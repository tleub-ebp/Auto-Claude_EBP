"""
QA Fixer Agent Session
=======================

Runs QA fixer sessions to resolve issues identified by the reviewer.

Memory Integration:
- Retrieves past patterns, fixes, and gotchas before fixing
- Saves fix outcomes and learnings after session
"""

from pathlib import Path
from typing import Any, Union

# Memory integration for cross-session learning
try:
    from agents.memory_manager import get_graphiti_context, save_session_memory
except ImportError:

    def get_graphiti_context(*args, **kwargs):
        return ""

    def save_session_memory(*args, **kwargs):
        # Stub function: memory_manager module not available
        # This is a fallback that does nothing when the memory integration is missing
        pass


try:
    from claude_agent_sdk import ClaudeSDKClient
except ImportError:
    ClaudeSDKClient = None  # type: ignore[assignment,misc]

try:
    from core.agent_client import AgentClient, ContentBlockType
except ImportError:
    AgentClient = None  # type: ignore[assignment,misc]
    ContentBlockType = None  # type: ignore[assignment,misc]

try:
    from debug import debug, debug_detailed, debug_error, debug_section, debug_success
except ImportError:

    def debug(*args, **kwargs):
        # Stub function: debug module not available
        # This is a fallback that does nothing when debug logging is missing
        pass

    def debug_detailed(*args, **kwargs):
        # Stub function: debug module not available
        # This is a fallback that does nothing when debug logging is missing
        pass

    def debug_error(*args, **kwargs):
        # Stub function: debug module not available
        # This is a fallback that does nothing when debug logging is missing
        pass

    def debug_section(*args, **kwargs):
        # Stub function: debug module not available
        # This is a fallback that does nothing when debug logging is missing
        pass

    def debug_success(*args, **kwargs):
        # Stub function: debug module not available
        # This is a fallback that does nothing when debug logging is missing
        pass


try:
    from security.tool_input_validator import get_safe_tool_input
except ImportError:

    def get_safe_tool_input(*args, **kwargs):
        return ""


try:
    from task_logger import (
        LogEntryType,
        LogPhase,
        get_task_logger,
    )
except ImportError:
    LogEntryType = None
    LogPhase = None

    def get_task_logger(*args, **kwargs):
        return None


try:
    from replay.recorder import get_replay_recorder as _get_replay_recorder

    _REPLAY_AVAILABLE = True
except ImportError:
    _REPLAY_AVAILABLE = False
    _get_replay_recorder = None  # type: ignore[assignment]

from agents.agent_audit import audit_event

from .criteria import get_qa_signoff_status

# Configuration
QA_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


# =============================================================================
# PROMPT LOADING
# =============================================================================


def load_qa_fixer_prompt() -> str:
    """Load the QA fixer agent prompt."""
    prompt_file = QA_PROMPTS_DIR / "qa_fixer.md"
    if not prompt_file.exists():
        raise FileNotFoundError(f"QA fixer prompt not found: {prompt_file}")
    return prompt_file.read_text(encoding="utf-8")


# =============================================================================
# QA FIXER SESSION
# =============================================================================


