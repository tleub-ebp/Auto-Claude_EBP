"""
Wave Executor
=============

Executes a wave of subtasks in parallel, each in its own subprocess.

Each subtask runs as an independent Python process calling the existing
coder agent (run_autonomous_agent). Communication happens via stdout
event markers (__EXEC_PHASE__, __TASK_EVENT__) that are multiplexed
and forwarded to the swarm orchestrator.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .types import SubtaskNode, SubtaskState, SwarmConfig, Wave

logger = logging.getLogger(__name__)

# Marker for swarm-specific events emitted to stdout
SWARM_EVENT_PREFIX = "__SWARM_EVENT__:"


@dataclass
class SubtaskResult:
    """Result of executing a single subtask."""

    subtask_id: str
    success: bool
    duration_seconds: float = 0.0
    error: str | None = None
    worktree_path: Path | None = None


@dataclass
class WaveResult:
    """Aggregated result of executing a wave."""

    wave_index: int
    results: list[SubtaskResult] = field(default_factory=list)
    all_succeeded: bool = True
    duration_seconds: float = 0.0


def emit_swarm_event(event_type: str, payload: dict[str, Any] | None = None) -> None:
    """Emit a swarm event to stdout for frontend parsing."""
    event = {"type": event_type, **(payload or {})}
    try:
        print(f"{SWARM_EVENT_PREFIX}{json.dumps(event, default=str)}", flush=True)
    except (OSError, UnicodeEncodeError):
        pass


class WaveExecutor:
    """
    Executes a wave of subtasks in parallel using asyncio subprocesses.

    Each subtask is executed as a separate Python process running the
    standard coder agent loop, scoped to a single subtask via environment
    variables. Worktrees are created per-subtask for isolation.
    """

    def __init__(
        self,
        project_dir: Path,
        spec_dir: Path,
        config: SwarmConfig,
        python_path: str | None = None,
        source_path: str | None = None,
    ) -> None:
        self.project_dir = Path(project_dir).resolve()
        self.spec_dir = Path(spec_dir).resolve()
        self.config = config
        self.python_path = python_path or sys.executable
        self.source_path = source_path or str(
            Path(__file__).resolve().parent.parent.parent
        )
        self._running_processes: dict[str, asyncio.subprocess.Process] = {}

    async def execute_wave(
        self,
        wave: Wave,
        nodes: dict[str, SubtaskNode],
        on_subtask_started: Any | None = None,
        on_subtask_completed: Any | None = None,
        on_subtask_failed: Any | None = None,
        on_subtask_log: Any | None = None,
    ) -> WaveResult:
        """
        Execute all subtasks in a wave concurrently.

        Args:
            wave: The wave to execute
            nodes: All subtask nodes (for metadata access)
            on_subtask_started: Callback(subtask_id) when a subtask begins
            on_subtask_completed: Callback(subtask_id, result) on success
            on_subtask_failed: Callback(subtask_id, error) on failure
            on_subtask_log: Callback(subtask_id, line) for each log line

        Returns:
            WaveResult with individual subtask results
        """
        wave.state = SubtaskState.RUNNING
        wave.started_at = time.time()

        emit_swarm_event(
            "wave_started",
            {
                "wave_index": wave.index,
                "subtask_ids": wave.subtask_ids,
                "parallelism": len(wave.subtask_ids),
            },
        )

        # Create tasks for all subtasks in the wave. Track the originating
        # subtask_id alongside each task so an exception path can recover the
        # id — `asyncio.gather(..., return_exceptions=True)` returns
        # `Exception` objects with no association back to which task raised.
        tasks: list[Any] = []
        scheduled_ids: list[str] = []
        for subtask_id in wave.subtask_ids:
            node = nodes.get(subtask_id)
            if not node:
                continue
            tasks.append(
                self._execute_subtask(
                    node,
                    on_started=on_subtask_started,
                    on_completed=on_subtask_completed,
                    on_failed=on_subtask_failed,
                    on_log=on_subtask_log,
                )
            )
            scheduled_ids.append(subtask_id)

        # Execute all subtasks concurrently
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Collect results — pair each result with its scheduled subtask_id so
        # retry logic in `_retry_failed_subtasks` can locate the failed node
        # via `nodes.get(sr.subtask_id)` instead of silently dropping.
        wave_result = WaveResult(wave_index=wave.index)
        for subtask_id, result in zip(scheduled_ids, results, strict=True):
            if isinstance(result, Exception):
                wave_result.results.append(
                    SubtaskResult(
                        subtask_id=subtask_id,
                        success=False,
                        error=str(result),
                    )
                )
                wave_result.all_succeeded = False
            elif isinstance(result, SubtaskResult):
                wave_result.results.append(result)
                if not result.success:
                    wave_result.all_succeeded = False

        wave.completed_at = time.time()
        wave.state = (
            SubtaskState.COMPLETED if wave_result.all_succeeded else SubtaskState.FAILED
        )
        wave_result.duration_seconds = (wave.completed_at or 0) - (wave.started_at or 0)

        emit_swarm_event(
            "wave_completed",
            {
                "wave_index": wave.index,
                "all_succeeded": wave_result.all_succeeded,
                "duration_seconds": wave_result.duration_seconds,
                "completed": sum(1 for r in wave_result.results if r.success),
                "failed": sum(1 for r in wave_result.results if not r.success),
            },
        )

        return wave_result

    async def _execute_subtask(
        self,
        node: SubtaskNode,
        on_started: Any | None = None,
        on_completed: Any | None = None,
        on_failed: Any | None = None,
        on_log: Any | None = None,
    ) -> SubtaskResult:
        """Execute a single subtask as a subprocess."""
        node.state = SubtaskState.RUNNING
        node.started_at = time.time()

        if on_started:
            on_started(node.id)

        emit_swarm_event(
            "subtask_started",
            {
                "subtask_id": node.id,
                "description": node.description,
                "wave_index": node.wave_index,
            },
        )

        try:
            result = await self._run_subtask_process(node, on_log)
            node.completed_at = time.time()

            if result.success:
                node.state = SubtaskState.COMPLETED
                if on_completed:
                    on_completed(node.id, result)
            else:
                node.state = SubtaskState.FAILED
                node.error = result.error
                if on_failed:
                    on_failed(node.id, result.error)

            emit_swarm_event(
                "subtask_completed",
                {
                    "subtask_id": node.id,
                    "success": result.success,
                    "duration_seconds": result.duration_seconds,
                    "error": result.error,
                },
            )

            return result

        except Exception as e:
            node.state = SubtaskState.FAILED
            node.completed_at = time.time()
            node.error = str(e)
            logger.error("Subtask %s failed with exception: %s", node.id, e)

            if on_failed:
                on_failed(node.id, str(e))

            return SubtaskResult(
                subtask_id=node.id,
                success=False,
                duration_seconds=(node.completed_at or 0) - (node.started_at or 0),
                error=str(e),
            )

    async def _run_subtask_process(
        self,
        node: SubtaskNode,
        on_log: Any | None = None,
    ) -> SubtaskResult:
        """
        Spawn a Python subprocess to execute the subtask.

        The subprocess runs `run.py --spec {spec_id} --subtask {subtask_id}`
        which scopes the coder agent to a single subtask within the spec.
        """
        spec_name = self.spec_dir.name
        subtask_id = node.id

        # Build command
        run_script = Path(self.source_path) / "run.py"
        args = [
            self.python_path,
            str(run_script),
            "--spec",
            spec_name,
            "--subtask",
            subtask_id,
        ]

        # Environment: inherit parent + swarm-specific vars
        env = dict(os.environ)
        env["SWARM_MODE"] = "1"
        env["SWARM_SUBTASK_ID"] = subtask_id
        env["SWARM_WAVE_INDEX"] = str(node.wave_index)
        env["PYTHONPATH"] = self.source_path

        start = time.time()
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.project_dir),
                env=env,
            )
            self._running_processes[subtask_id] = process
            node.process_pid = process.pid

            # Drain stderr concurrently with stdout. Reading stdout to EOF
            # before touching stderr deadlocks once the child writes more
            # than the OS pipe buffer (~64KB on Linux) to stderr — the kernel
            # blocks the write, the child can't progress, stdout never closes,
            # we wait forever. Spawn a background task that consumes stderr
            # in parallel.
            stderr_chunks: list[bytes] = []

            async def _drain_stderr() -> None:
                if process.stderr is None:
                    return
                async for line in process.stderr:
                    stderr_chunks.append(line)

            stderr_task = asyncio.create_task(_drain_stderr())

            # Stream stdout
            if process.stdout:
                async for line_bytes in process.stdout:
                    line = line_bytes.decode("utf-8", errors="replace").rstrip()
                    if on_log:
                        on_log(subtask_id, line)
                    # Forward phase events with subtask prefix
                    if "__EXEC_PHASE__:" in line or "__TASK_EVENT__:" in line:
                        emit_swarm_event(
                            "subtask_log",
                            {
                                "subtask_id": subtask_id,
                                "line": line,
                            },
                        )

            # Bound the wait so a wedged child cannot stall the entire swarm.
            try:
                await asyncio.wait_for(
                    process.wait(), timeout=self.config.subtask_timeout_seconds
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                stderr_task.cancel()
                raise RuntimeError(
                    f"Subtask {subtask_id} timed out after "
                    f"{self.config.subtask_timeout_seconds}s and was killed"
                )

            await stderr_task
            duration = time.time() - start

            stderr_output = b"".join(stderr_chunks).decode("utf-8", errors="replace")

            success = process.returncode == 0
            error = None
            if not success:
                error = (
                    stderr_output[:500]
                    if stderr_output
                    else f"Exit code {process.returncode}"
                )

            return SubtaskResult(
                subtask_id=subtask_id,
                success=success,
                duration_seconds=duration,
                error=error,
                worktree_path=node.worktree_path,
            )

        finally:
            self._running_processes.pop(subtask_id, None)
            node.process_pid = None

    async def cancel_all(self) -> None:
        """Kill all running subtask processes."""
        for subtask_id, process in list(self._running_processes.items()):
            try:
                process.kill()
                logger.info(
                    "Killed subtask process: %s (pid=%s)", subtask_id, process.pid
                )
            except (OSError, ProcessLookupError):
                pass
        self._running_processes.clear()

    async def cancel_subtask(self, subtask_id: str) -> bool:
        """Kill a specific subtask process."""
        process = self._running_processes.get(subtask_id)
        if process:
            try:
                process.kill()
                return True
            except (OSError, ProcessLookupError):
                return False
        return False
