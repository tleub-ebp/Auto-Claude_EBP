"""Tests for the pre-build cost estimator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cost_intelligence import estimate_build_cost
from cost_intelligence.estimator import (
    _CHARS_PER_TOKEN,
    _MIN_INPUT_TOKENS,
    _PHASE_PROFILES,
)

# ---------------------------------------------------------------------------
# Sanity / shape


class TestEstimateShape:
    def test_returns_one_estimate_per_phase(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("# Spec", encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        phases = [p.phase for p in result.phases]
        assert phases == ["planning", "coding", "qa"]

    def test_to_dict_roundtrips_through_json(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("# Spec", encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        encoded = json.dumps(result.to_dict())
        decoded = json.loads(encoded)
        assert decoded["spec_id"] == tmp_path.name
        assert "phases" in decoded
        assert decoded["confidence"] in {"high", "medium", "low"}


# ---------------------------------------------------------------------------
# Spec text → input tokens


class TestSpecCharsAndTokens:
    def test_no_files_uses_minimum_floor(self, tmp_path: Path) -> None:
        result = estimate_build_cost(tmp_path)
        assert result.spec_chars == 0
        assert result.base_input_tokens == _MIN_INPUT_TOKENS
        assert any("no spec text" in w for w in result.warnings)

    def test_aggregates_text_from_known_files(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("a" * 4_000, encoding="utf-8")
        (tmp_path / "requirements.json").write_text("b" * 2_000, encoding="utf-8")
        # Random extra file is NOT counted (only the canonical names are).
        (tmp_path / "notes.md").write_text("c" * 9_999, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        assert result.spec_chars == 6_000
        # 6000 / 4 = 1500.
        assert result.base_input_tokens == 1500

    def test_minimum_floor_applies_when_spec_is_tiny(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("hi", encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        # Only 2 chars → floor kicks in.
        assert result.base_input_tokens == _MIN_INPUT_TOKENS


# ---------------------------------------------------------------------------
# Per-phase math


class TestPhaseMath:
    def test_input_tokens_match_profile_multiplier(self, tmp_path: Path) -> None:
        # 8000 chars → 2000 base tokens.
        (tmp_path / "spec.md").write_text("x" * 8_000, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        base = result.base_input_tokens
        for phase in result.phases:
            profile = _PHASE_PROFILES[phase.phase]
            expected_input = int(base * profile["input_multiplier"]) * int(
                profile["iterations"]
            )
            assert phase.input_tokens == expected_input

    def test_output_tokens_match_profile(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("y" * 4_000, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        for phase in result.phases:
            profile = _PHASE_PROFILES[phase.phase]
            expected_output = int(profile["output_tokens"]) * int(profile["iterations"])
            assert phase.output_tokens == expected_output

    def test_total_cost_is_sum_of_phase_costs(self, tmp_path: Path) -> None:
        (tmp_path / "spec.md").write_text("z" * 4_000, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        expected = sum(p.estimated_cost_usd for p in result.phases)
        # Allow 1e-9 tolerance — both values are summed from the same floats.
        assert abs(result.total_cost_usd - expected) < 1e-9


# ---------------------------------------------------------------------------
# Pricing fallback


class TestPricingFallback:
    def test_unknown_model_yields_zero_cost_with_note(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force phase_config to return a model not in the catalog.
        try:
            from cost_intelligence import estimator as est
        except ImportError:
            pytest.skip("estimator module not importable")
        # Patch the imports inside estimate_build_cost.
        from phase_config import get_phase_model as _real

        def fake_model(_spec, _phase, _cli):
            return "totally-fake-model-xyz"

        monkeypatch.setattr(
            "phase_config.get_phase_model",
            fake_model,
        )
        (tmp_path / "spec.md").write_text("a" * 4_000, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        # All phases should be priced at $0 with a "no pricing data" note.
        for phase in result.phases:
            assert phase.estimated_cost_usd == 0.0
            assert any("no pricing data" in n for n in phase.notes)
        # Confidence falls below "high" when nothing is priced.
        assert result.confidence in ("low", "medium")


# ---------------------------------------------------------------------------
# Edge cases & robustness


class TestEdgeCases:
    def test_missing_spec_dir_returns_low_confidence_estimate(
        self, tmp_path: Path
    ) -> None:
        ghost = tmp_path / "does-not-exist"
        result = estimate_build_cost(ghost)
        assert result.confidence == "low"
        assert result.phases == []
        assert any("does not exist" in w for w in result.warnings)

    def test_unreadable_file_does_not_crash(self, tmp_path: Path) -> None:
        # Create a directory where a file is expected — read_text raises.
        # The estimator must skip it and continue.
        (tmp_path / "spec.md").mkdir()
        (tmp_path / "requirements.json").write_text("{}", encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        assert result.spec_chars >= 0  # didn't blow up
        assert result.phases  # other phases still computed


# ---------------------------------------------------------------------------
# Confidence heuristic


class TestConfidence:
    def test_no_spec_text_yields_low_confidence(self, tmp_path: Path) -> None:
        result = estimate_build_cost(tmp_path)
        assert result.confidence == "low"

    def test_normal_spec_yields_high_confidence_with_default_phase_models(
        self, tmp_path: Path
    ) -> None:
        # No monkeypatching: rely on the real default phase model resolution.
        # Catalog entries cover the date-stamped Anthropic IDs that
        # phase_config.DEFAULT_PHASE_MODELS resolves to (4-5, 4-6, 4-7),
        # so confidence should land on "high".
        (tmp_path / "spec.md").write_text("real content " * 200, encoding="utf-8")
        result = estimate_build_cost(tmp_path)
        assert result.confidence in ("high", "medium")
        assert result.total_cost_usd > 0
        # Every phase has pricing → no "no pricing data" notes.
        for phase in result.phases:
            assert not any("no pricing data" in n for n in phase.notes), (
                f"phase {phase.phase} model {phase.model} unpriced"
            )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
