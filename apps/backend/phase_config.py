"""
Phase Configuration Module
===========================

Handles model and thinking level configuration for different execution phases.
Reads configuration from task_metadata.json and provides resolved model IDs.
"""

import json
import os
import re
from pathlib import Path
from typing import Literal, TypedDict

try:
    from .models_registry import get_default
except ImportError:
    # Module is imported as a top-level "phase_config" (no package context),
    # e.g. by tests that put apps/backend on sys.path directly.
    from models_registry import get_default  # type: ignore[no-redef]

# Model shorthand to full model ID mapping
MODEL_ID_MAP: dict[str, str] = {
    "opus": "claude-opus-4-5-20251101",
    "sonnet": "claude-sonnet-4-5-20250929",
    "haiku": "claude-haiku-4-5-20251001",
}

# Thinking level to budget tokens mapping (None = no extended thinking)
# Values must match workpilot-ai/src/shared/constants/models.ts THINKING_BUDGET_MAP
THINKING_BUDGET_MAP: dict[str, int | None] = {
    "none": None,
    "low": 1024,
    "medium": 4096,  # Moderate analysis
    "high": 16384,  # Deep thinking for QA review
    "ultrathink": 63999,  # Maximum reasoning depth (API requires max_tokens >= budget + 1, so 63999 + 1 = 64000 limit)
}

# Spec runner phase-specific thinking levels
# Heavy phases use ultrathink for deep analysis
# Light phases use medium after compaction
SPEC_PHASE_THINKING_LEVELS: dict[str, str] = {
    # Heavy phases - ultrathink (discovery, spec creation, self-critique)
    "discovery": "ultrathink",
    "spec_writing": "ultrathink",
    "self_critique": "ultrathink",
    # Light phases - medium (after first invocation with compaction)
    "requirements": "medium",
    "research": "medium",
    "context": "medium",
    "planning": "medium",
    "validation": "medium",
    "quick_spec": "medium",
    "historical_context": "medium",
    "complexity_assessment": "medium",
}

# Default phase configuration (fallback, matches 'Balanced' profile)
DEFAULT_PHASE_MODELS: dict[str, str] = {
    "spec": "sonnet",
    "planning": "sonnet",  # Changed from "opus" (fix #433)
    "coding": "sonnet",
    "qa": "sonnet",
}

# Provider-specific default models — resolved from registry at runtime
# Used when a task has a provider set but no explicit model configuration.
# Keys must match provider names from provider_api.py / ProviderContext.

_GOOGLE_ENTRY = get_default("google")
GOOGLE_GEMINI_MODEL = _GOOGLE_ENTRY.model_id if _GOOGLE_ENTRY else "gemini-3.1-pro"

_META_ENTRY = get_default("meta")
META_LLAMA_MODEL = _META_ENTRY.model_id if _META_ENTRY else "meta-llama/llama-4-scout"

_AWS_ENTRY = get_default("aws")
AWS_BEDROCK_MODEL = _AWS_ENTRY.model_id if _AWS_ENTRY else "anthropic.claude-opus-4-7"

_OLLAMA_ENTRY = get_default("ollama")
OLLAMA_MODEL = _OLLAMA_ENTRY.model_id if _OLLAMA_ENTRY else "llama3.3"

_WINDSURF_ENTRY = get_default("windsurf")
WINDSURF_MODEL = _WINDSURF_ENTRY.model_id if _WINDSURF_ENTRY else "swe-1.6"

_COPILOT_ENTRY = get_default("copilot")
COPILOT_MODEL = _COPILOT_ENTRY.model_id if _COPILOT_ENTRY else "claude-sonnet-4.6"

_OPENAI_ENTRY = get_default("openai")
OPENAI_MODEL = _OPENAI_ENTRY.model_id if _OPENAI_ENTRY else "gpt-5.5"

_MISTRAL_ENTRY = get_default("mistral")
MISTRAL_MODEL = _MISTRAL_ENTRY.model_id if _MISTRAL_ENTRY else "mistral-large-3"

