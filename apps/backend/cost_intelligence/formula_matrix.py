"""Formula matrix — compare every ``Provider × LLM × Effort`` combination.

For a single kanban ticket this computes, across the cartesian product of the
pricing catalog and the five effort levels, a :class:`Formula` carrying:

  * expected input / output / thinking tokens
  * a USD cost band (low / expected / high)
  * a calibrated probability of feature success
  * a default "value" score (success per dollar) for the initial ranking

The goal is to let the user pick *the best formula* before any tokens are
spent. Estimation is heuristic and free — it never calls an LLM and never
raises (a kanban ticket must always render an estimate or a graceful
"unavailable").

A ticket usually has **no spec yet** (the spec is written during planning),
so the footprint is derived from the task title/description when no spec
directory exists, and refined from the spec when one is present.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .catalog import ModelPricing, PricingCatalog
from .cost_predictor import (
    DEFAULT_INPUT_TOKENS_PER_SUBTASK,
    DEFAULT_OUTPUT_TOKENS_PER_SUBTASK,
    DEFAULT_THINKING_TOKENS_PER_SUBTASK,
    QA_ITERATION_MULTIPLIER,
    SpecFootprint,
    _derive_history_averages,
    _load_history_samples,
    extract_spec_footprint,
)
from .success_model import EFFORT_LEVELS, estimate_success_probability

logger = logging.getLogger(__name__)

# Thinking-token budget per effort level, mirroring phase_config.THINKING_BUDGET_MAP.
# "medium" (4096) is the reference point against which avg_thinking is scaled.
_EFFORT_THINKING_BUDGET: dict[str, int] = {
    "none": 0,
    "low": 1024,
    "medium": 4096,
    "high": 16384,
    "ultrathink": 63999,
}
_REFERENCE_THINKING_BUDGET = 4096

# Confidence band width (±) applied around the point cost estimate.
_COST_BAND = 0.35

# Words that hint at a larger / riskier task when no spec is available.
_COMPLEXITY_KEYWORDS = re.compile(
    r"\b(refactor|migration|migrate|auth|authentication|security|database|"
    r"schema|integration|integrate|distributed|async|real-?time|performance|"
    r"optimi[sz]e|breaking|infrastructure|multiple|end-to-end|architecture)\b",
    re.IGNORECASE,
)


@dataclass
class Formula:
    """A single Provider × LLM × Effort candidate."""

    provider: str
    model: str
    effort: str
    tier: str
    per_token_billed: bool
    expected_input_tokens: int
    expected_output_tokens: int
    expected_thinking_tokens: int
    expected_cost_usd: float
    low_cost_usd: float
    high_cost_usd: float
    success_probability: float
    value_score: float
    energy_kwh: float
    rationale: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "effort": self.effort,
            "tier": self.tier,
            "per_token_billed": self.per_token_billed,
            "expected_input_tokens": self.expected_input_tokens,
            "expected_output_tokens": self.expected_output_tokens,
            "expected_thinking_tokens": self.expected_thinking_tokens,
            "expected_cost_usd": round(self.expected_cost_usd, 4),
            "low_cost_usd": round(self.low_cost_usd, 4),
            "high_cost_usd": round(self.high_cost_usd, 4),
            "success_probability": round(self.success_probability, 4),
            "value_score": round(self.value_score, 4),
            "energy_kwh": round(self.energy_kwh, 4),
            "rationale": list(self.rationale),
        }


@dataclass
class FormulaMatrix:
    """All formulas for one ticket, plus the footprint that produced them."""

    ticket_id: str
    complexity_score: float
    footprint: SpecFootprint
    history_samples: int
    formulas: list[Formula] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        from dataclasses import asdict

        return {
            "ticket_id": self.ticket_id,
            "complexity_score": round(self.complexity_score, 2),
            "footprint": asdict(self.footprint),
            "history_samples": self.history_samples,
            "formulas": [f.to_dict() for f in self.formulas],
            "warnings": list(self.warnings),
        }


def _heuristic_complexity_from_text(text: str) -> float:
    """A cheap 1-13 complexity estimate from a task title/description.

    Used when no spec (and no analytics history) is available. Combines text
    length with a count of risk/complexity keywords. Deliberately rough — it
    only needs to separate "tweak a label" from "rework the auth layer".
    """
    if not text:
        return 4.0
    words = len(text.split())
    length_component = min(5.0, words / 25.0)  # ~125 words → +5
    keyword_hits = len(set(_COMPLEXITY_KEYWORDS.findall(text)))
    keyword_component = min(5.0, keyword_hits * 1.2)
    return max(1.0, min(13.0, 3.0 + length_component + keyword_component))


def _footprint_from_complexity(complexity_score: float) -> SpecFootprint:
    """Synthesize a footprint when no spec directory exists yet."""
    # Map complexity onto an expected subtask count and a complexity multiplier
    # compatible with cost_predictor's footprint semantics (0.5-5.0).
    subtasks = max(1, round(complexity_score / 2.5))
    complexity_mult = max(0.5, min(5.0, complexity_score / 3.0))
    return SpecFootprint(
        subtask_count=subtasks,
        touched_files=0,
        loc_in_scope=0,
        has_implementation_plan=False,
        complexity_score=complexity_mult,
    )


def _per_model_history(
    samples: list[dict[str, Any]],
) -> dict[tuple[str, str], tuple[float, int]]:
    """Aggregate observed success rate per (provider, model) from history.

    Each sample may carry ``provider``, ``model`` and either a boolean
    ``success`` or a 0-1 ``success_rate``. Returns ``{(provider, model):
    (rate, n)}``. Missing fields are skipped silently.
    """
    buckets: dict[tuple[str, str], list[float]] = {}
    for s in samples:
        provider = str(s.get("provider", "")).lower()
        model = str(s.get("model", ""))
        if not provider or not model:
            continue
        if "success_rate" in s and s["success_rate"] is not None:
            rate = float(s["success_rate"])
        elif "success" in s and s["success"] is not None:
            rate = 1.0 if s["success"] else 0.0
        else:
            continue
        buckets.setdefault((provider, model), []).append(max(0.0, min(1.0, rate)))
    return {k: (sum(v) / len(v), len(v)) for k, v in buckets.items()}


def _compute_tokens(
    footprint: SpecFootprint,
    effort: str,
    avg_in: int,
    avg_out: int,
    avg_thinking: int,
    qa_rate: float,
) -> tuple[int, int, int]:
    """Expected (input, output, thinking) tokens for a footprint at an effort."""
    effort_idx = EFFORT_LEVELS.index(effort) if effort in EFFORT_LEVELS else 2
    qa_mult = 1.0 + QA_ITERATION_MULTIPLIER * qa_rate
    base = footprint.subtask_count * footprint.complexity_score * qa_mult

    # Effort makes the agent re-read more context and emit more reasoning.
    input_mult = 1.0 + 0.03 * effort_idx
    output_mult = 1.0 + 0.05 * effort_idx
    thinking_budget = _EFFORT_THINKING_BUDGET.get(effort, _REFERENCE_THINKING_BUDGET)
    thinking_mult = thinking_budget / _REFERENCE_THINKING_BUDGET  # none → 0

    expected_in = int(avg_in * base * input_mult)
    expected_out = int(avg_out * base * output_mult)
    expected_thinking = int(avg_thinking * base * thinking_mult)
    return expected_in, expected_out, expected_thinking


def _default_value_score(success: float, cost: float, per_token: bool) -> float:
    """Initial ranking score: success per dollar, with a floor for free models.

    Flat-rate / local models (cost ≈ 0) are scored on success alone scaled up,
    so they don't dominate purely by being free, but still rank competitively.
    """
    if cost <= 1e-4:
        # Free at the margin: reward success but keep it below a strong paid
        # high-success formula so "free but mediocre" doesn't always win.
        return round(success * 8.0, 4)
    return round(success / cost, 4)


def compute_formula_matrix(
    *,
    ticket_id: str,
    description: str = "",
    spec_dir: Path | None = None,
    project_root: Path | None = None,
    providers: list[str] | None = None,
    complexity_score: float | None = None,
    catalog: PricingCatalog | None = None,
) -> FormulaMatrix:
    """Compute the full formula matrix for one ticket. Never raises.

    Args:
        ticket_id: identifier for the ticket (used only for echo).
        description: task title/description, used to estimate complexity when
            no spec is available.
        spec_dir: optional spec directory; refines the footprint when present.
        project_root: project root, used to load cost/success history.
        providers: restrict to these providers (lower-case). ``None`` = all.
        complexity_score: override the derived 1-13 complexity.
        catalog: pricing catalog (defaults to the built-in one).
    """
    catalog = catalog or PricingCatalog()
    warnings: list[str] = []

    # --- footprint + complexity -------------------------------------------
    footprint: SpecFootprint
    if spec_dir is not None and Path(spec_dir).is_dir():
        footprint = extract_spec_footprint(Path(spec_dir))
        if complexity_score is None:
            # Map the footprint's 0.5-5.0 multiplier back to a 1-13 scale.
            complexity_score = max(1.0, min(13.0, footprint.complexity_score * 2.6))
    else:
        if complexity_score is None:
            complexity_score = _heuristic_complexity_from_text(description)
        footprint = _footprint_from_complexity(complexity_score)
        if not description and spec_dir is not None:
            warnings.append(
                "no spec directory and no description — using minimum footprint"
            )

    # --- history -----------------------------------------------------------
    samples: list[dict[str, Any]] = []
    if project_root is not None:
        try:
            samples = _load_history_samples(Path(project_root))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"could not load history: {exc}")
    avg_in, avg_out, avg_thinking, qa_rate = _derive_history_averages(samples)
    if not avg_thinking:
        avg_thinking = DEFAULT_THINKING_TOKENS_PER_SUBTASK
    if not avg_in:
        avg_in = DEFAULT_INPUT_TOKENS_PER_SUBTASK
    if not avg_out:
        avg_out = DEFAULT_OUTPUT_TOKENS_PER_SUBTASK
    per_model_hist = _per_model_history(samples)

    # --- cartesian product -------------------------------------------------
    provider_filter = {p.lower() for p in providers} if providers else None
    formulas: list[Formula] = []
    for provider in catalog.list_providers():
        if provider_filter is not None and provider not in provider_filter:
            continue
        for model in catalog.list_models(provider):
            pricing = catalog.get_pricing(provider, model) or ModelPricing(
                provider=provider, model=model
            )
            per_token = pricing.input > 0 or pricing.output > 0
            hist_rate, hist_n = per_model_hist.get((provider, model), (None, 0))
            for effort in EFFORT_LEVELS:
                formulas.append(
                    _build_formula(
                        provider=provider,
                        model=model,
                        effort=effort,
                        pricing=pricing,
                        per_token=per_token,
                        footprint=footprint,
                        complexity_score=complexity_score,
                        avg_in=avg_in,
                        avg_out=avg_out,
                        avg_thinking=avg_thinking,
                        qa_rate=qa_rate,
                        hist_rate=hist_rate,
                        hist_n=hist_n,
                    )
                )

    # Default ranking: best value first.
    formulas.sort(key=lambda f: f.value_score, reverse=True)

    return FormulaMatrix(
        ticket_id=ticket_id,
        complexity_score=complexity_score,
        footprint=footprint,
        history_samples=len(samples),
        formulas=formulas,
        warnings=warnings,
    )


def _build_formula(
    *,
    provider: str,
    model: str,
    effort: str,
    pricing: ModelPricing,
    per_token: bool,
    footprint: SpecFootprint,
    complexity_score: float,
    avg_in: int,
    avg_out: int,
    avg_thinking: int,
    qa_rate: float,
    hist_rate: float | None,
    hist_n: int,
) -> Formula:
    expected_in, expected_out, expected_thinking = _compute_tokens(
        footprint, effort, avg_in, avg_out, avg_thinking, qa_rate
    )
    expected_cost = pricing.cost_for_tokens(
        input_tokens=expected_in,
        output_tokens=expected_out,
        thinking_tokens=expected_thinking,
    )
    low_cost = expected_cost * (1.0 - _COST_BAND)
    high_cost = expected_cost * (1.0 + _COST_BAND)

    energy_kwh = (
        (expected_in + expected_out + expected_thinking)
        * pricing.energy_kwh_per_million_tok
        / 1_000_000
    )

    success = estimate_success_probability(
        provider,
        model,
        effort,
        complexity_score=complexity_score,
        historical_rate=hist_rate,
        historical_samples=hist_n,
    )
    value_score = _default_value_score(success.probability, expected_cost, per_token)

    return Formula(
        provider=provider,
        model=model,
        effort=effort,
        tier=success.tier,
        per_token_billed=per_token,
        expected_input_tokens=expected_in,
        expected_output_tokens=expected_out,
        expected_thinking_tokens=expected_thinking,
        expected_cost_usd=expected_cost,
        low_cost_usd=low_cost,
        high_cost_usd=high_cost,
        success_probability=success.probability,
        value_score=value_score,
        energy_kwh=energy_kwh,
        rationale=success.rationale,
    )
