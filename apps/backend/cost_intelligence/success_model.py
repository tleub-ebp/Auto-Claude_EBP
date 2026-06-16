"""Success-probability model for a (provider, model, effort) formula.

Given a task's complexity and a candidate formula, estimate the probability
that an autonomous run will land the feature successfully (green build +
QA approved). The model is deliberately **heuristic and free** — it spends
zero tokens — so it can be evaluated for the full cartesian product of the
pricing catalog without latency or cost.

The estimate blends four signals:

1. A capability prior derived from the model's tier (flagship / mid / small
   / local), inferred from the model id.
2. A complexity penalty: harder tasks lower the probability, and weaker
   models are penalised more steeply.
3. An effort boost: more reasoning effort raises the ceiling, with
   diminishing returns and a larger pay-off on complex tasks. "none" effort
   on a complex task is mildly penalised.
4. Historical calibration: when prior runs on the same provider/model exist,
   the heuristic is blended toward the observed success rate.

Output is a calibrated probability in [0.05, 0.98] plus a human-readable
rationale, so the UI can explain *why* a formula scores the way it does.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Effort axis — mirrors phase_config.THINKING_BUDGET_MAP ordering.
# ---------------------------------------------------------------------------

EFFORT_LEVELS: tuple[str, ...] = ("none", "low", "medium", "high", "ultrathink")

_EFFORT_INDEX: dict[str, int] = {level: i for i, level in enumerate(EFFORT_LEVELS)}


# ---------------------------------------------------------------------------
# Model tiers — capability prior at medium complexity / medium effort.
# ---------------------------------------------------------------------------

TIER_FLAGSHIP = "flagship"
TIER_MID = "mid"
TIER_SMALL = "small"
TIER_LOCAL = "local"

# Base success ceiling per tier for a *medium* complexity task at *medium*
# effort. These are conservative priors, tuned to be plausible rather than
# flattering — a flagship model is not guaranteed, a small model is not hopeless.
_TIER_BASE: dict[str, float] = {
    TIER_FLAGSHIP: 0.88,
    TIER_MID: 0.80,
    TIER_SMALL: 0.66,
    TIER_LOCAL: 0.56,
}

# How steeply each tier loses probability as the task gets harder.
_TIER_DIFFICULTY_SENSITIVITY: dict[str, float] = {
    TIER_FLAGSHIP: 0.18,
    TIER_MID: 0.28,
    TIER_SMALL: 0.42,
    TIER_LOCAL: 0.50,
}

# Patterns matched against the lower-cased model id, in priority order.
# First hit wins, so flagship markers are checked before generic ones.
_FLAGSHIP_RE = re.compile(
    r"(opus|fable|gpt-5|o3|o4|gemini-[0-9.]*-?pro|gemini-3|grok-4|"
    r"mistral-large|llama-4-maverick|deepseek-v3(?:\.\d+)?|llama-4-scout)"
)
_MID_RE = re.compile(
    r"(sonnet|gpt-4\.1|gpt-4o(?!-mini)|gemini-[0-9.]*-?flash|grok-2(?!-mini)|"
    r"codestral|mixtral|llama-3\.3-70b|qwen-2\.5-72b)"
)
_SMALL_RE = re.compile(
    r"(haiku|gpt-4o-mini|flash-lite|grok-2-mini|deepseek-coder|llama-3|"
    r"mistral-(?:small|tiny))"
)

# Providers whose models are always executed locally (no hosted capability).
_LOCAL_PROVIDERS = frozenset({"ollama"})


def infer_model_tier(provider: str, model: str) -> str:
    """Classify a (provider, model) pair into a capability tier."""
    if (provider or "").lower() in _LOCAL_PROVIDERS:
        return TIER_LOCAL
    m = (model or "").lower()
    # Strip a Bedrock-style "anthropic." / "meta." vendor prefix, but only when
    # it is a pure-alpha vendor token (so version dots like "2.5" are kept).
    m = re.sub(r"^[a-z]+\.", "", m)
    if _FLAGSHIP_RE.search(m):
        return TIER_FLAGSHIP
    if _SMALL_RE.search(m):
        return TIER_SMALL
    if _MID_RE.search(m):
        return TIER_MID
    # Unknown model id → assume a competent mid-tier rather than punish it.
    return TIER_MID


@dataclass
class SuccessEstimate:
    """A calibrated success probability for one formula."""

    provider: str
    model: str
    effort: str
    tier: str
    probability: float
    base_probability: float
    historical_samples: int
    rationale: list[str] = field(default_factory=list)
    components: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "effort": self.effort,
            "tier": self.tier,
            "probability": round(self.probability, 4),
            "base_probability": round(self.base_probability, 4),
            "historical_samples": self.historical_samples,
            "rationale": list(self.rationale),
            "components": {k: round(v, 4) for k, v in self.components.items()},
        }


def _complexity_factor(complexity_score: float) -> float:
    """Normalise a 1-13 complexity score to roughly [-0.5, +1.0].

    Medium complexity (≈5) maps to 0. Trivial tasks go negative (a bonus),
    very complex tasks (13) approach +1.0 (a penalty driver).
    """
    return (max(1.0, min(13.0, complexity_score)) - 5.0) / 8.0


def _effort_boost(effort: str, cfactor: float) -> float:
    """Probability gain from reasoning effort.

    Square-root growth gives diminishing returns. The pay-off is larger on
    complex tasks (where deliberation matters) and smaller on trivial ones.
    """
    idx = _EFFORT_INDEX.get(effort, 2)
    if idx == 0:
        # No extended thinking. Neutral on easy tasks, a small drag on hard ones.
        return -0.06 * max(0.0, cfactor)
    complexity_weight = 0.55 + 0.45 * max(0.0, cfactor + 0.3)
    boost = 0.065 * math.sqrt(idx) * complexity_weight
    return min(boost, 0.14)


def estimate_success_probability(
    provider: str,
    model: str,
    effort: str,
    *,
    complexity_score: float = 5.0,
    historical_rate: float | None = None,
    historical_samples: int = 0,
) -> SuccessEstimate:
    """Estimate P(feature success) for a (provider, model, effort) formula.

    ``historical_rate`` (0-1) and ``historical_samples`` let the caller blend
    the heuristic toward observed outcomes for this provider/model. When no
    history is available pass ``None`` / ``0``.
    """
    tier = infer_model_tier(provider, model)
    base = _TIER_BASE[tier]
    sensitivity = _TIER_DIFFICULTY_SENSITIVITY[tier]

    cfactor = _complexity_factor(complexity_score)
    difficulty_penalty = sensitivity * max(0.0, cfactor)
    easy_bonus = 0.10 * max(0.0, -cfactor)
    effort_delta = _effort_boost(effort, cfactor)

    heuristic = base - difficulty_penalty + easy_bonus + effort_delta
    heuristic = max(0.05, min(0.98, heuristic))

    components = {
        "tier_base": base,
        "difficulty_penalty": -difficulty_penalty,
        "easy_bonus": easy_bonus,
        "effort_delta": effort_delta,
    }

    probability = heuristic
    if historical_rate is not None and historical_samples > 0:
        # Confidence in history grows with sample count, capped at 0.6 so the
        # heuristic always retains a voice (priors guard against tiny samples).
        weight = min(0.6, historical_samples / (historical_samples + 8.0))
        probability = (1.0 - weight) * heuristic + weight * historical_rate
        components["historical_blend"] = weight
    probability = max(0.05, min(0.98, probability))

    rationale = _build_rationale(
        tier=tier,
        effort=effort,
        complexity_score=complexity_score,
        difficulty_penalty=difficulty_penalty,
        effort_delta=effort_delta,
        historical_rate=historical_rate,
        historical_samples=historical_samples,
    )

    return SuccessEstimate(
        provider=provider,
        model=model,
        effort=effort,
        tier=tier,
        probability=probability,
        base_probability=heuristic,
        historical_samples=historical_samples,
        rationale=rationale,
        components=components,
    )


def _build_rationale(
    *,
    tier: str,
    effort: str,
    complexity_score: float,
    difficulty_penalty: float,
    effort_delta: float,
    historical_rate: float | None,
    historical_samples: int,
) -> list[str]:
    parts: list[str] = [f"{tier} tier model"]
    if complexity_score >= 9:
        parts.append(f"high task complexity ({complexity_score:.0f}/13)")
    elif complexity_score <= 3:
        parts.append(f"low task complexity ({complexity_score:.0f}/13)")
    else:
        parts.append(f"moderate complexity ({complexity_score:.0f}/13)")
    if difficulty_penalty > 0.05:
        parts.append(f"−{difficulty_penalty * 100:.0f}% for difficulty")
    if effort_delta > 0.01:
        parts.append(f"+{effort_delta * 100:.0f}% from {effort} effort")
    elif effort_delta < -0.01:
        parts.append(f"{effort_delta * 100:.0f}% (no extended thinking)")
    if historical_rate is not None and historical_samples > 0:
        parts.append(
            f"calibrated on {historical_samples} similar run(s) "
            f"({historical_rate * 100:.0f}% observed)"
        )
    return parts