_DEEPSEEK_ENTRY = get_default("deepseek")
DEEPSEEK_MODEL = _DEEPSEEK_ENTRY.model_id if _DEEPSEEK_ENTRY else "deepseek-v3"

_GROK_ENTRY = get_default("grok")
GROK_MODEL = _GROK_ENTRY.model_id if _GROK_ENTRY else "grok-4.3"

PROVIDER_DEFAULT_MODELS: dict[str, dict[str, str]] = {
    # Anthropic / Claude — use Claude shorthands (resolved by resolve_model_id)
    "anthropic": {
        "spec": "sonnet",
        "planning": "sonnet",
        "coding": "sonnet",
        "qa": "sonnet",
    },
    "claude": {
        "spec": "sonnet",
        "planning": "sonnet",
        "coding": "sonnet",
        "qa": "sonnet",
    },
    # OpenAI
    "openai": {
        "spec": OPENAI_MODEL,
        "planning": OPENAI_MODEL,
        "coding": OPENAI_MODEL,
        "qa": OPENAI_MODEL,
    },
    # GitHub Copilot
    "copilot": {
        "spec": COPILOT_MODEL,
        "planning": COPILOT_MODEL,
        "coding": COPILOT_MODEL,
        "qa": COPILOT_MODEL,
    },
    # Google Gemini
    "google": {
        "spec": GOOGLE_GEMINI_MODEL,
        "planning": GOOGLE_GEMINI_MODEL,
        "coding": GOOGLE_GEMINI_MODEL,
        "qa": GOOGLE_GEMINI_MODEL,
    },
    # Mistral AI
    "mistral": {
        "spec": MISTRAL_MODEL,
        "planning": MISTRAL_MODEL,
        "coding": MISTRAL_MODEL,
        "qa": MISTRAL_MODEL,
    },
    # DeepSeek
    "deepseek": {
        "spec": DEEPSEEK_MODEL,
        "planning": DEEPSEEK_MODEL,
        "coding": DEEPSEEK_MODEL,
        "qa": DEEPSEEK_MODEL,
    },
    # Grok (xAI)
    "grok": {
        "spec": GROK_MODEL,
        "planning": GROK_MODEL,
        "coding": GROK_MODEL,
        "qa": GROK_MODEL,
    },
    # Meta (LLaMA)
    "meta": {
        "spec": META_LLAMA_MODEL,
        "planning": META_LLAMA_MODEL,
        "coding": META_LLAMA_MODEL,
        "qa": META_LLAMA_MODEL,
    },
    # AWS Bedrock
    "aws": {
        "spec": AWS_BEDROCK_MODEL,
        "planning": AWS_BEDROCK_MODEL,
        "coding": AWS_BEDROCK_MODEL,
        "qa": AWS_BEDROCK_MODEL,
    },
    # Ollama (local)
    "ollama": {
        "spec": OLLAMA_MODEL,
        "planning": OLLAMA_MODEL,
        "coding": OLLAMA_MODEL,
        "qa": OLLAMA_MODEL,
    },
    # Windsurf (Codeium) — SWE-1.5 is the flagship proprietary model
    "windsurf": {
        "spec": WINDSURF_MODEL,
        "planning": WINDSURF_MODEL,
        "coding": WINDSURF_MODEL,
        "qa": WINDSURF_MODEL,
    },
}

DEFAULT_PHASE_THINKING: dict[str, str] = {
    "spec": "medium",
    "planning": "high",
    "coding": "medium",
    "qa": "high",
}


class PhaseModelConfig(TypedDict, total=False):
    spec: str
    planning: str
    coding: str
    qa: str


class PhaseThinkingConfig(TypedDict, total=False):
    spec: str
    planning: str
    coding: str
    qa: str


class PhaseProviderConfig(TypedDict, total=False):
    spec: str
    planning: str
    coding: str
    qa: str


class TaskMetadataConfig(TypedDict, total=False):
    """Structure of model-related fields in task_metadata.json"""

    provider: str
    isAutoProfile: bool
    phaseModels: PhaseModelConfig
    phaseThinking: PhaseThinkingConfig
    phaseProviders: PhaseProviderConfig
    model: str
    thinkingLevel: str


