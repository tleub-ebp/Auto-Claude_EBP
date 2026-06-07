"""Tests for the swarm orchestrator's deterministic surface.

The async wave-execution path is exercised by integration tests (it spawns
real subprocesses + worktrees). Here we cover the pure logic that runs on
the main thread: plan loading, progress arithmetic, counter updates, and
callbacks.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from agents.swarm.orchestrator import SwarmOrchestrator
from agents.swarm.types import (
    SubtaskNode,
    SubtaskState,
    SwarmConfig,
    SwarmPhase,
)
from agents.swarm.wave_executor import SubtaskResult, WaveResult


@pytest.fixture
def orchestrator(tmp_path: Path) -> SwarmOrchestrator:
    project_dir = tmp_path / "project"
    spec_dir = tmp_path / "spec"
    project_dir.mkdir()
    spec_dir.mkdir()
    return SwarmOrchestrator(project_dir=project_dir, spec_dir=spec_dir)


# ---------------------------------------------------------------------------
# _load_plan


class TestLoadPlan:
    def test_returns_none_when_plan_missing(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        assert orchestrator._load_plan() is None

    def test_returns_dict_when_plan_present(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        plan = {"subtasks": [{"id": "s1", "description": "do thing"}]}
        (orchestrator.spec_dir / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
        loaded = orchestrator._load_plan()
        assert loaded == plan

    def test_returns_none_on_invalid_json(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        (orchestrator.spec_dir / "implementation_plan.json").write_text(
            "not json", encoding="utf-8"
        )
        assert orchestrator._load_plan() is None


# ---------------------------------------------------------------------------
# _calculate_progress


class TestCalculateProgress:
    def test_first_wave_starts_at_10_percent(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        # 10% reserved for analysis phase, 80% spread across waves, 10% for final merge.
        assert orchestrator._calculate_progress(wave_idx=0, total_waves=4) == 10

    def test_progress_climbs_per_wave(self, orchestrator: SwarmOrchestrator) -> None:
        p0 = orchestrator._calculate_progress(0, 4)
        p1 = orchestrator._calculate_progress(1, 4)
        p2 = orchestrator._calculate_progress(2, 4)
        assert p0 < p1 < p2

    def test_zero_total_waves_returns_zero(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        assert orchestrator._calculate_progress(0, 0) == 0

    def test_progress_caps_under_90_for_last_wave(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        # Last wave should still leave room for final merge (≤ 90%).
        p_last = orchestrator._calculate_progress(wave_idx=9, total_waves=10)
        assert p_last < 90


# ---------------------------------------------------------------------------
# _update_counters_from_wave_result


def _wave_result(*results: SubtaskResult) -> WaveResult:
    return WaveResult(
        wave_index=0,
        results=list(results),
        all_succeeded=all(r.success for r in results),
    )


class TestUpdateCounters:
    def test_all_succeed_increments_completed(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator.status.running_subtasks = 3
        orchestrator._update_counters_from_wave_result(
            _wave_result(
                SubtaskResult("s1", True),
                SubtaskResult("s2", True),
                SubtaskResult("s3", True),
            )
        )
        assert orchestrator.status.completed_subtasks == 3
        assert orchestrator.status.failed_subtasks == 0
        # Wave done → running counter resets.
        assert orchestrator.status.running_subtasks == 0

    def test_mixed_results_split_counts(self, orchestrator: SwarmOrchestrator) -> None:
        orchestrator._update_counters_from_wave_result(
            _wave_result(
                SubtaskResult("s1", True),
                SubtaskResult("s2", False, error="boom"),
                SubtaskResult("s3", True),
                SubtaskResult("s4", False),
            )
        )
        assert orchestrator.status.completed_subtasks == 2
        assert orchestrator.status.failed_subtasks == 2

    def test_empty_wave_does_not_change_counters(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator._update_counters_from_wave_result(_wave_result())
        assert orchestrator.status.completed_subtasks == 0
        assert orchestrator.status.failed_subtasks == 0


# ---------------------------------------------------------------------------
# Callbacks


class TestCallbacks:
    def test_started_callback_increments_running(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator._on_subtask_started("s1")
        orchestrator._on_subtask_started("s2")
        assert orchestrator.status.running_subtasks == 2

    def test_completed_callback_decrements_running(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator.status.running_subtasks = 2
        orchestrator._on_subtask_completed("s1", None)
        assert orchestrator.status.running_subtasks == 1

    def test_completed_callback_floors_at_zero(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator.status.running_subtasks = 0
        orchestrator._on_subtask_completed("s1", None)
        assert orchestrator.status.running_subtasks == 0

    def test_failed_callback_decrements_running(
        self, orchestrator: SwarmOrchestrator
    ) -> None:
        orchestrator.status.running_subtasks = 1
        orchestrator._on_subtask_failed("s1", "err")
        assert orchestrator.status.running_subtasks == 0

    def test_log_callback_does_not_raise(self, orchestrator: SwarmOrchestrator) -> None:
        orchestrator._on_subtask_log("s1", "regular log line")
        orchestrator._on_subtask_log("s1", "__EXEC_PHASE__:planning")
        orchestrator._on_subtask_log("s1", "ERROR something")


# ---------------------------------------------------------------------------
# run() — the failure path (no plan)


class TestRunFailureFastPath:
    def test_missing_plan_marks_failed(self, orchestrator: SwarmOrchestrator) -> None:
        # No implementation_plan.json on disk → pipeline must short-circuit
        # to FAILED status with a descriptive error. This exercises the
        # full run() wrapper (try/finally + workflow logger calls).
        result = asyncio.run(orchestrator.run())
        assert result.phase is SwarmPhase.FAILED
        assert "implementation plan" in result.error.lower()


# ---------------------------------------------------------------------------
# Construction with custom config


class TestConstruction:
    def test_default_config_is_used(self, tmp_path: Path) -> None:
        o = SwarmOrchestrator(project_dir=tmp_path / "p", spec_dir=tmp_path / "s")
        # We didn't pass a config — default SwarmConfig must apply.
        assert isinstance(o.config, SwarmConfig)

    def test_custom_config_is_kept(self, tmp_path: Path) -> None:
        cfg = SwarmConfig(max_parallel_agents=42, fail_fast=True)
        o = SwarmOrchestrator(
            project_dir=tmp_path / "p", spec_dir=tmp_path / "s", config=cfg
        )
        assert o.config is cfg
        assert o.config.max_parallel_agents == 42
        assert o.config.fail_fast is True


# ---------------------------------------------------------------------------
# SubtaskNode retry counter (used by the orchestrator's retry logic)


class TestSubtaskNodeRetry:
    def test_node_starts_with_zero_retries(self) -> None:
        node = SubtaskNode(id="s1", description="x", phase_name="phase-1")
        assert node.retry_count == 0
        assert node.state is SubtaskState.PENDING


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
