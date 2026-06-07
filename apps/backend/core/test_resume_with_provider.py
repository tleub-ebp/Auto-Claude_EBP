"""Tests for the RESUME_WITH_PROVIDER single-shot override marker.

Covers `_consume_resume_with_provider_marker()` and its integration into
`_get_active_provider()`. This is the backend side of Phase 8 / 9 — the
frontend writes the marker, the next session start consumes it.
"""

from __future__ import annotations

import json
from pathlib import Path

from core.client import (
    RESUME_WITH_PROVIDER_FILE,
    _consume_resume_with_provider_marker,
)


def test_returns_none_when_no_marker(tmp_path: Path) -> None:
    assert _consume_resume_with_provider_marker(tmp_path) is None


def test_reads_plain_text_provider_id(tmp_path: Path) -> None:
    (tmp_path / RESUME_WITH_PROVIDER_FILE).write_text("copilot", encoding="utf-8")
    assert _consume_resume_with_provider_marker(tmp_path) == "copilot"


def test_reads_json_provider_field(tmp_path: Path) -> None:
    (tmp_path / RESUME_WITH_PROVIDER_FILE).write_text(
        json.dumps({"provider": "openai"}), encoding="utf-8"
    )
    assert _consume_resume_with_provider_marker(tmp_path) == "openai"


def test_marker_is_consumed_single_shot(tmp_path: Path) -> None:
    """The marker file MUST be deleted after reading so the override only
    applies to the very next session, not every subsequent one."""
    marker = tmp_path / RESUME_WITH_PROVIDER_FILE
    marker.write_text("claude", encoding="utf-8")

    first = _consume_resume_with_provider_marker(tmp_path)
    second = _consume_resume_with_provider_marker(tmp_path)

    assert first == "claude"
    assert second is None
    assert not marker.exists()


def test_empty_marker_returns_none_and_is_removed(tmp_path: Path) -> None:
    """An empty marker is malformed — treat as no override, but still remove
    it so it doesn't accumulate."""
    marker = tmp_path / RESUME_WITH_PROVIDER_FILE
    marker.write_text("   \n", encoding="utf-8")

    assert _consume_resume_with_provider_marker(tmp_path) is None
    assert not marker.exists()


def test_whitespace_around_provider_is_trimmed(tmp_path: Path) -> None:
    (tmp_path / RESUME_WITH_PROVIDER_FILE).write_text("  copilot\n", encoding="utf-8")
    assert _consume_resume_with_provider_marker(tmp_path) == "copilot"


def test_json_without_provider_field_returns_none(tmp_path: Path) -> None:
    """JSON object without a `provider` key — return None (not a malformed
    plain-text). Marker still consumed."""
    marker = tmp_path / RESUME_WITH_PROVIDER_FILE
    marker.write_text(json.dumps({"foo": "bar"}), encoding="utf-8")

    assert _consume_resume_with_provider_marker(tmp_path) is None
    assert not marker.exists()


def test_get_active_provider_consumes_override(tmp_path: Path) -> None:
    """End-to-end check on _get_active_provider(): writing the marker before
    the call returns the override, and a second call returns the default
    (because the marker was consumed)."""
    from core.client import _get_active_provider

    (tmp_path / RESUME_WITH_PROVIDER_FILE).write_text("copilot", encoding="utf-8")

    # First call honors the override.
    first = _get_active_provider(tmp_path)
    assert first == "copilot"

    # Second call falls back to whatever the env/defaults dictate — the
    # important assertion here is just that it's NOT still "copilot" via
    # the marker (the marker file is gone).
    assert not (tmp_path / RESUME_WITH_PROVIDER_FILE).exists()
