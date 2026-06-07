"""Tests for the shared rate-limit shield."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_returns_false_for_non_rate_limit_error(tmp_path: Path) -> None:
    """Generic exceptions must NOT be swallowed — the caller still needs to
    count them as errors."""
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("internal server error 500")
    handled = await handle_rate_limit_pause(err, tmp_path, "qa")
    assert handled is False


@pytest.mark.asyncio
async def test_pauses_and_resumes_on_429_with_relative_time(tmp_path: Path) -> None:
    """A 429 with a parseable reset time must (1) be detected, (2) write a
    pause file with the calling phase tag, (3) wait, (4) return True."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error: please retry in 1 minute")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False  # waited full duration

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        handled = await handle_rate_limit_pause(err, tmp_path, "auto_fix")

    assert handled is True
    pause_file = tmp_path / RATE_LIMIT_PAUSE_FILE
    assert pause_file.exists()
    content = pause_file.read_text(encoding="utf-8")
    assert '"phase": "auto_fix"' in content, (
        "pause file must record which phase paused so the UI can show it"
    )


@pytest.mark.asyncio
async def test_falls_back_when_reset_time_unparseable(tmp_path: Path) -> None:
    """If the rate-limit message has no parseable reset time, return False so
    the caller falls back to its normal error-counting path rather than
    deadlocking on a wait with no end."""
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error")
    handled = await handle_rate_limit_pause(err, tmp_path, "spec")
    assert handled is False


@pytest.mark.asyncio
async def test_skips_wait_when_reset_already_passed(tmp_path: Path) -> None:
    """When the parsed reset is in the past, retry immediately rather than
    calling wait_for_rate_limit_reset with a negative duration."""
    from services.rate_limit_shield import handle_rate_limit_pause

    past = datetime.now() - timedelta(minutes=2)

    with (
        patch(
            "agents.coder.parse_rate_limit_reset_time",
            return_value=past.timestamp(),
        ),
        patch("agents.coder.wait_for_rate_limit_reset") as wait_mock,
    ):
        handled = await handle_rate_limit_pause(
            RuntimeError("429 rate limit reached"), tmp_path, "planner"
        )

    assert handled is True
    wait_mock.assert_not_called()


@pytest.mark.asyncio
async def test_phase_tag_appears_in_pause_file(tmp_path: Path) -> None:
    """Different phases pausing produces different `phase` field — verify the
    tag is passed through verbatim so the frontend can render it."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error: please retry in 2 minutes")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        await handle_rate_limit_pause(err, tmp_path, "spec:requirements")

    content = (tmp_path / RATE_LIMIT_PAUSE_FILE).read_text(encoding="utf-8")
    assert "spec:requirements" in content


@pytest.mark.asyncio
async def test_qa_loop_wrapper_still_works(tmp_path: Path) -> None:
    """The legacy `_handle_rate_limit_in_qa` wrapper in qa.loop must still
    work — it's a public-ish surface that other tests and the actual QA loop
    still depend on. It must delegate to the shared shield with phase='qa'."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from qa.loop import _handle_rate_limit_in_qa

    err = RuntimeError("429 rate_limit_error: please retry in 1 minute")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        handled = await _handle_rate_limit_in_qa(err, tmp_path, None)

    assert handled is True
    content = (tmp_path / RATE_LIMIT_PAUSE_FILE).read_text(encoding="utf-8")
    assert '"phase": "qa"' in content


# ---------------------------------------------------------------------------
# handle_prompt_too_long — permanent halt path (different from rate-limit which
# is a temporary pause-and-resume). These errors come from the LLM saying
# "your conversation exceeds my context window" — retrying with the same
# transcript will fail identically.
# ---------------------------------------------------------------------------


