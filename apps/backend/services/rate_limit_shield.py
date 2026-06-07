"""
Rate-limit shield: pause-and-resume on Anthropic 429 errors.

Generic helper that any LLM-calling phase (coder, qa, planner, spec, PR reviewer,
auto-fix, ...) can use to ride out a rate-limit window without counting the
error against retry budgets and without escalating to human review prematurely.

The coder phase originally owned this logic; QA reimplemented part of it; spec
and PR review phases had nothing. This module centralises it so every phase
gets the same behavior and one bug fix lands everywhere at once.

Imports of `agents.*` are deferred to the call site so that test modules which
mock out the `agents` package can still import the helper.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


async def handle_rate_limit_pause(
    error: Exception,
    spec_dir: Path,
    phase: str,
    source_spec_dir: Path | None = None,
) -> bool:
    """
    Detect a rate-limit error and, if recognised, pause until the quota window
    resets (or until the user manually resumes via the frontend).

    Args:
        error: The exception raised by the LLM session
        spec_dir: Spec directory where the pause file should be written (typically
            the worktree spec dir so the frontend can detect it)
        phase: Short tag describing the calling phase ("coder", "qa", "planner",
            "spec", "auto_fix", "pr_review"). Written into the pause file so the
            UI can show "Paused during QA" etc.
        source_spec_dir: Optional main-project spec dir used as a fallback for
            the RESUME signal when the worktree is hard to locate from the UI.

    Returns:
        True  — error was a rate-limit AND we paused-then-resumed. The caller
                should retry without incrementing any error counter.
        False — error was not a rate-limit, OR the wait time couldn't be parsed,
                OR the wait was unreasonably long (>MAX_RATE_LIMIT_WAIT_SECONDS).
                The caller should fall back to its usual error path.
    """
    from agents.base import MAX_RATE_LIMIT_WAIT_SECONDS, RATE_LIMIT_PAUSE_FILE
    from agents.coder import parse_rate_limit_reset_time, wait_for_rate_limit_reset
    from agents.session import is_rate_limit_error

    if not is_rate_limit_error(error):
        return False

    error_info = {"message": str(error), "type": "rate_limit"}
    reset_timestamp = parse_rate_limit_reset_time(error_info)

    if not reset_timestamp:
        logger.warning(
            "[%s] Rate limit hit but reset time could not be parsed — "
            "falling back to standard error handling",
            phase,
        )
        return False

    wait_seconds = reset_timestamp - datetime.now().timestamp()
    if wait_seconds <= 0:
        logger.info("[%s] Rate limit already reset, retrying immediately", phase)
        return True
    if wait_seconds > MAX_RATE_LIMIT_WAIT_SECONDS:
        logger.error(
            "[%s] Rate limit wait time too long (%.1fh) — giving up rather than waiting",
            phase,
            wait_seconds / 3600,
        )
        return False

    wait_minutes = wait_seconds / 60
    logger.warning(
        "[%s] Rate limit hit — pausing for %.0f minutes (reset_ts=%s)",
        phase,
        wait_minutes,
        reset_timestamp,
    )
    print(f"\n⏸  Rate limit reached. Pausing {phase} for {wait_minutes:.0f} minutes...")

    pause_data = {
        "paused_at": datetime.now().isoformat(),
        "reset_timestamp": reset_timestamp,
        "error": str(error)[:500],
        "phase": phase,
    }
    pause_file = spec_dir / RATE_LIMIT_PAUSE_FILE
    pause_file.write_text(json.dumps(pause_data), encoding="utf-8")

    resumed_early = await wait_for_rate_limit_reset(
        spec_dir, wait_seconds, source_spec_dir
    )
    if resumed_early:
        print("▶  Resumed early by user")
    else:
        print(f"▶  Rate limit window elapsed, resuming {phase}")

    return True


# Filename of the marker the backend writes when an LLM call fails with a
# "prompt too long" error. The frontend watches for this and surfaces an
# explanation + remediation actions (reset conversation / switch provider)
# instead of letting the task loop on a permanent failure.
PROMPT_TOO_LONG_HALT_FILE = "PROMPT_TOO_LONG_HALT"


def handle_prompt_too_long(
    error: Exception,
    spec_dir: Path,
    phase: str,
) -> bool:
    """
    Detect a "prompt too long" error and, if recognised, halt the task and
    record a marker the frontend can read to surface the right remediation.

    Unlike rate limits, this kind of error CANNOT be retried — the conversation
    will be just as long the next attempt. The right user-facing answer is:
    reset the conversation log, or switch to a provider with a larger context
    window. We mark the task accordingly and return True so the caller knows
    to stop looping and escalate to human review.

    Args:
        error: The exception raised by the LLM session
        spec_dir: Spec directory where the halt marker file should be written
        phase: Short tag describing the calling phase ("coder", "qa", "planner",
            "spec", "auto_fix"). Written into the marker so the UI can show
            "Halted during QA" etc.

    Returns:
        True  — error was a prompt-too-long error. The caller MUST stop
                retrying and escalate to human review with
                reviewReason="prompt_too_long".
        False — error was not a prompt-too-long error. Caller falls back
                to its normal error handling path.
    """
    from agents.session import is_prompt_too_long_error

    if not is_prompt_too_long_error(error):
        return False

    logger.error(
        "[%s] Prompt too long — halting (retrying with the same conversation "
        "will never succeed). Reset the conversation log or switch to a "
        "provider with a larger context window.",
        phase,
    )
    print(
        f"\n⛔ Prompt too long during {phase}. "
        "Reset the conversation or pick a provider with a larger context window."
    )

    # Break every mechanism that could replay the oversized transcript on the
    # next iteration. Three layers must all be cleared, otherwise the
    # "Continuing implementation… / Prompt is too long" cascade resumes:
    #
    #   1. Our own conversation.jsonl (replayed by _maybe_replay_conversation)
    #   2. The Claude SDK's on-disk transcript pointer .session.json
    #      (consumed by the frontend's "Reprendre" button and re-injected as
    #      AUTO_CLAUDE_RESUME_SESSION_ID, which then makes the SDK rehydrate
    #      ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl)
    #   3. The live AUTO_CLAUDE_RESUME_SESSION_ID env var in the current
    #      process — left set, it would make every subsequent
    #      create_client() in the same loop re-resume the doomed session.
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    try:
        log_file = spec_dir / "conversation.jsonl"
        if log_file.exists():
            archive = spec_dir / f"conversation.{timestamp}.too-long.jsonl"
            log_file.rename(archive)
            logger.info(
                "[%s] Archived oversized conversation log to %s",
                phase,
                archive.name,
            )
    except OSError as e:
        logger.warning("Could not archive conversation log: %s", e)

    # Layer 2: archive .session.json so the frontend's "Reprendre" can't replay
    # the doomed SDK session_id. We rename rather than delete to keep an audit
    # trail for diagnostics.
    try:
        session_state = spec_dir / ".session.json"
        if session_state.exists():
            archive = spec_dir / f".session.{timestamp}.too-long.json"
            session_state.rename(archive)
            logger.info(
                "[%s] Archived .session.json (resume marker) to %s",
                phase,
                archive.name,
            )
    except OSError as e:
        logger.warning("Could not archive .session.json: %s", e)

    # Layer 3: pop the in-process resume env var. Without this, the next
    # create_client() inside the same Python process would re-apply the
    # poisoned session_id even after we cleaned up the on-disk markers.
    import os as _os

    if _os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None) is not None:
        logger.info(
            "[%s] Cleared AUTO_CLAUDE_RESUME_SESSION_ID from process env", phase
        )

    halt_data = {
        "halted_at": datetime.now().isoformat(),
        "error": str(error)[:500],
        "phase": phase,
        "remediation": (
            "Conversation log archived (conversation.<timestamp>.too-long.jsonl). "
            "Resume to start a fresh session, OR switch to a provider with a "
            "larger context window."
        ),
    }
    halt_file = spec_dir / PROMPT_TOO_LONG_HALT_FILE
    try:
        halt_file.write_text(json.dumps(halt_data), encoding="utf-8")
    except OSError as e:
        # Marker is best-effort — escalation must still happen even if we
        # couldn't write it.
        logger.warning("Could not write prompt-too-long halt marker: %s", e)

    return True
