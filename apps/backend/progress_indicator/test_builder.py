"""Tests for the fine-grained progress indicator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from progress_indicator import build_progress_indicator


def _seed_plan(spec_dir: Path, statuses: list[str]) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    plan = {
        "feature": "demo",
        "phases": [
            {
                "name": "p1",
                "subtasks": [
                    {"id": f"st-{i}", "status": s} for i, s in enumerate(statuses)
                ],
            }
        ],
    }
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def _seed_logs(
    spec_dir: Path,
    *,
    planning_status: str = "pending",
    coding_status: str = "pending",
    validation_status: str = "pending",
    last_subtask: str | None = None,
    last_session: int | None = None,
    subphase: str | None = None,
    completed_at_planning: str | None = None,
    completed_at_coding: str | None = None,
) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    entries_coding = []
    if last_subtask or last_session or subphase:
        entry = {
            "timestamp": "2026-04-30T10:00:00+00:00",
            "type": "info",
            "content": "x",
            "phase": "coding",
        }
        if last_subtask:
            entry["subtask_id"] = last_subtask
        if last_session:
            entry["session"] = last_session
        if subphase:
            entry["subphase"] = subphase
        entries_coding.append(entry)

    logs = {
        "spec_id": spec_dir.name,
        "created_at": "2026-04-30T09:00:00+00:00",
        "updated_at": "2026-04-30T10:00:00+00:00",
        "phases": {
            "planning": {
                "phase": "planning",
                "status": planning_status,
                "started_at": "2026-04-30T09:00:00+00:00",
                "completed_at": completed_at_planning,
                "entries": [],
            },
            "coding": {
                "phase": "coding",
                "status": coding_status,
                "started_at": "2026-04-30T09:30:00+00:00",
                "completed_at": completed_at_coding,
                "entries": entries_coding,
            },
            "validation": {
                "phase": "validation",
                "status": validation_status,
                "started_at": None,
                "completed_at": None,
                "entries": [],
            },
        },
    }
    (spec_dir / "task_logs.json").write_text(json.dumps(logs), encoding="utf-8")


# ---------------------------------------------------------------------------
# Edge cases


class TestEdgeCases:
    def test_missing_spec_dir(self, tmp_path: Path) -> None:
        result = build_progress_indicator(tmp_path / "ghost")
        assert result.phase == "unknown"
        assert "does not exist" in result.warnings[0]

    def test_no_logs_no_plan_idle(self, tmp_path: Path) -> None:
        result = build_progress_indicator(tmp_path)
        assert result.phase == "idle"
        assert "no implementation_plan.json yet" in result.warnings
        assert "no task_logs.json yet" in result.warnings

    def test_plan_complete_without_logs_inferred_completed(
        self, tmp_path: Path
    ) -> None:
        _seed_plan(tmp_path, ["completed", "completed"])
        # No task_logs.json written.
        result = build_progress_indicator(tmp_path)
        assert result.phase == "completed"
        assert result.label == "Completed"
        assert result.subtasks_total == 2

    def test_corrupt_logs_treated_as_missing(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["pending"])
        (tmp_path / "task_logs.json").write_text("not json", encoding="utf-8")
        result = build_progress_indicator(tmp_path)
        # No usable logs → idle / pre-build.
        assert result.phase == "idle"


# ---------------------------------------------------------------------------
# Active phase detection


class TestActivePhase:
    def test_planning_active(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["pending", "pending"])
        _seed_logs(tmp_path, planning_status="active")
        result = build_progress_indicator(tmp_path)
        assert result.phase == "planning"
        assert result.label == "Planning"

    def test_coding_active_with_subtask_progress(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed", "completed", "pending", "pending"])
        _seed_logs(
            tmp_path, coding_status="active", last_subtask="st-2", last_session=1
        )
        result = build_progress_indicator(tmp_path)
        assert result.phase == "coding"
        # 2 completed out of 4 → currently working on subtask 3.
        assert result.label == "Coding subtask 3/4"
        assert result.current_subtask_id == "st-2"

    def test_qa_validating_first_pass(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed"])
        _seed_logs(
            tmp_path,
            coding_status="completed",
            completed_at_coding="2026-04-30T10:30:00+00:00",
            validation_status="active",
            last_session=1,
        )
        result = build_progress_indicator(tmp_path)
        # Note: with no entry on validation phase, the indicator falls back
        # to "QA validating" (current_session is None for that phase).
        assert result.phase == "qa"
        assert "QA" in result.label

    def test_no_active_phase_picks_latest_completed(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["completed"])
        _seed_logs(
            tmp_path,
            planning_status="completed",
            completed_at_planning="2026-04-30T09:30:00+00:00",
            coding_status="completed",
            completed_at_coding="2026-04-30T10:30:00+00:00",
        )
        result = build_progress_indicator(tmp_path)
        # Coding completed last → label reports coding (between sessions).
        assert result.phase == "coding"
        assert "Coding" in result.label


# ---------------------------------------------------------------------------
# Serialisation


class TestSerialisation:
    def test_to_dict_roundtrips_through_json(self, tmp_path: Path) -> None:
        _seed_plan(tmp_path, ["pending"])
        _seed_logs(tmp_path, coding_status="active")
        result = build_progress_indicator(tmp_path)
        encoded = json.dumps(result.to_dict())
        decoded = json.loads(encoded)
        assert decoded["spec_id"] == tmp_path.name
        assert "phase" in decoded
        assert "label" in decoded


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