def test_prompt_too_long_returns_false_for_other_errors(tmp_path: Path) -> None:
    """Non-prompt-too-long errors must NOT trigger the halt path — the caller
    should fall through to its normal error handling."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    assert handle_prompt_too_long(RuntimeError("boom"), tmp_path, "qa") is False
    assert (
        handle_prompt_too_long(RuntimeError("429 rate limit"), tmp_path, "coder")
        is False
    )
    # No marker file should have been written.
    assert not (tmp_path / PROMPT_TOO_LONG_HALT_FILE).exists()


def test_prompt_too_long_writes_halt_marker_and_returns_true(tmp_path: Path) -> None:
    """When the LLM says the prompt is too long, the helper must write the
    halt marker file and return True so the caller knows to stop retrying."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    err = RuntimeError("Anthropic: 400 prompt is too long: 250000 tokens")
    handled = handle_prompt_too_long(err, tmp_path, "coder")

    assert handled is True
    marker = tmp_path / PROMPT_TOO_LONG_HALT_FILE
    assert marker.exists()
    content = marker.read_text(encoding="utf-8")
    assert '"phase": "coder"' in content
    # The remediation message tells the user the conversation log has been
    # archived and how to recover. The exact wording is allowed to evolve as
    # long as it mentions the archive and the provider-switch alternative.
    assert "archived" in content.lower() or "conversation" in content.lower()
    assert "provider" in content.lower()


def test_prompt_too_long_archives_existing_conversation_log(tmp_path: Path) -> None:
    """When the prompt overflowed, the conversation log MUST be moved aside —
    otherwise the next session start replays it and triggers the same error
    again ('Continuing implementation… / Prompt is too long' loop).
    """
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    # Seed a fake conversation log.
    log_file = tmp_path / "conversation.jsonl"
    log_file.write_text('{"role": "user", "content": "x"}\n', encoding="utf-8")

    err = RuntimeError("Prompt is too long")
    handled = handle_prompt_too_long(err, tmp_path, "coder")

    assert handled is True
    assert (tmp_path / PROMPT_TOO_LONG_HALT_FILE).exists()
    # Original log file must be gone.
    assert not log_file.exists(), (
        "conversation.jsonl must be archived, not left in place"
    )
    # An archive file with the .too-long.jsonl suffix must exist instead.
    archives = list(tmp_path.glob("conversation.*.too-long.jsonl"))
    assert len(archives) == 1, f"expected exactly one archive, found {archives}"


def test_prompt_too_long_archives_session_json_resume_marker(tmp_path: Path) -> None:
    """The frontend's "Reprendre" button reads .session.json to re-inject
    AUTO_CLAUDE_RESUME_SESSION_ID, which makes the Claude SDK rehydrate the
    on-disk transcript. After a prompt-too-long, that resume marker MUST be
    archived too — otherwise the next "Reprendre" click re-poisons the
    session by replaying the same oversized transcript."""
    from services.rate_limit_shield import handle_prompt_too_long

    session_state = tmp_path / ".session.json"
    session_state.write_text(
        '{"session_id": "abc-123", "subtype": "error_max_turns"}',
        encoding="utf-8",
    )

    handle_prompt_too_long(RuntimeError("Prompt is too long"), tmp_path, "coder")

    assert not session_state.exists(), (
        ".session.json must be archived, not left in place"
    )
    archives = list(tmp_path.glob(".session.*.too-long.json"))
    assert len(archives) == 1, f"expected exactly one archive, found {archives}"


def test_response_text_detector_matches_bare_error_string() -> None:
    """The Claude Agent SDK surfaces "Prompt is too long" as a normal text
    response, not as an exception. The response-text detector must catch
    that exact shape and ignore real assistant turns that mention the
    phrase incidentally."""
    from agents.session import _response_text_indicates_prompt_too_long

    assert _response_text_indicates_prompt_too_long("Prompt is too long") is True
    assert _response_text_indicates_prompt_too_long("  Prompt is too long  \n") is True
    assert (
        _response_text_indicates_prompt_too_long("Prompt is too long: 250000 tokens")
        is True
    )
    # Real assistant work that happens to mention the phrase must NOT trip.
    long_response = (
        "I've reviewed the prior session and noticed that the prompt is too "
        "long to fit in the model's context window. Let me suggest a smaller "
        "approach: " + "x" * 200
    )
    assert _response_text_indicates_prompt_too_long(long_response) is False
    # Empty / unrelated content stays a no-op.
    assert _response_text_indicates_prompt_too_long("") is False
    assert _response_text_indicates_prompt_too_long("Task complete.") is False


def test_prompt_too_long_clears_resume_env_var(tmp_path: Path, monkeypatch) -> None:
    """The in-process AUTO_CLAUDE_RESUME_SESSION_ID env var is what
    create_client() reads on every iteration to decide whether to resume the
    prior SDK session. Leaving it set after a prompt-too-long means every
    subsequent iteration of the coder loop re-resumes the poisoned session.
    """
    from services.rate_limit_shield import handle_prompt_too_long

    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "doomed-session")

    handle_prompt_too_long(RuntimeError("Prompt is too long"), tmp_path, "coder")

    import os as _os

    assert _os.environ.get("AUTO_CLAUDE_RESUME_SESSION_ID") is None, (
        "env var must be cleared so the next create_client() doesn't re-resume"
    )


