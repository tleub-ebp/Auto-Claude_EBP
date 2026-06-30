"""Tests for the stray-root-plan guardrail (_cleanup_stray_root_plan).

A weak model can write ./implementation_plan.json to the worktree ROOT (a
relative path) and leave a truncated "{" there — not the plan WorkPilot reads
(which lives in the spec dir). The guardrail removes that stray ONLY when it's
genuinely invalid and ONLY in worktree mode, so a real plan is never touched.
"""

from __future__ import annotations

import json
from pathlib import Path

from agents.coder import (
    _bump_planning_failures,
    _cleanup_stray_root_plan,
    _clear_planning_failures,
    _read_planning_failures,
)


def _worktree(tmp_path: Path) -> tuple[Path, Path]:
    """Return (project_dir, spec_dir) for a worktree layout (root != spec)."""
    project_dir = tmp_path / "worktree"
    spec_dir = project_dir / ".workpilot" / "specs" / "001-feat"
    spec_dir.mkdir(parents=True)
    return project_dir, spec_dir


def test_removes_truncated_brace(tmp_path: Path) -> None:
    project_dir, spec_dir = _worktree(tmp_path)
    stray = project_dir / "implementation_plan.json"
    stray.write_text("{", encoding="utf-8")  # the exact reported file

    msg = _cleanup_stray_root_plan(project_dir, spec_dir)
    assert msg is not None and "implementation_plan.json" in msg
    assert not stray.exists()


def test_removes_no_phases_plan(tmp_path: Path) -> None:
    project_dir, spec_dir = _worktree(tmp_path)
    stray = project_dir / "implementation_plan.json"
    # The other reported shape: a qa_signoff stub with no real plan.
    stray.write_text(
        json.dumps({"qa_signoff": {"status": "pending"}}), encoding="utf-8"
    )

    assert _cleanup_stray_root_plan(project_dir, spec_dir) is not None
    assert not stray.exists()


def test_keeps_valid_plan_with_phases(tmp_path: Path) -> None:
    project_dir, spec_dir = _worktree(tmp_path)
    stray = project_dir / "implementation_plan.json"
    stray.write_text(
        json.dumps({"feature": "x", "phases": [{"id": "p1", "name": "n"}]}),
        encoding="utf-8",
    )

    # A real plan (even if misplaced) is NOT deleted.
    assert _cleanup_stray_root_plan(project_dir, spec_dir) is None
    assert stray.exists()


def test_noop_when_no_stray(tmp_path: Path) -> None:
    project_dir, spec_dir = _worktree(tmp_path)
    assert _cleanup_stray_root_plan(project_dir, spec_dir) is None


def test_direct_mode_never_touches_root(tmp_path: Path) -> None:
    # In --direct mode the project root IS the spec dir, so the root plan is the
    # REAL one — never delete it, even if (transiently) invalid.
    spec_dir = tmp_path / "proj"
    spec_dir.mkdir()
    (spec_dir / "implementation_plan.json").write_text("{", encoding="utf-8")

    assert _cleanup_stray_root_plan(spec_dir, spec_dir) is None
    assert (spec_dir / "implementation_plan.json").exists()


# ── Persistent planning-failure cap (breaks the cross-session retry loop) ──


def test_planning_failures_persist_and_clear(tmp_path: Path) -> None:
    # Starts at 0, survives "process restarts" (re-reading from disk), and the
    # bump count is what a fresh run would see.
    assert _read_planning_failures(tmp_path) == 0
    assert _bump_planning_failures(tmp_path) == 1
    assert _bump_planning_failures(tmp_path) == 2
    assert _read_planning_failures(tmp_path) == 2  # persisted on disk

    _clear_planning_failures(tmp_path)
    assert _read_planning_failures(tmp_path) == 0
    # Clearing again (no file) is a safe no-op.
    _clear_planning_failures(tmp_path)
    assert _read_planning_failures(tmp_path) == 0


def test_planning_failures_tolerates_garbage(tmp_path: Path) -> None:
    (tmp_path / ".planning_validation_failures").write_text("not-an-int")
    assert _read_planning_failures(tmp_path) == 0  # garbage → treated as 0
    assert _bump_planning_failures(tmp_path) == 1
