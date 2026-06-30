"""
MCP tool bridge for the OpenAI-compatible agent loop
====================================================

Lets the generic OpenAI-style clients (OpenAI / Google / **local LLM**) consume
configured MCP servers — the same servers the Claude SDK path already uses via
``CUSTOM_MCP_SERVERS``. Each MCP tool is surfaced as an OpenAI function
definition (namespaced ``mcp__<server>__<tool>``) and calls are routed back to
the owning MCP session.

Why this exists: ``LocalAgentClient`` (and its OpenAI/Google siblings) run a
fixed local ``ToolExecutor`` and previously ignored MCP entirely, so a local
LLM could never use e.g. the Hugging Face MCP's ``model_search`` during a task.

Server configuration is read from the canonical backend channel:
  1. ``CUSTOM_MCP_SERVERS`` env var (JSON array), and
  2. the project ``.workpilot/.env`` ``CUSTOM_MCP_SERVERS`` entry.

Each entry is ``{"id"|"name", "type": "command"|"http", ...}``:
  - command: ``command`` (+ optional ``args``)
  - http:    ``url`` (+ optional ``headers``)

The whole bridge is best-effort: a server that fails to connect is skipped with
a warning, never breaking the agent loop.
"""

from __future__ import annotations

import json
import logging
import os
import re
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Namespacing keeps MCP tool names from colliding with the built-in toolset and
# tells the agent loop which calls to route to MCP. OpenAI tool names must match
# ^[A-Za-z0-9_-]+$, so server/tool ids are sanitized into that charset.
MCP_TOOL_PREFIX = "mcp__"

_VALID_TYPES = {"command", "http"}


def _sanitize(name: str) -> str:
    """Coerce an id into the OpenAI tool-name charset ([A-Za-z0-9_-])."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name or "")


def _validate_server(entry: object) -> dict[str, Any] | None:
    """Minimal, dependency-free validation of one server config entry."""
    if not isinstance(entry, dict):
        return None
    stype = entry.get("type")
    if stype not in _VALID_TYPES:
        return None
    if stype == "command" and not isinstance(entry.get("command"), str):
        return None
    if stype == "http" and not isinstance(entry.get("url"), str):
        return None
    return entry


def _parse_custom_mcp_servers(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.warning("[mcp] CUSTOM_MCP_SERVERS is not valid JSON — ignoring")
        return []
    if not isinstance(parsed, list):
        return []
    return [s for s in (_validate_server(e) for e in parsed) if s]


def _read_project_env_servers(project_dir: str | None) -> list[dict[str, Any]]:
    """Read CUSTOM_MCP_SERVERS from the project's .workpilot/.env, if present."""
    if not project_dir:
        return []
    env_path = Path(project_dir) / ".workpilot" / ".env"
    if not env_path.exists():
        return []
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("CUSTOM_MCP_SERVERS="):
                value = line.split("=", 1)[1].strip().strip("\"'")
                return _parse_custom_mcp_servers(value)
    except OSError:
        logger.debug("[mcp] could not read %s", env_path, exc_info=True)
    return []


def load_mcp_server_configs(project_dir: str | None) -> list[dict[str, Any]]:
    """Resolve configured MCP servers (env var first, then project .env)."""
    servers = _parse_custom_mcp_servers(os.environ.get("CUSTOM_MCP_SERVERS"))
    if servers:
        return servers
    return _read_project_env_servers(project_dir)


def _server_id(entry: dict[str, Any], index: int) -> str:
    raw = entry.get("id") or entry.get("name") or f"server{index}"
    return _sanitize(str(raw)) or f"server{index}"


