"""
Agent Session Management
========================

Handles running agent sessions and post-session processing including
memory updates, recovery tracking, and Linear integration.
"""

import logging
import re
from pathlib import Path
from typing import Any, Union

# Make claude_agent_sdk optional for testing and provider-agnostic mode
try:
    from claude_agent_sdk import ClaudeSDKClient
except ImportError:
    ClaudeSDKClient = None  # type: ignore[assignment,misc]

from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.conversation_log import append_message as _log_append_message
from debug import debug, debug_detailed, debug_error, debug_section, debug_success
from insight_extractor import extract_session_insights
from linear_updater import (
    linear_subtask_completed,
    linear_subtask_failed,
)
from progress import (
    count_subtasks_detailed,
    is_build_complete,
)
from recovery import RecoveryManager
from security.tool_input_validator import get_safe_tool_input
from task_logger import (
    LogEntryType,
    LogPhase,
    get_task_logger,
)
from ui import (
    StatusManager,
    muted,
    print_key_value,
    print_status,
)

from .base import sanitize_error_message
from .decision_logger import AgentDecisionLogger, create_decision_logger
from .memory_manager import save_session_memory
from .utils import (
    find_subtask_in_plan,
    get_commit_count,
    get_latest_commit,
    load_implementation_plan,
    sync_spec_to_source,
)

try:
    from core.usage_tracker import record_session_usage as _record_usage
except ImportError:
    _record_usage = None  # type: ignore[assignment]

try:
    from replay.recorder import get_replay_recorder as _get_replay_recorder

    _REPLAY_AVAILABLE = True
except ImportError:
    _REPLAY_AVAILABLE = False
    _get_replay_recorder = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


# Maximum length for the tool-input string shown in the live activity feed
# and task logs. Generous enough that real-world commands and file paths are
# displayed in full so the user can see exactly what the agent is doing; only
# pathological inputs (e.g. an inline heredoc embedding a whole file) are
# trimmed so they can't flood the console or task log.
MAX_TOOL_INPUT_DISPLAY = 2000


def _format_tool_input_display(inp: dict[str, Any] | None) -> str | None:
    """Build a human-readable one-liner describing a tool call's input.

    Commands and paths are shown in full (up to MAX_TOOL_INPUT_DISPLAY) so the
    activity feed reveals the complete command rather than a truncated head.
    For over-long inputs we keep the head of a command and the tail of a path
    (the filename is the most useful part of a long path).
    """
    if not inp:
        return None
    if "pattern" in inp:
        return f"pattern: {inp['pattern']}"
    if "file_path" in inp:
        fp = str(inp["file_path"])
        if len(fp) > MAX_TOOL_INPUT_DISPLAY:
            fp = "..." + fp[-(MAX_TOOL_INPUT_DISPLAY - 3) :]
        return fp
    if "command" in inp:
        cmd = str(inp["command"])
        if len(cmd) > MAX_TOOL_INPUT_DISPLAY:
            cmd = cmd[: MAX_TOOL_INPUT_DISPLAY - 3] + "..."
        return cmd
    if "path" in inp:
        return str(inp["path"])
    return None


def _read_current_subtask_id(spec_dir: Path) -> str | None:
    """Best-effort lookup of the current subtask id from task_metadata.json.

    Stored as `current_subtask_id` by the coder when it picks the next pending
    subtask. May be absent (planner, qa, spec phases) — in which case None is
    fine; the conversation log just won't carry a subtask attribution.
    """
    try:
        import json as _json

        metadata_file = spec_dir / "task_metadata.json"
        if not metadata_file.exists():
            return None
        data = _json.loads(metadata_file.read_text(encoding="utf-8"))
        value = data.get("current_subtask_id")
        return str(value) if value else None
    except Exception:
        return None


# Cap on how many historical messages we re-inject into a new session.
# Above this the resume preamble dominates the prompt and the very next query
# trips "Prompt is too long" — replaying 1000+ turns is also useless context-
# wise because the model can't reason over that much detail anyway. Keep the
# tail (most recent context) and archive the rest. Empirically ~200 turns is
# the sweet spot for keeping useful continuity without burning the budget.
MAX_REPLAY_MESSAGES = 200

# Even after the message-count cap above, replay can still blow the context
# window if individual messages are huge (e.g. the system prompt with its
# WORKTREE preamble is ~25k chars × N repeats). Cap the total replay payload
# at a fraction of a typical 200k-token window so the preamble never crowds
# out the actual task. 600 KB ≈ 150k tokens, leaving headroom for the new
# prompt + assistant response.
MAX_REPLAY_TOTAL_CHARS = 600_000


def _entry_is_useful_for_replay(entry: dict) -> bool:
    """Decide whether a conversation log entry should be re-injected.

    The log accumulates a lot of cruft that's useful for diagnostics but
    actively harmful when fed back to the model:

    * ``role: system`` with no content — pure noise from internal bookkeeping.
    * ``role: system`` with only ``result`` blocks — tool results that have
      already been consumed by their assistant turn.
    * The system preamble re-sent on every session start (``⛔ ISOLATED
      WORKTREE``, project index, instructions block). It's ~25k chars and the
      next session will receive a fresh copy from generate_planner_prompt /
      similar, so replaying the old one is pure duplication.
    * Bare ``"Prompt is too long"`` assistant turns — the very thing that
      poisoned the log in the first place. Replaying them invites the model
      to mimic the pattern.

    Returns True iff the entry should be kept for replay.
    """
    role = entry.get("role")
    content = entry.get("content") or []

    if not content:
        # Empty content is purely structural; nothing to inject.
        return False

    block_types = [b.get("type") for b in content]

    # System turns with only tool-result blocks are useless without the
    # surrounding assistant tool_use turn, and they're noisy.
    if role == "system":
        if not any(
            t == "text" and (content[i].get("text") or "").strip()
            for i, t in enumerate(block_types)
        ):
            return False

    # Drop bare prompt-too-long echoes so we don't seed the next session with
    # the same failure mode.
    if role == "assistant" and block_types == ["text"]:
        only_text = (content[0].get("text") or "").strip()
        if 0 < len(only_text) <= 80 and is_prompt_too_long_error(
            RuntimeError(only_text)
        ):
            return False

    # Drop the recurring "⛔ ISOLATED WORKTREE" / planner-prompt preamble.
    # It's recreated fresh on every session start by the prompt generators,
    # so replaying old copies is duplication AND the single biggest source of
    # context-window pressure (we measured 137 copies × ~24700 chars in one
    # poisoned log).
    if role == "user" and block_types == ["text"]:
        first_text = (content[0].get("text") or "").lstrip()
        # Markers come from prompts/coder_prompt.py and prompts/planner_prompt.py.
        preamble_markers = (
            "## ⛔ ISOLATED WORKTREE",
            "⛔ ISOLATED WORKTREE",
            "## CRITICAL: TOOL CONCURRENCY ERROR",
        )
        if any(first_text.startswith(m) for m in preamble_markers):
            return False

    return True


