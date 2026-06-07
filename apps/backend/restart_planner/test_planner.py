"""Tests for the restart planner (read-only inspection + cleanup)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from restart_planner import RestartMode, plan_restart, prepare_restart


def _seed_plan(spec_dir: Path, subtask_statuses: list[str]) -> None:
    """Write a minimal implementation_plan.json with one phase per call."""
    spec_dir.mkdir(parents=True, exist_ok=True)
    subtasks = [
        {"id": f"st-{i}", "status": status} for i, status in enumerate(subtask_statuses)
    ]
    plan = {
        "feature": "demo",
        "phases": [{"name": "phase-1", "subtasks": subtasks}],
    }
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# plan_restart


class TestPlanRestart:
    def test_missing_spec_dir_disables_everything(self, tmp_path: Path) -> None:
        result = plan_restart(tmp_path / "ghost")
        assert result.can_restart_qa is False
        assert result.can_restart_coder is False
        assert result.can_restart_full is False
        assert "all" in result.reasons

    def test_no_plan_yields_full_only(self, tmp_path: Path) -> None:
        result = plan_restart(tmp_path)
        assert result.can_restart_qa is False
        assert result.can_restart_coder is False
        assert result.can_restart_full is True
        assert "qa" in result.reasons
        assert "coder" in result.reasons

    def test_corrupt_plan_treated_as_no_plan(self, tmp_path: Path) -> None:
        (tmp_path / "implementation_plan.json").write_text("not json", encoding="utf-8")
        result = plan_restart(tmp_path)
        assert result.can_restart_full is True
        assert result.can_restart_qa is False

    def test_no_completed_subtasks_blocks_qa(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["pending", "pending", "pending"])
        result = plan_restart(tmp_path)
        assert result.can_restart_qa is False
        assert "no completed subtasks" in result.reasons["qa"]
        assert result.can_restart_coder is True
        assert result.next_subtask_for_coder == "st-0"

    def test_partial_completion_enables_both(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed", "completed", "failed", "pending"])
        result = plan_restart(tmp_path)
        assert result.can_restart_qa is True
        assert result.can_restart_coder is True
        # First non-completed = the failed one at index 2.
        assert result.next_subtask_for_coder == "st-2"
        assert result.completed_subtasks == 2
        assert result.total_subtasks == 4

    def test_all_completed_blocks_coder(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed", "completed"])
        result = plan_restart(tmp_path)
        assert result.can_restart_qa is True
        assert result.can_restart_coder is False
        assert "already completed" in result.reasons["coder"]
        assert result.next_subtask_for_coder is None

    def test_full_restart_always_available_when_dir_exists(
        self, tmp_path: Path
    ) -> None:
        _seed_plan(tmp_path, ["completed"])
        result = plan_restart(tmp_path)
        assert result.can_restart_full is True

    def test_files_to_clean_lists_only_existing(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed"])
        # Create one of the cleanup targets so we can see it surface.
        (tmp_path / "QA_FIX_REQUEST.md").write_text("fix me", encoding="utf-8")
        result = plan_restart(tmp_path)
        # qa cleanup includes QA_FIX_REQUEST.md.
        assert "QA_FIX_REQUEST.md" in result.files_to_clean["qa"]
        # qa_signoff.json doesn't exist → not listed.
        assert "qa_signoff.json" not in result.files_to_clean["qa"]

    def test_to_dict_round_trip(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed"])
        result = plan_restart(tmp_path)
        encoded = json.dumps(result.to_dict())
        decoded = json.loads(encoded)
        assert decoded["spec_id"] == tmp_path.name
        assert decoded["can_restart_qa"] is True


# ---------------------------------------------------------------------------
# prepare_restart


class TestPrepareRestart:
    def test_qa_mode_deletes_qa_artifacts(self, tmp_path: Path) -> None:
        (tmp_path / "qa_report.md").write_text("x", encoding="utf-8")
        (tmp_path / "QA_FIX_REQUEST.md").write_text("y", encoding="utf-8")
        # implementation_plan.json must NOT be deleted by qa restart.
        (tmp_path / "implementation_plan.json").write_text("{}", encoding="utf-8")
        result = prepare_restart(tmp_path, RestartMode.QA)
        assert sorted(result["deleted"]) == ["QA_FIX_REQUEST.md", "qa_report.md"]
        assert (tmp_path / "implementation_plan.json").exists()

    def test_full_mode_deletes_implementation_plan(self, tmp_path: Path) -> None:
        (tmp_path / "implementation_plan.json").write_text("{}", encoding="utf-8")
        (tmp_path / "qa_report.md").write_text("x", encoding="utf-8")
        result = prepare_restart(tmp_path, RestartMode.FULL)
        assert "implementation_plan.json" in result["deleted"]
        assert not (tmp_path / "implementation_plan.json").exists()

    def test_missing_files_silently_skipped(self, tmp_path: Path) -> None:
        # No artifacts to delete → empty list, no error.
        result = prepare_restart(tmp_path, RestartMode.QA)
        assert result["deleted"] == []
        assert result["warnings"] == []

    def test_unknown_mode_via_string_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            prepare_restart(tmp_path, "totally-not-a-mode")

    def test_missing_spec_dir_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            prepare_restart(tmp_path / "ghost", RestartMode.FULL)

    def test_string_mode_accepted(self, tmp_path: Path) -> None:
        (tmp_path / "qa_report.md").write_text("x", encoding="utf-8")
        result = prepare_restart(tmp_path, "qa")
        assert result["mode"] == "qa"
        assert "qa_report.md" in result["deleted"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
