"""Task Scheduler — Cron-like scheduling engine for WorkPilot AI.

Supports recurring tasks (cron expressions), one-time scheduled execution,
task chaining (run B after A completes), and an intelligent priority queue.

Feature 8.1 — Scheduling de tâches (Cron-like).

Example:
    >>> from apps.backend.scheduling.scheduler import TaskScheduler, ScheduledTask
    >>> scheduler = TaskScheduler()
    >>> task = ScheduledTask(
    ...     task_id="security-scan-daily",
    ...     name="Daily Security Scan",
    ...     cron="0 22 * * *",
    ...     action="security_scan",
    ...     priority=2,
    ... )
    >>> scheduler.add_task(task)
    >>> scheduler.start()
"""

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


# ── Cron expression parser ──────────────────────────────────────────


class CronField(Enum):
    """Cron expression field types."""

    MINUTE = "minute"
    HOUR = "hour"
    DAY_OF_MONTH = "day_of_month"
    MONTH = "month"
    DAY_OF_WEEK = "day_of_week"


CRON_FIELD_RANGES: dict[CronField, tuple[int, int]] = {
    CronField.MINUTE: (0, 59),
    CronField.HOUR: (0, 23),
    CronField.DAY_OF_MONTH: (1, 31),
    CronField.MONTH: (1, 12),
    CronField.DAY_OF_WEEK: (0, 6),
}

CRON_FIELD_ORDER = [
    CronField.MINUTE,
    CronField.HOUR,
    CronField.DAY_OF_MONTH,
    CronField.MONTH,
    CronField.DAY_OF_WEEK,
]


class CronExpression:
    """Parses and evaluates standard 5-field cron expressions.

    Supports: ``*``, ranges (``1-5``), lists (``1,3,5``), steps (``*/15``),
    and combinations thereof.

    Attributes:
        expression: The raw cron expression string.
        fields: Parsed sets of valid values for each field.

    Example:
        >>> cron = CronExpression("*/15 9-17 * * 1-5")
        >>> cron.matches(datetime(2026, 2, 20, 10, 30))
        True
    """

    def __init__(self, expression: str) -> None:
        self.expression = expression.strip()
        self.fields: dict[CronField, set[int]] = {}
        self._parse()

    def _parse(self) -> None:
        """Parse the cron expression into field value sets."""
        parts = self.expression.split()
        if len(parts) != 5:
            raise ValueError(
                f"Cron expression must have 5 fields, got {len(parts)}: "
                f"'{self.expression}'"
            )

        for i, cron_field in enumerate(CRON_FIELD_ORDER):
            min_val, max_val = CRON_FIELD_RANGES[cron_field]
            self.fields[cron_field] = self._parse_field(
                parts[i], min_val, max_val, cron_field.value
            )

    def _parse_field(
        self,
        field_str: str,
        min_val: int,
        max_val: int,
        field_name: str,
    ) -> set[int]:
        """Parse a single cron field into a set of integers.

        Args:
            field_str: The field string (e.g., ``'*/15'``, ``'1-5'``, ``'*'``).
            min_val: The minimum allowed value.
            max_val: The maximum allowed value.
            field_name: The field name for error messages.

        Returns:
            A set of valid integer values.
        """
        values: set[int] = set()

        for part in field_str.split(","):
            part = part.strip()

            if "/" in part:
                # Step value: */15 or 1-30/5
                range_part, step_str = part.split("/", 1)
                step = int(step_str)
                if step <= 0:
                    raise ValueError(f"Invalid step value in {field_name}: {step}")

                if range_part == "*":
                    start, end = min_val, max_val
                elif "-" in range_part:
                    start, end = (int(x) for x in range_part.split("-", 1))
                else:
                    start = int(range_part)
                    end = max_val

                for v in range(start, end + 1, step):
                    if min_val <= v <= max_val:
                        values.add(v)

            elif "-" in part:
                # Range: 1-5
                start, end = (int(x) for x in part.split("-", 1))
                for v in range(start, end + 1):
                    if min_val <= v <= max_val:
                        values.add(v)

            elif part == "*":
                # Wildcard
                values.update(range(min_val, max_val + 1))

            else:
                # Single value
                v = int(part)
                if min_val <= v <= max_val:
                    values.add(v)
                else:
                    raise ValueError(
                        f"Value {v} out of range [{min_val}-{max_val}] for {field_name}"
                    )

        if not values:
            raise ValueError(f"No valid values for {field_name}: '{field_str}'")

        return values

    def matches(self, dt: datetime) -> bool:
        """Check if a datetime matches this cron expression.

        Args:
            dt: The datetime to test.

        Returns:
            True if the datetime matches.
        """
        # Convert Python weekday (Mon=0..Sun=6) to cron (Sun=0..Sat=6)
        cron_weekday = (dt.weekday() + 1) % 7

        return (
            dt.minute in self.fields[CronField.MINUTE]
            and dt.hour in self.fields[CronField.HOUR]
            and dt.day in self.fields[CronField.DAY_OF_MONTH]
            and dt.month in self.fields[CronField.MONTH]
            and cron_weekday in self.fields[CronField.DAY_OF_WEEK]
        )

    def next_occurrence(self, after: datetime | None = None) -> datetime:
        """Find the next datetime that matches this cron expression.

        Args:
            after: Start searching after this datetime. Defaults to now.

        Returns:
            The next matching datetime (minute precision).
        """
        if after is None:
            after = datetime.now(timezone.utc)

        # Start from the next minute
        candidate = after.replace(second=0, microsecond=0) + timedelta(minutes=1)

        # Search up to 2 years ahead to avoid infinite loops
        max_iterations = 366 * 24 * 60  # ~1 year in minutes
        for _ in range(max_iterations):
            if self.matches(candidate):
                return candidate
            candidate += timedelta(minutes=1)

        raise RuntimeError(
            f"Could not find next occurrence for '{self.expression}' "
            f"within search range."
        )

    def __repr__(self) -> str:
        return f"CronExpression('{self.expression}')"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, CronExpression):
            return self.expression == other.expression
        return NotImplemented


