"""Cost Estimation & Control — Real-time LLM cost tracking per provider and task.

Tracks token usage (input/output) per provider, calculates costs in real-time,
manages project budgets with alerts, and suggests the cheapest model for a task.

Features:
    - Feature 6.3 — Estimation et contrôle des coûts.
    - Feature 12 — Cost Intelligence Engine: granular tracking per agent/phase/spec,
      monthly/weekly budget periods, JSON persistence.

Example:
    >>> from apps.backend.scheduling.cost_estimator import CostEstimator
    >>> estimator = CostEstimator()
    >>> estimator.set_budget("my-project", 50.0, period="monthly")
    >>> usage = estimator.record_usage("my-project", "anthropic", "claude-sonnet-4-20250514",
    ...     input_tokens=1500, output_tokens=500, task_id="task-1",
    ...     agent_type="coder", phase="coding", spec_id="001-feature")
    >>> print(f"Cost: ${usage.cost:.4f}")
    >>> report = estimator.get_project_report("my-project")
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pricing database — cost per 1M tokens (USD)
# ---------------------------------------------------------------------------

PROVIDER_PRICING: dict[str, dict[str, dict[str, float]]] = {
    "anthropic": {
        # Claude 4.6
        "claude-opus-4-6": {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
        # Claude 4.5
        "claude-opus-4-5-20251101": {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-5-20250929": {"input": 3.0, "output": 15.0},
        "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.0},
        # Claude 4
        "claude-opus-4-20250514": {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-20250514": {"input": 3.0, "output": 15.0},
        "claude-haiku-4-20250514": {"input": 0.25, "output": 1.25},
        # Claude 3.5
        "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0},
        "claude-3-5-haiku-20241022": {"input": 0.80, "output": 4.0},
    },
    "openai": {
        # GPT-5
        "gpt-5.2": {"input": 5.0, "output": 20.0},
        # GPT-4o
        "gpt-4o": {"input": 2.50, "output": 10.0},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
        # GPT-4.1
        "gpt-4.1": {"input": 2.0, "output": 8.0},
        "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
        "gpt-4.1-nano": {"input": 0.10, "output": 0.40},
        # GPT-4
        "gpt-4-turbo": {"input": 10.0, "output": 30.0},
        "gpt-4": {"input": 30.0, "output": 60.0},
        # GPT-3.5
        "gpt-3.5-turbo": {"input": 0.50, "output": 1.50},
        # o-series reasoning
        "o3": {"input": 10.0, "output": 40.0},
        "o3-mini": {"input": 1.10, "output": 4.40},
        "o4-mini": {"input": 1.10, "output": 4.40},
        "o1": {"input": 15.0, "output": 60.0},
        "o1-mini": {"input": 3.0, "output": 12.0},
    },
    "google": {
        # Gemini 2.5
        "gemini-2.5-pro": {"input": 1.25, "output": 10.0},
        "gemini-2.5-flash": {"input": 0.15, "output": 0.60},
        # Gemini 2.0
        "gemini-2.0-flash": {"input": 0.10, "output": 0.40},
        "gemini-2.0-pro": {"input": 1.25, "output": 5.0},
        # Gemini 1.5
        "gemini-1.5-pro": {"input": 1.25, "output": 5.0},
        "gemini-1.5-flash": {"input": 0.075, "output": 0.30},
        # Gemini 3.0
        "gemini-3.0": {"input": 2.0, "output": 8.0},
    },
    "mistral": {
        "mistral-large": {"input": 2.0, "output": 6.0},
        "mistral-medium": {"input": 2.7, "output": 8.1},
        "mistral-small": {"input": 0.20, "output": 0.60},
        "codestral": {"input": 0.30, "output": 0.90},
        "pixtral-large": {"input": 2.0, "output": 6.0},
        "mistral-nemo": {"input": 0.15, "output": 0.15},
    },
    "deepseek": {
        "deepseek-chat": {"input": 0.14, "output": 0.28},
        "deepseek-coder": {"input": 0.14, "output": 0.28},
        "deepseek-r1": {"input": 0.55, "output": 2.19},
        "deepseek-v3": {"input": 0.27, "output": 1.10},
    },
    "grok": {
        "grok-3": {"input": 3.0, "output": 15.0},
        "grok-3-mini": {"input": 0.30, "output": 0.50},
        "grok-2": {"input": 2.0, "output": 10.0},
        "grok-2-mini": {"input": 0.30, "output": 1.0},
    },
    "cohere": {
        "command-r-plus": {"input": 2.50, "output": 10.0},
        "command-r": {"input": 0.15, "output": 0.60},
        "command-a": {"input": 2.50, "output": 10.0},
    },
    "ollama": {},  # Local models — free
    "meta": {
        "llama-4-maverick": {"input": 0.0, "output": 0.0},
        "llama-4-scout": {"input": 0.0, "output": 0.0},
        "llama-3.3-70b": {"input": 0.0, "output": 0.0},
        "llama-3.1-405b": {"input": 0.0, "output": 0.0},
        "llama-3.1-70b": {"input": 0.0, "output": 0.0},
        "llama-3.1-8b": {"input": 0.0, "output": 0.0},
    },
}


class AlertLevel(Enum):
    """Budget alert severity levels."""

    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"
    EXCEEDED = "exceeded"


@dataclass
class TokenUsage:
    """Single token usage record.

    Attributes:
        project_id: The project this usage belongs to.
        provider: The LLM provider name.
        model: The specific model used.
        input_tokens: Number of input (prompt) tokens.
        output_tokens: Number of output (completion) tokens.
        cost: The computed cost in USD.
        task_id: Optional task identifier.
        agent_type: Agent type (planner, coder, qa_reviewer, qa_fixer).
        phase: Execution phase (spec, planning, coding, qa).
        spec_id: Spec identifier (e.g. '001-feature-name').
        timestamp: When the usage was recorded.
    """

    project_id: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cost: float
    task_id: str = ""
    agent_type: str = ""
    phase: str = ""
    spec_id: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dictionary."""
        return {
            "project_id": self.project_id,
            "provider": self.provider,
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost": self.cost,
            "task_id": self.task_id,
            "agent_type": self.agent_type,
            "phase": self.phase,
            "spec_id": self.spec_id,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class BudgetAlert:
    """Budget threshold alert.

    Attributes:
        project_id: The project concerned.
        level: The alert severity.
        message: Human-readable alert description.
        current_spend: Current total spend in USD.
        budget_limit: The budget ceiling in USD.
        percentage: Spend as percentage of budget.
        timestamp: When the alert was generated.
    """

    project_id: str
    level: AlertLevel
    message: str
    current_spend: float
    budget_limit: float
    percentage: float
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dictionary."""
        return {
            "project_id": self.project_id,
            "level": self.level.value,
            "message": self.message,
            "current_spend": self.current_spend,
            "budget_limit": self.budget_limit,
            "percentage": self.percentage,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class ProjectBudget:
    """Budget configuration for a project.

    Attributes:
        project_id: The project identifier.
        limit: Maximum spend in USD.
        currency: The currency for display (cost always computed in USD).
        warning_threshold: Percentage at which to send a WARNING alert.
        critical_threshold: Percentage at which to send a CRITICAL alert.
        period: Budget period — ``'total'``, ``'monthly'``, or ``'weekly'``.
    """

    project_id: str
    limit: float
    currency: str = "USD"
    warning_threshold: float = 0.75
    critical_threshold: float = 0.90
    period: str = "total"


@dataclass
class CostEstimate:
    """Pre-execution cost estimate for a task.

    Attributes:
        provider: The LLM provider.
        model: The model name.
        estimated_input_tokens: Estimated prompt tokens.
        estimated_output_tokens: Estimated completion tokens.
        estimated_cost: Estimated cost in USD.
        confidence: Confidence level of the estimate ('low', 'medium', 'high').
    """

    provider: str
    model: str
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost: float
    confidence: str = "medium"

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dictionary."""
        return {
            "provider": self.provider,
            "model": self.model,
            "estimated_input_tokens": self.estimated_input_tokens,
            "estimated_output_tokens": self.estimated_output_tokens,
            "estimated_cost": self.estimated_cost,
            "confidence": self.confidence,
        }


# Average tokens per task type (rough heuristics)
TASK_TOKEN_ESTIMATES: dict[str, dict[str, int]] = {
    "planning": {"input": 2000, "output": 1500},
    "coding": {"input": 4000, "output": 3000},
    "review": {"input": 3000, "output": 1000},
    "bugfix": {"input": 3500, "output": 2500},
    "refactoring": {"input": 5000, "output": 4000},
    "documentation": {"input": 2000, "output": 2000},
    "testing": {"input": 3000, "output": 2500},
    "general": {"input": 2000, "output": 1000},
}


class CostEstimator:
    """LLM cost estimation, tracking, and budget control manager.

    Tracks token usage per project/provider/model, manages budgets with
    threshold alerts, and provides cost reports.

    Attributes:
        _usages: List of all recorded token usages.
        _budgets: Dictionary of project budgets keyed by project_id.
        _alerts: List of generated budget alerts.
        _custom_pricing: Custom pricing overrides.
    """

    def __init__(self) -> None:
        self._usages: list[TokenUsage] = []
        self._budgets: dict[str, ProjectBudget] = {}
        self._alerts: list[BudgetAlert] = []
        self._custom_pricing: dict[str, dict[str, dict[str, float]]] = {}
        # Track the last alert level emitted per project so we don't append a
        # new alert on every recorded usage once a threshold is crossed
        # (which previously caused unbounded list growth + UI alert spam).
        self._last_alert_level: dict[str, AlertLevel] = {}

    # ------------------------------------------------------------------
    # Pricing
    # ------------------------------------------------------------------

    def get_token_price(self, provider: str, model: str) -> dict[str, float]:
        """Get the price per 1M tokens for a provider/model.

        Args:
            provider: The provider name (e.g., ``'anthropic'``).
            model: The model name (e.g., ``'claude-sonnet-4-20250514'``).

        Returns:
            Dict with ``'input'`` and ``'output'`` prices per 1M tokens.
            Returns ``{'input': 0.0, 'output': 0.0}`` if not found (local models).
        """
        # Check custom pricing first
        custom = self._custom_pricing.get(provider, {}).get(model)
        if custom:
            return custom

        provider_models = PROVIDER_PRICING.get(provider, {})
        if model in provider_models:
            return provider_models[model]

        # Fuzzy match — only accept date-suffix variants of the SAME base
        # model. The previous `startswith` rule matched `gpt-4o-mini` against
        # `gpt-4` (and vice-versa), which could mis-bill by 200x or silently
        # undercount spend, breaking budget alarms. We now require an exact
        # match or a `<base>-<suffix>` form so `gpt-4-0314` still resolves to
        # `gpt-4` but `gpt-4o-mini` does not.
        for known_model, pricing in provider_models.items():
            if model == known_model or model.startswith(known_model + "-"):
                return pricing

        return {"input": 0.0, "output": 0.0}

    def set_custom_pricing(
        self, provider: str, model: str, input_per_1m: float, output_per_1m: float
    ) -> None:
        """Override pricing for a provider/model.

        Args:
            provider: The provider name.
            model: The model name.
            input_per_1m: Price per 1M input tokens in USD.
            output_per_1m: Price per 1M output tokens in USD.
        """
        if provider not in self._custom_pricing:
            self._custom_pricing[provider] = {}
        self._custom_pricing[provider][model] = {
            "input": input_per_1m,
            "output": output_per_1m,
        }

    def calculate_cost(
        self, provider: str, model: str, input_tokens: int, output_tokens: int
    ) -> float:
        """Calculate the cost for a given token usage.

        Args:
            provider: The provider name.
            model: The model name.
            input_tokens: Number of input tokens.
            output_tokens: Number of output tokens.

        Returns:
            The cost in USD.
        """
        pricing = self.get_token_price(provider, model)
        input_cost = (input_tokens / 1_000_000) * pricing["input"]
        output_cost = (output_tokens / 1_000_000) * pricing["output"]
        return round(input_cost + output_cost, 6)

    # ------------------------------------------------------------------
    # Usage tracking
    # ------------------------------------------------------------------

    def record_usage(
        self,
        project_id: str,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        task_id: str = "",
        agent_type: str = "",
        phase: str = "",
        spec_id: str = "",
    ) -> TokenUsage:
        """Record a token usage event and check budget.

        Args:
            project_id: The project identifier.
            provider: The LLM provider.
            model: The model used.
            input_tokens: Number of input tokens consumed.
            output_tokens: Number of output tokens produced.
            task_id: Optional task identifier.
            agent_type: Agent type (planner, coder, qa_reviewer, qa_fixer).
            phase: Execution phase (spec, planning, coding, qa).
            spec_id: Spec identifier (e.g. '001-feature-name').

        Returns:
            The recorded TokenUsage instance.
        """
        cost = self.calculate_cost(provider, model, input_tokens, output_tokens)
        usage = TokenUsage(
            project_id=project_id,
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost=cost,
            task_id=task_id,
            agent_type=agent_type,
            phase=phase,
            spec_id=spec_id,
        )
        self._usages.append(usage)

        # Check budget after recording
        self._check_budget(project_id)

        return usage

    def get_usages(
        self,
        project_id: str | None = None,
        provider: str | None = None,
        task_id: str | None = None,
        agent_type: str | None = None,
        phase: str | None = None,
        spec_id: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[TokenUsage]:
        """Retrieve filtered usage records.

        Args:
            project_id: Filter by project.
            provider: Filter by provider.
            task_id: Filter by task.
            agent_type: Filter by agent type.
            phase: Filter by execution phase.
            spec_id: Filter by spec identifier.
            since: Include only usages after this time.
            until: Include only usages before this time.

        Returns:
            A list of matching TokenUsage records.
        """
        results = self._usages
        if project_id:
            results = [u for u in results if u.project_id == project_id]
        if provider:
            results = [u for u in results if u.provider == provider]
        if task_id:
            results = [u for u in results if u.task_id == task_id]
        if agent_type:
            results = [u for u in results if u.agent_type == agent_type]
        if phase:
            results = [u for u in results if u.phase == phase]
        if spec_id:
            results = [u for u in results if u.spec_id == spec_id]
        if since:
            results = [u for u in results if u.timestamp >= since]
        if until:
            results = [u for u in results if u.timestamp <= until]
        return results

    def get_total_cost(
        self,
        project_id: str | None = None,
        provider: str | None = None,
        since: datetime | None = None,
    ) -> float:
        """Get total cost for a project/provider/time range.

        Args:
            project_id: Filter by project.
            provider: Filter by provider.
            since: Include only usages after this time.

        Returns:
            Total cost in USD.
        """
        usages = self.get_usages(project_id=project_id, provider=provider, since=since)
        return round(sum(u.cost for u in usages), 6)

    # ------------------------------------------------------------------
    # Budget management
    # ------------------------------------------------------------------

    def set_budget(
        self,
        project_id: str,
        limit: float,
        currency: str = "USD",
        warning_threshold: float = 0.75,
        critical_threshold: float = 0.90,
        period: str = "total",
    ) -> ProjectBudget:
        """Set a budget limit for a project.

        Args:
            project_id: The project identifier.
            limit: Maximum spend in USD.
            currency: Display currency.
            warning_threshold: Fraction of budget that triggers a warning (0-1).
            critical_threshold: Fraction of budget that triggers a critical alert (0-1).
            period: Budget period — ``'total'``, ``'monthly'``, or ``'weekly'``.

        Returns:
            The created ProjectBudget.
        """
        budget = ProjectBudget(
            project_id=project_id,
            limit=limit,
            currency=currency,
            warning_threshold=warning_threshold,
            critical_threshold=critical_threshold,
            period=period,
        )
        self._budgets[project_id] = budget
        return budget

    def get_budget(self, project_id: str) -> ProjectBudget | None:
        """Get the budget for a project.

        Args:
            project_id: The project identifier.

        Returns:
            The ProjectBudget or None if not set.
        """
        return self._budgets.get(project_id)

    def _get_budget_period_start(self, budget: ProjectBudget) -> datetime | None:
        """Get the start of the current budget period.

        Args:
            budget: The project budget with period info.

        Returns:
            Start datetime for the period, or None for ``'total'``.
        """
        if budget.period == "monthly":
            now = datetime.now(timezone.utc)
            return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        elif budget.period == "weekly":
            now = datetime.now(timezone.utc)
            start = now - timedelta(days=now.weekday())
            return start.replace(hour=0, minute=0, second=0, microsecond=0)
        return None

    def _check_budget(self, project_id: str) -> BudgetAlert | None:
        """Check if the project is exceeding its budget and create alerts.

        Args:
            project_id: The project identifier.

        Returns:
            A BudgetAlert if a threshold is breached, or None.
        """
        budget = self._budgets.get(project_id)
        if not budget:
            return None

        since = self._get_budget_period_start(budget)
        total_spend = self.get_total_cost(project_id=project_id, since=since)
        percentage = total_spend / budget.limit if budget.limit > 0 else 0.0

        alert = None
        if percentage >= 1.0:
            alert = BudgetAlert(
                project_id=project_id,
                level=AlertLevel.EXCEEDED,
                message=f"Budget exceeded! Spent ${total_spend:.2f} / ${budget.limit:.2f} ({percentage:.0%})",
                current_spend=total_spend,
                budget_limit=budget.limit,
                percentage=percentage,
            )
        elif percentage >= budget.critical_threshold:
            alert = BudgetAlert(
                project_id=project_id,
                level=AlertLevel.CRITICAL,
                message=f"Critical: approaching budget limit. Spent ${total_spend:.2f} / ${budget.limit:.2f} ({percentage:.0%})",
                current_spend=total_spend,
                budget_limit=budget.limit,
                percentage=percentage,
            )
        elif percentage >= budget.warning_threshold:
            alert = BudgetAlert(
                project_id=project_id,
                level=AlertLevel.WARNING,
                message=f"Warning: budget usage high. Spent ${total_spend:.2f} / ${budget.limit:.2f} ({percentage:.0%})",
                current_spend=total_spend,
                budget_limit=budget.limit,
                percentage=percentage,
            )

        if alert:
            # Only append when the level CHANGES — previously every usage
            # recorded after a threshold was crossed produced another alert.
            previous = self._last_alert_level.get(project_id)
            if previous != alert.level:
                self._alerts.append(alert)
                self._last_alert_level[project_id] = alert.level
        else:
            # Spend dropped back under all thresholds (e.g., budget reset);
            # clear the level so the next breach re-fires an alert.
            self._last_alert_level.pop(project_id, None)

        return alert

    def get_alerts(
        self, project_id: str | None = None, level: AlertLevel | None = None
    ) -> list[BudgetAlert]:
        """Get budget alerts.

        Args:
            project_id: Filter by project.
            level: Filter by alert level.

        Returns:
            A list of BudgetAlert objects.
        """
        results = self._alerts
        if project_id:
            results = [a for a in results if a.project_id == project_id]
        if level:
            results = [a for a in results if a.level == level]
        return results

    # ------------------------------------------------------------------
    # Cost estimation (pre-execution)
    # ------------------------------------------------------------------

    def estimate_task_cost(
        self,
        provider: str,
        model: str,
        task_type: str = "general",
        complexity_multiplier: float = 1.0,
    ) -> CostEstimate:
        """Estimate the cost of a task before execution.

        Args:
            provider: The LLM provider.
            model: The model to use.
            task_type: The task type (``'coding'``, ``'review'``, etc.).
            complexity_multiplier: Multiply token estimates by this factor.

        Returns:
            A CostEstimate with predicted costs.
        """
        estimates = TASK_TOKEN_ESTIMATES.get(task_type, TASK_TOKEN_ESTIMATES["general"])
        est_input = int(estimates["input"] * complexity_multiplier)
        est_output = int(estimates["output"] * complexity_multiplier)
        est_cost = self.calculate_cost(provider, model, est_input, est_output)

        confidence = "medium"
        if complexity_multiplier == 1.0:
            confidence = "medium"
        elif complexity_multiplier > 2.0:
            confidence = "low"
        else:
            confidence = "high"

        return CostEstimate(
            provider=provider,
            model=model,
            estimated_input_tokens=est_input,
            estimated_output_tokens=est_output,
            estimated_cost=est_cost,
            confidence=confidence,
        )

    def suggest_cheapest_model(
        self, task_type: str = "general", max_budget: float | None = None
    ) -> list[dict[str, Any]]:
        """Suggest the cheapest models for a given task type.

        Args:
            task_type: The type of task.
            max_budget: If set, exclude models whose estimated cost exceeds this.

        Returns:
            A list of dicts sorted by estimated cost (cheapest first), each with
            ``'provider'``, ``'model'``, ``'estimated_cost'``, and ``'quality_tier'``.
        """
        suggestions: list[dict[str, Any]] = []

        for provider, models in PROVIDER_PRICING.items():
            if not models:
                # Local/free providers
                suggestions.append(
                    {
                        "provider": provider,
                        "model": "(local)",
                        "estimated_cost": 0.0,
                        "quality_tier": "varies",
                    }
                )
                continue

            for model, pricing in models.items():
                estimate = self.estimate_task_cost(provider, model, task_type)
                if max_budget is not None and estimate.estimated_cost > max_budget:
                    continue
                suggestions.append(
                    {
                        "provider": provider,
                        "model": model,
                        "estimated_cost": estimate.estimated_cost,
                        "quality_tier": _infer_quality_tier(provider, model),
                    }
                )

        suggestions.sort(key=lambda s: s["estimated_cost"])
        return suggestions

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Granular aggregation (Cost Intelligence Engine)
    # ------------------------------------------------------------------

    def get_cost_by_agent_type(
        self, project_id: str, since: datetime | None = None
    ) -> dict[str, float]:
        """Aggregate costs by agent type.

        Args:
            project_id: The project identifier.
            since: Include only usages after this time.

        Returns:
            Dict mapping agent_type to total cost in USD.
        """
        usages = self.get_usages(project_id=project_id, since=since)
        result: dict[str, float] = {}
        for u in usages:
            key = u.agent_type or "unknown"
            result[key] = result.get(key, 0.0) + u.cost
        return {k: round(v, 6) for k, v in result.items()}

    def get_cost_by_phase(
        self, project_id: str, since: datetime | None = None
    ) -> dict[str, float]:
        """Aggregate costs by execution phase.

        Args:
            project_id: The project identifier.
            since: Include only usages after this time.

        Returns:
            Dict mapping phase to total cost in USD.
        """
        usages = self.get_usages(project_id=project_id, since=since)
        result: dict[str, float] = {}
        for u in usages:
            key = u.phase or "unknown"
            result[key] = result.get(key, 0.0) + u.cost
        return {k: round(v, 6) for k, v in result.items()}

    def get_cost_by_spec(
        self, project_id: str, since: datetime | None = None
    ) -> dict[str, float]:
        """Aggregate costs by spec identifier.

        Args:
            project_id: The project identifier.
            since: Include only usages after this time.

        Returns:
            Dict mapping spec_id to total cost in USD.
        """
        usages = self.get_usages(project_id=project_id, since=since)
        result: dict[str, float] = {}
        for u in usages:
            key = u.spec_id or "unknown"
            result[key] = result.get(key, 0.0) + u.cost
        return {k: round(v, 6) for k, v in result.items()}

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def get_project_report(
        self,
        project_id: str,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> dict[str, Any]:
        """Generate a cost report for a project.

        Args:
            project_id: The project identifier.
            since: Start of reporting period.
            until: End of reporting period.

        Returns:
            A dict with ``'total_cost'``, ``'by_provider'``, ``'by_model'``,
            ``'by_task'``, ``'by_agent_type'``, ``'by_phase'``, ``'by_spec'``,
            ``'total_tokens'``, ``'budget'``, ``'alerts'``, ``'usage_count'``.
        """
        usages = self.get_usages(project_id=project_id, since=since, until=until)

        by_provider: dict[str, float] = {}
        by_model: dict[str, float] = {}
        by_task: dict[str, float] = {}
        by_agent_type: dict[str, float] = {}
        by_phase: dict[str, float] = {}
        by_spec: dict[str, float] = {}
        total_input = 0
        total_output = 0

        for u in usages:
            by_provider[u.provider] = by_provider.get(u.provider, 0.0) + u.cost
            model_key = f"{u.provider}/{u.model}"
            by_model[model_key] = by_model.get(model_key, 0.0) + u.cost
            if u.task_id:
                by_task[u.task_id] = by_task.get(u.task_id, 0.0) + u.cost
            if u.agent_type:
                by_agent_type[u.agent_type] = (
                    by_agent_type.get(u.agent_type, 0.0) + u.cost
                )
            if u.phase:
                by_phase[u.phase] = by_phase.get(u.phase, 0.0) + u.cost
            if u.spec_id:
                by_spec[u.spec_id] = by_spec.get(u.spec_id, 0.0) + u.cost
            total_input += u.input_tokens
            total_output += u.output_tokens

        budget = self._budgets.get(project_id)
        budget_info = None
        if budget:
            budget_since = self._get_budget_period_start(budget)
            budget_usages = self.get_usages(project_id=project_id, since=budget_since)
            total = sum(u.cost for u in budget_usages)
            budget_info = {
                "limit": budget.limit,
                "currency": budget.currency,
                "period": budget.period,
                "spent": round(total, 6),
                "remaining": round(max(0, budget.limit - total), 6),
                "percentage": round(total / budget.limit * 100, 1)
                if budget.limit > 0
                else 0,
            }

        return {
            "project_id": project_id,
            "total_cost": round(sum(u.cost for u in usages), 6),
            "by_provider": {k: round(v, 6) for k, v in by_provider.items()},
            "by_model": {k: round(v, 6) for k, v in by_model.items()},
            "by_task": {k: round(v, 6) for k, v in by_task.items()},
            "by_agent_type": {k: round(v, 6) for k, v in by_agent_type.items()},
            "by_phase": {k: round(v, 6) for k, v in by_phase.items()},
            "by_spec": {k: round(v, 6) for k, v in by_spec.items()},
            "total_tokens": {"input": total_input, "output": total_output},
            "budget": budget_info,
            "alerts": [a.to_dict() for a in self.get_alerts(project_id=project_id)],
            "usage_count": len(usages),
        }

    def get_weekly_report(self, project_id: str) -> dict[str, Any]:
        """Generate a weekly cost report.

        Args:
            project_id: The project identifier.

        Returns:
            A cost report dict for the last 7 days.
        """
        since = datetime.now(timezone.utc) - timedelta(days=7)
        return self.get_project_report(project_id, since=since)

    def get_monthly_report(self, project_id: str) -> dict[str, Any]:
        """Generate a monthly cost report.

        Args:
            project_id: The project identifier.

        Returns:
            A cost report dict for the last 30 days.
        """
        since = datetime.now(timezone.utc) - timedelta(days=30)
        return self.get_project_report(project_id, since=since)

    def get_stats(self) -> dict[str, Any]:
        """Get global statistics across all projects.

        Returns:
            Dict with ``'total_usages'``, ``'total_cost'``, ``'projects'``,
            ``'providers_used'``, ``'budgets_set'``.
        """
        projects = set(u.project_id for u in self._usages)
        providers = set(u.provider for u in self._usages)
        return {
            "total_usages": len(self._usages),
            "total_cost": round(sum(u.cost for u in self._usages), 6),
            "projects": list(projects),
            "providers_used": list(providers),
            "budgets_set": len(self._budgets),
        }

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save_to_file(self, path: Path) -> None:
        """Persist all usage records and budgets to a JSON file.

        Args:
            path: File path for the JSON data.
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "usages": [u.to_dict() for u in self._usages],
            "budgets": {
                pid: {
                    "project_id": b.project_id,
                    "limit": b.limit,
                    "currency": b.currency,
                    "warning_threshold": b.warning_threshold,
                    "critical_threshold": b.critical_threshold,
                    "period": b.period,
                }
                for pid, b in self._budgets.items()
            },
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("Cost data saved to %s (%d records)", path, len(self._usages))

    def load_from_file(self, path: Path) -> None:
        """Load persisted records from a JSON file.

        Args:
            path: File path to load from.
        """
        path = Path(path)
        if not path.exists():
            return
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to load cost data from %s: %s", path, exc)
            return

        for u in data.get("usages", []):
            ts = u.get("timestamp", "")
            try:
                timestamp = datetime.fromisoformat(ts)
            except (ValueError, TypeError):
                timestamp = datetime.now(timezone.utc)
            self._usages.append(
                TokenUsage(
                    project_id=u.get("project_id", ""),
                    provider=u.get("provider", ""),
                    model=u.get("model", ""),
                    input_tokens=u.get("input_tokens", 0),
                    output_tokens=u.get("output_tokens", 0),
                    cost=u.get("cost", 0.0),
                    task_id=u.get("task_id", ""),
                    agent_type=u.get("agent_type", ""),
                    phase=u.get("phase", ""),
                    spec_id=u.get("spec_id", ""),
                    timestamp=timestamp,
                )
            )

        for pid, b in data.get("budgets", {}).items():
            self._budgets[pid] = ProjectBudget(
                project_id=b.get("project_id", pid),
                limit=b.get("limit", 0.0),
                currency=b.get("currency", "USD"),
                warning_threshold=b.get("warning_threshold", 0.75),
                critical_threshold=b.get("critical_threshold", 0.90),
                period=b.get("period", "total"),
            )

        logger.info("Loaded %d cost records from %s", len(self._usages), path)


def _infer_quality_tier(provider: str, model: str) -> str:
    """Infer quality tier from model name heuristics."""
    model_lower = model.lower()
    if any(
        kw in model_lower for kw in ("opus", "gpt-4", "gpt-5", "pro", "large", "o1")
    ):
        return "high"
    if any(kw in model_lower for kw in ("sonnet", "4o", "medium", "flash")):
        return "medium"
    if any(kw in model_lower for kw in ("haiku", "mini", "small", "3.5")):
        return "low"
    return "medium"
