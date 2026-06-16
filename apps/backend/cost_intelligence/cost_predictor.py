"""
Cost Predictor — Ex-ante cost estimation before a spec is executed.

Given a spec directory and the currently selected model, predicts:
  - expected input / output / thinking tokens
  - expected USD cost with a confidence band (low / likely / high)
  - expected number of QA iterations based on historical stats
  - a comparison table across alternate models

The predictor combines three signals:

1. Static heuristics derived from the spec (file count touched, lines of
   code in scope, number of subtasks in the implementation plan).
2. Historical statistics pulled from prior completed specs in the same
   project when available (average tokens per subtask, QA loop rate).
3. The pricing catalog from ``cost_intelligence.catalog``.

The goal is NOT cryptographic precision — it is to give users an order of
magnitude before they commit to running a spec, and to let them compare
models side-by-side.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .catalog import ModelPricing, PricingCatalog

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Heuristic constants — tunable defaults used when no history is available.
# ---------------------------------------------------------------------------

# Average prompt tokens consumed per subtask by the coder agent. This
# includes the system prompt, injected context, and tool results.
DEFAULT_INPUT_TOKENS_PER_SUBTASK = 18_000

# Average completion tokens produced per subtask.
DEFAULT_OUTPUT_TOKENS_PER_SUBTASK = 4_500

# Average thinking tokens budgeted when extended thinking is enabled.
DEFAULT_THINKING_TOKENS_PER_SUBTASK = 2_500

# Additional multiplier added for each QA iteration (reviewer + fixer).
QA_ITERATION_MULTIPLIER = 0.35

# Default probability that a spec triggers one QA iteration beyond the
# initial pass when no history exists.
DEFAULT_QA_ITERATION_RATE = 0.6

# Confidence band width (±) applied around the point estimate.
CONFIDENCE_BAND = 0.35


@dataclass
class SpecFootprint:
    """Static characteristics extracted from a spec directory."""

    subtask_count: int = 1
    touched_files: int = 0
    loc_in_scope: int = 0
    has_implementation_plan: bool = False
    complexity_score: float = 1.0


@dataclass
class CostPrediction:
    """A single cost prediction for one model."""

    provider: str
    model: str
    expected_input_tokens: int
    expected_output_tokens: int
    expected_thinking_tokens: int
    expected_cost_usd: float
    low_cost_usd: float
    high_cost_usd: float
    expected_qa_iterations: float
    confidence: float
    rationale: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PredictionReport:
    """Full prediction report for a spec."""

    spec_id: str
    footprint: SpecFootprint
    selected: CostPrediction
    alternatives: list[CostPrediction] = field(default_factory=list)
    history_samples: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "footprint": asdict(self.footprint),
            "selected": self.selected.to_dict(),
            "alternatives": [alt.to_dict() for alt in self.alternatives],
            "history_samples": self.history_samples,
        }


# ---------------------------------------------------------------------------
# Footprint extraction
# ---------------------------------------------------------------------------


def _safe_load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("Could not load %s: %s", path, exc)
        return None


def extract_spec_footprint(spec_dir: Path) -> SpecFootprint:
    """Inspect a spec directory and return its static footprint."""
    spec_dir = Path(spec_dir)
    footprint = SpecFootprint()

    plan = _safe_load_json(spec_dir / "implementation_plan.json")
    if plan and isinstance(plan, dict):
        subtasks = plan.get("subtasks") or plan.get("tasks") or []
        footprint.subtask_count = max(1, len(subtasks))
        footprint.has_implementation_plan = True

        touched: set[str] = set()
        loc = 0
        for task in subtasks:
            for f in task.get("files", []) or []:
                touched.add(f)
            loc += int(task.get("estimated_loc", 0) or 0)
        footprint.touched_files = len(touched)
        footprint.loc_in_scope = loc

    ctx = _safe_load_json(spec_dir / "context.json")
    if ctx and isinstance(ctx, dict):
        complexity = ctx.get("complexity_score")
        if isinstance(complexity, (int, float)):
            footprint.complexity_score = max(0.5, min(float(complexity), 5.0))

    return footprint


# ---------------------------------------------------------------------------
# History lookup
# ---------------------------------------------------------------------------


def _load_history_samples(project_root: Path) -> list[dict[str, Any]]:
    """Load cost history from previously completed specs.

    Looks at ``.workpilot/cost_data.json`` and ``.workpilot/specs/*/usage.json``.
    Returns an empty list when nothing is available — the caller falls back to
    static heuristics.
    """
    samples: list[dict[str, Any]] = []

    cost_data = project_root / ".workpilot" / "cost_data.json"
    data = _safe_load_json(cost_data)
    if data and isinstance(data, dict):
        # usage_tracker writes the canonical key "usages" (plural); accept the
        # legacy "usage" spelling too so older files still calibrate estimates.
        records = data.get("usages")
        if records is None:
            records = data.get("usage", [])
        for entry in records or []:
            if isinstance(entry, dict):
                samples.append(entry)

    specs_dir = project_root / ".workpilot" / "specs"
    if specs_dir.is_dir():
        for usage_file in specs_dir.glob("*/usage.json"):
            entry = _safe_load_json(usage_file)
            if isinstance(entry, dict):
                samples.append(entry)

    return samples