async def _maybe_replay_conversation(
    client: AgentClient,
    spec_dir: Path,
    provider: str,
    model: str,
) -> None:
    """If a prior conversation log exists for this spec, deserialize it and
    hand it to ``client.resume()`` so the new provider picks up the context.

    If the log is larger than ``MAX_REPLAY_MESSAGES`` we keep only the most
    recent messages and archive the full history alongside. Without this
    cap, a long-running task accumulated hundreds of turns and every session
    start re-injected the whole thing as a "transcript preamble", which is
    what caused the
    ``Replaying 1057 prior message(s) … / Prompt is too long`` cascade
    the user kept hitting.

    Silent on failure: the conversation log is best-effort and must never
    take down a session start.
    """
    try:
        from core.conversation_log import (
            CONVERSATION_LOG_FILENAME,
            deserialize_message,
            read_log,
        )

        log_file = spec_dir / CONVERSATION_LOG_FILENAME
        if not log_file.exists():
            return
        entries = read_log(spec_dir)
        if not entries:
            return

        # First pass: drop entries that have no business being re-injected
        # (system noise, the giant WORKTREE preamble we recreate every session,
        # bare "Prompt is too long" echoes). This is what actually shrinks the
        # replay payload — the count cap alone wasn't enough because the
        # preamble was being replayed up to 137 times in a single 200-message
        # window.
        original_count = len(entries)
        entries = [e for e in entries if _entry_is_useful_for_replay(e)]
        dropped = original_count - len(entries)
        if dropped:
            logger.info(
                "[session] Filtered %d/%d log entries from replay "
                "(system noise / duplicate preambles / prompt-too-long echoes)",
                dropped,
                original_count,
            )

        if len(entries) > MAX_REPLAY_MESSAGES:
            # Archive the full log so we never lose the audit trail, then
            # truncate the on-disk file to the trimmed tail so subsequent
            # sessions also start from the smaller window.
            try:
                from datetime import datetime as _dt

                _timestamp = _dt.now().strftime("%Y%m%d-%H%M%S")
                _archive = spec_dir / f"conversation.{_timestamp}.trimmed.jsonl"
                log_file.rename(_archive)
                logger.info(
                    "[session] Archived %d-message conversation log to %s "
                    "(keeping last %d for replay)",
                    len(entries),
                    _archive.name,
                    MAX_REPLAY_MESSAGES,
                )
                # Rewrite the trimmed + filtered tail back to the live log path
                # so the next iteration sees a small file.
                import json as _json

                tail = entries[-MAX_REPLAY_MESSAGES:]
                with log_file.open("wb") as f:
                    for entry in tail:
                        f.write(
                            (_json.dumps(entry, ensure_ascii=False) + "\n").encode(
                                "utf-8"
                            )
                        )
                entries = tail
            except OSError as _trim_err:
                logger.warning(
                    "[session] Could not trim oversized conversation log: %s — "
                    "falling back to skipping replay entirely",
                    _trim_err,
                )
                return

        # Second pass: even after dropping noise, enforce a hard cap on the
        # total payload size. Walk from the tail and stop once we've collected
        # enough recent context. This is the safety net that keeps a small
        # number of huge tool outputs (e.g. a 100k-line file read) from
        # blowing the context window on its own.
        sized: list[dict] = []
        running = 0
        for entry in reversed(entries):
            entry_chars = sum(
                len(b.get("text") or "") for b in (entry.get("content") or [])
            )
            if running + entry_chars > MAX_REPLAY_TOTAL_CHARS and sized:
                # Keep at least one message (sized non-empty), but stop here.
                break
            sized.append(entry)
            running += entry_chars
        sized.reverse()
        if len(sized) < len(entries):
            logger.info(
                "[session] Capped replay at %d/%d messages (~%d KB) to stay "
                "under the context window",
                len(sized),
                len(entries),
                running // 1024,
            )
        entries = sized

        history = [deserialize_message(e) for e in entries]
        debug(
            "session",
            f"Replaying {len(history)} prior message(s) from conversation log "
            f"into [{provider}/{model}]",
        )
        await client.resume(history)
    except Exception as e:
        logger.warning(
            "Could not replay conversation log from %s: %s — starting fresh",
            spec_dir,
            e,
        )


def _maybe_inject_pending_tool_use_note(message: str, spec_dir: Path) -> str:
    """If the conversation log ends on an assistant turn with a tool_use that
    never received its tool_result, prepend a directive to the user message
    telling the LLM to re-issue the tool call before continuing.

    Without this, the new provider would resume mid-thought without realising
    it had asked for an action that was never executed.
    """
    try:
        from core.conversation_log import has_pending_tool_use, read_log

        entries = read_log(spec_dir)
        if not entries or not has_pending_tool_use(entries):
            return message
        directive = (
            "[Resume directive] The previous session ended while a tool call "
            "was in flight and never received its result. Please re-issue the "
            "tool call you intended at the end of the prior conversation, then "
            "continue with the task below.\n\n"
        )
        return directive + message
    except Exception as e:
        logger.warning("Could not check for pending tool_use in %s: %s", spec_dir, e)
        return message


def is_tool_concurrency_error(error: Exception) -> bool:
    """
    Check if an error is a 400 tool concurrency error from Claude API.

    Tool concurrency errors occur when too many tools are used simultaneously
    in a single API request, hitting Claude's concurrent tool use limit.

    Args:
        error: The exception to check

    Returns:
        True if this is a tool concurrency error, False otherwise
    """
    error_str = str(error).lower()
    # Check for 400 status AND tool concurrency keywords
    return "400" in error_str and (
        ("tool" in error_str and "concurrency" in error_str)
        or "too many tools" in error_str
        or "concurrent tool" in error_str
    )


def is_rate_limit_error(error: Exception) -> bool:
    """
    Check if an error is a rate limit error (429 or similar).

    Rate limit errors occur when the API usage quota is exceeded,
    either for session limits or weekly limits.

    Args:
        error: The exception to check

    Returns:
        True if this is a rate limit error, False otherwise
    """
    error_str = str(error).lower()

    # Check for HTTP 429 with word boundaries to avoid false positives
    if re.search(r"\b429\b", error_str):
        return True

    # Check for other rate limit indicators. The "hit your" patterns cover
    # the Claude CLI shapes "You've hit your limit · resets …" AND the newer
    # "You've hit your session limit · resets …" / "weekly limit" variants —
    # missing the session/weekly word here caused the orchestration loop to
    # treat the error as a generic failure and retry, which in turn polluted
    # the conversation summary until the prompt itself blew the context window
    # ("Prompt is too long").
    return any(
        p in error_str
        for p in [
            "limit reached",
            "rate limit",
            "rate_limit",  # SDK may use underscore variant (e.g., "rate_limit_event")
            "hit your limit",
            "hit your session limit",
            "hit your weekly limit",
            "session limit",
            "weekly limit",
            "too many requests",
            "usage limit",
            "quota exceeded",
        ]
    )


def _response_text_indicates_prompt_too_long(response_text: str) -> bool:
    """Return True if the LLM's *response text* (not exception) signals that
    the prompt was rejected for being too long.

    Some providers — notably the Claude Agent SDK in newer versions — surface
    "Prompt is too long" as a normal assistant TextBlock instead of raising,
    so the stream completes cleanly with status="continue" and the caller's
    error handlers never run. Without this check the coder loop keeps
    iterating, the conversation log keeps growing, and the user sees the same
    one-line response forever.

    The check is intentionally narrow: we only fire on very short responses
    that are essentially the error string, never on long assistant turns that
    happen to mention the phrase in passing.
    """
    if not response_text:
        return False
    stripped = response_text.strip()
    # Real responses are paragraphs; the SDK echo is just the bare error.
    # 80 chars covers shapes like "Prompt is too long: 250000 tokens".
    if len(stripped) > 80:
        return False
    return is_prompt_too_long_error(RuntimeError(stripped))


def is_prompt_too_long_error(error: Exception) -> bool:
    """
    Check if an error is a "prompt too long" error from any LLM provider.

    These come back as HTTP 400 + a message like:
    - Anthropic: "Prompt is too long"
    - OpenAI: "context length exceeded" / "maximum context length"
    - Generic: "input is too long"

    Unlike rate limits, these errors will NEVER succeed on retry with the
    same conversation — retrying just burns more attempts. Callers should
    escalate to human review with a clear reason instead of looping.

    Args:
        error: The exception to check

    Returns:
        True if this is a prompt-too-long error, False otherwise
    """
    error_str = str(error).lower()
    patterns = [
        "prompt is too long",
        "prompt too long",
        "context length exceeded",
        "context_length_exceeded",
        "maximum context length",
        "max_tokens_to_sample",  # Anthropic SDK shape
        "input is too long",
        "input too long",
        "request too large",
        "token limit",
    ]
    return any(p in error_str for p in patterns)


