"""Intelligent Multi-Provider Router — Route LLM requests to the optimal provider.

Automatically routes requests to the best provider/model based on task type,
performance history, cost constraints, and provider availability. Supports
fallback chains, A/B testing, per-phase pipeline configuration, and
performance scoring.

Feature 6.1 — Routing intelligent multi-provider.

Extends the existing multi-provider infrastructure:
- ``src/connectors/llm_base.py`` — BaseLLMProvider interface
- ``src/connectors/llm_discovery.py`` — Dynamic provider discovery
- ``apps/backend/phase_config.py`` — Phase-specific model configuration
- ``apps/backend/scheduling/cost_estimator.py`` — Cost tracking

Example:
    >>> from apps.backend.scheduling.intelligent_router import IntelligentRouter
    >>> router = IntelligentRouter()
    >>> router.register_provider("anthropic", "claude-sonnet-4-20250514", capabilities=["coding", "planning"])
    >>> router.register_provider("openai", "gpt-4o", capabilities=["coding", "review"])
    >>> selection = router.route("coding", context={"complexity": "high"})
    >>> print(f"Selected: {selection.provider}/{selection.model}")
"""

import logging
import statistics
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class TaskType(str, Enum):
    """Types of tasks for routing decisions."""

    PLANNING = "planning"
    CODING = "coding"
    REVIEW = "review"
    QA = "qa"
    DOCUMENTATION = "documentation"
    REFACTORING = "refactoring"
    QUICK_FEEDBACK = "quick_feedback"
    GENERAL = "general"


class ProviderStatus(str, Enum):
    """Health status of a provider."""

    AVAILABLE = "available"
    DEGRADED = "degraded"
    RATE_LIMITED = "rate_limited"
    DOWN = "down"
    UNKNOWN = "unknown"


class RoutingStrategy(str, Enum):
    """Strategy for selecting a provider."""

    BEST_PERFORMANCE = "best_performance"
    CHEAPEST = "cheapest"
    LOWEST_LATENCY = "lowest_latency"
    ROUND_ROBIN = "round_robin"
    WEIGHTED = "weighted"
    FALLBACK_CHAIN = "fallback_chain"


class ABTestStatus(str, Enum):
    """Status of an A/B test."""

    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class ProviderConfig:
    """Configuration for a registered provider/model."""

    provider: str
    model: str
    capabilities: list[str] = field(default_factory=list)
    status: ProviderStatus = ProviderStatus.AVAILABLE
    priority: int = 5  # 1 = highest, 10 = lowest
    max_tokens: int = 4096
    cost_per_1m_input: float = 0.0
    cost_per_1m_output: float = 0.0
    avg_latency_ms: float = 0.0
    is_local: bool = False
    rate_limit_remaining: int = -1  # -1 = unknown
    rate_limit_reset_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def provider_model_key(self) -> str:
        return f"{self.provider}/{self.model}"

    @property
    def is_available(self) -> bool:
        return self.status in (ProviderStatus.AVAILABLE, ProviderStatus.DEGRADED)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["status"] = self.status.value
        d["provider_model_key"] = self.provider_model_key
        return d


@dataclass
class PerformanceRecord:
    """A performance measurement for a provider on a specific task type."""

    provider: str
    model: str
    task_type: str
    latency_ms: float
    quality_score: float  # 0-100
    success: bool
    tokens_used: int = 0
    cost: float = 0.0
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RoutingDecision:
    """Result of a routing decision."""

    provider: str
    model: str
    reason: str
    strategy: RoutingStrategy
    score: float = 0.0
    alternatives: list[dict[str, Any]] = field(default_factory=list)
    fallback_chain: list[str] = field(default_factory=list)
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()
        if isinstance(self.strategy, str):
            self.strategy = RoutingStrategy(self.strategy)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["strategy"] = self.strategy.value
        return d