def _result_to_text(result: Any) -> str:
    """Flatten an MCP CallToolResult into plain text for the agent transcript."""
    content = getattr(result, "content", None)
    if content is None and isinstance(result, dict):
        content = result.get("content")
    if not content:
        # Some servers return structured content only.
        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            try:
                return json.dumps(structured, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(structured)
        return ""
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text is not None:
            parts.append(str(text))
        else:
            # Non-text block (image/resource) — emit a compact marker.
            btype = getattr(block, "type", None) or (
                block.get("type") if isinstance(block, dict) else "content"
            )
            parts.append(f"[{btype}]")
    return "\n".join(parts)


class MCPToolManager:
    """Connects to configured MCP servers and bridges their tools.

    Use as an async context manager (or call ``connect()`` / ``aclose()``):

        async with MCPToolManager(project_dir, servers) as mcp:
            defs = mcp.tool_definitions()   # OpenAI function defs
            if mcp.has_tool(name):
                text = await mcp.call(name, args)
    """

    def __init__(
        self, project_dir: str | None, servers: list[dict[str, Any]] | None = None
    ):
        self._project_dir = project_dir
        self._servers = (
            servers if servers is not None else load_mcp_server_configs(project_dir)
        )
        self._stack: AsyncExitStack | None = None
        self._defs: list[dict[str, Any]] = []
        # full tool name -> (session, real_tool_name)
        self._route: dict[str, tuple[Any, str]] = {}

    async def __aenter__(self) -> MCPToolManager:
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def connect(self) -> None:
        if not self._servers:
            return
        self._stack = AsyncExitStack()
        for index, cfg in enumerate(self._servers):
            sid = _server_id(cfg, index)
            try:
                session = await self._open_session(cfg)
                await session.initialize()
                listed = await session.list_tools()
                tools = getattr(listed, "tools", None) or []
                for tool in tools:
                    tname = getattr(tool, "name", None)
                    if not tname:
                        continue
                    full = f"{MCP_TOOL_PREFIX}{sid}__{_sanitize(tname)}"
                    schema = getattr(tool, "inputSchema", None) or {
                        "type": "object",
                        "properties": {},
                    }
                    self._defs.append(
                        {
                            "name": full,
                            "description": (
                                getattr(tool, "description", None)
                                or f"{tname} (MCP: {sid})"
                            ),
                            "parameters": schema,
                        }
                    )
                    self._route[full] = (session, tname)
                logger.info(
                    "[mcp] connected to '%s' — %d tool(s) bridged", sid, len(tools)
                )
            except Exception as e:  # noqa: BLE001 — one bad server must not break the loop
                logger.warning("[mcp] could not connect to server '%s': %s", sid, e)

    async def _open_session(self, cfg: dict[str, Any]) -> Any:
        """Open and enter an MCP ClientSession for one server config."""
        from mcp import ClientSession  # noqa: PLC0415

        assert self._stack is not None
        if cfg.get("type") == "http":
            from mcp.client.streamable_http import (  # noqa: PLC0415
                streamablehttp_client,
            )

            transport = await self._stack.enter_async_context(
                streamablehttp_client(cfg["url"], headers=cfg.get("headers"))
            )
            # (read, write, get_session_id)
            read, write = transport[0], transport[1]
        else:  # command / stdio
            from mcp import StdioServerParameters  # noqa: PLC0415
            from mcp.client.stdio import stdio_client  # noqa: PLC0415

            params = StdioServerParameters(
                command=cfg["command"],
                args=cfg.get("args", []) or [],
                env={**os.environ, **(cfg.get("env") or {})},
            )
            read, write = await self._stack.enter_async_context(stdio_client(params))

        return await self._stack.enter_async_context(ClientSession(read, write))

    def tool_definitions(self) -> list[dict[str, Any]]:
        return list(self._defs)

    def has_tool(self, name: str) -> bool:
        return name in self._route

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        session, real = self._route[name]
        result = await session.call_tool(real, arguments or {})
        if getattr(result, "isError", False):
            return f"MCP tool error: {_result_to_text(result) or name}"
        return _result_to_text(result)

    async def aclose(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception:  # noqa: BLE001 — best-effort teardown
                logger.debug("[mcp] error during teardown", exc_info=True)
            self._stack = None
        self._defs.clear()
        self._route.clear()
