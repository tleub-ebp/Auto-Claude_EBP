"""Tests for the Consensus Arbiter opinion producer.

Covers the domain translators, the worktree→root resolution (so QA running in a
worktree feeds the single opinions directory the frontend scans), the overwrite
semantics, and a full end-to-end pass through the real runner to prove a genuine
cross-agent conflict is detected and resolved.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from consensus_arbiter.opinion_writer import (
    OPINIONS_SUBDIR,
    _file_from_location,
    _resolve_opinions_root,
    build_qa_reviewer_opinions,
    build_security_opinions,
    opinions_dir,
    record_qa_reviewer_opinion,
    record_security_opinions,
    write_opinions,
)

# --------------------------------------------------------------------------- #
# Location parsing
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("location", "expected"),
    [
        ("api/handler.py:42", "api/handler.py"),
        ("api/handler.py", "api/handler.py"),
        ("src\\a\\b.ts:10", "src/a/b.ts"),
        ("weird:name:99", "weird:name"),
        ("no-line:", "no-line:"),
        ("", ""),
        ("   ", ""),
    ],
)
def test_file_from_location(location: str, expected: str) -> None:
    assert _file_from_location(location) == expected


# --------------------------------------------------------------------------- #
# Root resolution (worktree → project root)
# --------------------------------------------------------------------------- #


def test_resolve_root_plain_project(tmp_path: Path) -> None:
    assert _resolve_opinions_root(tmp_path) == tmp_path


def test_resolve_root_from_worktree(tmp_path: Path) -> None:
    worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "spec-1"
    assert _resolve_opinions_root(worktree) == tmp_path


def test_opinions_dir_from_worktree(tmp_path: Path) -> None:
    worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "spec-1"
    assert opinions_dir(worktree) == tmp_path / OPINIONS_SUBDIR


# --------------------------------------------------------------------------- #
# Security translator
# --------------------------------------------------------------------------- #


def test_build_security_opinions_maps_severity_and_file() -> None:
    issues = [
        {
            "type": "critical",
            "title": "SQL injection",
            "location": "api/handler.py:10",
            "fix_required": "Use parameterized queries",
            "cwe": "CWE-89",
        },
        {
            "type": "high",
            "title": "XSS",
            "location": "ui/view.tsx:3",
            "fix_required": "Sanitize input",
        },
    ]
    opinions = build_security_opinions(issues)

    assert [o["affected_files"] for o in opinions] == [
        ["api/handler.py"],
        ["ui/view.tsx"],
    ]
    assert opinions[0]["domain"] == "security"
    assert opinions[0]["confidence"] == 0.95  # critical
    assert opinions[0]["recommendation"] == "Use parameterized queries"
    assert "CWE-89" in opinions[0]["reasoning"]
    assert opinions[1]["confidence"] == 0.85  # high


def test_build_security_opinions_skips_locationless_and_junk() -> None:
    issues = [
        {"type": "high", "title": "no location"},
        "not-a-dict",
        {"type": "critical", "title": "ok", "location": "a.py:1"},
    ]
    opinions = build_security_opinions(issues)  # type: ignore[arg-type]
    assert len(opinions) == 1
    assert opinions[0]["affected_files"] == ["a.py"]


# --------------------------------------------------------------------------- #
# QA reviewer translator
# --------------------------------------------------------------------------- #


def test_build_qa_opinion_approved_spans_changed_files() -> None:
    opinions = build_qa_reviewer_opinions("approved", ["a.py", "b/c.tsx"])
    assert len(opinions) == 1
    assert opinions[0]["domain"] == "qa"
    assert opinions[0]["recommendation"] == "Approve and merge as-is"
    assert opinions[0]["affected_files"] == ["a.py", "b/c.tsx"]


def test_build_qa_opinion_approved_without_files_is_empty() -> None:
    assert build_qa_reviewer_opinions("approved", []) == []


def test_build_qa_opinion_rejected_groups_issues_by_file() -> None:
    issues = [
        {"title": "missing test", "location": "a.py:1"},
        {"title": "bad name", "location": "a.py:9"},
        {"title": "no docs", "location": "b.py:2"},
    ]
    opinions = build_qa_reviewer_opinions("rejected", ["a.py", "b.py"], issues=issues)
    by_file = {o["affected_files"][0]: o for o in opinions}
    assert set(by_file) == {"a.py", "b.py"}
    assert "missing test" in by_file["a.py"]["recommendation"]
    assert "bad name" in by_file["a.py"]["recommendation"]


@pytest.mark.parametrize("verdict", ["human_escalation", "error", "", "unknown"])
def test_build_qa_opinion_inconclusive_verdicts_are_empty(verdict: str) -> None:
    assert build_qa_reviewer_opinions(verdict, ["a.py"], issues=[]) == []


# --------------------------------------------------------------------------- #
# Writer: normalization + overwrite semantics
# --------------------------------------------------------------------------- #


def test_write_opinions_normalizes_schema(tmp_path: Path) -> None:
    path = write_opinions(
        tmp_path,
        "My Producer!",  # sanitized to a safe stem
        [
            {
                "agent_name": "X",
                "domain": "not-a-domain",  # → qa
                "confidence": 5,  # → clamped to 1.0
                "affected_files": ["src\\a.py", ""],  # normalized + filtered
            }
        ],
    )
    assert path is not None
    assert path.name == "my-producer.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data[0]["domain"] == "qa"
    assert data[0]["confidence"] == 1.0
    assert data[0]["affected_files"] == ["src/a.py"]


def test_write_opinions_overwrites_and_clears(tmp_path: Path) -> None:
    write_opinions(tmp_path, "p", [{"agent_name": "A", "affected_files": ["a.py"]}])
    path = write_opinions(tmp_path, "p", [])  # now clean → empties the file
    assert path is not None
    assert json.loads(path.read_text(encoding="utf-8")) == []


def test_record_helpers_write_to_root_from_worktree(tmp_path: Path) -> None:
    worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "spec-1"
    worktree.mkdir(parents=True)

    record_security_opinions(
        worktree,
        [{"type": "high", "title": "XSS", "location": "a.py:1", "fix_required": "fix"}],
    )
    record_qa_reviewer_opinion(worktree, "approved", ["a.py"])

    root_dir = tmp_path / OPINIONS_SUBDIR
    assert (root_dir / "security-scanner.json").exists()
    assert (root_dir / "qa-reviewer.json").exists()
    # Nothing leaks into the worktree's own .workpilot.
    assert not (worktree / OPINIONS_SUBDIR).exists()


# --------------------------------------------------------------------------- #
# End-to-end: producer → runner detects & resolves a real cross-agent conflict
# --------------------------------------------------------------------------- #


def _load_runner():
    runner_path = (
        Path(__file__).resolve().parents[1] / "runners" / "consensus_arbiter_runner.py"
    )
    spec = importlib.util.spec_from_file_location("_ca_runner_test", runner_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_end_to_end_security_vs_qa_conflict(tmp_path: Path) -> None:
    # Security flags a file as critical; QA approves that same file → conflict.
    record_security_opinions(
        tmp_path,
        [
            {
                "type": "critical",
                "title": "SQL injection",
                "location": "api/handler.py:10",
                "fix_required": "Use parameterized queries",
                "cwe": "CWE-89",
            }
        ],
    )
    record_qa_reviewer_opinion(
        tmp_path, "approved", ["api/handler.py", "ui/button.tsx"]
    )

    runner = _load_runner()
    result = runner.run_scan(tmp_path)["result"]

    assert len(result["conflicts"]) == 1
    conflict = result["conflicts"][0]
    assert "api/handler.py" in conflict["topic"]
    domains = {op["domain"] for op in conflict["opinions"]}
    assert domains == {"security", "qa"}
    assert conflict["resolved"] is True
    # Security carries the higher confidence, so it wins the arbitration.
    assert conflict["resolution"] == "Use parameterized queries"
    assert result["resolvedCount"] == 1
    assert result["escalatedCount"] == 0


def test_end_to_end_no_conflict_when_domains_dont_overlap(tmp_path: Path) -> None:
    record_security_opinions(
        tmp_path,
        [{"type": "high", "title": "XSS", "location": "sec.py:1", "fix_required": "x"}],
    )
    record_qa_reviewer_opinion(tmp_path, "approved", ["ui.tsx"])  # different file

    runner = _load_runner()
    result = runner.run_scan(tmp_path)["result"]

    assert result["conflicts"] == []
    assert result["allResolved"] is True
