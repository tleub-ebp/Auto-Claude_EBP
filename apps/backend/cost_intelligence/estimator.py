"""Pre-build cost estimation for an autonomous run.

Given a spec directory, estimate token usage + USD cost across the three
agent phases (planning, coding, qa) using:

  * the user's configured provider+model per phase (``phase_config``)
  * the spec's text size as a rough proxy for input tokens
  * historical multipliers per phase, calibrated against typical runs

Output is **consultative** — meant to be shown in a "do you want to
proceed?" modal before the agent burns real tokens. Always returns a
result (no raises) so the UI can show "estimation unavailable" instead
of breaking the kanban.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Per-phase multipliers, calibrated empirically:
#   * how much of the spec text the agent re-ingests (input)
#   * how many output tokens it tends to generate
# These are deliberately conservative — better to over-quote than to
# under-quote. Adjust here if telemetry shows we're systematically off.
_PHASE_PROFILES: dict[str, dict[str, float]] = {
    "planning": {
        # Planner reads spec + writes a plan: input ~= 2x spec, output ~= spec.
        "input_multiplier": 2.0,
        "output_tokens": 4_000,
        # Planning is one shot.
        "iterations": 1,
    },
    "coding": {
        # Coder iterates: each iteration re-reads context + writes diff.
        "input_multiplier": 3.0,
        "output_tokens": 6_000,
        # Typical run: 3-5 iterations. Use the high end.
        "iterations": 5,
    },
    "qa": {
        # QA reads everything coder wrote + reports.
        "input_multiplier": 4.0,
        "output_tokens": 3_000,
        # Reviewer + fixer = 2 sessions on average.
        "iterations": 2,
    },
}

# 1 token ~ 4 characters (Claude tokenizer rule of thumb).
_CHARS_PER_TOKEN = 4
# Floor: even an empty spec triggers some non-trivial work.
_MIN_INPUT_TOKENS = 500


@dataclass
class PhaseEstimate:
    phase: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    iterations: int
    estimated_cost_usd: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "provider": self.provider,
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "iterations": self.iterations,
            "estimated_cost_usd": round(self.estimated_cost_usd, 6),
            "notes": list(self.notes),
        }


@dataclass
class CostEstimate:
    spec_id: str
    spec_chars: int
    base_input_tokens: int
    phases: list[PhaseEstimate]
    total_cost_usd: float
    confidence: str  # "high" | "medium" | "low"
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "spec_chars": self.spec_chars,
            "base_input_tokens": self.base_input_tokens,
            "phases": [p.to_dict() for p in self.phases],
            "total_cost_usd": round(self.total_cost_usd, 6),
            "confidence": self.confidence,
            "warnings": list(self.warnings),
        }


def _read_spec_chars(spec_dir: Path) -> int:
    """Return total characters across the spec's main text files."""
    total = 0
    for name in (
        "spec.md",
        "requirements.json",
        "context.json",
        "implementation_plan.json",
    ):
        path = spec_dir / name
        if not path.exists():
            continue
        try:
            total += len(path.read_text(encoding="utf-8"))
        except OSError:
            continue
    return total


def _estimate_phase(
    phase: str,
    base_input_tokens: int,
    *,
    catalog,
    provider: str,
    model: str,
) -> PhaseEstimate:
    profile = _PHASE_PROFILES[phase]
    iterations = int(profile["iterations"])
    input_per_iter = int(base_input_tokens * profile["input_multiplier"])
    output_per_iter = int(profile["output_tokens"])

    total_input = input_per_iter * iterations
    total_output = output_per_iter * iterations

    notes: list[str] = []
    pricing = catalog.get_pricing(provider, model)
    if pricing is None:
        notes.append(
            f"no pricing data for {provider}/{model} — cost set to $0 "
            "(local model? unknown provider?)"
        )
        cost = 0.0
    else:
        cost = pricing.cost_for_tokens(
            input_tokens=total_input, output_tokens=total_output
        )

    return PhaseEstimate(
        phase=phase,
        provider=provider,
        model=model,
        input_tokens=total_input,
        output_tokens=total_output,
        iterations=iterations,
        estimated_cost_usd=cost,
        notes=notes,
    )


def estimate_build_cost(spec_dir: Path) -> CostEstimate:
    """Produce a structured pre-build cost estimate. Never raises.

    Returns a CostEstimate with ``confidence="low"`` and a populated
    ``warnings`` list when something prevents a precise estimate.
    """
    spec_dir = Path(spec_dir)
    warnings: list[str] = []

    if not spec_dir.exists() or not spec_dir.is_dir():
        return CostEstimate(
            spec_id=spec_dir.name,
            spec_chars=0,
            base_input_tokens=_MIN_INPUT_TOKENS,
            phases=[],
            total_cost_usd=0.0,
            confidence="low",
            warnings=[f"spec_dir does not exist: {spec_dir}"],
        )

    spec_chars = _read_spec_chars(spec_dir)
    if spec_chars == 0:
        warnings.append(
            "no spec text found (spec.md / requirements.json / context.json / "
            "implementation_plan.json) — using minimum-input estimate"
        )
    base_input_tokens = max(_MIN_INPUT_TOKENS, spec_chars // _CHARS_PER_TOKEN)

    # Resolve provider + model per phase. Failing imports / unknown spec
    # → fall back to the default Anthropic catalog entry.
    try:
        from phase_config import get_phase_model, get_phase_provider
    except ImportError:
        get_phase_model = None  # type: ignore[assignment]
        get_phase_provider = None  # type: ignore[assignment]
        warnings.append("phase_config not importable — using fallback model")

    try:
        from cost_intelligence.catalog import PricingCatalog
    except ImportError:
        # Should never happen — we live in cost_intelligence.
        return CostEstimate(
            spec_id=spec_dir.name,
            spec_chars=spec_chars,
            base_input_tokens=base_input_tokens,
            phases=[],
            total_cost_usd=0.0,
            confidence="low",
            warnings=warnings + ["pricing catalog not available"],
        )

    catalog = PricingCatalog()
    phases: list[PhaseEstimate] = []
    for phase_name in ("planning", "coding", "qa"):
        try:
            provider = (
                get_phase_provider(spec_dir) if get_phase_provider else None
            ) or "anthropic"
            model = (
                get_phase_model(spec_dir, phase_name, None)
                if get_phase_model
                else "claude-sonnet-4-6"
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"could not resolve {phase_name} model: {exc}")
            provider = "anthropic"
            model = "claude-sonnet-4-6"

        phases.append(
            _estimate_phase(
                phase_name,
                base_input_tokens,
                catalog=catalog,
                provider=provider,
                model=model,
            )
        )

    total = sum(p.estimated_cost_usd for p in phases)

    # Confidence heuristic:
    #   high   — spec text present + all phases priced
    #   medium — spec text present but one phase has no pricing
    #   low    — no spec text, or no phases priced
    has_unpriced = any(any("no pricing data" in n for n in p.notes) for p in phases)
    if spec_chars == 0 or all(p.estimated_cost_usd == 0 for p in phases):
        confidence = "low"
    elif has_unpriced or warnings:
        confidence = "medium"
    else:
        confidence = "high"

    return CostEstimate(
        spec_id=spec_dir.name,
        spec_chars=spec_chars,
        base_input_tokens=base_input_tokens,
        phases=phases,
        total_cost_usd=total,
        confidence=confidence,
        warnings=warnings,
    )
