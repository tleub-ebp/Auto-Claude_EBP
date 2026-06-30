#!/usr/bin/env python3
"""
Tests for the MCP tool bridge (core/mcp_tools.py)
=================================================

Covers config parsing/validation, id sanitization, result flattening, and the
manager's def-building + call routing — using a fake MCP session so no real
server is contacted.
"""

import json

import pytest
from core.mcp_tools import (
    MCP_TOOL_PREFIX,
    MCPToolManager,
    _parse_custom_mcp_servers,
    _result_to_text,
    _sanitize,
    load_mcp_server_configs,
)


class TestConfigParsing:
    def test_parses_valid_http_and_command(self):
        raw = json.dumps(
            [
                {"id": "hf", "type": "http", "url": "https://huggingface.co/mcp"},
                {"id": "fs", "type": "command", "command": "npx"},
            ]
        )
        servers = _parse_custom_mcp_servers(raw)
        assert len(servers) == 2

    def test_drops_invalid_entries(self):
        raw = json.dumps(
            [
                {"id": "ok", "type": "http", "url": "http://x"},
                {"id": "bad-type", "type": "websocket", "url": "http://x"},
                {"id": "http-no-url", "type": "http"},
                {"id": "cmd-no-command", "type": "command"},
                "not-an-object",
            ]
        )
        servers = _parse_custom_mcp_servers(raw)
        assert len(servers) == 1
        assert servers[0]["id"] == "ok"

    def test_invalid_json_is_ignored(self):
        assert _parse_custom_mcp_servers("{not json") == []
        assert _parse_custom_mcp_servers(None) == []

    def test_load_prefers_env_var(self, monkeypatch):
        monkeypatch.setenv(
            "CUSTOM_MCP_SERVERS",
            json.dumps([{"id": "hf", "type": "http", "url": "http://x"}]),
        )
        servers = load_mcp_server_configs(None)
        assert len(servers) == 1
        assert servers[0]["id"] == "hf"


class TestHelpers:
    def test_sanitize(self):
        assert _sanitize("hugging.face/mcp") == "hugging_face_mcp"
        assert _sanitize("model_search-1") == "model_search-1"

    def test_result_to_text_from_text_blocks(self):
        class _Block:
            def __init__(self, text):
                self.text = text

        class _Result:
            content = [_Block("line1"), _Block("line2")]
            isError = False

        assert _result_to_text(_Result()) == "line1\nline2"

    def test_result_to_text_from_dict_blocks(self):
        result = {"content": [{"type": "text", "text": "hello"}]}
        assert _result_to_text(result) == "hello"


# ---------------------------------------------------------------------------
# Manager with a fake MCP session (no network / no real server)
# ---------------------------------------------------------------------------


class _FakeTool:
    def __init__(self, name, description="", input_schema=None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema or {"type": "object", "properties": {}}


class _FakeListResult:
    def __init__(self, tools):
        self.tools = tools


class _FakeTextBlock:
    def __init__(self, text):
        self.text = text


class _FakeCallResult:
    def __init__(self, text, is_error=False):
        self.content = [_FakeTextBlock(text)]
        self.isError = is_error


class _FakeSession:
    def __init__(self):
        self.calls = []

    async def initialize(self):
        return None

    async def list_tools(self):
        return _FakeListResult(
            [
                _FakeTool(
                    "model_search",
                    "Search the Hub",
                    {"type": "object", "properties": {"query": {"type": "string"}}},
                ),
                _FakeTool("model_details"),
            ]
        )

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "model_search":
            return _FakeCallResult("Qwen/Qwen2.5-Coder-7B-Instruct")
        return _FakeCallResult("boom", is_error=True)


@pytest.mark.asyncio
async def test_manager_bridges_and_routes(monkeypatch):
    fake = _FakeSession()

    async def _fake_open(self, _cfg):
        return fake

    monkeypatch.setattr(MCPToolManager, "_open_session", _fake_open)

    servers = [{"id": "hf", "type": "http", "url": "https://huggingface.co/mcp"}]
    async with MCPToolManager(project_dir=None, servers=servers) as mcp:
        defs = mcp.tool_definitions()
        names = {d["name"] for d in defs}
        assert f"{MCP_TOOL_PREFIX}hf__model_search" in names
        assert f"{MCP_TOOL_PREFIX}hf__model_details" in names

        # The model_search def keeps the server's input schema.
        search_def = next(
            d for d in defs if d["name"] == f"{MCP_TOOL_PREFIX}hf__model_search"
        )
        assert "query" in search_def["parameters"]["properties"]

        assert mcp.has_tool(f"{MCP_TOOL_PREFIX}hf__model_search")
        assert not mcp.has_tool("read_file")

        # Routing strips the namespace and forwards to the real tool name.
        text = await mcp.call(f"{MCP_TOOL_PREFIX}hf__model_search", {"query": "qwen"})
        assert text == "Qwen/Qwen2.5-Coder-7B-Instruct"
        assert fake.calls == [("model_search", {"query": "qwen"})]

        # isError surfaces as an error string rather than raising.
        err = await mcp.call(f"{MCP_TOOL_PREFIX}hf__model_details", {})
        assert "MCP tool error" in err


@pytest.mark.asyncio
async def test_manager_noop_without_servers():
    async with MCPToolManager(project_dir=None, servers=[]) as mcp:
        assert mcp.tool_definitions() == []
        assert not mcp.has_tool("anything")
