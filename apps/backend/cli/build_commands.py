"""
Build Commands
==============

CLI commands for building specs and handling the main build flow.
"""

import asyncio
import sys
from pathlib import Path

# Ensure parent directory is in path for imports (before other imports)
_PARENT_DIR = Path(__file__).parent.parent
if str(_PARENT_DIR) not in sys.path:
    sys.path.insert(0, str(_PARENT_DIR))

# Import only what we need at module level
# Heavy imports are lazy-loaded in functions to avoid import errors
from progress import print_paused_banner
from review import ReviewState
from ui import (
    BuildState,
    Icons,
    MenuOption,
    StatusManager,
    bold,
    box,
    highlight,
    icon,
    muted,
    print_status,
    select_menu,
    success,
    warning,
)
from workspace import (
    WorkspaceMode,
    check_existing_build,
    choose_workspace,
    finalize_workspace,
    get_existing_build_worktree,
    handle_workspace_choice,
    setup_workspace,
)

from .input_handlers import (
    read_from_file,
    read_multiline_input,
)


def _changed_files(worktree_manager, spec_name: str) -> list[str] | None:
    """Paths this task has touched, or None when it cannot be determined.

    None is not the same as an empty list, and the engine treats it that way:
    an unknown change set runs the conditional phases, because one extra pass
    is cheaper than skipping a design review on a change that did touch the UI.
    """
    if worktree_manager is None:
        return None
    try:
        return [path for _status, path in worktree_manager.get_changed_files(spec_name)]
    except Exception as exc:  # noqa: BLE001 - advisory input, never fatal
        from debug import debug_warning

        debug_warning("run.py", f"Could not list changed files: {exc}")
        return None


def _resolve_workflow_profile(
    spec_dir: Path,
    changed_files: list[str] | None = None,
    *,
    announce: bool = True,
):
    """Resolve the declarative workflow for this build, or None when disabled.

    Called twice, for two different questions. Up front with no change set, to
    show the user what their effort level bought before anything runs — at that
    point nothing has been written, so a conditional phase can only be
    forecast, and the engine's "unknown means run it" rule makes that forecast
    the inclusive one. Then again after the coding phase with the real change
    set, to decide which conditional gates actually apply. The second call does
    not announce: the plan was already printed, and reprinting it would read as
    a second build starting.

    Gated on WORKPILOT_WORKFLOW_ENGINE=1. Every failure degrades to None, which
    is exactly the previous behaviour: the workflow shapes the run, it must
    never be able to stop one.
    """
    import os

    if os.environ.get("WORKPILOT_WORKFLOW_ENGINE") != "1":
        return None
    try:
        from core.client import _get_active_provider
        from phase_config import get_phase_thinking

        from workflows import load_workflow, resolve_profile

        repo_root = Path(__file__).resolve().parents[3]
        workflow_path = repo_root / "workflows" / "feature-build" / "workflow.yaml"
        workflow = load_workflow(workflow_path)
        effort = get_phase_thinking(spec_dir, "coding")
        profile = resolve_profile(
            workflow,
            effort,
            provider=_get_active_provider(spec_dir),
            changed_files=changed_files,
        )
        if not announce:
            return profile
        print("\n" + profile.describe())

        # Naming an uninstalled implementation up front beats discovering it
        # halfway through a build.
        try:
            from skills_registry.packs import load_packs

            from workflows import validate_impls

            available = {
                p.name: {s.name for s in p.skills()}
                for p in load_packs(repo_root / "skills")
            }
            for miss in validate_impls(workflow, available):
                if profile.will_run(miss.phase_id):
                    print(f"  ⚠ {miss.phase_id}: {miss.reason}")
        except Exception as exc:  # noqa: BLE001 - advisory only
            print(f"  (could not check phase implementations: {exc})")

        return profile
    except Exception as exc:  # noqa: BLE001 - never block a build
        if announce:
            print(f"⚠ Workflow engine disabled for this run: {exc}")
        return None


