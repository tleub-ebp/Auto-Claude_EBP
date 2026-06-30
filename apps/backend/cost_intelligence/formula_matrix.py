"""Formula matrix — compare every ``Provider × LLM × Effort`` combination.

For a single kanban ticket this computes, across the cartesian product of the
pricing catalog and the five effort levels, a :class:`Formula` carrying:

  * expected input / output / thinking tokens
  * a USD cost band (low / expected / high)
  * a calibrated probability of feature success
  * a default "value" score (success per dollar) for the initial ranking

The goal is to let the user pick *the best formula* before any tokens are
spent. Estimation is free — it never calls an LLM and never raises (a kanban
ticket must always render an estimate or a graceful "unavailable"). Costs are
priced through the real pricing catalog; token *volumes* are calibrated on the
project's measured run history when available (``cost_basis`` = "measured" /
"calibrated") and fall back to synthetic per-subtask heuristics otherwise
(``cost_basis`` = "heuristic").

A ticket usually has **no spec yet** (the spec is written during planning),
so the footprint is derived from the task title/description when no spec
directory exists, and refined from the spec when one is present.
"""

from __future__ import annotations

import logging
import math
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
# Floor for the band once real history tightens it (never claim more precision).
_MIN_COST_BAND = 0.10

# Reference complexity (midpoint of the 1-13 scale) — the "typical" task that
# the project's measured per-task history is assumed to represent. A ticket's
# real-data baseline is scaled by ``complexity / _REFERENCE_COMPLEXITY``.
_REFERENCE_COMPLEXITY = 6.5
_COMPLEXITY_RATIO_BOUNDS = (0.4, 2.5)

# Anthropic (and most providers) bill extended-thinking tokens at the output
# rate, so measured output already contains the reasoning. We don't add a
# separate thinking estimate on the measured path (that would double-count);
# instead we let a higher effort inflate the *billed output* by this fraction
# of its thinking-budget ratio, keeping the effort→cost gradient monotonic.
_THINK_OUTPUT_WEIGHT = 0.35

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
    # How the cost/token figures were obtained:
    #   "measured"   — this exact provider/model has real run history here
    #   "calibrated" — real history exists (other models), volumes scaled from it
    #   "heuristic"  — no history, synthetic per-subtask volumes (real prices)
    cost_basis: str = "heuristic"
    # 0-1 confidence in the cost figure (rises with measured history).
    cost_confidence: float = 0.25
    # True when this is a local model actually pulled into the running Ollama
    # server (vs a generic catalog entry the user hasn't downloaded yet).
    installed: bool = False
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
            "cost_basis": self.cost_basis,
            "cost_confidence": round(self.cost_confidence, 2),
            "installed": self.installed,
            "rationale": list(self.rationale),
        }


