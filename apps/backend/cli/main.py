"""
WorkPilot AI CLI - Main Entry Point
===================================

Command-line interface for the WorkPilot AI autonomous coding framework.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from .batch_commands import (
    handle_batch_cleanup_command,
    handle_batch_create_command,
    handle_batch_status_command,
)
from .browser_agent_commands import handle_browser_agent_command
from .build_commands import handle_build_command
from .cost_commands import (
    handle_cost_budget_command,
    handle_cost_compare_command,
    handle_cost_predict_command,
    handle_cost_report_command,
)
from .env_commands import (
    handle_env_capture_command,
    handle_env_reproduce_command,
    handle_env_validate_command,
)
from .followup_commands import handle_followup_command
from .onboarding_commands import handle_onboard_command
from .qa_commands import (
    handle_auto_fix_command,
    handle_qa_command,
    handle_qa_status_command,
    handle_review_status_command,
)
from .self_healing_commands import handle_self_healing_command
from .spec_commands import print_specs_list
from .streaming_commands import (
    handle_list_recordings_command,
    handle_replay_recording_command,
    handle_streaming_server_command,
)
from .utils import (
    DEFAULT_MODEL,
    find_spec,
    get_project_dir,
    print_banner,
    setup_environment,
)
from .workspace_commands import (
    handle_cleanup_worktrees_command,
    handle_create_pr_command,
    handle_discard_command,
    handle_list_worktrees_command,
    handle_merge_command,
    handle_review_command,
)

# Ensure parent directory is in path for imports
_PARENT_DIR = Path(__file__).parent.parent
if str(_PARENT_DIR) not in sys.path:
    sys.path.insert(0, str(_PARENT_DIR))

# Ensure project root is in path for src.connectors imports (e.g. src.connectors.llm_config)
_PROJECT_ROOT = _PARENT_DIR.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="WorkPilot AI Framework - Autonomous multi-session coding agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List all specs
  python workpilot/run.py --list

  # Run a specific spec (by number or full name)
  python workpilot/run.py --spec 001
  python workpilot/run.py --spec 001-initial-app

  # Workspace management (after build completes)
  python workpilot/run.py --spec 001 --merge     # Add build to your project
  python workpilot/run.py --spec 001 --review    # See what was built
  python workpilot/run.py --spec 001 --discard   # Delete build (with confirmation)

  # Advanced options
  python workpilot/run.py --spec 001 --direct       # Skip workspace isolation
  python workpilot/run.py --spec 001 --isolated     # Force workspace isolation

  # Status checks
  python workpilot/run.py --spec 001 --review-status  # Check human review status
  python workpilot/run.py --spec 001 --qa-status      # Check QA validation status

Prerequisites:
  1. Authenticate: Run 'claude' and type '/login'
  2. Create a spec first: claude /spec

Environment Variables:
  CLAUDE_CODE_OAUTH_TOKEN  Your Claude Code OAuth token (auto-detected from Keychain)
                           Or authenticate via: claude → /login
  AUTO_BUILD_MODEL         Override default model (optional)
        """,
    )

    parser.add_argument(
        "--list",
        action="store_true",
        help="List all available specs and their status",
    )

    parser.add_argument(
        "--spec",
        type=str,
        default=None,
        help="Spec to run (e.g., '001' or '001-feature-name')",
    )

    parser.add_argument(
        "--project-dir",
        type=Path,
        default=None,
        help="Project directory (default: current working directory)",
    )

    parser.add_argument(
        "--max-iterations",
        type=int,
        default=None,
        help="Maximum number of agent sessions (default: unlimited)",
    )

    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help=f"Claude model to use (default: {DEFAULT_MODEL})",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output",
    )

    # Workspace options
    workspace_group = parser.add_mutually_exclusive_group()
    workspace_group.add_argument(
        "--isolated",
        action="store_true",
        help="Force building in isolated workspace (safer)",
    )
    workspace_group.add_argument(
        "--direct",
        action="store_true",
        help="Build directly in your project (no isolation)",
    )

    # Build management commands
    build_group = parser.add_mutually_exclusive_group()
    build_group.add_argument(
        "--merge",
        action="store_true",
        help="Merge an existing build into your project",
    )
    build_group.add_argument(
        "--review",
        action="store_true",
        help="Review what an existing build contains",
    )
    build_group.add_argument(
        "--discard",
        action="store_true",
        help="Discard an existing build (requires confirmation)",
    )
    build_group.add_argument(
        "--create-pr",
        action="store_true",
        help="Push branch and create a GitHub Pull Request",
    )
    build_group.add_argument(
        "--analyze-impact",
        action="store_true",
        help=(
            "Preview the PR body + impact analysis WITHOUT pushing or creating "
            "a PR. Outputs JSON {body, rating, features} for the frontend "
            "review modal."
        ),
    )

    # PR options
    parser.add_argument(
        "--pr-target",
        type=str,
        metavar="BRANCH",
        help="With --create-pr: target branch for PR (default: auto-detect)",
    )
    parser.add_argument(
        "--pr-title",
        type=str,
        metavar="TITLE",
        help="With --create-pr: custom PR title (default: generated from spec name)",
    )
    parser.add_argument(
        "--pr-draft",
        action="store_true",
        help="With --create-pr: create as draft PR",
    )
    parser.add_argument(
        "--pr-body-file",
        type=str,
        metavar="PATH",
        help=(
            "With --create-pr: read PR body verbatim from this file. Disables "
            "AI body generation and impact block auto-injection. Useful when "
            "the frontend has already let the user edit them in the review modal."
        ),
    )

    # Merge options
    parser.add_argument(
        "--no-commit",
        action="store_true",
        help="With --merge: stage changes but don't commit (review in IDE first)",
    )
    parser.add_argument(
        "--merge-preview",
        action="store_true",
        help="Preview merge conflicts without actually merging (returns JSON)",
    )

    # QA options
    parser.add_argument(
        "--qa",
        action="store_true",
        help="Run QA validation loop on a completed build",
    )
    parser.add_argument(
        "--qa-status",
        action="store_true",
        help="Show QA validation status for a spec",
    )
    parser.add_argument(
        "--skip-qa",
        action="store_true",
        help="Skip automatic QA validation after build completes",
    )
    parser.add_argument(
        "--auto-fix",
        action="store_true",
        help="Run intelligent auto-fix loop (automatically fix test failures)",
    )
    parser.add_argument(
        "--auto-fix-max-attempts",
        type=int,
        default=None,
        metavar="N",
        help="Maximum auto-fix attempts (default: 5, or AUTO_FIX_MAX_ATTEMPTS env var)",
    )

    # Follow-up options
    parser.add_argument(
        "--followup",
        action="store_true",
        help="Add follow-up tasks to a completed spec (extends existing implementation plan)",
    )

    # Review options
    parser.add_argument(
        "--review-status",
        action="store_true",
        help="Show human review/approval status for a spec",
    )

    # Non-interactive mode (for UI/automation)
    parser.add_argument(
        "--auto-continue",
        action="store_true",
        help="Non-interactive mode: auto-continue existing builds, skip prompts (for UI integration)",
    )

    # Worktree management
    parser.add_argument(
        "--list-worktrees",
        action="store_true",
        help="List all spec worktrees and their status",
    )
    parser.add_argument(
        "--cleanup-worktrees",
        action="store_true",
        help="Remove all spec worktrees and their branches (with confirmation)",
    )

    # Force bypass
    parser.add_argument(
        "--force",
        action="store_true",
        help="Skip approval check and start build anyway (for debugging)",
    )

    # Base branch for worktree creation
    parser.add_argument(
        "--base-branch",
        type=str,
        default=None,
        help="Base branch for creating worktrees (default: auto-detect or current branch)",
    )

    # Batch task management
    parser.add_argument(
        "--batch-create",
        type=str,
        default=None,
        metavar="FILE",
        help="Create multiple tasks from a batch JSON file",
    )
    parser.add_argument(
        "--batch-status",
        action="store_true",
        help="Show status of all specs in the project",
    )
    parser.add_argument(
        "--batch-cleanup",
        action="store_true",
        help="Clean up completed specs (dry-run by default)",
    )
    parser.add_argument(
        "--no-dry-run",
        action="store_true",
        help="Actually delete files in cleanup (not just preview)",
    )

    # Streaming Development Mode
    parser.add_argument(
        "--streaming-server",
        action="store_true",
        help="Start the streaming development WebSocket server",
    )
    parser.add_argument(
        "--streaming-port",
        type=int,
        default=8765,
        help="Port for streaming WebSocket server (default: 8765)",
    )
    parser.add_argument(
        "--list-recordings",
        action="store_true",
        help="List all streaming session recordings",
    )
    parser.add_argument(
        "--replay-recording",
        type=str,
        metavar="FILE",
        help="Replay a streaming session recording",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Playback speed for recording replay (default: 1.0 = real-time)",
    )
    parser.add_argument(
        "--enable-streaming",
        action="store_true",
        help="Enable streaming mode for this build (broadcasts events in real-time)",
    )
    parser.add_argument(
        "--streaming-session-id",
        type=str,
        default=None,
        help="Streaming session ID for live coding (connects to existing session)",
    )

    # Provider management commands
    provider_group = parser.add_argument_group("Provider management")
    provider_group.add_argument(
        "--provider-action",
        type=str,
        choices=["list", "select", "add", "delete", "test"],
        help="Action to perform on LLM providers",
    )
    provider_group.add_argument(
        "--provider",
        type=str,
        help="Name of the provider",
    )
    provider_group.add_argument(
        "--config",
        type=str,
        help="JSON config for adding a new provider",
    )

    # Cost Intelligence Engine commands
    cost_group = parser.add_argument_group("Cost Intelligence")
    cost_group.add_argument(
        "--cost-report",
        nargs="?",
        const="monthly",
        metavar="PERIOD",
        help="Show cost report (period: weekly or monthly, default: monthly)",
    )
    cost_group.add_argument(
        "--cost-compare",
        action="store_true",
        help="Compare costs to competitors (Cursor, Windsurf, Copilot, etc.)",
    )
    cost_group.add_argument(
        "--cost-budget",
        type=float,
        nargs="?",
        const=None,
        default=-1,
        metavar="AMOUNT",
        help="Set budget limit in USD (no value = show current budget)",
    )
    # Diagnostics
    parser.add_argument(
        "--doctor",
        action="store_true",
        help="Print a health report for optional dependencies and environment",
    )

    onboarding_group = parser.add_argument_group("Onboarding")
    onboarding_group.add_argument(
        "--onboard",
        action="store_true",
        help="Generate a newcomer onboarding guide for the current project",
    )
    onboarding_group.add_argument(
        "--onboard-output",
        type=str,
        default=None,
        metavar="PATH",
        help="Write the onboarding guide to PATH instead of stdout",
    )

    cost_group.add_argument(
        "--cost-predict",
        type=str,
        metavar="SPEC_ID",
        help="Predict cost of running a spec (e.g. '001-feature-name') before launch",
    )
    cost_group.add_argument(
        "--predict-model",
        type=str,
        default=None,
        metavar="MODEL",
        help="Model to use for --cost-predict (default: claude-sonnet-4-6)",
    )
    cost_group.add_argument(
        "--predict-provider",
        type=str,
        default="anthropic",
        metavar="PROVIDER",
        help="Provider to use for --cost-predict (default: anthropic)",
    )
    cost_group.add_argument(
        "--budget-period",
        type=str,
        default="monthly",
        choices=["total", "monthly", "weekly"],
        help="Budget period (default: monthly)",
    )

    # Environment Cloner commands
    env_group = parser.add_argument_group("Environment Cloner")
    env_group.add_argument(
        "--env-capture",
        action="store_true",
        help="Capture environment configuration (Docker Compose, .env files, running containers)",
    )
    env_group.add_argument(
        "--env-reproduce",
        action="store_true",
        help="Reproduce captured environment via Docker Compose",
    )
    env_group.add_argument(
        "--env-validate",
        action="store_true",
        help="Validate that cloned environment is running correctly",
    )
    env_group.add_argument(
        "--env-source",
        type=str,
        default="auto",
        choices=["auto", "compose", "containers"],
        help="Environment capture source (default: auto)",
    )

    # Self-Healing Codebase + Incident Responder
    healing_group = parser.add_argument_group("Self-Healing Codebase")
    healing_group.add_argument(
        "--self-heal",
        type=str,
        nargs="?",
        const="dashboard",
        metavar="MODE",
        help="Self-healing mode: cicd, proactive, dashboard (default: dashboard)",
    )

    # Browser Agent
    browser_group = parser.add_argument_group("Browser Agent")
    browser_group.add_argument(
        "--browser-agent",
        type=str,
        nargs="?",
        const="dashboard",
        metavar="MODE",
        help="Browser agent mode: screenshot, compare, tests, dashboard (default: dashboard)",
    )
    browser_group.add_argument(
        "--browser-url",
        type=str,
        help="URL to navigate/screenshot (for browser-agent screenshot/compare)",
    )
    browser_group.add_argument(
        "--browser-name",
        type=str,
        help="Screenshot/baseline name (for browser-agent screenshot/compare)",
    )

    return parser.parse_args()