def _run_deterministic_gates(profile, working_dir: Path, spec_dir: Path):
    """Execute the no-token checks the resolved profile keeps.

    Returns the run, or None when the engine is off. Never raises: a gate is a
    signal, and a build that produced working code must not fail because a
    linter could not start.
    """
    if profile is None:
        return None
    try:
        from skills_registry.packs import load_packs

        from workflows import run_deterministic_gates

        repo_root = Path(__file__).resolve().parents[3]
        packs = {p.name: p for p in load_packs(repo_root / "skills")}
        run = run_deterministic_gates(profile, working_dir, packs)
        if summary := run.describe():
            print("\n" + summary)
        return run
    except Exception as exc:  # noqa: BLE001 - gates never fail a build
        from debug import debug_warning

        debug_warning("run.py", f"Deterministic gates skipped: {exc}")
        return None


def _run_observe_phase(
    spec_dir: Path,
    *,
    profile,
    qa_approved: bool,
    ran_qa: bool,
    detector_clean: bool | None = None,
    tests_passed: bool | None = None,
) -> None:
    """Turn what this build externally verified into learning-loop candidates.

    Gated on the profile only for the phase's presence; the phase is declared
    `always: true`, so in practice it runs whenever the engine is on. Every
    failure is swallowed: a build that produced working code must not be
    reported as failed because the bookkeeping afterwards did not work.
    """
    if profile is not None and not profile.will_run("observe"):
        return
    if profile is None:
        return
    try:
        from learning_loop.observe import BuildOutcome, run_observe
        from learning_loop.pattern_storage import PatternStorage

        repo_root = Path(__file__).resolve().parents[3]
        outcome = BuildOutcome(
            spec_id=spec_dir.name,
            # QA that did not run is unknown, not passed. Recording a skipped
            # gate as a clean one manufactures corroboration out of a budget
            # decision, which is the one thing the external-signal rule exists
            # to prevent.
            qa_approved=qa_approved if ran_qa else None,
            tests_passed=tests_passed,
            # None when no gate ran or one could not be evaluated. Recording a
            # gate that did not execute as clean would manufacture exactly the
            # corroboration the promotion rules refuse to invent.
            detector_clean=detector_clean,
            workflow=profile.workflow,
        )
        patterns = PatternStorage(spec_dir.parent.parent).load_patterns()
        report = run_observe(repo_root, outcome, patterns)
        if summary := report.describe():
            print("\n" + summary)
    except Exception as exc:  # noqa: BLE001 - observation never fails a build
        from debug import debug_warning

        debug_warning("run.py", f"Observe phase skipped: {exc}")


def _report_hard_gates(profile, spec_dir: Path, tests_passed: bool | None) -> None:
    """Say whether the workflow's non-negotiable gates actually held.

    Reports; does not abort. The build has already produced a worktree and a
    diff, and throwing that away over a gate the user can see for themselves
    would be worse than telling them plainly. What matters is that "not
    negotiable" stops being a claim nobody checks.
    """
    if profile is None:
        return
    try:
        from workflows import evaluate_hard_gates

        report = evaluate_hard_gates(profile, spec_dir, tests_passed=tests_passed)
        if summary := report.describe():
            print("\n" + summary)
        if report.blocking:
            print("  → the branch is not ready to merge on this evidence.")
    except Exception as exc:  # noqa: BLE001 - a gate reports, never fails a build
        from debug import debug_warning

        debug_warning("run.py", f"Hard gate check skipped: {exc}")


def _tests_went_green(spec_dir: Path) -> bool | None:
    """Whether the QA report recorded a passing test run, or None if unknown."""
    report = spec_dir / "qa_report.md"
    if not report.is_file():
        return None
    try:
        text = report.read_text(encoding="utf-8", errors="replace").lower()
    except OSError:
        return None
    if "tests: pass" in text or "all tests passed" in text:
        return True
    if "tests: fail" in text or "test failures" in text:
        return False
    return None


