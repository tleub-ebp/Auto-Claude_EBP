"""Tests for the Provider × LLM × Effort formula matrix."""

from __future__ import annotations

import json
from pathlib import Path

from cost_intelligence.formula_matrix import (
    _aggregate_history_by_task,
    _heuristic_complexity_from_text,
    compute_formula_matrix,
)
from cost_intelligence.success_model import EFFORT_LEVELS


def _write_cost_data(
    project_root: Path, usages: list[dict], *, key: str = "usages"
) -> None:
    """Write a .workpilot/cost_data.json with real usage records."""
    wp = project_root / ".workpilot"
    wp.mkdir(parents=True, exist_ok=True)
    (wp / "cost_data.json").write_text(
        json.dumps({key: usages, "budgets": {}}), encoding="utf-8"
    )


def _coding_session(task: str, provider: str, model: str, in_tok: int, out_tok: int):
    return {
        "task_id": task,
        "spec_id": task,
        "provider": provider,
        "model": model,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "cost": (in_tok * 5 + out_tok * 25) / 1_000_000,
        "phase": "coding",
        "agent_type": "coder",
    }


class TestHeuristicComplexity:
    def test_empty_text_is_low(self):
        assert _heuristic_complexity_from_text("") <= 4.0

    def test_keywords_raise_complexity(self):
        simple = _heuristic_complexity_from_text("rename a button label")
        hard = _heuristic_complexity_from_text(
            "refactor the authentication layer and migrate the database schema "
            "with a distributed real-time integration"
        )
        assert hard > simple
        assert 1.0 <= hard <= 13.0


class TestComputeFormulaMatrix:
    def test_returns_formulas_for_all_efforts(self):
        matrix = compute_formula_matrix(
            ticket_id="T-1",
            description="add a new settings toggle",
            providers=["anthropic"],
        )
        # anthropic has many models; each must have all 5 efforts.
        efforts_seen = {f.effort for f in matrix.formulas}
        assert efforts_seen == set(EFFORT_LEVELS)
        # Every formula references the requested provider only.
        assert all(f.provider == "anthropic" for f in matrix.formulas)

    def test_never_raises_without_spec_or_project(self):
        matrix = compute_formula_matrix(ticket_id="T-2", description="")
        assert matrix.formulas  # full catalog
        assert matrix.complexity_score >= 1.0

    def test_default_sort_is_by_value_score_desc(self):
        matrix = compute_formula_matrix(
            ticket_id="T-3", description="small fix", providers=["anthropic"]
        )
        scores = [f.value_score for f in matrix.formulas]
        assert scores == sorted(scores, reverse=True)

    def test_higher_effort_costs_more_for_same_model(self):
        matrix = compute_formula_matrix(
            ticket_id="T-4",
            description="complex refactor with migration",
            providers=["anthropic"],
        )
        by_key = {(f.model, f.effort): f for f in matrix.formulas}
        # Pick a model present in the catalog.
        model = "claude-opus-4-8"
        none_f = by_key[(model, "none")]
        ultra_f = by_key[(model, "ultrathink")]
        assert ultra_f.expected_thinking_tokens > none_f.expected_thinking_tokens
        assert ultra_f.expected_cost_usd > none_f.expected_cost_usd

    def test_local_provider_is_free_and_tracks_energy(self):
        matrix = compute_formula_matrix(
            ticket_id="T-5", description="anything", providers=["ollama"]
        )
        assert matrix.formulas
        assert all(f.expected_cost_usd == 0.0 for f in matrix.formulas)
        assert all(not f.per_token_billed for f in matrix.formulas)
        # Energy should be tracked for at least the thinking-heavy efforts.
        assert any(f.energy_kwh > 0 for f in matrix.formulas)

    def test_to_dict_is_json_serializable(self):
        matrix = compute_formula_matrix(
            ticket_id="T-6", description="x", providers=["anthropic"]
        )
        payload = json.dumps(matrix.to_dict())
        parsed = json.loads(payload)
        assert parsed["ticket_id"] == "T-6"
        assert "formulas" in parsed
        assert parsed["formulas"][0]["success_probability"] >= 0.0

    def test_complexity_override_is_respected(self):
        matrix = compute_formula_matrix(
            ticket_id="T-7",
            description="ignored when override present",
            providers=["anthropic"],
            complexity_score=13.0,
        )
        assert matrix.complexity_score == 13.0

    def test_flat_rate_providers_ranked_on_success(self):
        # Copilot is $0 per token; formulas must still be produced & scored.
        matrix = compute_formula_matrix(
            ticket_id="T-8", description="task", providers=["copilot"]
        )
        assert matrix.formulas
        assert all(f.value_score > 0 for f in matrix.formulas)

    def test_no_history_is_heuristic(self, tmp_path):
        # Empty project → no usage history → heuristic basis, zero tasks.
        matrix = compute_formula_matrix(
            ticket_id="T-9",
            description="add a toggle",
            project_root=tmp_path,
            providers=["anthropic"],
        )
        assert matrix.history_tasks == 0
        assert all(f.cost_basis == "heuristic" for f in matrix.formulas)