@dataclass
class FormulaMatrix:
    """All formulas for one ticket, plus the footprint that produced them."""

    ticket_id: str
    complexity_score: float
    footprint: SpecFootprint
    history_samples: int
    # Distinct completed tasks found in the project's real usage history. When
    # > 0 the cost figures are calibrated on measured runs, not pure heuristics.
    history_tasks: int = 0
    formulas: list[Formula] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        from dataclasses import asdict

        return {
            "ticket_id": self.ticket_id,
            "complexity_score": round(self.complexity_score, 2),
            "footprint": asdict(self.footprint),
            "history_samples": self.history_samples,
            "history_tasks": self.history_tasks,
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


@dataclass
class _HistoryStats:
    """Real per-task aggregates derived from the project's usage history."""

    task_count: int
    avg_task_input: float
    avg_task_output: float
    # (provider, model) -> (tasks_seen, avg_input_per_task, avg_output_per_task,
    #                        avg_cost_per_task)
    per_model: dict[tuple[str, str], tuple[int, float, float, float]]


def _aggregate_history_by_task(
    samples: list[dict[str, Any]],
) -> _HistoryStats | None:
    """Aggregate per-session usage records into real per-task footprints.

    ``usage_tracker`` writes one record per agent session (planning, coding,
    each QA loop…). To estimate what a whole task costs we sum every record
    that shares a ``task_id``/``spec_id`` into a per-task total, then average
    across tasks. Also tracks, per (provider, model), the average tokens/cost
    it contributed per task it was used on — so a model we have actually run
    is anchored to its own measured footprint. Returns ``None`` when no record
    carries usable token counts (caller falls back to heuristics).
    """
    per_task_in: dict[str, int] = {}
    per_task_out: dict[str, int] = {}
    pm_in: dict[tuple[str, str], int] = {}
    pm_out: dict[tuple[str, str], int] = {}
    pm_cost: dict[tuple[str, str], float] = {}
    pm_tasks: dict[tuple[str, str], set[str]] = {}

    for i, s in enumerate(samples):
        in_tok = max(0, int(s.get("input_tokens", 0) or 0))
        out_tok = max(0, int(s.get("output_tokens", 0) or 0))
        cost = max(0.0, float(s.get("cost", 0.0) or 0.0))
        if in_tok == 0 and out_tok == 0:
            continue
        # Each session without a task id is treated as its own task so distinct
        # work is never collapsed together.
        task = str(s.get("task_id") or s.get("spec_id") or f"__rec_{i}")
        per_task_in[task] = per_task_in.get(task, 0) + in_tok
        per_task_out[task] = per_task_out.get(task, 0) + out_tok

        provider = str(s.get("provider", "")).lower()
        model = str(s.get("model", ""))
        if provider and model:
            key = (provider, model)
            pm_in[key] = pm_in.get(key, 0) + in_tok
            pm_out[key] = pm_out.get(key, 0) + out_tok
            pm_cost[key] = pm_cost.get(key, 0.0) + cost
            pm_tasks.setdefault(key, set()).add(task)

    task_count = len(per_task_in)
    if task_count == 0:
        return None

    avg_in = sum(per_task_in.values()) / task_count
    avg_out = sum(per_task_out.values()) / task_count
    per_model = {
        key: (
            len(tasks),
            pm_in[key] / len(tasks),
            pm_out[key] / len(tasks),
            pm_cost[key] / len(tasks),
        )
        for key, tasks in pm_tasks.items()
    }
    return _HistoryStats(task_count, avg_in, avg_out, per_model)


def _effort_multipliers(effort: str) -> tuple[int, float, float, float]:
    """Return (effort_idx, input_mult, output_mult, thinking_mult) for an effort."""
    effort_idx = EFFORT_LEVELS.index(effort) if effort in EFFORT_LEVELS else 2
    # Effort makes the agent re-read more context and emit more reasoning.
    input_mult = 1.0 + 0.03 * effort_idx
    output_mult = 1.0 + 0.05 * effort_idx
    thinking_budget = _EFFORT_THINKING_BUDGET.get(effort, _REFERENCE_THINKING_BUDGET)
    thinking_mult = thinking_budget / _REFERENCE_THINKING_BUDGET  # none → 0
    return effort_idx, input_mult, output_mult, thinking_mult


def _compute_tokens(
    footprint: SpecFootprint,
    effort: str,
    avg_in: int,
    avg_out: int,
    avg_thinking: int,
    qa_rate: float,
) -> tuple[int, int, int]:
    """Expected (input, output, thinking) tokens for a footprint at an effort."""
    qa_mult = 1.0 + QA_ITERATION_MULTIPLIER * qa_rate
    base = footprint.subtask_count * footprint.complexity_score * qa_mult

    _, input_mult, output_mult, thinking_mult = _effort_multipliers(effort)

    expected_in = int(avg_in * base * input_mult)
    expected_out = int(avg_out * base * output_mult)
    expected_thinking = int(avg_thinking * base * thinking_mult)
    return expected_in, expected_out, expected_thinking


def _compute_tokens_from_history(
    base_in: float,
    base_out: float,
    effort: str,
    complexity_score: float,
) -> tuple[int, int, int]:
    """Expected (input, output, thinking) tokens from a measured per-task baseline.

    ``base_in``/``base_out`` are the real average input/output tokens a task
    used. We scale them by the ticket's complexity relative to a typical task,
    then modulate by effort. Output already contains billed reasoning, so the
    thinking component stays 0 and a higher effort inflates output instead.
    """
    ratio = max(
        _COMPLEXITY_RATIO_BOUNDS[0],
        min(_COMPLEXITY_RATIO_BOUNDS[1], complexity_score / _REFERENCE_COMPLEXITY),
    )
    _, input_mult, output_mult, thinking_mult = _effort_multipliers(effort)
    effective_output_mult = output_mult * (
        1.0 + _THINK_OUTPUT_WEIGHT * max(0.0, thinking_mult - 1.0)
    )
    expected_in = int(base_in * ratio * input_mult)
    expected_out = int(base_out * ratio * effective_output_mult)
    return expected_in, expected_out, 0


# Rough energy estimate (kWh per 1M tokens) for a locally-served model when we
# can't tell its size — same order of magnitude as the catalog's built-in ones.
_DEFAULT_LOCAL_ENERGY_KWH = 0.07


def discover_local_models(
    base_url: str | None = None, timeout: float = 1.5
) -> list[str]:
    """Best-effort list of models actually pulled into the local Ollama server.

    Lets the Formula Lab compare the user's REAL local LLMs (including
    HF-discovered ``hf.co/org/model`` ones) — not just the generic catalog
    entries. Reads ``{base}/api/tags``. Never raises and never blocks for long:
    on any error (server down, timeout) it returns an empty list.
    """
    import json as _json
    import os as _os
    import urllib.request as _req

    base = (
        base_url
        or _os.environ.get("OLLAMA_BASE_URL")
        or _os.environ.get("LOCAL_LLM_BASE_URL")
        or "http://localhost:11434"
    ).rstrip("/")
    # Strip an OpenAI-style suffix if the configured URL carries one.
    for suffix in ("/v1/chat/completions", "/v1"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    try:
        if not base.startswith(("http://", "https://")):
            return []
        with _req.urlopen(f"{base}/api/tags", timeout=timeout) as resp:  # noqa: S310
            data = _json.loads(resp.read().decode())
    except Exception:  # noqa: BLE001 — discovery is optional, never fatal
        return []
    names: list[str] = []
    for m in data.get("models", []) or []:
        name = m.get("name") or m.get("model")
        if name:
            names.append(str(name))
    # Always include the explicitly configured default, even if not pulled yet.
    configured = _os.environ.get("OLLAMA_MODEL") or _os.environ.get("LOCAL_LLM_MODEL")
    if configured and configured not in names:
        names.append(configured)
    return names


def _register_local_models(catalog: PricingCatalog, models: list[str]) -> None:
    """Add user-supplied local model names to the catalog (priced at $0)."""
    for name in models:
        if not name or catalog.get_pricing("ollama", name):
            continue
        catalog.add_pricing(
            ModelPricing(
                provider="ollama",
                model=name,
                input=0.0,
                output=0.0,
                energy_kwh_per_million_tok=_DEFAULT_LOCAL_ENERGY_KWH,
            )
        )


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
    local_models: list[str] | None = None,
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

    # Make the user's real local LLMs first-class in the matrix (priced at $0).
    # The same set tells us which ollama entries are actually *pulled* (vs the
    # generic catalog suggestions the user hasn't downloaded yet).
    installed_local = {m for m in (local_models or []) if m}
    if local_models:
        _register_local_models(catalog, local_models)

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
    # Real per-task token/cost aggregates — when present, cost figures are
    # calibrated on measured runs rather than synthetic per-subtask volumes.
    history = _aggregate_history_by_task(samples)

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
                        history=history,
                        installed=provider == "ollama" and model in installed_local,
                    )
                )

    # Default ranking: best value first.
    formulas.sort(key=lambda f: f.value_score, reverse=True)

    return FormulaMatrix(
        ticket_id=ticket_id,
        complexity_score=complexity_score,
        footprint=footprint,
        history_samples=len(samples),
        history_tasks=history.task_count if history else 0,
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
    history: _HistoryStats | None = None,
    installed: bool = False,
) -> Formula:
    # Choose the token basis: measured (this model's own runs) > calibrated
    # (other models' runs in this project) > heuristic (synthetic volumes).
    pm = history.per_model.get((provider, model)) if history else None
    if history is not None and pm is not None:
        base_in, base_out = pm[1], pm[2]
        cost_basis = "measured"
        observed_tasks = pm[0]
    elif history is not None:
        base_in, base_out = history.avg_task_input, history.avg_task_output
        cost_basis = "calibrated"
        observed_tasks = history.task_count
    else:
        base_in = base_out = 0.0
        cost_basis = "heuristic"
        observed_tasks = 0

    if cost_basis == "heuristic":
        expected_in, expected_out, expected_thinking = _compute_tokens(
            footprint, effort, avg_in, avg_out, avg_thinking, qa_rate
        )
        band = _COST_BAND
        cost_confidence = 0.25
    else:
        expected_in, expected_out, expected_thinking = _compute_tokens_from_history(
            base_in, base_out, effort, complexity_score
        )
        # More measured tasks → tighter band → higher confidence.
        band = max(_MIN_COST_BAND, _COST_BAND * math.exp(-observed_tasks / 8.0))
        cost_confidence = round(max(0.3, min(0.95, 1.0 - band)), 2)

    expected_cost = pricing.cost_for_tokens(
        input_tokens=expected_in,
        output_tokens=expected_out,
        thinking_tokens=expected_thinking,
    )
    low_cost = expected_cost * (1.0 - band)
    high_cost = expected_cost * (1.0 + band)

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
        cost_basis=cost_basis,
        cost_confidence=cost_confidence,
        installed=installed,
        rationale=success.rationale,
    )
