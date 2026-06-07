"""
Agent Client Configuration
===========================

Factory functions for creating provider-agnostic agent clients.

The primary entry point is `create_agent_client()` which returns an `AgentClient`
instance (either `ClaudeAgentClient` or `CopilotAgentClient`) based on the
`provider` parameter.

For backward compatibility, `create_client()` still returns a raw `ClaudeSDKClient`.

All AI interactions should use `create_agent_client()` (preferred) or `create_client()`
to ensure consistent authentication and proper tool/MCP configuration.
For simple message calls without full agent sessions, use `create_simple_client()`
from `core.simple_client`.

The client factory uses AGENT_CONFIGS from agents/tools_pkg/models.py as the
single source of truth for phase-aware tool and MCP server configuration.
"""

import copy
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from core.platform import (
    is_windows,
    validate_cli_path,
)

logger = logging.getLogger(__name__)

# =============================================================================
# Project Index Cache
# =============================================================================
# Caches project index and capabilities to avoid reloading on every create_client() call.
# This significantly reduces the time to create new agent sessions.

_PROJECT_INDEX_CACHE: dict[str, tuple[dict[str, Any], dict[str, bool], float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minute TTL
_CACHE_LOCK = threading.Lock()  # Protects _PROJECT_INDEX_CACHE access
_AUTO_CLAUDE_DIR = ".workpilot"  # Auto-Claude configuration directory


def _get_cached_project_data(
    project_dir: Path,
) -> tuple[dict[str, Any], dict[str, bool]]:
    """
    Get project index and capabilities with caching.

    Args:
        project_dir: Path to the project directory

    Returns:
        Tuple of (project_index, project_capabilities)
    """

    key = str(Path(project_dir).resolve())
    now = time.time()
    debug = os.environ.get("DEBUG", "").lower() in ("true", "1")

    # Check cache with lock
    with _CACHE_LOCK:
        if key in _PROJECT_INDEX_CACHE:
            cached_index, cached_capabilities, cached_time = _PROJECT_INDEX_CACHE[key]
            cache_age = now - cached_time
            if cache_age < _CACHE_TTL_SECONDS:
                if debug:
                    print(
                        f"[ClientCache] Cache HIT for project index (age: {cache_age:.1f}s / TTL: {_CACHE_TTL_SECONDS}s)"
                    )
                logger.debug(f"Using cached project index for {project_dir}")
                # Return deep copies to prevent callers from corrupting the cache
                return copy.deepcopy(cached_index), copy.deepcopy(cached_capabilities)
            elif debug:
                print(
                    f"[ClientCache] Cache EXPIRED for project index (age: {cache_age:.1f}s > TTL: {_CACHE_TTL_SECONDS}s)"
                )

    # Cache miss or expired - load fresh data (outside lock to avoid blocking)
    load_start = time.time()
    logger.debug(f"Loading project index for {project_dir}")
    project_index = load_project_index(project_dir)
    project_capabilities = detect_project_capabilities(project_index)

    if debug:
        load_duration = (time.time() - load_start) * 1000
        print(
            f"[ClientCache] Cache MISS - loaded project index in {load_duration:.1f}ms"
        )

    # Store in cache with lock - use double-checked locking pattern
    # Re-check if another thread populated the cache while we were loading
    with _CACHE_LOCK:
        if key in _PROJECT_INDEX_CACHE:
            cached_index, cached_capabilities, cached_time = _PROJECT_INDEX_CACHE[key]
            cache_age = time.time() - cached_time
            if cache_age < _CACHE_TTL_SECONDS:
                # Another thread already cached valid data while we were loading
                if debug:
                    print(
                        "[ClientCache] Cache was populated by another thread, using cached data"
                    )
                # Return deep copies to prevent callers from corrupting the cache
                return copy.deepcopy(cached_index), copy.deepcopy(cached_capabilities)
        # Either no cache entry or it's expired - store our fresh data
        _PROJECT_INDEX_CACHE[key] = (project_index, project_capabilities, time.time())

    # Return the freshly loaded data (no need to copy since it's not from cache)
    return project_index, project_capabilities


def invalidate_project_cache(project_dir: Path | None = None) -> None:
    """
    Invalidate the project index cache.

    Args:
        project_dir: Specific project to invalidate, or None to clear all
    """
    with _CACHE_LOCK:
        if project_dir is None:
            _PROJECT_INDEX_CACHE.clear()
            logger.debug("Cleared all project index cache entries")
        else:
            key = str(Path(project_dir).resolve())
            if key in _PROJECT_INDEX_CACHE:
                del _PROJECT_INDEX_CACHE[key]
                logger.debug(f"Invalidated project index cache for {project_dir}")


from agents.tools_pkg import (
    CONTEXT7_TOOLS,
    ELECTRON_TOOLS,
    GRAPHITI_MCP_TOOLS,
    LINEAR_TOOLS,
    PUPPETEER_TOOLS,
    create_auto_claude_mcp_server,
    get_allowed_tools,
    get_required_mcp_servers,
    is_tools_available,
)

# Make claude_agent_sdk optional for testing purposes
try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    from claude_agent_sdk.types import HookMatcher
except ImportError:
    # Provide fallback for testing
    ClaudeAgentOptions = None
    ClaudeSDKClient = None
    HookMatcher = None

# BUG FIX #12: Monkey-patch SDK message parser to handle unknown message types
# gracefully instead of raising MessageParseError. The Claude CLI may send message
# types (e.g., "rate_limit_event") that the SDK version doesn't recognize yet.
# Without this patch, unknown types crash the entire agent session.
try:
    import claude_agent_sdk._internal.message_parser as _sdk_msg_parser
    from claude_agent_sdk.types import SystemMessage as _SDKSystemMessage

    _original_parse_message = _sdk_msg_parser.parse_message

    def _patched_parse_message(data):
        try:
            return _original_parse_message(data)
        except Exception as exc:
            if "Unknown message type" in str(exc):
                msg_type = (
                    data.get("type", "unknown") if isinstance(data, dict) else "unknown"
                )
                logger.warning(
                    "SDK received unknown message type '%s' — skipping gracefully "
                    "(data keys: %s)",
                    msg_type,
                    list(data.keys()) if isinstance(data, dict) else "N/A",
                )
                # Return as a SystemMessage so the session can continue
                return _SDKSystemMessage(subtype=msg_type, data=data)
            raise

    _sdk_msg_parser.parse_message = _patched_parse_message
    logger.debug("Patched SDK message parser for unknown message type resilience")
except Exception:
    # If patching fails (e.g., SDK not installed), continue without it
    pass

try:
    from core.auth import (
        configure_sdk_authentication,
        get_sdk_env_vars,
    )
except ImportError:
    # Fallback implementations for testing environments where core.auth module is not available
    # These functions are intentionally empty to prevent crashes during testing/development
    def configure_sdk_authentication(*args, **kwargs):
        """No-op fallback - authentication not available in test environment"""
        pass

    def get_sdk_env_vars(*args, **kwargs):
        """No-op fallback - returns empty dict when auth module unavailable"""
        return {}


from linear_updater import is_linear_enabled
from prompts_pkg.project_context import detect_project_capabilities, load_project_index
from security import bash_security_hook
from security.guardrails import guardrails_hook as _raw_guardrails_hook


def _make_guardrails_hook(project_dir: Path):
    """Bind the project root so the SDK can call the hook with its own signature."""

    async def _hook(
        input_data: dict,
        tool_use_id: str | None = None,
        context: object | None = None,
    ) -> dict:
        return await _raw_guardrails_hook(
            input_data, tool_use_id, context, project_root=project_dir
        )

    return _hook


def _make_pre_compact_hook(spec_dir: Path):
    """
    PreCompact hook — fires just before the SDK summarises older history to
    free space. Currently logs the event so we can spot compaction in traces;
    this is the canonical place to later archive the full transcript if needed.
    Hooks run in our process, not the agent's context window — zero token cost.
    """

    async def _hook(
        input_data: dict,
        tool_use_id: str | None = None,
        context: object | None = None,
    ) -> dict:
        try:
            trigger = (
                input_data.get("trigger", "auto")
                if isinstance(input_data, dict)
                else "auto"
            )
            session_id = (
                input_data.get("session_id") if isinstance(input_data, dict) else None
            )
            logger.info(
                "[hook:PreCompact] spec=%s session=%s trigger=%s",
                spec_dir.name,
                session_id,
                trigger,
            )
        except Exception:
            logger.debug("[hook:PreCompact] logging failed", exc_info=True)
        return {}

    return _hook


def _make_stop_hook(spec_dir: Path):
    """
    Stop hook — fires when the agent loop ends (success or error). Used for
    end-of-session observability; intentionally a no-op decision so the SDK
    proceeds normally. Heavy work belongs in session.py's post-session block.
    """

    async def _hook(
        input_data: dict,
        tool_use_id: str | None = None,
        context: object | None = None,
    ) -> dict:
        try:
            session_id = (
                input_data.get("session_id") if isinstance(input_data, dict) else None
            )
            logger.info("[hook:Stop] spec=%s session=%s", spec_dir.name, session_id)
        except Exception:
            logger.debug("[hook:Stop] logging failed", exc_info=True)
        return {}

    return _hook


def _validate_custom_mcp_server(server: dict) -> bool:
    """
    Validate a custom MCP server configuration for security.

    Ensures only expected fields with valid types are present.
    Rejects configurations that could lead to command injection.

    Args:
        server: Dict representing a custom MCP server configuration

    Returns:
        True if valid, False otherwise
    """
    if not isinstance(server, dict):
        return False

    # Required fields
    required_fields = {"id", "name", "type"}
    if not all(field in server for field in required_fields):
        logger.warning(
            f"Custom MCP server missing required fields: {required_fields - server.keys()}"
        )
        return False

    # Validate field types
    if not isinstance(server.get("id"), str) or not server["id"]:
        return False
    if not isinstance(server.get("name"), str) or not server["name"]:
        return False
    # FIX: Changed from ('command', 'url') to ('command', 'http') to match actual usage
    if server.get("type") not in ("command", "http"):
        logger.warning(f"Invalid MCP server type: {server.get('type')}")
        return False

    # Allowlist of safe executable commands for MCP servers
    # Only allow known package managers and interpreters - NO shell commands
    SAFE_COMMANDS = {
        "npx",
        "npm",
        "node",
        "python",
        "python3",
        "uv",
        "uvx",
    }

    # Blocklist of dangerous shell commands that should never be allowed
    DANGEROUS_COMMANDS = {
        "bash",
        "sh",
        "cmd",
        "powershell",
        "pwsh",  # PowerShell Core
        "/bin/bash",
        "/bin/sh",
        "/bin/zsh",
        "/usr/bin/bash",
        "/usr/bin/sh",
        "zsh",
        "fish",
    }

    # Dangerous interpreter flags that allow arbitrary code execution
    # Covers Python (-e, -c, -m, -p), Node.js (--eval, --print, loaders), and general
    DANGEROUS_FLAGS = {
        "--eval",
        "-e",
        "-c",
        "--exec",
        "-m",  # Python module execution
        "-p",  # Python eval+print
        "--print",  # Node.js print
        "--input-type=module",  # Node.js ES module mode
        "--experimental-loader",  # Node.js custom loaders
        "--require",  # Node.js require injection
        "-r",  # Node.js require shorthand
    }

    # Type-specific validation
    if server["type"] == "command":
        if not isinstance(server.get("command"), str) or not server["command"]:
            logger.warning("Command-type MCP server missing 'command' field")
            return False

        # SECURITY FIX: Validate command is in safe list and not in dangerous list
        command = server.get("command", "")

        # Reject paths - commands must be bare names only (no / or \)
        # This prevents path traversal like '/custom/malicious' or './evil'
        if "/" in command or "\\" in command:
            logger.warning(
                f"Rejected command with path in MCP server: {command}. "
                f"Commands must be bare names without path separators."
            )
            return False

        if command in DANGEROUS_COMMANDS:
            logger.warning(
                f"Rejected dangerous command in MCP server: {command}. "
                f"Shell commands are not allowed for security reasons."
            )
            return False

        if command not in SAFE_COMMANDS:
            logger.warning(
                f"Rejected unknown command in MCP server: {command}. "
                f"Only allowed commands: {', '.join(sorted(SAFE_COMMANDS))}"
            )
            return False

        # Validate args is a list of strings if present
        if "args" in server:
            if not isinstance(server["args"], list):
                return False
            if not all(isinstance(arg, str) for arg in server["args"]):
                return False
            # Check for dangerous interpreter flags that allow code execution
            for arg in server["args"]:
                if arg in DANGEROUS_FLAGS:
                    logger.warning(
                        f"Rejected dangerous flag '{arg}' in MCP server args. "
                        f"Interpreter code execution flags are not allowed."
                    )
                    return False
    elif server["type"] == "http":
        if not isinstance(server.get("url"), str) or not server["url"]:
            logger.warning("HTTP-type MCP server missing 'url' field")
            return False
        # Validate headers is a dict of strings if present
        if "headers" in server:
            if not isinstance(server["headers"], dict):
                return False
            if not all(
                isinstance(k, str) and isinstance(v, str)
                for k, v in server["headers"].items()
            ):
                return False

    # Optional description must be string if present
    if "description" in server and not isinstance(server.get("description"), str):
        return False

    # Reject any unexpected fields that could be exploited
    allowed_fields = {
        "id",
        "name",
        "type",
        "command",
        "args",
        "url",
        "headers",
        "description",
    }
    unexpected_fields = set(server.keys()) - allowed_fields
    if unexpected_fields:
        logger.warning(f"Custom MCP server has unexpected fields: {unexpected_fields}")
        return False

    return True


def load_project_mcp_config(project_dir: Path) -> dict:
    """
    Load MCP configuration from project's _AUTO_CLAUDE_DIR/.env file.

    Returns a dict of MCP-related env vars:
    - CONTEXT7_ENABLED (default: true)
    - LINEAR_MCP_ENABLED (default: true)
    - ELECTRON_MCP_ENABLED (default: false)
    - PUPPETEER_MCP_ENABLED (default: false)
    - AGENT_MCP_<agent>_ADD (per-agent MCP additions)
    - AGENT_MCP_<agent>_REMOVE (per-agent MCP removals)
    - CUSTOM_MCP_SERVERS (JSON array of custom server configs)

    Args:
        project_dir: Path to the project directory

    Returns:
        Dict of MCP configuration values (string values, except CUSTOM_MCP_SERVERS which is parsed JSON)
    """
    env_path = project_dir / _AUTO_CLAUDE_DIR / ".env"
    if not env_path.exists():
        return {}

    config = {}
    mcp_keys = {
        "CONTEXT7_ENABLED",
        "LINEAR_MCP_ENABLED",
        "ELECTRON_MCP_ENABLED",
        "PUPPETEER_MCP_ENABLED",
    }

    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip().strip("\"'")
                    # Include global MCP toggles
                    if key in mcp_keys:
                        config[key] = value
                    # Include per-agent MCP overrides (AGENT_MCP_<agent>_ADD/REMOVE)
                    elif key.startswith("AGENT_MCP_"):
                        config[key] = value
                    # Include custom MCP servers (parse JSON with schema validation)
                    elif key == "CUSTOM_MCP_SERVERS":
                        try:
                            parsed = json.loads(value)
                            if not isinstance(parsed, list):
                                logger.warning(
                                    "CUSTOM_MCP_SERVERS must be a JSON array"
                                )
                                config["CUSTOM_MCP_SERVERS"] = []
                            else:
                                # Validate each server and filter out invalid ones
                                valid_servers = []
                                for i, server in enumerate(parsed):
                                    if _validate_custom_mcp_server(server):
                                        valid_servers.append(server)
                                    else:
                                        logger.warning(
                                            f"Skipping invalid custom MCP server at index {i}"
                                        )
                                config["CUSTOM_MCP_SERVERS"] = valid_servers
                        except json.JSONDecodeError:
                            logger.warning(
                                f"Failed to parse CUSTOM_MCP_SERVERS JSON: {value}"
                            )
                            config["CUSTOM_MCP_SERVERS"] = []
    except Exception as e:
        logger.debug(f"Failed to load project MCP config from {env_path}: {e}")

    return config


def is_graphiti_mcp_enabled() -> bool:
    """
    Check if Graphiti MCP server integration is enabled.

    Requires GRAPHITI_MCP_URL to be set (e.g., http://localhost:9000/mcp/)
    This is separate from GRAPHITI_ENABLED which controls the Python library integration.
    """
    return bool(os.environ.get("GRAPHITI_MCP_URL"))


def get_graphiti_mcp_url() -> str:
    """Get the Graphiti MCP server URL."""
    return os.environ.get("GRAPHITI_MCP_URL", "http://localhost:9000/mcp/")


def is_electron_mcp_enabled() -> bool:
    """
    Check if Electron MCP server integration is enabled.

    Requires ELECTRON_MCP_ENABLED to be set to 'true'.
    When enabled, QA agents can use Puppeteer MCP tools to connect to Electron apps
    via Chrome DevTools Protocol on the configured debug port.
    """
    return os.environ.get("ELECTRON_MCP_ENABLED", "").lower() == "true"


def get_electron_debug_port() -> int:
    """Get the Electron remote debugging port (default: 9222)."""
    return int(os.environ.get("ELECTRON_DEBUG_PORT", "9222"))


def should_use_claude_md() -> bool:
    """Check if CLAUDE.md instructions should be included in system prompt."""
    return os.environ.get("USE_CLAUDE_MD", "").lower() == "true"


def load_claude_md(project_dir: Path) -> str | None:
    """
    Load CLAUDE.md content from project root if it exists.

    Args:
        project_dir: Root directory of the project

    Returns:
        Content of CLAUDE.md if found, None otherwise
    """
    claude_md_path = project_dir / "CLAUDE.md"
    if claude_md_path.exists():
        try:
            return claude_md_path.read_text(encoding="utf-8")
        except Exception:
            return None
    return None


# Map AGENT_CONFIGS agent_type → DomainAgentFactory role enum value.
# Kept here (rather than in feature_wiring) because it depends on the
# specific agent_type vocabulary used in this client layer.
_DOMAIN_ROLE_BY_AGENT_TYPE = {
    "coder": "coder",
    "planner": "planner",
    "qa_reviewer": "reviewer",
    "qa_fixer": "reviewer",
    "documenter": "documenter",
}


def _inject_domain_addendum(
    base_prompt: str,
    agent_type: str,
    spec_dir: Path | None,
) -> str:
    """Append the Domain Agents prompt addendum when the spec declares a
    ``domain`` field in ``requirements.json``.

    Best-effort. Returns the prompt unchanged if anything goes wrong (no
    domain configured, unknown role, addendum module missing, etc).
    Centralised so all four provider branches (Claude / Copilot / Windsurf /
    OpenAI) get the addendum the same way.
    """
    if spec_dir is None:
        return base_prompt
    role = _DOMAIN_ROLE_BY_AGENT_TYPE.get(agent_type)
    if not role:
        return base_prompt
    try:
        from agents.feature_wiring import load_domain_addendum

        addendum = load_domain_addendum(spec_dir, role=role)
    except Exception:  # noqa: BLE001
        return base_prompt
    if not addendum:
        return base_prompt
    print(f"   - Domain addendum: injected ({len(addendum)} chars, role={role})")
    return f"{base_prompt}\n\n# Domain-Specific Guidance\n\n{addendum}"


def create_client(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    agent_type: str = "coder",
    max_thinking_tokens: int | None = None,
    output_format: dict | None = None,
    agents: dict | None = None,
    resume: str | None = None,
) -> ClaudeSDKClient:
    """
    Create a Claude Agent SDK client with multi-layered security.

    Uses AGENT_CONFIGS for phase-aware tool and MCP server configuration.
    Only starts MCP servers that the agent actually needs, reducing context
    window bloat and startup latency.

    project_dir and spec_dir are normalized to Path objects if passed as strings.

    Args:
        project_dir: Root directory for the project (working directory)
        spec_dir: Directory containing the spec (for settings file)
        model: Claude model to use
        agent_type: Agent type identifier from AGENT_CONFIGS
                   (e.g., 'coder', 'planner', 'qa_reviewer', 'spec_gatherer')
        max_thinking_tokens: Token budget for extended thinking (None = disabled)
                            - ultrathink: 16000 (spec creation)
                            - high: 10000 (QA review)
                            - medium: 5000 (planning, validation)
                            - None: disabled (coding)
        output_format: Optional structured output format for validated JSON responses.
                      Use {"type": "json_schema", "schema": Model.model_json_schema()}
                      See: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
        agents: Optional dict of subagent definitions for SDK parallel execution.
               Format: {"agent-name": {"description": "...", "prompt": "...",
                        "tools": [...], "model": "inherit"}}
               See: https://platform.claude.com/docs/en/agent-sdk/subagents

    Returns:
        Configured ClaudeSDKClient

    Raises:
        ValueError: If agent_type is not found in AGENT_CONFIGS

    Security layers (defense in depth):
    1. Sandbox - OS-level bash command isolation prevents filesystem escape
    2. Permissions - File operations restricted to project_dir only
    3. Security hooks - Bash commands validated against an allowlist
       (see security.py for ALLOWED_COMMANDS)
    4. Tool filtering - Each agent type only sees relevant tools (prevents misuse)
    """
    # Normalize to Path objects in case strings are passed
    if isinstance(project_dir, str):
        project_dir = Path(project_dir)
    if isinstance(spec_dir, str):
        spec_dir = Path(spec_dir)

    # Collect env vars to pass to SDK (ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR, etc.)
    sdk_env = get_sdk_env_vars()

    # Token / context optimisations (docs: code.claude.com/docs/en/agent-sdk).
    # `setdefault` keeps any explicit user override intact.
    # - 1h prompt-cache TTL: Kanban runs many short cards back-to-back against
    #   the same system prompt + CLAUDE.md; 1h TTL keeps the cache warm between
    #   cards instead of paying full input price every 5 minutes.
    # - tool-search auto:5: defers MCP tool schemas when their combined size
    #   exceeds 5% of the context window. Activates only when there are enough
    #   MCP servers to make deferral worthwhile.
    sdk_env.setdefault("ENABLE_PROMPT_CACHING_1H", "1")
    sdk_env.setdefault("ENABLE_TOOL_SEARCH", "auto:5")

    # OpenTelemetry observability (opt-in). When AUTO_CLAUDE_OTEL_ENDPOINT is
    # set (e.g. `http://localhost:4318` for a local OTLP collector / Jaeger),
    # we flip on the CLI's built-in tracing so spans for each turn, tool call,
    # and hook flow into the user's backend. Traces are in beta on the CLI
    # side, so we gate them explicitly. The agent_type becomes the OTEL
    # service name so multiple runner kinds (coder, planner, analyzer, …)
    # appear as separate services in the dashboard.
    # See: code.claude.com/docs/en/agent-sdk/observability
    _otel_endpoint = os.environ.get("AUTO_CLAUDE_OTEL_ENDPOINT")
    if _otel_endpoint:
        sdk_env.setdefault("CLAUDE_CODE_ENABLE_TELEMETRY", "1")
        sdk_env.setdefault("CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "1")
        sdk_env.setdefault("OTEL_TRACES_EXPORTER", "otlp")
        sdk_env.setdefault("OTEL_METRICS_EXPORTER", "otlp")
        sdk_env.setdefault("OTEL_LOGS_EXPORTER", "otlp")
        sdk_env.setdefault("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
        sdk_env.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", _otel_endpoint)
        sdk_env.setdefault("OTEL_SERVICE_NAME", f"workpilot-{agent_type}")
        # Tighter export intervals so short Kanban cards flush before exit.
        sdk_env.setdefault("OTEL_METRIC_EXPORT_INTERVAL", "1000")
        sdk_env.setdefault("OTEL_LOGS_EXPORT_INTERVAL", "1000")
        sdk_env.setdefault("OTEL_TRACES_EXPORT_INTERVAL", "1000")

    # Get the config dir for profile-specific credential lookup
    # CLAUDE_CONFIG_DIR enables per-profile Keychain entries with SHA256-hashed service names
    config_dir = sdk_env.get("CLAUDE_CONFIG_DIR")

    # Multi-profile hardening (docs: code.claude.com/docs/en/agent-sdk/secure-deployment).
    # When a non-default CLAUDE_CONFIG_DIR is in use (i.e. the user is on a
    # specific profile rather than the global ~/.claude), disable the SDK's
    # auto-memory writer. Without this, prompts and learnings from profile A
    # would seed the auto-memory file consulted by profile B on the same
    # machine, leaking context across tenants/identities.
    if config_dir:
        sdk_env.setdefault("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")

    # Configure SDK authentication (OAuth or API profile mode)
    configure_sdk_authentication(config_dir)

    if config_dir:
        logger.info(f"Using CLAUDE_CONFIG_DIR for profile: {config_dir}")

    # Debug: Log git-bash path detection on Windows
    if "CLAUDE_CODE_GIT_BASH_PATH" in sdk_env:
        logger.info(f"Git Bash path found: {sdk_env['CLAUDE_CODE_GIT_BASH_PATH']}")
    elif is_windows():
        logger.warning("Git Bash path not detected on Windows!")

    # Check if Linear integration is enabled
    linear_enabled = is_linear_enabled()
    linear_api_key = os.environ.get("LINEAR_API_KEY", "")

    # Check if custom workpilot tools are available
    auto_claude_tools_enabled = is_tools_available()

    # Load project capabilities for dynamic MCP tool selection
    # This enables context-aware tool injection based on project type
    # Uses caching to avoid reloading on every create_client() call
    _, project_capabilities = _get_cached_project_data(project_dir)

    # Load per-project MCP configuration from _AUTO_CLAUDE_DIR/.env
    mcp_config = load_project_mcp_config(project_dir)

    # Get allowed tools using phase-aware configuration
    # This respects AGENT_CONFIGS and only includes tools the agent needs
    # Also respects per-project MCP configuration
    allowed_tools_list = get_allowed_tools(
        agent_type,
        project_capabilities,
        linear_enabled,
        mcp_config,
    )

    # Get required MCP servers for this agent type
    # This is the key optimization - only start servers the agent needs
    # Now also respects per-project MCP configuration
    required_servers = get_required_mcp_servers(
        agent_type,
        project_capabilities,
        linear_enabled,
        mcp_config,
    )

    # Check if Graphiti MCP is enabled (already filtered by get_required_mcp_servers)
    graphiti_mcp_enabled = "graphiti" in required_servers

    # Determine browser tools for permissions (already in allowed_tools_list)
    browser_tools_permissions = []
    if "electron" in required_servers:
        browser_tools_permissions = ELECTRON_TOOLS
    elif "puppeteer" in required_servers:
        browser_tools_permissions = PUPPETEER_TOOLS

    # Create comprehensive security settings
    # Note: Using both relative paths ("./**") and absolute paths to handle
    # cases where Claude uses absolute paths for file operations
    project_path_str = str(project_dir.resolve())
    spec_path_str = str(spec_dir.resolve()) if spec_dir else project_path_str

    # Detect if we're running in a worktree and get the original project directory
    # Worktrees are located in either:
    # - _AUTO_CLAUDE_DIR/worktrees/tasks/{spec-name}/ (new location)
    # - .worktrees/{spec-name}/ (legacy location)
    # When running in a worktree, we need to allow access to both the worktree
    # and the original project's _AUTO_CLAUDE_DIR/ directory for spec files
    original_project_permissions = []
    resolved_project_path = project_dir.resolve()

    # Check for worktree paths and extract original project directory
    # This handles spec worktrees, PR review worktrees, and legacy worktrees
    # Note: Windows paths are normalized to forward slashes before comparison
    worktree_markers = [
        f"/{_AUTO_CLAUDE_DIR}/worktrees/tasks/",  # Spec/task worktrees
        f"/{_AUTO_CLAUDE_DIR}/github/pr/worktrees/",  # PR review worktrees
        "/.worktrees/",  # Legacy worktree location
    ]
    project_path_posix = str(resolved_project_path).replace("\\", "/")

    for marker in worktree_markers:
        if marker in project_path_posix:
            # Extract the original project directory (parent of worktree location)
            # Use rsplit to get the rightmost occurrence (handles nested projects)
            original_project_str = project_path_posix.rsplit(marker, 1)[0]
            original_project_dir = Path(original_project_str)

            # Grant permissions for relevant directories in the original project
            permission_ops = ["Read", "Write", "Edit", "Glob", "Grep"]
            dirs_to_permit = [
                original_project_dir / _AUTO_CLAUDE_DIR,
                original_project_dir / ".worktrees",  # Legacy support
            ]

            for dir_path in dirs_to_permit:
                if dir_path.exists():
                    path_str = str(dir_path.resolve())
                    original_project_permissions.extend(
                        [f"{op}({path_str}/**)" for op in permission_ops]
                    )
            break

    security_settings = {
        "sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True},
        "permissions": {
            "defaultMode": "acceptEdits",  # Auto-approve edits within allowed directories
            "allow": [
                # Allow all file operations within the project directory
                # Include both relative (./**) and absolute paths for compatibility
                "Read(./**)",
                "Write(./**)",
                "Edit(./**)",
                "Glob(./**)",
                "Grep(./**)",
                # Also allow absolute paths (Claude sometimes uses full paths)
                f"Read({project_path_str}/**)",
                f"Write({project_path_str}/**)",
                f"Edit({project_path_str}/**)",
                f"Glob({project_path_str}/**)",
                f"Grep({project_path_str}/**)",
                # Allow spec directory explicitly (needed when spec is in worktree)
                f"Read({spec_path_str}/**)",
                f"Write({spec_path_str}/**)",
                f"Edit({spec_path_str}/**)",
                # Allow original project's _AUTO_CLAUDE_DIR/ and .worktrees/ directories
                # when running in a worktree (fixes issue #385 - permission errors)
                *original_project_permissions,
                # Bash permission granted here, but actual commands are validated
                # by the bash_security_hook (see security.py for allowed commands)
                "Bash(*)",
                # Allow web tools for documentation and research
                "WebFetch(*)",
                "WebSearch(*)",
                # Allow MCP tools based on required servers
                # Format: tool_name(*) allows all arguments
                *(
                    [f"{tool}(*)" for tool in CONTEXT7_TOOLS]
                    if "context7" in required_servers
                    else []
                ),
                *(
                    [f"{tool}(*)" for tool in LINEAR_TOOLS]
                    if "linear" in required_servers
                    else []
                ),
                *(
                    [f"{tool}(*)" for tool in GRAPHITI_MCP_TOOLS]
                    if graphiti_mcp_enabled
                    else []
                ),
                *[f"{tool}(*)" for tool in browser_tools_permissions],
            ],
        },
    }

    # Write settings to a file in the project directory
    settings_file = project_dir / ".claude_settings.json"
    with open(settings_file, "w", encoding="utf-8") as f:
        json.dump(security_settings, f, indent=2)

    print(f"Security settings: {settings_file}")
    print("   - Sandbox enabled (OS-level bash isolation)")
    print(f"   - Filesystem restricted to: {project_dir.resolve()}")
    if original_project_permissions:
        print("   - Worktree permissions: granted for original project directories")
    print("   - Bash commands restricted to allowlist")
    if max_thinking_tokens:
        print(f"   - Extended thinking: {max_thinking_tokens:,} tokens")
    else:
        print("   - Extended thinking: disabled")

    # Build list of MCP servers for display based on required_servers
    mcp_servers_list = []
    if "context7" in required_servers:
        mcp_servers_list.append("context7 (documentation)")
    if "electron" in required_servers:
        mcp_servers_list.append(
            f"electron (desktop automation, port {get_electron_debug_port()})"
        )
    if "puppeteer" in required_servers:
        mcp_servers_list.append("puppeteer (browser automation)")
    if "linear" in required_servers:
        mcp_servers_list.append("linear (project management)")
    if graphiti_mcp_enabled:
        mcp_servers_list.append("graphiti-memory (knowledge graph)")
    if "workpilot" in required_servers and auto_claude_tools_enabled:
        mcp_servers_list.append(f"workpilot ({agent_type} tools)")
    if mcp_servers_list:
        print(f"   - MCP servers: {', '.join(mcp_servers_list)}")
    else:
        print("   - MCP servers: none (minimal configuration)")

    # Show detected project capabilities for QA agents
    if agent_type in ("qa_reviewer", "qa_fixer") and any(project_capabilities.values()):
        caps = [
            k.replace("is_", "").replace("has_", "")
            for k, v in project_capabilities.items()
            if v
        ]
        print(f"   - Project capabilities: {', '.join(caps)}")
    print()

    # Configure MCP servers - ONLY start servers that are required
    # This is the key optimization to reduce context bloat and startup latency
    mcp_servers = {}

    if "context7" in required_servers:
        mcp_servers["context7"] = {
            "command": "npx",
            "args": ["-y", "@upstash/context7-mcp"],
        }

    if "electron" in required_servers:
        # Electron MCP for desktop apps
        # Electron app must be started with --remote-debugging-port=<port>
        mcp_servers["electron"] = {
            "command": "npm",
            "args": ["exec", "electron-mcp-server"],
        }

    if "puppeteer" in required_servers:
        # Puppeteer for web frontends (not Electron)
        mcp_servers["puppeteer"] = {
            "command": "npx",
            "args": ["puppeteer-mcp-server"],
        }

    if "chrome-devtools" in required_servers:
        # Chrome DevTools MCP for browser automation via Chrome DevTools Protocol
        # Connects to a running Chrome instance or launches a new one
        chrome_devtools_args = ["-y", "chrome-devtools-mcp@latest"]
        # Check if we should connect to an existing browser (e.g., app emulator)
        chrome_devtools_port = mcp_config.get(
            "CHROME_DEVTOOLS_PORT",
            os.environ.get("CHROME_DEVTOOLS_PORT", ""),
        )
        if chrome_devtools_port:
            chrome_devtools_args.append(
                f"--browser-url=http://127.0.0.1:{chrome_devtools_port}"
            )
        else:
            # Headless mode when no existing browser to connect to
            chrome_devtools_args.append("--headless")
        mcp_servers["chrome-devtools"] = {
            "command": "npx",
            "args": chrome_devtools_args,
        }

    if "linear" in required_servers:
        mcp_servers["linear"] = {
            "type": "http",
            "url": "https://mcp.linear.app/mcp",
            "headers": {"Authorization": f"Bearer {linear_api_key}"},
        }

    # Graphiti MCP server for knowledge graph memory
    if graphiti_mcp_enabled:
        mcp_servers["graphiti-memory"] = {
            "type": "http",
            "url": get_graphiti_mcp_url(),
        }

    if "github" in required_servers:
        github_pat = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
        if github_pat:
            mcp_servers["github"] = {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": github_pat},
            }

    if "brave-search" in required_servers:
        brave_api_key = os.environ.get("BRAVE_API_KEY", "")
        if brave_api_key:
            mcp_servers["brave-search"] = {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-brave-search"],
                "env": {"BRAVE_API_KEY": brave_api_key},
            }

    if "jira" in required_servers:
        jira_url = os.environ.get("JIRA_URL", "")
        jira_username = os.environ.get("JIRA_USERNAME", "")
        jira_api_token = os.environ.get("JIRA_API_TOKEN", "")
        if jira_url and jira_username and jira_api_token:
            mcp_servers["jira"] = {
                "command": "npx",
                "args": ["-y", "mcp-atlassian"],
                "env": {
                    "JIRA_URL": jira_url,
                    "JIRA_USERNAME": jira_username,
                    "JIRA_API_TOKEN": jira_api_token,
                },
            }

    if "azure-devops" in required_servers:
        ado_token = os.environ.get("AZURE_DEVOPS_TOKEN", "")
        ado_org = os.environ.get("AZURE_DEVOPS_ORG", "")
        if ado_token and ado_org:
            mcp_servers["azure-devops"] = {
                "command": "npx",
                "args": ["-y", "azure-devops-mcp"],
                "env": {
                    "AZURE_DEVOPS_TOKEN": ado_token,
                    "AZURE_DEVOPS_ORG": ado_org,
                },
            }

    if "sentry" in required_servers:
        sentry_token = os.environ.get("SENTRY_AUTH_TOKEN", "")
        if sentry_token:
            mcp_servers["sentry"] = {
                "command": "npx",
                "args": ["-y", "@sentry/mcp-server"],
                "env": {"SENTRY_AUTH_TOKEN": sentry_token},
            }

    if "slack" in required_servers:
        slack_token = os.environ.get("SLACK_BOT_TOKEN", "")
        if slack_token:
            mcp_servers["slack"] = {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-slack"],
                "env": {"SLACK_BOT_TOKEN": slack_token},
            }

    if "postman" in required_servers:
        postman_api_key = os.environ.get("POSTMAN_API_KEY", "")
        if postman_api_key:
            mcp_servers["postman"] = {
                "command": "npx",
                "args": ["-y", "@postman/mcp-postman"],
                "env": {"POSTMAN_API_KEY": postman_api_key},
            }

    if "teams" in required_servers:
        teams_webhook_url = os.environ.get("TEAMS_WEBHOOK_URL", "")
        if teams_webhook_url:
            mcp_servers["teams"] = {
                "command": "npx",
                "args": ["-y", "teams-mcp-server"],
                "env": {"TEAMS_WEBHOOK_URL": teams_webhook_url},
            }

    # Add custom workpilot MCP server if required and available
    if "workpilot" in required_servers and auto_claude_tools_enabled:
        auto_claude_mcp_server = create_auto_claude_mcp_server(spec_dir, project_dir)
        if auto_claude_mcp_server:
            mcp_servers["workpilot"] = auto_claude_mcp_server

    # Add custom MCP servers from project config
    custom_servers = mcp_config.get("CUSTOM_MCP_SERVERS", [])
    for custom in custom_servers:
        server_id = custom.get("id")
        if not server_id:
            continue
        # Only include if agent has it in their effective server list
        if server_id not in required_servers:
            continue
        server_type = custom.get("type", "command")
        if server_type == "command":
            mcp_servers[server_id] = {
                "command": custom.get("command", "npx"),
                "args": custom.get("args", []),
            }
        elif server_type == "http":
            server_config = {
                "type": "http",
                "url": custom.get("url", ""),
            }
            if custom.get("headers"):
                server_config["headers"] = custom["headers"]
            mcp_servers[server_id] = server_config

    # Build system prompt
    base_prompt = (
        f"You are an expert full-stack developer building production-quality software. "
        f"Your working directory is: {project_dir.resolve()}\n"
        f"Your filesystem access is RESTRICTED to this directory only. "
        f"Use relative paths (starting with ./) for all file operations. "
        f"Never use absolute paths or try to access files outside your working directory.\n\n"
        f"You follow existing code patterns, write clean maintainable code, and verify "
        f"your work through thorough testing. You communicate progress through Git commits "
        f"and build-progress.txt updates."
    )

    # CLAUDE.md loading strategy: hybrid (setting_sources + manual fallback).
    #
    # Primary path: `setting_sources=["project","user","local"]` (added below to
    # ClaudeAgentOptions) lets the SDK natively load <cwd>/CLAUDE.md,
    # <cwd>/.claude/CLAUDE.md, project rules, and skills with proper prompt-cache
    # prefix handling — no manual concatenation needed.
    #
    # Fallback: if the SDK can't find a CLAUDE.md (e.g. user disabled the
    # "project" setting source, or CLAUDE.md lives at an unusual path), we
    # still inject it manually into the system prompt when USE_CLAUDE_MD=true.
    # This preserves the historical behavior for projects that rely on it.
    if should_use_claude_md():
        # SDK-native loading path expects CLAUDE.md at <cwd>/CLAUDE.md or
        # <cwd>/.claude/CLAUDE.md. If found there, skip manual injection so
        # the SDK can cache the prefix once across cards.
        sdk_native_paths = [
            project_dir / "CLAUDE.md",
            project_dir / ".claude" / "CLAUDE.md",
        ]
        sdk_will_load = any(p.exists() for p in sdk_native_paths)
        if sdk_will_load:
            print("   - CLAUDE.md: loaded via setting_sources (SDK-native, cached)")
        else:
            claude_md_content = load_claude_md(project_dir)
            if claude_md_content:
                base_prompt = f"{base_prompt}\n\n# Project Instructions (from CLAUDE.md)\n\n{claude_md_content}"
                print("   - CLAUDE.md: injected manually (fallback)")
            else:
                print("   - CLAUDE.md: not found in project root")
    else:
        print("   - CLAUDE.md: disabled by project settings")

    base_prompt = _inject_domain_addendum(base_prompt, agent_type, spec_dir)

    print()

    # Build options dict, conditionally including output_format
    options_kwargs: dict[str, Any] = {
        "model": model,
        "system_prompt": base_prompt,
        "allowed_tools": allowed_tools_list,
        "mcp_servers": mcp_servers,
        "hooks": {
            "PreToolUse": [
                HookMatcher(matcher="Bash", hooks=[bash_security_hook]),
                HookMatcher(
                    matcher="Bash",
                    hooks=[_make_guardrails_hook(project_dir)],
                ),
                HookMatcher(
                    matcher="Write",
                    hooks=[_make_guardrails_hook(project_dir)],
                ),
                HookMatcher(
                    matcher="Edit",
                    hooks=[_make_guardrails_hook(project_dir)],
                ),
            ],
            "PreCompact": [HookMatcher(hooks=[_make_pre_compact_hook(spec_dir)])],
            "Stop": [HookMatcher(hooks=[_make_stop_hook(spec_dir)])],
        },
        "max_turns": int(os.environ.get("AUTO_CLAUDE_MAX_TURNS", "1000")),
        # Budget cap as a meaningful runaway guard. The error path
        # (`error_max_budget_usd`) is already handled in agents/session.py.
        # Default tuned for typical Kanban cards; users can raise via env.
        "max_budget_usd": float(os.environ.get("AUTO_CLAUDE_MAX_BUDGET_USD", "5.0")),
        "cwd": str(project_dir.resolve()),
        "settings": str(settings_file.resolve()),
        # setting_sources auto-loads CLAUDE.md, project rules, skills, and
        # filesystem-defined hooks from ~/.claude (user), <cwd>/.claude (project),
        # and .claude/settings.local.json (local). The SDK handles prompt-cache
        # prefixing automatically for these sources.
        # See: code.claude.com/docs/en/agent-sdk/claude-code-features
        "setting_sources": ["project", "user", "local"],
        "env": sdk_env,  # Pass ANTHROPIC_BASE_URL etc. to subprocess
        "max_thinking_tokens": max_thinking_tokens,  # Extended thinking budget
        "max_buffer_size": 10
        * 1024
        * 1024,  # 10MB buffer (default: 1MB) - fixes large tool results
        # Enable file checkpointing to track file read/write state across tool calls
        # This prevents "File has not been read yet" errors in recovery sessions
        "enable_file_checkpointing": True,
    }

    # Optional: Allow CLI path override via environment variable
    # The SDK bundles its own CLI, but users can override if needed
    env_cli_path = os.environ.get("CLAUDE_CLI_PATH")
    if env_cli_path and validate_cli_path(env_cli_path):
        options_kwargs["cli_path"] = env_cli_path
        logger.info(f"Using CLAUDE_CLI_PATH override: {env_cli_path}")

    # Add structured output format if specified
    # See: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
    if output_format:
        options_kwargs["output_format"] = output_format

    # Merge phase-appropriate default subagents with any caller-supplied ones.
    # Caller wins on key collision so a specific run can override defaults.
    # The set is chosen by agent_type so the planner doesn't waste context on
    # QA subagents and vice versa.
    # See: code.claude.com/docs/en/agent-sdk/subagents
    try:
        if agent_type in ("qa_reviewer", "qa_fixer", "qa"):
            from agents.qa_subagents import (
                merge_with_user_agents as _merge_phase_agents,
            )
        elif agent_type in ("planner", "architect"):
            from agents.planner_subagents import (
                merge_with_user_agents as _merge_phase_agents,
            )
        else:
            from agents.kanban_subagents import (
                merge_with_user_agents as _merge_phase_agents,
            )

        _merged_agents = _merge_phase_agents(agents)
    except Exception:
        _merged_agents = agents
    if _merged_agents:
        options_kwargs["agents"] = _merged_agents
        # Subagents are invoked via the built-in "Agent" tool — it must be
        # allowlisted, otherwise the SDK rejects the invocation. We mutate the
        # allowed_tools list in-place because it's already inside options_kwargs.
        _allowed = options_kwargs.get("allowed_tools") or []
        if "Agent" not in _allowed:
            _allowed.append("Agent")
            options_kwargs["allowed_tools"] = _allowed

    # Resume a prior SDK session if a session_id was provided. The SDK reads
    # the on-disk transcript at ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
    # and rehydrates context, saving the cost of replaying earlier turns.
    # Resolution order: explicit kwarg > env var > none. The env var path is
    # how the frontend's "Reprendre" button signals a session resume: it spawns
    # the subprocess with AUTO_CLAUDE_RESUME_SESSION_ID set, and the value MUST
    # be consumed exactly once for this client — leaving the env var set across
    # iterations of the coder loop made every subsequent session re-rehydrate
    # the same on-disk transcript, which is what caused the
    # "Continuing implementation… / Prompt is too long" cascade once the
    # transcript grew past the model's context window.
    # See: code.claude.com/docs/en/agent-sdk/sessions
    _resume_id = resume or os.environ.get("AUTO_CLAUDE_RESUME_SESSION_ID")
    if _resume_id:
        options_kwargs["resume"] = _resume_id
        logger.info(f"Resuming Claude SDK session: {_resume_id}")
        # Pop the env var so the NEXT iteration creates a fresh session instead
        # of re-replaying the same transcript. Explicit `resume=` kwargs still
        # work — they're per-call, not process-wide.
        os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)

    # Permission mode hardening for read-only phases. "plan" lets Claude
    # explore and reason but refuses every write/exec tool call — a strong
    # defense-in-depth complement to the tools allowlist. We only enable it
    # for phases that have no business modifying files anyway.
    # See: code.claude.com/docs/en/agent-sdk/permissions
    _readonly_phases = {
        "analyzer",
        "spec_critic",
        "spec_validation",
        "spec_context",
        "spec_discovery",
        "pr_reviewer",
        "pr_orchestrator_parallel",
        "insights",
    }
    if agent_type in _readonly_phases and "permission_mode" not in options_kwargs:
        options_kwargs["permission_mode"] = "plan"

    # Reasoning effort, gated on Opus 4.x (only Opus models support this param).
    # Docs recommend "xhigh" on Opus 4.7 for coding/agentic tasks; cheaper
    # phases get "low" to save tokens. Env var override wins so a user can
    # force a level for debugging.
    # See: code.claude.com/docs/en/agent-sdk/agent-loop#effort-level
    if "opus" in (model or "").lower():
        _effort_map = {
            "explorer": "low",
            "spec_gatherer": "low",
            "lint": "low",
            "status": "low",
            "documenter": "medium",
            "qa_reviewer": "high",
            "qa_fixer": "high",
            "validation": "high",
            "planner": "xhigh",
            "architect": "xhigh",
            "coder": "xhigh",
            "dev": "xhigh",
        }
        _effort = os.environ.get("AUTO_CLAUDE_EFFORT") or _effort_map.get(
            agent_type, "high"
        )
        options_kwargs["effort"] = _effort
        print(f"   - Effort: {_effort} (agent_type={agent_type}, model=opus)")

    return ClaudeSDKClient(options=ClaudeAgentOptions(**options_kwargs))


# =============================================================================
# Provider-Agnostic Agent Client Factory
# =============================================================================


# Filename for the single-shot "resume task X under provider Y" marker. The
# frontend writes this when the user picks a different provider from the
# paused-task modal. _get_active_provider() consumes it on the very next
# session start and deletes the file so it doesn't keep overriding.
RESUME_WITH_PROVIDER_FILE = "RESUME_WITH_PROVIDER"


def _consume_resume_with_provider_marker(spec_dir: Path) -> str | None:
    """Read and remove the RESUME_WITH_PROVIDER marker, returning the provider
    name the user picked (or None if no marker exists).

    The file can be either plain text containing the provider id
    (``copilot``) or JSON ``{"provider": "copilot"}``. Anything else is
    treated as no override and the file is left in place for inspection.

    Failures here must NEVER prevent session startup — log and return None.
    """
    marker = spec_dir / RESUME_WITH_PROVIDER_FILE
    if not marker.exists():
        return None
    try:
        raw = marker.read_text(encoding="utf-8").strip()
        if not raw:
            marker.unlink(missing_ok=True)
            return None
        # Try JSON first, fall back to plain text.
        provider: str | None
        try:
            import json as _json

            data = _json.loads(raw)
            provider = (
                str(data.get("provider", "")).strip()
                if isinstance(data, dict)
                else None
            )
        except Exception:
            provider = raw
        marker.unlink(missing_ok=True)  # single-shot
        return provider or None
    except Exception as e:
        logger.warning("[_get_active_provider] could not read %s: %s", marker, e)
        return None


def _get_active_provider(spec_dir: Path | None = None) -> str:
    """
    Determine the active AI provider from IPC selection, environment or project settings.

    Resolution order:
    0. RESUME_WITH_PROVIDER marker file (single-shot, "Reprendre avec X")
    1. Provider selected via IPC (from frontend UI selection)
    2. AUTO_CLAUDE_PROVIDER environment variable
    3. Project-level _AUTO_CLAUDE_DIR/.env → AI_PROVIDER key
    4. Default: "claude"

    Args:
        spec_dir: Optional spec directory to check for project-level settings.

    Returns:
        Provider identifier string: "claude", "copilot", "openai", etc.
    """
    # Provider name mapping (shared across all resolution strategies)
    provider_mapping = {
        "anthropic": "claude",
        "claude": "claude",
        "copilot": "copilot",
        "openai": "openai",
        "google": "google",
        "ollama": "ollama",
        "meta": "meta",
        "mistral": "mistral",
        "deepseek": "deepseek",
        "grok": "grok",
        "aws": "aws",
        "windsurf": "windsurf",
        "cursor": "cursor",
        "custom": "custom",
    }

    # 0. Highest priority: explicit "resume with X" marker written by the
    # frontend when the user picked a different provider from the paused-task
    # modal (Niveau 3b). Consumed once and removed so subsequent sessions
    # for the same spec don't keep overriding.
    if spec_dir:
        override = _consume_resume_with_provider_marker(Path(spec_dir))
        if override:
            mapped_override = provider_mapping.get(override.lower(), override.lower())
            logger.info(
                "[_get_active_provider] Resolved from RESUME_WITH_PROVIDER marker: "
                "'%s' -> '%s'",
                override,
                mapped_override,
            )
            return mapped_override

    # 1. Check provider selected via IPC (from frontend UI)
    try:
        from provider_api import get_selected_provider

        selected_provider = get_selected_provider()
        if selected_provider:
            mapped_provider = provider_mapping.get(
                selected_provider.lower(), selected_provider.lower()
            )
            if mapped_provider:
                return mapped_provider
    except Exception:
        # Fallback to other methods if IPC provider check fails
        pass

    # 1.5. Check SELECTED_LLM_PROVIDER env var (set by frontend credential manager)
    selected_env = os.environ.get("SELECTED_LLM_PROVIDER", "").lower().strip()
    if selected_env and selected_env in provider_mapping:
        resolved = provider_mapping.get(selected_env, selected_env)
        logger.info(
            f"[_get_active_provider] Resolved provider from SELECTED_LLM_PROVIDER env var: '{selected_env}' -> '{resolved}'"
        )
        return resolved

    # 1.7. Check task_metadata.json for provider.
    # This handles the case where the frontend has a non-Claude provider stored in the
    # task's metadata (e.g. "copilot") but has not set SELECTED_LLM_PROVIDER in the
    # subprocess environment (because settings.json.selectedProvider is null — i.e. the
    # user never explicitly clicked "select" in the provider UI after authenticating).
    if spec_dir:
        try:
            import json as _json

            metadata_path = Path(spec_dir) / "task_metadata.json"
            if not metadata_path.exists():
                # spec_dir may be e.g. _AUTO_CLAUDE_DIR/specs/001-name — try parent dirs
                for parent in Path(spec_dir).parents:
                    candidate = parent / "task_metadata.json"
                    if candidate.exists():
                        metadata_path = candidate
                        break
            if metadata_path.exists():
                with open(metadata_path, encoding="utf-8") as _f:
                    _meta = _json.load(_f)
                _meta_provider = _meta.get("provider", "").lower().strip()
                if _meta_provider and _meta_provider in provider_mapping:
                    _mapped = provider_mapping[_meta_provider]
                    logger.info(
                        f"[_get_active_provider] Resolved from task_metadata.json: "
                        f"'{_meta_provider}' -> '{_mapped}'"
                    )
                    return _mapped
        except Exception:
            logger.debug(
                "Could not read provider from task_metadata.json", exc_info=True
            )

    # 2. Environment variable override
    env_provider = os.environ.get("AUTO_CLAUDE_PROVIDER", "").lower().strip()
    if env_provider in (
        "claude",
        "copilot",
        "openai",
        "google",
        "ollama",
        "meta",
        "mistral",
        "deepseek",
        "grok",
        "aws",
        "windsurf",
        "cursor",
        "custom",
    ):
        return env_provider

    # 3. Project-level setting from spec's parent project
    if spec_dir:
        env_path = spec_dir / _AUTO_CLAUDE_DIR / ".env"
        if not env_path.exists():
            # Try parent directories (spec_dir might be inside _AUTO_CLAUDE_DIR/)
            for parent in spec_dir.parents:
                candidate = parent / _AUTO_CLAUDE_DIR / ".env"
                if candidate.exists():
                    env_path = candidate
                    break

        if env_path.exists():
            try:
                with open(env_path, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("AI_PROVIDER="):
                            value = line.split("=", 1)[1].strip().strip("\"'").lower()
                            if value in (
                                "claude",
                                "copilot",
                                "openai",
                                "google",
                                "ollama",
                                "meta",
                                "mistral",
                                "deepseek",
                                "grok",
                                "aws",
                                "windsurf",
                                "cursor",
                                "custom",
                            ):
                                return value
            except Exception:
                pass

    # 4. Default
    return "claude"


def create_agent_client(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    agent_type: str = "coder",
    max_thinking_tokens: int | None = None,
    output_format: dict | None = None,
    agents: dict | None = None,
    provider: str | None = None,
    resume: str | None = None,
) -> "AgentClient":  # noqa: F821
    """
    Create a provider-agnostic agent client for Kanban task execution.

    This is the **preferred entry point** for creating agent clients.
    It returns an `AgentClient` instance that abstracts the underlying
    provider (Claude SDK or GitHub Copilot).

    Args:
        project_dir: Root directory for the project (working directory)
        spec_dir: Directory containing the spec (for settings file)
        model: Model identifier (e.g., "claude-sonnet-4-5-20250929" or "gpt-4o")
        agent_type: Agent type from AGENT_CONFIGS
        max_thinking_tokens: Token budget for extended thinking
        output_format: Optional structured output format
        agents: Optional dict of subagent definitions.
               For Claude: passed as claude_agent_sdk.AgentDefinition objects
               For Copilot: converted to SubagentDefinition for parallel API calls
        provider: Provider override ("claude" or "copilot").
                 If None, auto-detected from env/project settings.

    Returns:
        AgentClient instance (ClaudeAgentClient or CopilotAgentClient)

    Raises:
        ValueError: If agent_type is unknown or provider is unsupported
    """
    from core.agent_client import (
        ClaudeAgentClient,
        CopilotAgentClient,
        SubagentDefinition,
    )

    # Normalize to Path objects in case strings are passed
    if isinstance(project_dir, str):
        project_dir = Path(project_dir)
    if isinstance(spec_dir, str):
        spec_dir = Path(spec_dir)

    # Resolve provider
    if provider is None:
        provider = _get_active_provider(spec_dir)

    logger.info(
        f"Creating agent client: provider={provider}, agent_type={agent_type}, model={model}"
    )

    if provider == "copilot":
        # Build system prompt (reuse logic from create_client)
        base_prompt = (
            f"You are an expert full-stack developer building production-quality software. "
            f"Your working directory is: {project_dir.resolve()}\n"
            f"Your filesystem access is RESTRICTED to this directory only. "
            f"Use relative paths (starting with ./) for all file operations. "
            f"Never use absolute paths or try to access files outside your working directory.\n\n"
            f"You follow existing code patterns, write clean maintainable code, and verify "
            f"your work through thorough testing. You communicate progress through Git commits "
            f"and build-progress.txt updates."
        )
        base_prompt = _inject_domain_addendum(base_prompt, agent_type, spec_dir)

        # Convert agents dict to SubagentDefinition if provided
        copilot_agents: dict[str, SubagentDefinition] | None = None
        if agents:
            copilot_agents = {}
            for name, defn in agents.items():
                # Handle both AgentDefinition (Claude SDK) and dict formats
                if hasattr(defn, "description"):
                    copilot_agents[name] = SubagentDefinition(
                        description=getattr(defn, "description", ""),
                        prompt=getattr(defn, "prompt", ""),
                        tools=getattr(defn, "tools", []),
                        model=getattr(defn, "model", "inherit"),
                    )
                elif isinstance(defn, dict):
                    copilot_agents[name] = SubagentDefinition(**defn)

        # Get allowed tools for the agent type
        _, project_capabilities = _get_cached_project_data(project_dir)
        from linear_updater import is_linear_enabled as _is_linear_enabled

        mcp_config = load_project_mcp_config(project_dir)
        allowed_tools_list = get_allowed_tools(
            agent_type, project_capabilities, _is_linear_enabled(), mcp_config
        )

        return CopilotAgentClient(
            model=model,
            system_prompt=base_prompt,
            allowed_tools=allowed_tools_list,
            agents=copilot_agents,
            cwd=str(project_dir.resolve()),
            agent_type=agent_type,
        )

    elif provider == "claude":
        # Default: use existing create_client() and wrap in ClaudeAgentClient
        sdk_client = create_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            agent_type=agent_type,
            max_thinking_tokens=max_thinking_tokens,
            output_format=output_format,
            agents=agents,
            resume=resume,
        )
        return ClaudeAgentClient(sdk_client)

    elif provider == "windsurf":
        # Windsurf (Codeium) — dual-mode:
        # Mode 1: gRPC to local Windsurf IDE language server (tool execution
        #         via text-based tool calling — consumes Windsurf credits)
        # Mode 2: REST API with OpenAI-compatible function calling
        #
        # sk-ws-* keys are IDE session keys that work through the local
        # Windsurf language server (gRPC).  WindsurfAgentClient automatically
        # detects these keys and routes to gRPC mode with text-based tool
        # execution so that Windsurf credits are consumed.
        from core.agent_client import WindsurfAgentClient

        # Build system prompt (same pattern as CopilotAgentClient)
        windsurf_system_prompt = (
            f"You are an expert full-stack developer building production-quality software. "
            f"Your working directory is: {project_dir.resolve()}\n"
            f"Your filesystem access is RESTRICTED to this directory only. "
            f"Use relative paths (starting with ./) for all file operations. "
            f"Never use absolute paths or try to access files outside your working directory.\n\n"
            f"You follow existing code patterns, write clean maintainable code, and verify "
            f"your work through thorough testing. You communicate progress through Git commits "
            f"and build-progress.txt updates.\n\n"
            f"You MUST use the provided tools (read_file, write_file, list_files, run_command) "
            f"to interact with the filesystem and execute commands. Do not just describe what to do — "
            f"actually do it by calling the tools."
        )
        windsurf_system_prompt = _inject_domain_addendum(
            windsurf_system_prompt, agent_type, spec_dir
        )

        logger.info(
            "[create_agent_client] Using WindsurfAgentClient "
            "(gRPC for sk-ws-* keys / REST for SSO keys, model=%s, agent_type=%s)",
            model,
            agent_type,
        )
        return WindsurfAgentClient(
            model=model,
            system_prompt=windsurf_system_prompt,
            max_turns=50,
            project_dir=str(project_dir),
            agent_type=agent_type,
        )

    elif provider == "openai":
        from core.agent_client import OpenAIAgentClient

        openai_system_prompt = (
            f"You are an expert full-stack developer building production-quality software. "
            f"Your working directory is: {project_dir.resolve()}\n"
            f"Your filesystem access is RESTRICTED to this directory only. "
            f"Use relative paths (starting with ./) for all file operations. "
            f"Never use absolute paths or try to access files outside your working directory.\n\n"
            f"You follow existing code patterns, write clean maintainable code, and verify "
            f"your work through thorough testing. You communicate progress through Git commits "
            f"and build-progress.txt updates.\n\n"
            f"You MUST use the provided tools (read_file, write_file, list_files, run_command) "
            f"to interact with the filesystem and execute commands. Do not just describe what to do — "
            f"actually do it by calling the tools."
        )
        openai_system_prompt = _inject_domain_addendum(
            openai_system_prompt, agent_type, spec_dir
        )

        logger.info(
            "[create_agent_client] Using OpenAIAgentClient (model=%s, agent_type=%s)",
            model,
            agent_type,
        )
        return OpenAIAgentClient(
            model=model or "gpt-4o",
            system_prompt=openai_system_prompt,
            max_turns=50,
            project_dir=str(project_dir),
            agent_type=agent_type,
        )

    else:
        # For other providers (google, ollama, etc.), fall back to Claude SDK
        logger.warning(
            f"Provider '{provider}' not directly supported, falling back to Claude SDK with provider selection"
        )
        sdk_client = create_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            agent_type=agent_type,
            max_thinking_tokens=max_thinking_tokens,
            output_format=output_format,
            agents=agents,
        )
        return ClaudeAgentClient(sdk_client)
