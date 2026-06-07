"""Regression tests for scheduling/cost_estimator.py.

Covers:
- Bug #26 (CRITICAL): fuzzy `model.startswith(known_model)` matched
  `gpt-4o-mini` against `gpt-4`, causing potential 200x mis-billing.
- Bug #33 (HIGH): budget alerts were appended on EVERY recorded usage
  once a threshold was crossed (unbounded `_alerts` growth + UI spam).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from scheduling.cost_estimator import (  # noqa: E402
    PROVIDER_PRICING,
    AlertLevel,
    CostEstimator,
    ProjectBudget,
)

# ─────────────────────────────────────────────────────────────────────
# Bug #26: fuzzy model match must NOT cross-contaminate base models
# ─────────────────────────────────────────────────────────────────────


class TestFuzzyModelMatch:
    def test_exact_match_wins(self) -> None:
        ce = CostEstimator()
        oai = PROVIDER_PRICING.get("openai", {})
        if "gpt-4" not in oai:
            pytest.skip("provider pricing layout changed")
        # Make sure exact-name lookup returns exact pricing.
        assert ce.get_token_price("openai", "gpt-4") == oai["gpt-4"]

    def test_mini_does_not_collapse_to_base(self) -> None:
        """The CRITICAL bug: gpt-4o-mini fell back to gpt-4 pricing
        (or vice-versa, dict order dependent) — up to 200x off."""
        ce = CostEstimator()
        oai = PROVIDER_PRICING.get("openai", {})
        if "gpt-4" not in oai or "gpt-4o-mini" not in oai:
            pytest.skip("test requires gpt-4 + gpt-4o-mini in catalog")

        p_mini = ce.get_token_price("openai", "gpt-4o-mini")
        p_4 = ce.get_token_price("openai", "gpt-4")
        # Must return mini pricing for mini, not gpt-4 pricing.
        assert p_mini == oai["gpt-4o-mini"]
        # And the two must actually differ (otherwise the test is vacuous).
        assert p_mini != p_4, (
            "test setup invalid: gpt-4 and gpt-4o-mini have identical "
            "pricing; cannot validate cross-contamination fix"
        )

    def test_date_suffix_variant_matches_base(self) -> None:
        """Legitimate fuzzy match: `gpt-4-0314` should resolve to `gpt-4`."""
        ce = CostEstimator()
        oai = PROVIDER_PRICING.get("openai", {})
        if "gpt-4" not in oai:
            pytest.skip("provider pricing layout changed")
        # Inject a fake date-suffix variant by query, not by mutation.
        result = ce.get_token_price("openai", "gpt-4-0314")
        assert result == oai["gpt-4"]

    def test_unknown_model_returns_zero(self) -> None:
        ce = CostEstimator()
        result = ce.get_token_price("openai", "totally-made-up-model-xyz")
        assert result == {"input": 0.0, "output": 0.0}

    def test_custom_pricing_takes_precedence(self) -> None:
        ce = CostEstimator()
        ce.set_custom_pricing("openai", "gpt-4", 999.0, 999.0)
        result = ce.get_token_price("openai", "gpt-4")
        assert result == {"input": 999.0, "output": 999.0}


# ─────────────────────────────────────────────────────────────────────
# Bug #33: alert dedup — same level fires once per crossing
# ─────────────────────────────────────────────────────────────────────


class TestBudgetAlertDedup:
    def _setup_estimator_with_budget(self) -> CostEstimator:
        ce = CostEstimator()
        ce._budgets["proj-1"] = ProjectBudget(
            project_id="proj-1",
            limit=10.0,
            period="total",
            warning_threshold=0.5,
            critical_threshold=0.8,
        )
        return ce

    def test_warning_alert_fires_once_per_crossing(self) -> None:
        """Pre-fix: every record_usage past 50% spawned a new WARNING.
        Post-fix: only one alert per level transition.

        Use cheap custom pricing so we can step through thresholds in
        controlled increments rather than depending on real-model rates.
        """
        ce = self._setup_estimator_with_budget()
        ce.set_custom_pricing("test", "model", 1_000_000.0, 1_000_000.0)
        # 1 input + 1 output token at $1M/M = $1 + $1 = $2 (20% of $10).
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=1,
            output_tokens=1,
        )
        # Cross WARNING (50% threshold) — total spend $6.
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=2,
            output_tokens=2,
        )
        alerts_after_warning = len(ce._alerts)
        assert ce._alerts[-1].level == AlertLevel.WARNING

        # Stay in WARNING band (still 50-80%): $7.
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=0,
            output_tokens=1,
        )
        # No new alert appended.
        assert len(ce._alerts) == alerts_after_warning

    def test_level_transition_emits_new_alert(self) -> None:
        """Crossing from WARNING → CRITICAL should fire a new alert."""
        ce = self._setup_estimator_with_budget()
        ce.set_custom_pricing("test", "model", 1_000_000.0, 1_000_000.0)
        # Push to WARNING band (60% of $10).
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=3,
            output_tokens=3,
        )
        assert ce._alerts[-1].level == AlertLevel.WARNING
        warning_count = len(ce._alerts)

        # Push to CRITICAL band (90% of $10).
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=2,
            output_tokens=1,
        )
        assert len(ce._alerts) > warning_count
        assert ce._alerts[-1].level in (AlertLevel.CRITICAL, AlertLevel.EXCEEDED)

    def test_unrelated_project_unaffected(self) -> None:
        ce = self._setup_estimator_with_budget()
        ce.set_custom_pricing("test", "model", 1_000_000.0, 1_000_000.0)
        ce._budgets["proj-2"] = ProjectBudget(
            project_id="proj-2", limit=100.0, period="total"
        )
        # Project-1 hits warning ($6 of $10 = 60%).
        ce.record_usage(
            project_id="proj-1",
            provider="test",
            model="model",
            input_tokens=3,
            output_tokens=3,
        )
        # Project-2 records small usage — no alert for proj-2 (well under
        # 50% of $100).
        ce.record_usage(
            project_id="proj-2",
            provider="test",
            model="model",
            input_tokens=1,
            output_tokens=1,
        )
        proj2_alerts = [a for a in ce._alerts if a.project_id == "proj-2"]
        assert proj2_alerts == []
