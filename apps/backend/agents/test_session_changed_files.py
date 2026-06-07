"""Tests for per-subtask changed-file persistence (post-session processing).

Guards the ground-truth file attribution used by the UI's per-subtask
"files modified" view: when a subtask completes we record the real git diff in
``files_changed`` (unioned across sessions), rather than relying on the
planner's pre-coding prediction.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from agents.session import _persist_subtask_changed_files


class TestPersistSubtaskChangedFiles:
    def _patch(self, monkeypatch: pytest.MonkeyPatch, changed: list[str]) -> dict:
        """Stub the git diff + plan-save dependencies; capture the saved plan."""
        captured: dict = {"save_calls": 0}

        def fake_get_changed_files(project_dir, commit_before, commit_after):
            return list(changed)

        def fake_save(spec_dir, plan):
            captured["save_calls"] += 1
            captured["plan"] = plan
            return True

        monkeypatch.setattr(
            "analysis.insight_extractor.get_changed_files", fake_get_changed_files
        )
        monkeypatch.setattr("qa.criteria.save_implementation_plan", fake_save)
        return captured

    def _run(self, plan: dict, subtask: dict) -> None:
        _persist_subtask_changed_files(
            spec_dir=Path("/spec"),
            project_dir=Path("/proj"),
            plan=plan,
            subtask=subtask,
            subtask_id="s1",
            commit_before="aaa",
            commit_after="bbb",
        )

    def test_records_changed_files_on_completion(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = self._patch(monkeypatch, ["src/a.ts", "src/b.ts"])
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts", "src/b.ts"]
        assert captured["save_calls"] == 1
        assert captured["plan"] is plan

    def test_unions_across_sessions_without_duplicates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch(monkeypatch, ["src/b.ts", "src/c.ts"])
        subtask = {"id": "s1", "files_changed": ["src/a.ts", "src/b.ts"]}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts", "src/b.ts", "src/c.ts"]

    def test_no_save_when_no_files_changed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = self._patch(monkeypatch, [])
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert "files_changed" not in subtask
        assert captured["save_calls"] == 0

    def test_no_save_when_nothing_new(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = self._patch(monkeypatch, ["src/a.ts"])
        subtask = {"id": "s1", "files_changed": ["src/a.ts"]}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts"]
        assert captured["save_calls"] == 0

    def test_never_raises_when_git_helper_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom(*_args, **_kwargs):
            raise RuntimeError("git exploded")

        monkeypatch.setattr("analysis.insight_extractor.get_changed_files", boom)
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        # Must be non-fatal: completion should never be blocked by attribution.
        self._run(plan, subtask)

        assert "files_changed" not in subtask
