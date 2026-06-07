"""
Test Executor
==============

Discovers and executes E2E tests using Playwright or pytest.
Returns structured results for the Browser Agent dashboard.
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from .models import TestInfo, TestResult, TestRunResult


def _resolve_npx() -> str:
    """Find the npx executable, accounting for Windows shell wrappers.

    On Windows, `npx` is `npx.cmd` (or `.ps1` / `.bat`); calling
    `subprocess.run(["npx", ...], shell=False)` raises FileNotFoundError
    even when npm is installed. shutil.which finds the right one.
    """
    found = shutil.which("npx")
    if found:
        return found
    # Last-resort fallback that lets subprocess raise FileNotFoundError
    # consistently across platforms.
    return "npx.cmd" if os.name == "nt" else "npx"


class TestExecutor:
    """Discovers and runs E2E tests, returning structured results."""

    __test__ = False  # Exclude from pytest collection

    # Common E2E test directories
    TEST_DIRS = ["e2e", "tests/e2e", "test/e2e", "browser-tests", "tests/browser"]

    # Common test file patterns
    TEST_PATTERNS = [
        "*.spec.ts",
        "*.spec.js",
        "*.test.ts",
        "*.test.js",
        "*.e2e.ts",
        "*.e2e.js",
        "*_test.py",
        "test_*.py",
    ]

    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)

    def discover_tests(self) -> list[TestInfo]:
        """Discover E2E test files in the project."""
        tests = []
        seen_paths = set()

        for test_dir_name in self.TEST_DIRS:
            test_dir = self.project_dir / test_dir_name
            if not test_dir.exists():
                continue

            for pattern in self.TEST_PATTERNS:
                for test_file in test_dir.rglob(pattern):
                    rel_path = str(test_file.relative_to(self.project_dir))
                    if rel_path in seen_paths:
                        continue
                    seen_paths.add(rel_path)

                    # Determine test type
                    if test_file.suffix in (".ts", ".js"):
                        test_type = "playwright"
                    elif test_file.suffix == ".py":
                        test_type = "pytest"
                    else:
                        test_type = "custom"

                    tests.append(
                        TestInfo(
                            name=test_file.stem,
                            path=rel_path,
                            type=test_type,
                        )
                    )

        return tests

    def run_tests(self, test_files: list[str] | None = None) -> TestRunResult:
        """Run E2E tests and return structured results."""
        discovered = self.discover_tests()
        if not discovered:
            return TestRunResult(
                total=0, passed=0, failed=0, skipped=0, duration_ms=0, results=[]
            )

        # Separate by type
        playwright_tests = [t for t in discovered if t.type == "playwright"]
        pytest_tests = [t for t in discovered if t.type == "pytest"]

        # Filter if specific files requested. Discovered paths are relative
        # to project_dir; callers may pass absolute paths. Normalize both
        # sides via resolve() to avoid the silent "0 results" surprise.
        if test_files:
            requested = {str((self.project_dir / t).resolve()) for t in test_files}

            def _matches(t: TestInfo) -> bool:
                return (
                    t.path in test_files
                    or str((self.project_dir / t.path).resolve()) in requested
                )

            playwright_tests = [t for t in playwright_tests if _matches(t)]
            pytest_tests = [t for t in pytest_tests if _matches(t)]

        all_results: list[TestResult] = []
        start_time = time.time()

        if playwright_tests:
            all_results.extend(self._run_playwright_tests(playwright_tests))

        if pytest_tests:
            all_results.extend(self._run_pytest_tests(pytest_tests))

        total_duration = (time.time() - start_time) * 1000

        passed = sum(1 for r in all_results if r.status == "passed")
        failed = sum(1 for r in all_results if r.status == "failed")
        skipped = sum(1 for r in all_results if r.status == "skipped")

        return TestRunResult(
            total=len(all_results),
            passed=passed,
            failed=failed,
            skipped=skipped,
            duration_ms=round(total_duration, 2),
            results=all_results,
        )

    def _run_playwright_tests(self, tests: list[TestInfo]) -> list[TestResult]:
        """Run Playwright tests via npx and parse results."""
        results = []
        test_paths = [t.path for t in tests]

        try:
            json_report = (
                self.project_dir
                / ".workpilot"
                / "browser-agent"
                / "playwright-report.json"
            )
            json_report.parent.mkdir(parents=True, exist_ok=True)

            cmd = [
                _resolve_npx(),
                "playwright",
                "test",
                "--reporter=json",
                *test_paths,
            ]

            start = time.time()
            proc = subprocess.run(
                cmd,
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=300,
                shell=False,
            )
            duration = (time.time() - start) * 1000

            # Try to parse JSON output
            try:
                report = json.loads(proc.stdout)
                for suite in report.get("suites", []):
                    results.extend(self._parse_playwright_suite(suite))
            except (json.JSONDecodeError, KeyError):
                # Fallback: create results from test list based on exit code
                status = "passed" if proc.returncode == 0 else "failed"
                for test in tests:
                    results.append(
                        TestResult(
                            name=test.name,
                            path=test.path,
                            status=status,
                            duration_ms=duration / len(tests),
                            error_message=proc.stderr[:500]
                            if status == "failed"
                            else None,
                        )
                    )

        except subprocess.TimeoutExpired:
            for test in tests:
                results.append(
                    TestResult(
                        name=test.name,
                        path=test.path,
                        status="error",
                        duration_ms=300000,
                        error_message="Test execution timed out (300s)",
                    )
                )
        except FileNotFoundError:
            for test in tests:
                results.append(
                    TestResult(
                        name=test.name,
                        path=test.path,
                        status="error",
                        duration_ms=0,
                        error_message="npx/playwright not found. Install with: npm install @playwright/test",
                    )
                )

        return results

    def _parse_playwright_suite(self, suite: dict) -> list[TestResult]:
        """Parse a Playwright JSON report suite recursively."""
        results = []

        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                for result in test.get("results", []):
                    status = result.get("status", "failed")
                    if status == "expected":
                        status = "passed"
                    elif status == "unexpected":
                        status = "failed"

                    error_msg = None
                    if result.get("error"):
                        error_msg = result["error"].get("message", "")[:500]

                    results.append(
                        TestResult(
                            name=spec.get("title", "unknown"),
                            path=spec.get("file", ""),
                            status=status,
                            duration_ms=result.get("duration", 0),
                            error_message=error_msg,
                        )
                    )

        # Recurse into child suites
        for child in suite.get("suites", []):
            results.extend(self._parse_playwright_suite(child))

        return results

    def _run_pytest_tests(self, tests: list[TestInfo]) -> list[TestResult]:
        """Run pytest tests and parse results."""
        results = []
        test_paths = [t.path for t in tests]

        try:
            cmd = [
                "python",
                "-m",
                "pytest",
                "--tb=short",
                "-q",
                "--json-report",
                "--json-report-file=-",
                *test_paths,
            ]

            start = time.time()
            proc = subprocess.run(
                cmd,
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=300,
            )
            duration = (time.time() - start) * 1000

            # Try to parse pytest-json-report output
            try:
                report = json.loads(proc.stdout)
                for test_data in report.get("tests", []):
                    status = test_data.get("outcome", "failed")
                    if status == "xfailed":
                        status = "skipped"

                    results.append(
                        TestResult(
                            name=test_data.get("nodeid", "unknown").split("::")[-1],
                            path=test_data.get("nodeid", "").split("::")[0],
                            status=status,
                            duration_ms=test_data.get("duration", 0) * 1000,
                            error_message=test_data.get("call", {}).get(
                                "longrepr", None
                            ),
                        )
                    )
            except (json.JSONDecodeError, KeyError):
                # Fallback: basic status from exit code
                status = "passed" if proc.returncode == 0 else "failed"
                for test in tests:
                    results.append(
                        TestResult(
                            name=test.name,
                            path=test.path,
                            status=status,
                            duration_ms=duration / len(tests),
                            error_message=proc.stderr[:500]
                            if status == "failed"
                            else None,
                        )
                    )

        except subprocess.TimeoutExpired:
            for test in tests:
                results.append(
                    TestResult(
                        name=test.name,
                        path=test.path,
                        status="error",
                        duration_ms=300000,
                        error_message="Test execution timed out (300s)",
                    )
                )

        return results
