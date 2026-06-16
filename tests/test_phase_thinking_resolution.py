#!/usr/bin/env python3
"""
Tests for per-phase thinking (effort) resolution
================================================

The frontend per-phase selector shows ``metadata.phaseThinking[phase]``
unconditionally, but the backend used to read it only when ``isAutoProfile``
was true. A "resume with this LLM" sets ``isAutoProfile=false`` (to force the
chosen single model), which made the backend fall back to the QA default
("high") while the UI still showed the configured effort ("low") — the
high-vs-low mismatch. ``get_phase_thinking`` now honours ``phaseThinking[phase]``
regardless of ``isAutoProfile``.
"""

import json
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from phase_config import (  # noqa: E402
    DEFAULT_PHASE_THINKING,
    get_phase_thinking,
    get_phase_thinking_budget,
)


def _write_metadata(spec_dir: Path, metadata: dict) -> None:
    (spec_dir / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")


def test_per_phase_thinking_honored_when_auto_profile(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {
            "isAutoProfile": True,
            "phaseThinking": {
                "spec": "ultrathink",
                "planning": "high",
                "coding": "low",
                "qa": "low",
            },
        },
    )
    assert get_phase_thinking(tmp_path, "qa") == "low"
    assert get_phase_thinking(tmp_path, "spec") == "ultrathink"


def test_per_phase_thinking_honored_when_not_auto_profile(tmp_path: Path) -> None:
    """The bug: resume-with-provider sets isAutoProfile=false + a single model,
    leaving phaseThinking intact. The per-phase effort must still win, not the
    "high" QA default."""
    _write_metadata(
        tmp_path,
        {
            "isAutoProfile": False,
            "model": "claude-sonnet-4-5-20250929",
            "phaseThinking": {
                "spec": "medium",
                "planning": "high",
                "coding": "low",
                "qa": "low",
            },
        },
    )
    assert get_phase_thinking(tmp_path, "qa") == "low"
    # Sanity: the default QA thinking is the "high" the user was wrongly getting.
    assert DEFAULT_PHASE_THINKING["qa"] == "high"
    assert get_phase_thinking(tmp_path, "qa") != DEFAULT_PHASE_THINKING["qa"]


def test_single_thinking_level_used_without_phase_thinking(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {
            "isAutoProfile": False,
            "model": "claude-opus-4-8",
            "thinkingLevel": "medium",
        },
    )
    assert get_phase_thinking(tmp_path, "qa") == "medium"


def test_phase_thinking_wins_over_single_level(tmp_path: Path) -> None:
    """When both exist, the per-phase value wins — matching the frontend, which
    displays phaseThinking[phase] and ignores the single thinkingLevel."""
    _write_metadata(
        tmp_path,
        {
            "isAutoProfile": False,
            "thinkingLevel": "high",
            "phaseThinking": {"qa": "low"},
        },
    )
    assert get_phase_thinking(tmp_path, "qa") == "low"


def test_falls_back_to_default_when_phase_missing(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {"isAutoProfile": True, "phaseThinking": {"spec": "medium"}},
    )
    # qa absent from phaseThinking → app default.
    assert get_phase_thinking(tmp_path, "qa") == DEFAULT_PHASE_THINKING["qa"]


def test_cli_thinking_overrides_everything(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {"isAutoProfile": True, "phaseThinking": {"qa": "low"}},
    )
    assert get_phase_thinking(tmp_path, "qa", cli_thinking="ultrathink") == "ultrathink"


def test_budget_reflects_resolved_level(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {"isAutoProfile": False, "phaseThinking": {"qa": "low"}},
    )
    # low → 1024 tokens (not the high default 16384).
    assert get_phase_thinking_budget(tmp_path, "qa") == 1024