def _derive_history_averages(
    samples: list[dict[str, Any]],
) -> tuple[int, int, int, float]:
    """Return (in_tok, out_tok, thinking_tok, qa_rate) averages."""
    if not samples:
        return (
            DEFAULT_INPUT_TOKENS_PER_SUBTASK,
            DEFAULT_OUTPUT_TOKENS_PER_SUBTASK,
            DEFAULT_THINKING_TOKENS_PER_SUBTASK,
            DEFAULT_QA_ITERATION_RATE,
        )

    total_in = total_out = total_thinking = 0
    qa_iters = 0
    valid = 0
    for s in samples:
        in_tok = int(s.get("input_tokens", 0) or 0)
        out_tok = int(s.get("output_tokens", 0) or 0)
        if in_tok <= 0 and out_tok <= 0:
            continue
        total_in += in_tok
        total_out += out_tok
        total_thinking += int(s.get("thinking_tokens", 0) or 0)
        qa_iters += int(s.get("qa_iterations", 0) or 0)
        valid += 1

    if valid == 0:
        return (
            DEFAULT_INPUT_TOKENS_PER_SUBTASK,
            DEFAULT_OUTPUT_TOKENS_PER_SUBTASK,
            DEFAULT_THINKING_TOKENS_PER_SUBTASK,
            DEFAULT_QA_ITERATION_RATE,
        )

    avg_in = total_in // valid
    avg_out = total_out // valid
    avg_thinking = (
        total_thinking // valid
        if total_thinking
        else DEFAULT_THINKING_TOKENS_PER_SUBTASK
    )
    qa_rate = qa_iters / valid
    return avg_in, avg_out, avg_thinking, qa_rate


# ---------------------------------------------------------------------------
# Predictor
# ---------------------------------------------------------------------------


