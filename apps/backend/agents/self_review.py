"""Coder self-review handoff helper.

Right after the coder finishes its loop and before QA reviewer kicks in,
the coder can be asked to read its own diff and write a short
``self_review.md`` at the spec root with three sections:

  1. **What I changed** — bullet summary of files + intent
  2. **What might break** — risk areas / edge cases the coder is unsure about
  3. **What I didn't test** — gaps in coverage the QA agent should focus on

The QA reviewer prompt picks this up automatically (it already reads
markdown files in the spec dir as additional context), so no QA-side
change is needed. This is **opt-in** via ``WORKPILOT_SELF_REVIEW_ENABLED``.

The module exposes:
  * ``self_review_enabled()`` — env-flag check, mirrors
    ``feature_wiring`` truthy parsing
  * ``compute_diff_summary(spec_dir, project_dir)`` — pure helper that
    builds the prompt input from a git diff between the spec's worktree
    and HEAD, never raises
  * ``write_self_review_stub(spec_dir, summary)`` — writes a fallback
    ``self_review.md`` when no SDK is available (so QA still gets a
    structured artefact, just less detailed)
  * ``async def run_self_review(client, spec_dir, project_dir)`` — the
    actual SDK-backed call; takes any object with an
    ``.invoke(prompt)`` async method (so we can mock it in tests
    without pulling in claude-agent-sdk)

Best-effort. Never raises into the calling agent.
"""

from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

SELF_REVIEW_ENV_VAR = "WORKPILOT_SELF_REVIEW_ENABLED"
SELF_REVIEW_FILENAME = "self_review.md"

# How many characters of git diff we ship to the model. Beyond this we
# truncate with an ellipsis — coder doesn't need every byte to write a
# useful summary, and a 100k diff would blow the context budget.
_MAX_DIFF_CHARS = 32_000


def self_review_enabled() -> bool:
    """True iff the user opted in via env var."""
    return (os.environ.get(SELF_REVIEW_ENV_VAR, "") or "").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


@dataclass
class DiffSummary:
    """Compact representation of what the coder just produced."""

    files_changed: list[str] = field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    diff_excerpt: str = ""
    truncated: bool = False
    error: str | None = None  # populated when git was unavailable / failed

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_changed": list(self.files_changed),
            "insertions": self.insertions,
            "deletions": self.deletions,
            "diff_excerpt": self.diff_excerpt,
            "truncated": self.truncated,
            "error": self.error,
        }


