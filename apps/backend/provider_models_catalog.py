"""Dynamic model catalog for AI providers.

Fetches the up-to-date list of available models from each provider's REST API
using the API key stored in `~/.work_pilot_ai_llm_providers.json`, applies a
strict filter to keep only chat/reasoning models relevant to phase
configuration, and caches the result on disk for 6 hours.

On any failure (no key, network down, malformed response, unsupported
provider) the module falls back to a small static catalog so the UI never
sees an empty dropdown.

Supported providers (with live fetching):
    anthropic, openai, google, mistral, deepseek, grok, ollama, windsurf

Other providers (copilot, aws, meta, custom, claude, …) get the static
catalog without a live fetch.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

try:
    from .models_registry import ModelEntry, list_provider
except ImportError:
    # Module is imported as a top-level "provider_models_catalog" (no package
    # context), e.g. by provider_api.py when apps/backend is on sys.path.
    from models_registry import ModelEntry, list_provider  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cache configuration
# ---------------------------------------------------------------------------

CACHE_PATH = Path.home() / ".work_pilot_ai_model_cache.json"
CACHE_TTL_SECONDS = 24 * 60 * 60  # 24 hours — refresh manually for sooner updates
HTTP_TIMEOUT = httpx.Timeout(8.0, connect=4.0)


# ---------------------------------------------------------------------------
# Static fallback catalog (generated from models_registry, last-resort only)
# ---------------------------------------------------------------------------


def _to_catalog_entry(entry: ModelEntry) -> dict[str, Any]:
    """Convert a ModelEntry to catalog dict format."""
    result: dict[str, Any] = {
        "value": entry.model_id,
        "label": entry.label,
        "tier": entry.tier,
    }
    if entry.supports_thinking:
        result["supportsThinking"] = True
    return result


def _build_static_fallback() -> dict[str, list[dict[str, Any]]]:
    """Generate STATIC_FALLBACK from registry."""
    result: dict[str, list[dict[str, Any]]] = {}
    for provider in [
        "anthropic",
        "openai",
        "google",
        "mistral",
        "deepseek",
        "grok",
        "meta",
        "ollama",
        "windsurf",
        "aws",
        "copilot",
        "cursor",
    ]:
        entries = list_provider(provider)
        result[provider] = [_to_catalog_entry(e) for e in entries]
    return result


STATIC_FALLBACK: dict[str, list[dict[str, Any]]] = _build_static_fallback()

# Aliases — providers that share a catalog
STATIC_FALLBACK["claude"] = STATIC_FALLBACK.get("anthropic", [])


# ---------------------------------------------------------------------------
# Filtering rules — strict allow-list per provider
# ---------------------------------------------------------------------------

# OpenAI: modern chat / reasoning families (May 2026: GPT-5.5, GPT-5.2, GPT-5,
# o-series). Excludes embeddings, TTS, Whisper, image, moderations, gpt-3.5,
# gpt-4-turbo, search/transcribe/realtime variants.
_OPENAI_KEEP = re.compile(
    r"^(gpt-5(\.\d)?|gpt-4\.1|o[34]|chatgpt-4o)(-|$)", re.IGNORECASE
)
_OPENAI_DROP = re.compile(
    r"(embedding|whisper|tts|dall-?e|moderation|audio|realtime|transcribe|search|image"
    # Drop dated snapshots like "gpt-5-2025-08-07" — keep only stable aliases.
    r"|-\d{4}-\d{2}-\d{2}$"
    # Drop niche aliases the user shouldn't pick from a generic dropdown.
    r"|chat-latest|codex)",
    re.IGNORECASE,
)

# Anthropic: only Claude 4.x and 3.7 (reasoning-capable lineage)
_ANTHROPIC_KEEP = re.compile(r"^claude-(opus-4|sonnet-4|haiku-4|3-7)", re.IGNORECASE)

# Mistral: large/medium/small + magistral (reasoning) + devstral (coding) + pixtral-large.
# Exclude embed/moderation/OCR/audio (voxtral)/edge variants.
_MISTRAL_KEEP = re.compile(
    r"^(mistral-(large|medium|small)|magistral|devstral|codestral|pixtral-large)",
    re.IGNORECASE,
)
_MISTRAL_DROP = re.compile(
    r"(embed|moderation|ocr|voxtral|saba|nemo|tiny|ministral|7b|8x7b|8x22b)",
    re.IGNORECASE,
)

# DeepSeek: chat / reasoner / v3+ families
_DEEPSEEK_KEEP = re.compile(r"^deepseek-(chat|reasoner|v\d)", re.IGNORECASE)

# Grok: grok-3+ (covers grok-3, grok-4, grok-4.1, grok-4.3, grok-4.20, …)
_GROK_KEEP = re.compile(r"^grok-([3-9]|\d{2,})", re.IGNORECASE)
_GROK_DROP = re.compile(
    r"(image|imagine|vision-beta|legacy|fast-beta|speech|tts)", re.IGNORECASE
)

# Gemini: 2.5+ pro/flash/flash-lite (covers 3.x). Allow trailing -preview /
# -latest / dated suffixes, drop image/audio/embedding/vision-only variants.
_GEMINI_KEEP = re.compile(
    r"^models/gemini-(2\.5|3\.\d|[4-9])[\w.-]*$",
    re.IGNORECASE,
)
_GEMINI_DROP = re.compile(
    r"(image|tts|embedding|audio|nano-banana|live|vision-only)",
    re.IGNORECASE,
)


def _tier_for_label(label: str) -> str:
    low = label.lower()
    if any(
        k in low
        for k in ("nano", "haiku", "flash-lite", "small", "mini", "fast", "lite")
    ):
        return "fast"
    if any(
        k in low
        for k in (
            "opus",
            "ultra",
            "pro",
            "large",
            "reasoner",
            "magistral",
            "devstral",
            "o3",
            "o4",
            "gpt-5",
            "grok-4",
            "claude-opus",
            "v4",
            "3.1-pro",
            "3-pro",
        )
    ):
        return "flagship"
    return "standard"


def _supports_thinking(provider: str, value: str) -> bool:
    v = value.lower()
    if provider in ("anthropic", "claude"):
        return "opus-4" in v or "sonnet-4" in v or "3-7" in v
    if provider == "openai":
        return v.startswith(("o3", "o4", "gpt-5"))
    if provider in ("google", "gemini"):
        # Gemini 2.5+ all support extended thinking ("Deep Think")
        return "2.5" in v or "3." in v or v.startswith("models/gemini-3")
    if provider == "deepseek":
        return "reasoner" in v or "v4" in v
    if provider == "grok":
        return v.startswith("grok-") and not v.startswith(("grok-1", "grok-2"))
    if provider == "mistral":
        return "magistral" in v
    return False


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _read_cache() -> dict[str, Any]:
    if not CACHE_PATH.exists():
        return {}
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("Could not read model cache: %s", e)
        return {}


def _write_cache(data: dict[str, Any]) -> None:
    try:
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except OSError as e:
        logger.warning("Could not write model cache: %s", e)


def _cached_entry(provider: str) -> dict[str, Any] | None:
    cache = _read_cache()
    entry = cache.get(provider)
    if not entry:
        return None
    fetched_at = entry.get("fetched_at", 0)
    if time.time() - fetched_at > CACHE_TTL_SECONDS:
        return None
    return entry


def _store_cache_entry(provider: str, models: list[dict[str, Any]]) -> None:
    cache = _read_cache()
    cache[provider] = {"fetched_at": time.time(), "models": models}
    _write_cache(cache)


# ---------------------------------------------------------------------------
# Per-provider live fetchers
# ---------------------------------------------------------------------------


def _api_key_for(provider: str) -> str | None:
    """Return the stored API key for `provider`, or None."""
    # Local import to avoid heavy import chain at module load
    try:
        from src.connectors.llm_config import load_provider_config
    except Exception as e:  # noqa: BLE001
        logger.debug("llm_config unavailable: %s", e)
        return None
    cfg = load_provider_config(provider) or {}
    key = cfg.get("api_key") or os.environ.get(f"{provider.upper()}_API_KEY")
    return key.strip() if isinstance(key, str) and key.strip() else None


def _fetch_anthropic() -> list[dict[str, Any]]:
    key = _api_key_for("anthropic") or _api_key_for("claude")
    if not key:
        return []
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get("https://api.anthropic.com/v1/models", headers=headers)
    resp.raise_for_status()
    items = resp.json().get("data", [])
    out: list[dict[str, Any]] = []
    for it in items:
        mid = it.get("id", "")
        if not _ANTHROPIC_KEEP.search(mid):
            continue
        label = it.get("display_name") or mid
        out.append(
            {
                "value": mid,
                "label": label,
                "tier": _tier_for_label(label),
                "supportsThinking": _supports_thinking("anthropic", mid),
            }
        )
    return out


def _fetch_openai() -> list[dict[str, Any]]:
    key = _api_key_for("openai")
    if not key:
        return []
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {key}"},
        )
    resp.raise_for_status()
    items = resp.json().get("data", [])
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items:
        mid = it.get("id", "")
        if mid in seen:
            continue
        if _OPENAI_DROP.search(mid):
            continue
        if not _OPENAI_KEEP.match(mid):
            continue
        # Skip dated snapshots when an undated alias likely exists; OpenAI API
        # actually returns both — we keep both so users can pin a snapshot.
        seen.add(mid)
        out.append(
            {
                "value": mid,
                "label": _humanize_openai(mid),
                "tier": _tier_for_label(mid),
                "supportsThinking": _supports_thinking("openai", mid),
            }
        )
    out.sort(key=lambda m: _openai_sort_key(m["value"]))
    return out


def _humanize_openai(mid: str) -> str:
    """Pretty-print OpenAI model IDs:
    - gpt-5            → "GPT-5"
    - gpt-5.5          → "GPT-5.5"
    - gpt-5.5-pro      → "GPT-5.5 Pro"
    - gpt-5.5-mini     → "GPT-5.5 mini"
    - gpt-4.1-nano     → "GPT-4.1 nano"
    - o4-mini          → "o4-mini"
    - chatgpt-4o-latest → "ChatGPT-4o (latest)"
    """
    if mid.startswith("gpt-"):
        rest = mid[len("gpt-") :]
        # split on the first '-' to separate version from suffix
        if "-" in rest:
            version, suffix = rest.split("-", 1)
            suffix_pretty = (
                suffix.replace("pro", "Pro")
                .replace("mini", "mini")
                .replace("nano", "nano")
            )
            return f"GPT-{version} {suffix_pretty}"
        return f"GPT-{rest}"
    if mid.startswith("chatgpt-"):
        return "Chat" + mid[4:].upper().replace("-", " ", 1)
    return mid


def _openai_sort_key(mid: str) -> tuple[int, str]:
    """Order so the most capable / most recent appears first."""
    # Higher GPT version → smaller sort index
    if mid.startswith("gpt-5.5"):
        return (0, mid)
    if mid.startswith("gpt-5.2"):
        return (1, mid)
    if mid.startswith("gpt-5"):
        return (2, mid)
    family_order = {"o4": 3, "o3": 4, "gpt-4.1": 5, "chatgpt-4o": 6}
    for prefix, order in family_order.items():
        if mid.startswith(prefix):
            return (order, mid)
    return (99, mid)


def _fetch_google() -> list[dict[str, Any]]:
    key = _api_key_for("google") or _api_key_for("gemini")
    if not key:
        return []
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params={"key": key},
        )
    resp.raise_for_status()
    items = resp.json().get("models", [])
    out: list[dict[str, Any]] = []
    for it in items:
        name = it.get("name", "")  # "models/gemini-3.1-pro"
        if not _GEMINI_KEEP.match(name):
            continue
        if _GEMINI_DROP.search(name):
            continue
        methods = it.get("supportedGenerationMethods", [])
        if "generateContent" not in methods:
            continue
        mid = name.split("/", 1)[1]
        # Drop preview snapshots when a stable counterpart exists in the same response.
        label = it.get("displayName") or mid
        out.append(
            {
                "value": mid,
                "label": label,
                "tier": _tier_for_label(mid),
                "supportsThinking": _supports_thinking("google", mid),
            }
        )
    return out


def _fetch_openai_compatible(
    provider: str,
    base_url: str,
    keep: re.Pattern[str],
    drop: re.Pattern[str] | None = None,
) -> list[dict[str, Any]]:
    key = _api_key_for(provider)
    if not key:
        return []
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(
            f"{base_url.rstrip('/')}/v1/models",
            headers={"Authorization": f"Bearer {key}"},
        )
    resp.raise_for_status()
    items = resp.json().get("data", [])
    out: list[dict[str, Any]] = []
    for it in items:
        mid = it.get("id", "")
        if drop and drop.search(mid):
            continue
        if not keep.search(mid):
            continue
        out.append(
            {
                "value": mid,
                "label": mid,
                "tier": _tier_for_label(mid),
                "supportsThinking": _supports_thinking(provider, mid),
            }
        )
    return out


def _fetch_mistral() -> list[dict[str, Any]]:
    return _fetch_openai_compatible(
        "mistral", "https://api.mistral.ai", _MISTRAL_KEEP, _MISTRAL_DROP
    )


def _fetch_deepseek() -> list[dict[str, Any]]:
    return _fetch_openai_compatible(
        "deepseek", "https://api.deepseek.com", _DEEPSEEK_KEEP
    )


def _fetch_grok() -> list[dict[str, Any]]:
    return _fetch_openai_compatible("grok", "https://api.x.ai", _GROK_KEEP, _GROK_DROP)


def _local_llm_root() -> str:
    """Resolve the local LLM server root (no path), honouring env + saved config.

    Covers any OpenAI-compatible local server: Ollama (11434), LM Studio (1234),
    llama.cpp, vLLM, LocalAI. Falls back to the Ollama default.
    """
    root = (
        os.environ.get("OLLAMA_BASE_URL")
        or os.environ.get("LOCAL_LLM_BASE_URL")
        or os.environ.get("LMSTUDIO_BASE_URL")
    )
    if not root:
        try:
            from src.connectors.llm_config import load_provider_config

            cfg = load_provider_config("ollama") or load_provider_config("local") or {}
            root = cfg.get("base_url")
        except Exception:  # noqa: BLE001
            root = None
    root = (root or "http://localhost:11434").strip().rstrip("/")
    # Strip an OpenAI-style suffix so we have the bare server root.
    if root.endswith("/chat/completions"):
        root = root[: -len("/chat/completions")].rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")].rstrip("/")
    return root


def _fetch_ollama() -> list[dict[str, Any]]:
    """List models from any OpenAI-compatible local server.

    Tries the OpenAI-compatible ``/v1/models`` endpoint first (works for LM
    Studio *and* Ollama), then falls back to Ollama's native ``/api/tags``.
    """
    root = _local_llm_root()

    # Tag each model with tool-calling support (hide non-tool models) and its
    # parameter size (warn that a small model is weak for planning).
    from ollama_model_detector import model_meta

    def _entry(name: str) -> dict[str, Any]:
        meta = model_meta(root, name)
        return {
            "value": name,
            "label": name,
            "tier": "local",
            "supports_tools": meta["supports_tools"],
            "param_b": meta["param_b"],
        }

    # 1) OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp, Ollama ≥ /v1)
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.get(f"{root}/v1/models")
        resp.raise_for_status()
        items = resp.json().get("data", [])
        out: list[dict[str, Any]] = [
            _entry(it.get("id", "")) for it in items if it.get("id")
        ]
        if out:
            return out
    except (httpx.HTTPError, OSError, ValueError, KeyError):
        pass

    # 2) Ollama-native endpoint
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.get(f"{root}/api/tags")
        resp.raise_for_status()
    except (httpx.HTTPError, OSError):
        return []
    items = resp.json().get("models", [])
    return [_entry(it.get("name", "")) for it in items if it.get("name")]


def _fetch_windsurf() -> list[dict[str, Any]]:
    """Windsurf has no public REST endpoint; the catalog of routable models
    is curated server-side via the Codeium gRPC API. We currently rely on
    the static fallback for this provider — kept here as a no-op so the
    dispatcher treats it uniformly."""
    return []


_FETCHERS = {
    "anthropic": _fetch_anthropic,
    "claude": _fetch_anthropic,
    "openai": _fetch_openai,
    "google": _fetch_google,
    "gemini": _fetch_google,
    "mistral": _fetch_mistral,
    "deepseek": _fetch_deepseek,
    "grok": _fetch_grok,
    "ollama": _fetch_ollama,
    "windsurf": _fetch_windsurf,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_models(provider: str, *, force_refresh: bool = False) -> dict[str, Any]:
    """Return the model list for `provider` with provenance metadata.

    Returns a dict::

        {
            "provider": str,
            "models": [{"value", "label", "tier", "supportsThinking"?}, …],
            "source": "live" | "cache" | "static",
            "fetchedAt": float | None,    # epoch seconds when source=cache/live
            "error": str | None,          # populated when fetch failed
        }
    """
    provider = (provider or "").lower()

    # Local servers (Ollama / LM Studio / …) change their installed-model list
    # frequently and answer instantly, so a 24h-cached list goes stale and shows
    # the wrong "installed" set. Always fetch them live and never fall back to a
    # stale cache for them.
    is_local = provider in {"ollama", "local", "lmstudio"}
    if is_local:
        force_refresh = True

    # 1) Cache hit, unless force_refresh
    if not force_refresh:
        cached = _cached_entry(provider)
        if cached:
            return {
                "provider": provider,
                "models": cached.get("models", []),
                "source": "cache",
                "fetchedAt": cached.get("fetched_at"),
                "error": None,
            }

    # 2) Try live fetch
    fetcher = _FETCHERS.get(provider)
    error: str | None = None
    if fetcher is not None:
        try:
            models = fetcher()
            if models:
                _store_cache_entry(provider, models)
                return {
                    "provider": provider,
                    "models": models,
                    "source": "live",
                    "fetchedAt": time.time(),
                    "error": None,
                }
        except httpx.HTTPStatusError as e:
            error = f"HTTP {e.response.status_code}"
            logger.warning("Live model fetch failed for %s: %s", provider, error)
        except (httpx.HTTPError, ValueError, KeyError) as e:
            error = type(e).__name__
            logger.warning("Live model fetch failed for %s: %s", provider, e)

    # 3) Stale cache (better than nothing) — but never for local providers, where
    # a stale list would falsely mark uninstalled models as installed.
    cache = None if is_local else _read_cache().get(provider)
    if cache and cache.get("models"):
        return {
            "provider": provider,
            "models": cache["models"],
            "source": "cache",
            "fetchedAt": cache.get("fetched_at"),
            "error": error,
        }

    # 4) Static fallback
    return {
        "provider": provider,
        "models": STATIC_FALLBACK.get(provider, []),
        "source": "static",
        "fetchedAt": None,
        "error": error,
    }
