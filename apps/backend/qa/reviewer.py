"""
QA Reviewer Agent Session
==========================

Runs QA validation sessions to review implementation against
acceptance criteria.

Memory Integration:
- Retrieves past patterns, gotchas, and insights before QA session
- Saves QA findings (bugs, patterns, validation outcomes) after session
"""

from pathlib import Path
from typing import Any, Union

# Memory integration for cross-session learning
from agents.agent_audit import audit_event
from agents.memory_manager import get_graphiti_context, save_session_memory
from core.agent_client import AgentClient, ContentBlockType

try:
    from claude_agent_sdk import ClaudeSDKClient
except ImportError:
    ClaudeSDKClient = None  # type: ignore[assignment,misc]

try:
    from claude_agent_sdk.types import ResultMessage
except ImportError:
    ResultMessage = None  # type: ignore[assignment,misc]

from debug import (
    debug,
    debug_detailed,
    debug_error,
    debug_section,
    debug_success,
    debug_warning,
)
from prompts_pkg import get_qa_reviewer_prompt
from security.tool_input_validator import get_safe_tool_input
from task_logger import (
    LogEntryType,
    LogPhase,
    get_task_logger,
)

from .criteria import (
    get_qa_signoff_status,
    load_implementation_plan,
    save_implementation_plan,
)

try:
    from core.usage_tracker import record_qa_result as _ut_record_qa
except ImportError:
    _ut_record_qa = None  # type: ignore[assignment]

try:
    from replay.recorder import get_replay_recorder as _get_replay_recorder

    _REPLAY_AVAILABLE = True
except ImportError:
    _REPLAY_AVAILABLE = False
    _get_replay_recorder = None  # type: ignore[assignment]

import re
from datetime import datetime, timezone


def _extract_verdict_from_response(response_text: str) -> str | None:
    """
    Parse the QA agent's response text to extract APPROVED/REJECTED verdict.

    This is a fallback for when the agent doesn't properly update
    implementation_plan.json. We look for clear verdict signals in the
    agent's output text.

    Returns: "approved", "rejected", or None if inconclusive.
    """
    if not response_text:
        return None

    text_upper = response_text.upper()

    # Look for explicit sign-off patterns
    # Pattern: "SIGN-OFF: APPROVED" or "Sign-off: REJECTED"
    signoff_match = re.search(
        r"SIGN[\-\s]*OFF\s*:\s*(APPROVED|REJECTED)",
        text_upper,
    )
    if signoff_match:
        return signoff_match.group(1).lower()

    # Pattern: "Status: APPROVED" or "Status: REJECTED"
    status_match = re.search(
        r"STATUS\s*:\s*(APPROVED|REJECTED)",
        text_upper,
    )
    if status_match:
        return status_match.group(1).lower()

    # Pattern: "QA VALIDATION COMPLETE" + "APPROVED ✓" or "REJECTED ✗"
    if "QA VALIDATION COMPLETE" in text_upper:
        if "APPROVED" in text_upper:
            return "approved"
        if "REJECTED" in text_upper:
            return "rejected"

    return None


def _programmatic_qa_signoff(
    spec_dir: Path,
    verdict: str,
    qa_session: int,
) -> bool:
    """
    Programmatically write the qa_signoff to implementation_plan.json.

    This is a fallback when the agent produces a clear verdict in its
    response text but fails to update the file itself.

    Returns True if successfully written.
    """
    plan = load_implementation_plan(spec_dir)
    if not plan:
        return False

    now = datetime.now(timezone.utc).isoformat()

    if verdict == "approved":
        plan["qa_signoff"] = {
            "status": "approved",
            "timestamp": now,
            "qa_session": qa_session,
            "report_file": "qa_report.md",
            "tests_passed": {},
            "verified_by": "qa_agent (auto-extracted from response)",
        }
    elif verdict == "rejected":
        plan["qa_signoff"] = {
            "status": "rejected",
            "timestamp": now,
            "qa_session": qa_session,
            "issues_found": [],
            "fix_request_file": "QA_FIX_REQUEST.md",
        }
    else:
        return False

    return save_implementation_plan(spec_dir, plan)


