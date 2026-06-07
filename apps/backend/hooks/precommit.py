"""Pre-commit hook implementations for WorkPilot AI.

Each check is a pure function returning an exit code so it can be unit-tested
without spawning a subprocess. The CLI wrapper (``main``) routes the
``--mode`` argument to the appropriate function.

Design rules:
* No network. No SDK. No LLM call. These run on every commit — they MUST be
  fast and deterministic.
* Missing baseline / config = exit 0 (so a fresh clone doesn't break commits).
  Configuration errors that the user CAN fix = exit 2 with a message.
* Print actionable output to stderr. Print a one-line summary to stdout for
  hook-manager UIs that capture it.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TextIO

logger = logging.getLogger(__name__)

HOOK_EXIT_OK = 0
HOOK_EXIT_VIOLATION = 1
HOOK_EXIT_INFRASTRUCTURE_ERROR = 2


# ---------------------------------------------------------------------------
# License check


def run_license_check(
    project_dir: Path,
    *,
    policy: str = "permissive_only",
    stderr: TextIO | None = None,
) -> int:
    """Fail if the project's deps violate the configured license policy.

    Reads policy presets from ``license_governance.LicensePolicy``. Skips
    silently (exit 0) if the module is missing — auditing must never
    block a commit on a stripped-down environment.
    """
    err = stderr or sys.stderr
    try:
        from license_governance import LicensePolicy, LicenseScanner
    except ImportError:
        print(
            "[license-check] license_governance not available — skipping",
            file=err,
        )
        return HOOK_EXIT_OK

    presets = {
        "permissive_only": LicensePolicy.permissive_only,
        "open_source_friendly": LicensePolicy.open_source_friendly,
        "saas_safe": LicensePolicy.saas_safe,
    }
    if policy not in presets:
        print(
            f"[license-check] unknown policy {policy!r}; valid: {sorted(presets)}",
            file=err,
        )
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    try:
        scanner = LicenseScanner(project_dir=project_dir, policy=presets[policy]())
        report = scanner.scan()
    except Exception as exc:  # noqa: BLE001
        print(f"[license-check] scanner error: {exc}", file=err)
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    if report.passed:
        print(
            f"[license-check] OK — {len(report.dependencies)} deps "
            f"under policy {policy!r}"
        )
        return HOOK_EXIT_OK

    print(
        f"[license-check] BLOCKED — {len(report.conflicts)} conflict(s) "
        f"under policy {policy!r}:",
        file=err,
    )
    for c in report.conflicts:
        print(
            f"  - {c.dependency.name}@{c.dependency.version} "
            f"({c.dependency.ecosystem}): {c.reason}",
            file=err,
        )
    print("  Run `wp-precommit license-check --policy <other>` to relax.", file=err)
    return HOOK_EXIT_VIOLATION


# ---------------------------------------------------------------------------
# Architecture drift check


def run_drift_check(
    project_dir: Path,
    *,
    current_report: Path | None = None,
    block_on: str = "high",
    stderr: TextIO | None = None,
) -> int:
    """Fail when drift severity ≥ ``block_on`` (default: HIGH/CRITICAL).

    Requires:
      * ``current_report`` — JSON architecture report for the working copy.
      * Baseline at ``<project>/.workpilot/architecture/baseline.json``.

    Both missing → exit 0 (no baseline established yet, can't decide).
    """
    err = stderr or sys.stderr
    try:
        from architecture_drift import DriftDetector, DriftSeverity
    except ImportError:
        print("[drift-check] architecture_drift not available — skipping", file=err)
        return HOOK_EXIT_OK

    detector = DriftDetector(project_dir=project_dir)
    baseline_path = detector.baseline_path()
    if not baseline_path.exists():
        print(
            f"[drift-check] no baseline at {baseline_path} — skipping "
            "(run the architecture analyser to establish one)",
        )
        return HOOK_EXIT_OK

    if current_report is None or not current_report.exists():
        print(
            "[drift-check] no current architecture report supplied "
            "(--current-report PATH) — skipping",
        )
        return HOOK_EXIT_OK

    try:
        from analysis.architecture_analyzer import ArchitectureReport
    except ImportError:
        # Fallback: build a minimal current report from the JSON shape.
        try:
            raw = json.loads(current_report.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[drift-check] could not read current report: {exc}", file=err)
            return HOOK_EXIT_INFRASTRUCTURE_ERROR
        # If the analyser is gone, we cannot validate the schema; bail out.
        print(
            "[drift-check] analysis.architecture_analyzer not importable — "
            "cannot run drift comparison",
            file=err,
        )
        return HOOK_EXIT_OK
    else:
        try:
            raw = json.loads(current_report.read_text(encoding="utf-8"))
            report_obj = ArchitectureReport.from_dict(raw)
        except Exception as exc:  # noqa: BLE001
            print(f"[drift-check] could not parse current report: {exc}", file=err)
            return HOOK_EXIT_INFRASTRUCTURE_ERROR

    drift = detector.compare(report_obj)

    blocking_levels = _drift_levels_at_or_above(block_on, DriftSeverity)
    if drift.severity in blocking_levels:
        print(
            f"[drift-check] BLOCKED — severity={drift.severity.value} "
            f"(threshold={block_on}, new_violations={len(drift.new_violations)})",
            file=err,
        )
        for v in drift.new_violations[:10]:
            print(f"  - {v.violation.type}: {v.violation.description}", file=err)
        if len(drift.new_violations) > 10:
            print(f"  ... and {len(drift.new_violations) - 10} more", file=err)
        return HOOK_EXIT_VIOLATION

    print(
        f"[drift-check] OK — severity={drift.severity.value} "
        f"(new={len(drift.new_violations)}, "
        f"resolved={len(drift.resolved_violations)})"
    )
    return HOOK_EXIT_OK


def _drift_levels_at_or_above(threshold: str, severity_enum) -> set:
    """Return the set of severity values ≥ threshold (ordered LOW<MED<HI<CRIT)."""
    order = ["clean", "low", "medium", "high", "critical"]
    threshold = (threshold or "high").lower()
    if threshold not in order:
        threshold = "high"
    cutoff = order.index(threshold)
    blocking = set()
    for member in severity_enum:
        if member.value in order and order.index(member.value) >= cutoff:
            blocking.add(member)
    return blocking


# ---------------------------------------------------------------------------
# Generational tests regression check


def run_gen_tests_check(
    project_dir: Path,
    *,
    junit_xml: Path | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Fail if the supplied JUnit XML shows regressions vs the latest generation.

    Requires:
      * ``junit_xml`` — path to a JUnit XML produced by the test runner.
      * At least one prior generation in
        ``<project>/.workpilot/generational-tests/``.

    Both missing → exit 0 (nothing to compare).
    """
    err = stderr or sys.stderr
    try:
        from generational_tests import GenerationalArchive, parse_junit_xml
    except ImportError:
        print("[gen-tests-check] generational_tests not available — skipping", file=err)
        return HOOK_EXIT_OK

    if junit_xml is None or not junit_xml.exists():
        print(
            "[gen-tests-check] no JUnit XML supplied (--junit-xml PATH) — skipping",
        )
        return HOOK_EXIT_OK

    try:
        outcomes = parse_junit_xml(junit_xml)
    except Exception as exc:  # noqa: BLE001
        print(f"[gen-tests-check] could not parse {junit_xml}: {exc}", file=err)
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    archive = GenerationalArchive(project_dir=project_dir)
    try:
        labels = archive.list_generations()
    except Exception as exc:  # noqa: BLE001
        print(
            f"[gen-tests-check] could not read archive: {exc} — skipping",
            file=err,
        )
        return HOOK_EXIT_OK

    if not labels:
        print("[gen-tests-check] no prior generation — skipping")
        return HOOK_EXIT_OK

    # Sorted alphabetically — labels typically embed dates so this gives the
    # latest as the last entry. Caller can pin a specific label later if
    # needed; the hook intentionally has no flag for it (keep it simple).
    baseline_label = labels[-1]

    try:
        regression = archive.compare(baseline_label, current_outcomes=outcomes)
    except Exception as exc:  # noqa: BLE001
        print(f"[gen-tests-check] compare failed: {exc}", file=err)
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    if not regression.regressions:
        print(
            f"[gen-tests-check] OK — {len(outcomes)} test outcomes vs "
            f"generation {baseline_label}"
        )
        return HOOK_EXIT_OK

    print(
        f"[gen-tests-check] BLOCKED — {len(regression.regressions)} regression(s) "
        f"vs generation {baseline_label}:",
        file=err,
    )
    for r in regression.regressions[:10]:
        print(
            f"  - {r.test_id}: {r.baseline_status} → {r.current_status}",
            file=err,
        )
    if len(regression.regressions) > 10:
        print(f"  ... and {len(regression.regressions) - 10} more", file=err)
    return HOOK_EXIT_VIOLATION


# ---------------------------------------------------------------------------
# Attribution auto-update


def _git_stage(file_path: Path, *, stderr: TextIO) -> bool:
    """Best-effort `git add <file>`. Returns True on success, False otherwise.

    Silent no-op when git isn't on PATH or when the project isn't a repo.
    The hook still exits OK in those cases — generating the file already
    delivered the value; staging is a convenience.
    """
    git = shutil.which("git")
    if git is None:
        return False
    try:
        result = subprocess.run(
            [git, "-C", str(file_path.parent), "add", "--", file_path.name],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[attribution-update] git add failed: {exc}", file=stderr)
        return False
    if result.returncode != 0:
        # Most common cause: not a git repo. Don't shout about it.
        return False
    return True


def run_attribution_update(
    project_dir: Path,
    *,
    project_name: str | None = None,
    include_transitive: bool = True,
    include_unknown: bool = True,
    stage: bool = True,
    stderr: TextIO | None = None,
) -> int:
    """Generate / update ``ATTRIBUTION.md`` at the project root.

    Always exits 0 unless the underlying scanner explodes — auto-attribution
    should never block a commit on a manifest hiccup. When ``stage`` is true
    and ``git`` is on PATH, the freshly-written file is also staged so the
    contributor doesn't forget it.
    """
    err = stderr or sys.stderr
    try:
        from license_governance import (
            ATTRIBUTION_FILENAME,
            AttributionOptions,
            LicenseScanner,
            write_attribution,
        )
    except ImportError:
        print(
            "[attribution-update] license_governance not available — skipping",
            file=err,
        )
        return HOOK_EXIT_OK

    try:
        scanner = LicenseScanner(project_dir=project_dir)
        report = scanner.scan()
    except Exception as exc:  # noqa: BLE001
        print(f"[attribution-update] scanner error: {exc}", file=err)
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    if not report.dependencies:
        print(
            "[attribution-update] no dependencies discovered — skipping "
            "(no ATTRIBUTION.md needed)"
        )
        return HOOK_EXIT_OK

    opts = AttributionOptions(
        project_name=project_name or project_dir.name,
        include_transitive=include_transitive,
        include_unknown=include_unknown,
    )
    try:
        written = write_attribution(report, project_dir, opts)
    except Exception as exc:  # noqa: BLE001
        print(f"[attribution-update] write failed: {exc}", file=err)
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    staged = _git_stage(written, stderr=err) if stage else False
    print(
        f"[attribution-update] OK — {ATTRIBUTION_FILENAME} updated "
        f"({len(report.dependencies)} deps)" + (" + staged" if staged else "")
    )
    return HOOK_EXIT_OK


# ---------------------------------------------------------------------------
# CLI entrypoint


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wp-precommit",
        description=(
            "WorkPilot AI pre-commit checks "
            "(license / drift / gen-tests / attribution)."
        ),
    )
    p.add_argument(
        "mode",
        choices=(
            "license-check",
            "drift-check",
            "gen-tests-check",
            "attribution-update",
        ),
        help="Which action to run.",
    )
    p.add_argument(
        "--project-dir",
        default=".",
        help="Project root (defaults to current working directory).",
    )
    p.add_argument(
        "--policy",
        default="permissive_only",
        help="License policy preset (license-check only).",
    )
    p.add_argument(
        "--current-report",
        default=None,
        help="Path to current architecture report JSON (drift-check only).",
    )
    p.add_argument(
        "--block-on",
        default="high",
        choices=("low", "medium", "high", "critical"),
        help="Minimum drift severity that blocks (drift-check only).",
    )
    p.add_argument(
        "--junit-xml",
        default=None,
        help="Path to JUnit XML (gen-tests-check only).",
    )
    p.add_argument(
        "--project-name",
        default=None,
        help="Display name in the generated header (attribution-update only).",
    )
    p.add_argument(
        "--no-transitive",
        action="store_true",
        help="Omit transitive deps from the attribution (attribution-update only).",
    )
    p.add_argument(
        "--no-unknown",
        action="store_true",
        help="Omit deps with no declared license (attribution-update only).",
    )
    p.add_argument(
        "--no-stage",
        action="store_true",
        help=(
            "Skip `git add` after writing the file "
            "(attribution-update only). Default: stage when in a repo."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    project_dir = Path(args.project_dir).resolve()
    if not project_dir.is_dir():
        print(
            f"[wp-precommit] project_dir is not a directory: {project_dir}",
            file=sys.stderr,
        )
        return HOOK_EXIT_INFRASTRUCTURE_ERROR

    if args.mode == "license-check":
        return run_license_check(project_dir, policy=args.policy)
    if args.mode == "drift-check":
        current = Path(args.current_report) if args.current_report else None
        return run_drift_check(
            project_dir, current_report=current, block_on=args.block_on
        )
    if args.mode == "gen-tests-check":
        junit = Path(args.junit_xml) if args.junit_xml else None
        return run_gen_tests_check(project_dir, junit_xml=junit)
    if args.mode == "attribution-update":
        return run_attribution_update(
            project_dir,
            project_name=args.project_name,
            include_transitive=not args.no_transitive,
            include_unknown=not args.no_unknown,
            stage=not args.no_stage,
        )

    return HOOK_EXIT_INFRASTRUCTURE_ERROR  # unreachable


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