def test_prompt_too_long_no_archive_when_no_conversation_log(tmp_path: Path) -> None:
    """If there's no conversation log to archive, the helper must still halt
    cleanly — not raise. (Some early-phase errors fire before any log entry
    has been written.)
    """
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    assert not (tmp_path / "conversation.jsonl").exists()

    handled = handle_prompt_too_long(
        RuntimeError("Prompt is too long"), tmp_path, "planner"
    )

    assert handled is True
    assert (tmp_path / PROMPT_TOO_LONG_HALT_FILE).exists()


def test_prompt_too_long_marker_records_phase_tag(tmp_path: Path) -> None:
    """The phase tag in the marker lets the UI tell the user where the halt
    happened ('Halted during QA' vs 'Halted during planning')."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    err = RuntimeError("context_length_exceeded")
    handle_prompt_too_long(err, tmp_path, "auto_fix")

    content = (tmp_path / PROMPT_TOO_LONG_HALT_FILE).read_text(encoding="utf-8")
    assert '"phase": "auto_fix"' in content


def test_prompt_too_long_detects_various_message_shapes(tmp_path: Path) -> None:
    """The helper should recognise the common phrasings used by Anthropic,
    OpenAI, and other providers — not just one exact string."""
    from services.rate_limit_shield import handle_prompt_too_long

    samples = [
        "Prompt is too long",
        "prompt too long",
        "context length exceeded",
        "maximum context length exceeded for model X",
        "input is too long",
    ]
    for msg in samples:
        # Each call uses a fresh tmp dir via a unique sub-path to avoid the
        # marker from a previous iteration tainting the result.
        sub = tmp_path / f"sub_{hash(msg)}"
        sub.mkdir()
        assert handle_prompt_too_long(RuntimeError(msg), sub, "qa") is True, (
            f"should have matched: {msg!r}"
        )


# ---------------------------------------------------------------------------
# Regression: the Claude CLI started emitting "You've hit your session limit"
# and "You've hit your weekly limit" banners (instead of the older bare
# "You've hit your limit"). The detector used to require the literal word
# "limit" right after "your", so the new banner slipped through, was treated
# as a generic error, and got retried with a continuation summary appended
# every iteration — which grew the prompt until it tripped "Prompt is too long"
# AND polluted the logs with duplicated banners.
# ---------------------------------------------------------------------------


def test_is_rate_limit_error_matches_session_and_weekly_variants() -> None:
    """The new CLI shapes 'hit your session limit' and 'hit your weekly limit'
    must classify as rate-limit errors — not generic ones."""
    from agents.session import is_rate_limit_error

    samples = [
        "You've hit your limit · resets 10am (Europe/Paris)",
        "You've hit your session limit · resets 3:20pm (Europe/Paris)",
        "You've hit your weekly limit · resets Dec 17 at 6am (Europe/Oslo)",
        "session limit reached",
        "weekly limit reached",
    ]
    for msg in samples:
        assert is_rate_limit_error(RuntimeError(msg)) is True, (
            f"should classify as rate-limit: {msg!r}"
        )


def test_parse_rate_limit_reset_time_handles_resets_without_at() -> None:
    """The new CLI banner uses 'resets 3:20pm' (no 'at' prefix). The parser
    must extract a valid future timestamp from that shape too, otherwise the
    rate-limit shield can't compute a wait window and the caller falls back
    to its retry loop — the exact bug behind the prompt-too-long avalanche."""
    from agents.coder import parse_rate_limit_reset_time

    error_info = {
        "message": "You've hit your session limit · resets 3:20pm (Europe/Paris)",
        "type": "rate_limit",
    }
    ts = parse_rate_limit_reset_time(error_info)
    assert ts is not None and ts > 0

    # Hour-only shape ("resets 10am") must also parse.
    error_info_hour_only = {
        "message": "You've hit your limit · resets 10am (Europe/Paris)",
        "type": "rate_limit",
    }
    ts2 = parse_rate_limit_reset_time(error_info_hour_only)
    assert ts2 is not None and ts2 > 0