def is_authentication_error(error: Exception) -> bool:
    """
    Check if an error is an authentication error (401, token expired, etc.).

    Authentication errors occur when OAuth tokens are invalid, expired,
    or have been revoked (e.g., after token refresh on another process).

    Validation approach:
    - HTTP 401 status code is checked with word boundaries to minimize false positives
    - Additional string patterns are validated against lowercase error messages
    - Patterns are designed to match known Claude API and OAuth error formats

    Known false positive risks:
    - Generic error messages containing "unauthorized" or "access denied" may match
      even if not related to authentication (e.g., file permission errors)
    - Error messages containing these keywords in user-provided content could match
    - Mitigation: HTTP 401 check provides strong signal; string patterns are secondary

    Real-world validation:
    - Pattern matching has been tested against actual Claude API error responses
    - False positive rate is acceptable given the recovery mechanism (prompt user to re-auth)
    - If false positive occurs, user can simply resume without re-authenticating

    Args:
        error: The exception to check

    Returns:
        True if this is an authentication error, False otherwise
    """
    error_str = str(error).lower()

    # Check for HTTP 401 with word boundaries to avoid false positives
    if re.search(r"\b401\b", error_str):
        return True

    # Check for other authentication indicators
    # NOTE: "authentication failed" and "authentication error" are more specific patterns
    # to reduce false positives from generic "authentication" mentions
    return any(
        p in error_str
        for p in [
            "authentication failed",
            "authentication error",
            "unauthorized",
            "invalid token",
            "token expired",
            "authentication_error",
            "invalid_token",
            "token_expired",
            "not authenticated",
            "http 401",
        ]
    )


def _persist_subtask_changed_files(
    spec_dir: Path,
    project_dir: Path,
    plan: dict,
    subtask: dict,
    subtask_id: str,
    commit_before: str | None,
    commit_after: str | None,
) -> None:
    """Persist the files a completed subtask actually changed (git ground truth).

    The planner's ``files_to_modify`` / ``files_to_create`` are *predictions*
    made before any code is written and are frequently empty or inaccurate. Once
    a subtask completes we know the commits it produced, so we record the *real*
    diff in ``files_changed`` and let the UI prefer it for the per-subtask
    "files modified" view.

    Uses a union with any previously recorded files: ``commit_before`` is
    recaptured at the start of each coder session, so a subtask that spans
    multiple sessions (retries) would otherwise only keep its last session's
    diff. Failures here are non-fatal — file attribution is a UI nicety and must
    never block subtask completion.
    """
    try:
        from analysis.insight_extractor import get_changed_files

        changed = get_changed_files(project_dir, commit_before, commit_after)
        if not changed:
            return

        existing = subtask.get("files_changed") or []
        # Union, preserving first-seen order.
        merged = list(dict.fromkeys([*existing, *changed]))
        if merged == existing:
            return

        subtask["files_changed"] = merged

        from qa.criteria import save_implementation_plan

        save_implementation_plan(spec_dir, plan)
        print_status(
            f"Recorded {len(merged)} changed file(s) for subtask {subtask_id}",
            "success",
        )
    except Exception as e:
        logger.warning(f"Could not persist changed files for subtask {subtask_id}: {e}")


