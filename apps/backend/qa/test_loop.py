"""Tests for the QA loop rate-limit shield."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_handle_rate_limit_returns_false_for_non_rate_limit_error(
    tmp_path: Path,
) -> None:
    """Generic exceptions (e.g. a 500 from the API) must NOT be swallowed as
    rate-limit pauses — the caller still needs to count them as errors."""
    from qa.loop import _handle_rate_limit_in_qa

    err = RuntimeError("internal server error 500")
    handled = await _handle_rate_limit_in_qa(err, tmp_path, None)
    assert handled is False


@pytest.mark.asyncio
async def test_handle_rate_limit_pauses_and_resumes_on_429(tmp_path: Path) -> None:
    """A 429 error with a parseable reset time must (1) be detected as a
    rate-limit, (2) create a RATE_LIMIT_PAUSE file, (3) wait, and (4) return
    True so the caller skips error-counting."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from qa.loop import _handle_rate_limit_in_qa

    err = RuntimeError("429 rate_limit_error: please retry in 1 minute")

    # Avoid the actual wait — just confirm the helper invokes it and returns True.
    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False  # would-be 'resumed_early' = False (waited full duration)

    # Patch the source modules — qa.loop imports them lazily inside the helper.
    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        handled = await _handle_rate_limit_in_qa(err, tmp_path, None)

    assert handled is True
    # Pause file should have been written so the frontend can show a "paused" badge
    pause_file = tmp_path / RATE_LIMIT_PAUSE_FILE
    assert pause_file.exists()
    content = pause_file.read_text(encoding="utf-8")
    assert "rate_limit" in content.lower() or "rate limit" in content.lower()


@pytest.mark.asyncio
async def test_handle_rate_limit_falls_back_when_reset_time_unparseable(
    tmp_path: Path,
) -> None:
    """If the rate-limit message has no parseable reset time, return False so
    the caller falls back to its normal error-counting path (rather than
    deadlocking on a wait with no end)."""
    from qa.loop import _handle_rate_limit_in_qa

    # 429 with no time info — is_rate_limit_error matches, but
    # parse_rate_limit_reset_time can't extract anything.
    err = RuntimeError("429 rate_limit_error")
    handled = await _handle_rate_limit_in_qa(err, tmp_path, None)
    assert handled is False


@pytest.mark.asyncio
async def test_handle_rate_limit_skips_wait_when_already_reset(
    tmp_path: Path,
) -> None:
    """When the parsed reset time is already in the past, we should retry
    immediately rather than calling wait_for_rate_limit_reset with a negative
    duration."""
    from qa.loop import _handle_rate_limit_in_qa

    past = datetime.now() - timedelta(minutes=2)

    with (
        patch(
            "agents.coder.parse_rate_limit_reset_time",
            return_value=past.timestamp(),
        ),
        patch("agents.coder.wait_for_rate_limit_reset") as wait_mock,
    ):
        handled = await _handle_rate_limit_in_qa(
            RuntimeError("429 rate limit reached"), tmp_path, None
        )

    assert handled is True
    wait_mock.assert_not_called()  # no waiting when reset is in the past