def handle_build_command(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    max_iterations: int | None,
    verbose: bool,
    force_isolated: bool,
    force_direct: bool,
    auto_continue: bool,
    skip_qa: bool,
    force_bypass_approval: bool,
    base_branch: str | None = None,
    enable_streaming: bool = False,
    streaming_session_id: str | None = None,
) -> None:
    """
    Handle the main build command.

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory path
        model: Model to use (used as default; may be overridden by task_metadata.json)
        max_iterations: Maximum number of iterations (None for unlimited)
        verbose: Enable verbose output
        force_isolated: Force isolated workspace mode
        force_direct: Force direct workspace mode
        auto_continue: Auto-continue mode (non-interactive)
        skip_qa: Skip automatic QA validation
        force_bypass_approval: Force bypass approval check
        base_branch: Base branch for worktree creation (default: current branch)
        enable_streaming: Enable streaming mode for this build
        streaming_session_id: Streaming session ID for live coding
    """
    # Lazy imports to avoid loading heavy modules
    from agent import run_autonomous_agent, sync_spec_to_source
    from debug import (
        debug,
        debug_info,
        debug_section,
        debug_success,
        debug_warning,
    )
    from phase_config import get_phase_model
    from prompts_pkg.prompts import (
        get_base_branch_from_metadata,
        get_use_local_branch_from_metadata,
    )
    from qa_loop import is_qa_approved, run_qa_validation_loop, should_run_qa

    from .utils import print_banner, validate_environment

    # Get the resolved model for the planning phase (first phase of build)
    # This respects task_metadata.json phase configuration from the UI
    planning_model = get_phase_model(spec_dir, "planning", model)
    coding_model = get_phase_model(spec_dir, "coding", model)
    qa_model = get_phase_model(spec_dir, "qa", model)

    # Resolve the declarative workflow, when it is switched on. It decides
    # which phases this effort level and provider actually buy; the hard-coded
    # sequence below stays the execution path. Opt-in until the golden profiles
    # have run against real builds — this function is the entry point of every
    # build in the product.
    _profile = _resolve_workflow_profile(spec_dir)

    print_banner()
    print(f"\nProject directory: {project_dir}")
    print(f"Spec: {spec_dir.name}")
    # Show phase-specific models if they differ
    if planning_model != coding_model or coding_model != qa_model:
        print(
            f"Models: Planning={planning_model.split('-')[1] if '-' in planning_model else planning_model}, "
            f"Coding={coding_model.split('-')[1] if '-' in coding_model else coding_model}, "
            f"QA={qa_model.split('-')[1] if '-' in qa_model else qa_model}"
        )
    else:
        print(f"Model: {planning_model}")

    if max_iterations:
        print(f"Max iterations: {max_iterations}")
    else:
        print("Max iterations: Unlimited (runs until all subtasks complete)")

    print()

    # Validate environment
    if not validate_environment(spec_dir):
        sys.exit(1)

    # Check human review approval
    review_state = ReviewState.load(spec_dir)
    if not review_state.is_approval_valid(spec_dir):
        if force_bypass_approval:
            # User explicitly bypassed approval check
            print()
            print(
                warning(
                    f"{icon(Icons.WARNING)} WARNING: Bypassing approval check with --force"
                )
            )
            print(muted("This spec has not been approved for building."))
            print()
        else:
            print()
            content = [
                bold(f"{icon(Icons.WARNING)} BUILD BLOCKED - REVIEW REQUIRED"),
                "",
                "This spec requires human approval before building.",
            ]

            if review_state.approved and not review_state.is_approval_valid(spec_dir):
                # Spec changed after approval
                content.append("")
                content.append(warning("The spec has been modified since approval."))
                content.append("Please re-review and re-approve.")

            content.extend(
                [
                    "",
                    highlight("To review and approve:"),
                    f"  python workpilot/review.py --spec-dir {spec_dir}",
                    "",
                    muted("Or use --force to bypass this check (not recommended)."),
                ]
            )
            print(box(content, width=70, style="heavy"))
            print()
            sys.exit(1)
    else:
        debug_success(
            "run.py", "Review approval validated", approved_by=review_state.approved_by
        )

    # Check for existing build
    if get_existing_build_worktree(project_dir, spec_dir.name):
        if auto_continue:
            # Non-interactive mode: auto-continue with existing build
            debug("run.py", "Auto-continue mode: continuing with existing build")
            print("Auto-continue: Resuming existing build...")
        else:
            continue_existing = check_existing_build(project_dir, spec_dir.name)
            if continue_existing:
                # Continue with existing worktree
                pass
            else:
                # User chose to start fresh or merged existing
                pass

    # Choose workspace (skip for parallel mode - it always uses worktrees)
    working_dir = project_dir
    worktree_manager = None
    source_spec_dir = None  # Track original spec dir for syncing back from worktree

    # Let user choose workspace mode (or auto-select if --auto-continue)
    workspace_mode = choose_workspace(
        project_dir,
        spec_dir.name,
        force_isolated=force_isolated,
        force_direct=force_direct,
        auto_continue=auto_continue,
    )

    # If base_branch not provided via CLI, try to read from task_metadata.json
    # This ensures the backend uses the branch configured in the frontend
    if base_branch is None:
        metadata_branch = get_base_branch_from_metadata(spec_dir)
        if metadata_branch:
            base_branch = metadata_branch
            debug("run.py", f"Using base branch from task metadata: {base_branch}")

    # Check if user requested local branch (preserves gitignored files like .env)
    use_local_branch = get_use_local_branch_from_metadata(spec_dir)

    if workspace_mode == WorkspaceMode.ISOLATED:
        # Keep reference to original spec directory for syncing progress back
        source_spec_dir = spec_dir

        working_dir, worktree_manager, localized_spec_dir = setup_workspace(
            project_dir,
            spec_dir.name,
            workspace_mode,
            source_spec_dir=spec_dir,
            base_branch=base_branch,
            use_local_branch=use_local_branch,
        )
        # Use the localized spec directory (inside worktree) for AI access
        if localized_spec_dir:
            spec_dir = localized_spec_dir

    # Run the autonomous agent
    debug_section("run.py", "Starting Build Execution")
    debug(
        "run.py",
        "Build configuration",
        model=model,
        workspace_mode=str(workspace_mode),
        working_dir=str(working_dir),
        spec_dir=str(spec_dir),
    )

    try:
        debug("run.py", "Starting agent execution")

        asyncio.run(
            run_autonomous_agent(
                project_dir=working_dir,  # Use worktree if isolated
                spec_dir=spec_dir,
                model=model,
                max_iterations=max_iterations,
                verbose=verbose,
                source_spec_dir=source_spec_dir,  # For syncing progress back to main project
                streaming_session_id=streaming_session_id,
            )
        )
        debug_success("run.py", "Agent execution completed")

        # Encoding-safety pass: editing UTF-8 files (notably .resx with a BOM)
        # can mangle accented characters into the Unicode replacement char "�".
        # Restore them from the pristine base version before QA so the corruption
        # never reaches the diff/merge. Best-effort: never breaks the build.
        if worktree_manager is not None:
            try:
                from core.encoding_repair import repair_worktree_changed_files

                repair_base = base_branch or worktree_manager.base_branch
                repair = repair_worktree_changed_files(working_dir, repair_base)
                repaired = repair.get("repaired") or []
                unrepaired = repair.get("unrepaired") or {}
                if repaired:
                    print(
                        f"🩹 Encoding repair: restored accented characters in "
                        f"{len(repaired)} file(s): {', '.join(repaired)}"
                    )
                if unrepaired:
                    print(
                        "⚠ Encoding repair: unrecoverable replacement chars (�) "
                        f"remain in {len(unrepaired)} file(s) — manual review: "
                        f"{', '.join(unrepaired.keys())}"
                    )
            except Exception as exc:  # noqa: BLE001 - non-fatal
                debug_warning("run.py", f"Encoding repair skipped: {exc}")

        # Run QA validation BEFORE finalization (while worktree still exists)
        # QA must sign off before the build is considered complete
        qa_approved = True  # Default to approved if QA is skipped
        qa_should_run = not skip_qa and should_run_qa(spec_dir)
        if _profile is not None and qa_should_run and not _profile.will_run("qa"):
            # The workflow says this effort level does not buy a QA pass.
            # `skip_qa` and should_run_qa() still win when either says no —
            # the profile can remove a phase, never add one back.
            print(
                f"\n⏭  QA skipped — workflow '{_profile.workflow}' does not run it "
                f"at effort '{_profile.effort}'."
            )
            qa_should_run = False
        if qa_should_run:
            print("\n" + "=" * 70)
            print("  SUBTASKS COMPLETE - STARTING QA VALIDATION")
            print("=" * 70)
            print("\nAll subtasks completed. Now running QA validation loop...")
            print("This ensures production-quality output before sign-off.\n")

            try:
                qa_approved = asyncio.run(
                    run_qa_validation_loop(
                        project_dir=working_dir,
                        spec_dir=spec_dir,
                        model=model,
                        verbose=verbose,
                        source_spec_dir=source_spec_dir,
                    )
                )

                if qa_approved:
                    print("\n" + "=" * 70)
                    print("  ✅ QA VALIDATION PASSED")
                    print("=" * 70)
                    print("\nAll acceptance criteria verified.")
                    print("The implementation is production-ready.\n")
                else:
                    print("\n" + "=" * 70)
                    print("  ⚠️  QA VALIDATION INCOMPLETE")
                    print("=" * 70)
                    print("\nSome issues require manual attention.")
                    print(f"See: {spec_dir / 'qa_report.md'}")
                    print(f"Or:  {spec_dir / 'QA_FIX_REQUEST.md'}")
                    print(
                        f"\nResume QA: python workpilot/run.py --spec {spec_dir.name} --qa\n"
                    )

                # Sync implementation plan to main project after QA
                # This ensures the main project has the latest status (human_review)
                if sync_spec_to_source(spec_dir, source_spec_dir):
                    debug_info(
                        "run.py", "Implementation plan synced to main project after QA"
                    )
            except KeyboardInterrupt:
                print("\n\nQA validation paused.")
                print(f"Resume: python workpilot/run.py --spec {spec_dir.name} --qa")
                qa_approved = False
        else:
            # QA skipped — if the build is complete but QA was already approved,
            # emit QA_PASSED so that frontend XState transitions from qa_review →
            # human_review instead of leaving the kanban card stuck.
            from progress import is_build_complete

            if is_build_complete(spec_dir) and is_qa_approved(spec_dir):
                try:
                    from core.task_event import TaskEventEmitter

                    task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)
                    task_event_emitter.emit(
                        "QA_PASSED",
                        {"iteration": 0, "testsRun": {}},
                    )
                except Exception:
                    pass  # Best-effort

        # Deterministic gates. The workflow declares them; this is where the
        # engine actually runs one. No API call, so they are not pruned by
        # effort — and their verdict is an *external* signal, which is what
        # makes it usable as corroboration by the learning loop below.
        gate_run = _run_deterministic_gates(
            _resolve_workflow_profile(
                spec_dir,
                _changed_files(worktree_manager, spec_dir.name),
                announce=False,
            ),
            working_dir,
            spec_dir,
        )

        # Hard gates. `verify` declares `hard_gate: tests-pass`, which until
        # now only kept the phase out of the effort pruner — nothing checked
        # whether the tests actually passed, so a build could conclude green
        # with a red suite. Evaluated here, from the same test evidence the
        # observe phase records, so the two cannot disagree.
        _tests_green = _tests_went_green(spec_dir)
        _report_hard_gates(_profile, spec_dir, _tests_green)

        # The `observe` phase. Marked `always: true` in the workflow, so it
        # runs at every effort level — it costs no API call, it only reads what
        # the verifiers already said. Placed after QA so the QA verdict is one
        # of the signals it can record.
        _run_observe_phase(
            spec_dir,
            profile=_profile,
            qa_approved=qa_approved,
            ran_qa=qa_should_run,
            detector_clean=gate_run.all_clean if gate_run else None,
            tests_passed=_tests_green,
        )

        # Post-build finalization (only for isolated sequential mode)
        # This happens AFTER QA validation so the worktree still exists
        if worktree_manager:
            choice = finalize_workspace(
                project_dir,
                spec_dir.name,
                worktree_manager,
                auto_continue=auto_continue,
            )
            handle_workspace_choice(
                choice, project_dir, spec_dir.name, worktree_manager
            )

    except KeyboardInterrupt:
        _handle_build_interrupt(
            spec_dir=spec_dir,
            project_dir=project_dir,
            worktree_manager=worktree_manager,
            working_dir=working_dir,
            model=model,
            max_iterations=max_iterations,
            verbose=verbose,
        )
    except Exception as e:
        import traceback

        print(f"\nFatal error: {e}")
        traceback.print_exc()
        sys.exit(1)