async def post_session_processing(
    spec_dir: Path,
    project_dir: Path,
    subtask_id: str,
    session_num: int,
    commit_before: str | None,
    commit_count_before: int,
    recovery_manager: RecoveryManager,
    linear_enabled: bool = False,
    status_manager: StatusManager | None = None,
    source_spec_dir: Path | None = None,
) -> bool:
    """
    Process session results and update memory automatically.

    This runs in Python (100% reliable) instead of relying on agent compliance.

    Args:
        spec_dir: Spec directory containing memory/
        project_dir: Project root for git operations
        subtask_id: The subtask that was being worked on
        session_num: Current session number
        commit_before: Git commit hash before session
        commit_count_before: Number of commits before session
        recovery_manager: Recovery manager instance
        linear_enabled: Whether Linear integration is enabled
        status_manager: Optional status manager for ccstatusline
        source_spec_dir: Original spec directory (for syncing back from worktree)

    Returns:
        True if subtask was completed successfully
    """
    print()
    print(muted("--- Post-Session Processing ---"))

    # Sync implementation plan back to source (for worktree mode)
    if sync_spec_to_source(spec_dir, source_spec_dir):
        print_status("Implementation plan synced to main project", "success")

    # Check if implementation plan was updated
    plan = load_implementation_plan(spec_dir)
    if not plan:
        print("  Warning: Could not load implementation plan")
        return False

    subtask = find_subtask_in_plan(plan, subtask_id)
    if not subtask:
        print(f"  Warning: Subtask {subtask_id} not found in plan")
        return False

    subtask_status = subtask.get("status", "pending")

    # Check for new commits
    commit_after = get_latest_commit(project_dir)
    commit_count_after = get_commit_count(project_dir)
    new_commits = commit_count_after - commit_count_before

    print_key_value("Subtask status", subtask_status)
    print_key_value("New commits", str(new_commits))

    # AUTO-BLOCK: If this is a manual verification task and no commits were made,
    # automatically mark it as "blocked" without waiting for human input.
    # This prevents the coder from asking "should I mark this as blocked?" indefinitely.
    verification = subtask.get("verification", {})
    is_manual_verification = verification.get("type") == "manual"

    # Force block for manual testing tasks with zero commits
    # This covers cases where subtask_status is "pending", "in_progress", or anything else
    if is_manual_verification and new_commits == 0:
        # Automatically mark as blocked - no commits means no code implementation,
        # just the agent asking questions
        old_status = subtask.get("status", "pending")

        # FORCE the status to "blocked" - ignore whatever the LLM set it to
        subtask["status"] = "blocked"
        subtask["_blocked_reason"] = "Manual testing required - no code changes"

        # Update implementation plan
        from qa.criteria import save_implementation_plan

        try:
            save_implementation_plan(spec_dir, plan)
            print_status(
                f"✓ Auto-blocked subtask {subtask_id} (manual verification, {new_commits} commits, was {old_status})",
                "warning",
            )
            subtask_status = "blocked"
        except Exception as e:
            logger.error(f"Could not auto-mark as blocked: {e}")
            print(f"  ✗ Warning: Could not auto-mark as blocked: {e}")

    if subtask_status == "completed":
        # Success! Record the attempt and good commit
        print_status(f"Subtask {subtask_id} completed successfully", "success")

        # Update status file
        if status_manager:
            subtasks = count_subtasks_detailed(spec_dir)
            status_manager.update_subtasks(
                completed=subtasks["completed"],
                total=subtasks["total"],
                in_progress=0,
            )

        # Record successful attempt
        recovery_manager.record_attempt(
            subtask_id=subtask_id,
            session=session_num,
            success=True,
            approach=f"Implemented: {subtask.get('description', 'subtask')[:100]}",
        )

        # Record good commit for rollback safety
        if commit_after and commit_after != commit_before:
            recovery_manager.record_good_commit(commit_after, subtask_id)
            print_status(f"Recorded good commit: {commit_after[:8]}", "success")

        # Record the actual files this subtask changed (ground truth from git),
        # so the per-subtask "files modified" view reflects reality instead of
        # the planner's pre-coding prediction.
        _persist_subtask_changed_files(
            spec_dir=spec_dir,
            project_dir=project_dir,
            plan=plan,
            subtask=subtask,
            subtask_id=subtask_id,
            commit_before=commit_before,
            commit_after=commit_after,
        )

        # Record Linear session result (if enabled)
        if linear_enabled:
            # Get progress counts for the comment
            subtasks_detail = count_subtasks_detailed(spec_dir)
            await linear_subtask_completed(
                spec_dir=spec_dir,
                subtask_id=subtask_id,
                completed_count=subtasks_detail["completed"],
                total_count=subtasks_detail["total"],
            )
            print_status("Linear progress recorded", "success")

        # Extract rich insights from session (LLM-powered analysis)
        try:
            extracted_insights = await extract_session_insights(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                commit_before=commit_before,
                commit_after=commit_after,
                success=True,
                recovery_manager=recovery_manager,
            )
            insight_count = len(extracted_insights.get("file_insights", []))
            pattern_count = len(extracted_insights.get("patterns_discovered", []))
            if insight_count > 0 or pattern_count > 0:
                print_status(
                    f"Extracted {insight_count} file insights, {pattern_count} patterns",
                    "success",
                )
        except Exception as e:
            logger.warning(f"Insight extraction failed: {e}")
            extracted_insights = None

        # Save session memory (Graphiti=primary, file-based=fallback)
        try:
            save_success, storage_type = await save_session_memory(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                success=True,
                subtasks_completed=[subtask_id],
                discoveries=extracted_insights,
            )
            if save_success:
                if storage_type == "graphiti":
                    print_status("Session saved to Graphiti memory", "success")
                else:
                    print_status(
                        "Session saved to file-based memory (fallback)", "info"
                    )
            else:
                print_status("Failed to save session memory", "warning")
        except Exception as e:
            logger.warning(f"Error saving session memory: {e}")
            print_status("Memory save failed", "warning")

        return True

    elif subtask_status == "blocked":
        # Subtask marked as blocked (waiting for manual testing/human intervention)
        print_status(
            f"Subtask {subtask_id} blocked: {subtask.get('_blocked_reason', 'waiting for manual testing')}",
            "warning",
        )

        # Record the blocked attempt
        recovery_manager.record_attempt(
            subtask_id=subtask_id,
            session=session_num,
            success=True,  # Blocking is considered success from code perspective
            approach=f"Marked as blocked: {subtask.get('_blocked_reason', 'manual testing required')}",
        )

        # Update status file
        if status_manager:
            subtasks = count_subtasks_detailed(spec_dir)
            status_manager.update_subtasks(
                completed=subtasks["completed"],
                total=subtasks["total"],
                in_progress=0,
            )

        # Record Linear session result (if enabled)
        if linear_enabled:
            attempt_count = recovery_manager.get_attempt_count(subtask_id)
            await linear_subtask_failed(
                spec_dir=spec_dir,
                subtask_id=subtask_id,
                attempt=attempt_count,
                error_summary=f"Blocked: {subtask.get('_blocked_reason', 'manual testing required')}",
            )

        return True  # Blocking is considered success - move to next subtask

    elif subtask_status == "in_progress":
        # Session ended without completion
        print_status(f"Subtask {subtask_id} still in progress", "warning")

        recovery_manager.record_attempt(
            subtask_id=subtask_id,
            session=session_num,
            success=False,
            approach="Session ended with subtask in_progress",
            error="Subtask not marked as completed",
        )

        # Still record commit if one was made (partial progress)
        if commit_after and commit_after != commit_before:
            recovery_manager.record_good_commit(commit_after, subtask_id)
            print_status(
                f"Recorded partial progress commit: {commit_after[:8]}", "info"
            )

        # Record Linear session result (if enabled)
        if linear_enabled:
            attempt_count = recovery_manager.get_attempt_count(subtask_id)
            await linear_subtask_failed(
                spec_dir=spec_dir,
                subtask_id=subtask_id,
                attempt=attempt_count,
                error_summary="Session ended without completion",
            )

        # Extract insights even from failed sessions (valuable for future attempts)
        try:
            extracted_insights = await extract_session_insights(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                commit_before=commit_before,
                commit_after=commit_after,
                success=False,
                recovery_manager=recovery_manager,
            )
        except Exception as e:
            logger.debug(f"Insight extraction failed for incomplete session: {e}")
            extracted_insights = None

        # Save failed session memory (to track what didn't work)
        try:
            await save_session_memory(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                success=False,
                subtasks_completed=[],
                discoveries=extracted_insights,
            )
        except Exception as e:
            logger.debug(f"Failed to save incomplete session memory: {e}")

        return False

    else:
        # Subtask still pending or failed
        print_status(
            f"Subtask {subtask_id} not completed (status: {subtask_status})", "error"
        )

        recovery_manager.record_attempt(
            subtask_id=subtask_id,
            session=session_num,
            success=False,
            approach="Session ended without progress",
            error=f"Subtask status is {subtask_status}",
        )

        # Record Linear session result (if enabled)
        if linear_enabled:
            attempt_count = recovery_manager.get_attempt_count(subtask_id)
            await linear_subtask_failed(
                spec_dir=spec_dir,
                subtask_id=subtask_id,
                attempt=attempt_count,
                error_summary=f"Subtask status: {subtask_status}",
            )

        # Extract insights even from completely failed sessions
        try:
            extracted_insights = await extract_session_insights(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                commit_before=commit_before,
                commit_after=commit_after,
                success=False,
                recovery_manager=recovery_manager,
            )
        except Exception as e:
            logger.debug(f"Insight extraction failed for failed session: {e}")
            extracted_insights = None

        # Save failed session memory (to track what didn't work)
        try:
            await save_session_memory(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=session_num,
                success=False,
                subtasks_completed=[],
                discoveries=extracted_insights,
            )
        except Exception as e:
            logger.debug(f"Failed to save failed session memory: {e}")

        return False


