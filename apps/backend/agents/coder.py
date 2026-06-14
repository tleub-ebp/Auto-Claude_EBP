"""
Coder Agent Module
==================

Main autonomous agent loop that runs the coder agent to implement subtasks.
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

from agents.agent_audit import audit_decision, audit_event
from agents.feature_wiring import (
    apply_router_override,
    cognitive_context_enabled,
    load_domain_addendum,
    suggest_routed_model,
)
from core.client import create_agent_client
from core.llm_optimization import should_inline_file_context
from core.task_event import TaskEventEmitter
from core.workflow_logger import workflow_logger
from qa.criteria import save_implementation_plan

try:
    from core.usage_tracker import (
        finish_build as _ut_finish_build,
    )
    from core.usage_tracker import (
        record_task_status as _ut_record_task,
    )
    from core.usage_tracker import (
        start_build as _ut_start_build,
    )
except ImportError:
    _ut_start_build = _ut_finish_build = _ut_record_task = None  # type: ignore[assignment]
from linear_updater import (
    LinearTaskState,
    is_linear_enabled,
    linear_build_complete,
    linear_task_started,
    linear_task_stuck,
)
from phase_config import (
    get_phase_model,
    get_phase_provider,
    get_phase_thinking_budget,
    load_task_metadata,
)
from phase_event import ExecutionPhase, emit_phase
from progress import (
    count_subtasks,
    count_subtasks_detailed,
    get_current_phase,
    get_next_subtask,
    is_build_complete,
    print_build_complete_banner,
    print_progress_summary,
    print_session_header,
)
from prompt_generator import (
    format_context_for_prompt,
    generate_planner_prompt,
    generate_subtask_prompt,
    load_subtask_context,
)
from prompts import is_first_run
from recovery import RecoveryManager
from security.constants import PROJECT_DIR_ENV_VAR
from task_logger import (
    LogEntryType,
    LogPhase,
    get_task_logger,
)
from ui import (
    BuildState,
    Icons,
    StatusManager,
    bold,
    box,
    highlight,
    icon,
    muted,
    print_key_value,
    print_status,
)

from .base import (
    AUTH_FAILURE_PAUSE_FILE,
    AUTH_RESUME_CHECK_INTERVAL_SECONDS,
    AUTH_RESUME_MAX_WAIT_SECONDS,
    AUTO_CONTINUE_DELAY_SECONDS,
    HUMAN_INTERVENTION_FILE,
    INITIAL_RETRY_DELAY_SECONDS,
    MAX_CONCURRENCY_RETRIES,
    MAX_RATE_LIMIT_WAIT_SECONDS,
    MAX_RETRY_DELAY_SECONDS,
    MAX_SUBTASK_RETRIES,
    RATE_LIMIT_CHECK_INTERVAL_SECONDS,
    RATE_LIMIT_PAUSE_FILE,
    RESUME_FILE,
    sanitize_error_message,
)
from .memory_manager import debug_memory_system_status, get_graphiti_context
from .session import (
    is_prompt_too_long_error,
    post_session_processing,
    run_agent_session,
)
from .utils import (
    find_phase_for_subtask,
    find_subtask_in_plan,
    get_commit_count,
    get_latest_commit,
    load_implementation_plan,
    sync_spec_to_source,
)

# Import streaming support
try:
    from streaming.agent_wrapper import create_streaming_wrapper

    STREAMING_AVAILABLE = True
except ImportError:
    STREAMING_AVAILABLE = False
    create_streaming_wrapper = None

logger = logging.getLogger(__name__)

# Agent name constant for logging
AGENT_NAME = "Claude Code"


# =============================================================================
# FILE VALIDATION UTILITIES
# =============================================================================


def _find_git_root(start: Path) -> Path | None:
    """Walk up from `start` looking for a directory containing `.git`. Return it, or None."""
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _suggest_project_dir_fix(project_dir: Path, invalid_paths: list[str]) -> str:
    """
    Build an actionable suggestion when paths escape project_dir.

    The common cause is that project_dir points to a sub-folder of the actual project
    root. If a Git root exists above project_dir AND the escaping paths resolve inside
    that Git root, recommend reconfiguring the project to point at the Git root.
    """
    resolved_project = Path(project_dir).resolve()
    git_root = _find_git_root(resolved_project)

    if git_root and git_root != resolved_project:
        all_resolve_inside_git_root = all(
            (resolved_project / p).resolve().is_relative_to(git_root)
            for p in invalid_paths
        )
        if all_resolve_inside_git_root:
            return (
                f"Project misconfiguration likely: project_dir is set to a sub-folder "
                f"({resolved_project}). All offending paths resolve inside the Git root "
                f"at {git_root}. Reconfigure the project in WorkPilot to point at "
                f"{git_root} instead, then re-plan. As an interim fix, you may also "
                f"rewrite the paths to be relative to project_dir (without `../`)."
            )

    return (
        "Update implementation plan to use paths within the project directory "
        "(no `../` segments, no absolute paths)."
    )


def validate_subtask_files(subtask: dict, project_dir: Path) -> dict:
    """
    Validate all files_to_modify exist before subtask execution.

    Args:
        subtask: Subtask dictionary containing files_to_modify array
        project_dir: Root directory of the project

    Returns:
        dict with:
        - success (bool): True if all files exist
        - error (str): Error message if validation fails
        - missing_files (list): List of missing file paths
        - invalid_paths (list): List of paths that resolve outside the project
        - suggestion (str): Actionable suggestion for resolution
    """
    missing_files = []
    invalid_paths = []

    resolved_project = Path(project_dir).resolve()
    for file_path in subtask.get("files_to_modify", []):
        full_path = (resolved_project / file_path).resolve()
        if not full_path.is_relative_to(resolved_project):
            invalid_paths.append(file_path)
            continue
        if not full_path.exists():
            missing_files.append(file_path)

    if invalid_paths:
        return {
            "success": False,
            "error": f"Paths resolve outside project boundary: {', '.join(invalid_paths)}",
            "missing_files": missing_files,
            "invalid_paths": invalid_paths,
            "suggestion": _suggest_project_dir_fix(project_dir, invalid_paths),
        }

    if missing_files:
        return {
            "success": False,
            "error": f"Planned files do not exist: {', '.join(missing_files)}",
            "missing_files": missing_files,
            "invalid_paths": [],
            "suggestion": "Update implementation plan with correct filenames or create missing files",
        }

    return {"success": True, "missing_files": [], "invalid_paths": []}


def _check_and_clear_resume_file(
    resume_file: Path,
    pause_file: Path,
    fallback_resume_file: Path | None = None,
) -> bool:
    """
    Check if resume file exists and clean up both resume and pause files.

    Also checks a fallback location (main project spec dir) in case the frontend
    couldn't find the worktree and only wrote the RESUME file there.

    Args:
        resume_file: Path to RESUME file
        pause_file: Path to pause file (RATE_LIMIT_PAUSE or AUTH_PAUSE)
        fallback_resume_file: Optional fallback RESUME file path (e.g. main project spec dir)

    Returns:
        True if resume file existed (early resume), False otherwise
    """
    found = resume_file.exists()

    # Check fallback location if primary not found
    if not found and fallback_resume_file and fallback_resume_file.exists():
        found = True
        try:
            fallback_resume_file.unlink(missing_ok=True)
        except OSError as e:
            logger.debug(f"Error cleaning up fallback resume file: {e}")

    if found:
        try:
            resume_file.unlink(missing_ok=True)
            pause_file.unlink(missing_ok=True)
        except OSError as e:
            logger.debug(
                f"Error cleaning up resume files: {e} (resume: {resume_file}, pause: {pause_file})"
            )
        return True
    return False


async def wait_for_rate_limit_reset(
    spec_dir: Path,
    wait_seconds: float,
    source_spec_dir: Path | None = None,
) -> bool:
    """
    Wait for rate limit reset with periodic checks for resume/cancel.

    Args:
        spec_dir: Spec directory to check for RESUME file
        wait_seconds: Maximum time to wait in seconds
        source_spec_dir: Optional main project spec dir as fallback for RESUME file

    Returns:
        True if resumed early, False if waited full duration
    """
    loop = asyncio.get_running_loop()
    start_time = loop.time()
    resume_file = spec_dir / RESUME_FILE
    pause_file = spec_dir / RATE_LIMIT_PAUSE_FILE
    fallback_resume = (source_spec_dir / RESUME_FILE) if source_spec_dir else None

    while True:
        # Check elapsed time using loop.time() to avoid drift
        elapsed = max(0, loop.time() - start_time)  # Ensure non-negative
        if elapsed >= wait_seconds:
            break

        # Check if user requested resume
        if _check_and_clear_resume_file(resume_file, pause_file, fallback_resume):
            return True

        # Wait for next check interval or remaining time
        sleep_time = min(RATE_LIMIT_CHECK_INTERVAL_SECONDS, wait_seconds - elapsed)
        await asyncio.sleep(sleep_time)

    # Clean up pause file after wait completes
    try:
        pause_file.unlink(missing_ok=True)
    except OSError as e:
        logger.debug(f"Error cleaning up pause file {pause_file}: {e}")

    return False


async def wait_for_auth_resume(
    spec_dir: Path,
    source_spec_dir: Path | None = None,
) -> None:
    """
    Wait for user re-authentication signal.

    Blocks until:
    - RESUME file is created (user completed re-auth in UI)
    - AUTH_PAUSE file is deleted (alternative resume signal)
    - Maximum wait timeout is reached (24 hours)

    Args:
        spec_dir: Spec directory to monitor for signal files
        source_spec_dir: Optional main project spec dir as fallback for RESUME file
    """
    loop = asyncio.get_running_loop()
    start_time = loop.time()
    resume_file = spec_dir / RESUME_FILE
    pause_file = spec_dir / AUTH_FAILURE_PAUSE_FILE
    fallback_resume = (source_spec_dir / RESUME_FILE) if source_spec_dir else None

    while True:
        # Check elapsed time using loop.time() to avoid drift
        elapsed = max(0, loop.time() - start_time)  # Ensure non-negative
        if elapsed >= AUTH_RESUME_MAX_WAIT_SECONDS:
            break

        # Check for resume signals
        if (
            _check_and_clear_resume_file(resume_file, pause_file, fallback_resume)
            or not pause_file.exists()
        ):
            # If pause file was deleted externally, still clean up resume file if it exists
            if not pause_file.exists():
                try:
                    resume_file.unlink(missing_ok=True)
                except OSError as e:
                    logger.debug(f"Error cleaning up resume file {resume_file}: {e}")
            return

        await asyncio.sleep(AUTH_RESUME_CHECK_INTERVAL_SECONDS)

    # Timeout reached - clean up and return
    print_status(
        "Authentication wait timeout reached (24 hours) - resuming with original credentials",
        "warning",
    )
    try:
        pause_file.unlink(missing_ok=True)
    except OSError as e:
        logger.debug(f"Error cleaning up pause file {pause_file} after timeout: {e}")


def _parse_relative_time(message: str) -> int | None:
    """Parse 'in X minutes/hours' pattern from message."""
    in_time_match = re.search(r"in\s+(\d+)\s*(minute|hour|min|hr)s?", message, re.I)
    if not in_time_match:
        return None

    amount = int(in_time_match.group(1))
    unit = in_time_match.group(2).lower()

    if unit.startswith("hour") or unit.startswith("hr"):
        delta = timedelta(hours=amount)
    else:
        delta = timedelta(minutes=amount)

    return int((datetime.now() + delta).timestamp())


def _validate_time_values(hour: int, minute: int) -> bool:
    """Validate hour and minute ranges."""
    return 0 <= hour <= 23 and 0 <= minute <= 59


def _convert_meridiem_to_24h(hour: int, meridiem: str) -> int:
    """Convert 12-hour format with meridiem to 24-hour format."""
    if meridiem.lower() == "pm" and hour < 12:
        return hour + 12
    elif meridiem.lower() == "am" and hour == 12:
        return 0
    return hour


def _validate_meridiem_hour(hour: int, meridiem: str) -> bool:
    """Validate hour range when meridiem is present (should be 1-12)."""
    return 1 <= hour <= 12


def _parse_absolute_time(message: str) -> int | None:
    """Parse absolute clock times from CLI messages.

    Handles both shapes the Claude CLI emits:
      - ``"resets at 10:30 pm"`` / ``"resets at 22:30"`` (legacy)
      - ``"resets 3:20pm (Europe/Paris)"`` / ``"resets 10am"`` (newer session-limit
        and weekly-limit banners — no ``at`` prefix, minute portion sometimes
        omitted)

    Missing the no-``at`` variant let the rate-limit shield fail to compute a
    reset timestamp, so the caller fell back to its retry loop and the
    conversation summary kept re-injecting until the prompt overflowed.
    """
    # Try minute-precision first (HH:MM with optional meridiem).
    at_time_match = re.search(
        r"(?:at|resets)\s+(\d{1,2}):(\d{2})\s*(am|pm)?", message, re.I
    )
    if not at_time_match:
        # Fall back to hour-only ("resets 10am" / "resets 3pm").
        hour_only = re.search(r"(?:at|resets)\s+(\d{1,2})\s*(am|pm)", message, re.I)
        if not hour_only:
            return None
        # Synthesise a zero-minute match so the rest of the function stays one branch.
        try:
            hour = int(hour_only.group(1))
        except ValueError:
            return None
        minute = 0
        meridiem = hour_only.group(2)
    else:
        try:
            hour = int(at_time_match.group(1))
            minute = int(at_time_match.group(2))
        except ValueError:
            return None
        meridiem = at_time_match.group(3)

    try:
        # Validate hour range when meridiem is present
        if meridiem and not _validate_meridiem_hour(hour, meridiem):
            return None

        if meridiem:
            hour = _convert_meridiem_to_24h(hour, meridiem)

        # Validate final hour and minute ranges
        if not _validate_time_values(hour, minute):
            return None

        now = datetime.now()
        reset_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if reset_time <= now:
            reset_time += timedelta(days=1)
        return int(reset_time.timestamp())
    except ValueError:
        return None


def parse_rate_limit_reset_time(error_info: dict | None) -> int | None:
    """
    Parse rate limit reset time from error info.

    Attempts to extract reset time from various formats in error messages.

    TIMEZONE ASSUMPTIONS:
    - "in X minutes/hours" patterns are timezone-safe (relative time)
    - "at HH:MM" patterns assume LOCAL timezone, which is reasonable since:
      1. The user sees timestamps in their local timezone
      2. The wait calculation happens locally using datetime.now()
      3. If the API returns UTC "at" times, this would need adjustment
        (but Claude API typically returns relative times like "in X minutes")

    Args:
        error_info: Error info dict with 'message' key

    Returns:
        Unix timestamp of reset time, or None if not parseable
    """
    if not error_info:
        return None

    message = error_info.get("message", "")

    # Try relative time pattern first
    reset_time = _parse_relative_time(message)
    if reset_time:
        return reset_time

    # Try absolute time pattern
    reset_time = _parse_absolute_time(message)
    if reset_time:
        return reset_time

    # No pattern matched
    return None


async def run_autonomous_agent(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    max_iterations: int | None = None,
    verbose: bool = False,
    source_spec_dir: Path | None = None,
    streaming_session_id: str | None = None,
) -> None:
    """
    Run the autonomous agent loop with automatic memory management.

    The agent can use subagents (via Task tool) for parallel execution if needed.
    This is decided by the agent itself based on the task complexity.

    Args:
        project_dir: Root directory for the project
        spec_dir: Directory containing the spec (.workpilot/specs/001-name/)
        model: Claude model to use
        max_iterations: Maximum number of iterations (None for unlimited)
        verbose: Whether to show detailed output
        source_spec_dir: Original spec directory in main project (for syncing from worktree)
        streaming_session_id: Optional streaming session ID for live coding
    """
    # Log agent start
    agent_trace_id = workflow_logger.log_agent_start(
        AGENT_NAME,
        "autonomous_agent_loop",
        {
            "project_dir": str(project_dir),
            "spec_dir": str(spec_dir),
            "model": model,
            "max_iterations": max_iterations,
            "streaming_session_id": streaming_session_id,
        },
    )
    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="coder",
        correlation_id=spec_dir.name,
        summary="coder autonomous loop invoked",
        payload={
            "model": model,
            "max_iterations": max_iterations,
            "spec_dir": str(spec_dir),
        },
    )

    # --- Feature wiring (opt-in) --------------------------------------------
    # ModelRouter:
    #   * Default mode (override flag OFF): suggest a cheaper model and log
    #     the divergence. The user's configured model is kept.
    #   * Override mode (WORKPILOT_MODEL_ROUTER_ENABLED=1) AND no explicit
    #     user choice: substitute `model` with the router's suggestion. We
    #     never overrule a CLI/UI/spec-file choice silently.
    try:
        new_model, override_info = apply_router_override(
            model,
            spec_dir=spec_dir,
            phase="coding",
            prompt_hint=f"coder run on spec {spec_dir.name}",
        )
        if override_info is not None:
            # Override took effect — record it as a decision and replace model.
            audit_decision(
                project_dir,
                actor="model_router",
                spec_dir=spec_dir,
                decision_id=f"router-override-{spec_dir.name}",
                title="Model substituted by router (no explicit user choice)",
                chosen=new_model,
                rejected=(model,),
                rationale=(
                    f"ModelRouter substituted {model} → {new_model} "
                    f"(~${override_info['estimated_cost_usd']:.4f}, "
                    f"{override_info['reason']}). "
                    f"Override active because no CLI/task_metadata model was set."
                ),
            )
            model = new_model  # noqa: PLW2901 — intentional reassignment
        else:
            # Override mode off OR user picked explicitly — log the suggestion
            # for cost analyses but keep the user's choice.
            suggestion = suggest_routed_model(
                prompt=f"coder run on spec {spec_dir.name}",
                task_hint="coding",
            )
            if suggestion and suggestion["model"] != model:
                audit_decision(
                    project_dir,
                    actor="model_router",
                    spec_dir=spec_dir,
                    decision_id=f"router-suggest-{spec_dir.name}",
                    title="Cheaper model available",
                    chosen=model,
                    rejected=(suggestion["model"],),
                    rationale=(
                        f"ModelRouter suggested {suggestion['model']} "
                        f"(~${suggestion['estimated_cost_usd']:.4f}, "
                        f"{suggestion['reason']}); user choice {model} kept."
                    ),
                )
    except Exception:
        # Wiring is best-effort. Never break the build.
        pass

    # Domain Agents: log when a domain addendum is available so downstream
    # tooling (and the audit trail) can show that a domain-specific
    # context was active for this run. Injecting the addendum into the
    # actual SDK system prompt is intentionally NOT done here — that
    # requires a coordinated change to the runtime/client layer and is
    # tracked separately. For now we surface the signal.
    try:
        domain_addendum = load_domain_addendum(spec_dir, role="coder")
        if domain_addendum:
            audit_event(
                project_dir,
                kind="system_event",
                actor="domain_agents",
                correlation_id=spec_dir.name,
                summary="domain addendum available for coder",
                payload={"addendum_chars": len(domain_addendum)},
            )
    except Exception:
        pass

    # Cognitive Context Optimizer flag — record whether opt-in was active
    # so reproducibility audits can correlate output quality vs context size.
    if cognitive_context_enabled():
        audit_event(
            project_dir,
            kind="system_event",
            actor="cognitive_context",
            correlation_id=spec_dir.name,
            summary="cognitive context optimizer flag enabled for this run",
        )
    # ------------------------------------------------------------------------

    # Start build tracking (best-effort)
    if _ut_start_build is not None:
        try:
            _ut_start_build(
                spec_dir=spec_dir,
                project_dir=project_dir,
                spec_id=spec_dir.name,
                spec_name=spec_dir.name,
                model=model,
                provider="anthropic",
            )
        except Exception:
            pass

    # Set environment variable for security hooks to find the correct project directory
    # This is needed because os.getcwd() may return the wrong directory in worktree mode
    os.environ[PROJECT_DIR_ENV_VAR] = str(project_dir.resolve())

    # Initialize streaming wrapper if session ID provided
    streaming_wrapper = None
    if STREAMING_AVAILABLE and streaming_session_id:
        try:
            streaming_wrapper = create_streaming_wrapper(
                streaming_session_id, enable_recording=True
            )
            await streaming_wrapper.start_session(
                {
                    "session_id": streaming_session_id,
                    "task": spec_dir.name,
                    "project_path": str(project_dir),
                    "agent_type": "coder",
                    "model": model,
                    "max_iterations": max_iterations,
                }
            )
            print_status(
                f"Streaming session started: {streaming_session_id}", "success"
            )
        except Exception as e:
            logger.warning(f"Failed to start streaming session: {e}")
            streaming_wrapper = None

    # Initialize recovery manager (handles memory persistence)
    recovery_manager = RecoveryManager(spec_dir, project_dir)

    # Initialize status manager for ccstatusline
    status_manager = StatusManager(project_dir)
    status_manager.set_active(spec_dir.name, BuildState.BUILDING)

    # Initialize task logger for persistent logging
    task_logger = get_task_logger(spec_dir)

    # Debug: Print memory system status at startup
    debug_memory_system_status()

    # Update initial subtask counts
    subtasks = count_subtasks_detailed(spec_dir)
    status_manager.update_subtasks(
        completed=subtasks["completed"],
        total=subtasks["total"],
        in_progress=subtasks["in_progress"],
    )

    # Check Linear integration status
    linear_task = None
    if is_linear_enabled():
        linear_task = LinearTaskState.load(spec_dir)
        if linear_task and linear_task.task_id:
            print_status("Linear integration: ENABLED", "success")
            print_key_value("Task", linear_task.task_id)
            print_key_value("Status", linear_task.status)
            print()
        else:
            print_status("Linear enabled but no task created for this spec", "warning")
            print()

    # Check if this is a fresh start or continuation
    first_run = is_first_run(spec_dir)

    # Track which phase we're in for logging
    current_log_phase = LogPhase.CODING
    is_planning_phase = False
    planning_retry_context: str | None = None
    planning_validation_failures = 0
    max_planning_validation_retries = 3

    def _validate_and_fix_implementation_plan() -> tuple[bool, list[str]]:
        from spec.validate_pkg import SpecValidator, auto_fix_plan

        spec_validator = SpecValidator(spec_dir)
        result = spec_validator.validate_implementation_plan()
        if result.valid:
            return True, []

        fixed = auto_fix_plan(spec_dir)
        if fixed:
            result = spec_validator.validate_implementation_plan()
            if result.valid:
                return True, []

        return False, result.errors

    if first_run:
        print_status(
            "Fresh start - will use Planner Agent to create implementation plan", "info"
        )
        content = [
            bold(f"{icon(Icons.GEAR)} PLANNER SESSION"),
            "",
            f"Spec: {highlight(spec_dir.name)}",
            muted("The agent will analyze your spec and create a subtask-based plan."),
        ]
        print()
        print(box(content, width=70, style="heavy"))
        print()

        # Update status for planning phase
        status_manager.update(state=BuildState.PLANNING)
        emit_phase(ExecutionPhase.PLANNING, "Creating implementation plan")
        is_planning_phase = True
        current_log_phase = LogPhase.PLANNING

        # Start planning phase in task logger
        if task_logger:
            task_logger.start_phase(
                LogPhase.PLANNING, "Starting implementation planning..."
            )

        # Update Linear to "In Progress" when build starts
        if linear_task and linear_task.task_id:
            print_status("Updating Linear task to In Progress...", "progress")
            await linear_task_started(spec_dir)
    else:
        print(f"Continuing build: {highlight(spec_dir.name)}")
        print_progress_summary(spec_dir)

        # Check if already complete
        if is_build_complete(spec_dir):
            print_build_complete_banner(spec_dir)
            status_manager.update(state=BuildState.COMPLETE)
            # Emit ALL_SUBTASKS_DONE so frontend XState transitions correctly
            # Without this, the process may exit without a terminal event,
            # causing handleProcessExited to incorrectly transition to error state
            try:
                completed, total = count_subtasks(spec_dir)
                task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)
                task_event_emitter.emit(
                    "ALL_SUBTASKS_DONE",
                    {"totalCount": total},
                )
            except Exception:
                logger.debug("Failed to emit ALL_SUBTASKS_DONE event", exc_info=True)
            return

        # Start/continue coding phase in task logger
        if task_logger:
            task_logger.start_phase(LogPhase.CODING, "Continuing implementation...")

        # Emit phase event when continuing build
        emit_phase(ExecutionPhase.CODING, "Continuing implementation")

    # Show human intervention hint
    content = [
        bold("INTERACTIVE CONTROLS"),
        "",
        f"Press {highlight('Ctrl+C')} once  {icon(Icons.ARROW_RIGHT)} Pause and optionally add instructions",
        f"Press {highlight('Ctrl+C')} twice {icon(Icons.ARROW_RIGHT)} Exit immediately",
    ]
    print(box(content, width=70, style="light"))
    print()

    # Main loop
    iteration = 0
    consecutive_concurrency_errors = 0  # Track consecutive 400 tool concurrency errors
    current_retry_delay = INITIAL_RETRY_DELAY_SECONDS  # Exponential backoff delay
    concurrency_error_context: str | None = (
        None  # Context to pass to agent after concurrency error
    )

    # Generic-error de-duplication: if the same error message recurs more than
    # MAX_REPEATED_GENERIC_ERRORS times back-to-back we bail out instead of
    # retrying forever. This is what prevented the session-limit / prompt-too-
    # long loop from filling the logs with duplicated "session limit · resets …"
    # banners while the conversation summary kept growing.
    MAX_REPEATED_GENERIC_ERRORS = 3
    last_generic_error_signature: str | None = None
    repeated_generic_error_count = 0

    def _reset_concurrency_state() -> None:
        """Reset concurrency error tracking state after a successful session or non-concurrency error."""
        nonlocal \
            consecutive_concurrency_errors, \
            current_retry_delay, \
            concurrency_error_context
        consecutive_concurrency_errors = 0
        current_retry_delay = INITIAL_RETRY_DELAY_SECONDS
        concurrency_error_context = None

    while True:
        iteration += 1

        # Anti-burnout loop detector (opt-in via WORKPILOT_LOOP_DETECTION_ENABLED).
        # If iteration N produces the same diff as a recent earlier iteration,
        # we're flip-flopping — pause the agent for human review instead of
        # burning more tokens.
        try:
            from agents.loop_detection import (
                get_detector,
                loop_detection_enabled,
            )

            if loop_detection_enabled() and iteration > 1:
                detector = get_detector(spec_dir)
                diff_hash = detector.hash_diff(project_dir)
                if detector.record_and_check(diff_hash):
                    audit_event(
                        project_dir,
                        kind="policy_violated",
                        actor="coder",
                        correlation_id=spec_dir.name,
                        summary=(
                            f"Circular fix detected at iteration {iteration} — "
                            "agent paused for human review"
                        ),
                        payload={
                            "iteration": iteration,
                            "diff_hash_prefix": diff_hash[:16],
                            "buffer": detector.buffer_snapshot(),
                        },
                    )
                    print_status(
                        "Circular fix detected — pausing for human intervention",
                        "warning",
                    )
                    pause_file = spec_dir / HUMAN_INTERVENTION_FILE
                    pause_file.write_text(
                        f"Loop detector triggered at iteration {iteration}.\n"
                        f"The coder produced the same diff it had a few "
                        f"iterations ago — likely a flip-flop between two "
                        f"fixes. Inspect the diff and decide whether to:\n"
                        f"  - delete this PAUSE file to resume,\n"
                        f"  - or restart with a different approach.\n",
                        encoding="utf-8",
                    )
                    status_manager.update(state=BuildState.PAUSED)
                    return
        except Exception as exc:
            logger.debug(f"Loop detection check skipped: {exc}")

        # Check for pause state in implementation plan
        from .utils import get_pause_state, is_paused

        plan = load_implementation_plan(spec_dir)
        if plan and is_paused(plan):
            pause_state = get_pause_state(plan)
            print()
            print_status("TASK PAUSED", "warning")
            print(muted(f"Paused at: {pause_state.get('paused_at')}"))
            if pause_state.get("paused_subtask_id"):
                print(muted(f"Paused subtask: {pause_state.get('paused_subtask_id')}"))
            if pause_state.get("provider"):
                print(
                    muted(
                        f"Provider: {pause_state.get('provider')} ({pause_state.get('model')})"
                    )
                )

            # Check if provider has changed since pause
            if pause_state.get("provider") and pause_state.get("provider") != model:
                model = pause_state.get("provider")
                print_status(f"Provider updated to {model}", "success")

            # Resume from paused subtask if specified
            if pause_state.get("paused_subtask_id"):
                print_status("Resuming from paused subtask", "success")

            return

        # Check for human intervention (PAUSE file)
        pause_file = spec_dir / HUMAN_INTERVENTION_FILE
        if pause_file.exists():
            print("\n" + "=" * 70)
            print("  PAUSED BY HUMAN")
            print("=" * 70)

            pause_content = pause_file.read_text(encoding="utf-8").strip()
            if pause_content:
                print(f"\nMessage: {pause_content}")

            print("\nTo resume, delete the PAUSE file:")
            print(f"  rm {pause_file}")
            print("\nThen run again:")
            print(f"  python workpilot/run.py --spec {spec_dir.name}")
            return

        # Check max iterations
        if max_iterations and iteration > max_iterations:
            print(f"\nReached max iterations ({max_iterations})")
            print("To continue, run the script again without --max-iterations")
            break

        # Get the next subtask to work on (planner sessions shouldn't bind to a subtask)
        next_subtask = None if first_run else get_next_subtask(spec_dir)
        subtask_id = next_subtask.get("id") if next_subtask else None
        phase_name = next_subtask.get("phase_name") if next_subtask else None

        # Update status for this session
        status_manager.update_session(iteration)
        if phase_name:
            current_phase = get_current_phase(spec_dir)
            if current_phase:
                status_manager.update_phase(
                    current_phase.get("name", ""),
                    current_phase.get("phase", 0),
                    current_phase.get("total", 0),
                )
        status_manager.update_subtasks(in_progress=1)

        # Print session header
        print_session_header(
            session_num=iteration,
            is_planner=first_run,
            subtask_id=subtask_id,
            subtask_desc=next_subtask.get("description") if next_subtask else None,
            phase_name=phase_name,
            attempt=recovery_manager.get_attempt_count(subtask_id) + 1
            if subtask_id
            else 1,
        )

        # Capture state before session for post-processing
        commit_before = get_latest_commit(project_dir)
        commit_count_before = get_commit_count(project_dir)

        # Get the phase-specific model and thinking level (respects task_metadata.json configuration)
        # first_run means we're in planning phase, otherwise coding phase
        current_phase = "planning" if first_run else "coding"
        phase_model = get_phase_model(spec_dir, current_phase, model)
        phase_thinking_budget = get_phase_thinking_budget(spec_dir, current_phase)
        agent_type = "planner" if first_run else "coder"

        # Honor a per-phase provider override (phaseProviders) when present so a
        # task can route, e.g., coding to Copilot and QA to Anthropic. When no
        # per-phase provider is configured we pass None and let
        # create_agent_client() resolve the provider as before (IPC marker,
        # env, task-wide metadata.provider), preserving existing behavior.
        _metadata = load_task_metadata(spec_dir)
        phase_provider = (
            get_phase_provider(spec_dir, phase=current_phase)
            if _metadata and _metadata.get("phaseProviders")
            else None
        )
        client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=phase_model,
            agent_type=agent_type,
            max_thinking_tokens=phase_thinking_budget,
            provider=phase_provider,
        )

        # Generate appropriate prompt
        if first_run:
            # Create client for planning phase
            prompt = generate_planner_prompt(spec_dir, project_dir)
            if planning_retry_context:
                prompt += "\n\n" + planning_retry_context

            # Retrieve Graphiti memory context for planning phase
            # This gives the planner knowledge of previous patterns, gotchas, and insights
            planner_context = await get_graphiti_context(
                spec_dir,
                project_dir,
                {
                    "description": "Planning implementation for new feature",
                    "id": "planner",
                },
            )
            if planner_context:
                prompt += "\n\n" + planner_context
                print_status("Graphiti memory context loaded for planner", "success")

            first_run = False
            current_log_phase = LogPhase.PLANNING

            # Set session info in logger
            if task_logger:
                task_logger.set_session(iteration)
        else:
            # Switch to coding phase after planning
            just_transitioned_from_planning = False
            if is_planning_phase:
                just_transitioned_from_planning = True
                is_planning_phase = False
                current_log_phase = LogPhase.CODING
                emit_phase(ExecutionPhase.CODING, "Starting implementation")
                if task_logger:
                    task_logger.end_phase(
                        LogPhase.PLANNING,
                        success=True,
                        message="Implementation plan created",
                    )
                    task_logger.start_phase(
                        LogPhase.CODING, "Starting implementation..."
                    )
                # In worktree mode, the UI prefers planning logs from the main spec dir.
                # Ensure the planning->coding transition is immediately reflected there.
                if sync_spec_to_source(spec_dir, source_spec_dir):
                    print_status("Phase transition synced to main project", "success")

            # PRE-CHECK: Look for any subtask with manual verification
            # These may be pending OR blocked (blocked by post-processing after 0 commits)
            if not next_subtask:
                plan = load_implementation_plan(spec_dir)
                if plan:
                    print(
                        muted(
                            f"[DEBUG] Scanning {len(plan.get('phases', []))} phases for manual tasks"
                        )
                    )
                    for phase in plan.get("phases", []):
                        print(
                            muted(
                                f"  Phase '{phase.get('name')}': {len(phase.get('subtasks', []))} subtasks"
                            )
                        )
                        for subtask in phase.get("subtasks", []):
                            status = subtask.get("status")
                            verification = subtask.get("verification", {})
                            print(
                                muted(
                                    f"    - {subtask.get('id')}: status={status}, verification={verification.get('type')}"
                                )
                            )
                            # Check for manual verification tasks in pending or blocked state
                            if (
                                status in ("pending", "blocked")
                                and verification.get("type") == "manual"
                            ):
                                # Found a manual verification task - treat it as next
                                next_subtask = {
                                    **subtask,
                                    "phase_id": phase.get("id"),
                                    "phase_name": phase.get("name"),
                                    "phase_num": phase.get("phase"),
                                }
                                subtask_id = next_subtask.get("id")
                                print_status(
                                    f"Found manual verification subtask: {subtask_id} (status={status})",
                                    "warning",
                                )
                                break
                        if next_subtask:
                            break
                else:
                    print(muted("[DEBUG] Could not load implementation plan"))

            if not next_subtask:
                # FIX for Issue #495: Race condition after planning phase
                # The implementation_plan.json may not be fully flushed to disk yet,
                # or there may be a brief delay before subtasks become available.
                # Retry with exponential backoff before giving up.
                if just_transitioned_from_planning:
                    print_status(
                        "Waiting for implementation plan to be ready...", "progress"
                    )
                    for retry_attempt in range(3):
                        delay = (retry_attempt + 1) * 2  # 2s, 4s, 6s
                        await asyncio.sleep(delay)
                        next_subtask = get_next_subtask(spec_dir)
                        if next_subtask:
                            # Update subtask_id and phase_name after successful retry
                            subtask_id = next_subtask.get("id")
                            phase_name = next_subtask.get("phase_name")
                            print_status(
                                f"Found subtask {subtask_id} after {delay}s delay",
                                "success",
                            )
                            break
                        print_status(
                            f"Retry {retry_attempt + 1}/3: No subtask found yet...",
                            "warning",
                        )

                if not next_subtask:
                    print("No pending subtasks found - build may be complete!")
                    break

            # Validate that all files_to_modify exist before attempting execution
            # This prevents infinite retry loops when implementation plan references non-existent files
            validation_result = validate_subtask_files(next_subtask, project_dir)
            if not validation_result["success"]:
                # File validation failed - record error and skip session
                error_msg = validation_result["error"]
                suggestion = validation_result.get("suggestion", "")

                print()
                print_status(f"File validation failed: {error_msg}", "error")
                if suggestion:
                    print(muted(f"Suggestion: {suggestion}"))
                print()

                # Record the validation failure in recovery manager
                recovery_manager.record_attempt(
                    subtask_id=subtask_id,
                    session=iteration,
                    success=False,
                    approach="File validation failed before execution",
                    error=error_msg,
                )

                # Log the validation failure
                if task_logger:
                    task_logger.log_error(
                        f"File validation failed: {error_msg}", LogPhase.CODING
                    )

                # Check if subtask has exceeded max retries
                attempt_count = recovery_manager.get_attempt_count(subtask_id)
                if attempt_count >= MAX_SUBTASK_RETRIES:
                    recovery_manager.mark_subtask_stuck(
                        subtask_id,
                        f"File validation failed after {attempt_count} attempts: {error_msg}",
                    )
                    print_status(
                        f"Subtask {subtask_id} marked as STUCK after {attempt_count} failed validation attempts",
                        "error",
                    )
                    print(
                        muted(
                            "Consider: update implementation plan with correct filenames"
                        )
                    )

                # Update status
                status_manager.update(state=BuildState.ERROR)

                # Small delay before retry
                await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)
                continue  # Skip to next iteration

            # PRE-CHECK: If this is a manual verification task, skip the coder session
            # and mark it as completed to remove from queue
            verification = next_subtask.get("verification", {})
            if verification.get("type") == "manual":
                print()
                print_status(
                    f"Subtask {subtask_id} requires manual verification",
                    "warning",
                )
                print(
                    muted(
                        "Skipping coder session - marking as completed for human review"
                    )
                )

                # Mark as completed (not blocked) so it's removed from queue
                # This prevents infinite waiting since no automated testing can run
                plan = load_implementation_plan(spec_dir)
                if plan:
                    subtask = find_subtask_in_plan(plan, subtask_id)
                    if subtask:
                        subtask["status"] = "completed"
                        # Add metadata that this requires manual review
                        subtask["_manual_review_required"] = True

                        try:
                            save_implementation_plan(spec_dir, plan)
                            print_status(
                                f"✓ Subtask {subtask_id} marked as COMPLETED (manual review needed)",
                                "warning",
                            )

                            # Log the decision
                            if task_logger:
                                task_logger.log(
                                    f"Subtask {subtask_id}: Manual verification task - marked completed for human review",
                                    LogEntryType.TEXT,
                                    LogPhase.CODING,
                                )
                        except Exception as e:
                            logger.error(f"Failed to mark as completed: {e}")
                            print(f"  ✗ Warning: Could not mark as completed: {e}")

                # Continue to next subtask without launching coder
                await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)
                continue

            # Get attempt count for recovery context
            attempt_count = recovery_manager.get_attempt_count(subtask_id)
            recovery_hints = (
                recovery_manager.get_recovery_hints(subtask_id)
                if attempt_count > 0
                else None
            )

            # Find the phase for this subtask
            plan = load_implementation_plan(spec_dir)
            phase = find_phase_for_subtask(plan, subtask_id) if plan else {}

            # Generate focused, minimal prompt for this subtask
            prompt = generate_subtask_prompt(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask=next_subtask,
                phase=phase or {},
                attempt_count=attempt_count,
                recovery_hints=recovery_hints,
            )

            # Load and append relevant file context — only when the
            # (provider, effort) pair benefits from inlining. Claude agents
            # and high-effort runs re-read files via tools anyway, so inline
            # content there is duplicated input paid on every turn.
            # Provider resolved WITHOUT side effects (get_phase_provider) —
            # _get_active_provider would consume the RESUME_WITH_PROVIDER
            # marker before create_agent_client gets to read it.
            inline_provider = phase_provider or get_phase_provider(
                spec_dir, phase=current_phase
            )
            if should_inline_file_context(inline_provider, phase_thinking_budget):
                context = load_subtask_context(spec_dir, project_dir, next_subtask)
                if context.get("patterns") or context.get("files_to_modify"):
                    prompt += "\n\n" + format_context_for_prompt(context)
            else:
                print(
                    muted(
                        "File context inlining skipped (agent reads files via "
                        "tools — saves duplicated prompt tokens)"
                    )
                )

            # Retrieve and append Graphiti memory context (if enabled)
            graphiti_context = await get_graphiti_context(
                spec_dir, project_dir, next_subtask
            )
            if graphiti_context:
                prompt += "\n\n" + graphiti_context
                print_status("Graphiti memory context loaded", "success")

            # Add concurrency error context if recovering from 400 error
            if concurrency_error_context:
                prompt += "\n\n" + concurrency_error_context
                print_status(
                    f"Added tool concurrency error context (retry {consecutive_concurrency_errors}/{MAX_CONCURRENCY_RETRIES})",
                    "warning",
                )

            # Show what we're working on
            print(f"Working on: {highlight(subtask_id)}")
            print(f"Description: {next_subtask.get('description', 'No description')}")
            if attempt_count > 0:
                print_status(f"Previous attempts: {attempt_count}", "warning")
            print()

            # Set session info in logger
            if task_logger and subtask_id:
                task_logger.set_subtask(subtask_id)
                task_logger.set_session(iteration)

        # Run session with Claude SDK client
        # Initialize status before async with block in case client context manager fails
        status = "error"
        response = None
        error_info = {
            "type": "client_error",
            "message": "Client session failed to start",
        }
        async with client:
            # Emit agent thinking event
            if streaming_wrapper:
                await streaming_wrapper.emit_agent_thinking(
                    f"Starting {agent_type} session {iteration} for subtask {subtask_id or 'planning'}"
                )

            status, response, error_info = await run_agent_session(
                client,
                prompt,
                spec_dir,
                verbose=verbose,
                phase=current_log_phase,
                streaming_wrapper=streaming_wrapper,
            )

            # Emit agent response event
            if streaming_wrapper and response:
                await streaming_wrapper.emit_agent_response(
                    response[:500]
                )  # Limit response length

            # AUTO-ANSWER: If the LLM asked "should I mark this as blocked?",
            # automatically send the answer to continue execution
            if (
                status == "continue"
                and response
                and "should I mark" in response.lower()
                and "blocked" in response.lower()
            ):
                print_status(
                    "Detected blocking question from agent - auto-answering to continue...",
                    "warning",
                )
                # The agent asked whether to block the manual testing subtask.
                # Automatically answer: Yes, mark it as blocked and continue.
                auto_answer = (
                    "Yes, please mark this subtask as 'blocked' and continue to the next subtask. "
                    "The manual testing requires a human tester with Visual Studio access."
                )

                # Send the auto-answer as a new session
                async with client:
                    await client.query(auto_answer)
                    response_text = ""
                    async for msg in client.receive_response():
                        if hasattr(msg, "content"):
                            for block in msg.content:
                                if hasattr(block, "text"):
                                    response_text += block.text
                    response = response_text
                # This will execute the blocking and continue automatically

        plan_validated = False
        if is_planning_phase and status != "error":
            valid, errors = _validate_and_fix_implementation_plan()
            if valid:
                plan_validated = True
                planning_retry_context = None
            else:
                planning_validation_failures += 1
                if planning_validation_failures >= max_planning_validation_retries:
                    print_status(
                        "implementation_plan.json validation failed too many times",
                        "error",
                    )
                    for err in errors:
                        print(f"  - {err}")
                    status_manager.update(state=BuildState.ERROR)
                    return

                print_status(
                    "implementation_plan.json invalid - retrying planner", "warning"
                )
                for err in errors:
                    print(f"  - {err}")

                planning_retry_context = (
                    "## IMPLEMENTATION PLAN VALIDATION ERRORS\n\n"
                    "The previous `implementation_plan.json` is INVALID.\n"
                    "You MUST rewrite it to match the required schema:\n"
                    "- Top-level: `feature`, `workflow_type`, `phases`\n"
                    "- Each phase: `id` (or `phase`) and `name`, and `subtasks`\n"
                    "- Each subtask: `id`, `description`, `status` (use `pending` for not started)\n\n"
                    "Validation errors:\n" + "\n".join(f"- {e}" for e in errors)
                )
                # Stay in planning mode for the next iteration
                first_run = True
                status = "continue"

        # === POST-SESSION PROCESSING (100% reliable) ===
        # Only run post-session processing for coding sessions.
        if subtask_id and current_log_phase == LogPhase.CODING:
            linear_is_enabled = (
                linear_task is not None and linear_task.task_id is not None
            )
            success = await post_session_processing(
                spec_dir=spec_dir,
                project_dir=project_dir,
                subtask_id=subtask_id,
                session_num=iteration,
                commit_before=commit_before,
                commit_count_before=commit_count_before,
                recovery_manager=recovery_manager,
                linear_enabled=linear_is_enabled,
                status_manager=status_manager,
                source_spec_dir=source_spec_dir,
            )

            # Check for stuck subtasks
            attempt_count = recovery_manager.get_attempt_count(subtask_id)
            if not success and attempt_count >= MAX_SUBTASK_RETRIES:
                recovery_manager.mark_subtask_stuck(
                    subtask_id, f"Failed after {attempt_count} attempts"
                )
                print()
                print_status(
                    f"Subtask {subtask_id} marked as STUCK after {attempt_count} attempts",
                    "error",
                )
                print(muted("Consider: manual intervention or skipping this subtask"))

                # Record stuck subtask in Linear (if enabled)
                if linear_is_enabled:
                    await linear_task_stuck(
                        spec_dir=spec_dir,
                        subtask_id=subtask_id,
                        attempt_count=attempt_count,
                    )
                    print_status("Linear notified of stuck subtask", "info")
        elif plan_validated and source_spec_dir:
            # After planning phase, sync the newly created implementation plan back to source
            if sync_spec_to_source(spec_dir, source_spec_dir):
                print_status("Implementation plan synced to main project", "success")

        # Handle session status
        if status == "complete":
            # Emit ALL_SUBTASKS_DONE so frontend XState transitions coding → qa_review.
            # Without this, the process may exit without a terminal event, causing
            # the kanban card to stay stuck in the "In Progress" column.
            try:
                completed, total = count_subtasks(spec_dir)
                task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)
                task_event_emitter.emit(
                    "ALL_SUBTASKS_DONE",
                    {"totalCount": total},
                )
            except Exception:
                logger.debug("Failed to emit ALL_SUBTASKS_DONE event", exc_info=True)

            print_build_complete_banner(spec_dir)
            status_manager.update(state=BuildState.COMPLETE)

            # Reset error tracking on success
            _reset_concurrency_state()

            if task_logger:
                task_logger.end_phase(
                    LogPhase.CODING,
                    success=True,
                    message="All subtasks completed successfully",
                )

            if linear_task and linear_task.task_id:
                await linear_build_complete(spec_dir)
                print_status("Linear notified: build complete, ready for QA", "success")

            # Learning Loop: extract patterns from this build
            try:
                from learning_loop.service import LearningLoopService

                learning_service = LearningLoopService(project_dir)
                report = await learning_service.run_post_build_analysis(spec_dir)
                if report.patterns_found:
                    print_status(
                        f"Learning loop: {len(report.patterns_found)} pattern(s) extracted",
                        "success",
                    )
            except Exception as e:
                logger.debug(f"Learning loop post-build analysis skipped: {e}")

            # Coder self-review handoff (opt-in via WORKPILOT_SELF_REVIEW_ENABLED).
            # Writes self_review.md at the spec root so the QA reviewer starts
            # with the coder's own risk notes instead of a blank slate. We pass
            # `client=None` here — the SDK-backed call would re-spawn the coder
            # for one extra turn which is a coordinated change to plumb properly,
            # so for now we just write the deterministic stub from the diff.
            try:
                from agents.self_review import (
                    run_self_review,
                    self_review_enabled,
                )

                if self_review_enabled():
                    written = await run_self_review(
                        client=None, spec_dir=spec_dir, project_dir=project_dir
                    )
                    if written is not None:
                        print_status(
                            f"Self-review handoff written to {written.name}",
                            "info",
                        )
            except Exception as e:
                logger.debug(f"Self-review skipped: {e}")

            break

        elif status == "continue":
            # Reset error tracking on successful session
            _reset_concurrency_state()

            print(
                muted(
                    f"\nAgent will auto-continue in {AUTO_CONTINUE_DELAY_SECONDS}s..."
                )
            )
            print_progress_summary(spec_dir)

            # Update state back to building
            status_manager.update(
                state=BuildState.PLANNING if is_planning_phase else BuildState.BUILDING
            )

            # Show next subtask info
            next_subtask = get_next_subtask(spec_dir)
            if next_subtask:
                subtask_id = next_subtask.get("id")
                print(
                    f"\nNext: {highlight(subtask_id)} - {next_subtask.get('description')}"
                )

                attempt_count = recovery_manager.get_attempt_count(subtask_id)
                if attempt_count > 0:
                    print_status(
                        f"WARNING: {attempt_count} previous attempt(s)", "warning"
                    )

            await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)

        elif status == "error":
            emit_phase(ExecutionPhase.FAILED, "Session encountered an error")

            # Check if this is a tool concurrency error (400)
            is_concurrency_error = (
                error_info and error_info.get("type") == "tool_concurrency"
            )

            if is_concurrency_error:
                consecutive_concurrency_errors += 1

                # Check if we've exceeded max retries (allow 5 retries with delays: 2s, 4s, 8s, 16s, 32s)
                if consecutive_concurrency_errors > MAX_CONCURRENCY_RETRIES:
                    print_status(
                        f"Tool concurrency limit hit {consecutive_concurrency_errors} times consecutively",
                        "error",
                    )
                    print()
                    print("=" * 70)
                    print("  CRITICAL: Agent stuck in retry loop")
                    print("=" * 70)
                    print()
                    print(
                        "The agent is repeatedly hitting Claude API's tool concurrency limit."
                    )
                    print(
                        "This usually means the agent is trying to use too many tools at once."
                    )
                    print()
                    print("Possible solutions:")
                    print("  1. The agent needs to reduce tool usage per request")
                    print("  2. Break down the current subtask into smaller steps")
                    print("  3. Manual intervention may be required")
                    print()
                    print(f"Error: {error_info.get('message', 'Unknown error')[:200]}")
                    print()

                    # Mark current subtask as stuck if we have one
                    if subtask_id:
                        recovery_manager.mark_subtask_stuck(
                            subtask_id,
                            f"Tool concurrency errors after {consecutive_concurrency_errors} retries",
                        )
                        print_status(f"Subtask {subtask_id} marked as STUCK", "error")

                    status_manager.update(state=BuildState.ERROR)
                    break  # Exit the loop

                # Exponential backoff: 2s, 4s, 8s, 16s, 32s
                print_status(
                    f"Tool concurrency error (retry {consecutive_concurrency_errors}/{MAX_CONCURRENCY_RETRIES})",
                    "warning",
                )
                print(
                    muted(
                        f"Waiting {current_retry_delay}s before retry (exponential backoff)..."
                    )
                )
                print()

                # Set context for next retry so agent knows to adjust behavior
                error_context_message = (
                    "## CRITICAL: TOOL CONCURRENCY ERROR\n\n"
                    f"Your previous session hit Claude API's tool concurrency limit (HTTP 400).\n"
                    f"This is retry {consecutive_concurrency_errors}/{MAX_CONCURRENCY_RETRIES}.\n\n"
                    "**IMPORTANT: You MUST adjust your approach:**\n"
                    "1. Use ONE tool at a time - do NOT call multiple tools in parallel\n"
                    "2. Wait for each tool result before calling the next tool\n"
                    "3. Avoid starting with `pwd` or multiple Read calls at once\n"
                    "4. If you need to read multiple files, read them one by one\n"
                    "5. Take a more incremental, step-by-step approach\n\n"
                    "Start by focusing on ONE specific action for this subtask."
                )

                # If we're in planning phase, reset first_run to True so next iteration
                # re-enters the planning branch (fix for issue #1565)
                if current_log_phase == LogPhase.PLANNING:
                    first_run = True
                    planning_retry_context = error_context_message
                    print_status(
                        "Planning session failed - will retry planning", "warning"
                    )
                else:
                    concurrency_error_context = error_context_message

                status_manager.update(state=BuildState.ERROR)
                await asyncio.sleep(current_retry_delay)

                # Double the retry delay for next time (cap at MAX_RETRY_DELAY_SECONDS)
                current_retry_delay = min(
                    current_retry_delay * 2, MAX_RETRY_DELAY_SECONDS
                )

            elif error_info and (
                error_info.get("type") == "prompt_too_long"
                or is_prompt_too_long_error(RuntimeError(error_info.get("message", "")))
            ):
                # Prompt too long for the LLM context window — retrying with
                # the same conversation will fail identically. Halt the loop
                # and surface the right remediation to the user.
                #
                # We accept BOTH the new explicit type tag and the legacy
                # string-match path so a partial deploy (only one side updated)
                # still breaks the loop instead of spinning on the error.
                _reset_concurrency_state()
                from services.rate_limit_shield import handle_prompt_too_long

                handle_prompt_too_long(
                    RuntimeError(error_info.get("message", "")),
                    spec_dir,
                    "coder",
                )
                print_status(
                    "Prompt too long — task halted (reset conversation or "
                    "switch provider)",
                    "error",
                )
                emit_phase(
                    ExecutionPhase.FAILED,
                    "Prompt too long for LLM context window",
                )
                status_manager.update(state=BuildState.ERROR)
                break

            elif error_info and error_info.get("type") == "rate_limit":
                # Rate limit error - intelligent wait for reset
                _reset_concurrency_state()

                reset_timestamp = parse_rate_limit_reset_time(error_info)
                if reset_timestamp:
                    wait_seconds = reset_timestamp - datetime.now().timestamp()

                    # Handle negative wait_seconds (reset time in the past)
                    if wait_seconds <= 0:
                        print_status(
                            "Rate limit reset time already passed - retrying immediately",
                            "warning",
                        )
                        status_manager.update(state=BuildState.BUILDING)
                        await asyncio.sleep(2)  # Brief delay before retry
                        continue

                    if wait_seconds > MAX_RATE_LIMIT_WAIT_SECONDS:
                        # Wait time too long - fail the task
                        print_status("Rate limit wait time too long", "error")
                        print(
                            f"Reset time would require waiting {wait_seconds / 3600:.1f} hours"
                        )
                        print(
                            f"Maximum wait is {MAX_RATE_LIMIT_WAIT_SECONDS / 3600:.1f} hours"
                        )
                        emit_phase(
                            ExecutionPhase.FAILED,
                            "Rate limit wait time exceeds maximum allowed",
                        )
                        status_manager.update(state=BuildState.ERROR)
                        break

                    # Emit pause phase with reset time for frontend
                    wait_minutes = wait_seconds / 60
                    emit_phase(
                        ExecutionPhase.RATE_LIMIT_PAUSED,
                        f"Rate limit - resuming in {wait_minutes:.0f} minutes",
                        reset_timestamp=reset_timestamp,
                    )

                    # Create pause file for frontend detection
                    # Sanitize error message to prevent exposing sensitive data
                    raw_error = error_info.get("message", "Rate limit reached")
                    sanitized_error = (
                        sanitize_error_message(raw_error, max_length=500)
                        or "Rate limit reached"
                    )
                    pause_data = {
                        "paused_at": datetime.now().isoformat(),
                        "reset_timestamp": reset_timestamp,
                        "error": sanitized_error,
                    }
                    pause_file = spec_dir / RATE_LIMIT_PAUSE_FILE
                    pause_file.write_text(json.dumps(pause_data), encoding="utf-8")

                    print_status(
                        f"Rate limited - waiting {wait_minutes:.0f} minutes for reset",
                        "warning",
                    )
                    status_manager.update(state=BuildState.PAUSED)

                    # Wait with periodic checks for resume signal
                    resumed_early = await wait_for_rate_limit_reset(
                        spec_dir, wait_seconds, source_spec_dir
                    )
                    if resumed_early:
                        print_status("Resumed early by user", "success")

                    # Resume execution
                    emit_phase(ExecutionPhase.CODING, "Resuming after rate limit")
                    status_manager.update(state=BuildState.BUILDING)
                    continue  # Resume the loop
                else:
                    # Couldn't parse reset time - fall back to standard retry
                    print_status("Rate limit hit (unknown reset time)", "warning")
                    print(muted("Will retry with a fresh session..."))
                    status_manager.update(state=BuildState.ERROR)
                    await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)
                    _reset_concurrency_state()
                    status_manager.update(state=BuildState.BUILDING)
                    continue

            elif error_info and error_info.get("type") == "authentication":
                # Authentication error - pause for user re-authentication
                _reset_concurrency_state()

                emit_phase(
                    ExecutionPhase.AUTH_FAILURE_PAUSED,
                    "Re-authentication required",
                )

                # Create pause file for frontend detection
                # Sanitize error message to prevent exposing sensitive data
                raw_error = error_info.get("message", "Authentication failed")
                sanitized_error = (
                    sanitize_error_message(raw_error, max_length=500)
                    or "Authentication failed"
                )
                pause_data = {
                    "paused_at": datetime.now().isoformat(),
                    "error": sanitized_error,
                    "requires_action": "re-authenticate",
                }
                pause_file = spec_dir / AUTH_FAILURE_PAUSE_FILE
                pause_file.write_text(json.dumps(pause_data), encoding="utf-8")

                print()
                print("=" * 70)
                print("  AUTHENTICATION REQUIRED")
                print("=" * 70)
                print()
                print("OAuth token is invalid or expired.")
                print("Please re-authenticate in the WorkPilot AI settings.")
                print()
                print("The task will automatically resume once you re-authenticate.")
                print()

                status_manager.update(state=BuildState.PAUSED)

                # Wait for user to complete re-authentication
                await wait_for_auth_resume(spec_dir, source_spec_dir)

                print_status("Authentication restored - resuming", "success")
                emit_phase(ExecutionPhase.CODING, "Resuming after re-authentication")
                status_manager.update(state=BuildState.BUILDING)
                continue  # Resume the loop

            else:
                # Other errors - use standard retry logic, but bail out if the
                # same error keeps recurring so we don't loop forever (and don't
                # pollute the logs with duplicate banners). This catches the
                # case where, for whatever reason, the rate-limit / prompt-too-
                # long detectors don't match a new CLI banner shape: instead of
                # retrying with the conversation-continuation summary (which
                # makes the prompt grow every iteration) we surface the failure.
                current_signature = (
                    (error_info or {}).get("message", "")
                    if error_info
                    else str(error_info)
                )
                # Normalise the signature so timestamps / reset-time tails don't
                # defeat the comparison ("resets 3:20pm" vs "resets 3:21pm").
                normalised_signature = re.sub(
                    r"\s+", " ", current_signature[:200]
                ).strip()

                if (
                    last_generic_error_signature is not None
                    and normalised_signature == last_generic_error_signature
                ):
                    repeated_generic_error_count += 1
                else:
                    last_generic_error_signature = normalised_signature
                    repeated_generic_error_count = 1

                if repeated_generic_error_count >= MAX_REPEATED_GENERIC_ERRORS:
                    print_status(
                        f"Same error repeated {repeated_generic_error_count} times — halting "
                        "instead of growing the conversation summary further.",
                        "error",
                    )
                    emit_phase(
                        ExecutionPhase.FAILED,
                        "Repeated error (retry would not change outcome)",
                    )
                    status_manager.update(state=BuildState.ERROR)
                    break

                print_status("Session encountered an error", "error")
                print(muted("Will retry with a fresh session..."))
                status_manager.update(state=BuildState.ERROR)
                await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)

                # Reset concurrency error tracking on non-concurrency errors
                _reset_concurrency_state()

        # Small delay between sessions
        if max_iterations is None or iteration < max_iterations:
            print("\nPreparing next session...\n")
            await asyncio.sleep(1)

    # Final summary
    content = [
        bold(f"{icon(Icons.SESSION)} SESSION SUMMARY"),
        "",
        f"Project: {project_dir}",
        f"Spec: {highlight(spec_dir.name)}",
        f"Sessions completed: {iteration}",
    ]
    print()
    print(box(content, width=70, style="heavy"))
    print_progress_summary(spec_dir)

    # Show stuck subtasks if any
    stuck_subtasks = recovery_manager.get_stuck_subtasks()
    if stuck_subtasks:
        print()
        print_status("STUCK SUBTASKS (need manual intervention):", "error")
        for stuck in stuck_subtasks:
            print(f"  {icon(Icons.ERROR)} {stuck['subtask_id']}: {stuck['reason']}")

    # Instructions
    completed, total = count_subtasks(spec_dir)
    if completed < total:
        content = [
            bold(f"{icon(Icons.PLAY)} NEXT STEPS"),
            "",
            f"{total - completed} subtasks remaining.",
            f"Run again: {highlight(f'python workpilot/run.py --spec {spec_dir.name}')}",
        ]
    else:
        content = [
            bold(f"{icon(Icons.SUCCESS)} NEXT STEPS"),
            "",
            "All subtasks completed!",
            "  1. Review the workpilot/* branch",
            "  2. Run manual tests",
            "  3. Merge to main",
        ]

    print()
    print(box(content, width=70, style="light"))
    print()

    # Set final status
    if completed == total:
        status_manager.update(state=BuildState.COMPLETE)
        if _ut_finish_build is not None:
            try:
                _ut_finish_build(spec_dir, status="complete")
            except Exception:
                pass
        if _ut_record_task is not None:
            try:
                _ut_record_task(project_dir, spec_dir.name, "completed")
            except Exception:
                pass
        # Log agent completion
        workflow_logger.log_agent_end(
            AGENT_NAME,
            "autonomous_agent_loop",
            "success",
            {
                "total_sessions": iteration,
                "completed_subtasks": completed,
                "total_subtasks": total,
                "project_dir": str(project_dir),
                "spec_dir": str(spec_dir.name),
            },
            agent_trace_id,
        )
        audit_event(
            project_dir,
            kind="agent_completed",
            actor="coder",
            correlation_id=spec_dir.name,
            summary=f"coder completed: {completed}/{total} subtasks",
            payload={
                "completed_subtasks": completed,
                "total_subtasks": total,
                "total_sessions": iteration,
            },
        )
    else:
        status_manager.update(state=BuildState.PAUSED)
        if _ut_finish_build is not None:
            try:
                _ut_finish_build(spec_dir, status="paused")
            except Exception:
                pass
        if _ut_record_task is not None:
            try:
                _ut_record_task(project_dir, spec_dir.name, "in_progress")
            except Exception:
                pass
        # Log agent pause
        workflow_logger.log_agent_end(
            AGENT_NAME,
            "autonomous_agent_loop",
            "paused",
            {
                "total_sessions": iteration,
                "completed_subtasks": completed,
                "total_subtasks": total,
                "remaining": total - completed,
                "project_dir": str(project_dir),
                "spec_dir": str(spec_dir.name),
            },
            agent_trace_id,
        )
        audit_event(
            project_dir,
            kind="agent_paused",
            actor="coder",
            correlation_id=spec_dir.name,
            summary=f"coder paused: {completed}/{total} subtasks",
            payload={
                "completed_subtasks": completed,
                "total_subtasks": total,
                "remaining": total - completed,
            },
        )

    # Clean up streaming session
    if streaming_wrapper:
        try:
            await streaming_wrapper.end_session()
            print_status(f"Streaming session ended: {streaming_session_id}", "info")
        except Exception as e:
            logger.warning(f"Failed to end streaming session: {e}")
