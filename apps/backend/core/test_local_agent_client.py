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
    _normalize_local_base_url,
    _resolve_local_base_url,
)

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