# =============================================================================
# QA REVIEWER SESSION
# =============================================================================


async def run_qa_agent_session(
    client: Union["ClaudeSDKClient", AgentClient, Any],
    project_dir: Path,
    spec_dir: Path,
    qa_session: int,
    max_iterations: int,
    verbose: bool = False,
    previous_error: dict | None = None,
) -> tuple[str, str]:
    """
    Run a QA reviewer agent session.

    Accepts both raw ClaudeSDKClient instances (backward compatible) and
    wrapped AgentClient instances (provider-agnostic). If an AgentClient is
    passed, normalized AgentMessage stream is used; otherwise the raw SDK
    message stream is consumed directly.

    Args:
        client: Claude SDK client or AgentClient instance
        project_dir: Project root directory (for capability detection)
        spec_dir: Spec directory
        qa_session: QA iteration number
        max_iterations: Maximum number of QA iterations
        verbose: Whether to show detailed output
        previous_error: Error context from previous iteration for self-correction

    Returns:
        (status, response_text) where status is:
        - "approved" if QA approves
        - "rejected" if QA finds issues
        - "error" if an error occurred
    """
    debug_section("qa_reviewer", f"QA Reviewer Session {qa_session}")
    debug(
        "qa_reviewer",
        "Starting QA reviewer session",
        spec_dir=str(spec_dir),
        qa_session=qa_session,
        max_iterations=max_iterations,
    )
    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="qa_reviewer",
        correlation_id=spec_dir.name,
        summary=f"QA reviewer session {qa_session} invoked",
        payload={"qa_session": qa_session, "max_iterations": max_iterations},
    )

    print(f"\n{'=' * 70}")
    print(f"  QA REVIEWER SESSION {qa_session}")
    print("  Validating all acceptance criteria...")
    print(f"{'=' * 70}\n")

    # Get task logger for streaming markers
    task_logger = get_task_logger(spec_dir)
    current_tool = None
    message_count = 0
    tool_count = 0

    # Initialize replay recorder for this QA session (non-blocking, best-effort)
    _rs_id = None
    _rr = None
    if _REPLAY_AVAILABLE:
        try:
            import uuid as _uuid_mod

            _rr = _get_replay_recorder()
            _rs_id = _uuid_mod.uuid4().hex[:16]
            _rr.start_session(
                _rs_id,
                {
                    "agent_name": "QA Reviewer",
                    "agent_type": "qa_reviewer",
                    "task": spec_dir.name,
                    "project_path": str(spec_dir.parent.parent.parent),
                    "model": getattr(getattr(client, "options", None), "model", "")
                    or "",
                },
            )
        except Exception:
            _rr = None
            _rs_id = None

    # Load QA prompt with dynamically-injected project-specific MCP tools
    # This includes Electron validation for Electron apps, Puppeteer for web, etc.
    prompt = get_qa_reviewer_prompt(spec_dir, project_dir)
    debug_detailed(
        "qa_reviewer",
        "Loaded QA reviewer prompt with project-specific tools",
        prompt_length=len(prompt),
        project_dir=str(project_dir),
    )

    # Retrieve memory context for QA (past patterns, gotchas, validation insights)
    qa_memory_context = await get_graphiti_context(
        spec_dir,
        project_dir,
        {
            "description": "QA validation and acceptance criteria review",
            "id": f"qa_reviewer_{qa_session}",
        },
    )
    if qa_memory_context:
        prompt += "\n\n" + qa_memory_context
        print("✓ Memory context loaded for QA reviewer")
        debug_success("qa_reviewer", "Graphiti memory context loaded for QA")

    # Add session context
    prompt += f"\n\n---\n\n**QA Session**: {qa_session}\n"
    prompt += f"**Max Iterations**: {max_iterations}\n"

    # Add error context for self-correction if previous iteration failed
    if previous_error:
        debug(
            "qa_reviewer",
            "Adding error context for self-correction",
            error_type=previous_error.get("error_type"),
            consecutive_errors=previous_error.get("consecutive_errors"),
        )
        prompt += f"""

---

## ⚠️ CRITICAL: PREVIOUS ITERATION FAILED - SELF-CORRECTION REQUIRED

The previous QA session failed with the following error:

**Error**: {previous_error.get("error_message", "Unknown error")}
**Consecutive Failures**: {previous_error.get("consecutive_errors", 1)}

### What Went Wrong

You did NOT update the `implementation_plan.json` file with the required `qa_signoff` object.

### Required Action

After completing your QA review, you MUST:

1. **Read the current implementation_plan.json**:
   ```bash
   cat {spec_dir}/implementation_plan.json
   ```

2. **Update it with your qa_signoff** by editing the JSON file to add/update the `qa_signoff` field:

   If APPROVED:
   ```json
   {{
     "qa_signoff": {{
       "status": "approved",
       "timestamp": "[current ISO timestamp]",
       "qa_session": {qa_session},
       "report_file": "qa_report.md",
       "tests_passed": {{"unit": "X/Y", "integration": "X/Y", "e2e": "X/Y"}},
       "verified_by": "qa_agent"
     }}
   }}
   ```

   If REJECTED:
   ```json
   {{
     "qa_signoff": {{
       "status": "rejected",
       "timestamp": "[current ISO timestamp]",
       "qa_session": {qa_session},
       "issues_found": [
         {{"type": "critical", "title": "[issue]", "location": "[file:line]", "fix_required": "[description]"}}
       ],
       "fix_request_file": "QA_FIX_REQUEST.md"
     }}
   }}
   ```

3. **Use the Edit tool or Write tool** to update the file. The file path is:
   `{spec_dir}/implementation_plan.json`

### FAILURE TO DO THIS WILL CAUSE ANOTHER ERROR

This is attempt {previous_error.get("consecutive_errors", 1) + 1}. If you fail to update implementation_plan.json again, the QA process will be escalated to human review.

---

"""
        print(
            f"\n⚠️  Retry with self-correction context (attempt {previous_error.get('consecutive_errors', 1) + 1})"
        )

    # ── Provider-agnostic path (OpenAI, Windsurf, Copilot, Google, etc.) ──
    if isinstance(client, AgentClient):
        return await _run_qa_agent_client_session(
            client,
            project_dir,
            spec_dir,
            qa_session,
            prompt,
            task_logger,
            verbose,
            message_count,
            tool_count,
            _rr,
            _rs_id,
        )

    # ── Claude SDK path (backward compatible) ──
    try:
        debug("qa_reviewer", "Sending query to Claude SDK...")
        await client.query(prompt)
        debug_success("qa_reviewer", "Query sent successfully")

        response_text = ""
        result_error: str | None = None
        debug("qa_reviewer", "Starting to receive response stream...")
        async for msg in client.receive_response():
            msg_type = type(msg).__name__
            message_count += 1
            debug_detailed(
                "qa_reviewer",
                f"Received message #{message_count}",
                msg_type=msg_type,
            )

            # Capture ResultMessage errors (e.g. rate limit, auth failure, crash)
            if ResultMessage is not None and isinstance(msg, ResultMessage):
                if msg.is_error:
                    result_error = msg.result or f"SDK error (subtype={msg.subtype})"
                    debug_error(
                        "qa_reviewer",
                        f"ResultMessage error: {result_error}",
                        num_turns=msg.num_turns,
                        duration_ms=msg.duration_ms,
                    )
                    print(f"\n❌ Claude session error: {result_error}")
                else:
                    debug(
                        "qa_reviewer",
                        "ResultMessage received (session complete)",
                        num_turns=msg.num_turns,
                        cost_usd=msg.total_cost_usd,
                        duration_ms=msg.duration_ms,
                    )
                continue

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
                                LogPhase.VALIDATION,
                                print_to_console=False,
                            )
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

                        # Extract tool input for display (full command/path)
                        if inp:
                            if "file_path" in inp:
                                fp = str(inp["file_path"])
                                if len(fp) > 2000:
                                    fp = "..." + fp[-1997:]
                                tool_input_display = fp
                            elif "pattern" in inp:
                                tool_input_display = f"pattern: {inp['pattern']}"

                        debug(
                            "qa_reviewer",
                            f"Tool call #{tool_count}: {tool_name}",
                            tool_input=tool_input_display,
                        )

                        # Log tool start (handles printing)
                        if task_logger:
                            task_logger.tool_start(
                                tool_name,
                                tool_input_display,
                                LogPhase.VALIDATION,
                                print_to_console=True,
                            )
                        else:
                            print(f"\n[QA Tool: {tool_name}]", flush=True)

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

            elif msg_type == "UserMessage" and hasattr(msg, "content"):
                for block in msg.content:
                    block_type = type(block).__name__

                    if block_type == "ToolResultBlock":
                        is_error = getattr(block, "is_error", False)
                        result_content = getattr(block, "content", "")

                        if is_error:
                            debug_error(
                                "qa_reviewer",
                                f"Tool error: {current_tool}",
                                error=str(result_content)[:200],
                            )
                            error_str = str(result_content)[:500]
                            print(f"   [Error] {error_str}", flush=True)
                            if task_logger and current_tool:
                                # Store full error in detail for expandable view
                                task_logger.tool_end(
                                    current_tool,
                                    success=False,
                                    result=error_str[:100],
                                    detail=str(result_content),
                                    phase=LogPhase.VALIDATION,
                                )
                        else:
                            debug_detailed(
                                "qa_reviewer",
                                f"Tool success: {current_tool}",
                                result_length=len(str(result_content)),
                            )
                            if verbose:
                                result_str = str(result_content)[:200]
                                print(f"   [Done] {result_str}", flush=True)
                            else:
                                print("   [Done]", flush=True)
                            if task_logger and current_tool:
                                # Store full result in detail for expandable view
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
                                    phase=LogPhase.VALIDATION,
                                )

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

        # Shared post-processing: check QA result, save memory, extract verdict
        _qa_result = await _process_qa_result(
            spec_dir,
            project_dir,
            qa_session,
            response_text,
            message_count,
            tool_count,
            result_error=result_error,
        )

        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return _qa_result

    except Exception as e:
        debug_error(
            "qa_reviewer",
            f"QA session exception: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during QA session: {e}")
        if task_logger:
            task_logger.log_error(f"QA session error: {e}", LogPhase.VALIDATION)
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "error", str(e)


