"""Tests for the success-probability model."""

from __future__ import annotations

import pytest
from cost_intelligence.success_model import (
    EFFORT_LEVELS,
    TIER_FLAGSHIP,
    TIER_LOCAL,
    TIER_MID,
    TIER_SMALL,
    estimate_success_probability,
    infer_model_tier,
)


class TestInferModelTier:
    @pytest.mark.parametrize(
        "provider,model,expected",
        [
            ("anthropic", "claude-opus-4-8", TIER_FLAGSHIP),
            ("anthropic", "claude-fable-5", TIER_FLAGSHIP),
            ("openai", "gpt-5", TIER_FLAGSHIP),
            ("google", "gemini-2.5-pro", TIER_FLAGSHIP),
            ("anthropic", "claude-sonnet-4-6", TIER_MID),
            ("openai", "gpt-4o", TIER_MID),
            ("anthropic", "claude-haiku-4-6", TIER_SMALL),
            ("openai", "gpt-4o-mini", TIER_SMALL),
            ("ollama", "llama-3.3-70b", TIER_LOCAL),
            ("aws", "anthropic.claude-opus-4-8", TIER_FLAGSHIP),
        ],
    )
    def test_tiers(self, provider, model, expected):
        assert infer_model_tier(provider, model) == expected

    def test_unknown_model_defaults_to_mid(self):
        assert infer_model_tier("acme", "totally-unknown-model") == TIER_MID

    def test_ollama_always_local_even_for_strong_model(self):
        # An opus-like name on a local provider is still local capability.
        assert infer_model_tier("ollama", "mistral-large") == TIER_LOCAL


class TestSuccessProbability:
    def test_probability_in_bounds(self):
        for effort in EFFORT_LEVELS:
            est = estimate_success_probability(
                "anthropic", "claude-opus-4-8", effort, complexity_score=7
            )
            assert 0.05 <= est.probability <= 0.98

    def test_flagship_beats_small_on_complex_task(self):
        opus = estimate_success_probability(
            "anthropic", "claude-opus-4-8", "high", complexity_score=12
        )
        haiku = estimate_success_probability(
            "anthropic", "claude-haiku-4-6", "high", complexity_score=12
        )
        assert opus.probability > haiku.probability

    def test_higher_effort_raises_probability_on_complex_task(self):
        low = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "low", complexity_score=11
        )
        high = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "high", complexity_score=11
        )
        assert high.probability > low.probability

    def test_complex_task_lowers_probability(self):
        easy = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "medium", complexity_score=2
        )
        hard = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "medium", complexity_score=12
        )
        assert easy.probability > hard.probability

    def test_historical_calibration_pulls_toward_observed(self):
        # Heuristic ~0.8 for sonnet/medium/moderate, but history says 0.3.
        no_hist = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "medium", complexity_score=5
        )
        with_hist = estimate_success_probability(
            "anthropic",
            "claude-sonnet-4-6",
            "medium",
            complexity_score=5,
            historical_rate=0.3,
            historical_samples=20,
        )
        assert with_hist.probability < no_hist.probability
        assert with_hist.historical_samples == 20
        assert "historical_blend" in with_hist.components

    def test_small_sample_history_barely_moves_estimate(self):
        base = estimate_success_probability(
            "anthropic", "claude-sonnet-4-6", "medium", complexity_score=5
        )
        tiny = estimate_success_probability(
            "anthropic",
            "claude-sonnet-4-6",
            "medium",
            complexity_score=5,
            historical_rate=0.0,
            historical_samples=1,
        )
        # weight = 1/9 ≈ 0.11 → modest pull, not a collapse to 0.
        assert tiny.probability > base.probability * 0.5

    def test_rationale_is_populated(self):
        est = estimate_success_probability(
            "anthropic", "claude-opus-4-8", "high", complexity_score=10
        )
        assert est.rationale
        assert any("tier" in r for r in est.rationale)
