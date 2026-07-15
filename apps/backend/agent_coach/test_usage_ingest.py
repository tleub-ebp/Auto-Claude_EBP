"""Tests for the Agent Coach usage-ledger ingest.

Covers the per-call → per-run aggregation, discovery across the project root and
its worktrees, and a full end-to-end pass through the real runner proving the
coach produces a report from cost_data.json (instead of "no records found").
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from agent_coach.usage_ingest import (
    _discover_cost_data_files,
    aggregate_usages_to_runs,
    load_agent_runs_from_usage,
)


def _usage(**kw) -> dict:
    base = {
        "spec_id": "001-feature",
        "agent_type": "coder",
        "model": "claude-sonnet-4-6",
        "input_tokens": 100,
        "output_tokens": 50,
        "cost": 0.01,
        "timestamp": "2026-07-08T10:00:00+00:00",
    }
    base.update(kw)
    return base


def _write_cost_data(path: Path, usages: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"usages": usages, "budgets": {}}), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #


def test_aggregate_groups_by_task_and_agent() -> None:
    usages = [
        _usage(agent_type="coder", input_tokens=100, output_tokens=50, cost=0.01),
        _usage(agent_type="coder", input_tokens=200, output_tokens=100, cost=0.02),
        _usage(agent_type="planner", input_tokens=10, output_tokens=5, cost=0.001),
    ]
    runs = {r.agent_name: r for r in aggregate_usages_to_runs(usages)}

    assert set(runs) == {"coder", "planner"}
    assert runs["coder"].tokens_used == 450  # (100+50)+(200+100)
    assert runs["coder"].cost_usd == 0.03
    assert runs["coder"].metadata["llm_calls"] == 2
    assert runs["coder"].run_id == "001-feature:coder"


def test_aggregate_picks_most_used_model() -> None:
    usages = [
        _usage(model="claude-sonnet-4-6"),
        _usage(model="claude-sonnet-4-6"),
        _usage(model="claude-haiku-4-5"),
    ]
    runs = aggregate_usages_to_runs(usages)
    assert len(runs) == 1
    assert runs[0].model == "claude-sonnet-4-6"


def test_aggregate_falls_back_to_phase_then_default_agent_name() -> None:
    usages = [
        {"spec_id": "s", "phase": "qa_review", "cost": 0.5},  # no agent_type
        {"spec_id": "s", "cost": 0.1},  # neither agent_type nor phase
    ]
    names = {r.agent_name for r in aggregate_usages_to_runs(usages)}
    assert names == {"qa_review", "agent"}


def test_aggregate_tolerates_missing_and_bad_numbers() -> None:
    usages = [
        {"spec_id": "s", "agent_type": "coder", "cost": None, "input_tokens": "x"},
    ]
    runs = aggregate_usages_to_runs(usages)
    assert runs[0].cost_usd == 0.0
    assert runs[0].tokens_used == 0


# --------------------------------------------------------------------------- #
# Discovery (root + worktrees)
# --------------------------------------------------------------------------- #


def test_discover_root_and_worktree_cost_data(tmp_path: Path) -> None:
    root_file = tmp_path / ".workpilot" / "cost_data.json"
    wt_file = (
        tmp_path
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-x"
        / ".workpilot"
        / "cost_data.json"
    )
    _write_cost_data(root_file, [_usage()])
    _write_cost_data(wt_file, [_usage()])

    found = _discover_cost_data_files(tmp_path)
    assert root_file in found
    assert wt_file in found


def test_load_from_usage_merges_all_files(tmp_path: Path) -> None:
    _write_cost_data(
        tmp_path / ".workpilot" / "cost_data.json",
        [_usage(spec_id="A", agent_type="coder", cost=0.01)],
    )
    _write_cost_data(
        tmp_path / ".workpilot" / "worktrees" / "t" / ".workpilot" / "cost_data.json",
        [_usage(spec_id="B", agent_type="coder", cost=0.02)],
    )
    runs = load_agent_runs_from_usage(tmp_path)
    # Different specs → distinct runs even though the agent name matches.
    assert {r.run_id for r in runs} == {"A:coder", "B:coder"}


def test_load_from_usage_empty_project(tmp_path: Path) -> None:
    assert load_agent_runs_from_usage(tmp_path) == []


# --------------------------------------------------------------------------- #
# End-to-end via the real runner
# --------------------------------------------------------------------------- #


def _load_runner():
    runner_path = (
        Path(__file__).resolve().parents[1] / "runners" / "agent_coach_runner.py"
    )
    spec = importlib.util.spec_from_file_location("_coach_runner_test", runner_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_end_to_end_report_from_cost_data(tmp_path: Path) -> None:
    # One cheap agent, one 3x+ cost outlier → coach should report tips.
    _write_cost_data(
        tmp_path / ".workpilot" / "cost_data.json",
        [
            _usage(spec_id="A", agent_type="planner", cost=0.001),
            _usage(spec_id="A", agent_type="coder", cost=0.001),
            _usage(spec_id="B", agent_type="coder", cost=0.5),  # outlier
        ],
    )

    runner = _load_runner()
    report = runner.run_scan(tmp_path)["report"]

    assert report["totalRuns"] == 3
    assert report["totalCostUsd"] > 0
    assert report["mostUsedModel"] == "claude-sonnet-4-6"
    # A single model across all runs → the model-diversity tip fires.
    categories = {t["category"] for t in report["tips"]}
    assert "cost_optimisation" in categories