Phase = Literal["spec", "planning", "coding", "qa"]


# Dotted Claude model ids are the Copilot/Windsurf spelling (e.g.
# "claude-opus-4.8", "claude-sonnet-4.6"). The Anthropic API only accepts the
# dash-separated form ("claude-opus-4-8"), so a dotted id left in
# task_metadata.json after switching a task back from Copilot to Anthropic is
# rejected with "model ... may not exist". This regex matches the dotted version
# separator on a Claude id so it can be rewritten to the native dashed form.
_DOTTED_CLAUDE_VERSION_RE = re.compile(r"^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)")


def normalize_anthropic_model_id(model: str) -> str:
    """Rewrite a dotted Claude model id to its Anthropic-native dashed form.

    ``"claude-opus-4.8"`` → ``"claude-opus-4-8"``;
    ``"claude-sonnet-4.6"`` → ``"claude-sonnet-4-6"``.

    Ids that don't match the dotted Claude pattern (including non-Claude models
    and already-dashed ids) are returned unchanged. Only call this when the model
    is destined for Anthropic — Copilot/Windsurf keep the dotted spelling.
    """
    if not model:
        return model
    return _DOTTED_CLAUDE_VERSION_RE.sub(r"\1-\2", model)


def resolve_model_id(model: str) -> str:
    """
    Resolve a model shorthand (haiku, sonnet, opus) to a full model ID.
    If the model is already a full ID, return it unchanged.

    Priority:
    1. Environment variable override (from API Profile)
    2. Hardcoded MODEL_ID_MAP
    3. Pass through unchanged (assume full model ID)

    Args:
        model: Model shorthand or full ID

    Returns:
        Full Claude model ID
    """
    # Check for environment variable override (from API Profile custom model mappings)
    if model in MODEL_ID_MAP:
        env_var_map = {
            "haiku": "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "sonnet": "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "opus": "ANTHROPIC_DEFAULT_OPUS_MODEL",
        }
        env_var = env_var_map.get(model)
        if env_var:
            env_value = os.environ.get(env_var)
            if env_value:
                return env_value

        # Fall back to hardcoded mapping
        return MODEL_ID_MAP[model]

    # Already a full model ID or unknown shorthand
    return model


# Reverse of THINKING_BUDGET_MAP, to label a thinking budget (tokens) back as
# its effort level (none/low/medium/high/ultrathink) for display/tracing.
_BUDGET_TO_THINKING_LEVEL: dict[int | None, str] = {
    budget: level for level, budget in THINKING_BUDGET_MAP.items()
}


def thinking_level_from_budget(budget: int | None) -> str:
    """Map a thinking budget (tokens) back to its effort level name.

    Inverse of ``get_thinking_budget`` / ``THINKING_BUDGET_MAP``. Unknown budgets
    (custom token counts) are rendered as ``"<n> tokens"`` so the trace still
    carries the information.
    """
    if budget in _BUDGET_TO_THINKING_LEVEL:
        return _BUDGET_TO_THINKING_LEVEL[budget]
    return f"{budget} tokens"


def get_thinking_budget(thinking_level: str) -> int | None:
    """
    Get the thinking budget for a thinking level.

    Args:
        thinking_level: Thinking level (none, low, medium, high, ultrathink)

    Returns:
        Token budget or None for no extended thinking
    """
    import logging

    if thinking_level not in THINKING_BUDGET_MAP:
        valid_levels = ", ".join(THINKING_BUDGET_MAP.keys())
        logging.warning(
            f"Invalid thinking_level '{thinking_level}'. Valid values: {valid_levels}. "
            f"Defaulting to 'medium'."
        )
        return THINKING_BUDGET_MAP["medium"]

    return THINKING_BUDGET_MAP[thinking_level]