async def run_qa_fixer_session(
    client: Union["ClaudeSDKClient", "AgentClient", Any],
    spec_dir: Path,
    fix_session: int,
    verbose: bool = False,
    project_dir: Path | None = None,
) -> tuple[str, str]:
    """
    Run a QA fixer agent session.

    Accepts both raw ClaudeSDKClient instances (backward compatible) and
    wrapped AgentClient instances (provider-agnostic). If an AgentClient is
    passed, normalized AgentMessage stream is used; otherwise the raw SDK
    message stream is consumed directly.

    Args:
        client: Claude SDK client or AgentClient instance
        spec_dir: Spec directory
        fix_session: Fix iteration number
        verbose: Whether to show detailed output
        project_dir: Project root directory (for memory context)

    Returns:
        (status, response_text) where status is:
        - "fixed" if fixes were applied
        - "error" if an error occurred
    """
    # Derive project_dir from spec_dir if not provided
    # spec_dir is typically: /project/.workpilot/specs/001-name/
    if project_dir is None:
        # Walk up from spec_dir to find project root
        project_dir = spec_dir.parent.parent.parent
    debug_section("qa_fixer", f"QA Fixer Session {fix_session}")
    debug(
        "qa_fixer",
        "Starting QA fixer session",
        spec_dir=str(spec_dir),
        fix_session=fix_session,
    )
    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="qa_fixer",
        correlation_id=spec_dir.name,
        summary=f"QA fixer session {fix_session} invoked",
        payload={"fix_session": fix_session},
    )

    print(f"\n{'=' * 70}")
    print(f"  QA FIXER SESSION {fix_session}")
    print("  Applying fixes from QA_FIX_REQUEST.md...")
    print(f"{'=' * 70}\n")

    # Get task logger for streaming markers
    task_logger = get_task_logger(spec_dir)
    current_tool = None
    message_count = 0
    tool_count = 0

    # Initialize replay recorder for this QA fix session (non-blocking, best-effort)
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
                    "agent_name": "QA Fixer",
                    "agent_type": "qa_fixer",
                    "task": spec_dir.name,
                    "project_path": str(project_dir),
                    "model": getattr(getattr(client, "options", None), "model", "")
                    or "",
                },
            )
        except Exception:
            _rr = None
            _rs_id = None

    # Check that fix request file exists
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if not fix_request_file.exists():
        debug_error("qa_fixer", "QA_FIX_REQUEST.md not found")
        return "error", "QA_FIX_REQUEST.md not found"

    # Load fixer prompt
    prompt = load_qa_fixer_prompt()
    debug_detailed("qa_fixer", "Loaded QA fixer prompt", prompt_length=len(prompt))

    # Retrieve memory context for fixer (past fixes, patterns, gotchas)
    fixer_memory_context = await get_graphiti_context(
        spec_dir,
        project_dir,
        {
            "description": "Fixing QA issues and implementing corrections",
            "id": f"qa_fixer_{fix_session}",
        },
    )
    if fixer_memory_context:
        prompt += "\n\n" + fixer_memory_context
        print("✓ Memory context loaded for QA fixer")
        debug_success("qa_fixer", "Graphiti memory context loaded for fixer")

    # Add session context - use full path so agent can find files
    prompt += f"\n\n---\n\n**Fix Session**: {fix_session}\n"
    prompt += f"**Spec Directory**: {spec_dir}\n"
    prompt += f"**Spec Name**: {spec_dir.name}\n"
    prompt += f"\n**IMPORTANT**: All spec files are located in: `{spec_dir}/`\n"
    prompt += f"The fix request file is at: `{spec_dir}/QA_FIX_REQUEST.md`\n"

    # ── Provider-agnostic path (OpenAI, Windsurf, Copilot, Google, etc.) ──
    if AgentClient is not None and isinstance(client, AgentClient):
        return await _run_qa_fixer_agent_client_session(
            client,
            spec_dir,
            fix_session,
            prompt,
            project_dir,
            task_logger,
            verbose,
            message_count,
            tool_count,
            _rr,
            _rs_id,
        )

    # ── Claude SDK path (backward compatible) ──
    try:
        debug("qa_fixer", "Sending query to Claude SDK...")
        await client.query(prompt)
        debug_success("qa_fixer", "Query sent successfully")

        response_text = ""
        debug("qa_fixer", "Starting to receive response stream...")
        async for msg in client.receive_response():
            msg_type = type(msg).__name__
            message_count += 1
            debug_detailed(
                "qa_fixer",
                f"Received message #{message_count}",
                msg_type=msg_type,
            )

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

                        if inp:
                            if "file_path" in inp:
                                fp = str(inp["file_path"])
                                if len(fp) > 2000:
                                    fp = "..." + fp[-1997:]
                                tool_input_display = fp
                            elif "command" in inp:
                                cmd = str(inp["command"])
                                if len(cmd) > 2000:
                                    cmd = cmd[:1997] + "..."
                                tool_input_display = cmd

                        debug(
                            "qa_fixer",
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
                            print(f"\n[Fixer Tool: {tool_name}]", flush=True)

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
                                "qa_fixer",
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
                                "qa_fixer",
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

        # Shared post-processing: check fix status, save memory
        _fix_result = await _process_fixer_result(
            spec_dir,
            project_dir,
            fix_session,
            response_text,
            message_count,
            tool_count,
        )

        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return _fix_result

    except Exception as e:
        debug_error(
            "qa_fixer",
            f"Fixer session exception: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during fixer session: {e}")
        if task_logger:
            task_logger.log_error(f"QA fixer error: {e}", LogPhase.VALIDATION)
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "error", str(e)


# =============================================================================
# PROVIDER-AGNOSTIC QA FIXER SESSION (AgentClient path)
# =============================================================================


async def _run_qa_fixer_agent_client_session(
    client: "AgentClient",
    spec_dir: Path,
    fix_session: int,
    prompt: str,
    project_dir: Path | None,
    task_logger: Any,
    verbose: bool,
    message_count: int,
    tool_count: int,
    _rr: Any,
    _rs_id: Any,
) -> tuple[str, str]:
    """
    Provider-agnostic QA fixer session using normalized AgentMessage stream.

    This is the equivalent of the Claude SDK path in run_qa_fixer_session()
    but processes ContentBlockType-based blocks from any AgentClient provider
    (OpenAI, Windsurf, Copilot, Google, Mistral, etc.).
    """
    provider = client.provider_name()
    debug_section("qa_fixer", f"QA Fixer Session [{provider}]")
    debug(
        "qa_fixer",
        f"Starting {provider} QA fixer session",
        spec_dir=str(spec_dir),
        fix_session=fix_session,
    )
    print(f"Sending QA fixer prompt to {provider} agent...\n")

    current_tool = None

    try:
        debug("qa_fixer", f"Sending query to {provider}...")
        await client.query(prompt)
        debug_success("qa_fixer", "Query sent successfully")

        response_text = ""
        debug("qa_fixer", "Starting to receive response stream...")

        async for agent_msg in client.receive_response():
            message_count += 1
            debug_detailed(
                "qa_fixer",
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
                        elif "command" in inp:
                            cmd = str(inp["command"])
                            if len(cmd) > 2000:
                                cmd = cmd[:1997] + "..."
                            tool_input_display = cmd
                        elif "pattern" in inp:
                            tool_input_display = f"pattern: {inp['pattern']}"

                    debug(
                        "qa_fixer",
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
                        print(f"\n[Fixer Tool: {tool_name}]", flush=True)

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
                            "qa_fixer",
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
                            "qa_fixer",
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

        # Shared post-processing: check fix status, save memory
        _fix_result = await _process_fixer_result(
            spec_dir,
            project_dir,
            fix_session,
            response_text,
            message_count,
            tool_count,
        )

        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return _fix_result

    except Exception as e:
        debug_error(
            "qa_fixer",
            f"QA fixer session exception [{provider}]: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during fixer session: {e}")
        if task_logger:
            task_logger.log_error(f"QA fixer error: {e}", LogPhase.VALIDATION)
        if _rr and _rs_id:
            try:
                _rr.end_session(_rs_id)
            except Exception:
                pass
        return "error", str(e)


# =============================================================================
# SHARED FIXER RESULT POST-PROCESSING
# =============================================================================


async def _process_fixer_result(
    spec_dir: Path,
    project_dir: Path | None,
    fix_session: int,
    response_text: str,
    message_count: int,
    tool_count: int,
) -> tuple[str, str]:
    """
    Shared post-processing logic for QA fixer sessions.

    Checks implementation_plan.json for fix status, saves memory insights.
    Used by both the Claude SDK path and the AgentClient path.
    """
    status = get_qa_signoff_status(spec_dir)
    ready = bool(status and status.get("ready_for_qa_revalidation"))
    debug(
        "qa_fixer",
        "Fixer session completed",
        message_count=message_count,
        tool_count=tool_count,
        response_length=len(response_text),
        ready_for_revalidation=ready,
    )
    if project_dir is not None:
        audit_event(
            project_dir,
            kind="agent_completed",
            actor="qa_fixer",
            correlation_id=spec_dir.name,
            summary=f"QA fixer session {fix_session} completed (ready_for_revalidation={ready})",
            payload={
                "fix_session": fix_session,
                "ready_for_revalidation": ready,
            },
        )

    fixer_discoveries = {
        "files_understood": {},
        "patterns_found": [
            f"QA fixer session {fix_session}: Applied fixes from QA_FIX_REQUEST.md"
        ],
        "gotchas_encountered": [],
    }

    if status and status.get("ready_for_qa_revalidation"):
        debug_success("qa_fixer", "Fixes applied, ready for QA revalidation")
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_fixer_{fix_session}",
            session_num=fix_session,
            success=True,
            subtasks_completed=[f"qa_fixer_{fix_session}"],
            discoveries=fixer_discoveries,
        )
    else:
        debug_success("qa_fixer", "Fixes assumed applied (status not updated)")
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_fixer_{fix_session}",
            session_num=fix_session,
            success=True,
            subtasks_completed=[f"qa_fixer_{fix_session}"],
            discoveries=fixer_discoveries,
        )

    return "fixed", response_text
