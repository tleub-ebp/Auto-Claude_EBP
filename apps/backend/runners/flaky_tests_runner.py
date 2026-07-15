"""
Flaky Tests Runner

Discovers test reports in a project, builds a TestRun history, and runs
the FlakyAnalyzer to identify flaky tests.

Two report formats are understood:
    * JUnit XML (``<testsuite>``/``<testcase>``) — pytest, jest, Maven
      surefire, and ``dotnet test --logger junit``.
    * TRX (``<TestRun>``/``<UnitTestResult>``) — the *native* format
      emitted by ``dotnet test --logger trx`` / ``vstest.console``. .NET
      projects produce TRX by default, never JUnit, so a JUnit-only
      detective always reported "0 tests" on a C# solution.

Output protocol (one JSON object per line, prefixed):
    FLAKY_EVENT:{"type": "progress", "data": {"status": "..."}}
    FLAKY_RESULT:{...full report dict...}
    FLAKY_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from flaky_test_detective.flaky_analyzer import (  # noqa: E402
    FlakyAnalyzer,
    TestRun,
)

REPORT_GLOBS = [
    # JUnit XML
    "**/test-results/**/*.xml",
    "**/junit*.xml",
    "**/TEST-*.xml",
    "**/*.junit.xml",
    "**/build/test-results/**/*.xml",
    "**/target/surefire-reports/*.xml",
    "**/reports/junit/*.xml",
    # TRX (native .NET / vstest) — dotnet test --logger trx writes here
    "**/*.trx",
    "**/TestResults/**/*.trx",
]
DEFAULT_IGNORES = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "bin",
    "obj",
}


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("FLAKY_EVENT", {"type": event_type, "data": data})


def _discover_reports(root: Path) -> list[Path]:
    found: set[Path] = set()
    for pattern in REPORT_GLOBS:
        for path in root.glob(pattern):
            if path.is_file() and not any(
                part in DEFAULT_IGNORES for part in path.parts
            ):
                found.add(path)
    return sorted(found)


def _local(tag: str) -> str:
    """Return the local part of a (possibly namespaced) XML tag.

    TRX documents declare a default namespace, so ElementTree reports
    tags as ``{http://…/2010}UnitTestResult``. Matching on the local
    name keeps the parser namespace-agnostic.
    """
    return tag.rsplit("}", 1)[-1]


def _iter_local(root: ET.Element, name: str):
    """Yield descendant elements whose local tag name equals ``name``."""
    for el in root.iter():
        if _local(el.tag) == name:
            yield el


# --- JUnit ------------------------------------------------------------


def _testcase_full_name(case: ET.Element) -> str:
    name = case.attrib.get("name", "")
    classname = case.attrib.get("classname", "")
    return f"{classname}::{name}" if classname else name


def _testcase_duration(case: ET.Element) -> float:
    try:
        return float(case.attrib.get("time", "0")) * 1000
    except ValueError:
        return 0.0


def _testcase_error_message(case: ET.Element) -> tuple[bool, str]:
    """Return (passed, error_message). Skipped tests yield (True, "")."""
    failure = case.find("failure")
    error = case.find("error")
    if failure is not None:
        return False, failure.attrib.get("message", "") or (failure.text or "")
    if error is not None:
        return False, error.attrib.get("message", "") or (error.text or "")
    return True, ""


def _parse_junit_root(root: ET.Element, run_id: str, timestamp: float) -> list[TestRun]:
    runs: list[TestRun] = []
    for case in _iter_local(root, "testcase"):
        if any(_local(c.tag) == "skipped" for c in case):
            continue
        passed, error_message = _testcase_error_message(case)
        runs.append(
            TestRun(
                test_name=_testcase_full_name(case),
                passed=passed,
                duration_ms=_testcase_duration(case),
                error_message=error_message[:500],
                run_id=run_id,
                timestamp=timestamp,
            )
        )
    return runs


# --- TRX (native .NET / vstest) ---------------------------------------

# TRX outcomes that mean "the test did not run" — treated like a JUnit
# <skipped> and excluded from flakiness accounting.
_TRX_SKIPPED_OUTCOMES = {"notexecuted", "inconclusive", "pending", "warning"}


def _trx_duration(result: ET.Element) -> float:
    """Parse a TRX ``duration`` attribute (``HH:MM:SS.fffffff``) to ms."""
    raw = result.attrib.get("duration", "")
    if not raw:
        return 0.0
    try:
        hms, _, frac = raw.partition(".")
        hours, minutes, seconds = (int(p) for p in hms.split(":"))
        total = hours * 3600 + minutes * 60 + seconds
        frac_ms = float(f"0.{frac}") * 1000 if frac else 0.0
        return total * 1000 + frac_ms
    except (ValueError, TypeError):
        return 0.0


def _trx_error_message(result: ET.Element) -> str:
    for msg in _iter_local(result, "Message"):
        if msg.text:
            return msg.text
    return ""


def _parse_trx_root(root: ET.Element, run_id: str, timestamp: float) -> list[TestRun]:
    runs: list[TestRun] = []
    for result in _iter_local(root, "UnitTestResult"):
        outcome = result.attrib.get("outcome", "").lower()
        if outcome in _TRX_SKIPPED_OUTCOMES:
            continue
        name = result.attrib.get("testName", "")
        passed = outcome == "passed"
        error_message = "" if passed else _trx_error_message(result)
        runs.append(
            TestRun(
                test_name=name,
                passed=passed,
                duration_ms=_trx_duration(result),
                error_message=error_message[:500],
                run_id=run_id,
                timestamp=timestamp,
            )
        )
    return runs


def _parse_report_file(path: Path, run_id: str) -> list[TestRun]:
    """Parse a report file, dispatching on the actual root element.

    The root tag (not the extension) decides the format so a JUnit XML
    saved with a ``.xml`` name and a TRX with a ``.trx`` name both work.
    """
    try:
        tree = ET.parse(path)  # noqa: S314
    except (ET.ParseError, OSError):
        return []

    root = tree.getroot()
    timestamp = path.stat().st_mtime
    root_tag = _local(root.tag).lower()

    if root_tag == "testrun":  # TRX
        return _parse_trx_root(root, run_id, timestamp)
    return _parse_junit_root(root, run_id, timestamp)


def _flaky_test_to_dict(test: Any) -> dict[str, Any]:
    return {
        "testName": test.test_name,
        "totalRuns": test.total_runs,
        "failures": test.failures,
        "flakinessRate": test.flakiness_rate,
        "probableCause": test.probable_cause.value,
        "confidence": test.confidence.value,
        "errorPatterns": test.error_patterns,
        "suggestedFix": test.suggested_fix,
    }


# Language detection → the command that makes that stack emit a
# machine-readable (JUnit XML / TRX) test report. Markers are either an
# exact filename or a ``*.ext`` extension pattern. Order defines the
# order languages appear in the guidance message.
_LANGUAGE_REPORT_HINTS: list[tuple[str, tuple[str, ...], str]] = [
    (
        "C# / .NET",
        ("*.sln", "*.csproj", "*.fsproj", "*.vbproj"),
        "dotnet test --logger trx",
    ),
    (
        "JavaScript / TypeScript",
        ("package.json",),
        "jest --reporters=default --reporters=jest-junit (or vitest --reporter=junit)",
    ),
    (
        "Python",
        ("pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "*.py"),
        "pytest --junitxml=test-results/junit.xml",
    ),
    (
        "Java / Kotlin",
        ("pom.xml", "build.gradle", "build.gradle.kts"),
        "mvn test (Surefire emits JUnit XML) or gradle test",
    ),
    (
        "Go",
        ("go.mod",),
        "gotestsum --junitfile test-results/junit.xml",
    ),
    (
        "Ruby",
        ("Gemfile",),
        "rspec --format RspecJunitFormatter --out test-results/junit.xml",
    ),
    (
        "Rust",
        ("Cargo.toml",),
        "cargo nextest run --profile ci (emits JUnit)",
    ),
    (
        "PHP",
        ("composer.json",),
        "phpunit --log-junit test-results/junit.xml",
    ),
]

# Stop walking once we've seen enough of the tree to identify the stack;
# keeps detection fast on very large monorepos.
_MAX_SCANNED_FILES = 20000


def _scan_markers(project_path: Path) -> tuple[set[str], set[str]]:
    """Single pruned walk collecting seen filenames and extensions."""
    filenames: set[str] = set()
    extensions: set[str] = set()
    for dirpath, dirnames, files in os.walk(project_path):
        dirnames[:] = [d for d in dirnames if d not in DEFAULT_IGNORES]
        for name in files:
            filenames.add(name)
            extensions.add(Path(name).suffix.lower())
        if len(filenames) > _MAX_SCANNED_FILES:
            break
    return filenames, extensions


def _marker_matches(marker: str, filenames: set[str], extensions: set[str]) -> bool:
    if marker.startswith("*."):
        return marker[1:].lower() in extensions
    return marker in filenames


def _detect_languages(project_path: Path) -> list[tuple[str, str]]:
    """Detect project languages, returning ``(label, report_command)``."""
    filenames, extensions = _scan_markers(project_path)
    detected: list[tuple[str, str]] = []
    for label, markers, command in _LANGUAGE_REPORT_HINTS:
        if any(_marker_matches(m, filenames, extensions) for m in markers):
            detected.append((label, command))
    return detected


def _no_reports_message(project_path: Path) -> str:
    """Guidance for the empty state, tailored to the detected languages.

    Telling a C# developer to "emit XML reports" is confusing — .NET
    emits TRX, JS emits JUnit via jest-junit, etc. So we detect the
    project's languages and point at the right command for each.
    """
    detected = _detect_languages(project_path)
    if not detected:
        return (
            "No test reports found. Configure your test runner to emit "
            "JUnit XML or TRX reports, then re-scan."
        )
    hints = "; ".join(f"{label} → `{command}`" for label, command in detected)
    return (
        "No test reports found. Emit JUnit XML or TRX reports and re-scan. "
        f"Detected stack — {hints}."
    )


def run_scan(project_path: Path, threshold: float, min_runs: int) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering test reports..."})
    report_files = _discover_reports(project_path)
    _emit_event(
        "progress",
        {"status": f"Parsing {len(report_files)} test reports..."},
    )

    runs: list[TestRun] = []
    for idx, file in enumerate(report_files):
        runs.extend(_parse_report_file(file, run_id=f"{file.name}-{idx}"))

    if not runs:
        _emit_event("complete", {"flakyCount": 0, "totalTests": 0})
        return {
            "totalTests": 0,
            "flakyCount": 0,
            "flakyTests": [],
            "summary": _no_reports_message(project_path),
        }

    _emit_event(
        "progress",
        {"status": f"Analysing {len(runs)} test runs..."},
    )
    analyzer = FlakyAnalyzer(flakiness_threshold=threshold, min_runs=min_runs)
    report = analyzer.analyze(runs)

    result = {
        "totalTests": report.total_tests_analysed,
        "flakyCount": report.flaky_count,
        "flakyTests": [_flaky_test_to_dict(t) for t in report.flaky_tests],
        "summary": report.summary,
    }
    _emit_event(
        "complete",
        {"flakyCount": report.flaky_count, "totalTests": report.total_tests_analysed},
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Flaky Tests Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.05,
        help="Flakiness rate threshold (0.0-1.0)",
    )
    parser.add_argument(
        "--min-runs",
        type=int,
        default=2,
        help="Minimum runs needed to assess flakiness",
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("FLAKY_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        result = run_scan(project_path, args.threshold, args.min_runs)
        _emit("FLAKY_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("FLAKY_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
