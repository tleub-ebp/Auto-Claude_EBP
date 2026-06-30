"""Tests for local-model native tool-calling detection (the picker pre-filter).

Uses an unreachable URL so /api/show fails and the name-allowlist FALLBACK is
exercised (the authoritative /api/show path needs a live Ollama server).
"""

from ollama_model_detector import _parse_param_billions, model_supports_tools

_DEAD_URL = "http://127.0.0.1:1"  # nothing listening → forces the name fallback


def test_param_billions_parsing() -> None:
    assert _parse_param_billions("8.0B") == 8.0
    assert _parse_param_billions("70.6B") == 70.6
    assert _parse_param_billions("qwen2.5-coder:7b") == 7.0
    assert _parse_param_billions("llama3.3:70b") == 70.0
    # No size token → unknown (a version number like 3.1 is NOT a size).
    assert _parse_param_billions("llama3.1:latest") is None
    assert _parse_param_billions(None) is None


def test_known_tool_calling_families_allowed() -> None:
    assert model_supports_tools(_DEAD_URL, "llama3.1:latest")
    assert model_supports_tools(_DEAD_URL, "llama3.3")
    assert model_supports_tools(_DEAD_URL, "qwen2.5-coder:32b")
    assert model_supports_tools(_DEAD_URL, "mistral-nemo:latest")
    assert model_supports_tools(_DEAD_URL, "command-r:35b")


def test_non_tool_models_rejected() -> None:
    assert not model_supports_tools(_DEAD_URL, "codellama:7b")
    assert not model_supports_tools(_DEAD_URL, "gemma2:9b")
    assert not model_supports_tools(_DEAD_URL, "phi3:mini")
    assert not model_supports_tools(_DEAD_URL, "starcoder2:7b")