def handle_provider_command(args):
    from src.connectors.llm_config import (
        delete_provider_config,
        get_active_provider,
        list_provider_configs,
        load_provider_config,
        save_provider_config,
        set_active_provider,
    )
    from src.connectors.llm_discovery import discover_llm_providers

    if args.action == "list":
        active = get_active_provider()
        print("Providers disponibles:")
        for cls in discover_llm_providers():
            name = cls().get_name()
            marker = " (actif)" if name == active else ""
            print(f"- {name}{marker}")
        print("Configurations enregistrées:")
        for name in list_provider_configs():
            marker = " (actif)" if name == active else ""
            print(f"- {name}{marker}")
    elif args.action == "select":
        set_active_provider(args.provider)
        print(f"Provider sélectionné et persisté: {args.provider}")
    elif args.action == "add":
        config = json.loads(args.config)
        save_provider_config(args.provider, config)
        print(f"Config enregistrée pour {args.provider}")
    elif args.action == "delete":
        delete_provider_config(args.provider)
        print(f"Config supprimée pour {args.provider}")
    elif args.action == "test":
        config = load_provider_config(args.provider)
        if not config:
            print("Aucune config trouvée pour ce provider.")
            return
        for cls in discover_llm_providers():
            if cls().get_name() == args.provider:
                try:
                    instance = cls(**config)
                    instance.connect()
                    if not instance.validate():
                        print("Validation échouée.")
                        return
                    print("Provider OK.")
                except Exception as e:
                    print(f"Erreur: {e}")
                return
        print("Provider non trouvé.")