def _handle_build_interrupt(
    spec_dir: Path,
    project_dir: Path,
    worktree_manager,
    working_dir: Path,
    model: str,
    max_iterations: int | None,
    verbose: bool,
) -> None:
    """
    Handle keyboard interrupt during build.

    Args:
        spec_dir: Spec directory path
        project_dir: Project root directory
        worktree_manager: Worktree manager instance (if using isolated mode)
        working_dir: Current working directory
        model: Model being used
        max_iterations: Maximum iterations
        verbose: Verbose mode flag
    """
    from agent import run_autonomous_agent

    # Print paused banner
    print_paused_banner(spec_dir, spec_dir.name, has_worktree=bool(worktree_manager))

    # Update status file
    status_manager = StatusManager(project_dir)
    status_manager.update(state=BuildState.PAUSED)

    # Offer to add human input with enhanced menu
    try:
        options = [
            MenuOption(
                key="type",
                label="Type instructions",
                icon=Icons.EDIT,
                description="Enter guidance for the agent's next session",
            ),
            MenuOption(
                key="paste",
                label="Paste from clipboard",
                icon=Icons.CLIPBOARD,
                description="Paste text you've copied (Cmd+V / Ctrl+Shift+V)",
            ),
            MenuOption(
                key="file",
                label="Read from file",
                icon=Icons.DOCUMENT,
                description="Load instructions from a text file",
            ),
            MenuOption(
                key="skip",
                label="Continue without instructions",
                icon=Icons.SKIP,
                description="Resume the build as-is",
            ),
            MenuOption(
                key="quit",
                label="Quit",
                icon=Icons.DOOR,
                description="Exit without resuming",
            ),
        ]

        choice = select_menu(
            title="What would you like to do?",
            options=options,
            subtitle="Progress saved. You can add instructions for the agent.",
            allow_quit=False,  # We have explicit quit option
        )

        if choice == "quit" or choice is None:
            print()
            print_status("Exiting...", "info")
            status_manager.set_inactive()
            sys.exit(0)

        human_input = ""

        if choice == "file":
            # Read from file
            human_input = read_from_file()
            if human_input is None:
                human_input = ""

        elif choice in ["type", "paste"]:
            human_input = read_multiline_input("Enter/paste your instructions below.")
            if human_input is None:
                print()
                print_status("Exiting without saving instructions...", "warning")
                status_manager.set_inactive()
                sys.exit(0)

        if human_input:
            # Save to HUMAN_INPUT.md
            input_file = spec_dir / "HUMAN_INPUT.md"
            input_file.write_text(human_input, encoding="utf-8")

            content = [
                success(f"{icon(Icons.SUCCESS)} INSTRUCTIONS SAVED"),
                "",
                f"Saved to: {highlight(str(input_file.name))}",
                "",
                muted(
                    "The agent will read and follow these instructions when you resume."
                ),
            ]
            print()
            print(box(content, width=70, style="heavy"))
        elif choice != "skip":
            print()
            print_status("No instructions provided.", "info")

        # If 'skip' was selected, actually resume the build
        if choice == "skip":
            print()
            print_status("Resuming build...", "info")
            status_manager.update(state=BuildState.RUNNING)
            asyncio.run(
                run_autonomous_agent(
                    project_dir=working_dir,
                    spec_dir=spec_dir,
                    model=model,
                    max_iterations=max_iterations,
                    verbose=verbose,
                    streaming_session_id=streaming_session_id,  # noqa: F821
                )
            )
            # Build completed or was interrupted again - exit
            sys.exit(0)

    except KeyboardInterrupt:
        # User pressed Ctrl+C again during input prompt - exit immediately
        print()
        print_status("Exiting...", "warning")
        status_manager = StatusManager(project_dir)
        status_manager.set_inactive()
        sys.exit(0)
    except EOFError:
        # stdin closed
        pass

    # Resume instructions (shown when user provided instructions or chose file/type/paste)
    print()
    content = [
        bold(f"{icon(Icons.PLAY)} TO RESUME"),
        "",
        f"Run: {highlight(f'python workpilot/run.py --spec {spec_dir.name}')}",
    ]
    if worktree_manager:
        content.append("")
        content.append(muted("Your build is in a separate workspace and is safe."))
    print(box(content, width=70, style="light"))
    print()
