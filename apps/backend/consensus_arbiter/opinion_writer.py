"""
Consensus Arbiter — Opinion Producer
====================================

Persists agent opinions to ``<project-root>/.workpilot/agent-opinions/*.json``
so the Consensus Arbiter runner has real data to arbitrate. Without a producer
the arbiter always reports "no conflicts" because the directory stays empty —
the engine and UI were complete but nothing ever fed them (mirrors the carbon
ledger, which was read by a runner but never written).

Each producer owns exactly one file (``<producer>.json``) and *overwrites* it on
every run, so the arbiter always reflects the most recent build rather than an
ever-growing pile of stale opinions. Files are a JSON list of opinion objects in
the exact shape ``consensus_arbiter_runner.py`` ingests::

    [{"agent_name", "domain", "recommendation", "confidence",
      "reasoning", "affected_files"}]

Producers wired today (``apps/backend/qa/loop.py``):
  - ``SecurityScanner`` (domain=security) — one opinion per critical/high finding
  - ``QA Reviewer``     (domain=qa)        — verdict over the task's changed files

A genuine conflict surfaces when, e.g., the security scanner flags a file that
the QA reviewer approved — exactly the kind of cross-agent disagreement a human
should be asked to arbitrate.

Every public entry point is best-effort: it swallows and logs its own failures
so a producer problem can never break the QA pipeline it is embedded in.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

OPINIONS_SUBDIR = Path(".workpilot") / "agent-opinions"

# Must match AgentDomain in arbiter_engine.py. Anything else falls back to "qa".
_VALID_DOMAINS = {
    "security",
    "performance",
    "qa",
    "ux",
    "architecture",
    "database",
    "devops",
    "accessibility",
    "cost",
}

# Confidence assigned to a security finding by its severity. Criticals are near
# certain; lows are advisory. Used as the opinion's arbitration weight.
_SECURITY_CONFIDENCE: dict[str, float] = {
    "critical": 0.95,
    "high": 0.85,
    "medium": 0.6,
    "low": 0.4,
}

_file_locks: dict[str, threading.Lock] = {}
_file_locks_mutex = threading.Lock()


# ---------------------------------------------------------------------------
# Low-level file helpers (self-contained so this package stays standalone)
# ---------------------------------------------------------------------------


def _get_file_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _file_locks_mutex:
        return _file_locks.setdefault(key, threading.Lock())


def _atomic_write(path: Path, content: str) -> None:
    """Write *content* to *path* atomically via a sibling .tmp file + rename."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _resolve_opinions_root(project_dir: Path) -> Path:
    """Return the main project root that owns the agent-opinions directory.

    QA runs inside worktrees (``<root>/.workpilot/worktrees/tasks/<spec>``) so
    ``project_dir`` is the worktree, not the repo the arbiter scans. Walk back to
    the directory that owns the first ``.workpilot`` in the chain so every
    worktree feeds the single opinions directory the frontend actually scans
    (it passes the *selected project root* as ``projectPath``). Mirrors
    ``usage_tracker._resolve_carbon_ledger_root``.
    """
    parts = project_dir.parts
    for i, part in enumerate(parts):
        if part == ".workpilot" and i + 1 < len(parts) and parts[i + 1] == "worktrees":
            return Path(*parts[:i]) if i else project_dir
    return project_dir


def opinions_dir(project_dir: Path) -> Path:
    """The ``.workpilot/agent-opinions`` directory at the resolved project root."""
    return _resolve_opinions_root(project_dir) / OPINIONS_SUBDIR


def _sanitize_producer_key(producer_key: str) -> str:
    """Reduce a producer name to a safe, stable file stem."""
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", producer_key.strip().lower()).strip("-.")
    return safe or "producer"


def _normalize_path(path: str) -> str:
    """Repo-relative, forward-slashed path so opinions overlap on the same key."""
    return str(path).replace("\\", "/").strip()


