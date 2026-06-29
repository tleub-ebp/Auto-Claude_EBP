"""
QA Acceptance Criteria Handling
================================

Manages acceptance criteria validation and status tracking.
"""

import json
import re
from datetime import datetime
from pathlib import Path

from progress import is_build_complete

# =============================================================================
# IMPLEMENTATION PLAN I/O
# =============================================================================


def load_implementation_plan(spec_dir: Path) -> dict | None:
    """Load the implementation plan JSON."""
    plan_file = spec_dir / "implementation_plan.json"
    if not plan_file.exists():
        return None
    try:
        with open(plan_file, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def save_implementation_plan(spec_dir: Path, plan: dict) -> bool:
    """Save the implementation plan JSON."""
    plan_file = spec_dir / "implementation_plan.json"
    try:
        with open(plan_file, "w", encoding="utf-8") as f:
            json.dump(plan, f, indent=2)
        return True
    except OSError:
        return False


def plan_snapshot_slug(provider: str, model: str) -> str:
    """Filename-safe ``<provider>-<model>`` slug for a per-LLM plan snapshot."""
    slug = re.sub(r"[^a-z0-9]+", "-", f"{provider}_{model}".lower()).strip("-")
    return slug or "unknown"


def snapshot_plan_for_model(
    spec_dir: Path,
    provider: str,
    model: str,
    *,
    valid: bool,
    dest_dir: Path | None = None,
) -> Path | None:
    """Archive the current ``implementation_plan.json`` under ``plans/<slug>.json``
    so plans produced by different LLMs can be compared side by side.

    Reads the plan from ``spec_dir`` (the live run dir) but writes the snapshot
    under ``<dest_dir or spec_dir>/plans/``. In worktree mode pass
    ``dest_dir=source_spec_dir`` so snapshots land in the MAIN project spec dir
    and PERSIST across worktree removal and task reset (``plans/`` is not a reset
    artifact) — otherwise they'd vanish with the worktree.

    One file per (provider, model) — the latest planning run for that LLM wins.
    Each snapshot wraps the plan with its provenance (provider, model, capture
    time, whether it passed validation), so a UI can list/diff them.

    Best-effort: returns the path written, or None when there is no parseable
    plan to snapshot. Never raises.
    """
    plan = load_implementation_plan(spec_dir)
    if plan is None:
        return None
    try:
        plans_dir = (dest_dir or spec_dir) / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        out = plans_dir / f"{plan_snapshot_slug(provider, model)}.json"
        snapshot = {
            "provider": provider,
            "model": model,
            "captured_at": datetime.now().isoformat(),
            "valid": valid,
            "plan": plan,
        }
        with open(out, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2)
        return out
    except OSError:
        return None


# =============================================================================
# QA SIGN-OFF STATUS
# =============================================================================


def get_qa_signoff_status(spec_dir: Path) -> dict | None:
    """Get the current QA sign-off status from implementation plan."""
    plan = load_implementation_plan(spec_dir)
    if not plan:
        return None
    return plan.get("qa_signoff")


def is_qa_approved(spec_dir: Path) -> bool:
    """Check if QA has approved the build."""
    status = get_qa_signoff_status(spec_dir)
    if not status:
        return False
    return status.get("status") == "approved"


def is_qa_rejected(spec_dir: Path) -> bool:
    """Check if QA has rejected the build (needs fixes)."""
    status = get_qa_signoff_status(spec_dir)
    if not status:
        return False
    return status.get("status") == "rejected"


def is_fixes_applied(spec_dir: Path) -> bool:
    """Check if fixes have been applied and ready for re-validation."""
    status = get_qa_signoff_status(spec_dir)
    if not status:
        return False
    return status.get("status") == "fixes_applied" and status.get(
        "ready_for_qa_revalidation", False
    )


def get_qa_iteration_count(spec_dir: Path) -> int:
    """Get the number of QA iterations so far."""
    status = get_qa_signoff_status(spec_dir)
    if not status:
        return 0
    return status.get("qa_session", 0)


# =============================================================================
# ARCHITECTURE ENFORCEMENT STATUS
# =============================================================================


def get_architecture_status(spec_dir: Path) -> dict | None:
    """Get the architecture enforcement status from implementation plan."""
    plan = load_implementation_plan(spec_dir)
    if not plan:
        return None
    return plan.get("architecture_enforcement")


def is_architecture_approved(spec_dir: Path) -> bool:
    """
    Check if architecture validation has passed.

    Returns True if:
    - No architecture enforcement was configured (no rules = pass)
    - Architecture validation explicitly approved
    """
    status = get_architecture_status(spec_dir)
    if not status:
        return True  # No architecture enforcement = pass by default
    return status.get("status") == "approved"


# =============================================================================
# QA READINESS CHECKS
# =============================================================================


def should_run_qa(spec_dir: Path) -> bool:
    """
    Determine if QA validation should run.

    QA should run when:
    - All subtasks are completed
    - QA has not yet approved
    """
    if not is_build_complete(spec_dir):
        return False

    if is_qa_approved(spec_dir):
        return False

    return True


def should_run_fixes(spec_dir: Path) -> bool:
    """
    Determine if QA fixes should run.

    Fixes should run when:
    - QA has rejected the build
    - Max iterations not reached
    """
    from .loop import MAX_QA_ITERATIONS

    if not is_qa_rejected(spec_dir):
        return False

    iterations = get_qa_iteration_count(spec_dir)
    if iterations >= MAX_QA_ITERATIONS:
        return False

    return True


# =============================================================================
# STATUS DISPLAY
# =============================================================================


def print_qa_status(spec_dir: Path) -> None:
    """Print the current QA status."""
    from .report import get_iteration_history, get_recurring_issue_summary

    status = get_qa_signoff_status(spec_dir)

    if not status:
        print("QA Status: Not started")
        return

    qa_status = status.get("status", "unknown")
    qa_session = status.get("qa_session", 0)
    timestamp = status.get("timestamp", "unknown")

    print(f"QA Status: {qa_status.upper()}")
    print(f"QA Sessions: {qa_session}")
    print(f"Last Updated: {timestamp}")

    if qa_status == "approved":
        tests = status.get("tests_passed", {})
        print(
            f"Tests: Unit {tests.get('unit', '?')}, Integration {tests.get('integration', '?')}, E2E {tests.get('e2e', '?')}"
        )
    elif qa_status == "rejected":
        issues = status.get("issues_found", [])
        print(f"Issues Found: {len(issues)}")
        for issue in issues[:3]:  # Show first 3
            print(
                f"  - {issue.get('title', 'Unknown')}: {issue.get('type', 'unknown')}"
            )
        if len(issues) > 3:
            print(f"  ... and {len(issues) - 3} more")

    # Show iteration history summary
    history = get_iteration_history(spec_dir)
    if history:
        summary = get_recurring_issue_summary(history)
        print("\nIteration History:")
        print(f"  Total iterations: {len(history)}")
        print(f"  Approved: {summary.get('iterations_approved', 0)}")
        print(f"  Rejected: {summary.get('iterations_rejected', 0)}")
        if summary.get("most_common"):
            print("  Most common issues:")
            for issue in summary["most_common"][:3]:
                print(f"    - {issue['title']} ({issue['occurrences']} occurrences)")