async def run_agent_session(
    client: Union["ClaudeSDKClient", AgentClient, Any],
    message: str,
    spec_dir: Path,
    verbose: bool = False,
    phase: LogPhase = LogPhase.CODING,
    streaming_wrapper: Any = None,
) -> tuple[str, str, dict]:
    """
    Run a single agent session using Claude Agent SDK or any AgentClient provider.

    This function accepts both raw ClaudeSDKClient instances (backward compatible)
    and wrapped AgentClient instances (provider-agnostic). If an AgentClient is
    passed, the normalized AgentMessage stream is used; otherwise the raw SDK
    message stream is consumed directly.

    Args:
        client: Claude SDK client or AgentClient instance
        message: The prompt to send
        spec_dir: Spec directory path
        verbose: Whether to show detailed output
        phase: Current execution phase for logging

    Returns:
        (status, response_text, error_info) where:
        - status: "continue", "complete", or "error"
        - response_text: Agent's response text
        - error_info: Dict with error details (empty if no error):
            - "type": "tool_concurrency" or "other"
            - "message": Error message string
            - "exception_type": Exception class name string
    """
    # If client is an AgentClient, delegate to the provider-agnostic session runner
    if isinstance(client, AgentClient):
        return await _run_agent_client_session(
            client,
            message,
            spec_dir,
            verbose,
            phase,
            streaming_wrapper=streaming_wrapper,
        )

    debug_section("session", f"Agent Session - {phase.value}")
    debug(
        "session",
        "Starting agent session",
        spec_dir=str(spec_dir),
        phase=phase.value,
        prompt_length=len(message),
        prompt_preview=message[:200] + "..." if len(message) > 200 else message,
    )
    print("Sending prompt to Claude Agent SDK...\n")

    # Get task logger for this spec
    task_logger = get_task_logger(spec_dir)
    current_tool = None
    message_count = 0
    tool_count = 0

    # Initialize replay recorder for this session (non-blocking, best-effort)
    _rs_id = None
    _rr = None
    if _REPLAY_AVAILABLE and spec_dir is not None:
        try:
            import uuid as _uuid_mod

            _rr = _get_replay_recorder()
            _rs_id = _uuid_mod.uuid4().hex[:16]
            _phase_to_role_replay = {
                LogPhase.PLANNING: "planner",
                LogPhase.CODING: "coder",
                LogPhase.VALIDATION: "qa_reviewer",
                LogPhase.QA_FIX: "qa_fixer",
            }
            _agent_role = _phase_to_role_replay.get(
                phase, phase.value if hasattr(phase, "value") else str(phase)
            )
            _rr.start_session(
                _rs_id,
                {
                    "agent_name": _agent_role.replace("_", " ").title(),
                    "agent_type": _agent_role,
                    "task": spec_dir.name,
                    "project_path": str(spec_dir.parent.parent.parent),
                    "model": getattr(getattr(client, "options", None), "model", "")
                    or "",
                },
            )
        except Exception:
            _rr = None
            _rs_id = None

    # Decision logger — structured record of agent decisions (non-blocking)
    _phase_to_agent = {
        LogPhase.PLANNING: "planner",
        LogPhase.CODING: "coder",
        LogPhase.VALIDATION: "qa_reviewer",
        LogPhase.QA_FIX: "qa_fixer",
    }
    _decision_logger: AgentDecisionLogger | None = None
    try:
        _decision_logger = create_decision_logger(
            spec_dir=spec_dir,
            agent_type=_phase_to_agent.get(phase, phase.value),
        )
    except Exception:
        logger.debug(
            "Failed to create decision logger; continuing without it", exc_info=True
        )

    try:
        # Send the query
        debug("session", "Sending query to Claude SDK...")
        await client.query(message)
        debug_success("session", "Query sent successfully")

        # Collect response text and show tool use
        response_text = ""
        _sdk_result_msg = None  # Captures ResultMessage (cost/usage) when emitted
        debug("session", "Starting to receive response stream...")
        async for msg in client.receive_response():
            msg_type = type(msg).__name__
            message_count += 1
            debug_detailed(
                "session",
                f"Received message #{message_count}",
                msg_type=msg_type,
            )

            # Capture ResultMessage (cost/usage info from the SDK)
            if msg_type == "ResultMessage":
                _sdk_result_msg = msg
                continue

            # Handle AssistantMessage (text and tool use)
            if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                for block in msg.content:
                    block_type = type(block).__name__

                    if block_type == "TextBlock" and hasattr(block, "text"):
                        response_text += block.text
                        print(block.text, end="", flush=True)
                        # Log text to task logger (persist without double-printing)
                        if task_logger and block.text.strip():
                            task_logger.log(
                                block.text,
                                LogEntryType.TEXT,
                                phase,
                                print_to_console=False,
                            )
                        # Stream agent thinking to live view
                        if streaming_wrapper and block.text.strip():
                            try:
                                await streaming_wrapper.emit_agent_thinking(
                                    block.text[:300]
                                )
                            except Exception:
                                pass
                        # Record agent response in replay
                        if _rr and _rs_id and block.text.strip():
                            try:
                                _rr.record_response(_rs_id, block.text)
                            except Exception:
                                pass
                    elif block_type == "ToolUseBlock" and hasattr(block, "name"):
                        tool_name = block.name
                        tool_input_display = None
                        tool_count += 1

                        # Safely extract tool input (handles None, non-dict, etc.)
                        inp = get_safe_tool_input(block)

                        # Extract meaningful tool input for display (full command)
                        tool_input_display = _format_tool_input_display(inp)

                        debug(
                            "session",
                            f"Tool call #{tool_count}: {tool_name}",
                            tool_input=tool_input_display,
                            full_input=str(inp)[:500] if inp else None,
                        )

                        # Log tool start (handles printing too)
                        if task_logger:
                            task_logger.tool_start(
                                tool_name,
                                tool_input_display,
                                phase,
                                print_to_console=True,
                            )
                        else:
                            print(f"\n[Tool: {tool_name}]", flush=True)

                        if verbose and hasattr(block, "input"):
                            input_str = str(block.input)
                            if len(input_str) > 300:
                                print(f"   Input: {input_str[:300]}...", flush=True)
                            else:
                                print(f"   Input: {input_str}", flush=True)
                        current_tool = tool_name

                        # Record tool use in replay
                        if _rr and _rs_id:
                            try:
                                if (
                                    tool_name in ("Edit", "Write")
                                    and inp
                                    and inp.get("file_path")
                                ):
                                    _op = "update" if tool_name == "Edit" else "create"
                                    _after = str(
                                        inp.get("new_string")
                                        or inp.get("content")
                                        or ""
                                    )
                                    _rr.record_file_change(
                                        _rs_id,
                                        inp["file_path"],
                                        operation=_op,
                                        after_content=_after,
                                    )
                                elif tool_name == "Bash" and inp and inp.get("command"):
                                    _rr.record_command(_rs_id, inp["command"])
                                else:
                                    _rr.record_tool_call(
                                        _rs_id, tool_name, tool_input_dict=inp or {}
                                    )
                            except Exception:
                                pass

                        # Record tool call in decision log (non-blocking)
                        if _decision_logger and inp is not None:
                            try:
                                _decision_logger.log_tool_call(tool_name, inp)
                            except Exception:
                                pass

                        # Stream tool use events to live view
                        if streaming_wrapper and inp:
                            try:
                                await streaming_wrapper.emit_tool_use(
                                    tool_name, tool_input_display
                                )
                                if tool_name in ("Edit", "Write") and inp.get(
                                    "file_path"
                                ):
                                    content = inp.get("content") or inp.get(
                                        "new_string", ""
                                    )
                                    await streaming_wrapper.emit_file_change(
                                        inp["file_path"],
                                        "update",
                                        content[:2000] if content else None,
                                    )
                                elif tool_name == "Bash" and inp.get("command"):
                                    await streaming_wrapper.emit_command(
                                        inp["command"][:500]
                                    )
                            except Exception:
                                pass

            # Handle UserMessage (tool results)
            elif msg_type == "UserMessage" and hasattr(msg, "content"):
                for block in msg.content:
                    block_type = type(block).__name__

                    if block_type == "ToolResultBlock":
                        result_content = getattr(block, "content", "")
                        is_error = getattr(block, "is_error", False)

                        # Check if this is an error (not just content containing "blocked")
                        if is_error and "blocked" in str(result_content).lower():
                            # Actual blocked command by security hook
                            debug_error(
                                "session",
                                f"Tool BLOCKED: {current_tool}",
                                result=str(result_content)[:300],
                            )
                            print(f"   [BLOCKED] {result_content}", flush=True)
                            if task_logger and current_tool:
                                task_logger.tool_end(
                                    current_tool,
                                    success=False,
                                    result="BLOCKED",
                                    detail=str(result_content),
                                    phase=phase,
                                )
                        elif is_error:
                            # Show errors (truncated)
                            error_str = str(result_content)[:500]
                            debug_error(
                                "session",
                                f"Tool error: {current_tool}",
                                error=error_str[:200],
                            )
                            print(f"   [Error] {error_str}", flush=True)
                            if task_logger and current_tool:
                                # Store full error in detail for expandable view
                                task_logger.tool_end(
                                    current_tool,
                                    success=False,
                                    result=error_str[:100],
                                    detail=str(result_content),
                                    phase=phase,
                                )
                        else:
                            # Tool succeeded
                            debug_detailed(
                                "session",
                                f"Tool success: {current_tool}",
                                result_length=len(str(result_content)),
                            )
                            if verbose:
                                result_str = str(result_content)[:200]
                                print(f"   [Done] {result_str}", flush=True)
                            else:
                                print("   [Done]", flush=True)
                            if task_logger and current_tool:
                                # Store full result in detail for expandable view (only for certain tools)
                                # Skip storing for very large outputs like Glob results
                                detail_content = None
                                if current_tool in (
                                    "Read",
                                    "Grep",
                                    "Bash",
                                    "Edit",
                                    "Write",
                                ):
                                    result_str = str(result_content)
                                    # Only store if not too large (detail truncation happens in logger)
                                    if (
                                        len(result_str) < 50000
                                    ):  # 50KB max before truncation
                                        detail_content = result_str
                                task_logger.tool_end(
                                    current_tool,
                                    success=True,
                                    detail=detail_content,
                                    phase=phase,
                                )

                        # Stream command output to live view
                        if streaming_wrapper and current_tool:
                            try:
                                if current_tool == "Bash":
                                    await streaming_wrapper.emit_command_output(
                                        str(result_content)[:1000], is_error=is_error
                                    )
                            except Exception:
                                pass

                        # Record tool result in replay
                        if _rr and _rs_id and current_tool:
                            try:
                                _result_str = str(result_content)[:2000]
                                if current_tool == "Bash":
                                    _rr.record_command_output(
                                        _rs_id, _result_str, is_error=is_error
                                    )
                                elif current_tool not in ("Edit", "Write"):
                                    _rr.record_tool_result(
                                        _rs_id,
                                        current_tool,
                                        output=_result_str,
                                        success=not is_error,
                                    )
                            except Exception:
                                pass

                        current_tool = None

        print("\n" + "-" * 70 + "\n")

        # Persist SDK session_id so the Kanban UI can offer "Resume" on
        # cards that hit max_turns/max_budget_usd. Best-effort: never fail
        # the session just because we couldn't write the marker file.
        if _sdk_result_msg is not None:
            try:
                _sid = getattr(_sdk_result_msg, "session_id", None)
                if _sid:
                    import json as _json

                    _state_path = spec_dir / ".session.json"
                    _state = {
                        "session_id": _sid,
                        "subtype": getattr(_sdk_result_msg, "subtype", None),
                        "model": getattr(
                            getattr(client, "options", None), "model", None
                        ),
                        "phase": phase.value,
                    }
                    _state_path.write_text(
                        _json.dumps(_state, indent=2), encoding="utf-8"
                    )
                    logger.debug(
                        "[session] Persisted session_id=%s subtype=%s to %s",
                        _sid,
                        _state["subtype"],
                        _state_path,
                    )
            except Exception as _se:
                logger.debug("[session] Could not persist session_id: %s", _se)

        # Record token usage from the SDK ResultMessage (best-effort)
        if _sdk_result_msg is not None and _record_usage is not None:
            try:
                usage = getattr(_sdk_result_msg, "usage", None) or {}
                input_tokens = (
                    usage.get("input_tokens", 0) if isinstance(usage, dict) else 0
                )
                output_tokens = (
                    usage.get("output_tokens", 0) if isinstance(usage, dict) else 0
                )
                # Cache token breakdown (SDK uses prompt caching automatically).
                # cache_creation: tokens written into a new cache entry (premium rate)
                # cache_read:     tokens served from cache (discounted rate)
                cache_creation = (
                    usage.get("cache_creation_input_tokens", 0)
                    if isinstance(usage, dict)
                    else 0
                )
                cache_read = (
                    usage.get("cache_read_input_tokens", 0)
                    if isinstance(usage, dict)
                    else 0
                )
                cost_usd = getattr(_sdk_result_msg, "total_cost_usd", None) or 0.0
                # Derive project_dir from spec_dir (spec_dir = project/.workpilot/specs/XXX)
                _project_dir = spec_dir.parent.parent.parent
                _model = getattr(getattr(client, "options", None), "model", "unknown")
                # Resolve provider via the same multi-strategy logic used by create_agent_client
                # (env vars, task_metadata.json, .workpilot/.env) — get_selected_provider()
                # always returns None in subprocess context so it's useless here.
                _provider = "anthropic"
                try:
                    from core.client import _get_active_provider

                    _active = _get_active_provider(spec_dir)
                    # _get_active_provider returns "claude" for Anthropic; normalise to "anthropic"
                    _provider = (
                        "anthropic" if _active in ("claude", "anthropic") else _active
                    )
                except Exception:
                    pass
                _record_usage(
                    spec_dir=spec_dir,
                    project_dir=_project_dir,
                    phase=phase.value,
                    agent_type=phase.value,
                    model=_model,
                    provider=_provider,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cost_usd=cost_usd,
                    cache_creation_input_tokens=cache_creation,
                    cache_read_input_tokens=cache_read,
                )
            except Exception as _ute:
                logger.debug("[usage_tracker] SDK usage recording failed: %s", _ute)

        # Check if build is complete
        if is_build_complete(spec_dir):
            debug_success(
                "session",
                "Session completed - build is complete",
                message_count=message_count,
                tool_count=tool_count,
                response_length=len(response_text),
            )
            if _rr and _rs_id:
                try:
                    _rr.end_session(_rs_id)
                except Exception:
                    pass
            return "complete", response_text, {}

        # Provider may surface "Prompt is too long" as a normal short text
        # response instead of an exception (Claude Agent SDK does this when
        # the resume preamble blew the context window). Reclassify so the
        # coder loop sees error_type="prompt_too_long" and halts cleanly,
        # otherwise the response just gets stored, the stream ends with
        # "continue", and the next iteration replays the same oversized log.
        if _response_text_indicates_prompt_too_long(response_text):
            debug_error(
                "session",
                "Reclassifying short prompt-too-long response as error",
                response_preview=response_text[:120],
            )
            error_info = {
                "type": "prompt_too_long",
                "message": response_text.strip(),
                "exception_type": "PromptTooLongResponse",
            }
            # Same defense-in-depth cleanup as the exception path so the next
            # session doesn't trip the same wall — see the equivalent block
            # below in `except Exception as e:` for the rationale.
            try:
                import os as _os
                from datetime import datetime as _dt

                _timestamp = _dt.now().strftime("%Y%m%d-%H%M%S")
                _log_file = spec_dir / "conversation.jsonl"
                if _log_file.exists():
                    _log_file.rename(
                        spec_dir / f"conversation.{_timestamp}.too-long.jsonl"
                    )
                _session_state = spec_dir / ".session.json"
                if _session_state.exists():
                    _session_state.rename(
                        spec_dir / f".session.{_timestamp}.too-long.json"
                    )
                _os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
            except OSError:
                pass
            if _rr and _rs_id:
                try:
                    _rr.end_session(_rs_id)
                except Exception:
                    pass
            return "error", response_text, error_info

        debug_success(
            "session",
            "Session completed - continuing",
            message_count=message_count,
            tool_count=tool_count,
            response_length=len(response_text),
        )
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "continue", response_text, {}

    except Exception as e:
        # Detect specific error types for better retry handling
        is_concurrency = is_tool_concurrency_error(e)
        is_rate_limit = is_rate_limit_error(e)
        is_auth = is_authentication_error(e)
        # Prompt-too-long check must run here so the caller can short-circuit
        # the retry loop with a single classification check, instead of having
        # to re-match the message string in every branch.
        is_too_long = is_prompt_too_long_error(e)

        # Classify error type for appropriate handling
        if is_concurrency:
            error_type = "tool_concurrency"
        elif is_too_long:
            error_type = "prompt_too_long"
        elif is_rate_limit:
            error_type = "rate_limit"
        elif is_auth:
            error_type = "authentication"
        else:
            error_type = "other"

        debug_error(
            "session",
            f"Session error: {e}",
            exception_type=type(e).__name__,
            error_category=error_type,
            message_count=message_count,
            tool_count=tool_count,
        )

        # Sanitize error message to remove potentially sensitive data
        # Must happen BEFORE printing to stdout, since stdout is captured by the frontend
        sanitized_error = sanitize_error_message(str(e))

        # Log errors prominently based on type
        if is_concurrency:
            print("\n⚠️  Tool concurrency limit reached (400 error)")
            print("   Claude API limits concurrent tool use in a single request")
            print(f"   Error: {sanitized_error[:200]}\n")
        elif is_too_long:
            print("\n⛔ Prompt too long — context window exceeded")
            print("   Retrying would fail identically. Halting.\n")
        elif is_rate_limit:
            print("\n⚠️  Rate limit reached")
            print("   API usage quota exceeded - waiting for reset")
            print(f"   Error: {sanitized_error[:200]}\n")
        elif is_auth:
            print("\n⚠️  Authentication error")
            print("   OAuth token may be invalid or expired")
            print(f"   Error: {sanitized_error[:200]}\n")
        else:
            print(f"Error during agent session: {sanitized_error}")

        if task_logger:
            task_logger.log_error(f"Session error: {sanitized_error}", phase)

        # Defense in depth: if the prompt overflowed the model's context, we
        # MUST break all three replay channels before returning, otherwise the
        # next session start re-injects the same giant transcript and trips
        # the same error again:
        #   1) our own conversation.jsonl (replayed by _maybe_replay_conversation)
        #   2) the SDK's .session.json resume pointer
        #   3) the in-process AUTO_CLAUDE_RESUME_SESSION_ID env var
        # See services/rate_limit_shield.handle_prompt_too_long for the same
        # cleanup chain — it's duplicated here because run_agent_session can
        # be reached without going through that shield (e.g. callers that
        # haven't wired the shield in yet).
        if is_too_long:
            try:
                import os as _os
                from datetime import datetime as _dt

                _timestamp = _dt.now().strftime("%Y%m%d-%H%M%S")
                _log_file = spec_dir / "conversation.jsonl"
                if _log_file.exists():
                    _archive = spec_dir / f"conversation.{_timestamp}.too-long.jsonl"
                    _log_file.rename(_archive)
                    logger.info(
                        "[session] Archived oversized conversation log to %s",
                        _archive.name,
                    )
                _session_state = spec_dir / ".session.json"
                if _session_state.exists():
                    _state_archive = spec_dir / f".session.{_timestamp}.too-long.json"
                    _session_state.rename(_state_archive)
                    logger.info(
                        "[session] Archived .session.json resume marker to %s",
                        _state_archive.name,
                    )
                _os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
            except OSError as _archive_err:
                logger.warning(
                    "[session] Could not archive oversized session state: %s",
                    _archive_err,
                )

        error_info = {
            "type": error_type,
            "message": sanitized_error,
            "exception_type": type(e).__name__,
        }
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "error", sanitized_error, error_info


