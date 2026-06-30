#!/usr/bin/env python3
"""
Tests for the local-LLM model catalog fetcher (_fetch_ollama)
=============================================================

Verifies that the fetcher honours OLLAMA_BASE_URL, prefers the OpenAI-compatible
``/v1/models`` endpoint (LM Studio / vLLM / Ollama ≥ /v1), and falls back to
Ollama's native ``/api/tags``. httpx is faked — no local server is contacted.
"""

import httpx
import provider_models_catalog as cat
import pytest


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def raise_for_status(self):
        if self.status != 200:
            raise httpx.HTTPStatusError(
                "boom",
                request=None,
                response=None,  # type: ignore[arg-type]
            )

    def json(self):
        return self._payload


class _FakeClient:
    """Routes GET by URL suffix to a configured response (or raises)."""

    def __init__(self, routes):
        self._routes = routes
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kwargs):
        self.calls.append(url)
        for suffix, resp in self._routes.items():
            if url.endswith(suffix):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise httpx.ConnectError("no route")


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in ("OLLAMA_BASE_URL", "LOCAL_LLM_BASE_URL", "LMSTUDIO_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


def _install_fake_client(monkeypatch, routes):
    captured = {}

    def factory(*args, **kwargs):
        client = _FakeClient(routes)
        captured["client"] = client
        return client

    monkeypatch.setattr(cat.httpx, "Client", factory)
    return captured


def test_prefers_openai_v1_models_and_honours_base_url(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
    captured = _install_fake_client(
        monkeypatch,
        {"/v1/models": _FakeResp({"data": [{"id": "qwen2.5-coder"}]})},
    )

    out = cat._fetch_ollama()

    assert out == [
        {"value": "qwen2.5-coder", "label": "qwen2.5-coder", "tier": "local"}
    ]
    # The configured port must be used (not the default 11434).
    assert any("localhost:1234/v1/models" in u for u in captured["client"].calls)


def test_falls_back_to_api_tags(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434")
    _install_fake_client(
        monkeypatch,
        {
            "/v1/models": httpx.ConnectError("nope"),
            "/api/tags": _FakeResp({"models": [{"name": "llama3.3"}]}),
        },
    )

    out = cat._fetch_ollama()

    assert out == [{"value": "llama3.3", "label": "llama3.3", "tier": "local"}]


def test_empty_v1_falls_back_to_tags(monkeypatch):
    _install_fake_client(
        monkeypatch,
        {
            "/v1/models": _FakeResp({"data": []}),
            "/api/tags": _FakeResp({"models": [{"name": "mistral-nemo"}]}),
        },
    )

    out = cat._fetch_ollama()

    assert out == [{"value": "mistral-nemo", "label": "mistral-nemo", "tier": "local"}]


def test_returns_empty_when_unreachable(monkeypatch):
    _install_fake_client(
        monkeypatch,
        {
            "/v1/models": httpx.ConnectError("nope"),
            "/api/tags": httpx.ConnectError("nope"),
        },
    )

    assert cat._fetch_ollama() == []


def test_local_root_strips_openai_suffixes(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234/v1/chat/completions")
    assert cat._local_llm_root() == "http://localhost:1234"
