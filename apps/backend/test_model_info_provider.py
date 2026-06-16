"""Tests for provider resolution in core.model_info used for log labelling.

Regression: GitHub Copilot authenticates with an Anthropic-compatible token, so
the API-key heuristic mislabelled it as the "anthropic" provider in the logs
(`[anthropic:Opus 4.6]`) while the frontend correctly showed `[copilot:...]`.
The explicit `SELECTED_LLM_PROVIDER` / `AUTO_CLAUDE_PROVIDER` env signal must win.
"""

import sys
import types

from core import model_info


def test_selected_llm_provider_wins_over_anthropic_token(monkeypatch):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

    assert model_info._detect_provider_from_env() == "copilot"


def test_claude_alias_normalised_to_anthropic(monkeypatch):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

    assert model_info._detect_provider_from_env() == "anthropic"


def test_auto_claude_provider_used_as_fallback(monkeypatch):
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "openai")

    assert model_info._detect_provider_from_env() == "openai"


def test_anthropic_token_still_detected_without_explicit_signal(monkeypatch):
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    assert model_info._detect_provider_from_env() == "anthropic"


def test_get_current_model_info_prefers_explicit_provider(monkeypatch):
    # Simulate the agent subprocess where the IPC global is not set.
    fake_provider_api = types.ModuleType("provider_api")
    fake_provider_api.get_selected_provider = lambda: None
    monkeypatch.setitem(sys.modules, "provider_api", fake_provider_api)

    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    info = model_info.get_current_model_info()

    assert info["provider"] == "copilot"
    assert info["model_label"] == "GitHub Copilot"
