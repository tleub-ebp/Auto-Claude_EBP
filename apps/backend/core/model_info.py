#!/usr/bin/env python3
"""
Model Information Utility
=========================

Utility for getting current LLM model and provider information for logging.
Similar to frontend functionality but adapted for backend architecture.
"""

import os


def get_current_model_info() -> dict[str, str]:
    """
    Get current LLM model and provider information for logging.

    Returns:
        Dictionary containing provider, model, and model_label information
    """
    try:
        # Try to get selected provider from global state (provider_api.py)
        try:
            from provider_api import get_selected_provider

            selected_provider = get_selected_provider()
        except ImportError:
            selected_provider = None

        # If no selected provider, try to detect from environment
        if not selected_provider:
            selected_provider = _detect_provider_from_env()

        if not selected_provider:
            return {"provider": "unknown", "model": "unknown", "model_label": "unknown"}

        # Get model information for the provider
        model_info = _get_model_info_for_provider(selected_provider)

        return {
            "provider": selected_provider,
            "model": model_info.get("model", "unknown"),
            "model_label": model_info.get(
                "model_label", model_info.get("model", "unknown")
            ),
        }

    except Exception:
        return {"provider": "error", "model": "error", "model_label": "error"}


def _detect_provider_from_env() -> str | None:
    """Detect which provider is likely configured based on environment variables."""

    # Highest priority: explicit provider signal injected by the frontend into the
    # agent subprocess. `SELECTED_LLM_PROVIDER` is set by the credential manager and
    # `AUTO_CLAUDE_PROVIDER` is the generic override. This MUST win over the API-key
    # heuristics below, because GitHub Copilot authenticates with an
    # Anthropic-compatible token (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) and
    # would otherwise be mislabelled as the "anthropic" provider in the logs.
    explicit = (
        (os.getenv("SELECTED_LLM_PROVIDER") or os.getenv("AUTO_CLAUDE_PROVIDER") or "")
        .strip()
        .lower()
    )
    if explicit:
        # "claude" is an alias used by some frontend code paths for Anthropic.
        return "anthropic" if explicit == "claude" else explicit

    # Check in order of preference
    if (
        os.getenv("ANTHROPIC_API_KEY")
        or os.getenv("CLAUDE_API_KEY")
        or os.getenv("CLAUDE_CODE_OAUTH_TOKEN")
    ):
        return "anthropic"
    elif os.getenv("OPENAI_API_KEY"):
        return "openai"
    elif os.getenv("GOOGLE_API_KEY"):
        return "google"
    elif os.getenv("GROK_API_KEY"):
        return "grok"
    elif os.getenv("OLLAMA_BASE_URL"):
        return "ollama"
    elif (
        os.getenv("WINDSURF_API_KEY")
        or os.getenv("WINDSURF_OAUTH_TOKEN")
        or os.getenv("CODEIUM_API_KEY")
    ):
        return "windsurf"
    elif _is_copilot_available():
        return "copilot"

    return None


def _is_copilot_available() -> bool:
    """Check if GitHub Copilot is available via gh CLI."""
    try:
        from security.secure_subprocess import run_secure

        result = run_secure(["gh", "auth", "status"], timeout=10)
        return "Logged in to github.com" in result.output
    except Exception:
        return False


def _get_model_info_for_provider(provider: str) -> dict[str, str]:
    """Get model information for a specific provider."""

    if provider == "anthropic":
        # Try to get from provider config first
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("anthropic") or load_provider_config("claude")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": _format_anthropic_model_label(config["model"]),
                }
        except ImportError:
            pass

        # Fallback to environment or defaults
        model = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")
        return {"model": model, "model_label": _format_anthropic_model_label(model)}

    elif provider == "openai":
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("openai")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": _format_openai_model_label(config["model"]),
                }
        except ImportError:
            pass

        model = os.getenv("OPENAI_MODEL", "gpt-4o")
        return {"model": model, "model_label": _format_openai_model_label(model)}

    elif provider == "google":
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("google")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": _format_google_model_label(config["model"]),
                }
        except ImportError:
            pass

        model = os.getenv("GOOGLE_MODEL", "gemini-3.0")
        return {"model": model, "model_label": _format_google_model_label(model)}

    elif provider == "grok":
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("grok")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": _format_grok_model_label(config["model"]),
                }
        except ImportError:
            pass

        model = os.getenv("GROK_MODEL", "grok-2")
        return {"model": model, "model_label": _format_grok_model_label(model)}

    elif provider == "ollama":
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("ollama")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": f"Ollama: {config['model']}",
                }
        except ImportError:
            pass

        model = os.getenv("OLLAMA_MODEL", "llama3")
        return {"model": model, "model_label": f"Ollama: {model}"}

    elif provider == "copilot":
        return {"model": "copilot", "model_label": "GitHub Copilot"}

    elif provider == "windsurf":
        try:
            from src.connectors.llm_config import load_provider_config

            config = load_provider_config("windsurf")
            if config and "model" in config:
                return {
                    "model": config["model"],
                    "model_label": _format_windsurf_model_label(config["model"]),
                }
        except ImportError:
            pass

        model = os.getenv("WINDSURF_MODEL", "claude-4-sonnet")
        return {"model": model, "model_label": _format_windsurf_model_label(model)}

    # Default fallback
    return {"model": "unknown", "model_label": "Unknown Model"}