def handle_doctor_command() -> None:
    """Print a health report for optional dependencies and environment.

    Designed to be a one-stop "why isn't X working" diagnostic that users
    can paste into bug reports. Each probe is isolated so a single failing
    import does not abort the whole report.
    """
    import importlib
    import platform

    print("WorkPilot AI — doctor")
    print("=" * 60)
    print(
        f"Platform   : {platform.system()} {platform.release()} ({platform.machine()})"
    )
    print(f"Python     : {platform.python_version()}")
    print()

    optional_deps = [
        ("secretstorage", "Linux Secret Service (credential storage)"),
        ("graphiti_core", "Graph-based memory (Graphiti)"),
        ("google.generativeai", "Google Gemini provider"),
        ("openai", "OpenAI / Azure OpenAI provider"),
        ("anthropic", "Anthropic SDK"),
        ("httpx", "HTTP client (required)"),
        ("pydantic", "Validation (required)"),
    ]
    print("Optional dependencies")
    print("-" * 60)
    for module_name, description in optional_deps:
        try:
            importlib.import_module(module_name)
            status = "OK"
        except ImportError:
            status = "MISSING"
        print(f"  [{status:>7}] {module_name:<24} — {description}")

    print()
    print("Environment variables")
    print("-" * 60)
    env_vars = [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "WORKPILOT_AZURE_DEVOPS_ALLOW_MOCK",
    ]
    for var in env_vars:
        present = "set" if os.environ.get(var) else "not set"
        print(f"  {var:<38} {present}")