# =============================================================================
# PROVIDER-AGNOSTIC QA REVIEWER SESSION (AgentClient path)
# =============================================================================


async def _run_qa_agent_client_session(
    client: AgentClient,
    project_dir: Path,
    spec_dir: Path,
    qa_session: int,
    prompt: str,
    task_logger: Any,
    verbose: bool,
    message_count: int,
    tool_count: int,
    _rr: Any,
    _rs_id: Any,
) -> tuple[str, str]:
    """
    Provider-agnostic QA reviewer session using normalized AgentMessage stream.

    This is the equivalent of the Claude SDK path in run_qa_agent_session()
    but processes ContentBlockType-based blocks from any AgentClient provider
    (OpenAI, Windsurf, Copilot, Google, Mistral, etc.).
    """
    provider = client.provider_name()
    debug_section("qa_reviewer", f"QA Reviewer Session [{provider}]")
    debug(
        "qa_reviewer",
        f"Starting {provider} QA reviewer session",
        spec_dir=str(spec_dir),
        qa_session=qa_session,
    )
    print(f"Sending QA prompt to {provider} agent...\n")

    current_tool = None

    try:
        debug("qa_reviewer", f"Sending query to {provider}...")
        await client.query(prompt)
        debug_success("qa_reviewer", "Query sent successfully")

        response_text = ""
        debug("qa_reviewer", "Starting to receive response stream...")

        async for agent_msg in client.receive_response():
            message_count += 1
            debug_detailed(
                "qa_reviewer",
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
                            LogPhase.VALIDATION,
                            print_to_console=False,
                        )
                    # Record agent response in replay
                    if _rr and _rs_id and block.text.strip():
                        try:
                            _rr.record_response(_rs_id, block.text)
                        except Exception:
                            pass

                elif block.type == ContentBlockType.TOOL_USE:
                    tool_name = block.tool_name or ""
                    tool_count += 1
                    tool_input_display = None
                    inp = block.tool_input or {}

                    if inp:
                        if "file_path" in inp:
                            fp = str(inp["file_path"])
                            if len(fp) > 2000:
                                fp = "..." + fp[-1997:]
                            tool_input_display = fp
                        elif "pattern" in inp:
                            tool_input_display = f"pattern: {inp['pattern']}"
                        elif "command" in inp:
                            cmd = str(inp["command"])
                            if len(cmd) > 2000:
                                cmd = cmd[:1997] + "..."
                            tool_input_display = cmd

                    debug(
                        "qa_reviewer",
                        f"Tool call #{tool_count}: {tool_name}",
                        tool_input=tool_input_display,
                    )

                    if task_logger:
                        task_logger.tool_start(
                            tool_name,
                            tool_input_display,
                            LogPhase.VALIDATION,
                            print_to_console=True,
                        )
                    else:
                        print(f"\n[QA Tool: {tool_name}]", flush=True)

                    if verbose and inp:
                        input_str = str(inp)
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
                                    inp.get("new_string") or inp.get("content") or ""
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

                elif block.type == ContentBlockType.TOOL_RESULT:
                    is_error = block.is_error
                    result_content = block.result_content or ""

                    if is_error:
                        debug_error(
                            "qa_reviewer",
                            f"Tool error: {current_tool}",
                            error=str(result_content)[:200],
                        )
                        error_str = str(result_content)[:500]
                        print(f"   [Error] {error_str}", flush=True)
                        if task_logger and current_tool:
                            task_logger.tool_end(
                                current_tool,
                                success=False,
                                result=error_str[:100],
                                detail=str(result_content),
                                phase=LogPhase.VALIDATION,
                            )
                    else:
                        debug_detailed(
                            "qa_reviewer",
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
                                phase=LogPhase.VALIDATION,
                            )

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

        # Shared post-processing: check QA result, save memory, extract verdict
        _qa_result = await _process_qa_result(
            spec_dir,
            project_dir,
            qa_session,
            response_text,
            message_count,
            tool_count,
            result_error=None,
        )

        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return _qa_result

    except Exception as e:
        debug_error(
            "qa_reviewer",
            f"QA session exception [{provider}]: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during QA session: {e}")
        if task_logger:
            task_logger.log_error(f"QA session error: {e}", LogPhase.VALIDATION)
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "error", str(e)