def _format_anthropic_model_label(model: str) -> str:
    """Format Anthropic model label for display."""
    model_labels = {
        "claude-opus-4-8": "Claude Opus 4.8",
        "claude-sonnet-4-8": "Claude Sonnet 4.8",
        "claude-haiku-4-8": "Claude Haiku 4.8",
        "claude-opus-4-7": "Claude Opus 4.7",
        "claude-opus-4-6": "Claude Opus 4.6",
        "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
        "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
        "claude-opus-4-5-20251101": "Claude Opus 4.5",
        "opus-4.6": "Opus 4.6",
    }
    return model_labels.get(model, f"Claude: {model}")


def _format_openai_model_label(model: str) -> str:
    """Format OpenAI model label for display."""
    model_labels = {
        "gpt-4o": "GPT-4o",
        "gpt-4.1": "GPT-4.1",
        "gpt-4.1-mini": "GPT-4.1 mini",
        "gpt-4.1-nano": "GPT-4.1 nano",
        "gpt-4o-mini": "GPT-4o mini",
        "gpt-4-turbo": "GPT-4 Turbo",
        "gpt-4": "GPT-4",
        "gpt-3.5-turbo": "GPT-3.5 Turbo",
        "o1": "o1",
        "o1-mini": "o1-mini",
        "o1-pro": "o1 Pro",
        "o3": "o3",
        "o3-mini": "o3-mini",
        "o4-mini": "o4-mini",
    }
    return model_labels.get(model, f"OpenAI: {model}")


def _format_google_model_label(model: str) -> str:
    """Format Google model label for display."""
    model_labels = {
        "gemini-3.0": "Gemini 3.0",
        "gemini-2.0": "Gemini 2.0",
        "gemini-1.5-pro": "Gemini 1.5 Pro",
        "gemini-1.5-flash": "Gemini 1.5 Flash",
    }
    return model_labels.get(model, f"Gemini: {model}")


def _format_grok_model_label(model: str) -> str:
    """Format Grok model label for display."""
    model_labels = {
        "grok-2": "Grok 2",
        "grok-1": "Grok 1",
    }
    return model_labels.get(model, f"Grok: {model}")


def _format_windsurf_model_label(model: str) -> str:
    """Format Windsurf model label for display."""
    model_labels = {
        # SWE models (Windsurf proprietary)
        "swe-1.6": "SWE-1.6",
        "swe-1.6-fast": "SWE-1.6 Fast",
        "swe-1.5": "SWE-1.5",
        "swe-1.5-thinking": "SWE-1.5 Thinking",
        "swe-1.5-slow": "SWE-1.5 Slow",
        "swe-1.5-fast": "SWE-1.5 Fast",
        # Claude models (canonical aliases used by WorkPilot)
        "claude-sonnet-4": "Claude Sonnet 4 (Windsurf)",
        "claude-opus-4": "Claude Opus 4 (Windsurf)",
        "claude-3.7-sonnet": "Claude 3.7 Sonnet (Windsurf)",
        "claude-3.7-sonnet-thinking": "Claude 3.7 Sonnet Thinking (Windsurf)",
        "claude-3.5-sonnet": "Claude 3.5 Sonnet (Windsurf)",
        # Internal aliases kept for compatibility
        "claude-4-sonnet": "Claude Sonnet 4 (Windsurf)",
        "claude-4-opus": "Claude Opus 4 (Windsurf)",
        "claude-4.5-sonnet": "Claude 4.5 Sonnet (Windsurf)",
        "claude-4.5-opus": "Claude 4.5 Opus (Windsurf)",
        "claude-code": "Claude Code (Windsurf)",
        # GPT models
        "gpt-4o": "GPT-4o (Windsurf)",
        "gpt-4.1": "GPT-4.1 (Windsurf)",
        "gpt-4.1-mini": "GPT-4.1 mini (Windsurf)",
        # Reasoning
        "o3": "o3 (Windsurf)",
        "o3-mini": "o3-mini (Windsurf)",
        "o4-mini": "o4-mini (Windsurf)",
        # Other
        "gemini-2.5-pro": "Gemini 2.5 Pro (Windsurf)",
        "gemini-2.0-flash": "Gemini 2.0 Flash (Windsurf)",
        "deepseek-r1": "DeepSeek R1 (Windsurf)",
        "deepseek-v3": "DeepSeek V3 (Windsurf)",
        "grok-3": "Grok 3 (Windsurf)",
    }
    return model_labels.get(model, f"Windsurf: {model}")


def get_model_info_string() -> str:
    """
    Get model/provider info as a formatted string for logging.

    Returns:
        String in format [provider:model_label]
    """
    model_info = get_current_model_info()
    return f"[{model_info['provider']}:{model_info['model_label']}]"


def get_model_info_for_logs() -> dict[str, str]:
    """
    Get model info for logging (simplified interface).

    Returns:
        Dictionary with provider and model_label keys
    """
    model_info = get_current_model_info()
    return {
        "provider": model_info["provider"],
        "model_label": model_info["model_label"],
    }
