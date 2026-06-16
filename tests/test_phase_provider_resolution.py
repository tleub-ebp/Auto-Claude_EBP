#!/usr/bin/env python3
"""
Tests for per-phase provider resolution
=======================================

Verifies that ``phaseProviders`` in task_metadata.json drives provider
selection independently per phase, while preserving the legacy task-wide
``provider`` fallback when no per-phase override exists.
"""

import json
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from phase_config import get_phase_provider  # noqa: E402


def _write_metadata(spec_dir: Path, metadata: dict) -> None:
    (spec_dir / "task_metadata.json").write_text(
        json.dumps(metadata), encoding="utf-8"
    )


def test_per_phase_provider_takes_precedence(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {
            "provider": "anthropic",
            "phaseProviders": {
                "spec": "anthropic",
                "planning": "anthropic",
                "coding": "copilot",
                "qa": "openai",
            },
        },
    )

    assert get_phase_provider(tmp_path, phase="coding") == "copilot"
    assert get_phase_provider(tmp_path, phase="qa") == "openai"
    assert get_phase_provider(tmp_path, phase="planning") == "anthropic"


def test_falls_back_to_task_wide_provider(tmp_path: Path) -> None:
    _write_metadata(tmp_path, {"provider": "openai"})

    # No phaseProviders → task-wide provider used for every phase.
    assert get_phase_provider(tmp_path, phase="coding") == "openai"
    assert get_phase_provider(tmp_path) == "openai"


def test_partial_phase_providers_fall_back(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {
            "provider": "anthropic",
            "phaseProviders": {"coding": "copilot"},
        },
    )

    # Phase with an override uses it; others fall back to task-wide provider.
    assert get_phase_provider(tmp_path, phase="coding") == "copilot"
    assert get_phase_provider(tmp_path, phase="qa") == "anthropic"


def test_cli_provider_wins_over_metadata(tmp_path: Path) -> None:
    _write_metadata(
        tmp_path,
        {
            "provider": "anthropic",
            "phaseProviders": {"coding": "copilot"},
        },
    )

    assert (
        get_phase_provider(tmp_path, cli_provider="openai", phase="coding")
        == "openai"
    )
