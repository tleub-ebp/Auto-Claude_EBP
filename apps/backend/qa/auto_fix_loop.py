"""
Auto-Fix Loop Module
====================

Intelligent auto-fix loops that automatically detect and fix test failures.

Features:
- Automatic test execution and failure detection
- Intelligent failure analysis and fix generation
- Configurable retry limits (default: 5 attempts)
- Learning from common errors using Graphiti memory
- Comprehensive success tracking and metrics
- Human escalation after max attempts

Usage:
    from qa.auto_fix_loop import AutoFixLoop

    loop = AutoFixLoop(project_dir, spec_dir, model)
    success = await loop.run_until_green(max_attempts=5)
"""

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path

try:
    from agents.memory_manager import get_graphiti_context, save_session_memory
except ImportError:
    # Fallback if memory manager not available
    def get_graphiti_context(*args, **kwargs):
        # Fallback implementation when memory manager is not available
        # Return empty context string to prevent crashes in environments without memory management
        return ""

    def save_session_memory(*args, **kwargs):
        # Fallback implementation when memory manager is not available
        # Silently ignore memory save calls to prevent crashes in environments without memory management
        pass


try:
    from analysis.test_discovery import TestDiscovery
except ImportError:
    TestDiscovery = None

try:
    from core.client import create_agent_client, create_client
except ImportError:

    def create_client(*args, **kwargs):
        return None

    def create_agent_client(*args, **kwargs):
        return None


try:
    from core.task_event import TaskEventEmitter
except ImportError:
    TaskEventEmitter = None

try:
    from debug import debug, debug_error, debug_section, debug_success, debug_warning
except ImportError:

    def debug(*args, **kwargs):
        # Fallback implementation when debug module is not available
        # Silently ignore debug calls to prevent crashes in environments without debug utilities
        pass

    def debug_error(*args, **kwargs):
        # Fallback implementation when debug module is not available
        # Silently ignore debug error calls to prevent crashes in environments without debug utilities
        pass

    def debug_section(*args, **kwargs):
        # Fallback implementation when debug module is not available
        # Silently ignore debug section calls to prevent crashes in environments without debug utilities
        pass

    def debug_success(*args, **kwargs):
        # Fallback implementation when debug module is not available
        # Silently ignore debug success calls to prevent crashes in environments without debug utilities
        pass

    def debug_warning(*args, **kwargs):
        # Fallback implementation when debug module is not available
        # Silently ignore debug warning calls to prevent crashes in environments without debug utilities
        pass


try:
    from phase_config import get_phase_model, get_phase_thinking_budget
except ImportError:

    def get_phase_model(*args, **kwargs):
        return None

    def get_phase_thinking_budget(*args, **kwargs):
        return "medium"


try:
    from task_logger import LogPhase, get_task_logger
except ImportError:
    LogPhase = None

    def get_task_logger(*args, **kwargs):
        return None


from .fixer import run_qa_fixer_session

# Configuration
DEFAULT_MAX_AUTO_FIX_ATTEMPTS = 5
TEST_EXECUTION_TIMEOUT = 300.0  # 5 minutes


@dataclass
class AutoFixTestResult:
    """Result of test execution."""

    executed: bool
    passed: bool
    output: str
    error: str | None
    duration: float
    test_count: int = 0
    failed_count: int = 0


@dataclass
class AutoFixAttempt:
    """Record of a single auto-fix attempt."""

    attempt_number: int
    test_result: AutoFixTestResult
    fix_applied: bool
    fix_status: str
    duration: float
    error_pattern: str | None = None
    timestamp: float = 0.0


