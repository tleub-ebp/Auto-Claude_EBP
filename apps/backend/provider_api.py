# IMPORTANT : La liste des providers LLM doit être centralisée dans configured_providers.json à la racine du projet.
# Ce fichier est la source unique de vérité pour le frontend ET le backend.
# Toute modification doit être faite dans ce fichier uniquement.

import logging
import sys
from contextlib import asynccontextmanager

# Windows: force the Proactor event-loop policy BEFORE anything else creates
# a loop. uvicorn (especially with --reload) defaults to the Selector loop on
# Python ≥ 3.8, which raises NotImplementedError on `asyncio.create_subprocess_exec`.
# The Claude Agent SDK spawns the bundled `claude.exe` via subprocess, so the
# /api/slash-commands/run endpoint (and any future SDK-backed endpoint) would
# fail with "Failed to start Claude Code" without this fix.
# Safe no-op on Linux/macOS where the policy attribute doesn't exist.
if sys.platform == "win32":
    import asyncio as _asyncio

    _policy_cls = getattr(_asyncio, "WindowsProactorEventLoopPolicy", None)
    if _policy_cls is not None:
        _asyncio.set_event_loop_policy(_policy_cls())

logging.basicConfig(level=logging.INFO, stream=sys.stdout, force=True)

# Install the global log redaction filter as early as possible — before
# any module logs anything sensitive at import time. Idempotent.
try:
    from core.log_redaction import install_global_redaction

    install_global_redaction()
except Exception as _e:  # noqa: BLE001 — never block boot on this
    logging.getLogger(__name__).warning("Could not install log redaction: %s", _e)

import ipaddress
import json
import os
import socket
import threading
from typing import Annotated, Any
from urllib.parse import urlparse

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../")))

from apps.backend.models_registry import get_default

# Import specific exception for provider validation failures
try:
    from integrations.graphiti.providers_pkg.exceptions import ProviderError
except ImportError:
    # Fallback if the module is not available
    class ProviderError(Exception):
        """Raised when a provider cannot be initialized or validated."""

        pass


# Constants
PROVIDER_CONFIG_NOT_FOUND = "Provider config not found"
PROVIDER_CLASS_NOT_FOUND = "Provider class not found"
API_KEY_VALIDATION_FAILED_INVALID = "API key validation failed: invalid key"
API_KEY_VALIDATION_FAILED_ERROR = "API key validation failed: {e}"
HOOK_NOT_FOUND = "Hook not found"
PROMPT_REQUIRED = "Prompt is required"
PROVIDER_TEST_FAILED = "Provider test failed: {e}"
GENERATION_FAILED = "Generation failed: {e}"
TEMPLATE_NOT_FOUND = "Template not found"
GITHUB_CLI_AUTH_SUCCESS = "Logged in to github.com"
API_MODELS_ENDPOINT = "/v1/models"

# Default HTTP timeout (seconds) applied as a safety net to every AsyncClient.
# Individual requests may still override with their own `timeout=` kwarg.
DEFAULT_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

logger = logging.getLogger(__name__)


def _safe_error_message(e: Exception) -> str:
    """Return a safe error message without exposing internal stack traces."""
    logger.error("Operation failed: %s: %s", type(e).__name__, e)
    # Map known exception types to safe user-facing messages
    _SAFE_MESSAGES: dict[type, str] = {
        TimeoutError: "Request timed out",
        ConnectionError: "Connection failed",
        PermissionError: "Permission denied",
        FileNotFoundError: "Resource not found",
        ValueError: "Invalid input",
        KeyError: "Missing required field",
        OSError: "System error",
    }
    for exc_type, msg in _SAFE_MESSAGES.items():
        if isinstance(e, exc_type):
            return msg
    return "An unexpected error occurred"


# SSRF Protection - Authorized URLs list
AUTHORIZED_URLS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com",
    "google": "https://generativelanguage.googleapis.com",
    "mistral": "https://api.mistral.ai",
    "deepseek": "https://api.deepseek.com",
    "grok": "https://api.x.ai",
    "meta": "https://api.together.xyz",
    "cursor": "https://api.cursor.com",
    "windsurf": "https://server.codeium.com",
}

# Private IP ranges for SSRF protection
PRIVATE_IP_RANGES = [
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv6Network("::1/128"),
    ipaddress.IPv6Network("fc00::/7"),
    ipaddress.IPv6Network("fe80::/10"),
]


# Lazy import: llm_discovery is only needed by endpoint functions, not at module init.
# Importing it eagerly breaks other modules (agent_runner, client) that import
# provider_api just for get_selected_provider() but don't have src.connectors on sys.path.
def get_provider_by_name(name: str):
    from src.connectors.llm_discovery import (
        get_provider_by_name as _get_provider_by_name,
    )

    return _get_provider_by_name(name)


# Lazy imports for llm_config functions (same reason as llm_discovery above)
def _get_llm_config():
    from src.connectors.llm_config import (
        delete_provider_config,
        force_claude_provider_config,
        list_provider_configs,
        load_provider_config,
        save_provider_config,
    )

    return {
        "save_provider_config": save_provider_config,
        "load_provider_config": load_provider_config,
        "delete_provider_config": delete_provider_config,
        "list_provider_configs": list_provider_configs,
        "force_claude_provider_config": force_claude_provider_config,
    }


def save_provider_config(*args, **kwargs):
    return _get_llm_config()["save_provider_config"](*args, **kwargs)


def load_provider_config(*args, **kwargs):
    return _get_llm_config()["load_provider_config"](*args, **kwargs)


def delete_provider_config(*args, **kwargs):
    return _get_llm_config()["delete_provider_config"](*args, **kwargs)


def list_provider_configs(*args, **kwargs):
    return _get_llm_config()["list_provider_configs"](*args, **kwargs)


def force_claude_provider_config(*args, **kwargs):
    return _get_llm_config()["force_claude_provider_config"](*args, **kwargs)


