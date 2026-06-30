"""
QA Validation Loop Orchestration
=================================

Main QA loop that coordinates reviewer and fixer sessions until
approval or max iterations.
"""

import os
import subprocess
import time as time_module
from pathlib import Path

from core.client import create_agent_client
from core.task_event import TaskEventEmitter
from debug import debug, debug_error, debug_section, debug_success, debug_warning
from linear_updater import (
    LinearTaskState,
    is_linear_enabled,
    linear_qa_approved,
    linear_qa_max_iterations,
    linear_qa_rejected,
    linear_qa_started,
)
from phase_config import get_phase_model, get_phase_thinking_budget
from phase_event import ExecutionPhase, emit_phase
from progress import count_subtasks, is_build_complete
from security.constants import PROJECT_DIR_ENV_VAR
from security.qa_scanner import run_qa_security_scan
from task_logger import (
    LogPhase,
    get_task_logger,
)

from .criteria import (
    get_qa_iteration_count,
    get_qa_signoff_status,
    is_qa_approved,
)
from .fixer import run_qa_fixer_session
from .report import (
    create_manual_test_plan,
    escalate_to_human,
    get_iteration_history,
    get_recurring_issue_summary,
    has_recurring_issues,
    is_no_test_project,
    record_iteration,
)
from .reviewer import run_qa_agent_session


def _ensure_fix_request_file(
    spec_dir: Path, issues: list[dict], qa_iteration: int
) -> bool:
    """
    Garantit qu'un ``QA_FIX_REQUEST.md`` existe avant de lancer le fixer.

    Le QA reviewer est censé écrire ce fichier via le prompt
    ``qa_reviewer.md`` (commande ``cat > QA_FIX_REQUEST.md << EOF``). En
    pratique, certains modèles (ou des sessions interrompues) oublient
    cette étape et la boucle échoue ensuite avec
    ``Fixer error: QA_FIX_REQUEST.md not found``.

    Pour rendre la boucle robuste, on synthétise le fichier à partir des
    issues déjà connues (``issues_found`` du sign-off) avant d'invoquer le
    fixer si aucun fichier n'a été produit.

    Args:
        spec_dir: Dossier du spec courant.
        issues: Liste des issues remontées par le reviewer.
        qa_iteration: Itération QA en cours, pour traçabilité.

    Returns:
        ``True`` si le fichier existe à la sortie (déjà présent ou
        synthétisé), ``False`` si on n'a pas pu le créer (issues vides).
    """
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if fix_request_file.exists():
        return True

    if not issues:
        debug_warning(
            "qa_loop",
            "Cannot synthesize QA_FIX_REQUEST.md: reviewer reported no issues",
            iteration=qa_iteration,
        )
        return False

    lines: list[str] = [
        "# QA Fix Request",
        "",
        f"_Auto-généré par la boucle QA (itération {qa_iteration}) car le "
        "reviewer n'a pas produit de fichier explicite._",
        "",
        "## Issues à corriger",
        "",
    ]
    for idx, issue in enumerate(issues, start=1):
        title = issue.get("title") or issue.get("summary") or f"Issue {idx}"
        description = (
            issue.get("description")
            or issue.get("details")
            or issue.get("message")
            or ""
        )
        severity = issue.get("severity") or issue.get("priority") or "unknown"
        lines.append(f"### {idx}. {title}")
        lines.append("")
        lines.append(f"- **Sévérité** : {severity}")
        if description:
            lines.append("")
            lines.append(description.strip())
        lines.append("")

    lines.append("## Verification")
    lines.append("")
    lines.append(
        "Après application des correctifs, mettre à jour "
        "`implementation_plan.json` avec `ready_for_qa_revalidation: true`."
    )
    lines.append("")

    try:
        fix_request_file.write_text("\n".join(lines), encoding="utf-8")
        debug_warning(
            "qa_loop",
            "Synthesized QA_FIX_REQUEST.md from issues_found "
            "(reviewer did not produce one)",
            iteration=qa_iteration,
            issue_count=len(issues),
            path=str(fix_request_file),
        )
        return True
    except OSError as exc:
        debug_error(
            "qa_loop",
            f"Failed to synthesize QA_FIX_REQUEST.md: {exc}",
            iteration=qa_iteration,
        )
        return False


# Configuration
MAX_QA_ITERATIONS = 50
MAX_CONSECUTIVE_ERRORS = 3  # Stop after 3 consecutive errors without progress