class TestRealDataCalibration:
    def test_aggregate_groups_records_by_task(self):
        samples = [
            _coding_session("A", "anthropic", "claude-opus-4-8", 100_000, 20_000),
            _coding_session("A", "anthropic", "claude-opus-4-8", 50_000, 10_000),
            _coding_session("B", "anthropic", "claude-opus-4-8", 90_000, 30_000),
        ]
        stats = _aggregate_history_by_task(samples)
        assert stats is not None
        assert stats.task_count == 2  # two distinct task ids
        # Task A summed to 150k in / 30k out; B to 90k/30k → averages.
        assert stats.avg_task_input == (150_000 + 90_000) / 2
        assert stats.avg_task_output == (30_000 + 30_000) / 2
        n, in_pt, out_pt, cost_pt = stats.per_model[("anthropic", "claude-opus-4-8")]
        assert n == 2

    def test_records_without_tokens_are_ignored(self):
        assert _aggregate_history_by_task([]) is None
        assert (
            _aggregate_history_by_task(
                [{"task_id": "A", "input_tokens": 0, "output_tokens": 0}]
            )
            is None
        )

    def test_history_makes_cost_measured_and_real(self, tmp_path):
        # Two real Opus runs in this project → the Opus formulas are "measured".
        _write_cost_data(
            tmp_path,
            [
                _coding_session("A", "anthropic", "claude-opus-4-8", 200_000, 40_000),
                _coding_session("B", "anthropic", "claude-opus-4-8", 180_000, 36_000),
            ],
        )
        matrix = compute_formula_matrix(
            ticket_id="T-10",
            description="medium task",
            project_root=tmp_path,
            providers=["anthropic"],
            complexity_score=6.5,  # reference complexity → ratio ≈ 1.0
        )
        assert matrix.history_tasks == 2
        opus = next(
            f
            for f in matrix.formulas
            if f.model == "claude-opus-4-8" and f.effort == "none"
        )
        assert opus.cost_basis == "measured"
        # Tokens anchored to the ~190k/38k measured average (×effort 'none' = ×1).
        assert 180_000 <= opus.expected_input_tokens <= 200_000
        # Cost priced through the real catalog ($5/$25 per MTok for Opus).
        expected = (
            opus.expected_input_tokens * 5 + opus.expected_output_tokens * 25
        ) / 1_000_000
        assert abs(opus.expected_cost_usd - expected) < 1e-6
        # Measured basis is more confident than the heuristic default.
        assert opus.cost_confidence > 0.25

    def test_other_models_are_calibrated_not_measured(self, tmp_path):
        # History only for Opus; Sonnet has no runs → "calibrated" from the
        # project's per-task baseline, still priced through its own catalog rate.
        _write_cost_data(
            tmp_path,
            [_coding_session("A", "anthropic", "claude-opus-4-8", 200_000, 40_000)],
        )
        matrix = compute_formula_matrix(
            ticket_id="T-11",
            description="task",
            project_root=tmp_path,
            providers=["anthropic"],
        )
        sonnet = next(f for f in matrix.formulas if f.model == "claude-sonnet-4-6")
        assert sonnet.cost_basis == "calibrated"
        assert sonnet.expected_input_tokens > 0

    def test_legacy_usage_key_still_loads(self, tmp_path):
        # Files written under the old singular "usage" key must still calibrate.
        _write_cost_data(
            tmp_path,
            [_coding_session("A", "anthropic", "claude-opus-4-8", 150_000, 30_000)],
            key="usage",
        )
        matrix = compute_formula_matrix(
            ticket_id="T-12",
            description="task",
            project_root=tmp_path,
            providers=["anthropic"],
        )
        assert matrix.history_tasks == 1
        assert any(f.cost_basis == "measured" for f in matrix.formulas)
