"""
Planner Agent Module
====================

Handles follow-up planner sessions for adding new subtasks to completed specs.
"""

import logging
from pathlib import Path

from core.runtimes import create_agent_runtime
from phase_config import get_phase_model, get_phase_provider, get_phase_thinking_budget
from phase_event import ExecutionPhase, emit_phase
from task_logger import (
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
    print_status,
)

from .agent_audit import audit_decision, audit_event
from .feature_wiring import (
    apply_router_override,
    load_domain_addendum,
    suggest_routed_model,
)
from .session import run_agent_session

logger = logging.getLogger(__name__)


async def run_followup_planner(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    verbose: bool = False,
) -> bool:
    """
    Run the follow-up planner to add new subtasks to a completed spec.

    This is a simplified version of run_autonomous_agent that:
    1. Creates a client
    2. Loads the followup planner prompt
    3. Runs a single planning session
    4. Returns after the plan is updated (doesn't enter coding loop)

    The planner agent will:
    - Read FOLLOWUP_REQUEST.md for the new task
    - Read the existing implementation_plan.json
    - Add new phase(s) with pending subtasks
    - Update the plan status back to in_progress

    Args:
        project_dir: Root directory for the project
        spec_dir: Directory containing the completed spec
        model: Claude model to use
        verbose: Whether to show detailed output

    Returns:
        bool: True if planning completed successfully
    """
    from implementation_plan import ImplementationPlan
    from prompts import get_followup_planner_prompt

    # Initialize status manager for ccstatusline
    status_manager = StatusManager(project_dir)
    status_manager.set_active(spec_dir.name, BuildState.PLANNING)
    emit_phase(ExecutionPhase.PLANNING, "Follow-up planning")

    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="planner",
        correlation_id=spec_dir.name,
        summary="follow-up planner invoked",
        payload={"model": model, "spec_dir": str(spec_dir)},
    )

    # --- Feature wiring (opt-in) --------------------------------------------
    try:
        new_model, override_info = apply_router_override(
            model,
            spec_dir=spec_dir,
            phase="planning",
            prompt_hint=f"follow-up planning for spec {spec_dir.name}",
        )
        if override_info is not None:
            audit_decision(
                project_dir,
                actor="model_router",
                spec_dir=spec_dir,
                decision_id=f"router-override-planner-{spec_dir.name}",
                title="Planner model substituted by router (no explicit user choice)",
                chosen=new_model,
                rejected=(model,),
                rationale=(
                    f"ModelRouter substituted {model} → {new_model} "
                    f"(~${override_info['estimated_cost_usd']:.4f}). "
                    f"Override active because no CLI/task_metadata model was set."
                ),
            )
            model = new_model  # noqa: PLW2901 — intentional reassignment
        else:
            suggestion = suggest_routed_model(
                prompt=f"follow-up planning for spec {spec_dir.name}",
                task_hint="planning",
            )
            if suggestion and suggestion["model"] != model:
                audit_decision(
                    project_dir,
                    actor="model_router",
                    spec_dir=spec_dir,
                    decision_id=f"router-suggest-planner-{spec_dir.name}",
                    title="Cheaper planner model available",
                    chosen=model,
                    rejected=(suggestion["model"],),
                    rationale=(
                        f"ModelRouter suggested {suggestion['model']} "
                        f"(~${suggestion['estimated_cost_usd']:.4f}); "
                        f"user choice {model} kept."
                    ),
                )
    except Exception:
        pass

    try:
        if load_domain_addendum(spec_dir, role="planner"):
            audit_event(
                project_dir,
                kind="system_event",
                actor="domain_agents",
                correlation_id=spec_dir.name,
                summary="domain addendum available for planner",
            )
    except Exception:
        pass
    # ------------------------------------------------------------------------

    # Initialize task logger for persistent logging
    task_logger = get_task_logger(spec_dir)

    # Show header
    content = [
        bold(f"{icon(Icons.GEAR)} FOLLOW-UP PLANNER SESSION"),
        "",
        f"Spec: {highlight(spec_dir.name)}",
        muted("Adding follow-up work to completed spec."),
        "",
        muted("The agent will read your FOLLOWUP_REQUEST.md and add new subtasks."),
    ]
    print()
    print(box(content, width=70, style="heavy"))
    print()

    # Start planning phase in task logger
    if task_logger:
        task_logger.start_phase(LogPhase.PLANNING, "Starting follow-up planning...")
        task_logger.set_session(1)

    # Migration vers runtime provider-agnostique
    phase_provider = get_phase_provider(spec_dir, phase="planning")
    phase_model = get_phase_model(spec_dir, "planning", model)
    phase_thinking_budget = get_phase_thinking_budget(spec_dir, "planning")
    config = None
    runtime = create_agent_runtime(
        spec_dir=spec_dir,
        phase="planning",
        project_dir=project_dir,
        agent_type="planner",
        cli_provider=phase_provider,
        cli_model=phase_model,
        cli_thinking=phase_thinking_budget,
        config=config,
    )

    # Generate follow-up planner prompt
    prompt = get_followup_planner_prompt(spec_dir)

    print_status("Running follow-up planner...", "progress")
    print()

    try:
        # Outer retry loop so the rate-limit shield can pause-and-resume the
        # planning session instead of failing the follow-up planning outright.
        from services.rate_limit_shield import (
            handle_prompt_too_long,
            handle_rate_limit_pause,
        )

        while True:
            async with runtime:
                status, response, error_info = await run_agent_session(
                    runtime, prompt, spec_dir, verbose, phase=LogPhase.PLANNING
                )

            if status == "error" and isinstance(error_info, dict):
                err_msg = error_info.get("message", "")
                # Prompt-too-long is permanent — halt and let the UI surface
                # "reset conversation / switch provider" remediation.
                if handle_prompt_too_long(RuntimeError(err_msg), spec_dir, "planner"):
                    break
                if error_info.get("type") == "rate_limit" and (
                    await handle_rate_limit_pause(
                        RuntimeError(err_msg), spec_dir, "planner"
                    )
                ):
                    # Pause-and-resume succeeded — retry the planning session.
                    continue
            break

        # End planning phase in task logger
        if task_logger:
            task_logger.end_phase(
                LogPhase.PLANNING,
                success=(status != "error"),
                message="Follow-up planning session completed",
            )

        if status == "error":
            print()
            print_status("Follow-up planning failed", "error")
            status_manager.update(state=BuildState.ERROR)
            audit_event(
                project_dir,
                kind="agent_failed",
                actor="planner",
                correlation_id=spec_dir.name,
                summary="follow-up planning failed (session error)",
                payload={"error_info": str(error_info)[:500] if error_info else ""},
            )
            return False

        # Verify the plan was updated (should have pending subtasks now)
        plan_file = spec_dir / "implementation_plan.json"
        if plan_file.exists():
            plan = ImplementationPlan.load(plan_file)

            # Check if there are any pending subtasks
            all_subtasks = [c for p in plan.phases for c in p.subtasks]
            pending_subtasks = [c for c in all_subtasks if c.status.value == "pending"]

            if pending_subtasks:
                # Reset the plan status to in_progress (in case planner didn't)
                plan.reset_for_followup()
                await plan.async_save(plan_file)

                print()
                content = [
                    bold(f"{icon(Icons.SUCCESS)} FOLLOW-UP PLANNING COMPLETE"),
                    "",
                    f"New pending subtasks: {highlight(str(len(pending_subtasks)))}",
                    f"Total subtasks: {len(all_subtasks)}",
                    "",
                    muted("Next steps:"),
                    f"  Run: {highlight(f'python workpilot/run.py --spec {spec_dir.name}')}",
                ]
                print(box(content, width=70, style="heavy"))
                print()
                status_manager.update(state=BuildState.PAUSED)
                audit_event(
                    project_dir,
                    kind="agent_completed",
                    actor="planner",
                    correlation_id=spec_dir.name,
                    summary=f"follow-up planning added {len(pending_subtasks)} subtasks",
                    payload={
                        "new_pending_subtasks": len(pending_subtasks),
                        "total_subtasks": len(all_subtasks),
                    },
                )
                return True
            else:
                print()
                print_status(
                    "Warning: No pending subtasks found after planning", "warning"
                )
                print(muted("The planner may not have added new subtasks."))
                print(muted("Check implementation_plan.json manually."))
                status_manager.update(state=BuildState.PAUSED)
                audit_event(
                    project_dir,
                    kind="agent_completed",
                    actor="planner",
                    correlation_id=spec_dir.name,
                    summary="follow-up planning produced no new subtasks",
                    payload={"total_subtasks": len(all_subtasks)},
                )
                return False
        else:
            print()
            print_status(
                "Error: implementation_plan.json not found after planning", "error"
            )
            status_manager.update(state=BuildState.ERROR)
            audit_event(
                project_dir,
                kind="agent_failed",
                actor="planner",
                correlation_id=spec_dir.name,
                summary="follow-up planning: implementation_plan.json missing",
            )
            return False

    except Exception as e:
        print()
        print_status(f"Follow-up planning error: {e}", "error")
        if task_logger:
            task_logger.log_error(f"Follow-up planning error: {e}", LogPhase.PLANNING)
        status_manager.update(state=BuildState.ERROR)
        audit_event(
            project_dir,
            kind="agent_failed",
            actor="planner",
            correlation_id=spec_dir.name,
            summary=f"follow-up planning crashed: {type(e).__name__}",
            payload={"error": str(e)[:500]},
        )
        return False