async def _run_dotnet_tests(project_dir: Path) -> bool:
    """
    Attempt to run dotnet test on the project.

    Returns:
        True if tests were found and executed, False otherwise.
    """
    try:
        # Search for test projects (*.csproj files with test frameworks)
        test_projects = []
        for csproj in project_dir.glob("**/*.csproj"):
            try:
                content = csproj.read_text(encoding="utf-8", errors="ignore")
                if any(
                    fw in content
                    for fw in ["NUnit", "xunit", "MSTest", "Microsoft.NET.Test.Sdk"]
                ):
                    test_projects.append(csproj)
            except OSError:
                pass

        if not test_projects:
            return False

        debug("qa_loop", f"Found {len(test_projects)} test project(s)")
        print(f"   Found {len(test_projects)} test project(s)")

        # Run dotnet test on each test project
        for test_project in test_projects:
            print(f"   Running tests in: {test_project.relative_to(project_dir)}")
            try:
                result = subprocess.run(
                    ["dotnet", "test", str(test_project), "-c", "Debug"],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    cwd=str(project_dir),
                )
                if result.returncode == 0:
                    print("      ✅ Tests passed")
                    debug("qa_loop", f"dotnet test passed for {test_project.name}")
                else:
                    print("      ⚠️  Tests failed or no tests found")
                    debug_warning(
                        "qa_loop",
                        f"dotnet test returned {result.returncode} for {test_project.name}",
                    )
                    if result.stdout:
                        debug("qa_loop", f"stdout: {result.stdout[:500]}")
                    if result.stderr:
                        debug_error("qa_loop", f"stderr: {result.stderr[:500]}")
            except FileNotFoundError:
                debug_error("qa_loop", "dotnet CLI not found on PATH")
                return False
            except subprocess.TimeoutExpired:
                debug_error("qa_loop", "dotnet test timed out after 300 seconds")
                print("      ❌ Tests timed out")
                return False

        return True

    except Exception as e:
        debug_error("qa_loop", f"Error running dotnet tests: {e}")
        return False


async def _handle_rate_limit_in_qa(
    error: Exception,
    spec_dir: Path,
    source_spec_dir: Path | None,
) -> bool:
    """
    Thin wrapper around the shared rate-limit shield.

    Kept as a module-local alias so existing call sites and tests that patch
    `qa.loop._handle_rate_limit_in_qa` don't need to change.
    """
    from services.rate_limit_shield import handle_rate_limit_pause

    return await handle_rate_limit_pause(error, spec_dir, "qa", source_spec_dir)


# =============================================================================
# QA VALIDATION LOOP
# =============================================================================


