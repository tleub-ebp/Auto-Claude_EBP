"""
Pricing Catalog — Versioned per-model pricing for all supported providers.

Prices are expressed in USD per 1M tokens. The catalog covers input,
output, cache_write, cache_read, thinking, and vision token types.

Ollama models default to $0 but can optionally track energy cost.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelPricing:
    """Per-model pricing in USD per 1M tokens."""

    provider: str
    model: str
    input: float = 0.0
    output: float = 0.0
    cache_write: float = 0.0
    cache_read: float = 0.0
    thinking: float = 0.0
    vision: float = 0.0
    energy_kwh_per_million_tok: float = 0.0

    def cost_for_tokens(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_write_tokens: int = 0,
        cache_read_tokens: int = 0,
        thinking_tokens: int = 0,
        vision_tokens: int = 0,
    ) -> float:
        """Calculate USD cost for the given token counts."""
        return (
            (input_tokens * self.input / 1_000_000)
            + (output_tokens * self.output / 1_000_000)
            + (cache_write_tokens * self.cache_write / 1_000_000)
            + (cache_read_tokens * self.cache_read / 1_000_000)
            + (thinking_tokens * self.thinking / 1_000_000)
            + (vision_tokens * self.vision / 1_000_000)
        )


# Built-in pricing catalog (can be overridden by a JSON/YAML file)
_DEFAULT_CATALOG: dict[str, dict[str, dict[str, float]]] = {
    "anthropic": {
        # 4.8 (current latest) — public price sheet $5/$25 per MTok (Opus-tier),
        # cache at the standard Anthropic multipliers (1.25× / 0.1× input).
        "claude-opus-4-8": {
            "input": 5.0,
            "output": 25.0,
            "cache_write": 6.25,
            "cache_read": 0.50,
            "thinking": 25.0,
        },
        # Fable 5 — « Mythos-class » (GA 2026-06-09). Prix public $10/$50 ; cache
        # aux multiplicateurs standard Anthropic (1.25× / 0.1× l'entrée).
        "claude-fable-5": {
            "input": 10.0,
            "output": 50.0,
            "cache_write": 12.50,
            "cache_read": 1.00,
            "thinking": 50.0,
        },
        # Mythos 5 — same capabilities/pricing as Fable 5 (Project Glasswing only).
        "claude-mythos-5": {
            "input": 10.0,
            "output": 50.0,
            "cache_write": 12.50,
            "cache_read": 1.00,
            "thinking": 50.0,
        },
        "claude-sonnet-4-8": {
            "input": 3.0,
            "output": 15.0,
            "cache_write": 3.75,
            "cache_read": 0.30,
        },
        "claude-haiku-4-8": {"input": 1.0, "output": 5.0},
        # 4.7
        "claude-opus-4-7": {
            "input": 5.0,
            "output": 25.0,
            "cache_write": 6.25,
            "cache_read": 0.50,
            "thinking": 25.0,
        },
        "claude-sonnet-4-7": {
            "input": 3.0,
            "output": 15.0,
            "cache_write": 3.75,
            "cache_read": 0.30,
        },
        "claude-haiku-4-7": {"input": 1.0, "output": 5.0},
        # 4.6
        "claude-opus-4-6": {
            "input": 5.0,
            "output": 25.0,
            "cache_write": 6.25,
            "cache_read": 0.50,
            "thinking": 25.0,
        },
        "claude-sonnet-4-6": {
            "input": 3.0,
            "output": 15.0,
            "cache_write": 3.75,
            "cache_read": 0.30,
        },
        "claude-haiku-4-6": {"input": 1.0, "output": 5.0},
        # 4.5 (the date-stamped IDs DEFAULT_PHASE_MODELS resolves to today).
        "claude-opus-4-5": {
            "input": 5.0,
            "output": 25.0,
            "cache_write": 6.25,
            "cache_read": 0.50,
            "thinking": 25.0,
        },
        "claude-opus-4-5-20251101": {
            "input": 5.0,
            "output": 25.0,
            "cache_write": 6.25,
            "cache_read": 0.50,
            "thinking": 25.0,
        },
        "claude-sonnet-4-5": {
            "input": 3.0,
            "output": 15.0,
            "cache_write": 3.75,
            "cache_read": 0.30,
        },
        "claude-sonnet-4-5-20250929": {
            "input": 3.0,
            "output": 15.0,
            "cache_write": 3.75,
            "cache_read": 0.30,
        },
        "claude-haiku-4-5": {"input": 1.0, "output": 5.0},
        "claude-haiku-4-5-20251001": {"input": 1.0, "output": 5.0},
        # 4.0 (older snapshots kept for replay reproducibility).
        "claude-opus-4-20250514": {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-20250514": {"input": 3.0, "output": 15.0},
    },
    # NOTE: non-Anthropic prices below are best-effort estimates (no authoritative
    # price sheet in-repo) — verify against each provider's public pricing.
    "openai": {
        "gpt-5.1": {"input": 1.25, "output": 10.0},
        "gpt-5": {"input": 1.25, "output": 10.0},
        "gpt-5-mini": {"input": 0.25, "output": 2.0},
        "gpt-4.1": {"input": 2.50, "output": 10.0},
        "gpt-4o": {"input": 2.50, "output": 10.0},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    },
    "google": {
        "gemini-3-pro": {"input": 2.0, "output": 12.0},
        "gemini-3-flash": {"input": 0.30, "output": 1.20},
        "gemini-2.5-pro": {"input": 1.25, "output": 5.0},
        "gemini-2.5-flash": {"input": 0.15, "output": 0.60},
    },
    "xai": {
        "grok-4": {"input": 5.0, "output": 15.0},
    },
    # GitHub Copilot — coding assistant billed per seat, not per token.
    # We record $0 token pricing so predictions still render without misleading cost.
    "copilot": {
        "gpt-4.1": {"input": 0.0, "output": 0.0},
        "gpt-4o": {"input": 0.0, "output": 0.0},
        "claude-sonnet-4-6": {"input": 0.0, "output": 0.0},
        "gemini-2.5-pro": {"input": 0.0, "output": 0.0},
    },
    # Windsurf (Codeium) — flat-rate seat licensing; token price ≈ 0 for estimation.
    "windsurf": {
        "windsurf-default": {"input": 0.0, "output": 0.0},
        "windsurf-premier": {"input": 0.0, "output": 0.0},
        "windsurf-cascade": {"input": 0.0, "output": 0.0},
    },
    # AWS Bedrock — pass-through pricing that mirrors underlying foundation models.
    "aws": {
        "anthropic.claude-opus-4-8": {"input": 5.0, "output": 25.0},
        "anthropic.claude-opus-4-8-v1": {"input": 5.0, "output": 25.0},
        "anthropic.claude-fable-5": {"input": 10.0, "output": 50.0},
        "anthropic.claude-opus-4-6": {"input": 5.0, "output": 25.0},
        "anthropic.claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
        "meta.llama-3.3-70b": {"input": 0.72, "output": 0.72},
    },
    # Grok — alias for xAI's provider (frontend registry names it "grok").
    "grok": {
        "grok-4": {"input": 5.0, "output": 15.0},
        "grok-2": {"input": 2.0, "output": 10.0},
        "grok-2-mini": {"input": 0.30, "output": 0.50},
    },
    # Meta (Llama API / direct) — reference pricing from Llama API preview.
    "meta": {
        "llama-3.3-70b": {"input": 0.72, "output": 0.72},
        "llama-4-maverick": {"input": 2.0, "output": 6.0},
    },
    # Cursor — proxy pricing; the user pays Cursor's flat plan, not per token.
    "cursor": {
        "cursor-default": {"input": 0.0, "output": 0.0},
    },
    "ollama": {
        "llama-3.3-70b": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.08,
        },
        "deepseek-coder-v3": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.05,
        },
        "mistral-large": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.06,
        },
        "qwen-2.5-72b": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.07,
        },
    },
    "groq": {
        "llama-3.3-70b": {"input": 0.59, "output": 0.79},
        "mixtral-8x7b": {"input": 0.24, "output": 0.24},
    },
    "together": {
        "llama-3.3-70b": {"input": 0.88, "output": 0.88},
    },
    "fireworks": {
        "llama-3.3-70b": {"input": 0.90, "output": 0.90},
    },
    "deepseek": {
        "deepseek-v3": {"input": 0.27, "output": 1.10},
        "deepseek-coder-v3": {"input": 0.14, "output": 0.28},
    },
    "mistral": {
        "mistral-large": {"input": 2.0, "output": 6.0},
        "codestral": {"input": 0.30, "output": 0.90},
    },
}


class PricingCatalog:
    """Multi-provider pricing catalog with file override support."""

    def __init__(self, catalog_path: Path | None = None) -> None:
        self._pricing: dict[str, dict[str, ModelPricing]] = {}
        self._load_defaults()
        if catalog_path and catalog_path.exists():
            self._load_from_file(catalog_path)

    def get_pricing(self, provider: str, model: str) -> ModelPricing | None:
        """Get pricing for a specific provider/model combo."""
        provider_lower = provider.lower()
        models = self._pricing.get(provider_lower, {})
        # Exact match first
        if model in models:
            return models[model]
        # Prefix match for versioned models
        for key, pricing in models.items():
            if model.startswith(key) or key.startswith(model):
                return pricing
        return None

    def calculate_cost(
        self,
        provider: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        **kwargs: int,
    ) -> float:
        """Calculate cost in USD. Returns 0.0 if model not found."""
        pricing = self.get_pricing(provider, model)
        if pricing is None:
            logger.warning(
                "No pricing found for %s/%s, defaulting to $0", provider, model
            )
            return 0.0
        return pricing.cost_for_tokens(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            **kwargs,
        )

    def list_providers(self) -> list[str]:
        return list(self._pricing.keys())

    def list_models(self, provider: str) -> list[str]:
        return list(self._pricing.get(provider.lower(), {}).keys())

    def add_pricing(self, pricing: ModelPricing) -> None:
        """Add or update a model's pricing."""
        provider = pricing.provider.lower()
        if provider not in self._pricing:
            self._pricing[provider] = {}
        self._pricing[provider][pricing.model] = pricing

    def _load_defaults(self) -> None:
        for provider, models in _DEFAULT_CATALOG.items():
            self._pricing[provider] = {}
            for model_name, prices in models.items():
                self._pricing[provider][model_name] = ModelPricing(
                    provider=provider, model=model_name, **prices
                )

    def _load_from_file(self, path: Path) -> None:
        """Override defaults from a JSON pricing file."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for provider, models in data.items():
                if provider not in self._pricing:
                    self._pricing[provider] = {}
                for model_name, prices in models.items():
                    self._pricing[provider][model_name] = ModelPricing(
                        provider=provider, model=model_name, **prices
                    )
            logger.info("Loaded pricing overrides from %s", path)
        except Exception:
            logger.exception("Failed to load pricing catalog from %s", path)
