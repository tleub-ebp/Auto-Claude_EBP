"""
Architecture Validator
=======================

Top-level entry point for architecture enforcement.
Called from qa/loop.py after QA reviewer approves.

Orchestrates deterministic rules engine + optional AI review.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from debug import debug, debug_error, debug_section, debug_success, debug_warning

from .config import infer_architecture_config, load_architecture_config
from .models import ArchitectureViolation
from .rules_engine import ArchitectureRulesEngine

# Maximum files to analyze in AI review (to keep token usage reasonable)
MAX_AI_REVIEW_FILES = 200


async def run_architecture_validation(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    verbose: bool = False,
) -> tuple[bool, dict]:
    """
    Run architecture validation (deterministic + optional AI).

    Called from qa/loop.py after QA reviewer approves.

    Args:
        project_dir: Root directory of the project
        spec_dir: Directory containing the spec files
        model: Model identifier for AI review
        verbose: Enable verbose logging

    Returns:
        (passed, report_dict) where report_dict is saved to implementation_plan.json
    """
    debug_section("architecture", "Architecture Enforcement Gate")

    # 1. Load or infer architecture config
    config = load_architecture_config(project_dir)
    if config:
        debug("architecture", "Loaded explicit architecture rules", source="explicit")
    else:
        config = infer_architecture_config(project_dir)
        if not config.layers and not config.bounded_contexts:
            # No rules could be inferred — skip validation
            debug(
                "architecture",
                "No architecture rules configured or inferred, skipping validation",
            )
            return True, {
                "status": "approved",
                "summary": "No architecture rules configured. Skipping validation.",
                "config_source": "none",
            }
        debug(
            "architecture",
            "Inferred architecture rules from project structure",
            source="inferred",
            layers=len(config.layers),
            contexts=len(config.bounded_contexts),
        )

    # 2. Get changed files from git diff
    changed_files = _get_changed_files(project_dir, spec_dir)
    if changed_files is not None:
        debug(
            "architecture",
            f"Analyzing {len(changed_files)} changed file(s)",
            files=changed_files[:10],
        )
    else:
        debug("architecture", "Could not determine changed files, analyzing all")

    # 3. Run deterministic rules engine
    engine = ArchitectureRulesEngine(project_dir, config)
    report = engine.validate(changed_files)

    debug(
        "architecture",
        "Deterministic analysis complete",
        violations=len(report.violations),
        warnings=len(report.warnings),
        files_analyzed=report.files_analyzed,
        duration=f"{report.duration_seconds:.2f}s",
    )

    if verbose:
        if report.violations:
            for v in report.violations:
                print(f"  \u274c {v.type}: {v.description}")
        if report.warnings:
            for w in report.warnings:
                print(f"  \u26a0\ufe0f  {w.type}: {w.description}")

    # 4. Optional AI review (only if deterministic passes and AI enabled)
    ai_violations: list[ArchitectureViolation] = []
    if report.passed and config.ai_review:
        try:
            from .ai_reviewer import run_architecture_ai_review

            debug("architecture", "Running AI architecture review...")
            ai_violations = await run_architecture_ai_review(
                project_dir=project_dir,
                spec_dir=spec_dir,
                model=model,
                deterministic_report=report,
                config=config,
                verbose=verbose,
            )
            if ai_violations:
                # AI found additional violations
                ai_errors = [v for v in ai_violations if v.severity == "error"]
                ai_warnings = [v for v in ai_violations if v.severity == "warning"]
                report.violations.extend(ai_errors)
                report.warnings.extend(ai_warnings)
                if ai_errors:
                    report.passed = False
                    report.summary += (
                        f"\nAI review found {len(ai_errors)} additional error(s) "
                        f"and {len(ai_warnings)} warning(s)."
                    )
                debug(
                    "architecture",
                    "AI review complete",
                    ai_errors=len(ai_errors),
                    ai_warnings=len(ai_warnings),
                )
        except Exception as e:
            # AI review failure should not block the pipeline
            debug_warning(
                "architecture",
                f"AI architecture review failed (non-blocking): {e}",
            )
            report.warnings.append(
                ArchitectureViolation(
                    type="ai_review_error",
                    severity="warning",
                    file="",
                    description=f"AI architecture review could not complete: {e}",
                    suggestion="Check logs for details. The deterministic analysis still passed.",
                )
            )

    # 5. Build result
    report_dict = report.to_dict()

    if report.passed:
        debug_success(
            "architecture",
            "Architecture validation PASSED",
            warnings=len(report.warnings),
        )
    else:
        debug_error(
            "architecture",
            "Architecture validation FAILED",
            violations=len(report.violations),
            warnings=len(report.warnings),
        )

    return report.passed, report_dict


def _get_changed_files(project_dir: Path, spec_dir: Path) -> list[str] | None:
    """
    Get list of changed files from git diff against the base branch.

    Returns None if git diff fails (will fall back to full analysis).
    """
    base_branch = _detect_base_branch(spec_dir, project_dir)

    try:
        result = subprocess.run(
            [
                "git",
                "diff",
                f"{base_branch}...HEAD",
                "--name-only",
                "--diff-filter=ACMR",
            ],
            cwd=project_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if result.returncode == 0:
            files = [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
            return files if files else None
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass

    return None


def _detect_base_branch(spec_dir: Path, project_dir: Path) -> str:
    """Detect the base branch for git diff. Reuses prompts_pkg logic.

    Hard-coded `main` fallback was wrong for repos using `master`/`develop`
    (this very repo's main branch is `develop`!). When the import fails we
    now probe `git symbolic-ref refs/remotes/origin/HEAD` to discover the
    real default branch; if even that fails we fall back to `main` to keep
    the previous behavior on totally fresh repos.
    """
    try:
        from prompts_pkg.prompts import _detect_base_branch as _detect

        return _detect(spec_dir, project_dir)
    except ImportError:
        pass

    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            ref = result.stdout.strip()
            # Strip the `origin/` prefix if present.
            if "/" in ref:
                ref = ref.split("/", 1)[1]
            if ref:
                return ref
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass

    # Try common defaults that exist locally.
    for candidate in ("develop", "main", "master"):
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", "--quiet", candidate],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                return candidate
        except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
            continue

    return "main"


def write_architecture_fix_request(spec_dir: Path, report_dict: dict) -> None:
    """
    Write architecture violations to QA_FIX_REQUEST.md for the fixer agent.

    This file is read by the QA fixer to understand what needs to be fixed.
    """
    violations = report_dict.get("violations", [])
    if not violations:
        return

    lines = [
        "# Architecture Violation Fix Request",
        "",
        "The Architecture Enforcement Agent found the following violations that must",
        "be fixed before the build can be approved.",
        "",
        f"**Total violations:** {len(violations)}",
        "",
        "## Violations",
        "",
    ]

    for i, v in enumerate(violations, 1):
        lines.append(
            f"### {i}. {v.get('type', 'unknown')} ({v.get('severity', 'error')})"
        )
        lines.append("")
        if v.get("file"):
            line_info = f" (line {v['line']})" if v.get("line") else ""
            lines.append(f"**File:** `{v['file']}`{line_info}")
        if v.get("import_target"):
            lines.append(f"**Import:** `{v['import_target']}`")
        if v.get("rule"):
            lines.append(f"**Rule:** {v['rule']}")
        lines.append("")
        lines.append(v.get("description", ""))
        if v.get("suggestion"):
            lines.append("")
            lines.append(f"**Suggestion:** {v['suggestion']}")
        lines.append("")

    fix_request_path = spec_dir / "QA_FIX_REQUEST.md"
    try:
        # Append to existing fix request if present
        existing = ""
        if fix_request_path.exists():
            existing = fix_request_path.read_text(encoding="utf-8")
            if existing and not existing.endswith("\n\n"):
                existing += "\n\n"

        content = existing + "\n".join(lines)
        fix_request_path.write_text(content, encoding="utf-8")
    except OSError:
        pass