def load_task_metadata(spec_dir: Path) -> TaskMetadataConfig | None:
    """
    Load task_metadata.json from the spec directory.

    Args:
        spec_dir: Path to the spec directory

    Returns:
        Parsed task metadata or None if not found
    """
    metadata_path = spec_dir / "task_metadata.json"
    if not metadata_path.exists():
        return None

    try:
        with open(metadata_path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _metadata_phase_provider(
    metadata: TaskMetadataConfig | None, phase: Phase | None
) -> str | None:
    """Return the per-phase provider from metadata.phaseProviders, if any."""
    if not metadata or phase is None:
        return None
    phase_providers = metadata.get("phaseProviders")
    if phase_providers:
        provider = phase_providers.get(phase)
        if provider:
            return provider
    return None


def get_phase_provider(
    spec_dir: Path,
    cli_provider: str | None = None,
    phase: Phase | None = None,
) -> str | None:
    """
    Get the LLM provider configured for this task.

    Priority:
    1. CLI argument (if provided)
    2. Per-phase provider from task_metadata.json (phaseProviders[phase])
    3. Task-wide provider from task_metadata.json
    4. Provider selected via IPC (from frontend UI)
    5. None (let downstream code use its default)

    Args:
        spec_dir: Path to the spec directory
        cli_provider: Provider from CLI argument (optional)
        phase: Execution phase (spec, planning, coding, qa) for per-phase lookup

    Returns:
        Provider string (e.g. 'anthropic', 'openai', 'ollama') or None
    """
    if cli_provider:
        return cli_provider

    metadata = load_task_metadata(spec_dir)

    # Per-phase provider takes precedence over the task-wide provider.
    phase_provider = _metadata_phase_provider(metadata, phase)
    if phase_provider:
        return phase_provider

    if metadata and metadata.get("provider"):
        return metadata["provider"]

    # Check provider selected via IPC (from frontend UI)
    try:
        import provider_api

        selected_provider = provider_api.get_selected_provider()
        if selected_provider:
            return selected_provider
    except Exception:
        pass

    return None


def _resolve_provider_model(model: str, provider: str | None) -> str:
    """
    Resolve a model identifier to a full model ID, provider-aware.

    For Anthropic/Claude providers (or no provider), uses resolve_model_id()
    which maps shorthands like "sonnet" to full Claude model IDs.
    For other providers, model IDs are already full IDs and are passed through.

    Args:
        model: Model shorthand or full ID
        provider: LLM provider name (e.g. 'openai', 'anthropic') or None

    Returns:
        Full model ID ready for the API
    """
    # Anthropic/Claude shorthands need resolution. Also normalize any dotted
    # Copilot-style Claude id (e.g. "claude-opus-4.8") to the dashed Anthropic
    # form before it reaches the API, which rejects the dotted spelling.
    if not provider or provider in ("anthropic", "claude"):
        return resolve_model_id(normalize_anthropic_model_id(model))

    # For non-Anthropic providers, check if it's a Claude shorthand
    # (could happen if user switched providers but metadata still has "sonnet")
    if model in MODEL_ID_MAP:
        # This is a Claude shorthand but provider is not Anthropic — use provider defaults
        # Caller should handle this; just pass through resolve_model_id as fallback
        return resolve_model_id(model)

    # Detect Anthropic-native versioned model IDs (dash-separated versions, e.g.
    # "claude-sonnet-4-5-20250929", "claude-opus-4-6") that are NOT valid for
    # non-Anthropic providers.  Copilot uses dot-separated notation (e.g.
    # "claude-sonnet-4.5", "claude-opus-4.7") which must NOT be intercepted here.
    # This happens when a task was started with Anthropic and its task_metadata.json
    # still contains the old versioned model after the provider was switched.
    # Fall back to the provider's default model instead of sending an invalid ID.
    # The « Mythos-class » family (claude-fable-5, claude-mythos-5) has a single
    # version group and is matched by a second pattern.
    if re.match(r"^claude-(opus|sonnet|haiku)-\d+-\d", model) or re.match(
        r"^claude-(fable|mythos)-\d", model
    ):
        provider_defaults = PROVIDER_DEFAULT_MODELS.get(provider, {})
        fallback = provider_defaults.get("spec") or provider_defaults.get("coding")
        if fallback:
            return fallback

    # Already a full model ID for non-Anthropic provider
    return model


def _resolve_cli_model(cli_model: str | None) -> str | None:
    """Resolve CLI model argument if provided."""
    if cli_model:
        return resolve_model_id(cli_model)
    return None


def _resolve_auto_profile_model(
    metadata: TaskMetadataConfig, phase: Phase, cli_provider: str | None
) -> str | None:
    """Resolve model from auto profile configuration."""
    if not metadata.get("isAutoProfile") or not metadata.get("phaseModels"):
        return None

    phase_models = metadata["phaseModels"]
    provider = (
        cli_provider
        or _metadata_phase_provider(metadata, phase)
        or metadata.get("provider")
    )
    model = phase_models.get(phase, DEFAULT_PHASE_MODELS[phase])
    return _resolve_provider_model(model, provider)


def _resolve_single_model(
    metadata: TaskMetadataConfig, cli_provider: str | None
) -> str | None:
    """Resolve model from single model configuration."""
    if not metadata.get("model"):
        return None

    provider = cli_provider or metadata.get("provider")
    return _resolve_provider_model(metadata["model"], provider)


def _resolve_complexity_routing(
    spec_dir: Path,
    phase: Phase,
    cli_provider: str | None,
    metadata: TaskMetadataConfig | None,
) -> str | None:
    """Resolve model using complexity-based routing."""
    if metadata and not metadata.get("isAutoProfile"):
        return None

    try:
        from scheduling.complexity_router import get_complexity_routing

        routing = get_complexity_routing(spec_dir)
        if routing.source == "default":
            return None

        model = routing.phase_models.get(phase, DEFAULT_PHASE_MODELS[phase])
        provider = (
            cli_provider
            or _metadata_phase_provider(metadata, phase)
            or (metadata.get("provider") if metadata else None)
        )
        return _resolve_provider_model(model, provider)
    except ImportError:
        return None


def _resolve_provider_default(
    spec_dir: Path,
    phase: Phase,
    cli_provider: str | None,
    metadata: TaskMetadataConfig | None,
) -> str | None:
    """Resolve model from provider-specific defaults."""
    provider = cli_provider
    if not provider:
        provider = _metadata_phase_provider(metadata, phase)
    if not provider and metadata:
        provider = metadata.get("provider")
    if not provider:
        provider = get_phase_provider(spec_dir, phase=phase)

    if provider and provider in PROVIDER_DEFAULT_MODELS:
        provider_models = PROVIDER_DEFAULT_MODELS[provider]
        model = provider_models.get(phase, DEFAULT_PHASE_MODELS[phase])
        return _resolve_provider_model(model, provider)

    return None


def get_phase_model(
    spec_dir: Path,
    phase: Phase,
    cli_model: str | None = None,
    cli_provider: str | None = None,
) -> str:
    """
    Get the resolved model ID for a specific execution phase.

    Priority:
    1. CLI argument (if provided)
    2. Phase-specific config from task_metadata.json (if auto profile)
    3. Single model from task_metadata.json (if not auto profile)
    4. Provider-specific default (if provider is known)
    5. Default phase configuration (Anthropic/Claude fallback)

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_model: Model from CLI argument (optional)
        cli_provider: Provider from CLI argument (optional)

    Returns:
        Resolved full model ID
    """
    # 1. CLI argument takes precedence
    cli_result = _resolve_cli_model(cli_model)
    if cli_result:
        return cli_result

    # 2. Load task metadata
    metadata = load_task_metadata(spec_dir)

    # 3. Auto profile with phase-specific config
    if metadata:
        auto_profile_result = _resolve_auto_profile_model(metadata, phase, cli_provider)
        if auto_profile_result:
            return auto_profile_result

        # 4. Non-auto profile: use single model
        single_model_result = _resolve_single_model(metadata, cli_provider)
        if single_model_result:
            return single_model_result

    # 5. Complexity-based routing
    complexity_result = _resolve_complexity_routing(
        spec_dir, phase, cli_provider, metadata
    )
    if complexity_result:
        return complexity_result

    # 6. Provider-specific defaults
    provider_result = _resolve_provider_default(spec_dir, phase, cli_provider, metadata)
    if provider_result:
        return provider_result

    # 7. Ultimate fallback: Anthropic/Claude default
    return resolve_model_id(DEFAULT_PHASE_MODELS[phase])


def get_phase_thinking(
    spec_dir: Path,
    phase: Phase,
    cli_thinking: str | None = None,
) -> str:
    """
    Get the thinking level for a specific execution phase.

    Priority:
    1. CLI argument (if provided)
    2. Per-phase thinking from task_metadata.json (phaseThinking[phase]) whenever
       present — regardless of isAutoProfile
    3. Single thinking level from task_metadata.json
    4. Default phase configuration

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_thinking: Thinking level from CLI argument (optional)

    Returns:
        Thinking level string
    """
    # CLI argument takes precedence
    if cli_thinking:
        return cli_thinking

    # Load task metadata
    metadata = load_task_metadata(spec_dir)

    if metadata:
        # Per-phase thinking wins whenever the phase is present — regardless of
        # isAutoProfile. This mirrors the frontend selector, whose `getPhaseConfig`
        # reads `metadata.phaseThinking[phase]` unconditionally. A single-model
        # resume (RESUME_WITH_PROVIDER sets isAutoProfile=false to force its chosen
        # model) must keep honouring the per-phase effort the user still sees;
        # otherwise the UI shows e.g. "Low" while the run uses the "high" default.
        phase_thinking = metadata.get("phaseThinking") or {}
        if phase_thinking.get(phase):
            return phase_thinking[phase]

        # Otherwise honour a single thinking level if one was set.
        if metadata.get("thinkingLevel"):
            return metadata["thinkingLevel"]

    # Complexity-based thinking routing (Cost Intelligence Engine)
    if not metadata or metadata.get("isAutoProfile"):
        try:
            from scheduling.complexity_router import get_complexity_routing

            routing = get_complexity_routing(spec_dir)
            if routing.source != "default":
                return routing.phase_thinking.get(phase, DEFAULT_PHASE_THINKING[phase])
        except ImportError:
            pass

    # Fall back to default phase configuration
    return DEFAULT_PHASE_THINKING[phase]


def get_phase_thinking_budget(
    spec_dir: Path,
    phase: Phase,
    cli_thinking: str | None = None,
) -> int | None:
    """
    Get the thinking budget tokens for a specific execution phase.

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_thinking: Thinking level from CLI argument (optional)

    Returns:
        Token budget or None for no extended thinking
    """
    thinking_level = get_phase_thinking(spec_dir, phase, cli_thinking)
    return get_thinking_budget(thinking_level)


def get_phase_config(
    spec_dir: Path,
    phase: Phase,
    cli_model: str | None = None,
    cli_thinking: str | None = None,
    cli_provider: str | None = None,
) -> tuple[str, str, int | None]:
    """
    Get the full configuration for a specific execution phase.

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_model: Model from CLI argument (optional)
        cli_thinking: Thinking level from CLI argument (optional)
        cli_provider: Provider from CLI argument (optional)

    Returns:
        Tuple of (model_id, thinking_level, thinking_budget)
    """
    model_id = get_phase_model(spec_dir, phase, cli_model, cli_provider)
    thinking_level = get_phase_thinking(spec_dir, phase, cli_thinking)
    thinking_budget = get_thinking_budget(thinking_level)

    return model_id, thinking_level, thinking_budget


def get_spec_phase_thinking_budget(phase_name: str) -> int | None:
    """
    Get the thinking budget for a specific spec runner phase.

    This maps granular spec phases (discovery, spec_writing, etc.) to their
    appropriate thinking budgets based on SPEC_PHASE_THINKING_LEVELS.

    Args:
        phase_name: Name of the spec phase (e.g., 'discovery', 'spec_writing')

    Returns:
        Token budget for extended thinking, or None for no extended thinking
    """
    thinking_level = SPEC_PHASE_THINKING_LEVELS.get(phase_name, "medium")
    return get_thinking_budget(thinking_level)