async def run_qa_validation_loop(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    verbose: bool = False,
    source_spec_dir: Path | None = None,
) -> bool:
    """
    Run the full QA validation loop.

    This is the self-validating loop:
    1. QA Agent reviews
    2. If rejected → Fixer Agent fixes
    3. QA Agent re-reviews
    4. Loop until approved or max iterations

    Enhanced with:
    - Iteration tracking with detailed history
    - Recurring issue detection (3+ occurrences → human escalation)
    - No-test project handling

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory
        model: Claude model to use
        verbose: Whether to show detailed output

    Returns:
        True if QA approved, False otherwise
    """
    # Set environment variable for security hooks to find the correct project directory
    # This is needed because os.getcwd() may return the wrong directory in worktree mode
    os.environ[PROJECT_DIR_ENV_VAR] = str(project_dir.resolve())
    task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)

    # Clear a stale "local model can't call tools" halt marker from a previous
    # run — re-running QA (e.g. after switching to a tool-capable model or a
    # cloud provider) must not keep surfacing the old halt.
    from services.rate_limit_shield import LOCAL_MODEL_NO_TOOLS_HALT_FILE

    stale_halt = spec_dir / LOCAL_MODEL_NO_TOOLS_HALT_FILE
    if stale_halt.exists():
        try:
            stale_halt.unlink()
        except OSError:
            pass

    debug_section("qa_loop", "QA Validation Loop")
    debug(
        "qa_loop",
        "Starting QA validation loop",
        project_dir=str(project_dir),
        spec_dir=str(spec_dir),
        model=model,
        max_iterations=MAX_QA_ITERATIONS,
    )

    print("\n" + "=" * 70)
    print("  QA VALIDATION LOOP")
    print("  Self-validating quality assurance")
    print("=" * 70)

    # Initialize task logger for the validation phase
    task_logger = get_task_logger(spec_dir)

    # Verify build is complete
    if not is_build_complete(spec_dir):
        debug_warning("qa_loop", "Build is not complete, cannot run QA")
        print("\n❌ Build is not complete. Cannot run QA validation.")
        completed, total = count_subtasks(spec_dir)
        debug("qa_loop", "Build progress", completed=completed, total=total)
        print(f"   Progress: {completed}/{total} subtasks completed")
        return False

    # Emit phase event at start of QA validation (before any early returns)
    emit_phase(ExecutionPhase.QA_REVIEW, "Starting QA validation")
    task_event_emitter.emit(
        "QA_STARTED",
        {"iteration": 1, "maxIterations": MAX_QA_ITERATIONS},
    )

    # Check if there's pending human feedback that needs to be processed
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    has_human_feedback = fix_request_file.exists()

    # Check if already approved - but if there's human feedback, we need to process it first
    if is_qa_approved(spec_dir) and not has_human_feedback:
        debug_success("qa_loop", "Build already approved by QA")
        print("\n✅ Build already approved by QA.")
        task_event_emitter.emit(
            "QA_PASSED",
            {"iteration": 0, "testsRun": {}},
        )
        return True

    # If there's human feedback, we need to run the fixer first before re-validating
    if has_human_feedback:
        debug(
            "qa_loop",
            "Human feedback detected - will run fixer first",
            fix_request_file=str(fix_request_file),
        )
        emit_phase(ExecutionPhase.QA_FIXING, "Processing human feedback")
        task_event_emitter.emit(
            "QA_FIXING_STARTED",
            {"iteration": 0},
        )
        print("\n📝 Human feedback detected. Running QA Fixer first...")

        # Get model and thinking budget for fixer (uses QA phase config)
        qa_model = get_phase_model(spec_dir, "qa", model)
        fixer_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")

        try:
            fix_client = create_agent_client(
                project_dir=project_dir,
                spec_dir=spec_dir,
                model=qa_model,
                agent_type="qa_fixer",
                max_thinking_tokens=fixer_thinking_budget,
            )
        except Exception as e:
            debug_error(
                "qa_loop", f"Failed to create fixer client for human feedback: {e}"
            )
            print(f"\n❌ Failed to create fixer client: {e}")
            task_event_emitter.emit(
                "QA_AGENT_ERROR",
                {"iteration": 0, "consecutiveErrors": 1},
            )
            return False

        try:
            async with fix_client:
                fix_status, fix_response = await run_qa_fixer_session(
                    fix_client,
                    spec_dir,
                    0,
                    False,  # iteration 0 for human feedback
                )
        except Exception as e:
            debug_error("qa_loop", f"Fixer session crashed during human feedback: {e}")
            fix_status = "error"
            fix_response = str(e)

        if fix_status == "error":
            debug_error("qa_loop", f"Fixer error: {fix_response[:200]}")
            print(f"\n❌ Fixer encountered error: {fix_response}")
            return False

        debug_success("qa_loop", "Human feedback fixes applied")
        task_event_emitter.emit(
            "QA_FIXING_COMPLETE",
            {"iteration": 0},
        )
        print("\n✅ Fixes applied based on human feedback. Running QA validation...")

        # Remove the fix request file after processing
        try:
            fix_request_file.unlink()
            debug("qa_loop", "Removed processed QA_FIX_REQUEST.md")
        except OSError:
            pass  # Ignore if file removal fails

    # ── Security Scan (Feature 29: QA Security Scanner) ──────────────────────
    # Run before the QA review loop so findings are already in qa_report.md
    # when the QA reviewer agent reads it.
    print("\n🔐 Running security scan...")
    try:
        sec_passed, _, sec_issues = await run_qa_security_scan(project_dir, spec_dir)
        if not sec_passed:
            critical_count = sum(1 for i in sec_issues if i.get("type") == "critical")
            high_count = sum(1 for i in sec_issues if i.get("type") == "high")
            debug_warning(
                "qa_loop",
                "Security scan found vulnerabilities",
                critical=critical_count,
                high=high_count,
            )
            print(
                f"   ⚠️  Security issues found: {critical_count} critical, {high_count} high"
            )
            task_event_emitter.emit(
                "SECURITY_SCAN_ISSUES",
                {
                    "critical": critical_count,
                    "high": high_count,
                    "issues": sec_issues[:10],
                },
            )
        else:
            print("   ✅ Security scan passed — no critical/high issues")
    except Exception as _sec_err:
        debug_warning("qa_loop", f"Security scan skipped (non-blocking): {_sec_err}")
        print(f"   ℹ️  Security scan skipped: {_sec_err}")
    # ── End Security Scan ─────────────────────────────────────────────────────

    # Check for no-test projects and attempt .NET test execution
    if is_no_test_project(spec_dir, project_dir):
        print("\n⚠️  No test framework detected in project.")

        # Check if this is a .NET project with test projects available
        from core.dotnet_tools import detect_dotnet_project

        if detect_dotnet_project(project_dir):
            print("Detected .NET project — attempting to run dotnet test...")
            try:
                result = await _run_dotnet_tests(project_dir)
                if result:
                    print("✅ dotnet test executed successfully")
                else:
                    print("⚠️  dotnet test found no test projects")
                    print("Creating manual test plan as fallback...")
                    manual_plan = create_manual_test_plan(spec_dir, spec_dir.name)
                    print(f"📝 Manual test plan created: {manual_plan}")
            except Exception as e:
                debug_error("qa_loop", f"dotnet test failed: {e}")
                print(f"⚠️  dotnet test execution failed: {e}")
                print("Creating manual test plan as fallback...")
                manual_plan = create_manual_test_plan(spec_dir, spec_dir.name)
                print(f"📝 Manual test plan created: {manual_plan}")
        else:
            print("Creating manual test plan...")
            manual_plan = create_manual_test_plan(spec_dir, spec_dir.name)
            print(f"📝 Manual test plan created: {manual_plan}")

        print("\nNote: Automated testing will be limited for this project.")

    # Start validation phase in task logger
    if task_logger:
        task_logger.start_phase(LogPhase.VALIDATION, "Starting QA validation...")

    # Check Linear integration status
    linear_task = None
    if is_linear_enabled():
        linear_task = LinearTaskState.load(spec_dir)
        if linear_task and linear_task.task_id:
            print(f"Linear task: {linear_task.task_id}")
            # Update Linear to "In Review" when QA starts
            await linear_qa_started(spec_dir)
            print("Linear task moved to 'In Review'")

    qa_iteration = get_qa_iteration_count(spec_dir)
    consecutive_errors = 0
    last_error_context = None  # Track error for self-correction feedback
    max_iterations_emitted = False

    while qa_iteration < MAX_QA_ITERATIONS:
        qa_iteration += 1
        iteration_start = time_module.time()

        debug_section("qa_loop", f"QA Iteration {qa_iteration}")
        debug(
            "qa_loop",
            f"Starting iteration {qa_iteration}/{MAX_QA_ITERATIONS}",
            iteration=qa_iteration,
            max_iterations=MAX_QA_ITERATIONS,
        )

        print(f"\n--- QA Iteration {qa_iteration}/{MAX_QA_ITERATIONS} ---")
        emit_phase(
            ExecutionPhase.QA_REVIEW, f"Running QA review iteration {qa_iteration}"
        )
        # Sous-étape de la phase de validation, affichée dans la barre de phase
        # de l'UI (équivalent des « phase N: NOM » de la planification).
        if task_logger:
            task_logger.start_subphase(
                f"QA REVIEW — PASS {qa_iteration}/{MAX_QA_ITERATIONS}",
                phase=LogPhase.VALIDATION,
                print_to_console=False,
            )

        # Run QA reviewer with phase-specific model and thinking budget
        qa_model = get_phase_model(spec_dir, "qa", model)
        qa_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")
        debug(
            "qa_loop",
            "Creating client for QA reviewer session...",
            model=qa_model,
            thinking_budget=qa_thinking_budget,
        )
        try:
            client = create_agent_client(
                project_dir=project_dir,
                spec_dir=spec_dir,
                model=qa_model,
                agent_type="qa_reviewer",
                max_thinking_tokens=qa_thinking_budget,
            )
        except Exception as e:
            debug_error("qa_loop", f"Failed to create QA reviewer client: {e}")
            print(f"\n❌ Failed to create QA reviewer client: {e}")
            task_event_emitter.emit(
                "QA_AGENT_ERROR",
                {
                    "iteration": qa_iteration,
                    "consecutiveErrors": 1,
                },
            )
            return False

        try:
            async with client:
                debug("qa_loop", "Running QA reviewer agent session...")
                status, response = await run_qa_agent_session(
                    client,
                    project_dir,  # Pass project_dir for capability-based tool injection
                    spec_dir,
                    qa_iteration,
                    MAX_QA_ITERATIONS,
                    verbose,
                    previous_error=last_error_context,  # Pass error context for self-correction
                )
        except Exception as e:
            # Prompt-too-long errors are not retryable — the conversation
            # is already too big for the model's context window, so the next
            # attempt would fail identically. Halt the loop and let the UI
            # surface "reset conversation / switch provider" actions.
            from services.rate_limit_shield import handle_prompt_too_long

            if handle_prompt_too_long(e, spec_dir, "qa"):
                debug_error("qa_loop", "QA halted: prompt too long")
                print("\n⛔ QA halted: prompt too long. See task detail.")
                if task_logger:
                    task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=False,
                        message="QA halted: prompt too long for the LLM context window",
                    )
                return False

            # Rate-limit errors must not count toward MAX_CONSECUTIVE_ERRORS or
            # we escalate to human after 3 limit-hits in a row instead of waiting
            # for the quota window to reset (the same iteration would have succeeded).
            if await _handle_rate_limit_in_qa(e, spec_dir, source_spec_dir):
                qa_iteration -= (
                    1  # don't burn an iteration on a paused-then-resumed attempt
                )
                continue
            debug_error("qa_loop", f"QA reviewer session crashed: {e}")
            print(f"\n❌ QA reviewer session error: {e}")
            status = "error"
            response = str(e)

        iteration_duration = time_module.time() - iteration_start
        debug(
            "qa_loop",
            "QA reviewer session completed",
            status=status,
            duration_seconds=f"{iteration_duration:.1f}",
            response_length=len(response),
        )

        # A local model that never emits a real tool call cannot drive agentic
        # QA — it can only hallucinate (e.g. a fabricated "spec file not found"
        # tool result). Retrying with the same model is futile, so halt now with
        # one clear, actionable message instead of burning MAX_CONSECUTIVE_ERRORS
        # passes. (feat/local-llm-agnostic hardening)
        from services.rate_limit_shield import handle_local_model_no_tools

        if handle_local_model_no_tools(client, spec_dir, "qa", qa_model):
            halt_msg = (
                f"QA halted: the local model « {qa_model} » did not call any "
                "tool, so it cannot validate the implementation. Switch the "
                "Validation phase to a more capable model (a larger local "
                "model, or a cloud provider like Anthropic/Claude) and re-run."
            )
            print(f"\n⛔ {halt_msg}")
            task_event_emitter.emit(
                "QA_AGENT_ERROR",
                {
                    "iteration": qa_iteration,
                    "consecutiveErrors": 1,
                    "reason": "local_model_no_tools",
                },
            )
            if task_logger:
                task_logger.end_phase(
                    LogPhase.VALIDATION,
                    success=False,
                    message=halt_msg,
                )
            emit_phase(ExecutionPhase.FAILED, "QA halted: local model can't call tools")
            return False

        if status == "approved":
            # Reset error tracking on success
            consecutive_errors = 0
            last_error_context = None

            # Record successful iteration
            debug_success(
                "qa_loop",
                "QA APPROVED",
                iteration=qa_iteration,
                duration=f"{iteration_duration:.1f}s",
            )
            record_iteration(spec_dir, qa_iteration, "approved", [], iteration_duration)

            # === Architecture Enforcement Gate ===
            # After QA reviewer approves, run architecture validation
            # Deterministic analysis first (fast), AI review second (optional)
            try:
                from architecture.validator import (
                    run_architecture_validation,
                    write_architecture_fix_request,
                )

                debug_section("qa_loop", "Running Architecture Enforcement Gate")
                emit_phase(
                    ExecutionPhase.QA_REVIEW,
                    "Architecture validation",
                )

                arch_passed, arch_report = await run_architecture_validation(
                    project_dir=project_dir,
                    spec_dir=spec_dir,
                    model=qa_model,
                    verbose=verbose,
                )

                # Save architecture report to implementation_plan
                from .criteria import load_implementation_plan, save_implementation_plan

                plan = load_implementation_plan(spec_dir)
                if plan:
                    plan["architecture_enforcement"] = arch_report
                    save_implementation_plan(spec_dir, plan)

                if not arch_passed:
                    # Architecture violations found — treat like a QA rejection
                    arch_violations = arch_report.get("violations", [])
                    debug_warning(
                        "qa_loop",
                        "Architecture violations found",
                        violation_count=len(arch_violations),
                    )
                    print(
                        f"\n🏗️  Architecture enforcement found {len(arch_violations)} violation(s)"
                    )

                    emit_phase(
                        ExecutionPhase.QA_FIXING,
                        "Fixing architecture violations",
                    )
                    task_event_emitter.emit(
                        "QA_FAILED",
                        {
                            "iteration": qa_iteration,
                            "issueCount": len(arch_violations),
                            "issues": [
                                v.get("description", "") for v in arch_violations[:5]
                            ],
                        },
                    )

                    # Write architecture fix request for the fixer agent
                    write_architecture_fix_request(spec_dir, arch_report)

                    # Override status to rejected so the fixer loop handles it
                    status = "rejected"
                    # Record this as a rejection due to architecture
                    arch_issues = [
                        {
                            "title": f"Architecture: {v.get('type', 'violation')}",
                            "description": v.get("description", ""),
                            "type": "architecture_violation",
                        }
                        for v in arch_violations
                    ]
                    record_iteration(
                        spec_dir,
                        qa_iteration,
                        "rejected",
                        arch_issues,
                        iteration_duration,
                    )

                    # Fall through to the rejected handler below
                    # (which will run the fixer)

            except ImportError:
                # architecture package not available — skip gracefully
                debug_warning(
                    "qa_loop",
                    "Architecture enforcement package not available, skipping",
                )
            except Exception as e:
                # Architecture validation should not block the QA pipeline
                debug_warning(
                    "qa_loop",
                    f"Architecture validation error (non-blocking): {e}",
                )

            # === End Architecture Enforcement Gate ===

            # === Coverage Enforcement Gate ===
            # After QA + architecture approve, enforce the minimum test coverage
            # threshold (default 100% for unit + integration, e2e best-effort).
            # Language-agnostic: validates the coverage numbers recorded by the
            # QA reviewer in qa_signoff.coverage. Controlled by
            # WORKPILOT_QA_MIN_COVERAGE (0 = disabled).
            if status == "approved":
                try:
                    from .coverage_gate import (
                        build_coverage_issues,
                        mark_signoff_rejected,
                        run_coverage_gate,
                        write_coverage_fix_request,
                    )

                    coverage_report = run_coverage_gate(spec_dir)

                    if not coverage_report["enabled"]:
                        debug(
                            "qa_loop",
                            "Coverage enforcement gate disabled "
                            "(WORKPILOT_QA_MIN_COVERAGE=0)",
                        )
                    elif coverage_report["warnings"]:
                        for warning in coverage_report["warnings"]:
                            debug_warning("qa_loop", f"Coverage: {warning}")

                    if coverage_report["enabled"] and not coverage_report["passed"]:
                        debug_warning(
                            "qa_loop",
                            "Coverage gate failed",
                            min_coverage=coverage_report["min_coverage"],
                            failures=len(coverage_report["failures"]),
                        )
                        print(
                            "\n📊 Coverage enforcement: "
                            f"{len(coverage_report['failures'])} requirement(s) "
                            f"below {coverage_report['min_coverage']}% threshold"
                        )

                        emit_phase(
                            ExecutionPhase.QA_FIXING,
                            "Fixing insufficient test coverage",
                        )

                        coverage_issues = build_coverage_issues(coverage_report)
                        task_event_emitter.emit(
                            "QA_FAILED",
                            {
                                "iteration": qa_iteration,
                                "issueCount": len(coverage_issues),
                                "issues": [
                                    i["description"] for i in coverage_issues[:5]
                                ],
                            },
                        )

                        # Write a coverage-specific fix request for the fixer agent
                        write_coverage_fix_request(spec_dir, coverage_report)

                        # Make the gate authoritative: persist rejected status so a
                        # later loop invocation cannot short-circuit on a stale
                        # "approved" qa_signoff written by the reviewer.
                        mark_signoff_rejected(spec_dir, coverage_report)

                        # Override status so the fixer loop handles it
                        status = "rejected"
                        record_iteration(
                            spec_dir,
                            qa_iteration,
                            "rejected",
                            coverage_issues,
                            iteration_duration,
                        )
                        # Fall through to the rejected handler below

                except ImportError:
                    debug_warning(
                        "qa_loop",
                        "Coverage gate package not available, skipping",
                    )
                except Exception as e:
                    # Coverage gate must not crash the QA pipeline.
                    debug_warning(
                        "qa_loop",
                        f"Coverage gate error (non-blocking): {e}",
                    )

            # === End Coverage Enforcement Gate ===

            # Only proceed to final approval if architecture passed (status still "approved")
            if status == "approved":
                emit_phase(ExecutionPhase.COMPLETE, "QA validation passed")

                qa_status = get_qa_signoff_status(spec_dir) or {}
                task_event_emitter.emit(
                    "QA_PASSED",
                    {
                        "iteration": qa_iteration,
                        "testsRun": qa_status.get("tests_passed", {}),
                    },
                )

                print("\n" + "=" * 70)
                print("  ✅ QA APPROVED + ARCHITECTURE CLEAN")
                print("=" * 70)
                print("\nAll acceptance criteria verified.")
                print("Architecture validation passed.")
                print("The implementation is production-ready.")
                print("\nNext steps:")
                print("  1. Review the auto-claude/* branch")
                print("  2. Create a PR and merge to main")

                # End validation phase successfully
                if task_logger:
                    task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=True,
                        message="QA validation passed - all criteria met, architecture clean",
                    )

                # Update Linear: QA approved, awaiting human review
                if linear_task and linear_task.task_id:
                    await linear_qa_approved(spec_dir)
                    print("\nLinear: Task marked as QA approved, awaiting human review")

                return True

        elif status == "human_escalation":
            # QA agent could not auto-verify (e.g. sandbox/no CLI) — escalate to human review
            debug(
                "qa_loop",
                "QA requires human verification",
                iteration=qa_iteration,
                duration=f"{iteration_duration:.1f}s",
            )
            qa_status = get_qa_signoff_status(spec_dir) or {}
            notes = qa_status.get("next_steps", [])

            emit_phase(ExecutionPhase.COMPLETE, "QA requires manual verification")
            task_event_emitter.emit(
                "QA_PASSED",
                {
                    "iteration": qa_iteration,
                    "testsRun": qa_status.get("tests_passed", {}),
                    "manualVerificationRequired": True,
                },
            )

            print("\n" + "=" * 70)
            print("  ⚠️  QA REQUIRES MANUAL VERIFICATION")
            print("=" * 70)
            print("\nCode quality passed automated review.")
            print("Manual verification required (e.g. run tests outside sandbox).")
            if notes:
                print("\nNext steps:")
                for step in notes[:5]:
                    print(f"  - {step}")

            if task_logger:
                task_logger.end_phase(
                    LogPhase.VALIDATION,
                    success=True,
                    message="QA validation passed — manual verification required",
                )

            if linear_task and linear_task.task_id:
                await linear_qa_approved(spec_dir)
                print("\nLinear: Task marked as QA approved, awaiting human review")

            return True

        elif status == "rejected":
            # Reset error tracking on valid response (rejected is a valid response)
            consecutive_errors = 0
            last_error_context = None

            debug_warning(
                "qa_loop",
                "QA REJECTED",
                iteration=qa_iteration,
                duration=f"{iteration_duration:.1f}s",
            )
            print(f"\n❌ QA found issues. Iteration {qa_iteration}/{MAX_QA_ITERATIONS}")

            # Get issues from QA report
            qa_status = get_qa_signoff_status(spec_dir)
            current_issues = qa_status.get("issues_found", []) if qa_status else []
            debug(
                "qa_loop",
                "Issues found by QA",
                issue_count=len(current_issues),
                issues=current_issues[:3] if current_issues else [],  # Show first 3
            )
            task_event_emitter.emit(
                "QA_FAILED",
                {
                    "iteration": qa_iteration,
                    "issueCount": len(current_issues),
                    "issues": [
                        issue.get("title", "")
                        for issue in (current_issues[:5] if current_issues else [])
                    ],
                },
            )

            # Check for recurring issues BEFORE recording current iteration
            # This prevents the current issues from matching themselves in history
            history = get_iteration_history(spec_dir)
            has_recurring, recurring_issues = has_recurring_issues(
                current_issues, history
            )

            # Record rejected iteration AFTER checking for recurring issues
            record_iteration(
                spec_dir, qa_iteration, "rejected", current_issues, iteration_duration
            )

            if has_recurring:
                from .report import RECURRING_ISSUE_THRESHOLD

                debug_error(
                    "qa_loop",
                    "Recurring issues detected - escalating to human",
                    recurring_count=len(recurring_issues),
                    threshold=RECURRING_ISSUE_THRESHOLD,
                )
                print(
                    f"\n⚠️  Recurring issues detected ({len(recurring_issues)} issue(s) appeared {RECURRING_ISSUE_THRESHOLD}+ times)"
                )
                print("Escalating to human review due to recurring issues...")

                # Create escalation file
                await escalate_to_human(spec_dir, recurring_issues, qa_iteration)

                # End validation phase
                if task_logger:
                    task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=False,
                        message=f"QA escalated to human after {qa_iteration} iterations due to recurring issues",
                    )

                # Update Linear
                if linear_task and linear_task.task_id:
                    await linear_qa_max_iterations(spec_dir, qa_iteration)
                    print(
                        "\nLinear: Task marked as needing human intervention (recurring issues)"
                    )
                task_event_emitter.emit(
                    "QA_MAX_ITERATIONS",
                    {"iteration": qa_iteration, "maxIterations": MAX_QA_ITERATIONS},
                )
                max_iterations_emitted = True

                return False

            # Record rejection in Linear
            if linear_task and linear_task.task_id:
                issues_count = len(current_issues)
                await linear_qa_rejected(spec_dir, issues_count, qa_iteration)

            if qa_iteration >= MAX_QA_ITERATIONS:
                print("\n⚠️  Maximum QA iterations reached.")
                print("Escalating to human review.")
                if not max_iterations_emitted:
                    task_event_emitter.emit(
                        "QA_MAX_ITERATIONS",
                        {
                            "iteration": qa_iteration,
                            "maxIterations": MAX_QA_ITERATIONS,
                        },
                    )
                    max_iterations_emitted = True
                break

            # Run fixer with phase-specific thinking budget
            fixer_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")
            debug(
                "qa_loop",
                "Starting QA fixer session...",
                model=qa_model,
                thinking_budget=fixer_thinking_budget,
            )
            emit_phase(ExecutionPhase.QA_FIXING, "Fixing QA issues")
            if task_logger:
                task_logger.start_subphase(
                    f"QA FIX — PASS {qa_iteration}",
                    phase=LogPhase.VALIDATION,
                    print_to_console=False,
                )
            task_event_emitter.emit(
                "QA_FIXING_STARTED",
                {"iteration": qa_iteration},
            )
            print("\nRunning QA Fixer Agent...")

            # Garde-fou : le reviewer DOIT avoir écrit QA_FIX_REQUEST.md, mais
            # certaines sessions (modèles trop concis, interruption réseau)
            # produisent qa_report.md sans rejouer le `cat > QA_FIX_REQUEST.md`
            # final. Sans ce fichier le fixer renvoie immédiatement "error" et
            # la boucle échoue avec "Fixer error: QA_FIX_REQUEST.md not found".
            # On le synthétise depuis les issues déjà connues pour permettre
            # au fixer de travailler.
            _ensure_fix_request_file(spec_dir, current_issues, qa_iteration)

            try:
                fix_client = create_agent_client(
                    project_dir=project_dir,
                    spec_dir=spec_dir,
                    model=qa_model,
                    agent_type="qa_fixer",
                    max_thinking_tokens=fixer_thinking_budget,
                )
            except Exception as e:
                debug_error("qa_loop", f"Failed to create QA fixer client: {e}")
                print(f"\n❌ Failed to create QA fixer client: {e}")
                record_iteration(
                    spec_dir,
                    qa_iteration,
                    "error",
                    [{"title": "Fixer client error", "description": str(e)}],
                )
                break

            try:
                async with fix_client:
                    fix_status, fix_response = await run_qa_fixer_session(
                        fix_client, spec_dir, qa_iteration, verbose
                    )
            except Exception as e:
                # Prompt-too-long is permanent — see the reviewer block above.
                from services.rate_limit_shield import handle_prompt_too_long

                if handle_prompt_too_long(e, spec_dir, "qa"):
                    debug_error("qa_loop", "QA fixer halted: prompt too long")
                    print("\n⛔ QA fixer halted: prompt too long. See task detail.")
                    if task_logger:
                        task_logger.end_phase(
                            LogPhase.VALIDATION,
                            success=False,
                            message="QA fixer halted: prompt too long for the LLM context window",
                        )
                    return False

                # Same rate-limit shield as the reviewer above: pause-and-resume
                # instead of counting toward consecutive errors.
                if await _handle_rate_limit_in_qa(e, spec_dir, source_spec_dir):
                    qa_iteration -= 1
                    continue
                debug_error("qa_loop", f"QA fixer session crashed: {e}")
                fix_status = "error"
                fix_response = str(e)

            debug(
                "qa_loop",
                "QA fixer session completed",
                fix_status=fix_status,
                response_length=len(fix_response),
            )

            if fix_status == "error":
                debug_error("qa_loop", f"Fixer error: {fix_response[:200]}")
                print(f"\n❌ Fixer encountered error: {fix_response}")
                record_iteration(
                    spec_dir,
                    qa_iteration,
                    "error",
                    [{"title": "Fixer error", "description": fix_response}],
                )
                break

            debug_success("qa_loop", "Fixes applied, re-running QA validation")
            task_event_emitter.emit(
                "QA_FIXING_COMPLETE",
                {"iteration": qa_iteration},
            )
            print("\n✅ Fixes applied. Re-running QA validation...")

        elif status == "error":
            consecutive_errors += 1
            debug_error(
                "qa_loop",
                f"QA session error: {response[:200]}",
                consecutive_errors=consecutive_errors,
                max_consecutive=MAX_CONSECUTIVE_ERRORS,
            )
            print(f"\n❌ QA error: {response}")
            print(
                f"   Consecutive errors: {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}"
            )
            record_iteration(
                spec_dir,
                qa_iteration,
                "error",
                [{"title": "QA error", "description": response}],
            )

            # Build error context for self-correction in next iteration
            last_error_context = {
                "error_type": "missing_implementation_plan_update",
                "error_message": response,
                "consecutive_errors": consecutive_errors,
                "expected_action": "You MUST update implementation_plan.json with a qa_signoff object containing 'status': 'approved' or 'status': 'rejected'",
                "file_path": str(spec_dir / "implementation_plan.json"),
            }

            # Check if we've hit max consecutive errors
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                debug_error(
                    "qa_loop",
                    f"Max consecutive errors ({MAX_CONSECUTIVE_ERRORS}) reached - escalating to human",
                )
                print(
                    f"\n⚠️  {MAX_CONSECUTIVE_ERRORS} consecutive errors without progress."
                )
                print(
                    "The QA agent is unable to properly update implementation_plan.json."
                )
                print("Escalating to human review.")
                task_event_emitter.emit(
                    "QA_AGENT_ERROR",
                    {
                        "iteration": qa_iteration,
                        "consecutiveErrors": consecutive_errors,
                    },
                )

                # A local model often emits *some* recoverable tool calls (so the
                # fast-halt above doesn't fire) yet never writes a valid
                # qa_signoff — it stalls here after 3 errors. Make the escalation
                # message name the likely cause so the user knows to switch model
                # instead of assuming a code bug.
                fail_message = (
                    f"QA agent failed {MAX_CONSECUTIVE_ERRORS} consecutive times "
                    "- unable to update implementation_plan.json"
                )
                try:
                    provider = client.provider_name()
                except Exception:
                    provider = ""
                if provider in ("ollama", "local", "lmstudio"):
                    fail_message += (
                        f". The local model « {qa_model} » likely can't complete "
                        "tool-based QA — switch the Validation phase to a more "
                        "capable model (a larger local model, or a cloud provider)."
                    )

                # End validation phase as failed
                if task_logger:
                    task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=False,
                        message=fail_message,
                    )
                return False

            print("Retrying with error feedback...")

    # Max iterations reached without approval
    emit_phase(ExecutionPhase.FAILED, "QA validation incomplete")
    if not max_iterations_emitted:
        task_event_emitter.emit(
            "QA_MAX_ITERATIONS",
            {"iteration": qa_iteration, "maxIterations": MAX_QA_ITERATIONS},
        )
    debug_error(
        "qa_loop",
        "QA VALIDATION INCOMPLETE - max iterations reached",
        iterations=qa_iteration,
        max_iterations=MAX_QA_ITERATIONS,
    )
    print("\n" + "=" * 70)
    print("  ⚠️  QA VALIDATION INCOMPLETE")
    print("=" * 70)
    print(f"\nReached maximum iterations ({MAX_QA_ITERATIONS}) without approval.")
    print("\nRemaining issues require human review:")

    # Show iteration summary
    history = get_iteration_history(spec_dir)
    summary = get_recurring_issue_summary(history)
    debug(
        "qa_loop",
        "QA loop final summary",
        total_iterations=len(history),
        total_issues=summary.get("total_issues", 0),
        unique_issues=summary.get("unique_issues", 0),
    )
    if summary["total_issues"] > 0:
        print("\n📊 Iteration Summary:")
        print(f"   Total iterations: {len(history)}")
        print(f"   Total issues found: {summary['total_issues']}")
        print(f"   Unique issues: {summary['unique_issues']}")
        if summary.get("most_common"):
            print("   Most common issues:")
            for issue in summary["most_common"][:3]:
                print(f"     - {issue['title']} ({issue['occurrences']} occurrences)")

    # End validation phase as failed
    if task_logger:
        task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=f"QA validation incomplete after {qa_iteration} iterations",
        )

    # Show the fix request file if it exists
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if fix_request_file.exists():
        print(f"\nSee: {fix_request_file}")

    qa_report_file = spec_dir / "qa_report.md"
    if qa_report_file.exists():
        print(f"See: {qa_report_file}")

    # Update Linear: max iterations reached, needs human intervention
    if linear_task and linear_task.task_id:
        await linear_qa_max_iterations(spec_dir, qa_iteration)
        print("\nLinear: Task marked as needing human intervention")

    print("\nManual intervention required.")
    return False