class AutoFixLoop:
    """
    Orchestrates automatic test-fix-test loops until all tests pass.

    The loop:
    1. Runs tests to detect failures
    2. Analyzes failure output
    3. Generates and applies fixes using Claude
    4. Re-runs tests
    5. Repeats until tests pass or max attempts reached
    """

    def __init__(
        self,
        project_dir: Path,
        spec_dir: Path,
        model: str,
        verbose: bool = False,
    ):
        """
        Initialize auto-fix loop.

        Args:
            project_dir: Project root directory
            spec_dir: Spec directory
            model: Claude model to use
            verbose: Whether to show detailed output
        """
        self.project_dir = project_dir
        self.spec_dir = spec_dir
        self.model = model
        self.verbose = verbose
        self.task_logger = get_task_logger(spec_dir)
        self.task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)
        self.attempts: list[AutoFixAttempt] = []

        # Initialize test discovery
        self.test_discovery = TestDiscovery()
        self.test_info = self.test_discovery.discover(project_dir)

    async def run_until_green(
        self, max_attempts: int = DEFAULT_MAX_AUTO_FIX_ATTEMPTS
    ) -> bool:
        """
        Run auto-fix loop until all tests pass or max attempts reached.

        Args:
            max_attempts: Maximum number of fix attempts (default: 5)

        Returns:
            True if all tests pass, False otherwise
        """
        debug_section("auto_fix_loop", "Auto-Fix Loop")
        debug(
            "auto_fix_loop",
            "Starting auto-fix loop",
            project_dir=str(self.project_dir),
            spec_dir=str(self.spec_dir),
            max_attempts=max_attempts,
        )

        print("\n" + "=" * 70)
        print("  🔄 AUTO-FIX LOOP")
        print("  Intelligent test-fix-test automation")
        print("=" * 70)

        # Check if tests are available
        if not self.test_info.has_tests:
            debug_warning("auto_fix_loop", "No tests found in project")
            print("\n⚠️  No tests found in project. Cannot run auto-fix loop.")
            return False

        # Emit start event
        self.task_event_emitter.emit(
            "AUTO_FIX_STARTED",
            {
                "maxAttempts": max_attempts,
                "testCommand": self.test_info.test_command,
                "frameworks": [f.name for f in self.test_info.frameworks],
            },
        )

        # Load memory context for common test failures
        memory_context = await self._load_memory_context()

        # Start validation phase
        if self.task_logger:
            self.task_logger.start_phase(
                LogPhase.VALIDATION, "Starting auto-fix loop..."
            )

        attempt_number = 0
        while attempt_number < max_attempts:
            attempt_number += 1
            attempt_start = time.time()

            debug_section("auto_fix_loop", f"Attempt {attempt_number}/{max_attempts}")
            print(f"\n--- Auto-Fix Attempt {attempt_number}/{max_attempts} ---")

            # Step 1: Run tests
            debug("auto_fix_loop", "Executing tests...")
            test_result = await self._run_tests()

            if test_result.passed:
                # Success! All tests passed
                duration = time.time() - attempt_start
                attempt = AutoFixAttempt(
                    attempt_number=attempt_number,
                    test_result=test_result,
                    fix_applied=False,
                    fix_status="success",
                    duration=duration,
                    timestamp=time.time(),
                )
                self.attempts.append(attempt)

                debug_success(
                    "auto_fix_loop",
                    "All tests passed!",
                    attempts=attempt_number,
                    duration=f"{duration:.1f}s",
                )

                print("\n" + "=" * 70)
                print("  ✅ ALL TESTS PASSED!")
                print("=" * 70)
                print(f"\nTests fixed successfully after {attempt_number} attempt(s).")

                # Save success to memory
                await self._save_success_to_memory(attempt_number, memory_context)

                # Update metrics
                self._update_metrics(success=True, attempts=attempt_number)

                # Emit success event
                self.task_event_emitter.emit(
                    "AUTO_FIX_SUCCESS",
                    {
                        "attempts": attempt_number,
                        "duration": duration,
                        "testsRun": test_result.test_count,
                    },
                )

                # End validation phase successfully
                if self.task_logger:
                    self.task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=True,
                        message=f"Auto-fix successful after {attempt_number} attempts",
                    )

                return True

            # Tests failed - analyze and fix
            debug_warning(
                "auto_fix_loop",
                "Tests failed",
                failed_count=test_result.failed_count,
                total_count=test_result.test_count,
            )

            print(f"\n❌ Tests failed: {test_result.failed_count} failures")
            print(f"   Test output: {test_result.output[:500]}")

            if attempt_number >= max_attempts:
                # Max attempts reached
                debug_error(
                    "auto_fix_loop",
                    "Max attempts reached without success",
                    attempts=attempt_number,
                )
                break

            # Step 2: Analyze failure and generate fix
            debug("auto_fix_loop", "Analyzing test failures...")
            error_pattern = self._analyze_failure(test_result)

            # Emit attempt event
            self.task_event_emitter.emit(
                "AUTO_FIX_ATTEMPT",
                {
                    "attempt": attempt_number,
                    "maxAttempts": max_attempts,
                    "failedTests": test_result.failed_count,
                    "errorPattern": error_pattern,
                },
            )

            # Step 3: Generate fix request
            self._create_fix_request(test_result, error_pattern, memory_context)

            # Step 4: Apply fix using QA fixer
            debug("auto_fix_loop", "Applying automated fix...")
            print("\n🔧 Applying automated fix...")

            fix_status, fix_response = await self._apply_fix(attempt_number)

            duration = time.time() - attempt_start
            attempt = AutoFixAttempt(
                attempt_number=attempt_number,
                test_result=test_result,
                fix_applied=(fix_status == "fixed"),
                fix_status=fix_status,
                duration=duration,
                error_pattern=error_pattern,
                timestamp=time.time(),
            )
            self.attempts.append(attempt)

            if fix_status == "error":
                debug_error("auto_fix_loop", f"Fix error: {fix_response[:200]}")
                print(f"\n❌ Fix failed: {fix_response[:200]}")
                # Continue to next attempt
                continue

            debug_success("auto_fix_loop", "Fix applied, re-running tests...")
            print("\n✅ Fix applied. Re-running tests...")

        # Max attempts reached without success
        debug_error("auto_fix_loop", "Auto-fix loop failed", attempts=attempt_number)
        print("\n" + "=" * 70)
        print("  ⚠️  AUTO-FIX FAILED")
        print("=" * 70)
        print(f"\nFailed to fix tests after {max_attempts} attempts.")
        print("Escalating to human review...")

        # Save failure to memory
        await self._save_failure_to_memory(attempt_number, memory_context)

        # Update metrics
        self._update_metrics(success=False, attempts=attempt_number)

        # Escalate to human
        self._escalate_to_human()

        # Emit failure event
        self.task_event_emitter.emit(
            "AUTO_FIX_FAILED",
            {
                "attempts": attempt_number,
                "maxAttempts": max_attempts,
                "finalFailures": (
                    self.attempts[-1].test_result.failed_count if self.attempts else 0
                ),
            },
        )

        # End validation phase as failed
        if self.task_logger:
            self.task_logger.end_phase(
                LogPhase.VALIDATION,
                success=False,
                message=f"Auto-fix failed after {attempt_number} attempts",
            )

        return False

    async def _run_tests(self) -> AutoFixTestResult:
        """Execute project tests and return results."""
        start_time = time.time()

        try:
            test_cmd = self.test_info.test_command
            if not test_cmd:
                return AutoFixTestResult(
                    executed=False,
                    passed=False,
                    output="",
                    error="No test command available",
                    duration=0.0,
                )

            debug("auto_fix_loop", f"Executing: {test_cmd}")

            # Execute tests with timeout
            proc = await asyncio.create_subprocess_shell(
                test_cmd,
                cwd=self.project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=TEST_EXECUTION_TIMEOUT,
                )
            except asyncio.TimeoutError:
                debug_error("auto_fix_loop", "Tests timed out")
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
                return AutoFixTestResult(
                    executed=True,
                    passed=False,
                    output="",
                    error=f"Timeout after {TEST_EXECUTION_TIMEOUT}s",
                    duration=TEST_EXECUTION_TIMEOUT,
                )

            duration = time.time() - start_time
            passed = proc.returncode == 0
            output = stdout.decode("utf-8") if stdout else ""
            error_output = stderr.decode("utf-8") if stderr else ""

            # Parse test counts from output (framework-specific)
            test_count, failed_count = self._parse_test_counts(output + error_output)

            return AutoFixTestResult(
                executed=True,
                passed=passed,
                output=output + "\n" + error_output,
                error=error_output if not passed else None,
                duration=duration,
                test_count=test_count,
                failed_count=failed_count,
            )

        except Exception as e:
            debug_error("auto_fix_loop", f"Test execution failed: {e}")
            return AutoFixTestResult(
                executed=False,
                passed=False,
                output="",
                error=str(e),
                duration=time.time() - start_time,
            )

    def _parse_test_counts(self, output: str) -> tuple[int, int]:
        """
        Parse test counts from test output.

        Returns:
            (total_tests, failed_tests)
        """
        import re

        # Try jest/vitest format first: "Tests: 2 failed, 5 passed, 7 total" or "Tests: 5 passed, 7 total"
        jest_match = re.search(
            r"Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total",
            output,
            re.IGNORECASE,
        )
        if jest_match:
            failed = int(jest_match.group(1)) if jest_match.group(1) else 0
            total = int(jest_match.group(3))
            return total, failed

        # Try pytest format: "5 passed, 2 failed"
        pytest_match = re.search(
            r"(\d+)\s+passed(?:,\s+(\d+)\s+failed)?", output, re.IGNORECASE
        )
        if pytest_match:
            passed = int(pytest_match.group(1))
            failed = int(pytest_match.group(2)) if pytest_match.group(2) else 0
            return passed + failed, failed

        # Default: assume some tests ran if output contains test-related keywords
        if any(
            keyword in output.lower()
            for keyword in ["test", "spec", "pass", "fail", "error"]
        ):
            return 1, 1 if "fail" in output.lower() else 0

        return 0, 0

    def _analyze_failure(self, test_result: AutoFixTestResult) -> str:
        """
        Analyze test failure to identify error pattern.

        Returns:
            Error pattern identifier
        """
        output = test_result.output.lower()

        # Common error patterns
        if "assertion" in output or "expected" in output:
            return "assertion_failure"
        elif "timeout" in output:
            return "timeout"
        elif "syntax" in output or "syntaxerror" in output:
            return "syntax_error"
        elif "import" in output or "module" in output:
            return "import_error"
        elif "type" in output and "error" in output:
            return "type_error"
        elif "undefined" in output or "is not defined" in output:
            return "undefined_error"
        elif "null" in output or "none" in output:
            return "null_pointer"
        else:
            return "general_failure"

    def _create_fix_request(
        self, test_result: AutoFixTestResult, error_pattern: str, memory_context: str
    ) -> None:
        """Create QA_FIX_REQUEST.md for the fixer agent."""
        fix_request_file = self.spec_dir / "QA_FIX_REQUEST.md"

        content = f"""# Auto-Fix Request

## Test Execution Failed

The automated tests have failed. Please analyze the test output below and apply fixes to make the tests pass.

### Test Command
```bash
{self.test_info.test_command}
```

### Test Results
- **Status**: FAILED
- **Failed Tests**: {test_result.failed_count}/{test_result.test_count}
- **Error Pattern**: {error_pattern}
- **Duration**: {test_result.duration:.2f}s

### Test Output
```
{test_result.output}
```

### Error Details
```
{test_result.error or "See output above"}
```

### Memory Context - Common Patterns
{memory_context}

### Instructions
1. Analyze the test failures carefully
2. Identify the root cause of the failures
3. Apply minimal fixes to make tests pass
4. Ensure fixes don't break existing functionality
5. Update implementation_plan.json with fixes_applied status

**IMPORTANT**: Focus on fixing the actual code issues, not just the tests.
"""

        fix_request_file.write_text(content, encoding="utf-8")
        debug("auto_fix_loop", "Created fix request file", path=str(fix_request_file))

    async def _apply_fix(self, attempt_number: int) -> tuple[str, str]:
        """
        Apply fix using QA fixer agent.

        Wraps the session in the shared rate-limit shield: if the LLM call hits
        a rate-limit, we pause until the quota window resets and retry the same
        attempt rather than burning one of the limited attempts on a 429.
        """
        from services.rate_limit_shield import (
            handle_prompt_too_long,
            handle_rate_limit_pause,
        )

        # Get model and thinking budget
        qa_model = get_phase_model(self.spec_dir, "qa", self.model)
        fixer_thinking_budget = get_phase_thinking_budget(self.spec_dir, "qa")

        while True:
            # Create client using the provider-agnostic factory
            fix_client = create_agent_client(
                project_dir=self.project_dir,
                spec_dir=self.spec_dir,
                model=qa_model,
                agent_type="qa_fixer",
                max_thinking_tokens=fixer_thinking_budget,
            )

            try:
                async with fix_client:
                    fix_status, fix_response = await run_qa_fixer_session(
                        fix_client,
                        self.spec_dir,
                        attempt_number,
                        self.verbose,
                        self.project_dir,
                    )
                return fix_status, fix_response
            except Exception as e:
                # Prompt-too-long is a permanent failure; stop retrying and
                # surface a "reset conversation / switch provider" choice
                # to the user via the halt marker file.
                if handle_prompt_too_long(e, self.spec_dir, "auto_fix"):
                    raise
                if await handle_rate_limit_pause(e, self.spec_dir, "auto_fix"):
                    # Shield paused-and-resumed; retry the same attempt.
                    continue
                raise

    async def _load_memory_context(self) -> str:
        """Load memory context about common test failures."""
        try:
            task_data = {
                "description": "Analyzing common test failure patterns for auto-fix",
                "id": f"auto_fix_{self.spec_dir.name}",
            }
            memory_context = await get_graphiti_context(
                self.spec_dir, self.project_dir, task_data
            )

            if memory_context:
                debug_success("auto_fix_loop", "Loaded memory context for auto-fix")
                return memory_context
            else:
                return "No historical patterns found."
        except Exception as e:
            debug_error("auto_fix_loop", f"Failed to load memory context: {e}")
            return "Memory context unavailable."

    async def _save_success_to_memory(self, attempts: int, memory_context: str) -> None:
        """Save successful fix to memory for learning."""
        try:
            if not self.attempts:
                return

            # Get the last attempt that succeeded
            last_attempt = self.attempts[-1]

            episode_data = {
                "type": "AUTO_FIX_SUCCESS",
                "attempts": attempts,
                "error_pattern": last_attempt.error_pattern,
                "duration": last_attempt.duration,
                "test_framework": (
                    self.test_info.frameworks[0].name
                    if self.test_info.frameworks
                    else "unknown"
                ),
                "context": memory_context,
            }

            await save_session_memory(
                self.spec_dir,
                self.project_dir,
                {"id": f"auto_fix_success_{self.spec_dir.name}"},
                json.dumps(episode_data),
            )

            debug_success("auto_fix_loop", "Saved success to memory")
        except Exception as e:
            debug_error("auto_fix_loop", f"Failed to save success to memory: {e}")

    async def _save_failure_to_memory(self, attempts: int, memory_context: str) -> None:
        """Save failure to memory for learning."""
        try:
            if not self.attempts:
                return

            episode_data = {
                "type": "AUTO_FIX_FAILURE",
                "attempts": attempts,
                "error_patterns": [a.error_pattern for a in self.attempts],
                "context": memory_context,
            }

            await save_session_memory(
                self.spec_dir,
                self.project_dir,
                {"id": f"auto_fix_failure_{self.spec_dir.name}"},
                json.dumps(episode_data),
            )

            debug_success("auto_fix_loop", "Saved failure to memory")
        except Exception as e:
            debug_error("auto_fix_loop", f"Failed to save failure to memory: {e}")

    def _update_metrics(self, success: bool, attempts: int) -> None:
        """Update auto-fix metrics in implementation_plan.json."""
        try:
            plan_file = self.spec_dir / "implementation_plan.json"
            if not plan_file.exists():
                debug_warning(
                    "auto_fix_loop",
                    "implementation_plan.json not found, skipping metrics",
                )
                return

            plan = json.loads(plan_file.read_text(encoding="utf-8"))

            if "auto_fix_stats" not in plan:
                plan["auto_fix_stats"] = {
                    "total_runs": 0,
                    "successful_runs": 0,
                    "total_attempts": 0,
                    "success_rate": 0.0,
                    "average_attempts": 0.0,
                    "runs": [],
                }

            stats = plan["auto_fix_stats"]
            stats["total_runs"] += 1
            stats["total_attempts"] += attempts

            if success:
                stats["successful_runs"] += 1

            stats["success_rate"] = (
                stats["successful_runs"] / stats["total_runs"]
                if stats["total_runs"] > 0
                else 0.0
            )
            stats["average_attempts"] = (
                stats["total_attempts"] / stats["total_runs"]
                if stats["total_runs"] > 0
                else 0.0
            )

            # Record this run
            stats["runs"].append(
                {
                    "timestamp": time.time(),
                    "success": success,
                    "attempts": attempts,
                    "duration": sum(a.duration for a in self.attempts),
                }
            )

            # Keep only last 50 runs
            if len(stats["runs"]) > 50:
                stats["runs"] = stats["runs"][-50:]

            plan_file.write_text(json.dumps(plan, indent=2), encoding="utf-8")
            debug_success("auto_fix_loop", "Updated auto-fix metrics")

        except Exception as e:
            debug_error("auto_fix_loop", f"Failed to update metrics: {e}")

    def _escalate_to_human(self) -> None:
        """Escalate to human review after auto-fix failure."""
        try:
            escalation_file = self.spec_dir / "AUTO_FIX_ESCALATION.md"

            # Build summary of attempts
            attempts_summary = "\n".join(
                f"**Attempt {a.attempt_number}**: {a.error_pattern} "
                f"({a.duration:.1f}s, fix_{'applied' if a.fix_applied else 'failed'})"
                for a in self.attempts
            )

            content = f"""# Auto-Fix Escalation

## Auto-Fix Loop Failed

The automated test-fix loop was unable to resolve all test failures after {len(self.attempts)} attempts.

### Summary
- **Max Attempts**: {len(self.attempts)}
- **Test Command**: `{self.test_info.test_command}`
- **Final Status**: FAILED

### Attempt History
{attempts_summary}

### Last Test Output
```
{self.attempts[-1].test_result.output if self.attempts else "No output"}
```

### Next Steps
1. Review the test failures manually
2. Check if tests are flaky or environment-dependent
3. Verify that the implementation is correct
4. Run tests locally: `{self.test_info.test_command}`

### Files to Review
- Implementation: See spec files in `{self.spec_dir}/`
- Test output: Above
- Fix requests: `{self.spec_dir}/QA_FIX_REQUEST.md`

**Manual intervention required.**
"""

            escalation_file.write_text(content, encoding="utf-8")
            debug_success(
                "auto_fix_loop",
                "Created escalation file",
                path=str(escalation_file),
            )

            print(f"\n📋 Escalation report: {escalation_file}")

            # Also emit escalation event
            self.task_event_emitter.emit(
                "AUTO_FIX_ESCALATED",
                {
                    "attempts": len(self.attempts),
                    "escalationFile": str(escalation_file),
                },
            )

        except Exception as e:
            debug_error("auto_fix_loop", f"Failed to create escalation: {e}")


# =============================================================================
# PUBLIC API
# =============================================================================


async def run_auto_fix_loop(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    max_attempts: int = DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
    verbose: bool = False,
) -> bool:
    """
    Run auto-fix loop until tests pass or max attempts reached.

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory
        model: Claude model to use
        max_attempts: Maximum fix attempts (default: 5)
        verbose: Whether to show detailed output

    Returns:
        True if tests pass, False otherwise
    """
    loop = AutoFixLoop(project_dir, spec_dir, model, verbose)
    return await loop.run_until_green(max_attempts)