# =============================================================================
# Provider-Agnostic Session Runner
# =============================================================================


async def _run_agent_client_session(
    client: AgentClient,
    message: str,
    spec_dir: Path,
    verbose: bool = False,
    phase: LogPhase = LogPhase.CODING,
    streaming_wrapper: Any = None,
) -> tuple[str, str, dict]:
    """
    Run a single agent session using any AgentClient provider.

    This is the provider-agnostic equivalent of run_agent_session().
    It processes normalized AgentMessage objects instead of raw SDK messages.

    Args:
        client: AgentClient instance (ClaudeAgentClient or CopilotAgentClient)
        message: The prompt to send
        spec_dir: Spec directory path
        verbose: Whether to show detailed output
        phase: Current execution phase for logging

    Returns:
        (status, response_text, error_info) — same contract as run_agent_session()
    """
    provider = client.provider_name()
    debug_section("session", f"Agent Session [{provider}] - {phase.value}")
    debug(
        "session",
        f"Starting {provider} agent session",
        spec_dir=str(spec_dir),
        phase=phase.value,
        prompt_length=len(message),
        prompt_preview=message[:200] + "..." if len(message) > 200 else message,
    )
    print(f"Sending prompt to {provider} agent...\n")

    task_logger = get_task_logger(spec_dir)
    current_tool = None
    message_count = 0
    tool_count = 0

    # Conversation log context: provider, model and subtask_id are persisted on
    # every message so a different provider can replay the transcript later.
    log_model = str(getattr(client, "model", "unknown"))
    log_subtask_id = _read_current_subtask_id(spec_dir)

    # If a prior session for this spec left a conversation log, replay it into
    # the client so the LLM has the same context — even when this run uses a
    # different provider than the one that originally produced the transcript.
    # If the last assistant message ended on an un-dispatched tool_use, append
    # a directive nudging the LLM to redo it.
    await _maybe_replay_conversation(client, spec_dir, provider, log_model)
    message = _maybe_inject_pending_tool_use_note(message, spec_dir)

    try:
        # Persist the initial user message before the network call so a process
        # crash between query() and the first stream chunk still leaves a usable
        # log for replay.
        _log_append_message(
            spec_dir,
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text=message)],
            ),
            phase=phase.value,
            provider=provider,
            model=log_model,
            subtask_id=log_subtask_id,
        )

        debug("session", f"Sending query to {provider}...")
        await client.query(message)
        debug_success("session", "Query sent successfully")

        response_text = ""
        debug("session", "Starting to receive response stream...")

        async for agent_msg in client.receive_response():  # noqa: SIM113 — result msg needs post-loop handling
            message_count += 1
            debug_detailed(
                "session",
                f"Received message #{message_count}",
                msg_type=agent_msg.type_name,
            )

            for block in agent_msg.content:
                if block.type == ContentBlockType.TEXT and block.text:
                    response_text += block.text
                    print(block.text, end="", flush=True)
                    if task_logger and block.text.strip():
                        task_logger.log(
                            block.text,
                            LogEntryType.TEXT,
                            phase,
                            print_to_console=False,
                        )
                    # Stream agent thinking to live view
                    if streaming_wrapper and block.text.strip():
                        try:
                            await streaming_wrapper.emit_agent_thinking(
                                block.text[:300]
                            )
                        except Exception:
                            pass

                elif block.type == ContentBlockType.TOOL_USE:
                    tool_name = block.tool_name or ""
                    tool_count += 1
                    inp = block.tool_input or {}
                    tool_input_display = _format_tool_input_display(inp)

                    debug(
                        "session",
                        f"Tool call #{tool_count}: {tool_name}",
                        tool_input=tool_input_display,
                    )

                    if task_logger:
                        task_logger.tool_start(
                            tool_name,
                            tool_input_display,
                            phase,
                            print_to_console=True,
                        )
                    else:
                        print(f"\n[Tool: {tool_name}]", flush=True)

                    if verbose and inp:
                        input_str = str(inp)
                        if len(input_str) > 300:
                            print(f"   Input: {input_str[:300]}...", flush=True)
                        else:
                            print(f"   Input: {input_str}", flush=True)
                    current_tool = tool_name

                    # Stream tool use events to live view
                    if streaming_wrapper and inp:
                        try:
                            await streaming_wrapper.emit_tool_use(
                                tool_name, tool_input_display
                            )
                            if tool_name in ("Edit", "Write") and inp.get("file_path"):
                                content = inp.get("content") or inp.get(
                                    "new_string", ""
                                )
                                await streaming_wrapper.emit_file_change(
                                    inp["file_path"],
                                    "update",
                                    content[:2000] if content else None,
                                )
                            elif tool_name == "Bash" and inp.get("command"):
                                await streaming_wrapper.emit_command(
                                    inp["command"][:500]
                                )
                        except Exception:
                            pass

                elif block.type == ContentBlockType.TOOL_RESULT:
                    is_error = block.is_error
                    result_content = block.result_content or ""

                    if is_error and "blocked" in str(result_content).lower():
                        debug_error(
                            "session",
                            f"Tool BLOCKED: {current_tool}",
                            result=str(result_content)[:300],
                        )
                        print(f"   [BLOCKED] {result_content}", flush=True)
                        if task_logger and current_tool:
                            task_logger.tool_end(
                                current_tool,
                                success=False,
                                result="BLOCKED",
                                detail=str(result_content),
                                phase=phase,
                            )
                    elif is_error:
                        error_str = str(result_content)[:500]
                        debug_error(
                            "session",
                            f"Tool error: {current_tool}",
                            error=error_str[:200],
                        )
                        print(f"   [Error] {error_str}", flush=True)
                        if task_logger and current_tool:
                            task_logger.tool_end(
                                current_tool,
                                success=False,
                                result=error_str[:100],
                                detail=str(result_content),
                                phase=phase,
                            )
                    else:
                        debug_detailed(
                            "session",
                            f"Tool success: {current_tool}",
                            result_length=len(str(result_content)),
                        )
                        if verbose:
                            result_str = str(result_content)[:200]
                            print(f"   [Done] {result_str}", flush=True)
                        else:
                            print("   [Done]", flush=True)
                        if task_logger and current_tool:
                            detail_content = None
                            if current_tool in (
                                "Read",
                                "Grep",
                                "Bash",
                                "Edit",
                                "Write",
                            ):
                                result_str = str(result_content)
                                if len(result_str) < 50000:
                                    detail_content = result_str
                            task_logger.tool_end(
                                current_tool,
                                success=True,
                                detail=detail_content,
                                phase=phase,
                            )

                    # Stream command output to live view
                    if streaming_wrapper and current_tool:
                        try:
                            if current_tool == "Bash":
                                await streaming_wrapper.emit_command_output(
                                    str(result_content)[:1000], is_error=is_error
                                )
                        except Exception:
                            pass

                    current_tool = None

            # Persist this assistant message in the conversation log AFTER all
            # its blocks have been processed. This way the log mirrors what the
            # agent actually emitted (text + tool_use + tool_result), making it
            # safe to replay against a different provider after a pause.
            _log_append_message(
                spec_dir,
                agent_msg,
                phase=phase.value,
                provider=provider,
                model=log_model,
                subtask_id=log_subtask_id,
            )

        print("\n" + "-" * 70 + "\n")

        # Persist SDK session_id on the AgentClient path too, mirroring the
        # raw SDK branch above. Without this the "Reprendre" button in the
        # Kanban UI has no .session.json to read when the user runs through
        # the provider-agnostic factory (i.e. nearly every flow today).
        _agent_session_id = getattr(client, "last_session_id", None)
        if _agent_session_id:
            try:
                import json as _json_session

                _state_path = spec_dir / ".session.json"
                _state = {
                    "session_id": _agent_session_id,
                    "subtype": getattr(
                        getattr(client, "last_result_msg", None), "subtype", None
                    ),
                    "model": getattr(client, "model", None),
                    "phase": phase.value,
                }
                _state_path.write_text(
                    _json_session.dumps(_state, indent=2), encoding="utf-8"
                )
                logger.debug(
                    "[session] Persisted session_id=%s (AgentClient) to %s",
                    _agent_session_id,
                    _state_path,
                )
            except Exception as _se:
                logger.debug("[session] AgentClient session_id persist failed: %s", _se)

        # Record token usage from AgentClient (best-effort via duck typing)
        if _record_usage is not None:
            try:
                _usage = getattr(client, "last_usage", None)
                if _usage is not None:
                    _project_dir = spec_dir.parent.parent.parent
                    _record_usage(
                        spec_dir=spec_dir,
                        project_dir=_project_dir,
                        phase=phase.value,
                        agent_type=phase.value,
                        model=getattr(client, "model", "unknown"),
                        provider=client.provider_name(),
                        input_tokens=_usage.get("input_tokens", 0),
                        output_tokens=_usage.get("output_tokens", 0),
                        cost_usd=_usage.get("cost_usd", 0.0),
                        cache_creation_input_tokens=_usage.get(
                            "cache_creation_input_tokens", 0
                        ),
                        cache_read_input_tokens=_usage.get(
                            "cache_read_input_tokens", 0
                        ),
                    )
            except Exception as _ute:
                logger.debug(
                    "[usage_tracker] AgentClient usage recording failed: %s", _ute
                )

        if is_build_complete(spec_dir):
            debug_success(
                "session",
                "Session completed - build is complete",
                message_count=message_count,
                tool_count=tool_count,
                response_length=len(response_text),
            )
            return "complete", response_text, {}

        # Same reclassification as in the SDK-direct runner — providers can
        # surface "Prompt is too long" as a plain text response. See the
        # corresponding block in run_agent_session() for the full rationale.
        if _response_text_indicates_prompt_too_long(response_text):
            debug_error(
                "session",
                "Reclassifying short prompt-too-long response as error (AgentClient)",
                response_preview=response_text[:120],
            )
            try:
                import os as _os
                from datetime import datetime as _dt

                _timestamp = _dt.now().strftime("%Y%m%d-%H%M%S")
                _log_file = spec_dir / "conversation.jsonl"
                if _log_file.exists():
                    _log_file.rename(
                        spec_dir / f"conversation.{_timestamp}.too-long.jsonl"
                    )
                _session_state = spec_dir / ".session.json"
                if _session_state.exists():
                    _session_state.rename(
                        spec_dir / f".session.{_timestamp}.too-long.json"
                    )
                _os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
            except OSError:
                pass
            return (
                "error",
                response_text,
                {
                    "type": "prompt_too_long",
                    "message": response_text.strip(),
                    "exception_type": "PromptTooLongResponse",
                },
            )

        debug_success(
            "session",
            "Session completed - continuing",
            message_count=message_count,
            tool_count=tool_count,
            response_length=len(response_text),
        )
        return "continue", response_text, {}

    except Exception as e:
        is_concurrency = is_tool_concurrency_error(e)
        is_rate_limit_err = is_rate_limit_error(e)
        is_auth = is_authentication_error(e)
        is_too_long = is_prompt_too_long_error(e)

        if is_concurrency:
            error_type = "tool_concurrency"
        elif is_too_long:
            error_type = "prompt_too_long"
        elif is_rate_limit_err:
            error_type = "rate_limit"
        elif is_auth:
            error_type = "authentication"
        else:
            error_type = "other"

        debug_error(
            "session",
            f"Session error: {e}",
            exception_type=type(e).__name__,
            error_category=error_type,
            message_count=message_count,
            tool_count=tool_count,
        )

        sanitized_error = sanitize_error_message(str(e))

        if is_concurrency:
            print("\n⚠️  Tool concurrency limit reached (400 error)")
            print(f"   Error: {sanitized_error[:200]}\n")
        elif is_too_long:
            print("\n⛔ Prompt too long — context window exceeded")
            print("   Retrying would fail identically. Halting.\n")
        elif is_rate_limit_err:
            print("\n⚠️  Rate limit reached")
            print(f"   Error: {sanitized_error[:200]}\n")
        elif is_auth:
            print("\n⚠️  Authentication error")
            print(f"   Error: {sanitized_error[:200]}\n")
        else:
            print(f"Error during agent session: {sanitized_error}")

        if task_logger:
            task_logger.log_error(f"Session error: {sanitized_error}", phase)

        error_info = {
            "type": error_type,
            "message": sanitized_error,
            "exception_type": type(e).__name__,
        }
        return "error", sanitized_error, error_info