def _git(args: list[str], cwd: Path) -> tuple[int, str, str]:
    """Run a git command, return (returncode, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def compute_diff_summary(spec_dir: Path, project_dir: Path) -> DiffSummary:
    """Build a DiffSummary from ``git diff HEAD`` in ``project_dir``.

    Spec_dir is currently only used to pick a label (the spec id) — the
    actual diff lives in the worktree where the coder ran. Caller passes
    the worktree path as ``project_dir``.
    """
    project_dir = Path(project_dir)
    if not project_dir.is_dir():
        return DiffSummary(error=f"project_dir is not a directory: {project_dir}")

    # First check we're inside a git repo.
    rc, _, err = _git(["rev-parse", "--is-inside-work-tree"], project_dir)
    if rc != 0:
        return DiffSummary(error=f"not a git repo: {err.strip() or 'unknown error'}")

    # Files changed (staged + unstaged).
    rc, files_out, files_err = _git(["diff", "HEAD", "--name-only"], project_dir)
    files = (
        [line.strip() for line in files_out.splitlines() if line.strip()]
        if rc == 0
        else []
    )

    # Numstat — fast win for insertions/deletions.
    rc, numstat_out, _ = _git(["diff", "HEAD", "--numstat"], project_dir)
    insertions = 0
    deletions = 0
    if rc == 0:
        for line in numstat_out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 2:
                continue
            try:
                insertions += int(parts[0])
                deletions += int(parts[1])
            except ValueError:
                # "-" for binary files; skip.
                continue

    # Excerpt of the actual diff.
    rc, diff_out, _ = _git(["diff", "HEAD"], project_dir)
    if rc != 0:
        diff_out = ""

    truncated = False
    if len(diff_out) > _MAX_DIFF_CHARS:
        diff_out = (
            diff_out[:_MAX_DIFF_CHARS] + "\n…[truncated by self_review excerpt cap]…\n"
        )
        truncated = True

    return DiffSummary(
        files_changed=files,
        insertions=insertions,
        deletions=deletions,
        diff_excerpt=diff_out,
        truncated=truncated,
        error=None if rc == 0 else (files_err.strip() or None),
    )


def build_self_review_prompt(
    spec_id: str,
    summary: DiffSummary,
) -> str:
    """The user prompt sent to the coder for the self-review pass."""
    files_block = (
        "\n".join(f"  - {f}" for f in summary.files_changed[:50]) or "  (none)"
    )
    if len(summary.files_changed) > 50:
        files_block += f"\n  …and {len(summary.files_changed) - 50} more"

    diff_block = summary.diff_excerpt or "(no diff captured — git was unavailable)"

    return (
        f"You just finished implementing spec `{spec_id}`. Before the QA "
        f"reviewer takes over, write a short hand-off note to help them "
        f"focus their review.\n\n"
        f"Statistics: {len(summary.files_changed)} file(s) changed, "
        f"+{summary.insertions} / -{summary.deletions} lines.\n\n"
        f"Files touched:\n{files_block}\n\n"
        f"Diff (truncated to {_MAX_DIFF_CHARS} chars if long):\n"
        f"```diff\n{diff_block}\n```\n\n"
        f"Write `{SELF_REVIEW_FILENAME}` at the spec root with EXACTLY "
        f"these three sections (no preamble, no other content):\n\n"
        f"## What I changed\n"
        f"(bullet summary, group by file or by intent — keep it under 10 lines)\n\n"
        f"## What might break\n"
        f"(risk areas you're unsure about — name specific files / functions / "
        f"edge cases. Be HONEST. If you cut a corner, say so.)\n\n"
        f"## What I didn't test\n"
        f"(coverage gaps the QA agent should focus on. Empty section if "
        f"you tested everything.)\n"
    )


def write_self_review_stub(spec_dir: Path, summary: DiffSummary) -> Path:
    """Write a minimal self_review.md from the diff summary alone.

    Used when no SDK is available (or the call failed) — at least the QA
    reviewer sees *something* structured instead of nothing. Returns the
    written path.
    """
    spec_dir = Path(spec_dir)
    spec_dir.mkdir(parents=True, exist_ok=True)
    target = spec_dir / SELF_REVIEW_FILENAME

    files_block = (
        "\n".join(f"- `{f}`" for f in summary.files_changed[:30])
        or "- (no files detected)"
    )
    if len(summary.files_changed) > 30:
        files_block += f"\n- _…and {len(summary.files_changed) - 30} more_"

    body = (
        f"# Coder self-review (auto-generated stub)\n\n"
        f"_The SDK was unavailable for a full self-review, so this is the "
        f"deterministic fallback. Treat the items below as raw diff "
        f"statistics, not as the coder's curated commentary._\n\n"
        f"## What I changed\n\n"
        f"{files_block}\n\n"
        f"_Stats: +{summary.insertions} / -{summary.deletions} lines across "
        f"{len(summary.files_changed)} file(s)._\n\n"
        f"## What might break\n\n"
        f"_(no curated risk list — please review the diff manually.)_\n\n"
        f"## What I didn't test\n\n"
        f"_(no coverage notes — please assume nothing extra was tested.)_\n"
    )
    if summary.error:
        body += f"\n---\n\n_Note: {summary.error}_\n"
    target.write_text(body, encoding="utf-8")
    return target


class _Invokable(Protocol):
    """Minimal interface for an SDK client we can call once."""

    async def invoke(self, prompt: str) -> str: ...  # pragma: no cover


async def run_self_review(
    client: _Invokable | None,
    spec_dir: Path,
    project_dir: Path,
) -> Path | None:
    """Run the self-review pass; write ``self_review.md``. Returns the path or None.

    Best-effort: any exception is caught and logged. Falls back to the
    deterministic stub if ``client`` is None or its ``invoke`` raises.
    """
    spec_dir = Path(spec_dir)
    project_dir = Path(project_dir)

    summary = compute_diff_summary(spec_dir, project_dir)

    if client is None:
        logger.info("Self-review: no SDK client supplied, writing deterministic stub")
        try:
            return write_self_review_stub(spec_dir, summary)
        except OSError as exc:
            logger.warning("Self-review stub write failed: %s", exc)
            return None

    prompt = build_self_review_prompt(spec_dir.name, summary)
    try:
        response = await client.invoke(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Self-review SDK call failed: %s — writing stub", exc)
        try:
            return write_self_review_stub(spec_dir, summary)
        except OSError as inner:
            logger.warning("Self-review stub write failed too: %s", inner)
            return None

    # Sanity check the response looks like markdown with the three sections;
    # otherwise we wrap it under "What I changed" so QA still gets it.
    has_sections = (
        "## What I changed" in response
        and "## What might break" in response
        and "## What I didn't test" in response
    )
    final_text = (
        response
        if has_sections
        else (
            f"# Coder self-review\n\n## What I changed\n\n{response.strip()}\n\n"
            f"## What might break\n\n_(model didn't follow the requested "
            f"section structure — see above.)_\n\n"
            f"## What I didn't test\n\n_(unknown — see above.)_\n"
        )
    )

    target = spec_dir / SELF_REVIEW_FILENAME
    try:
        target.write_text(final_text, encoding="utf-8")
        return target
    except OSError as exc:
        logger.warning("Self-review write failed: %s", exc)
        return None