from validated_keys_db import is_validated, set_validated


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan without WebSocket server to prevent blocking issues."""
    # WebSocket disabled temporarily due to connection issues
    # Updated to websockets v16.0 which resolves handshake problems
    # WebSocket is now handled separately in websocket_server.py

    # Initialize analytics database
    try:
        from analytics import init_database

        init_database()
        logging.getLogger(__name__).info("Analytics database initialized")
    except Exception as e:
        logging.getLogger(__name__).warning(
            f"Could not initialize analytics database: {e}"
        )

    logging.getLogger(__name__).debug(
        "Backend started without WebSocket (disabled for stability)"
    )

    yield


app = FastAPI(lifespan=lifespan)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_ALLOWED_ORIGINS = [
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "app://.",  # Electron custom protocol
    "file://",  # Electron file:// protocol
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Accept-Language",
        "Authorization",
        "Content-Type",
        "Content-Language",
        "X-Requested-With",
        "X-Provider",
    ],
)

# Global variable to store selected provider (ContextVar doesn't work across HTTP requests)
_selected_provider: str | None = None
_provider_lock = threading.Lock()


def _get_anthropic_token() -> str | None:
    """Get the first available Anthropic auth token from env or system keyring."""
    token = (
        os.getenv("ANTHROPIC_API_KEY")
        or os.getenv("CLAUDE_CODE_OAUTH_TOKEN")
        or os.getenv("CLAUDE_API_KEY")
    )
    if not token:
        from src.connectors.llm_config import get_claude_token_from_system

        token = get_claude_token_from_system()
    return token


def _check_copilot_gh_auth() -> bool:
    """Return True if 'gh auth status' reports success."""
    import subprocess

    try:
        result = subprocess.run(
            ["gh", "auth", "status"], capture_output=True, text=True, timeout=5
        )
        return GITHUB_CLI_AUTH_SUCCESS in (result.stdout + result.stderr)
    except Exception:
        logger.debug("Failed to check GitHub Copilot auth — skipping", exc_info=True)
        return False


def get_env_provider_config(name: str) -> dict | None:
    # Anthropic / Claude
    if name in ("claude", "anthropic"):
        token = os.getenv("ANTHROPIC_API_KEY")
        if not token:
            from src.connectors.llm_config import get_claude_token_from_system

            token = get_claude_token_from_system()
        if token:
            default_model = get_default("anthropic")
            model_id = default_model.model_id if default_model else "claude-opus-4-7"
            return {"api_key": token, "model": model_id}
        return None

    # OpenAI
    if name == "openai" and os.getenv("OPENAI_API_KEY"):
        default_model = get_default("openai")
        model_id = default_model.model_id if default_model else "gpt-5.5"
        return {
            "api_key": os.getenv("OPENAI_API_KEY"),
            "model": model_id,
            "base_url": os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        }

    # Google Gemini
    if name == "google" and os.getenv("GOOGLE_API_KEY"):
        default_model = get_default("google")
        model_id = default_model.model_id if default_model else "gemini-3.1-pro"
        return {"api_key": os.getenv("GOOGLE_API_KEY"), "model": model_id}

    # Mistral AI
    if name == "mistral" and os.getenv("MISTRAL_API_KEY"):
        default_model = get_default("mistral")
        model_id = default_model.model_id if default_model else "mistral-large-3"
        return {
            "api_key": os.getenv("MISTRAL_API_KEY"),
            "model": model_id,
            "base_url": os.getenv("MISTRAL_BASE_URL", "https://api.mistral.ai/v1"),
        }

    # DeepSeek
    if name == "deepseek" and os.getenv("DEEPSEEK_API_KEY"):
        default_model = get_default("deepseek")
        model_id = default_model.model_id if default_model else "deepseek-v4"
        return {
            "api_key": os.getenv("DEEPSEEK_API_KEY"),
            "model": model_id,
            "base_url": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        }

    # Grok (xAI)
    if name == "grok" and os.getenv("GROK_API_KEY"):
        default_model = get_default("grok")
        model_id = default_model.model_id if default_model else "grok-4.3"
        return {"api_key": os.getenv("GROK_API_KEY"), "model": model_id}

    # Meta (LLaMA) — via Together AI or Replicate
    if name == "meta" and os.getenv("META_API_KEY"):
        default_model = get_default("meta")
        model_id = (
            default_model.model_id if default_model else "meta-llama/llama-4-scout"
        )
        return {
            "api_key": os.getenv("META_API_KEY"),
            "model": model_id,
            "base_url": os.getenv("META_BASE_URL", "https://api.together.xyz/v1"),
        }

    # AWS Bedrock
    if name == "aws":
        access_key = os.getenv("AWS_ACCESS_KEY_ID")
        secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        if access_key and secret_key:
            default_model = get_default("aws")
            model_id = (
                default_model.model_id if default_model else "anthropic.claude-opus-4-7"
            )
            return {
                "api_key": access_key,
                "secret_key": secret_key,
                "region": os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
                "model": model_id,
            }
        return None

    # Ollama (local)
    if name == "ollama":
        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        # Reject schemes other than http/https before opening the URL —
        # otherwise urlopen would happily handle file://, ftp://, etc.,
        # and the env var is operator-supplied, not constant.
        try:
            parsed = urlparse(base_url)
        except Exception:
            logger.debug("Failed to parse Ollama base URL — skipping", exc_info=True)
            return None
        if parsed.scheme not in ("http", "https"):
            logger.debug("Refusing Ollama probe to non-http(s) URL: %s", base_url)
            return None
        # Vérifier si Ollama est accessible
        try:
            import urllib.request

            req = urllib.request.Request(f"{base_url}/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=2):  # noqa: S310 — scheme validated above
                return {"model": "llama3.3", "base_url": base_url}
        except Exception as e:
            logger.debug("Ollama availability check failed at %s: %s", base_url, e)
        return None

    # GitHub Copilot (gh CLI)
    if name == "copilot":
        if _check_copilot_gh_auth():
            return {"authenticated": True, "model": "gpt-4o"}
        return None

    # Windsurf (Codeium)
    if name == "windsurf":
        token = (
            os.getenv("WINDSURF_API_KEY")
            or os.getenv("WINDSURF_OAUTH_TOKEN")
            or os.getenv("CODEIUM_API_KEY")
        )
        if token:
            return {"api_key": token, "model": "swe-1.6-fast"}
        return None

    # Cursor
    if name == "cursor" and os.getenv("CURSOR_API_KEY"):
        return {
            "api_key": os.getenv("CURSOR_API_KEY"),
            "model": "cursor-default",
            "base_url": os.getenv("CURSOR_BASE_URL", "https://api.cursor.com/v1"),
        }

    return None


# Correction de la détection dynamique : n'afficher que les providers réellement implémentés
@app.get("/providers/{provider}/status")
def get_provider_status(provider: str):
    """Get the status of a specific provider."""
    try:
        cfg = get_env_provider_config(provider)
        if cfg is None:
            return {"available": False, "authenticated": False}

        # For Windsurf, check OAuth token specifically
        if provider == "windsurf":
            oauth_token = os.getenv("WINDSURF_OAUTH_TOKEN")
            logger.debug(
                "oauth_token present: %s", bool(oauth_token and oauth_token.strip())
            )
            return {
                "available": True,
                "authenticated": bool(oauth_token and oauth_token.strip() != ""),
                "oauth": True,
            }

        return {"available": True, "authenticated": True}
    except Exception as e:
        return {
            "available": False,
            "authenticated": False,
            "error": _safe_error_message(e),
        }


@app.get("/providers")
def get_providers():
    config_path = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "../../config/configured_providers.json"
        )
    )
    if not os.path.exists(config_path):
        providers = [
            {
                "name": "anthropic",
                "label": "Anthropic (Claude)",
                "description": "Claude, focalisé sur la sécurité et l’IA d’entreprise.",
            },
            {
                "name": "openai",
                "label": "OpenAI",
                "description": "Créateur de la série GPT (ChatGPT, GPT-4/4o/5).",
            },
            {
                "name": "google",
                "label": "Google / Google DeepMind",
                "description": "Modèles Gemini (successeur de PaLM/LaMDA).",
            },
            {
                "name": "meta",
                "label": "Meta (Facebook/Meta AI)",
                "description": "Modèles LLaMA et variantes open source.",
            },
            {
                "name": "mistral",
                "label": "Mistral AI",
                "description": "Startup française, LLM open weight et commercial.",
            },
            {
                "name": "deepseek",
                "label": "DeepSeek",
                "description": "Entreprise chinoise, agent conversationnel.",
            },
            {
                "name": "aws",
                "label": "Amazon Web Services (AWS)",
                "description": "Offre des API LLM intégrées à ses services cloud.",
            },
            {
                "name": "ollama",
                "label": "LLM local (Ollama, LM Studio, etc.)",
                "description": "Exécutez un modèle LLM localement sur votre machine (Ollama, LM Studio, etc.).",
            },
        ]
        status = {}
        for p in providers:
            name = p["name"]
            config = None
            config = get_env_provider_config(name)
            if name == "anthropic" or name == "claude":
                status[name] = bool(_get_anthropic_token())
            else:
                status[name] = bool(
                    config and (config.get("api_key") or config.get("base_url"))
                )
        return {"providers": providers, "status": status}
    # Si le fichier existe, on garde la logique mixte
    with open(config_path, encoding="utf-8") as f:
        data = json.load(f)
    providers = data.get("providers", [])
    from src.connectors.llm_config import load_all_provider_configs

    all_configs = load_all_provider_configs()
    status = {}
    for p in providers:
        name = p["name"]
        provider_configs = [cfg for pname, cfg in all_configs.items() if pname == name]
        has_valid_key = any(
            cfg.get("api_key") for cfg in provider_configs if cfg.get("api_key")
        )
        has_oauth_token = any(
            cfg.get("oauth_token") for cfg in provider_configs if cfg.get("oauth_token")
        )
        if name == "anthropic" or name == "claude":
            status[name] = (
                bool(_get_anthropic_token()) or has_valid_key or has_oauth_token
            )
        else:
            env_key = os.getenv(f"{name.upper()}_API_KEY")
            # For Windsurf, check OAuth token instead of API key
            if name == "windsurf":
                env_key = os.getenv("WINDSURF_OAUTH_TOKEN")
            has_valid_key = any(
                cfg.get("api_key") and str(cfg.get("api_key")).strip() != ""
                for cfg in provider_configs
            )
            # For Windsurf, also check oauth_token
            if name == "windsurf":
                has_valid_key = has_valid_key or any(
                    cfg.get("oauth_token") and str(cfg.get("oauth_token")).strip() != ""
                    for cfg in provider_configs
                )
            api_key = None
            for cfg in provider_configs:
                if cfg.get("api_key") and str(cfg.get("api_key")).strip() != "":
                    api_key = cfg.get("api_key")
                    break
                elif (
                    name == "windsurf"
                    and cfg.get("oauth_token")
                    and str(cfg.get("oauth_token")).strip() != ""
                ):
                    api_key = cfg.get("oauth_token")
                    break
            is_valid = False
            if api_key:
                is_valid = is_validated(name, api_key)
            # Cas spécial pour Copilot : vérifier l'authentification gh CLI
            if name == "copilot":
                status[name] = _check_copilot_gh_auth()
            else:
                status[name] = is_valid or (
                    env_key is not None and env_key.strip() != ""
                )
    return {"providers": providers, "status": status}


@app.get("/providers/configs")
def get_provider_configs():
    return {"configs": list_provider_configs()}


@app.get(
    "/providers/config/{provider}",
    responses={404: {"description": PROVIDER_CONFIG_NOT_FOUND}},
)
def get_provider_config(provider: str):
    config = load_provider_config(provider) or get_env_provider_config(provider)
    if not config:
        raise HTTPException(status_code=404, detail=PROVIDER_CONFIG_NOT_FOUND)
    return config


@app.post("/providers/config/{provider}")
def set_provider_config(provider: str, config: dict[str, Any]):
    save_provider_config(provider, config)
    return {"status": "ok"}


@app.delete("/providers/config/{provider}")
def delete_provider_config_api(provider: str):
    delete_provider_config(provider)
    return {"status": "deleted"}


@app.post("/providers/select")
def select_provider(provider: Annotated[str, Query(...)]):
    global _selected_provider
    with _provider_lock:
        _selected_provider = provider
    return {"selected": provider}


@app.get("/providers/selected")
def get_selected_provider_endpoint():
    """Get the currently selected provider."""
    return {"selected": get_selected_provider()}


def get_selected_provider() -> str | None:
    with _provider_lock:
        return _selected_provider


@app.post(
    "/providers/test/{provider}",
    responses={
        404: {"description": PROVIDER_CONFIG_NOT_FOUND},
        400: {"description": "Provider test failed"},
    },
)
@limiter.limit("5/minute")
def test_provider(request: Request, provider: str):
    config = load_provider_config(provider)
    if not config:
        raise HTTPException(status_code=404, detail=PROVIDER_CONFIG_NOT_FOUND)
    provider_cls = get_provider_by_name(provider)
    if not provider_cls:
        raise HTTPException(status_code=404, detail=PROVIDER_CLASS_NOT_FOUND)
    try:
        instance = provider_cls(**config)
        instance.connect()
        if not instance.validate():
            raise ProviderError("Validation failed")
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=PROVIDER_TEST_FAILED.format(e=e))


def validate_url_ssrf(provider: str, url: str) -> str:
    """
    Public wrapper for SSRF URL validation - intended for testing purposes.

    Args:
        provider: Provider name for authorized URL lookup
        url: User-provided URL to validate

    Returns:
        Safe, normalized URL string

    Raises:
        ValueError: If URL is invalid or potentially malicious
    """
    return _validate_url_ssrf(provider, url)


def _validate_url_ssrf(provider: str, url: str) -> str:
    """
    Validate URL against SSRF attacks using authorized URLs list and IP verification.

    Args:
        provider: Provider name for authorized URL lookup
        url: User-provided URL to validate

    Returns:
        Safe, normalized URL string

    Raises:
        ValueError: If URL is invalid or potentially malicious
    """
    if not url:
        raise ValueError("URL cannot be empty")

    try:
        parsed = urlparse(url)
    except Exception as e:
        raise ValueError(f"Invalid URL format: {e}")

    # Check scheme
    if parsed.scheme not in ("https", "http"):
        raise ValueError("Only HTTP and HTTPS schemes are allowed")

    # For HTTPS providers, enforce authorized URLs
    if provider in AUTHORIZED_URLS:
        authorized_url = AUTHORIZED_URLS[provider]
        authorized_parsed = urlparse(authorized_url)

        # Check if hostname matches authorized hostname
        if parsed.hostname != authorized_parsed.hostname:
            raise ValueError(
                f"Hostname {parsed.hostname} is not authorized for provider {provider}"
            )

        # Check if port matches authorized port (if specified)
        if (
            authorized_parsed.port
            and parsed.port
            and parsed.port != authorized_parsed.port
        ):
            raise ValueError(
                f"Port {parsed.port} is not authorized for provider {provider}"
            )

        # Rebuild safe URL with authorized scheme and host
        safe_url = f"{authorized_parsed.scheme}://{authorized_parsed.netloc}"
        return safe_url.rstrip("/")

    # For local providers (like Ollama), perform IP validation
    hostname = parsed.hostname or ""
    if hostname in ("localhost", "127.0.0.1"):
        # Allow localhost for local providers
        safe_url = f"{parsed.scheme}://{hostname}"
        if parsed.port:
            safe_url += f":{parsed.port}"
        return safe_url.rstrip("/")

    # For any other hostname, perform IP address validation.
    #
    # SECURITY: this code path is currently unreachable from production
    # (every caller passes a provider that is in AUTHORIZED_URLS). It
    # exists for future custom-provider support and via the public
    # wrapper. We resolve ALL addresses (not just the first IPv4) to
    # close the multi-record DNS rebinding loophole, and we pin the
    # validated IP into the returned URL so the HTTP client cannot
    # re-resolve to a different address between validation and use.
    try:
        # getaddrinfo returns every A/AAAA record so an attacker cannot
        # hide a private IP behind a multi-record response (the previous
        # gethostbyname call only saw one).
        infos = socket.getaddrinfo(
            hostname, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        raise ValueError(f"Unable to resolve hostname: {hostname}")

    if not infos:
        raise ValueError(f"No addresses resolved for hostname: {hostname}")

    resolved_ips: list[str] = []
    for info in infos:
        family, _, _, _, sockaddr = info
        ip_str = sockaddr[0]
        try:
            if family == socket.AF_INET6:
                ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address = (
                    ipaddress.IPv6Address(ip_str.split("%", 1)[0])
                )
            else:
                ip_obj = ipaddress.IPv4Address(ip_str)
        except ipaddress.AddressValueError as exc:
            raise ValueError(f"Invalid resolved address {ip_str!r}: {exc}")

        # Reject ANY private/loopback/link-local/multicast/reserved address
        # — covers the explicit PRIVATE_IP_RANGES list AND the broader
        # ipaddress library checks (e.g., 0.0.0.0/8, IPv6 fc00::/7 already
        # listed, multicast, reserved blocks).
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            raise ValueError(
                f"Resolved IP {ip_str} is in a non-routable / private "
                f"range and is not allowed"
            )
        for private_range in PRIVATE_IP_RANGES:
            if ip_obj in private_range:
                raise ValueError(
                    f"Resolved IP {ip_str} is in private range and not allowed"
                )
        resolved_ips.append(ip_str)

    # Defense against DNS rebinding: return the URL with the literal IP
    # we just validated, NOT the hostname. The HTTP client therefore
    # cannot re-resolve the hostname to a different address between
    # validation and connection. Bracket IPv6 literals.
    pinned = resolved_ips[0]
    if ":" in pinned:
        host_part = f"[{pinned}]"
    else:
        host_part = pinned
    if parsed.port:
        netloc = f"{host_part}:{parsed.port}"
    else:
        netloc = host_part
    return f"{parsed.scheme}://{netloc}".rstrip("/")


def _validate_openai_base_url(base_url: str | None) -> str:
    """
    Validate a user-provided OpenAI base URL to prevent SSRF.

    Returns a safe base URL string or raises ValueError if invalid.
    """
    # Default official OpenAI API endpoint when no base_url is provided.
    if not base_url:
        return "https://api.openai.com"

    try:
        return _validate_url_ssrf("openai", base_url)
    except ValueError as e:
        raise ValueError(f"Invalid OpenAI base URL: {e}")


@app.post("/providers/test-key/{provider}")
@limiter.limit("5/minute")
async def test_provider_api_key(request: Request, provider: str, payload: dict):
    """Test an API key for any supported provider."""
    api_key = payload.get("api_key")
    base_url = payload.get("base_url")

    async def _test_bearer(url: str, key: str, provider: str) -> dict:
        """Helper: test a Bearer-authenticated API_MODELS_ENDPOINT endpoint."""
        try:
            headers = {"Authorization": f"Bearer {key}"}
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                resp = await client.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                set_validated(provider, key, True)
                return {"success": True}
            set_validated(provider, key, False)
            return {"success": False, "error": resp.text}
        except Exception as e:
            set_validated(provider, key, False)
            return {"success": False, "error": _safe_error_message(e)}

    # --- Anthropic ---
    if provider in ("anthropic", "claude"):
        try:
            # Use authorized URL for Anthropic
            safe_url = (
                _validate_url_ssrf("anthropic", "https://api.anthropic.com")
                + API_MODELS_ENDPOINT
            )
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                resp = await client.get(safe_url, headers=headers, timeout=10)
            if resp.status_code in (200, 403):
                set_validated(provider, api_key, True)
                return {"success": True}
            set_validated(provider, api_key, False)
            return {"success": False, "error": resp.text}
        except Exception as e:
            set_validated(provider, api_key, False)
            return {"success": False, "error": _safe_error_message(e)}

    # --- OpenAI ---
    if provider == "openai":
        try:
            safe_base_url = _validate_openai_base_url(base_url)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=_safe_error_message(e))
        url = safe_base_url + API_MODELS_ENDPOINT
        return await _test_bearer(url, api_key, provider)

    # --- Google Gemini ---
    if provider == "google":
        try:
            safe_url = (
                _validate_url_ssrf(
                    "google", "https://generativelanguage.googleapis.com"
                )
                + API_MODELS_ENDPOINT
            )
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                resp = await client.get(f"{safe_url}?key={api_key}", timeout=10)
            if resp.status_code == 200:
                set_validated(provider, api_key, True)
                return {"success": True}
            set_validated(provider, api_key, False)
            return {"success": False, "error": resp.text}
        except Exception as e:
            set_validated(provider, api_key, False)
            return {"success": False, "error": _safe_error_message(e)}

    # --- Mistral AI ---
    if provider == "mistral":
        try:
            safe_base_url = _validate_url_ssrf(
                "mistral", base_url or "https://api.mistral.ai"
            )
            url = safe_base_url + API_MODELS_ENDPOINT
            return await _test_bearer(url, api_key, provider)
        except ValueError as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- DeepSeek ---
    if provider == "deepseek":
        try:
            safe_base_url = _validate_url_ssrf(
                "deepseek", base_url or "https://api.deepseek.com"
            )
            url = safe_base_url + API_MODELS_ENDPOINT
            return await _test_bearer(url, api_key, provider)
        except ValueError as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- Grok (xAI) ---
    if provider == "grok":
        try:
            safe_url = (
                _validate_url_ssrf("grok", "https://api.x.ai") + API_MODELS_ENDPOINT
            )
            return await _test_bearer(safe_url, api_key, provider)
        except ValueError as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- Meta (via Together AI / Replicate — OpenAI-compatible) ---
    if provider == "meta":
        try:
            safe_base_url = _validate_url_ssrf(
                "meta", base_url or "https://api.together.xyz"
            )
            url = safe_base_url + API_MODELS_ENDPOINT
            return await _test_bearer(url, api_key, provider)
        except ValueError as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- Cursor ---
    if provider == "cursor":
        try:
            safe_base_url = _validate_url_ssrf(
                "cursor", base_url or "https://api.cursor.com"
            )
            url = safe_base_url + API_MODELS_ENDPOINT
            return await _test_bearer(url, api_key, provider)
        except ValueError as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- Windsurf (Codeium) ---
    if provider == "windsurf":
        oauth_token = payload.get("oauth_token") or payload.get("api_key")
        if not oauth_token:
            return {"success": False, "error": "OAuth token required for Windsurf"}
        try:
            from integrations.windsurf_mcp import get_windsurf_mcp

            mcp = await get_windsurf_mcp()
            status = await mcp.check_status()
            if status.get("connected", False):
                set_validated(provider, oauth_token, True)
                return {"success": True, "method": "MCP"}
        except Exception as mcp_error:
            logging.warning(f"MCP test failed, trying direct API: {mcp_error}")
        try:
            safe_url = (
                _validate_url_ssrf("windsurf", "https://server.codeium.com")
                + "/api"
                + API_MODELS_ENDPOINT
            )
            headers = {"Authorization": f"Bearer {oauth_token}"}
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                resp = await client.get(safe_url, headers=headers, timeout=10)
            if resp.status_code in [200, 404]:
                set_validated(provider, oauth_token, True)
                return {"success": True, "method": "direct_api"}
            set_validated(provider, oauth_token, False)
            return {"success": False, "error": resp.text}
        except Exception as e:
            set_validated(provider, oauth_token, False)
            return {"success": False, "error": _safe_error_message(e)}

    # --- Copilot (gh CLI auth — no API key test) ---
    if provider == "copilot":
        try:
            import asyncio

            proc = await asyncio.create_subprocess_exec(
                "gh",
                "auth",
                "status",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
                return {"success": False, "error": "GitHub CLI check timed out"}
            stdout_text = stdout.decode() if stdout else ""
            stderr_text = stderr.decode() if stderr else ""
            if GITHUB_CLI_AUTH_SUCCESS in (stdout_text + stderr_text):
                return {"success": True, "method": "gh_cli"}
            return {
                "success": False,
                "error": "GitHub CLI not authenticated. Run: gh auth login",
            }
        except Exception as e:
            return {"success": False, "error": _safe_error_message(e)}

    # --- Ollama (local — no key needed) ---
    if provider == "ollama":

        def build_ollama_url(raw_base_url: str | None) -> str:
            """
            Build a safe Ollama URL from an optional base URL.

            Only allow localhost/127.0.0.1 on the standard Ollama port.
            Fall back to the default if validation fails.
            """
            default_base = "http://localhost:11434"
            if not raw_base_url:
                return default_base + "/api/tags"

            try:
                parsed = urlparse(raw_base_url)
            except Exception:
                # Malformed URL; use safe default
                return default_base + "/api/tags"

            # Require HTTP scheme
            if parsed.scheme not in ("http",):
                return default_base + "/api/tags"

            # Only allow localhost-style hosts
            hostname = parsed.hostname or ""
            allowed_hosts = {"localhost", "127.0.0.1"}
            if hostname not in allowed_hosts:
                return default_base + "/api/tags"

            # Enforce allowed port (default 11434 if missing)
            port = parsed.port or 11434
            if port != 11434:
                return default_base + "/api/tags"

            safe_base = f"{parsed.scheme}://{hostname}:{port}"
            return safe_base + "/api/tags"

        try:
            url = build_ollama_url(base_url)
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                resp = await client.get(url, timeout=5)
            if resp.status_code == 200:
                return {"success": True}
            return {
                "success": False,
                "error": f"Ollama returned HTTP {resp.status_code}",
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Ollama not reachable: {_safe_error_message(e)}",
            }

    return {
        "success": False,
        "error": f"Provider '{provider}' non supporté pour le test",
    }


@app.get("/providers/models/{provider}")
def get_provider_models(provider: str, refresh: bool = False):
    """Returns a list of known model IDs for the given provider.

    Backed by the dynamic catalog (live API call → cache → static fallback).
    Kept as a string list for backwards compatibility with existing callers
    (App.tsx, ProviderManager.tsx, AccountForm.tsx). For the rich format
    (label, tier, supportsThinking, source provenance) use
    `/providers/models/{provider}/catalog`.
    """
    from provider_models_catalog import list_models

    catalog = list_models(provider, force_refresh=refresh)
    return {
        "models": [m["value"] for m in catalog["models"]],
        "provider": provider,
    }


@app.get("/providers/models/{provider}/catalog")
def get_provider_models_catalog(provider: str, refresh: bool = False):
    """Returns the full model catalog for `provider` with provenance.

    Response shape::

        {
            "provider": str,
            "models": [{"value", "label", "tier", "supportsThinking"?}, ...],
            "source": "live" | "cache" | "static",
            "fetchedAt": float | None,
            "error": str | None
        }
    """
    from provider_models_catalog import list_models

    return list_models(provider, force_refresh=refresh)


@app.get("/providers/capabilities/{provider}")
def get_provider_capabilities(provider: str):
    provider_cls = get_provider_by_name(provider)
    if not provider_cls:
        return {"error": "Provider not found"}
    from src.connectors.llm_config import load_provider_config

    config = load_provider_config(provider) or get_env_provider_config(provider) or {}
    try:
        instance = provider_cls(**config)
        instance.connect()
        return instance.get_capabilities()
    except Exception as e:
        return {"error": _safe_error_message(e)}


@app.get("/providers/schema/{provider}")
def get_provider_schema(provider: str):
    provider_cls = get_provider_by_name(provider)
    if not provider_cls:
        return {"error": "Provider not found"}
    from src.connectors.llm_config import load_provider_config

    config = load_provider_config(provider) or get_env_provider_config(provider) or {}
    try:
        instance = provider_cls(**config)
        return instance.get_config_schema()
    except Exception as e:
        return {"error": _safe_error_message(e)}


@app.post(
    "/providers/generate/{provider}",
    responses={
        404: {"description": PROVIDER_CONFIG_NOT_FOUND},
        400: {"description": "Generation failed"},
    },
)
@limiter.limit("30/minute")
def generate_with_provider(request: Request, provider: str, payload: dict[str, Any]):
    provider_cls = get_provider_by_name(provider)
    if not provider_cls:
        raise HTTPException(status_code=404, detail=PROVIDER_CLASS_NOT_FOUND)
    config = load_provider_config(provider)
    if not config:
        raise HTTPException(status_code=404, detail=PROVIDER_CONFIG_NOT_FOUND)
    prompt = payload.get("prompt")
    if not prompt:
        raise HTTPException(status_code=400, detail=PROMPT_REQUIRED)
    try:
        instance = provider_cls(**config)
        instance.connect()
        result = instance.generate(prompt, **payload.get("params", {}))
        return {"result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=GENERATION_FAILED.format(e=e))


# Per-provider key-validation specs. Keep this in sync with AUTHORIZED_URLS above.
# auth_style: how the API key is presented to the provider.
#   "bearer"     → Authorization: Bearer <key>
#   "x-api-key"  → x-api-key: <key>  (Anthropic-style)
#   "query"      → appended as ?key=<key> (Google-style)
# ok_statuses: status codes that count as a valid key (some providers return 403/404
#   on the models endpoint even with a valid key — that still proves auth worked).
_VALIDATION_SPECS: dict[str, dict[str, Any]] = {
    "openai": {
        "url": "https://api.openai.com" + API_MODELS_ENDPOINT,
        "auth_style": "bearer",
        "ok_statuses": (200,),
    },
    "grok": {
        "url": "https://api.x.ai" + API_MODELS_ENDPOINT,
        "auth_style": "bearer",
        "ok_statuses": (200,),
    },
    "anthropic": {
        "url": "https://api.anthropic.com" + API_MODELS_ENDPOINT,
        "auth_style": "x-api-key",
        "ok_statuses": (200, 403),
        "extra_headers": {"anthropic-version": "2023-06-01"},
    },
    "claude": {
        "url": "https://api.anthropic.com" + API_MODELS_ENDPOINT,
        "auth_style": "x-api-key",
        "ok_statuses": (200, 403),
        "extra_headers": {"anthropic-version": "2023-06-01"},
    },
    "google": {
        "url": "https://generativelanguage.googleapis.com" + API_MODELS_ENDPOINT,
        "auth_style": "query",
        "ok_statuses": (200,),
    },
    "windsurf": {
        "url": "https://server.codeium.com/api" + API_MODELS_ENDPOINT,
        "auth_style": "bearer",
        "ok_statuses": (200, 404),
    },
    "mistral": {
        "url": "https://api.mistral.ai" + API_MODELS_ENDPOINT,
        "auth_style": "bearer",
        "ok_statuses": (200,),
    },
    "deepseek": {
        "url": "https://api.deepseek.com" + API_MODELS_ENDPOINT,
        "auth_style": "bearer",
        "ok_statuses": (200,),
    },
}


async def _validate_key_http(provider: str, api_key: str, spec: dict[str, Any]) -> None:
    """Test an API key by hitting the provider's models endpoint.

    Raises HTTPException(400) and marks the key invalid on any failure.
    """
    url = spec["url"]
    auth_style = spec["auth_style"]
    ok_statuses = spec["ok_statuses"]
    headers: dict[str, str] = dict(spec.get("extra_headers", {}))

    if auth_style == "bearer":
        headers["Authorization"] = f"Bearer {api_key}"
    elif auth_style == "x-api-key":
        headers["x-api-key"] = api_key
    elif auth_style == "query":
        url = f"{url}?key={api_key}"

    try:
        async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
            resp = await client.get(url, headers=headers, timeout=10)
        if resp.status_code not in ok_statuses:
            set_validated(provider, api_key, False)
            raise HTTPException(
                status_code=400, detail=API_KEY_VALIDATION_FAILED_INVALID
            )
    except httpx.HTTPError as e:
        set_validated(provider, api_key, False)
        raise HTTPException(
            status_code=400,
            detail=API_KEY_VALIDATION_FAILED_ERROR.format(e=_safe_error_message(e)),
        )


@app.post(
    "/providers/validate/{provider}",
    responses={400: {"description": "API key validation failed"}},
)
@limiter.limit("5/minute")
async def validate_provider_key(
    request: Request, provider: str, api_key: Annotated[str, Body(..., embed=True)]
):
    """Validate a provider API key by actually testing it before marking as valid."""
    spec = _VALIDATION_SPECS.get(provider)
    if spec is None:
        # Providers without specific validation (meta, cursor, copilot, ollama, aws)
        # Accept the key if it's non-empty
        if api_key and api_key.strip():
            set_validated(provider, api_key, True)
            return {"status": "validated"}
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{provider}': API key is empty",
        )

    await _validate_key_http(provider, api_key, spec)
    set_validated(provider, api_key, True)
    return {"status": "validated"}


@app.get("/db/health")
def db_health():
    try:
        from validated_keys_db import get_db

        conn = get_db()
        cur = conn.execute("SELECT 1")
        cur.fetchone()
        conn.close()
        return {"db_up": True}
    except Exception as e:
        return {"db_up": False, "error": _safe_error_message(e)}


@app.get("/health")
def health_check():
    """Comprehensive health check returning the status of all subsystems."""
    import platform
    import time

    start = time.monotonic()
    subsystems: dict[str, Any] = {}

    # 1. Database (validated_keys_db — SQLite)
    try:
        from validated_keys_db import get_db

        conn = get_db()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        subsystems["database"] = {"status": "ok"}
    except Exception as e:
        subsystems["database"] = {"status": "error", "error": _safe_error_message(e)}

    # 2. LLM Providers — quick availability check (env vars / configs)
    provider_status: dict[str, bool] = {}
    for name in [
        "anthropic",
        "openai",
        "google",
        "grok",
        "windsurf",
        "ollama",
        "copilot",
    ]:
        try:
            cfg = get_env_provider_config(name)
            provider_status[name] = cfg is not None
        except Exception:
            logger.debug(
                "Failed to check provider %s availability", name, exc_info=True
            )
            provider_status[name] = False
    subsystems["providers"] = {"status": "ok", "available": provider_status}

    # 3. Graphiti Memory (optional — only if enabled)
    graphiti_enabled = os.getenv("GRAPHITI_ENABLED", "").lower() == "true"
    if graphiti_enabled:
        try:
            from integrations.graphiti.config import get_graphiti_config

            gconfig = get_graphiti_config()
            subsystems["graphiti_memory"] = {
                "status": "ok",
                "enabled": True,
                "llm_provider": gconfig.llm_provider
                if hasattr(gconfig, "llm_provider")
                else "unknown",
                "embedder_provider": gconfig.embedder_provider
                if hasattr(gconfig, "embedder_provider")
                else "unknown",
            }
        except Exception as e:
            subsystems["graphiti_memory"] = {
                "status": "error",
                "enabled": True,
                "error": _safe_error_message(e),
            }
    else:
        subsystems["graphiti_memory"] = {"status": "disabled", "enabled": False}

    # 4. configured_providers.json file
    config_path = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "../../config/configured_providers.json"
        )
    )
    subsystems["configured_providers_file"] = {
        "status": "ok" if os.path.exists(config_path) else "missing"
    }

    # 5. System info
    subsystems["system"] = {
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "pid": os.getpid(),
    }

    elapsed_ms = round((time.monotonic() - start) * 1000, 2)
    all_ok = all(
        s.get("status") in ("ok", "disabled")
        for s in subsystems.values()
        if isinstance(s, dict) and "status" in s
    )

    return {
        "status": "healthy" if all_ok else "degraded",
        "response_time_ms": elapsed_ms,
        "subsystems": subsystems,
    }


@app.get("/providers/usage/{provider}")
async def get_provider_usage(provider: str):
    """
    Récupère l'usage et le crédit restant pour le provider OpenAI, Copilot ou autre si implémenté.
    """
    if provider == "openai":
        # NOTE: L'endpoint /v1/usage d'OpenAI ne fonctionne plus avec les clés API standards
        # depuis 2025. Il nécessite des permissions spéciales (api.usage.read) et souvent
        # une clé d'administrateur. Voir : https://community.openai.com/t/how-to-view-billing-via-api/1362751
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return {"error": "Clé API OpenAI manquante."}

        # Essai avec l'endpoint alternatif /v1/organization/usage si disponible
        try:
            headers = {"Authorization": f"Bearer {api_key}"}
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                # Tentative avec l'endpoint d'organisation (peut aussi nécessiter des permissions spéciales)
                resp = await client.get(
                    "https://api.openai.com/v1/organization/usage",
                    headers=headers,
                    timeout=10,
                )

            if resp.status_code == 200:
                data = resp.json()
                return {
                    "provider": "openai",
                    "usage": data,
                    "fetched_at": "now",
                    "note": "Données d'usage récupérées avec succès",
                }
            else:
                # Si l'endpoint échoue, retourner un message informatif
                return {
                    "provider": "openai",
                    "error": f"Erreur {resp.status_code}: L'endpoint d'usage OpenAI nécessite des permissions spéciales (api.usage.read) ou une clé d'administrateur. Veuillez vérifier votre dashboard OpenAI pour l'usage actuel.",
                    "status_code": resp.status_code,
                    "alternative": "Consultez https://platform.openai.com/settings/organization/billing/overview",
                }
        except Exception as e:
            return {
                "provider": "openai",
                "error": f"Impossible de récupérer l'usage OpenAI: {_safe_error_message(e)}",
                "note": "L'endpoint /v1/usage d'OpenAI nécessite des permissions spéciales depuis 2025",
                "alternative": "Consultez https://platform.openai.com/settings/organization/billing/overview",
            }
    elif provider == "copilot":
        try:
            from src.connectors.llm_copilot import get_copilot_usage_metrics

            usage_data = get_copilot_usage_metrics()

            # Formater les données pour le frontend
            if "error" in usage_data:
                return {
                    "provider": "copilot",
                    "available": False,
                    "error": usage_data.get("error", "COPILOT_USAGE_RETRIEVAL_FAILED"),
                    "message": usage_data.get(
                        "message",
                        "Impossible de récupérer les métriques Copilot pour le moment.",
                    ),
                }

            # Branche "personal-quotas": quotas Premium Requests via
            # /copilot_internal/user — c'est ce que la UI github.com affiche.
            if usage_data.get("scope") == "personal-quotas":
                premium = usage_data.get("premium_requests", {}) or {}
                chat = usage_data.get("chat", {}) or {}
                completions = usage_data.get("completions", {}) or {}
                return {
                    "provider": "copilot",
                    "available": True,
                    "usage": {
                        "scope": "personal-quotas",
                        "plan": usage_data.get("plan"),
                        "login": usage_data.get("login"),
                        "organization": usage_data.get("organization"),
                        "premium_requests": premium,
                        "chat": chat,
                        "completions": completions,
                        "quota_reset_date": usage_data.get("quota_reset_date"),
                        "level": "user",
                    },
                    "fetched_at": usage_data.get("fetched_at"),
                    "copilotUsageDetails": {
                        "scope": "personal-quotas",
                        "plan": usage_data.get("plan"),
                        "organization": usage_data.get("organization"),
                        "premiumRequestsUsed": premium.get("used", 0),
                        "premiumRequestsEntitlement": premium.get("entitlement", 0),
                        "premiumRequestsRemaining": premium.get("remaining", 0),
                        "premiumRequestsPercentUsed": premium.get("percent_used", 0),
                        "premiumRequestsPercentRemaining": premium.get(
                            "percent_remaining"
                        ),
                        "premiumRequestsUnlimited": premium.get("unlimited", False),
                        "chatUnlimited": chat.get("unlimited", False),
                        "completionsUnlimited": completions.get("unlimited", False),
                        "quotaResetDate": usage_data.get("quota_reset_date"),
                    },
                }

            # Branche legacy: métriques agrégées enterprise/org (admin-only)
            return {
                "provider": "copilot",
                "available": True,
                "usage": {
                    "total_suggestions": usage_data.get("total_suggestions", 0),
                    "total_acceptances": usage_data.get("total_acceptances", 0),
                    "total_lines_suggested": usage_data.get("total_lines_suggested", 0),
                    "total_lines_accepted": usage_data.get("total_lines_accepted", 0),
                    "acceptance_rate_percent": usage_data.get(
                        "acceptance_rate_percent", 0
                    ),
                    "line_acceptance_rate_percent": usage_data.get(
                        "line_acceptance_rate_percent", 0
                    ),
                    "total_tokens": usage_data.get("total_tokens", 0),
                    "organization": usage_data.get("organization"),
                    "level": usage_data.get("level", "organization"),
                },
                "fetched_at": usage_data.get("fetched_at"),
                "copilotUsageDetails": {
                    "scope": "aggregated-metrics",
                    "suggestions": usage_data.get("total_suggestions", 0),
                    "acceptances": usage_data.get("total_acceptances", 0),
                    "acceptanceRate": usage_data.get("acceptance_rate_percent", 0),
                    "linesSuggested": usage_data.get("total_lines_suggested", 0),
                    "linesAccepted": usage_data.get("total_lines_accepted", 0),
                    "lineAcceptanceRate": usage_data.get(
                        "line_acceptance_rate_percent", 0
                    ),
                },
            }
        except ImportError as e:
            return {"error": f"Module Copilot non disponible: {_safe_error_message(e)}"}
        except Exception as e:
            return {
                "error": f"Erreur lors de la récupération des métriques Copilot: {_safe_error_message(e)}"
            }
    elif provider == "anthropic" or provider == "claude":
        try:
            from connectors.llm_anthropic_usage import get_anthropic_usage_metrics

            usage_data = get_anthropic_usage_metrics()

            # Formater les données pour le frontend
            if "error" in usage_data:
                return usage_data

            return {
                "provider": "anthropic",
                "available": True,
                "usage": usage_data.get("usage", {}),
                "fetched_at": usage_data.get("fetched_at"),
                "providerName": "anthropic",
            }
        except ImportError as e:
            return {
                "error": f"Module Anthropic usage non disponible: {_safe_error_message(e)}"
            }
        except Exception as e:
            return {
                "error": f"Erreur lors de la récupération des métriques Anthropic: {_safe_error_message(e)}"
            }
    elif provider == "windsurf":
        # Windsurf (Codeium) — multi-strategy auth for GetTeamCreditBalance
        service_key = os.getenv("WINDSURF_API_KEY") or os.getenv("CODEIUM_API_KEY")
        if not service_key:
            return {
                "provider": "windsurf",
                "error": "Clé API Windsurf manquante. Définissez WINDSURF_API_KEY ou CODEIUM_API_KEY.",
                "alternative": "Consultez le dashboard Windsurf pour obtenir votre service key.",
            }
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                # Strategy 1: service_key in body (standard for team service keys)
                resp = await client.post(
                    "https://server.codeium.com/api/v1/GetTeamCreditBalance",
                    json={"service_key": service_key},
                    timeout=10,
                )
                # Strategy 2: Authorization Bearer header (some Codeium API versions)
                if resp.status_code == 401:
                    resp = await client.post(
                        "https://server.codeium.com/api/v1/GetTeamCreditBalance",
                        headers={"Authorization": f"Bearer {service_key}"},
                        json={},
                        timeout=10,
                    )
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "provider": "windsurf",
                    "available": True,
                    "usage": data,
                    "fetched_at": "now",
                }
            # Strategy 3: Validate key via GetUser if credit balance unavailable
            try:
                async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT) as client:
                    user_resp = await client.post(
                        "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetUser",
                        headers={
                            "Authorization": f"Bearer {service_key}",
                            "Content-Type": "application/json",
                        },
                        json={},
                        timeout=10,
                    )
                if user_resp.status_code == 200:
                    user_data = user_resp.json()
                    return {
                        "provider": "windsurf",
                        "available": True,
                        "usage": {
                            "user": user_data,
                            "note": "Credit balance unavailable — key validated via GetUser",
                        },
                        "fetched_at": "now",
                    }
            except Exception:
                logger.debug(
                    "Failed to call Windsurf GetUser endpoint — skipping", exc_info=True
                )
            return {
                "provider": "windsurf",
                "error": f"Erreur {resp.status_code}: {resp.text[:200]}",
                "status_code": resp.status_code,
                "note": "Vérifiez que votre service key Windsurf est valide.",
            }
        except Exception as e:
            return {
                "provider": "windsurf",
                "error": f"Impossible de récupérer l'usage Windsurf: {_safe_error_message(e)}",
            }
    else:
        return {"error": f"Usage non supporté pour le provider '{provider}'"}


# ---------------------------------------------------------------------------
# Feature API endpoints — Expose backend Python modules to the frontend
# ---------------------------------------------------------------------------


# Dashboard + Session History endpoints moved to dashboard/api.py


# Refactoring + documentation + feedback + templates + code-review
# endpoints moved to agent_endpoints/api.py
# System status endpoints moved to system_status/api.py
# GitHub PR Details endpoint moved to runners/github/api.py
# Test Generation Agent API moved to test_generation/api.py
# Both mounted below alongside the other feature routers.


# Event-Driven Hooks System API moved to event_hooks/api.py


# --- Analytics API (prefer real DB implementation, fall back to minimal stub) ---
try:
    from analytics.database import init_database as _init_analytics_db

    _init_analytics_db()
    from analytics.api_simple import router as analytics_router

    app.include_router(analytics_router)
except Exception as e:
    logging.getLogger(__name__).warning(
        "Could not load real analytics router (%s), falling back to minimal stub",
        e,
    )
    try:
        from analytics.api_minimal import router as analytics_router

        app.include_router(analytics_router)
    except ImportError as e2:
        logging.getLogger(__name__).warning("Could not import analytics router: %s", e2)

# --- Mission Control API ---
try:
    from mission_control.api import router as mission_control_router

    app.include_router(mission_control_router)
except ImportError as e:
    print(f"Warning: Could not import mission control router: {e}")

# --- Agent Replay & Debug Mode API ---
try:
    from replay.api import router as replay_router

    app.include_router(replay_router)
except ImportError as e:
    print(f"Warning: Could not import replay router: {e}")

# --- Adaptive Model Router API ---
try:
    from model_router.api import router as model_router_api

    app.include_router(model_router_api)
except ImportError as e:
    print(f"Warning: Could not import model_router api: {e}")

# --- Codebase Longevity API ---
try:
    from longevity.api import router as longevity_router

    app.include_router(longevity_router)
except ImportError as e:
    print(f"Warning: Could not import longevity router: {e}")

# --- Architecture Drift Detection API ---
try:
    from architecture_drift.api import router as architecture_drift_router

    app.include_router(architecture_drift_router)
except ImportError as e:
    print(f"Warning: Could not import architecture_drift router: {e}")

# --- Generational Test Archive API ---
try:
    from generational_tests.api import router as generational_tests_router

    app.include_router(generational_tests_router)
except ImportError as e:
    print(f"Warning: Could not import generational_tests router: {e}")

# --- Cognitive Context Optimizer API ---
try:
    from cognitive_context.api import router as cognitive_context_router

    app.include_router(cognitive_context_router)
except ImportError as e:
    print(f"Warning: Could not import cognitive_context router: {e}")

# --- Agent Health Monitor API ---
try:
    from agent_health.api import router as agent_health_router

    app.include_router(agent_health_router)
except ImportError as e:
    print(f"Warning: Could not import agent_health router: {e}")

# --- CI/CD Anomaly Detective API ---
try:
    from cicd_anomaly.api import router as cicd_anomaly_router

    app.include_router(cicd_anomaly_router)
except ImportError as e:
    print(f"Warning: Could not import cicd_anomaly router: {e}")

# --- License Governance API ---
try:
    from license_governance.api import router as license_governance_router

    app.include_router(license_governance_router)
except ImportError as e:
    print(f"Warning: Could not import license_governance router: {e}")

# --- Domain-Specific Agent Factory API ---
try:
    from domain_agents.api import router as domain_agents_router

    app.include_router(domain_agents_router)
except ImportError as e:
    print(f"Warning: Could not import domain_agents router: {e}")

# --- i18n Auto-Scaler API ---
try:
    from i18n_scaler.api import router as i18n_scaler_router

    app.include_router(i18n_scaler_router)
except ImportError as e:
    print(f"Warning: Could not import i18n_scaler router: {e}")

# --- Audit Trail API ---
try:
    from audit_trail.api import router as audit_trail_router

    app.include_router(audit_trail_router)
except ImportError as e:
    print(f"Warning: Could not import audit_trail router: {e}")

# --- Real-time Pair Programming API ---
try:
    from pair_realtime.api import router as pair_realtime_router

    app.include_router(pair_realtime_router)
except ImportError as e:
    print(f"Warning: Could not import pair_realtime router: {e}")

# --- Code Playground API ---
try:
    from code_playground.api import router as code_playground_router

    app.include_router(code_playground_router)
except ImportError as e:
    print(f"Warning: Could not import code_playground router: {e}")

# --- Cost Estimator API (pre-build cost preview) ---
try:
    from cost_intelligence.api import router as cost_estimator_router

    app.include_router(cost_estimator_router)
except ImportError as e:
    print(f"Warning: Could not import cost_estimator router: {e}")

# --- Restart Planner API (read-only restart inspection + cleanup) ---
try:
    from restart_planner.api import router as restart_planner_router

    app.include_router(restart_planner_router)
except ImportError as e:
    print(f"Warning: Could not import restart_planner router: {e}")

# --- Prompt Preview API (debug helper for the kanban "Voir prompt" button) ---
try:
    from core.prompt_preview_api import router as prompt_preview_router

    app.include_router(prompt_preview_router)
except ImportError as e:
    print(f"Warning: Could not import prompt_preview router: {e}")

# --- Timeline API (UI-friendly view of the audit_trail per spec) ---
try:
    from timeline.api import router as timeline_router

    app.include_router(timeline_router)
except ImportError as e:
    print(f"Warning: Could not import timeline router: {e}")

# --- Progress Indicator API (fine-grained sub-status for the kanban) ---
try:
    from progress_indicator.api import router as progress_indicator_router

    app.include_router(progress_indicator_router)
except ImportError as e:
    print(f"Warning: Could not import progress_indicator router: {e}")

# --- QA Auto-Promotion API (skip human_review when score is high enough) ---
try:
    from qa_promotion.api import router as qa_promotion_router

    app.include_router(qa_promotion_router)
except ImportError as e:
    print(f"Warning: Could not import qa_promotion router: {e}")

# --- Slash Commands API (Kanban Quick-Command bar: list + run .claude/commands) ---
try:
    from slash_commands.api import router as slash_commands_router

    app.include_router(slash_commands_router)
except ImportError as e:
    print(f"Warning: Could not import slash_commands router: {e}")

# --- Parallel Variations API (local Arena: scaffold + compare, never auto-merge) ---
try:
    from parallel_variations.api import router as parallel_variations_router

    app.include_router(parallel_variations_router)
except ImportError as e:
    print(f"Warning: Could not import parallel_variations router: {e}")

# --- Virtual Reviewer API (advisory only, no signature, no PR) ---
try:
    from virtual_reviewer.api import router as virtual_reviewer_router

    app.include_router(virtual_reviewer_router)
except ImportError as e:
    print(f"Warning: Could not import virtual_reviewer router: {e}")

# --- Test Generation Agent API (extracted from this file) ---
try:
    from test_generation.api import router as test_generation_router

    app.include_router(test_generation_router)
except ImportError as e:
    print(f"Warning: Could not import test_generation router: {e}")

# --- GitHub PR Details API (extracted from this file) ---
try:
    from runners.github.api import router as github_api_router

    app.include_router(github_api_router)
except ImportError as e:
    print(f"Warning: Could not import github api router: {e}")

# --- System Status API (extracted from this file) ---
try:
    from system_status.api import router as system_status_router

    app.include_router(system_status_router)
except ImportError as e:
    print(f"Warning: Could not import system_status router: {e}")

# --- Dashboard + Sessions API (extracted from this file) ---
try:
    from dashboard.api import router as dashboard_router

    app.include_router(dashboard_router)
except ImportError as e:
    print(f"Warning: Could not import dashboard router: {e}")

# --- Agent feature endpoints (extracted from this file) ---
try:
    from agent_endpoints.api import router as agent_endpoints_router

    app.include_router(agent_endpoints_router)
except ImportError as e:
    print(f"Warning: Could not import agent_endpoints router: {e}")

# --- Event-Driven Hooks System API (extracted from this file) ---
try:
    from event_hooks.api import router as event_hooks_router

    app.include_router(event_hooks_router)
except ImportError as e:
    print(f"Warning: Could not import event_hooks router: {e}")

if __name__ == "__main__":
    import uvicorn

    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    port = int(os.getenv("BACKEND_PORT", 9000))
    uvicorn.run(
        "provider_api:app",
        host="127.0.0.1",
        port=port,
        reload=True,
        reload_excludes=[".venv"],
    )