@dataclass
class PipelineConfig:
    """Per-phase pipeline configuration (planning → model A, coding → model B, etc.)."""

    pipeline_id: str
    name: str
    phase_routing: dict[str, dict[str, str]] = field(default_factory=dict)
    description: str = ""

    def get_provider_for_phase(self, phase: str) -> tuple[str, str] | None:
        """Returns (provider, model) for a phase, or None."""
        config = self.phase_routing.get(phase)
        if config:
            return config.get("provider", ""), config.get("model", "")
        return None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ABTest:
    """An A/B test comparing two provider configurations."""

    test_id: str
    name: str
    task_type: str
    provider_a: str
    model_a: str
    provider_b: str
    model_b: str
    status: ABTestStatus = ABTestStatus.RUNNING
    results_a: list[dict[str, Any]] = field(default_factory=list)
    results_b: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat()
        if isinstance(self.status, str):
            self.status = ABTestStatus(self.status)

    @property
    def total_runs(self) -> int:
        return len(self.results_a) + len(self.results_b)

    def get_summary(self) -> dict[str, Any]:
        """Get comparison summary."""

        def _avg(records: list[dict], key: str) -> float:
            vals = [r.get(key, 0) for r in records]
            return statistics.mean(vals) if vals else 0.0

        return {
            "test_id": self.test_id,
            "name": self.name,
            "status": self.status.value,
            "total_runs": self.total_runs,
            "a": {
                "provider": self.provider_a,
                "model": self.model_a,
                "runs": len(self.results_a),
                "avg_quality": round(_avg(self.results_a, "quality_score"), 1),
                "avg_latency_ms": round(_avg(self.results_a, "latency_ms"), 0),
                "avg_cost": round(_avg(self.results_a, "cost"), 6),
            },
            "b": {
                "provider": self.provider_b,
                "model": self.model_b,
                "runs": len(self.results_b),
                "avg_quality": round(_avg(self.results_b, "quality_score"), 1),
                "avg_latency_ms": round(_avg(self.results_b, "latency_ms"), 0),
                "avg_cost": round(_avg(self.results_b, "cost"), 6),
            },
        }

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["status"] = self.status.value
        d["summary"] = self.get_summary()
        return d


# ---------------------------------------------------------------------------
# Default provider capabilities / recommendations
# ---------------------------------------------------------------------------

DEFAULT_TASK_RECOMMENDATIONS: dict[str, list[dict[str, str]]] = {
    "planning": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
        {"provider": "google", "model": "gemini-2.0-pro"},
    ],
    "coding": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
        {"provider": "deepseek", "model": "deepseek-coder"},
    ],
    "review": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
    ],
    "qa": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
    ],
    "quick_feedback": [
        {"provider": "ollama", "model": "llama3:8b"},
        {"provider": "anthropic", "model": "claude-haiku-4-20250514"},
        {"provider": "openai", "model": "gpt-4o-mini"},
    ],
    "documentation": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o-mini"},
    ],
    "refactoring": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
    ],
    "general": [
        {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
        {"provider": "openai", "model": "gpt-4o"},
    ],
}


# ---------------------------------------------------------------------------
# IntelligentRouter
# ---------------------------------------------------------------------------