def _normalize_opinion(opinion: dict[str, Any]) -> dict[str, Any]:
    """Coerce a raw opinion dict into the runner's expected schema."""
    domain = str(opinion.get("domain", "qa")).lower()
    if domain not in _VALID_DOMAINS:
        domain = "qa"
    try:
        confidence = float(opinion.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    files = [
        _normalize_path(f)
        for f in (opinion.get("affected_files") or [])
        if str(f).strip()
    ]
    return {
        "agent_name": str(opinion.get("agent_name") or "Unknown"),
        "domain": domain,
        "recommendation": str(opinion.get("recommendation", "")),
        "confidence": confidence,
        "reasoning": str(opinion.get("reasoning", "")),
        "affected_files": files,
    }


# ---------------------------------------------------------------------------
# Core writer
# ---------------------------------------------------------------------------


def write_opinions(
    project_dir: Path,
    producer_key: str,
    opinions: list[dict[str, Any]],
) -> Path | None:
    """Overwrite ``<producer_key>.json`` with *opinions* (a list of dicts).

    Always writes — even an empty list — so opinions from a previous run that no
    longer apply (e.g. a file that used to be flagged and is now clean) are
    cleared instead of lingering as phantom conflicts. Best-effort: logs and
    returns ``None`` on any failure rather than raising into the caller.
    """
    try:
        target_dir = opinions_dir(Path(project_dir))
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{_sanitize_producer_key(producer_key)}.json"
        payload = [_normalize_opinion(o) for o in opinions if isinstance(o, dict)]
        with _get_file_lock(path):
            _atomic_write(path, json.dumps(payload, indent=2))
        logger.debug("Wrote %d opinion(s) to %s", len(payload), path)
        return path
    except Exception:
        logger.debug(
            "Failed to write agent opinions for %r", producer_key, exc_info=True
        )
        return None


# ---------------------------------------------------------------------------
# Domain translators
# ---------------------------------------------------------------------------


def _file_from_location(location: str) -> str:
    """Extract the file path from a ``"path/to/file.py:123"`` location string.

    Only a trailing ``:<line>`` is stripped; paths without a line number pass
    through untouched. Relative paths never carry a Windows drive colon here, so
    there is no ambiguity with the line separator.
    """
    loc = (location or "").strip()
    if not loc:
        return ""
    head, sep, tail = loc.rpartition(":")
    if sep and head and tail.isdigit():
        return _normalize_path(head)
    return _normalize_path(loc)


def build_security_opinions(sec_issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate ``QASecurityScanner.to_qa_issues()`` output into opinions.

    Each critical/high finding becomes one security-domain opinion recommending
    its remediation on the affected file. When two findings hit the same file
    with different fixes the arbiter surfaces it as a conflict to prioritize.
    """
    opinions: list[dict[str, Any]] = []
    for issue in sec_issues or []:
        if not isinstance(issue, dict):
            continue
        file_path = _file_from_location(str(issue.get("location", "")))
        if not file_path:
            continue
        severity = str(issue.get("type", "high")).lower()
        title = str(issue.get("title", "Security issue"))
        fix = str(issue.get("fix_required") or "Fix this security vulnerability")
        cwe = issue.get("cwe")
        reasoning = f"{title} ({cwe})" if cwe else title
        opinions.append(
            {
                "agent_name": "SecurityScanner",
                "domain": "security",
                "recommendation": fix,
                "confidence": _SECURITY_CONFIDENCE.get(severity, 0.7),
                "reasoning": reasoning,
                "affected_files": [file_path],
            }
        )
    return opinions


def build_qa_reviewer_opinions(
    verdict: str,
    changed_files: list[str] | None,
    issues: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build the QA reviewer's opinion(s) from its verdict.

    - ``approved``: one "approve as-is" opinion spanning every changed file, so
      it can collide with another domain (e.g. security) that wants a change to
      one of those files.
    - ``rejected``: one opinion per flagged file describing the fix QA wants.
    - anything else (``human_escalation``, ``error``, unknown): no opinion —
      the verdict is inconclusive, so there is nothing to arbitrate.
    """
    verdict = (verdict or "").lower()
    files = [_normalize_path(f) for f in (changed_files or []) if str(f).strip()]

    if verdict == "approved":
        if not files:
            return []
        return [
            {
                "agent_name": "QA Reviewer",
                "domain": "qa",
                "recommendation": "Approve and merge as-is",
                "confidence": 0.8,
                "reasoning": "All acceptance criteria validated; no changes requested.",
                "affected_files": files,
            }
        ]

    if verdict == "rejected":
        by_file: dict[str, list[str]] = {}
        for issue in issues or []:
            if not isinstance(issue, dict):
                continue
            file_path = _file_from_location(str(issue.get("location", "")))
            if not file_path:
                continue
            by_file.setdefault(file_path, []).append(str(issue.get("title", "issue")))
        return [
            {
                "agent_name": "QA Reviewer",
                "domain": "qa",
                "recommendation": "Fix required: " + "; ".join(titles),
                "confidence": 0.85,
                "reasoning": "QA rejected: acceptance criteria not met.",
                "affected_files": [file_path],
            }
            for file_path, titles in by_file.items()
        ]

    return []


# ---------------------------------------------------------------------------
# Public record_* helpers (called from the QA loop)
# ---------------------------------------------------------------------------


def record_security_opinions(
    project_dir: Path,
    sec_issues: list[dict[str, Any]],
) -> Path | None:
    """Persist the security scanner's opinions for the current build."""
    return write_opinions(
        project_dir, "security-scanner", build_security_opinions(sec_issues)
    )


def record_qa_reviewer_opinion(
    project_dir: Path,
    verdict: str,
    changed_files: list[str] | None,
    issues: list[dict[str, Any]] | None = None,
) -> Path | None:
    """Persist the QA reviewer's opinion for the current verdict."""
    return write_opinions(
        project_dir,
        "qa-reviewer",
        build_qa_reviewer_opinions(verdict, changed_files, issues),
    )


def get_task_changed_files(project_dir: Path, spec_dir: Path) -> list[str]:
    """Repo-relative files changed by this task, via ``git diff base...HEAD``.

    Returns an empty list (never ``None``) when git is unavailable or the diff
    fails, so callers can treat "no known changes" and "git failed" the same
    way. Paths come back forward-slashed from git, matching the security
    scanner's normalization so opinions overlap on identical keys.
    """
    base_branch = _detect_base_branch(spec_dir, Path(project_dir))
    try:
        result = subprocess.run(
            [
                "git",
                "diff",
                f"{base_branch}...HEAD",
                "--name-only",
                "--diff-filter=ACMR",
            ],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if result.returncode == 0:
            return [
                _normalize_path(line)
                for line in result.stdout.splitlines()
                if line.strip()
            ]
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass
    return []


def _detect_base_branch(spec_dir: Path, project_dir: Path) -> str:
    """Best-effort default-branch detection (this repo's main is ``develop``)."""
    try:
        from prompts_pkg.prompts import _detect_base_branch as _detect

        return _detect(spec_dir, project_dir)
    except Exception:
        pass
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().rsplit("/", 1)[-1]
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass
    return "main"