# ── Task status ─────────────────────────────────────────────────────


class TaskStatus(Enum):
    """Status of a scheduled task."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


# ── Scheduled task ──────────────────────────────────────────────────


@dataclass
class ScheduledTask:
    """A task that can be scheduled for execution.

    Attributes:
        task_id: Unique identifier for the task.
        name: Human-readable task name.
        action: The action identifier or callable to execute.
        cron: Optional cron expression for recurring execution.
        run_at: Optional specific datetime for one-time execution.
        priority: Priority level (1=highest, 10=lowest). Default 5.
        enabled: Whether the task is active.
        metadata: Additional task metadata.
        max_retries: Maximum number of retries on failure.
        retry_count: Current retry count.
        status: Current task status.
        last_run: Datetime of the last execution.
        next_run: Datetime of the next scheduled execution.
        created_at: Datetime when the task was created.
        chain_after: Task ID to wait for before running.
        tags: Tags for filtering and grouping.
    """

    task_id: str = ""
    name: str = ""
    action: str = ""
    cron: str | None = None
    run_at: datetime | None = None
    priority: int = 5
    enabled: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)
    max_retries: int = 0
    retry_count: int = 0
    status: TaskStatus = TaskStatus.PENDING
    last_run: datetime | None = None
    next_run: datetime | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    chain_after: str | None = None
    tags: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.task_id:
            self.task_id = str(uuid.uuid4())[:8]
        self._compute_next_run()

    def _compute_next_run(self) -> None:
        """Compute the next run time based on cron or run_at."""
        if self.cron:
            try:
                cron_expr = CronExpression(self.cron)
                self.next_run = cron_expr.next_occurrence()
            except (ValueError, RuntimeError) as e:
                logger.warning(
                    "Invalid cron '%s' for task '%s': %s", self.cron, self.task_id, e
                )
                self.next_run = None
        elif self.run_at and self.run_at > datetime.now(timezone.utc):
            self.next_run = self.run_at

    @property
    def is_recurring(self) -> bool:
        """Check if this is a recurring task."""
        return self.cron is not None

    @property
    def is_due(self) -> bool:
        """Check if the task is due for execution."""
        if not self.enabled or self.status in (
            TaskStatus.RUNNING,
            TaskStatus.CANCELLED,
        ):
            return False
        if self.next_run is None:
            return False
        now = datetime.now(timezone.utc)
        return now >= self.next_run

    def mark_running(self) -> None:
        """Mark the task as currently running."""
        self.status = TaskStatus.RUNNING
        self.last_run = datetime.now(timezone.utc)

    def mark_completed(self) -> None:
        """Mark the task as completed and schedule next run if recurring."""
        self.status = TaskStatus.COMPLETED
        self.retry_count = 0
        if self.is_recurring and self.cron:
            try:
                cron_expr = CronExpression(self.cron)
                self.next_run = cron_expr.next_occurrence()
                self.status = TaskStatus.PENDING
            except (ValueError, RuntimeError):
                self.next_run = None

    def mark_failed(self, error: str = "") -> None:
        """Mark the task as failed, with optional retry."""
        self.retry_count += 1
        if self.retry_count <= self.max_retries:
            self.status = TaskStatus.PENDING
            # Exponential backoff: 2^retry minutes
            backoff = timedelta(minutes=2**self.retry_count)
            self.next_run = datetime.now(timezone.utc) + backoff
            logger.info(
                "Task '%s' failed (attempt %d/%d), retrying at %s: %s",
                self.task_id,
                self.retry_count,
                self.max_retries,
                self.next_run,
                error,
            )
        else:
            self.status = TaskStatus.FAILED
            logger.error(
                "Task '%s' permanently failed after %d attempts: %s",
                self.task_id,
                self.retry_count,
                error,
            )

    def to_dict(self) -> dict[str, Any]:
        """Serialize the task to a dictionary."""
        return {
            "task_id": self.task_id,
            "name": self.name,
            "action": self.action,
            "cron": self.cron,
            "run_at": self.run_at.isoformat() if self.run_at else None,
            "priority": self.priority,
            "enabled": self.enabled,
            "metadata": self.metadata,
            "max_retries": self.max_retries,
            "retry_count": self.retry_count,
            "status": self.status.value,
            "last_run": self.last_run.isoformat() if self.last_run else None,
            "next_run": self.next_run.isoformat() if self.next_run else None,
            "created_at": self.created_at.isoformat(),
            "chain_after": self.chain_after,
            "tags": self.tags,
        }


# ── Task chain ──────────────────────────────────────────────────────


@dataclass
class TaskChain:
    """A chain of tasks to execute sequentially.

    When one task completes, the next in the chain is triggered.

    Attributes:
        chain_id: Unique chain identifier.
        name: Human-readable chain name.
        task_ids: Ordered list of task IDs.
        current_index: Index of the current task in the chain.
        status: Chain status.
        stop_on_failure: Whether to halt the chain on task failure.
    """

    chain_id: str = ""
    name: str = ""
    task_ids: list[str] = field(default_factory=list)
    current_index: int = 0
    status: TaskStatus = TaskStatus.PENDING
    stop_on_failure: bool = True

    def __post_init__(self) -> None:
        if not self.chain_id:
            self.chain_id = f"chain-{uuid.uuid4().hex[:8]}"

    @property
    def current_task_id(self) -> str | None:
        """Get the current task ID in the chain."""
        if 0 <= self.current_index < len(self.task_ids):
            return self.task_ids[self.current_index]
        return None

    @property
    def is_complete(self) -> bool:
        """Check if all tasks in the chain have been processed."""
        return self.current_index >= len(self.task_ids)

    def advance(self) -> str | None:
        """Move to the next task in the chain.

        Returns:
            The next task ID, or None if the chain is complete.
        """
        self.current_index += 1
        if self.is_complete:
            self.status = TaskStatus.COMPLETED
            return None
        return self.current_task_id

    def to_dict(self) -> dict[str, Any]:
        """Serialize the chain to a dictionary."""
        return {
            "chain_id": self.chain_id,
            "name": self.name,
            "task_ids": self.task_ids,
            "current_index": self.current_index,
            "status": self.status.value,
            "stop_on_failure": self.stop_on_failure,
        }


# ── Task queue ──────────────────────────────────────────────────────


class TaskQueue:
    """Priority queue for scheduled tasks.

    Tasks are ordered by priority (lower number = higher priority),
    then by next_run time.

    Attributes:
        _tasks: Internal list of tasks sorted by priority.
        _lock: Thread lock for concurrent access.
    """

    def __init__(self) -> None:
        self._tasks: list[ScheduledTask] = []
        self._lock = threading.Lock()

    def push(self, task: ScheduledTask) -> None:
        """Add a task to the queue.

        Args:
            task: The task to add.
        """
        with self._lock:
            self._tasks.append(task)
            self._sort()

    def pop(self) -> ScheduledTask | None:
        """Remove and return the highest-priority due task.

        Returns:
            The next due task, or None if no tasks are due.
        """
        with self._lock:
            for i, task in enumerate(self._tasks):
                if task.is_due:
                    return self._tasks.pop(i)
            return None

    def peek(self) -> ScheduledTask | None:
        """Return the highest-priority due task without removing it.

        Returns:
            The next due task, or None.
        """
        with self._lock:
            for task in self._tasks:
                if task.is_due:
                    return task
            return None

    def remove(self, task_id: str) -> bool:
        """Remove a task by ID.

        Args:
            task_id: The task ID to remove.

        Returns:
            True if the task was found and removed.
        """
        with self._lock:
            for i, task in enumerate(self._tasks):
                if task.task_id == task_id:
                    self._tasks.pop(i)
                    return True
            return False

    def get(self, task_id: str) -> ScheduledTask | None:
        """Get a task by ID without removing it.

        Args:
            task_id: The task ID.

        Returns:
            The task, or None if not found.
        """
        with self._lock:
            for task in self._tasks:
                if task.task_id == task_id:
                    return task
            return None

    def list_all(self) -> list[ScheduledTask]:
        """Return all tasks in priority order.

        Returns:
            A copy of the task list.
        """
        with self._lock:
            return list(self._tasks)

    def list_due(self) -> list[ScheduledTask]:
        """Return all tasks that are currently due.

        Returns:
            List of due tasks.
        """
        with self._lock:
            return [t for t in self._tasks if t.is_due]

    def pop_all_due(self) -> list[ScheduledTask]:
        """Atomically remove and return all due tasks.

        The previous tick() pattern called list_due() (snapshot under lock)
        then remove(task.task_id) per task (re-acquiring the lock each
        time). Between snapshot and remove, the queue could be mutated by
        add_task / remove_task / a manual second tick(), causing
        double-execution of the same task or lost-update on next_run.
        """
        with self._lock:
            due: list[ScheduledTask] = []
            remaining: list[ScheduledTask] = []
            for task in self._tasks:
                if task.is_due:
                    due.append(task)
                else:
                    remaining.append(task)
            self._tasks = remaining
            return due

    @property
    def size(self) -> int:
        """Number of tasks in the queue."""
        with self._lock:
            return len(self._tasks)

    def _sort(self) -> None:
        """Sort tasks by priority then next_run time."""
        self._tasks.sort(
            key=lambda t: (
                t.priority,
                t.next_run or datetime.max.replace(tzinfo=timezone.utc),
            )
        )


# ── Task scheduler ──────────────────────────────────────────────────


class TaskScheduler:
    """Main scheduler engine that manages task lifecycle.

    Supports adding, removing, pausing, and executing scheduled tasks.
    Runs a background thread that checks for due tasks at regular intervals.

    Attributes:
        _queue: The task priority queue.
        _chains: Registered task chains.
        _action_handlers: Mapping of action names to handler callables.
        _running: Whether the scheduler loop is active.
        _thread: The background scheduler thread.
        _check_interval: Seconds between queue checks.

    Example:
        >>> scheduler = TaskScheduler()
        >>> scheduler.register_handler("security_scan", my_scan_function)
        >>> scheduler.add_task(ScheduledTask(
        ...     name="Nightly Scan",
        ...     cron="0 22 * * *",
        ...     action="security_scan",
        ... ))
        >>> scheduler.start()
    """

    def __init__(self, check_interval: int = 30) -> None:
        """Initialize the scheduler.

        Args:
            check_interval: Seconds between checks for due tasks.
        """
        self._queue = TaskQueue()
        self._chains: dict[str, TaskChain] = {}
        self._action_handlers: dict[str, Callable[..., Any]] = {}
        self._running = False
        self._thread: threading.Thread | None = None
        self._check_interval = check_interval
        self._execution_log: list[dict[str, Any]] = []
        # Heartbeat: updated at the end of every tick so callers can detect
        # a wedged loop (alive thread but no progress).
        self._last_tick_at: float | None = None

    # ── Task management ─────────────────────────────────────────

    def add_task(self, task: ScheduledTask) -> ScheduledTask:
        """Add a task to the scheduler.

        Args:
            task: The task to schedule.

        Returns:
            The scheduled task (with computed next_run).
        """
        logger.info(
            "Adding task '%s' (%s) — next run: %s",
            task.name,
            task.task_id,
            task.next_run,
        )
        self._queue.push(task)
        return task

    def remove_task(self, task_id: str) -> bool:
        """Remove a task from the scheduler.

        Args:
            task_id: The task ID to remove.

        Returns:
            True if the task was removed.
        """
        removed = self._queue.remove(task_id)
        if removed:
            logger.info("Removed task '%s'.", task_id)
        return removed

    def pause_task(self, task_id: str) -> bool:
        """Pause a scheduled task.

        Args:
            task_id: The task ID to pause.

        Returns:
            True if the task was paused.
        """
        task = self._queue.get(task_id)
        if task:
            task.enabled = False
            task.status = TaskStatus.PAUSED
            logger.info("Paused task '%s'.", task_id)
            return True
        return False

    def resume_task(self, task_id: str) -> bool:
        """Resume a paused task.

        Args:
            task_id: The task ID to resume.

        Returns:
            True if the task was resumed.
        """
        task = self._queue.get(task_id)
        if task and task.status == TaskStatus.PAUSED:
            task.enabled = True
            task.status = TaskStatus.PENDING
            task._compute_next_run()
            logger.info("Resumed task '%s'.", task_id)
            return True
        return False

    def get_task(self, task_id: str) -> ScheduledTask | None:
        """Get a task by ID.

        Args:
            task_id: The task ID.

        Returns:
            The task, or None if not found.
        """
        return self._queue.get(task_id)

    def list_tasks(self, tag: str | None = None) -> list[ScheduledTask]:
        """List all scheduled tasks, optionally filtered by tag.

        Args:
            tag: Optional tag to filter by.

        Returns:
            List of tasks.
        """
        tasks = self._queue.list_all()
        if tag:
            tasks = [t for t in tasks if tag in t.tags]
        return tasks

    # ── Chain management ────────────────────────────────────────

    def add_chain(self, chain: TaskChain) -> TaskChain:
        """Register a task chain.

        Args:
            chain: The chain to register.

        Returns:
            The registered chain.
        """
        self._chains[chain.chain_id] = chain
        logger.info(
            "Registered chain '%s' with %d tasks.",
            chain.chain_id,
            len(chain.task_ids),
        )

        # Enable the first task in the chain
        first_id = chain.current_task_id
        if first_id:
            task = self._queue.get(first_id)
            if task:
                task.enabled = True
                task._compute_next_run()

        return chain

    def _handle_chain_progression(self, completed_task_id: str) -> None:
        """Progress any chain that includes the completed task.

        Args:
            completed_task_id: The ID of the task that just completed.
        """
        for chain in self._chains.values():
            if chain.current_task_id == completed_task_id:
                next_id = chain.advance()
                if next_id:
                    next_task = self._queue.get(next_id)
                    if next_task:
                        next_task.enabled = True
                        next_task.next_run = datetime.now(timezone.utc)
                        logger.info(
                            "Chain '%s': advancing to task '%s'.",
                            chain.chain_id,
                            next_id,
                        )
                else:
                    logger.info("Chain '%s' completed.", chain.chain_id)

    # ── Action handlers ─────────────────────────────────────────

    def register_handler(self, action: str, handler: Callable[..., Any]) -> None:
        """Register a handler function for an action type.

        Args:
            action: The action identifier.
            handler: The callable to execute.
        """
        self._action_handlers[action] = handler
        logger.info("Registered handler for action '%s'.", action)

    # ── Execution ───────────────────────────────────────────────

    def execute_task(self, task: ScheduledTask) -> dict[str, Any]:
        """Execute a single task.

        Args:
            task: The task to execute.

        Returns:
            Execution result dictionary.
        """
        task.mark_running()
        result: dict[str, Any] = {
            "task_id": task.task_id,
            "action": task.action,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "success": False,
        }

        handler = self._action_handlers.get(task.action)
        if not handler:
            error_msg = f"No handler registered for action '{task.action}'"
            logger.warning(error_msg)
            task.mark_failed(error_msg)
            result["error"] = error_msg
            self._execution_log.append(result)
            return result

        try:
            output = handler(task.metadata)
            task.mark_completed()
            result["success"] = True
            result["output"] = output
            result["completed_at"] = datetime.now(timezone.utc).isoformat()

            # Handle chain progression
            self._handle_chain_progression(task.task_id)

        except Exception as e:
            error_msg = str(e)
            task.mark_failed(error_msg)
            result["error"] = error_msg
            logger.exception("Task '%s' execution failed.", task.task_id)

        self._execution_log.append(result)
        return result

    def tick(self) -> list[dict[str, Any]]:
        """Check for due tasks and execute them.

        This is the main loop body. Called periodically by the
        background thread or manually for testing.

        Returns:
            List of execution results from this tick.
        """
        results: list[dict[str, Any]] = []
        # Atomic drain: snapshot + remove happens under a single lock so a
        # concurrent tick() / add_task / remove_task cannot cause the same
        # task to be popped twice or a recurring task to be lost.
        due_tasks = self._queue.pop_all_due()

        for task in due_tasks:
            result = self.execute_task(task)
            results.append(result)

            # Re-add to queue if still active (recurring tasks)
            if task.status == TaskStatus.PENDING and task.next_run:
                self._queue.push(task)

        return results

    # ── Background loop ─────────────────────────────────────────

    def start(self) -> None:
        """Start the background scheduler thread."""
        if self._running:
            logger.warning("Scheduler is already running.")
            return

        self._running = True
        self._thread = threading.Thread(
            target=self._run_loop,
            name="TaskScheduler",
            daemon=True,
        )
        self._thread.start()
        logger.info("Scheduler started (interval=%ds).", self._check_interval)

    def stop(self) -> None:
        """Stop the background scheduler thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=self._check_interval + 5)
            self._thread = None
        logger.info("Scheduler stopped.")

    @property
    def is_running(self) -> bool:
        """Whether the scheduler loop is active.

        Cross-checks the thread state in addition to the `_running` flag —
        without this, a non-Exception (SystemExit, MemoryError, etc.) that
        kills the thread leaves `_running=True`, so callers think
        scheduling still works while no tasks ever fire.
        """
        if not self._running:
            return False
        if self._thread is not None and not self._thread.is_alive():
            return False
        return True

    @property
    def last_tick_at(self) -> float | None:
        """Unix timestamp of the most recent tick, or None if never ticked.

        Callers can compare against `time.time()` to detect a wedged loop
        even when the thread is technically alive but blocked.
        """
        return self._last_tick_at

    def _run_loop(self) -> None:
        """Background loop that checks and executes due tasks."""
        try:
            while self._running:
                try:
                    self.tick()
                except Exception:
                    logger.exception("Error in scheduler tick.")
                self._last_tick_at = time.time()
                time.sleep(self._check_interval)
        finally:
            # Mark not-running so callers don't think the loop is alive
            # after a fatal exit (SystemExit, KeyboardInterrupt in worker
            # context, etc.). Without this `is_running` returned True
            # forever and the UI showed "scheduler running" while no tasks
            # ever fired.
            self._running = False
            logger.info("Scheduler background loop exited.")

    # ── Reporting ───────────────────────────────────────────────

    def get_execution_log(self, limit: int = 50) -> list[dict[str, Any]]:
        """Get recent execution history.

        Args:
            limit: Maximum entries to return.

        Returns:
            List of execution result dictionaries.
        """
        return self._execution_log[-limit:]

    def get_stats(self) -> dict[str, Any]:
        """Get scheduler statistics.

        Returns:
            Dictionary with queue size, running status, and counts.
        """
        tasks = self._queue.list_all()
        return {
            "running": self._running,
            "total_tasks": len(tasks),
            "pending_tasks": sum(1 for t in tasks if t.status == TaskStatus.PENDING),
            "due_tasks": len(self._queue.list_due()),
            "paused_tasks": sum(1 for t in tasks if t.status == TaskStatus.PAUSED),
            "chains": len(self._chains),
            "executions_total": len(self._execution_log),
            "check_interval": self._check_interval,
        }
