"""Wiring of the new MVP features (Model Router / Cognitive Context /
Domain Agents) into the existing coder + planner pipelines.

All three integrations are **opt-in** and **non-overriding**:

* :func:`suggest_routed_model` returns a ``ModelChoice`` *suggestion* — never
  changes the model the user has explicitly configured. The caller decides
  what to do with the suggestion (typically: log a divergence audit event).
* :func:`maybe_optimize_context` is a no-op unless ``WORKPILOT_COGNITIVE_CONTEXT_ENABLED``
  is truthy in the environment. Default = OFF (the user's project context is
  already finely tuned in most setups).
* :func:`load_domain_addendum` reads ``requirements.json`` from the spec dir,
  looks for a top-level ``domain`` key, and returns the matching
  :class:`DomainAgentBundle.prompt_addendum`. Returns ``""`` when no domain
  is set (the common case for back-compat).

Each helper is **best-effort**: if the underlying module is missing, the
helper returns a sensible default rather than raising. This keeps the
existing coder/planner runnable in stripped-down environments.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Env var to opt into Cognitive Context Optimizer in the agent pipeline.
COGNITIVE_CONTEXT_ENV_VAR = "WORKPILOT_COGNITIVE_CONTEXT_ENABLED"

# Env var to let the Model Router *substitute* the resolved phase model.
# Default OFF — the user's UI / CLI / spec choice always wins. When ON, the
# router only substitutes if the user did NOT make an explicit choice
# (= no `task_metadata.json` with a model field, no CLI override).
MODEL_ROUTER_OVERRIDE_ENV_VAR = "WORKPILOT_MODEL_ROUTER_ENABLED"


def _is_truthy(value: str | None) -> bool:
    return (value or "").lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Model Router suggestion


def suggest_routed_model(
    *,
    prompt: str = "",
    task_hint: str | None = None,
    available_providers: list[str] | None = None,
) -> dict[str, Any] | None:
    """Ask the ModelRouter for a cheaper/cheapest acceptable model.

    Returns ``None`` if the router module isn't available. Otherwise a dict
    with ``provider``, ``model``, ``estimated_cost_usd``, ``reason``,
    ``task_class``, ``tier``. Always returns a *suggestion* — the caller is
    responsible for deciding whether to use it (default policy: respect the
    user's UI choice + log divergence to the audit trail).
    """
    try:
        from model_router import ModelRouter
    except ImportError:
        return None

    try:
        router = ModelRouter(available=available_providers)
        choice = router.route(prompt=prompt, hint=task_hint)
        return {
            "provider": choice.provider,
            "model": choice.model,
            "estimated_cost_usd": choice.estimated_cost_usd,
            "reason": choice.reason,
            "task_class": choice.task_class.value,
            "tier": choice.tier.value,
        }
    except Exception as exc:  # noqa: BLE001
        logger.debug("ModelRouter.route failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Cognitive Context Optimizer (opt-in)


def cognitive_context_enabled() -> bool:
    """Return True iff the env flag asks for Cognitive Context optimization."""
    return _is_truthy(os.environ.get(COGNITIVE_CONTEXT_ENV_VAR))


def model_router_override_enabled() -> bool:
    """Return True iff the user opted into router-driven model substitution."""
    return _is_truthy(os.environ.get(MODEL_ROUTER_OVERRIDE_ENV_VAR))


def _user_made_explicit_model_choice(
    spec_dir: Path | None, cli_model: str | None
) -> bool:
    """Detect whether the user explicitly picked a model for this run.

    True if:
      * a CLI argument set the model, OR
      * ``task_metadata.json`` exists and has any model-related field
        (model / phaseModels / isAutoProfile=True with phaseModels).

    False otherwise — meaning we got the default model and it's safe for
    the router to substitute.
    """
    if cli_model:
        return True
    if spec_dir is None:
        return False
    metadata_path = Path(spec_dir) / "task_metadata.json"
    if not metadata_path.exists():
        return False
    try:
        import json as _json

        data = _json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return False
    if not isinstance(data, dict):
        return False
    if data.get("model"):
        return True
    if data.get("phaseModels"):
        return True
    return False


def apply_router_override(
    current_model: str,
    *,
    spec_dir: Path | None,
    phase: str,
    prompt_hint: str | None = None,
    cli_model: str | None = None,
    available_providers: list[str] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """Possibly substitute ``current_model`` with the router's suggestion.

    Returns ``(model_to_use, override_info_or_None)``.

    * If the override env flag is OFF → returns ``(current_model, None)``.
    * If the user explicitly chose a model (CLI / task_metadata.json) →
      returns ``(current_model, None)`` — we never overrule an explicit
      choice silently.
    * Otherwise asks the router. If it returns a different model, the
      response is ``(suggestion["model"], suggestion_dict)`` so the caller
      can audit the substitution.
    """
    if not model_router_override_enabled():
        return current_model, None
    if _user_made_explicit_model_choice(spec_dir, cli_model):
        return current_model, None

    suggestion = suggest_routed_model(
        prompt=prompt_hint or f"{phase} phase",
        task_hint=phase,
        available_providers=available_providers,
    )
    if not suggestion:
        return current_model, None
    if suggestion["model"] == current_model:
        return current_model, None
    return suggestion["model"], suggestion


def maybe_optimize_context(
    *,
    prompt: str,
    candidate_files: list[Path | str],
    project_dir: Path | None = None,
    token_budget: int = 8_000,
    explicit_mentions: list[str] | None = None,
    recent_files: list[str] | None = None,
) -> dict[str, Any] | None:
    """Run the Cognitive Context Optimizer when enabled, else no-op.

    Returns the optimizer's structured output (a dict) when it ran, ``None``
    when it was skipped (env flag off, module missing, or empty input).
    """
    if not cognitive_context_enabled():
        return None
    if not candidate_files:
        return None

    try:
        from cognitive_context import CognitiveContextOptimizer
    except ImportError:
        logger.debug("cognitive_context module missing — skipping optimization")
        return None

    try:
        optimizer = CognitiveContextOptimizer(token_budget=token_budget)
        result = optimizer.optimize(
            prompt=prompt,
            candidate_files=[str(f) for f in candidate_files],
            project_dir=project_dir,
            explicit_mentions=explicit_mentions or [],
            recent_files=recent_files or [],
        )
        # Most optimizers return a dataclass — normalise to a dict.
        if hasattr(result, "to_dict"):
            return result.to_dict()
        return result if isinstance(result, dict) else {"result": str(result)}
    except Exception as exc:  # noqa: BLE001
        logger.debug("CognitiveContextOptimizer.optimize failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Domain-Specific Agent prompt addendum


def _read_spec_domain(spec_dir: Path) -> str | None:
    """Look for a ``domain`` key in ``requirements.json`` at the spec root."""
    req_file = spec_dir / "requirements.json"
    if not req_file.exists():
        return None
    try:
        data = json.loads(req_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    domain = data.get("domain")
    if isinstance(domain, str) and domain.strip():
        return domain.strip()
    return None


def load_domain_addendum(
    spec_dir: Path,
    *,
    role: str = "coder",
) -> str:
    """Return the prompt addendum for the spec's domain (or ``""``).

    Reads the top-level ``domain`` field from ``requirements.json``. If the
    field is missing or unrecognised, returns an empty string — the agent
    keeps its baseline prompt. Never raises.
    """
    domain = _read_spec_domain(spec_dir)
    if not domain:
        return ""

    try:
        from domain_agents import AgentRole, DomainAgentFactory, DomainTag
    except ImportError:
        return ""

    try:
        # Normalise to enums; reject silently if they don't match the catalog.
        DomainTag(domain)
        AgentRole(role)
    except ValueError:
        logger.debug("Unknown domain %r or role %r — skipping addendum", domain, role)
        return ""

    try:
        bundle = DomainAgentFactory().build(domain=domain, role=role)
        return bundle.prompt_addendum or ""
    except Exception as exc:  # noqa: BLE001
        logger.debug("Failed to build domain bundle for %r/%r: %s", domain, role, exc)
        return ""
