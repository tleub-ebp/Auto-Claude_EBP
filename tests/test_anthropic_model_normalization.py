#!/usr/bin/env python3
"""
Tests for dotted→dashed Claude model id normalization
=====================================================

A model picked under a Copilot/Windsurf provider is stored in dotted notation
(e.g. "claude-opus-4.8"). If the task is switched back to Anthropic, that dotted
id lingers in task_metadata.json and Anthropic rejects it ("model ... may not
exist"). ``normalize_anthropic_model_id`` rewrites it to the dashed native form,
and ``_resolve_provider_model`` applies it for the Anthropic provider only.
"""

import json
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from phase_config import (  # noqa: E402
    get_phase_model,
    normalize_anthropic_model_id,
    thinking_level_from_budget,
)


def test_thinking_level_from_budget_round_trips() -> None:
    # Inverse of THINKING_BUDGET_MAP — budgets label back to their effort level.
    assert thinking_level_from_budget(None) == "none"
    assert thinking_level_from_budget(1024) == "low"
    assert thinking_level_from_budget(4096) == "medium"
    assert thinking_level_from_budget(16384) == "high"
    assert thinking_level_from_budget(63999) == "ultrathink"


def test_thinking_level_from_budget_unknown_renders_tokens() -> None:
    assert thinking_level_from_budget(12000) == "12000 tokens"


def _write_metadata(spec_dir: Path, metadata: dict) -> None:
    (spec_dir / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")


def test_normalize_rewrites_dotted_claude_ids() -> None:
    assert normalize_anthropic_model_id("claude-opus-4.8") == "claude-opus-4-8"
    assert normalize_anthropic_model_id("claude-sonnet-4.6") == "claude-sonnet-4-6"
    assert normalize_anthropic_model_id("claude-haiku-4.5") == "claude-haiku-4-5"


def test_normalize_leaves_dashed_and_dated_ids_untouched() -> None:
    assert normalize_anthropic_model_id("claude-opus-4-8") == "claude-opus-4-8"
    assert (
        normalize_anthropic_model_id("claude-sonnet-4-5-20250929")
        == "claude-sonnet-4-5-20250929"
    )


def test_normalize_leaves_non_claude_and_empty_untouched() -> None:
    # Non-Claude dotted ids (e.g. GPT, Gemini) must be preserved verbatim.
    assert normalize_anthropic_model_id("gpt-5.5") == "gpt-5.5"
    assert normalize_anthropic_model_id("gemini-3.1-pro") == "gemini-3.1-pro"
    assert normalize_anthropic_model_id("") == ""


def test_resolve_provider_model_normalizes_for_anthropic(tmp_path: Path) -> None:
    """A dotted id persisted under the Anthropic provider is normalized when the
    QA phase model is resolved."""
    _write_metadata(
        tmp_path,
        {
            "provider": "anthropic",
            "isAutoProfile": True,
            "phaseModels": {
                "spec": "claude-opus-4.8",
                "planning": "claude-opus-4.8",
                "coding": "claude-sonnet-4.6",
                "qa": "claude-opus-4.8",
            },
        },
    )

    assert get_phase_model(tmp_path, "qa") == "claude-opus-4-8"
    assert get_phase_model(tmp_path, "coding") == "claude-sonnet-4-6"


def test_resolve_provider_model_preserves_dotted_for_copilot(tmp_path: Path) -> None:
    """Under Copilot the dotted spelling IS valid and must be preserved."""
    _write_metadata(
        tmp_path,
        {
            "provider": "copilot",
            "isAutoProfile": True,
            "phaseModels": {
                "spec": "claude-opus-4.8",
                "planning": "claude-opus-4.8",
                "coding": "claude-opus-4.8",
                "qa": "claude-opus-4.8",
            },
        },
    )

    assert get_phase_model(tmp_path, "qa") == "claude-opus-4.8"


def test_auto_profile_phase_model_wins_over_cli_model(tmp_path: Path) -> None:
    """In auto-profile mode the per-phase model MUST win over the CLI --model.

    Regression: the frontend launches the backend with --model = phaseModels.spec
    (the Spec phase model) as the global default. If the CLI arg took precedence,
    every phase ran on the spec model and the user's per-phase Planning/Coding/QA
    selections were silently ignored — changing one phase's model had no effect.
    """
    _write_metadata(
        tmp_path,
        {
            "provider": "anthropic",
            "isAutoProfile": True,
            "phaseModels": {
                "spec": "claude-opus-4-8",
                "planning": "claude-sonnet-4-6",
                "coding": "claude-opus-4-8",
                "qa": "claude-opus-4-8",
            },
        },
    )

    # Frontend passes --model = the spec model; Planning must still use its own.
    assert (
        get_phase_model(tmp_path, "planning", cli_model="claude-opus-4-8")
        == "claude-sonnet-4-6"
    )
    # A phase whose configured model equals the spec model still resolves (sanity).
    assert (
        get_phase_model(tmp_path, "qa", cli_model="claude-opus-4-8")
        == "claude-opus-4-8"
    )


def test_resolve_provider_model_falls_back_fable_on_non_anthropic() -> None:
    """A « Mythos-class » Anthropic id (claude-fable-5) left in metadata after a
    switch to a non-Anthropic provider must fall back to that provider's default,
    not be sent verbatim to an incompatible API."""
    from phase_config import _resolve_provider_model

    # Non-Anthropic provider: the native id is dropped for the provider default.
    assert _resolve_provider_model("claude-fable-5", "openai") != "claude-fable-5"
    # Anthropic provider: the native id is a valid model and is preserved.
    assert _resolve_provider_model("claude-fable-5", "anthropic") == "claude-fable-5"
