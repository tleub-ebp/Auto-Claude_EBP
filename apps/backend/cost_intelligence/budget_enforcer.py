"""
Budget Enforcer — Circuit breaker + progressive degradation.

Monitors live cost tracking against configured budgets and triggers:
  - Progressive alerts at 50%, 75%, 90%, 100%
  - Automatic model degradation (flagship → standard → fast → local)
  - Circuit breaker when an agent burns 3× budget with no progress
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from apps.backend.models_registry import get_tier

from .live_tracker import LiveCostTracker

logger = logging.getLogger(__name__)


class AlertLevel(str, Enum):
    NONE = "none"
    INFO_50 = "info_50"  # 50% of budget
    WARNING_75 = "warning_75"  # 75% of budget
    CRITICAL_90 = "critical_90"  # 90% of budget
    HARD_STOP = "hard_stop"  # 100% of budget


class DegradationTier(str, Enum):
    FLAGSHIP = "flagship"  # Opus, GPT-4.1, Gemini 2.5 Pro
    STANDARD = "standard"  # Sonnet, GPT-4o, Gemini 2.5 Flash
    FAST = "fast"  # Haiku, GPT-4o-mini, Gemini Flash
    LOCAL = "local"  # Ollama models (cost $0)

    @property
    def rank(self) -> int:
        return {
            DegradationTier.FLAGSHIP: 4,
            DegradationTier.STANDARD: 3,
            DegradationTier.FAST: 2,
            DegradationTier.LOCAL: 1,
        }[self]

    def degrade(self) -> DegradationTier:
        """Return the next lower tier."""
        order = [
            DegradationTier.FLAGSHIP,
            DegradationTier.STANDARD,
            DegradationTier.FAST,
            DegradationTier.LOCAL,
        ]
        idx = order.index(self)
        return order[min(idx + 1, len(order) - 1)]


# Default model mappings per tier — generated from registry
def _build_tier_models() -> dict[DegradationTier, list[dict[str, str]]]:
    """Build tier models from registry."""
    result: dict[DegradationTier, list[dict[str, str]]] = {}
    for tier in DegradationTier:
        models: list[dict[str, str]] = []
        for provider in ("anthropic", "openai", "google", "mistral", "ollama"):
            entry = get_tier(provider, tier.value)
            if entry:
                models.append({"provider": entry.provider, "model": entry.model_id})
        result[tier] = models
    return result


DEFAULT_TIER_MODELS: dict[DegradationTier, list[dict[str, str]]] = _build_tier_models()


class CircuitBreakerState(str, Enum):
    CLOSED = "closed"  # Normal operation
    OPEN = "open"  # Agent suspended
    HALF_OPEN = "half_open"  # Testing if agent can resume


@dataclass
class BudgetConfig:
    """Budget configuration for a scope."""

    scope: str = "spec"  # organisation | project | spec
    scope_id: str = ""
    soft_warn: float = 0.0  # USD threshold for 50% alert
    hard_stop: float = 0.0  # USD threshold for hard stop (100%)
    auto_degrade: bool = True  # Enable automatic degradation
    circuit_breaker_multiplier: float = 3.0  # Trigger at 3× budget with no progress
    cooldown_seconds: float = 60.0  # Min time between alerts

    @property
    def warn_75(self) -> float:
        return self.hard_stop * 0.75 if self.hard_stop > 0 else 0.0

    @property
    def critical_90(self) -> float:
        return self.hard_stop * 0.90 if self.hard_stop > 0 else 0.0


@dataclass
class BudgetStatus:
    """Current budget status for a scope."""

    config: BudgetConfig
    current_cost: float = 0.0
    alert_level: AlertLevel = AlertLevel.NONE
    current_tier: DegradationTier = DegradationTier.FLAGSHIP
    circuit_breaker: CircuitBreakerState = CircuitBreakerState.CLOSED
    percentage_used: float = 0.0
    remaining_usd: float = 0.0
    last_alert_time: float = 0.0

    @property
    def is_stopped(self) -> bool:
        return (
            self.alert_level == AlertLevel.HARD_STOP
            or self.circuit_breaker == CircuitBreakerState.OPEN
        )


class BudgetEnforcer:
    """Monitor costs against budgets with alerts and degradation.

    Usage::

        enforcer = BudgetEnforcer(tracker)
        enforcer.set_budget("spec", "spec-001", hard_stop=10.0)
        status = enforcer.check("spec", "spec-001")
        if status.is_stopped:
            # suspend the agent
            ...
    """

    def __init__(self, tracker: LiveCostTracker) -> None:
        self._tracker = tracker
        self._budgets: dict[str, BudgetConfig] = {}
        self._statuses: dict[str, BudgetStatus] = {}
        self._progress_marks: dict[str, float] = {}  # last known progress timestamp
        self._alert_callbacks: list[Callable[[BudgetStatus], None]] = []

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    def set_budget(
        self,
        scope: str,
        scope_id: str,
        hard_stop: float,
        soft_warn: float | None = None,
        auto_degrade: bool = True,
        circuit_breaker_multiplier: float = 3.0,
    ) -> BudgetConfig:
        """Configure a budget for a scope."""
        key = f"{scope}:{scope_id}"
        config = BudgetConfig(
            scope=scope,
            scope_id=scope_id,
            soft_warn=soft_warn or hard_stop * 0.50,
            hard_stop=hard_stop,
            auto_degrade=auto_degrade,
            circuit_breaker_multiplier=circuit_breaker_multiplier,
        )
        self._budgets[key] = config
        self._statuses[key] = BudgetStatus(
            config=config, current_tier=DegradationTier.FLAGSHIP
        )
        return config

    def on_alert(self, callback: Callable[[BudgetStatus], None]) -> None:
        """Register a callback for budget alerts."""
        self._alert_callbacks.append(callback)

    def mark_progress(self, scope: str, scope_id: str) -> None:
        """Mark that the agent is making progress (resets circuit breaker timer)."""
        key = f"{scope}:{scope_id}"
        self._progress_marks[key] = time.time()

    # ------------------------------------------------------------------
    # Enforcement
    # ------------------------------------------------------------------

    def check(self, scope: str, scope_id: str) -> BudgetStatus:
        """Check budget status and update alerts/degradation."""
        key = f"{scope}:{scope_id}"
        config = self._budgets.get(key)
        if config is None:
            return BudgetStatus(
                config=BudgetConfig(scope=scope, scope_id=scope_id),
                alert_level=AlertLevel.NONE,
            )

        status = self._statuses[key]
        snapshot = self._tracker.get_snapshot(scope, scope_id)
        cost = snapshot.total_cost_usd
        status.current_cost = cost

        if config.hard_stop > 0:
            status.percentage_used = (cost / config.hard_stop) * 100
            status.remaining_usd = max(0, config.hard_stop - cost)
        else:
            status.percentage_used = 0.0
            status.remaining_usd = float("inf")

        # Determine alert level
        old_level = status.alert_level
        status.alert_level = self._compute_alert_level(cost, config)

        # Auto-degradation
        if config.auto_degrade and status.alert_level in (
            AlertLevel.WARNING_75,
            AlertLevel.CRITICAL_90,
        ):
            new_tier = self._compute_degradation_tier(cost, config, status.current_tier)
            if new_tier.rank < status.current_tier.rank:
                logger.info(
                    "Degrading %s from %s to %s (cost=$%.2f)",
                    key,
                    status.current_tier.value,
                    new_tier.value,
                    cost,
                )
                status.current_tier = new_tier

        # Circuit breaker check
        status.circuit_breaker = self._check_circuit_breaker(key, cost, config)

        # Fire callbacks on level change
        if status.alert_level != old_level and status.alert_level != AlertLevel.NONE:
            now = time.time()
            if now - status.last_alert_time >= config.cooldown_seconds:
                status.last_alert_time = now
                for cb in self._alert_callbacks:
                    try:
                        cb(status)
                    except Exception:
                        logger.exception("Alert callback failed")

        return status

    def get_recommended_model(
        self, scope: str, scope_id: str, preferred_provider: str = "anthropic"
    ) -> dict[str, str] | None:
        """Get the recommended model based on current degradation tier."""
        key = f"{scope}:{scope_id}"
        status = self._statuses.get(key)
        tier = status.current_tier if status else DegradationTier.FLAGSHIP
        models = DEFAULT_TIER_MODELS.get(tier, [])

        # Prefer the user's provider
        for m in models:
            if m["provider"] == preferred_provider:
                return m
        return models[0] if models else None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_alert_level(cost: float, config: BudgetConfig) -> AlertLevel:
        if config.hard_stop <= 0:
            return AlertLevel.NONE
        if cost >= config.hard_stop:
            return AlertLevel.HARD_STOP
        if cost >= config.critical_90:
            return AlertLevel.CRITICAL_90
        if cost >= config.warn_75:
            return AlertLevel.WARNING_75
        if cost >= config.soft_warn:
            return AlertLevel.INFO_50
        return AlertLevel.NONE

    @staticmethod
    def _compute_degradation_tier(
        cost: float, config: BudgetConfig, current: DegradationTier
    ) -> DegradationTier:
        if config.hard_stop <= 0:
            return current
        pct = cost / config.hard_stop
        if pct >= 0.90:
            target = DegradationTier.LOCAL
        elif pct >= 0.75:
            target = DegradationTier.FAST
        elif pct >= 0.50:
            target = DegradationTier.STANDARD
        else:
            target = current
        # Only degrade, never upgrade
        return target if target.rank < current.rank else current

    def _check_circuit_breaker(
        self, key: str, cost: float, config: BudgetConfig
    ) -> CircuitBreakerState:
        """Open circuit breaker if cost > multiplier × budget with no progress."""
        if config.hard_stop <= 0:
            return CircuitBreakerState.CLOSED

        threshold = config.hard_stop * config.circuit_breaker_multiplier
        if cost < threshold:
            return CircuitBreakerState.CLOSED

        last_progress = self._progress_marks.get(key, 0)
        if time.time() - last_progress > config.cooldown_seconds:
            logger.warning(
                "Circuit breaker OPEN for %s: cost=$%.2f > threshold=$%.2f with no progress",
                key,
                cost,
                threshold,
            )
            return CircuitBreakerState.OPEN

        return CircuitBreakerState.HALF_OPEN
