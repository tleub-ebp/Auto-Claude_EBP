"""Tests for the stray-root-plan guardrail (_cleanup_stray_root_plan).

A weak model can write ./implementation_plan.json to the worktree ROOT (a
relative path) and leave a truncated "{" there — not the plan WorkPilot reads
(which lives in the spec dir). The guardrail removes that stray ONLY when it's
genuinely invalid and ONLY in worktree mode, so a real plan is never touched.
"""

from __future__ import annotations

import json
from pathlib import Path

from agents.coder import _cleanup_stray_root_plan


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