class CostPredictor:
    """Produce ex-ante cost predictions for a spec."""

    def __init__(self, catalog: PricingCatalog | None = None) -> None:
        self.catalog = catalog or PricingCatalog()

    def predict(
        self,
        spec_dir: Path,
        *,
        project_root: Path | None = None,
        selected_model: str | None = None,
        selected_provider: str | None = None,
        alternative_models: list[tuple[str, str]] | None = None,
        thinking_enabled: bool = True,
    ) -> PredictionReport:
        """Predict cost for running ``spec_dir`` with ``selected_model``.

        ``alternative_models`` is a list of ``(provider, model)`` pairs that
        will be included in the report for side-by-side comparison.
        """
        spec_dir = Path(spec_dir)
        project_root = Path(project_root) if project_root else spec_dir.parents[2]

        footprint = extract_spec_footprint(spec_dir)
        samples = _load_history_samples(project_root)
        avg_in, avg_out, avg_thinking, qa_rate = _derive_history_averages(samples)

        selected_provider = selected_provider or "anthropic"
        selected_model = selected_model or "claude-sonnet-4-6"

        selected = self._predict_for_model(
            provider=selected_provider,
            model=selected_model,
            footprint=footprint,
            avg_in=avg_in,
            avg_out=avg_out,
            avg_thinking=avg_thinking,
            qa_rate=qa_rate,
            thinking_enabled=thinking_enabled,
            history_samples=len(samples),
        )

        alternatives = []
        for provider, model in alternative_models or []:
            if provider == selected_provider and model == selected_model:
                continue
            alternatives.append(
                self._predict_for_model(
                    provider=provider,
                    model=model,
                    footprint=footprint,
                    avg_in=avg_in,
                    avg_out=avg_out,
                    avg_thinking=avg_thinking,
                    qa_rate=qa_rate,
                    thinking_enabled=thinking_enabled,
                    history_samples=len(samples),
                )
            )

        spec_id = spec_dir.name
        return PredictionReport(
            spec_id=spec_id,
            footprint=footprint,
            selected=selected,
            alternatives=alternatives,
            history_samples=len(samples),
        )

    def _predict_for_model(
        self,
        *,
        provider: str,
        model: str,
        footprint: SpecFootprint,
        avg_in: int,
        avg_out: int,
        avg_thinking: int,
        qa_rate: float,
        thinking_enabled: bool,
        history_samples: int,
    ) -> CostPrediction:
        pricing = self.catalog.get_pricing(provider, model)
        if pricing is None:
            pricing = ModelPricing(provider=provider, model=model)
            logger.info(
                "No pricing entry for %s/%s — predicting $0 cost", provider, model
            )

        qa_iterations = qa_rate
        complexity_mult = footprint.complexity_score
        qa_mult = 1.0 + QA_ITERATION_MULTIPLIER * qa_iterations

        expected_in = int(avg_in * footprint.subtask_count * complexity_mult * qa_mult)
        expected_out = int(
            avg_out * footprint.subtask_count * complexity_mult * qa_mult
        )
        expected_thinking = int(
            avg_thinking * footprint.subtask_count * complexity_mult
            if thinking_enabled
            else 0
        )

        expected_cost = pricing.cost_for_tokens(
            input_tokens=expected_in,
            output_tokens=expected_out,
            thinking_tokens=expected_thinking,
        )

        low_cost = expected_cost * (1.0 - CONFIDENCE_BAND)
        high_cost = expected_cost * (1.0 + CONFIDENCE_BAND)

        confidence = self._confidence(history_samples, footprint)
        rationale = self._build_rationale(
            footprint=footprint,
            qa_iterations=qa_iterations,
            thinking_enabled=thinking_enabled,
            history_samples=history_samples,
        )

        return CostPrediction(
            provider=provider,
            model=model,
            expected_input_tokens=expected_in,
            expected_output_tokens=expected_out,
            expected_thinking_tokens=expected_thinking,
            expected_cost_usd=round(expected_cost, 4),
            low_cost_usd=round(low_cost, 4),
            high_cost_usd=round(high_cost, 4),
            expected_qa_iterations=round(qa_iterations, 2),
            confidence=round(confidence, 2),
            rationale=rationale,
        )

    @staticmethod
    def _confidence(history_samples: int, footprint: SpecFootprint) -> float:
        """Return a confidence score in [0, 1]."""
        sample_factor = 1.0 - math.exp(-history_samples / 20.0)
        plan_factor = 0.6 if footprint.has_implementation_plan else 0.3
        return max(0.1, min(0.95, 0.3 + 0.5 * sample_factor + 0.2 * plan_factor))

    @staticmethod
    def _build_rationale(
        *,
        footprint: SpecFootprint,
        qa_iterations: float,
        thinking_enabled: bool,
        history_samples: int,
    ) -> list[str]:
        parts: list[str] = []
        parts.append(
            f"{footprint.subtask_count} subtask(s) detected"
            f" (complexity ×{footprint.complexity_score:.1f})"
        )
        if footprint.touched_files:
            parts.append(
                f"{footprint.touched_files} file(s), ~{footprint.loc_in_scope} LOC in scope"
            )
        if thinking_enabled:
            parts.append("extended thinking enabled")
        parts.append(f"expected QA iterations: {qa_iterations:.2f}")
        parts.append(
            f"{history_samples} historical sample(s) used"
            if history_samples
            else "no history — using default heuristics"
        )
        return parts
