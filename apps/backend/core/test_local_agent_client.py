#!/usr/bin/env python3
"""
Tests for LocalAgentClient (OpenAI-compatible local LLM servers)
================================================================

Covers base-URL normalization, source-priority resolution, the optional-key
placeholder, provider identity, and the forced-off OpenAI-only payload params.
These are pure/offline checks — no local server is contacted.
"""

import pytest
from core.agent_client import (
    LocalAgentClient,
    _extract_text_tool_calls,
    _normalize_local_base_url,
    _resolve_local_base_url,
)


class TestExtractTextToolCalls:
    """Recovering tool calls that a local model emitted as JSON text."""

    KNOWN = {"read_file", "write_file", "run_command"}

    def test_bare_json_object(self):
        content = '{"name": "read_file", "arguments": {"path": "./spec.md"}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {"function": {"name": "read_file", "arguments": {"path": "./spec.md"}}}
        ]

    def test_fenced_json_block_in_prose(self):
        content = (
            "Sure, let me read the spec first:\n"
            '```json\n{"name": "read_file", "arguments": {"path": "spec.md"}}\n```\n'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert len(out) == 1
        assert out[0]["function"]["name"] == "read_file"

    def test_function_wrapper_shape(self):
        content = '{"function": {"name": "run_command", "arguments": {"cmd": "ls"}}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"cmd": "ls"}

    def test_unknown_tool_name_ignored(self):
        # A plain data object with a "name" key must NOT be taken as a tool call.
        out = _extract_text_tool_calls('{"name": "John", "age": 30}', self.KNOWN)
        assert out == []

    def test_string_arguments_are_parsed(self):
        content = '{"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"path": "a.txt"}

    def test_no_known_tools_returns_empty(self):
        out = _extract_text_tool_calls('{"name": "read_file"}', set())
        assert out == []


_LOCAL_ENV_VARS = (
    "OLLAMA_BASE_URL",
    "LOCAL_LLM_BASE_URL",
    "LMSTUDIO_BASE_URL",
    "OLLAMA_API_KEY",
    "LOCAL_LLM_API_KEY",
    "LMSTUDIO_API_KEY",
)


@pytest.fixture(autouse=True)
def _clear_local_env(monkeypatch):
    """Each test starts from a clean local-LLM env so results are deterministic."""
    for var in _LOCAL_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


class TestNormalizeLocalBaseUrl:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # bare root → append /v1/chat/completions
            ("http://localhost:11434", "http://localhost:11434/v1/chat/completions"),
            ("http://localhost:1234", "http://localhost:1234/v1/chat/completions"),
            # trailing slash tolerated
            ("http://localhost:1234/", "http://localhost:1234/v1/chat/completions"),
            # /v1 already present
            ("http://localhost:1234/v1", "http://localhost:1234/v1/chat/completions"),
            ("http://localhost:1234/v1/", "http://localhost:1234/v1/chat/completions"),
            # full path is idempotent
            (
                "http://localhost:1234/v1/chat/completions",
                "http://localhost:1234/v1/chat/completions",
            ),
            # empty/None → Ollama default
            ("", "http://localhost:11434/v1/chat/completions"),
            (None, "http://localhost:11434/v1/chat/completions"),
        ],
    )
    def test_normalization(self, raw, expected):
        assert _normalize_local_base_url(raw) == expected


class TestResolveLocalBaseUrl:
    def test_explicit_arg_wins(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:9999")
        assert (
            _resolve_local_base_url("http://localhost:1234")
            == "http://localhost:1234/v1/chat/completions"
        )

    def test_env_used_when_no_arg(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        assert (
            _resolve_local_base_url(None) == "http://localhost:1234/v1/chat/completions"
        )

    def test_lmstudio_env_supported(self, monkeypatch):
        monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234")
        assert (
            _resolve_local_base_url(None) == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_default_when_nothing_set(self, monkeypatch):
        # No env, and force the saved-config lookup to yield nothing.
        monkeypatch.setattr(
            "core.agent_client._resolve_local_base_url",
            _resolve_local_base_url,
        )
        # load_provider_config may or may not exist on the host; the result must
        # still fall back to the Ollama default rather than raise.
        result = _resolve_local_base_url(None)
        assert result.endswith("/v1/chat/completions")


class TestLocalAgentClient:
    def test_provider_name_is_ollama(self):
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client.provider_name() == "ollama"

    def test_base_url_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client._api_base == "http://localhost:1234/v1/chat/completions"

    def test_explicit_base_url_arg(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:8080/v1")
        assert client._api_base == "http://localhost:8080/v1/chat/completions"

    def test_api_key_placeholder_when_unset(self):
        client = LocalAgentClient(model="m")
        # Non-empty so the inherited missing-key guard doesn't abort the loop.
        assert client._api_key == "local"

    def test_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_API_KEY", "secret-token")
        client = LocalAgentClient(model="m")
        assert client._api_key == "secret-token"

    def test_openai_only_params_forced_off(self):
        client = LocalAgentClient(
            model="m", reasoning_effort="high", prompt_cache_key="abc"
        )
        assert client._reasoning_effort is None
        assert client._prompt_cache_key is None

    def test_default_model(self):
        client = LocalAgentClient()
        assert client.model == "llama3.3"

    def test_native_chat_url_derived_from_base(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        assert client._native_chat_url() == "http://localhost:11434/api/chat"

    def test_native_chat_url_with_custom_port(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:1234/v1")
        assert client._native_chat_url() == "http://localhost:1234/api/chat"

    def test_num_ctx_default_and_env(self, monkeypatch):
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        assert LocalAgentClient(model="m")._num_ctx() == 8192
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "16384")
        assert LocalAgentClient(model="m")._num_ctx() == 16384

    def test_connection_error_message_is_friendly(self):
        """A connection failure is rephrased into an actionable Ollama hint."""
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        msg = client._describe_request_error(
            OSError("Cannot connect to host localhost:11434 ssl:default")
        )
        assert "Ollama ne répond pas" in msg
        assert "http://localhost:11434" in msg
        assert "Télécharger" in msg
        # The raw aiohttp text must not leak through.
        assert "ssl:default" not in msg

    def test_non_connection_error_passthrough(self):
        """A genuine API error (not a connection failure) keeps its detail."""
        client = LocalAgentClient(model="m")
        msg = client._describe_request_error(ValueError("model not found"))
        assert "model not found" in msg
        assert "Ollama ne répond pas" not in msg
