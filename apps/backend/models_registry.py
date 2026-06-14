"""Centralized LLM model registry.

Single source of truth for all model metadata, pricing, tiers, and provider defaults.
Replaces hardcoded model strings scattered across phase_config.py, provider_api.py,
cost_intelligence/, and agent_client.py.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelEntry:
    """A single LLM model with metadata, pricing, and routing info."""

    provider: str
    model_id: str
    label: str
    tier: str  # "flagship" | "standard" | "fast" | "local"
    supports_thinking: bool = False

    # Pricing (USD per 1M tokens; 0.0 = unmetered/flat-rate)
    price_input: float = 0.0
    price_output: float = 0.0
    price_cache_write: float = 0.0
    price_cache_read: float = 0.0
    price_thinking: float = 0.0
    energy_kwh_per_million_tok: float = 0.0

    # Routing helpers
    is_default: bool = False
    base_url: str | None = None


# =============================================================================
# ANTHROPIC / CLAUDE MODELS
# =============================================================================

_ANTHROPIC_MODELS = [
    # Claude Fable 5 — « Mythos-class » (GA 2026-06-09), au-dessus d'Opus 4.8.
    ModelEntry(
        "anthropic",
        "claude-fable-5",
        "Claude Fable 5",
        "flagship",
        supports_thinking=True,
        price_input=10.0,
        price_output=50.0,
        is_default=False,
    ),
    # Flagship
    ModelEntry(
        "anthropic",
        "claude-opus-4-8",
        "Claude Opus 4.8",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-7",
        "Claude Opus 4.7",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-6-v1",
        "Claude Opus 4.6",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-6",
        "Claude Opus 4.6",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-5-20251101",
        "Claude Opus 4.5",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-5",
        "Claude Opus 4.5",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-20250514",
        "Claude Opus 4 (May 2025)",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    # Standard
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-5-20250929",
        "Claude Sonnet 4.5",
        "standard",
        supports_thinking=True,
        price_input=3.0,
        price_output=15.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        "standard",
        price_input=3.0,
        price_output=15.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        "standard",
        price_input=3.0,
        price_output=15.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-20250514",
        "Claude Sonnet 4 (May 2025)",
        "standard",
        price_input=3.0,
        price_output=15.0,
        is_default=False,
    ),
    # Fast
    ModelEntry(
        "anthropic",
        "claude-haiku-4-5-20251001",
        "Claude Haiku 4.5",
        "fast",
        price_input=0.80,
        price_output=4.0,
        is_default=False,
    ),
    ModelEntry(
        "anthropic",
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        "fast",
        price_input=0.80,
        price_output=4.0,
        is_default=False,
    ),
]

# =============================================================================
# OPENAI MODELS
# =============================================================================

_OPENAI_MODELS = [
    # Flagship with thinking
    ModelEntry(
        "openai",
        "gpt-5.5-pro",
        "GPT-5.5 Pro",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=60.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-5.5",
        "GPT-5.5",
        "flagship",
        supports_thinking=True,
        price_input=6.0,
        price_output=24.0,
        is_default=True,
    ),
    ModelEntry(
        "openai",
        "gpt-5.5-mini",
        "GPT-5.5 Mini",
        "standard",
        supports_thinking=True,
        price_input=0.80,
        price_output=3.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-5.2",
        "GPT-5.2",
        "flagship",
        supports_thinking=True,
        price_input=10.0,
        price_output=40.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o4",
        "O4",
        "flagship",
        supports_thinking=True,
        price_input=20.0,
        price_output=80.0,
        is_default=False,
    ),
    # Latest
    ModelEntry(
        "openai",
        "gpt-4.1",
        "GPT-4.1",
        "flagship",
        price_input=2.50,
        price_output=10.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4.1-mini",
        "GPT-4.1 Mini",
        "standard",
        price_input=0.40,
        price_output=1.60,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4.1-nano",
        "GPT-4.1 Nano",
        "fast",
        price_input=0.10,
        price_output=0.40,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4o",
        "GPT-4o",
        "standard",
        price_input=2.50,
        price_output=10.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4o-mini",
        "GPT-4o Mini",
        "fast",
        price_input=0.15,
        price_output=0.60,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4-turbo",
        "GPT-4 Turbo",
        "flagship",
        price_input=10.0,
        price_output=30.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-4",
        "GPT-4",
        "flagship",
        price_input=30.0,
        price_output=60.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "gpt-3.5-turbo",
        "GPT-3.5 Turbo",
        "fast",
        price_input=0.50,
        price_output=1.50,
        is_default=False,
    ),
    # Reasoning models
    ModelEntry(
        "openai",
        "o1",
        "O1",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=60.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o1-mini",
        "O1 Mini",
        "standard",
        supports_thinking=True,
        price_input=3.0,
        price_output=12.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o1-pro",
        "O1 Pro",
        "flagship",
        supports_thinking=True,
        price_input=150.0,
        price_output=600.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o3",
        "O3",
        "flagship",
        supports_thinking=True,
        price_input=10.0,
        price_output=40.0,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o3-mini",
        "O3 Mini",
        "standard",
        supports_thinking=True,
        price_input=1.10,
        price_output=4.40,
        is_default=False,
    ),
    ModelEntry(
        "openai",
        "o4-mini",
        "O4 Mini",
        "standard",
        supports_thinking=True,
        price_input=1.10,
        price_output=4.40,
        is_default=False,
    ),
]

# =============================================================================
# GOOGLE / GEMINI MODELS
# =============================================================================

_GOOGLE_MODELS = [
    # Flagship with thinking
    ModelEntry(
        "google",
        "gemini-3.1-pro",
        "Gemini 3.1 Pro",
        "flagship",
        supports_thinking=True,
        price_input=7.50,
        price_output=30.0,
        is_default=True,
    ),
    ModelEntry(
        "google",
        "gemini-3.1-flash",
        "Gemini 3.1 Flash",
        "standard",
        supports_thinking=True,
        price_input=0.75,
        price_output=3.0,
        is_default=False,
    ),
    ModelEntry(
        "google",
        "gemini-3.1-flash-lite",
        "Gemini 3.1 Flash Lite",
        "fast",
        price_input=0.075,
        price_output=0.30,
        is_default=False,
    ),
    # Current versions
    ModelEntry(
        "google",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro",
        "standard",
        price_input=1.25,
        price_output=5.0,
        is_default=False,
    ),
    ModelEntry(
        "google",
        "gemini-2.5-flash",
        "Gemini 2.5 Flash",
        "fast",
        price_input=0.15,
        price_output=0.60,
        is_default=False,
    ),
    ModelEntry(
        "google",
        "gemini-2.0-flash",
        "Gemini 2.0 Flash",
        "fast",
        price_input=0.10,
        price_output=0.40,
        is_default=False,
    ),
]

# =============================================================================
# MISTRAL MODELS
# =============================================================================

_MISTRAL_MODELS = [
    # Flagship with thinking
    ModelEntry(
        "mistral",
        "mistral-large-3",
        "Mistral Large 3",
        "flagship",
        price_input=2.0,
        price_output=6.0,
        is_default=True,
    ),
    ModelEntry(
        "mistral",
        "magistral-medium-2506",
        "Magistral Medium",
        "flagship",
        supports_thinking=True,
        price_input=2.0,
        price_output=6.0,
        is_default=False,
    ),
    ModelEntry(
        "mistral",
        "magistral-small-2506",
        "Magistral Small",
        "standard",
        supports_thinking=True,
        price_input=0.20,
        price_output=0.60,
        is_default=False,
    ),
    # Standard
    ModelEntry(
        "mistral",
        "mistral-small-4",
        "Mistral Small 4",
        "standard",
        price_input=0.14,
        price_output=0.42,
        is_default=False,
    ),
    ModelEntry(
        "mistral",
        "mistral-large-2",
        "Mistral Large 2",
        "standard",
        price_input=2.0,
        price_output=6.0,
        is_default=False,
    ),
    # Code
    ModelEntry(
        "mistral",
        "devstral-2512",
        "Devstral 2512",
        "flagship",
        price_input=1.0,
        price_output=3.0,
        is_default=False,
    ),
]

# =============================================================================
# DEEPSEEK MODELS
# =============================================================================

_DEEPSEEK_MODELS = [
    # Flagship with thinking
    ModelEntry(
        "deepseek",
        "deepseek-v4",
        "DeepSeek V4",
        "flagship",
        supports_thinking=True,
        price_input=1.0,
        price_output=3.0,
        is_default=False,
    ),
    ModelEntry(
        "deepseek",
        "deepseek-v4-flash",
        "DeepSeek V4 Flash",
        "standard",
        supports_thinking=True,
        price_input=0.14,
        price_output=0.28,
        is_default=False,
    ),
    ModelEntry(
        "deepseek",
        "deepseek-reasoner",
        "DeepSeek Reasoner",
        "flagship",
        supports_thinking=True,
        price_input=0.55,
        price_output=2.19,
        is_default=False,
    ),
    # Standard
    ModelEntry(
        "deepseek",
        "deepseek-chat",
        "DeepSeek Chat",
        "standard",
        price_input=0.27,
        price_output=1.10,
        is_default=False,
    ),
    ModelEntry(
        "deepseek",
        "deepseek-v3",
        "DeepSeek V3",
        "standard",
        price_input=0.27,
        price_output=1.10,
        is_default=True,
    ),
    # Code
    ModelEntry(
        "deepseek",
        "deepseek-coder-v3",
        "DeepSeek Coder V3",
        "standard",
        price_input=0.14,
        price_output=0.28,
        is_default=False,
    ),
]

# =============================================================================
# GROK MODELS
# =============================================================================

_GROK_MODELS = [
    # Flagship with thinking
    ModelEntry(
        "grok",
        "grok-4.3",
        "Grok 4.3",
        "flagship",
        supports_thinking=True,
        price_input=5.0,
        price_output=15.0,
        is_default=True,
    ),
    ModelEntry(
        "grok",
        "grok-4.20-reasoning",
        "Grok 4.20 Reasoning",
        "flagship",
        supports_thinking=True,
        price_input=5.0,
        price_output=15.0,
        is_default=False,
    ),
    # Standard & Fast
    ModelEntry(
        "grok",
        "grok-4",
        "Grok 4",
        "flagship",
        supports_thinking=True,
        price_input=5.0,
        price_output=15.0,
        is_default=False,
    ),
    ModelEntry(
        "grok",
        "grok-2",
        "Grok 2",
        "standard",
        price_input=2.0,
        price_output=10.0,
        is_default=False,
    ),
    ModelEntry(
        "grok",
        "grok-2-mini",
        "Grok 2 Mini",
        "fast",
        price_input=0.30,
        price_output=0.50,
        is_default=False,
    ),
    ModelEntry(
        "grok",
        "grok-4.1-fast",
        "Grok 4.1 Fast",
        "fast",
        price_input=1.0,
        price_output=3.0,
        is_default=False,
    ),
]

# =============================================================================
# META / LLAMA MODELS
# =============================================================================

_META_MODELS = [
    ModelEntry(
        "meta",
        "llama-3.3-70b",
        "Llama 3.3 70B",
        "standard",
        price_input=0.72,
        price_output=0.72,
        is_default=False,
    ),
    ModelEntry(
        "meta",
        "llama-3.1-8b",
        "Llama 3.1 8B",
        "fast",
        price_input=0.05,
        price_output=0.10,
        is_default=False,
    ),
    ModelEntry(
        "meta",
        "llama-3.1-70b",
        "Llama 3.1 70B",
        "standard",
        price_input=0.59,
        price_output=0.79,
        is_default=False,
    ),
    ModelEntry(
        "meta",
        "llama-4-maverick",
        "Llama 4 Maverick",
        "flagship",
        price_input=2.0,
        price_output=6.0,
        is_default=False,
    ),
    ModelEntry(
        "meta",
        "meta-llama/llama-4-scout",
        "Meta Llama 4 Scout",
        "standard",
        price_input=1.0,
        price_output=3.0,
        is_default=True,
    ),
]

# =============================================================================
# OLLAMA MODELS (local/free)
# =============================================================================

_OLLAMA_MODELS = [
    ModelEntry("ollama", "llama3.3", "Llama 3.3", "local", is_default=True),
    ModelEntry(
        "ollama", "deepseek-coder-v3", "DeepSeek Coder V3", "local", is_default=False
    ),
]

# =============================================================================
# WINDSURF / CODEIUM MODELS
# =============================================================================

# Model IDs are the friendly slugs resolved by integrations/windsurf_proxy/models.py
# (MODEL_NAME_TO_ENUM). The previous values were internal MODEL_<ENUM> placeholder
# names which are NOT valid model identifiers and broke the Windsurf provider.
_WINDSURF_MODELS = [
    ModelEntry("windsurf", "swe-1.6-fast", "SWE 1.6 Fast", "fast", is_default=True),
    ModelEntry("windsurf", "swe-1.6", "SWE 1.6", "flagship", is_default=False),
    ModelEntry("windsurf", "swe-1.5", "SWE 1.5", "flagship", is_default=False),
    ModelEntry(
        "windsurf",
        "swe-1.5-thinking",
        "SWE 1.5 Thinking",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "claude-opus-4",
        "Claude Opus 4 (Windsurf)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "claude-sonnet-4",
        "Claude Sonnet 4 (Windsurf)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "claude-3.7-sonnet",
        "Claude 3.7 Sonnet (Windsurf)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf", "gpt-4.1", "GPT-4.1 (Windsurf)", "standard", is_default=False
    ),
    ModelEntry("windsurf", "gpt-4o", "GPT-4o (Windsurf)", "standard", is_default=False),
    ModelEntry(
        "windsurf",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro (Windsurf)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "deepseek-r1",
        "DeepSeek R1 (Windsurf)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "deepseek-v3",
        "DeepSeek V3 (Windsurf)",
        "standard",
        is_default=False,
    ),
    ModelEntry(
        "windsurf",
        "gemini-2.0-flash",
        "Gemini 2.0 Flash (Windsurf)",
        "fast",
        is_default=False,
    ),
    ModelEntry("windsurf", "swe-1.5-fast", "SWE 1.5 Fast", "fast", is_default=False),
]

# =============================================================================
# AWS BEDROCK MODELS
# =============================================================================

_AWS_MODELS = [
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-8",
        "Claude Opus 4.8 (Bedrock)",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-8-v1",
        "Claude Opus 4.8 v1 (Bedrock)",
        "flagship",
        supports_thinking=True,
        price_input=15.0,
        price_output=75.0,
        is_default=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-fable-5",
        "Claude Fable 5 (Bedrock)",
        "flagship",
        supports_thinking=True,
        price_input=10.0,
        price_output=50.0,
        is_default=False,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-6",
        "Claude Opus 4.6 (Bedrock)",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-6-v1",
        "Claude Opus 4.6 v1 (Bedrock)",
        "flagship",
        price_input=15.0,
        price_output=75.0,
        is_default=False,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-sonnet-4-6",
        "Claude Sonnet 4.6 (Bedrock)",
        "standard",
        price_input=3.0,
        price_output=15.0,
        is_default=False,
    ),
    ModelEntry(
        "aws",
        "meta.llama-3.3-70b",
        "Llama 3.3 70B (Bedrock)",
        "standard",
        price_input=0.72,
        price_output=0.72,
        is_default=False,
    ),
]

# =============================================================================
# COPILOT MODELS
# Source: docs.github.com/en/copilot/reference/ai-models/supported-models
# =============================================================================

_COPILOT_MODELS = [
    # ── Flagship / Opus ───────────────────────────────────────────────────
    ModelEntry(
        "copilot",
        "claude-opus-4.8",
        "Claude Opus 4.8 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.7",
        "Claude Opus 4.7 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.6",
        "Claude Opus 4.6 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.5",
        "Claude Opus 4.5 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    # ── GPT-5 family ─────────────────────────────────────────────────────
    ModelEntry(
        "copilot",
        "gpt-5.5",
        "GPT-5.5 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gpt-5.4",
        "GPT-5.4 (Copilot)",
        "flagship",
        supports_thinking=True,
        is_default=False,
    ),
    # ── Standard ─────────────────────────────────────────────────────────
    ModelEntry(
        "copilot",
        "claude-sonnet-4.6",
        "Claude Sonnet 4.6 (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "copilot",
        "claude-sonnet-4.5",
        "Claude Sonnet 4.5 (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gpt-4.1",
        "GPT-4.1 (Copilot)",
        "standard",
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gpt-4o",
        "GPT-4o (Copilot)",
        "standard",
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "o4-mini",
        "o4-mini (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "o3",
        "o3 (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "o3-mini",
        "o3-mini (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "o1",
        "o1 (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "claude-3.7-sonnet",
        "Claude 3.7 Sonnet (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=False,
    ),
    # ── Fast ─────────────────────────────────────────────────────────────
    ModelEntry(
        "copilot",
        "claude-haiku-4.5",
        "Claude Haiku 4.5 (Copilot)",
        "fast",
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gemini-2.0-flash",
        "Gemini 2.0 Flash (Copilot)",
        "fast",
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gpt-4.1-mini",
        "GPT-4.1 mini (Copilot)",
        "fast",
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "o1-mini",
        "o1-mini (Copilot)",
        "fast",
        supports_thinking=True,
        is_default=False,
    ),
    ModelEntry(
        "copilot",
        "gpt-4o-mini",
        "GPT-4o mini (Copilot)",
        "fast",
        is_default=False,
    ),
]

# =============================================================================
# CURSOR MODELS
# =============================================================================

_CURSOR_MODELS = [
    ModelEntry(
        "cursor", "cursor-default", "Cursor Default", "standard", is_default=True
    ),
]

# =============================================================================
# REGISTRY
# =============================================================================

REGISTRY: tuple[ModelEntry, ...] = tuple(
    _ANTHROPIC_MODELS
    + _OPENAI_MODELS
    + _GOOGLE_MODELS
    + _MISTRAL_MODELS
    + _DEEPSEEK_MODELS
    + _GROK_MODELS
    + _META_MODELS
    + _OLLAMA_MODELS
    + _WINDSURF_MODELS
    + _AWS_MODELS
    + _COPILOT_MODELS
    + _CURSOR_MODELS
)

# =============================================================================
# HELPERS
# =============================================================================


def get_default(provider: str) -> ModelEntry | None:
    """Get the default model for a provider."""
    for entry in REGISTRY:
        if entry.provider == provider and entry.is_default:
            return entry
    return None


def get_tier(provider: str, tier: str) -> ModelEntry | None:
    """Get the representative model for a provider + tier combination."""
    for entry in REGISTRY:
        if entry.provider == provider and entry.tier == tier:
            return entry
    return None


def get_pricing(provider: str, model_id: str) -> ModelEntry | None:
    """Get pricing for a provider + model combination."""
    for entry in REGISTRY:
        if entry.provider == provider and entry.model_id == model_id:
            return entry
    return None


def list_provider(provider: str) -> list[ModelEntry]:
    """List all models for a provider."""
    return [e for e in REGISTRY if e.provider == provider]