class IntelligentRouter:
    """Routes LLM requests to the optimal provider based on context.

    Args:
        default_strategy: Default routing strategy.
        max_history: Maximum performance records to retain.
    """

    def __init__(
        self,
        default_strategy: str = "best_performance",
        max_history: int = 1000,
    ):
        self.default_strategy = RoutingStrategy(default_strategy)
        self.max_history = max_history

        self._providers: dict[str, ProviderConfig] = {}
        self._performance_history: list[PerformanceRecord] = []
        self._pipelines: dict[str, PipelineConfig] = {}
        self._ab_tests: dict[str, ABTest] = {}
        self._fallback_chains: dict[str, list[str]] = {}
        self._routing_log: list[RoutingDecision] = []
        self._round_robin_index: dict[str, int] = {}
        self._ab_counter = 0
        self._pipeline_counter = 0

    # -- Provider management ------------------------------------------------

    def register_provider(
        self,
        provider: str,
        model: str,
        capabilities: list[str] | None = None,
        priority: int = 5,
        cost_per_1m_input: float = 0.0,
        cost_per_1m_output: float = 0.0,
        is_local: bool = False,
        max_tokens: int = 4096,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderConfig:
        """Register a provider/model for routing.

        Args:
            provider: Provider name (anthropic, openai, etc.).
            model: Model identifier.
            capabilities: List of task types this model is good at.
            priority: Priority (1=highest, 10=lowest).
            cost_per_1m_input: Cost per 1M input tokens.
            cost_per_1m_output: Cost per 1M output tokens.
            is_local: Whether this is a local model (free).
            max_tokens: Max output tokens supported.
            metadata: Additional metadata.

        Returns:
            The registered ProviderConfig.
        """
        config = ProviderConfig(
            provider=provider,
            model=model,
            capabilities=capabilities or [],
            priority=priority,
            cost_per_1m_input=cost_per_1m_input,
            cost_per_1m_output=cost_per_1m_output,
            is_local=is_local,
            max_tokens=max_tokens,
            metadata=metadata or {},
        )
        key = config.provider_model_key
        self._providers[key] = config
        logger.info(
            "Registered provider %s (priority=%d, capabilities=%s)",
            key,
            priority,
            capabilities,
        )
        return config

    def unregister_provider(self, provider: str, model: str) -> bool:
        """Remove a provider from the routing table."""
        key = f"{provider}/{model}"
        if key in self._providers:
            del self._providers[key]
            return True
        return False

    def get_provider(self, provider: str, model: str) -> ProviderConfig | None:
        """Get a registered provider config."""
        return self._providers.get(f"{provider}/{model}")

    def get_available_providers(self, task_type: str = "") -> list[ProviderConfig]:
        """Get all available providers, optionally filtered by capability."""
        results = [p for p in self._providers.values() if p.is_available]
        if task_type:
            results = [
                p for p in results if task_type in p.capabilities or not p.capabilities
            ]
        return sorted(results, key=lambda p: p.priority)

    def update_provider_status(self, provider: str, model: str, status: str) -> bool:
        """Update a provider's health status."""
        key = f"{provider}/{model}"
        if key not in self._providers:
            return False
        self._providers[key].status = ProviderStatus(status)
        logger.info("Provider %s status updated to %s", key, status)
        return True

    def mark_rate_limited(self, provider: str, model: str, reset_at: str = "") -> bool:
        """Mark a provider as rate-limited."""
        key = f"{provider}/{model}"
        if key not in self._providers:
            return False
        self._providers[key].status = ProviderStatus.RATE_LIMITED
        self._providers[key].rate_limit_reset_at = reset_at
        return True

    # -- Performance tracking -----------------------------------------------

    def record_performance(
        self,
        provider: str,
        model: str,
        task_type: str,
        latency_ms: float,
        quality_score: float,
        success: bool,
        tokens_used: int = 0,
        cost: float = 0.0,
    ) -> PerformanceRecord:
        """Record a performance measurement for a provider.

        Args:
            provider: Provider name.
            model: Model identifier.
            task_type: Type of task performed.
            latency_ms: Request latency in milliseconds.
            quality_score: Quality score (0-100).
            success: Whether the request succeeded.
            tokens_used: Total tokens consumed.
            cost: Cost of the request.

        Returns:
            The recorded PerformanceRecord.
        """
        record = PerformanceRecord(
            provider=provider,
            model=model,
            task_type=task_type,
            latency_ms=latency_ms,
            quality_score=quality_score,
            success=success,
            tokens_used=tokens_used,
            cost=cost,
        )
        self._performance_history.append(record)

        # Trim history
        if len(self._performance_history) > self.max_history:
            self._performance_history = self._performance_history[-self.max_history :]

        # Update provider avg latency
        key = f"{provider}/{model}"
        if key in self._providers:
            relevant = [
                r
                for r in self._performance_history
                if r.provider == provider and r.model == model and r.success
            ]
            if relevant:
                self._providers[key].avg_latency_ms = statistics.mean(
                    r.latency_ms for r in relevant[-20:]
                )

        return record

    def get_performance_scores(
        self, task_type: str = ""
    ) -> dict[str, dict[str, float]]:
        """Get aggregated performance scores per provider/model.

        Returns:
            Dict mapping provider_model_key to {avg_quality, avg_latency, success_rate}.
        """
        grouped: dict[str, list[PerformanceRecord]] = {}
        for r in self._performance_history:
            if task_type and r.task_type != task_type:
                continue
            key = f"{r.provider}/{r.model}"
            grouped.setdefault(key, []).append(r)

        scores: dict[str, dict[str, float]] = {}
        for key, records in grouped.items():
            successful = [r for r in records if r.success]
            scores[key] = {
                "avg_quality": statistics.mean(r.quality_score for r in successful)
                if successful
                else 0.0,
                "avg_latency_ms": statistics.mean(r.latency_ms for r in successful)
                if successful
                else 0.0,
                "success_rate": len(successful) / len(records) * 100
                if records
                else 0.0,
                "total_requests": len(records),
                "avg_cost": statistics.mean(r.cost for r in records)
                if records
                else 0.0,
            }
        return scores

    # -- Routing ------------------------------------------------------------

    def route(
        self,
        task_type: str,
        strategy: str | None = None,
        context: dict[str, Any] | None = None,
        max_cost: float = 0.0,
        pipeline_id: str = "",
    ) -> RoutingDecision | None:
        """Route a request to the optimal provider.

        Args:
            task_type: Type of task (coding, planning, review, etc.).
            strategy: Override routing strategy (defaults to instance default).
            context: Additional context (complexity, urgency, etc.).
            max_cost: Maximum allowable list-price sum (input + output rate
                per 1M tokens). NOTE: this is a list-price filter, NOT an
                expected per-call cost. A model with input=$3 and output=$15
                requires max_cost >= 18. For asymmetric workloads (e.g.,
                coding tasks with 3:1 input:output), use the cost_estimator
                to compute expected per-call spend before deciding budget.
            pipeline_id: If set, use pipeline phase configuration.

        Returns:
            RoutingDecision with the selected provider, or None if no provider available.
        """
        strat = RoutingStrategy(strategy) if strategy else self.default_strategy
        ctx = context or {}

        # Pipeline override
        if pipeline_id and pipeline_id in self._pipelines:
            pipeline = self._pipelines[pipeline_id]
            phase_config = pipeline.get_provider_for_phase(task_type)
            if phase_config:
                prov, mod = phase_config
                if (
                    f"{prov}/{mod}" in self._providers
                    and self._providers[f"{prov}/{mod}"].is_available
                ):
                    decision = RoutingDecision(
                        provider=prov,
                        model=mod,
                        reason=f"Pipeline '{pipeline.name}' phase config for '{task_type}'",
                        strategy=strat,
                        score=100.0,
                    )
                    self._routing_log.append(decision)
                    return decision

        # Get candidates
        candidates = self.get_available_providers(task_type)
        if not candidates:
            return None

        # Apply cost filter
        if max_cost > 0:
            candidates = [
                c
                for c in candidates
                if c.cost_per_1m_input + c.cost_per_1m_output <= max_cost or c.is_local
            ]
            if not candidates:
                return None

        # Select based on strategy
        if strat == RoutingStrategy.CHEAPEST:
            decision = self._route_cheapest(candidates, task_type)
        elif strat == RoutingStrategy.LOWEST_LATENCY:
            decision = self._route_lowest_latency(candidates, task_type)
        elif strat == RoutingStrategy.ROUND_ROBIN:
            decision = self._route_round_robin(candidates, task_type)
        elif strat == RoutingStrategy.FALLBACK_CHAIN:
            decision = self._route_fallback(candidates, task_type)
        else:  # BEST_PERFORMANCE or WEIGHTED
            decision = self._route_best_performance(candidates, task_type)

        if decision:
            # Build fallback chain
            chain = [
                f"{c.provider}/{c.model}"
                for c in candidates
                if f"{c.provider}/{c.model}" != f"{decision.provider}/{decision.model}"
            ]
            decision.fallback_chain = chain[:3]
            self._routing_log.append(decision)

        return decision

    def _route_best_performance(
        self, candidates: list[ProviderConfig], task_type: str
    ) -> RoutingDecision:
        """Select provider with best combined quality + success rate."""
        scores = self.get_performance_scores(task_type)
        best = None
        best_score = -1.0

        for c in candidates:
            key = c.provider_model_key
            if key in scores:
                s = scores[key]
                # Weighted: 60% quality, 30% success rate, 10% inverse latency
                combined = (
                    s["avg_quality"] * 0.6
                    + s["success_rate"] * 0.3
                    + max(0, 100 - s["avg_latency_ms"] / 100) * 0.1
                )
            else:
                # No history — use priority-based default score
                combined = max(0, (10 - c.priority) * 10)

            if combined > best_score:
                best_score = combined
                best = c

        if not best:
            best = candidates[0]
            best_score = 50.0

        return RoutingDecision(
            provider=best.provider,
            model=best.model,
            reason=f"Best performance score ({best_score:.1f}) for task '{task_type}'",
            strategy=RoutingStrategy.BEST_PERFORMANCE,
            score=best_score,
            alternatives=[
                {"provider": c.provider, "model": c.model}
                for c in candidates
                if c != best
            ][:3],
        )

    def _route_cheapest(
        self, candidates: list[ProviderConfig], task_type: str
    ) -> RoutingDecision:
        """Select cheapest provider."""
        # Local models first (free)
        local = [c for c in candidates if c.is_local]
        if local:
            best = local[0]
            return RoutingDecision(
                provider=best.provider,
                model=best.model,
                reason=f"Local model (free) for task '{task_type}'",
                strategy=RoutingStrategy.CHEAPEST,
                score=100.0,
            )

        sorted_by_cost = sorted(
            candidates, key=lambda c: c.cost_per_1m_input + c.cost_per_1m_output
        )
        best = sorted_by_cost[0]
        total_cost = best.cost_per_1m_input + best.cost_per_1m_output
        return RoutingDecision(
            provider=best.provider,
            model=best.model,
            reason=f"Cheapest option (${total_cost:.2f}/1M tokens) for task '{task_type}'",
            strategy=RoutingStrategy.CHEAPEST,
            score=max(0, 100 - total_cost),
        )

    def _route_lowest_latency(
        self, candidates: list[ProviderConfig], task_type: str
    ) -> RoutingDecision:
        """Select lowest latency provider."""
        # Prefer providers with measured latency
        with_latency = [c for c in candidates if c.avg_latency_ms > 0]
        if with_latency:
            best = min(with_latency, key=lambda c: c.avg_latency_ms)
        else:
            best = candidates[0]

        return RoutingDecision(
            provider=best.provider,
            model=best.model,
            reason=f"Lowest latency ({best.avg_latency_ms:.0f}ms) for task '{task_type}'",
            strategy=RoutingStrategy.LOWEST_LATENCY,
            score=max(0, 100 - best.avg_latency_ms / 50),
        )

    def _route_round_robin(
        self, candidates: list[ProviderConfig], task_type: str
    ) -> RoutingDecision:
        """Round-robin across available providers."""
        idx = self._round_robin_index.get(task_type, 0)
        selected = candidates[idx % len(candidates)]
        self._round_robin_index[task_type] = idx + 1

        return RoutingDecision(
            provider=selected.provider,
            model=selected.model,
            reason=f"Round-robin selection (index={idx}) for task '{task_type}'",
            strategy=RoutingStrategy.ROUND_ROBIN,
            score=50.0,
        )

    def _route_fallback(
        self, candidates: list[ProviderConfig], task_type: str
    ) -> RoutingDecision:
        """Use configured fallback chain or priority order."""
        chain_key = task_type
        if chain_key in self._fallback_chains:
            for key in self._fallback_chains[chain_key]:
                if key in self._providers and self._providers[key].is_available:
                    prov, mod = key.split("/", 1)
                    return RoutingDecision(
                        provider=prov,
                        model=mod,
                        reason=f"Fallback chain selection for task '{task_type}'",
                        strategy=RoutingStrategy.FALLBACK_CHAIN,
                        score=80.0,
                        fallback_chain=[
                            k for k in self._fallback_chains[chain_key] if k != key
                        ],
                    )

        # Default: use priority order
        best = candidates[0]
        return RoutingDecision(
            provider=best.provider,
            model=best.model,
            reason=f"Priority fallback (priority={best.priority}) for task '{task_type}'",
            strategy=RoutingStrategy.FALLBACK_CHAIN,
            score=60.0,
        )

    def get_fallback(
        self, provider: str, model: str, task_type: str
    ) -> RoutingDecision | None:
        """Get fallback provider when the primary fails.

        Args:
            provider: The failed provider.
            model: The failed model.
            task_type: The task type.

        Returns:
            Alternative RoutingDecision, or None.
        """
        candidates = self.get_available_providers(task_type)
        failed_key = f"{provider}/{model}"
        candidates = [c for c in candidates if c.provider_model_key != failed_key]

        if not candidates:
            return None

        return self._route_best_performance(candidates, task_type)

    # -- Fallback chains ----------------------------------------------------

    def set_fallback_chain(self, task_type: str, chain: list[str]) -> None:
        """Set a fallback chain for a task type.

        Args:
            task_type: The task type.
            chain: Ordered list of 'provider/model' keys.
        """
        self._fallback_chains[task_type] = chain

    def get_fallback_chain(self, task_type: str) -> list[str]:
        """Get the fallback chain for a task type."""
        return self._fallback_chains.get(task_type, [])

    # -- Pipeline configuration ---------------------------------------------

    def create_pipeline(
        self,
        name: str,
        phase_routing: dict[str, dict[str, str]],
        description: str = "",
    ) -> PipelineConfig:
        """Create a per-phase pipeline configuration.

        Args:
            name: Pipeline name.
            phase_routing: Dict mapping phase -> {"provider": ..., "model": ...}.
            description: Optional description.

        Returns:
            The created PipelineConfig.
        """
        self._pipeline_counter += 1
        pipeline_id = f"pipe-{self._pipeline_counter:04d}"
        pipeline = PipelineConfig(
            pipeline_id=pipeline_id,
            name=name,
            phase_routing=phase_routing,
            description=description,
        )
        self._pipelines[pipeline_id] = pipeline
        return pipeline

    def get_pipeline(self, pipeline_id: str) -> PipelineConfig | None:
        """Get a pipeline configuration."""
        return self._pipelines.get(pipeline_id)

    def list_pipelines(self) -> list[PipelineConfig]:
        """List all pipeline configurations."""
        return list(self._pipelines.values())

    # -- A/B testing --------------------------------------------------------

    def create_ab_test(
        self,
        name: str,
        task_type: str,
        provider_a: str,
        model_a: str,
        provider_b: str,
        model_b: str,
    ) -> ABTest:
        """Create an A/B test comparing two provider configurations.

        Args:
            name: Test name.
            task_type: Task type to test on.
            provider_a/model_a: Configuration A.
            provider_b/model_b: Configuration B.

        Returns:
            The created ABTest.
        """
        self._ab_counter += 1
        test_id = f"ab-{self._ab_counter:04d}"
        test = ABTest(
            test_id=test_id,
            name=name,
            task_type=task_type,
            provider_a=provider_a,
            model_a=model_a,
            provider_b=provider_b,
            model_b=model_b,
        )
        self._ab_tests[test_id] = test
        return test

    def route_ab_test(self, test_id: str) -> RoutingDecision | None:
        """Route a request through an A/B test (alternating between A and B).

        Returns:
            RoutingDecision for either A or B variant.
        """
        test = self._ab_tests.get(test_id)
        if not test or test.status != ABTestStatus.RUNNING:
            return None

        # Alternate: pick variant with fewer runs
        use_a = len(test.results_a) <= len(test.results_b)
        if use_a:
            return RoutingDecision(
                provider=test.provider_a,
                model=test.model_a,
                reason=f"A/B test '{test.name}' — variant A",
                strategy=RoutingStrategy.WEIGHTED,
                score=50.0,
            )
        else:
            return RoutingDecision(
                provider=test.provider_b,
                model=test.model_b,
                reason=f"A/B test '{test.name}' — variant B",
                strategy=RoutingStrategy.WEIGHTED,
                score=50.0,
            )

    def record_ab_result(
        self,
        test_id: str,
        variant: str,
        quality_score: float,
        latency_ms: float,
        cost: float = 0.0,
    ) -> bool:
        """Record a result for an A/B test variant.

        Args:
            test_id: The test ID.
            variant: 'a' or 'b'.
            quality_score: Quality score (0-100).
            latency_ms: Latency in milliseconds.
            cost: Cost of the request.

        Returns:
            True if recorded successfully.
        """
        test = self._ab_tests.get(test_id)
        if not test or test.status != ABTestStatus.RUNNING:
            return False

        result = {
            "quality_score": quality_score,
            "latency_ms": latency_ms,
            "cost": cost,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if variant.lower() == "a":
            test.results_a.append(result)
        elif variant.lower() == "b":
            test.results_b.append(result)
        else:
            return False
        return True

    def complete_ab_test(self, test_id: str) -> dict[str, Any] | None:
        """Complete an A/B test and return summary."""
        test = self._ab_tests.get(test_id)
        if not test:
            return None
        test.status = ABTestStatus.COMPLETED
        return test.get_summary()

    def get_ab_test(self, test_id: str) -> ABTest | None:
        """Get an A/B test."""
        return self._ab_tests.get(test_id)

    def list_ab_tests(self) -> list[ABTest]:
        """List all A/B tests."""
        return list(self._ab_tests.values())

    # -- Routing log & stats ------------------------------------------------

    def get_routing_log(self, limit: int = 50) -> list[RoutingDecision]:
        """Get recent routing decisions."""
        return self._routing_log[-limit:]

    def get_stats(self) -> dict[str, Any]:
        """Get router statistics."""
        providers = list(self._providers.values())
        available = [p for p in providers if p.is_available]
        return {
            "total_providers": len(providers),
            "available_providers": len(available),
            "rate_limited": sum(
                1 for p in providers if p.status == ProviderStatus.RATE_LIMITED
            ),
            "down": sum(1 for p in providers if p.status == ProviderStatus.DOWN),
            "local_providers": sum(1 for p in providers if p.is_local),
            "performance_records": len(self._performance_history),
            "routing_decisions": len(self._routing_log),
            "active_pipelines": len(self._pipelines),
            "ab_tests_running": sum(
                1 for t in self._ab_tests.values() if t.status == ABTestStatus.RUNNING
            ),
            "ab_tests_completed": sum(
                1 for t in self._ab_tests.values() if t.status == ABTestStatus.COMPLETED
            ),
            "fallback_chains": len(self._fallback_chains),
        }