# =============================================================================
# SHARED QA RESULT POST-PROCESSING
# =============================================================================


async def _process_qa_result(
    spec_dir: Path,
    project_dir: Path,
    qa_session: int,
    response_text: str,
    message_count: int,
    tool_count: int,
    result_error: str | None = None,
) -> tuple[str, str]:
    """
    Shared post-processing logic for QA reviewer sessions.

    Checks implementation_plan.json for QA signoff, saves memory insights,
    extracts verdicts from response text as fallback.

    Used by both the Claude SDK path and the AgentClient path.
    """
    status = get_qa_signoff_status(spec_dir)
    debug(
        "qa_reviewer",
        "QA session completed",
        message_count=message_count,
        tool_count=tool_count,
        response_length=len(response_text),
        qa_status=status.get("status") if status else "unknown",
    )
    qa_status_value = status.get("status") if status else "unknown"
    audit_event(
        project_dir,
        kind="agent_completed" if qa_status_value == "approved" else "agent_failed",
        actor="qa_reviewer",
        correlation_id=spec_dir.name,
        summary=f"QA reviewer session {qa_session} → {qa_status_value}",
        payload={
            "qa_session": qa_session,
            "verdict": qa_status_value,
            "result_error": (str(result_error)[:500] if result_error else ""),
        },
    )

    qa_discoveries = {
        "files_understood": {},
        "patterns_found": [],
        "gotchas_encountered": [],
    }

    if status and status.get("status") == "approved":
        debug_success("qa_reviewer", "QA APPROVED")
        if _ut_record_qa is not None:
            try:
                _ut_record_qa(project_dir, spec_dir.name, passed=True, score=100.0)
            except Exception:
                pass
        qa_discoveries["patterns_found"].append(
            f"QA session {qa_session}: All acceptance criteria validated successfully"
        )
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_reviewer_{qa_session}",
            session_num=qa_session,
            success=True,
            subtasks_completed=[f"qa_reviewer_{qa_session}"],
            discoveries=qa_discoveries,
        )
        return ("approved", response_text)

    if status and status.get("status") == "rejected":
        debug_error("qa_reviewer", "QA REJECTED")
        if _ut_record_qa is not None:
            try:
                _ut_record_qa(project_dir, spec_dir.name, passed=False, score=0.0)
            except Exception:
                pass
        issues = status.get("issues_found", [])
        for issue in issues:
            qa_discoveries["gotchas_encountered"].append(
                f"QA Issue ({issue.get('type', 'unknown')}): {issue.get('title', 'No title')} at {issue.get('location', 'unknown')}"
            )
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_reviewer_{qa_session}",
            session_num=qa_session,
            success=False,
            subtasks_completed=[],
            discoveries=qa_discoveries,
        )
        return ("rejected", response_text)

    if status and status.get("status") not in ("approved", "rejected"):
        non_standard = status.get("status", "unknown")
        debug_warning(
            "qa_reviewer",
            f"QA agent wrote non-standard status: {non_standard} — treating as human escalation",
        )
        print(f"\n⚠️  QA agent set non-standard status: {non_standard}")
        print("Treating as human escalation (manual verification required).")
        return ("human_escalation", response_text)

    # Agent didn't update the file — try to extract verdict from response
    extracted_verdict = _extract_verdict_from_response(response_text)

    if extracted_verdict:
        debug(
            "qa_reviewer",
            f"Extracted verdict from response: {extracted_verdict}",
            message_count=message_count,
            tool_count=tool_count,
        )
        print(
            f"\n⚠️  Agent didn't update implementation_plan.json, "
            f"but verdict detected: {extracted_verdict.upper()}"
        )

        if _programmatic_qa_signoff(spec_dir, extracted_verdict, qa_session):
            debug_success(
                "qa_reviewer",
                f"Programmatically wrote qa_signoff: {extracted_verdict}",
            )
            print(
                f"✅ Programmatically updated implementation_plan.json "
                f"with status: {extracted_verdict}"
            )
            return (extracted_verdict, response_text)

        debug_error(
            "qa_reviewer",
            "Failed to programmatically write qa_signoff",
        )
        return ("error", "Failed to write qa_signoff")

    # Agent didn't update the status and no clear verdict in response
    debug_error(
        "qa_reviewer",
        "QA agent did not update implementation_plan.json",
        message_count=message_count,
        tool_count=tool_count,
        response_preview=response_text[:500] if response_text else "empty",
    )

    if result_error:
        return ("error", f"Agent session error: {result_error}")

    error_details = []
    if message_count == 0:
        error_details.append("No messages received from agent")
    if tool_count == 0:
        error_details.append("No tools were used by agent")
    if not response_text:
        error_details.append("Agent produced no output")

    error_msg = "QA agent did not update implementation_plan.json"
    if error_details:
        error_msg += f" ({'; '.join(error_details)})"

    return ("error", error_msg)