def main() -> None:
    """Main CLI entry point."""
    # Set up environment first
    setup_environment()

    # Initialize Sentry early to capture any startup errors
    from core.sentry import capture_exception, init_sentry

    init_sentry(component="cli")

    try:
        _run_cli()
    except KeyboardInterrupt:
        # Clean exit on Ctrl+C
        sys.exit(130)
    except Exception as e:
        # Capture unexpected errors to Sentry
        capture_exception(e)
        print(f"\nUnexpected error: {e}")
        sys.exit(1)


def _run_cli() -> None:
    """Run the CLI logic (extracted for error handling)."""
    # Import here to avoid import errors during startup
    from core.sentry import set_context

    # Parse arguments
    args = parse_args()

    # Import debug functions after environment setup
    from debug import debug, debug_error, debug_section, debug_success

    debug_section("run.py", "Starting Auto-Build Framework")
    debug("run.py", "Arguments parsed", args=vars(args))

    # Determine project directory
    project_dir = get_project_dir(args.project_dir)
    debug("run.py", f"Using project directory: {project_dir}")

    # Get model from CLI arg or env var (None if not explicitly set)
    # This allows get_phase_model() to fall back to task_metadata.json
    model = args.model or os.environ.get("AUTO_BUILD_MODEL")

    # Handle --doctor command (short-circuits everything else)
    if args.doctor:
        handle_doctor_command()
        return

    # Handle --list command
    if args.list:
        print_banner()
        print_specs_list(project_dir)
        return

    # Handle streaming commands
    if args.streaming_server:
        handle_streaming_server_command(args)
        return

    if args.list_recordings:
        handle_list_recordings_command(args)
        return

    if args.replay_recording:
        handle_replay_recording_command(args)
        return

    # Handle --list-worktrees command
    if args.list_worktrees:
        handle_list_worktrees_command(project_dir)
        return

    # Handle --cleanup-worktrees command
    if args.cleanup_worktrees:
        handle_cleanup_worktrees_command(project_dir)
        return

    # Handle batch commands
    if args.batch_create:
        handle_batch_create_command(args.batch_create, str(project_dir))
        return

    if args.batch_status:
        handle_batch_status_command(str(project_dir))
        return

    if args.batch_cleanup:
        handle_batch_cleanup_command(str(project_dir), dry_run=not args.no_dry_run)
        return

    # Handle Cost Intelligence commands
    if args.cost_report is not None:
        handle_cost_report_command(project_dir, period=args.cost_report)
        return

    if args.cost_compare:
        handle_cost_compare_command(project_dir)
        return

    if args.cost_budget != -1:
        handle_cost_budget_command(
            project_dir, limit=args.cost_budget, period=args.budget_period
        )
        return

    if args.cost_predict:
        handle_cost_predict_command(
            project_dir,
            spec_id=args.cost_predict,
            model=args.predict_model,
            provider=args.predict_provider,
        )
        return

    if args.onboard:
        out_path = Path(args.onboard_output) if args.onboard_output else None
        handle_onboard_command(project_dir, output=out_path)
        return

    # Handle Environment Cloner commands
    if args.env_capture:
        handle_env_capture_command(project_dir, source=args.env_source)
        return

    if args.env_reproduce:
        handle_env_reproduce_command(project_dir)
        return

    if args.env_validate:
        handle_env_validate_command(project_dir)
        return

    # Handle Self-Healing commands
    if args.self_heal is not None:
        handle_self_healing_command(
            project_dir, mode=args.self_heal, verbose=args.verbose
        )
        return

    # Handle Browser Agent commands
    if args.browser_agent is not None:
        handle_browser_agent_command(
            project_dir,
            mode=args.browser_agent,
            url=getattr(args, "browser_url", None),
            name=getattr(args, "browser_name", None),
            verbose=args.verbose,
        )
        return

    # Require --spec if not listing
    if not args.spec:
        print_banner()
        print("\nError: --spec is required")
        print("\nUsage:")
        print("  python workpilot/run.py --list           # See all specs")
        print("  python workpilot/run.py --spec 001       # Run a spec")
        print("\nCreate a new spec with:")
        print("  claude /spec")
        sys.exit(1)

    # Find the spec
    debug("run.py", "Finding spec", spec_identifier=args.spec)
    spec_dir = find_spec(project_dir, args.spec)
    if not spec_dir:
        debug_error("run.py", "Spec not found", spec=args.spec)
        print_banner()
        print(f"\nError: Spec '{args.spec}' not found")
        print("\nAvailable specs:")
        print_specs_list(project_dir)
        sys.exit(1)

    debug_success("run.py", "Spec found", spec_dir=str(spec_dir))

    # Set Sentry context for error tracking
    set_context(
        "spec",
        {
            "name": spec_dir.name,
            "project": str(project_dir),
        },
    )

    # Handle build management commands
    if args.merge_preview:
        from cli.workspace_commands import handle_merge_preview_command

        result = handle_merge_preview_command(
            project_dir, spec_dir.name, base_branch=args.base_branch
        )
        # Output as JSON for the UI to parse
        import json

        print(json.dumps(result))
        return

    if args.merge:
        success = handle_merge_command(
            project_dir,
            spec_dir.name,
            no_commit=args.no_commit,
            base_branch=args.base_branch,
        )
        if not success:
            sys.exit(1)
        return

    if args.review:
        handle_review_command(project_dir, spec_dir.name)
        return

    if args.discard:
        handle_discard_command(project_dir, spec_dir.name)
        return

    if args.analyze_impact:
        from .workspace_commands import handle_analyze_impact_command

        result = handle_analyze_impact_command(
            project_dir=project_dir,
            spec_name=spec_dir.name,
            target_branch=args.pr_target,
        )
        if not result.get("success", True):
            sys.exit(1)
        return

    if args.create_pr:
        # Optional body override from a file (used by the frontend review modal)
        body_override: str | None = None
        if args.pr_body_file:
            body_path = Path(args.pr_body_file)
            try:
                body_override = body_path.read_text(encoding="utf-8")
            except OSError as e:
                print(
                    json.dumps(
                        {
                            "success": False,
                            "error": f"Could not read --pr-body-file: {e}",
                        }
                    )
                )
                sys.exit(1)

        # Pass args.pr_target directly - WorktreeManager._detect_base_branch
        # handles base branch detection internally when target_branch is None
        result = handle_create_pr_command(
            project_dir=project_dir,
            spec_name=spec_dir.name,
            target_branch=args.pr_target,
            title=args.pr_title,
            draft=args.pr_draft,
            body=body_override,
        )
        # JSON output is already printed by handle_create_pr_command
        if not result.get("success"):
            sys.exit(1)
        return

    # Handle QA commands
    if args.qa_status:
        handle_qa_status_command(spec_dir)
        return

    if args.review_status:
        handle_review_status_command(spec_dir)
        return

    if args.qa:
        handle_qa_command(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            verbose=args.verbose,
        )
        return

    if args.auto_fix:
        handle_auto_fix_command(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            max_attempts=args.auto_fix_max_attempts,
            verbose=args.verbose,
        )
        return

    # Handle --followup command
    if args.followup:
        handle_followup_command(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            verbose=args.verbose,
        )
        return

    # Normal build flow
    handle_build_command(
        project_dir=project_dir,
        spec_dir=spec_dir,
        model=model,
        max_iterations=args.max_iterations,
        verbose=args.verbose,
        force_isolated=args.isolated,
        force_direct=args.direct,
        auto_continue=args.auto_continue,
        skip_qa=args.skip_qa,
        force_bypass_approval=args.force,
        base_branch=args.base_branch,
        enable_streaming=args.enable_streaming,
        streaming_session_id=args.streaming_session_id,
    )


if __name__ == "__main__":
    main()
