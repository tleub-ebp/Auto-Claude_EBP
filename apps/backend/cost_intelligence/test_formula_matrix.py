"""Tests for the Provider × LLM × Effort formula matrix."""

from __future__ import annotations

import json

from cost_intelligence.formula_matrix import (
    _heuristic_complexity_from_text,
    compute_formula_matrix,
)
from cost_intelligence.success_model import EFFORT_LEVELS


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
