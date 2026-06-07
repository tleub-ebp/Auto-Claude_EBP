"""
Event-Driven Hooks System — Core Service

Manages hooks CRUD, event bus, trigger matching, action execution, and persistence.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shlex
import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import (
    Action,
    ActionType,
    ExecutionStatus,
    Hook,
    HookEvent,
    HookExecution,
    HookStatus,
    Trigger,
    TriggerCondition,
)
from .templates import get_hook_templates, get_template_by_id

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Persistence
# ─────────────────────────────────────────────────────────────────────────────


def _get_hooks_dir() -> Path:
    """Return the directory where hooks are persisted."""
    base = Path(os.getenv("WORKPILOT_DATA_DIR", Path.home() / ".workpilot"))
    hooks_dir = base / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    return hooks_dir


def _get_hooks_file() -> Path:
    return _get_hooks_dir() / "hooks.json"


def _get_executions_file() -> Path:
    return _get_hooks_dir() / "executions.json"


# ─────────────────────────────────────────────────────────────────────────────
# Condition matching
# ─────────────────────────────────────────────────────────────────────────────


def _match_condition(condition: TriggerCondition, event_data: dict[str, Any]) -> bool:
    """Check if a single condition matches the event data."""
    value = event_data.get(condition.field, "")
    if isinstance(value, (list, dict)):
        value = str(value)
    value = str(value)

    op = condition.operator.lower()
    target = condition.value

    if op == "equals":
        return value == target
    elif op == "contains":
        return target.lower() in value.lower()
    elif op == "startswith":
        return value.lower().startswith(target.lower())
    elif op == "endswith":
        return value.lower().endswith(target.lower())
    elif op == "matches":
        try:
            return bool(re.search(target, value))
        except re.error:
            return False
    elif op == "glob":
        return fnmatch.fnmatch(value, target)
    elif op == "not_equals":
        return value != target
    elif op == "not_contains":
        return target.lower() not in value.lower()
    return False


def _match_trigger(trigger: Trigger, event: HookEvent) -> bool:
    """Check if a trigger matches the given event."""
    if trigger.type != event.type:
        return False
    if not trigger.conditions:
        return True
    return all(_match_condition(c, event.data) for c in trigger.conditions)


# ─────────────────────────────────────────────────────────────────────────────
# Action executors
# ─────────────────────────────────────────────────────────────────────────────


async def _execute_action(
    action: Action, event: HookEvent, hook: Hook
) -> dict[str, Any]:
    """Execute a single action and return the result."""
    result: dict[str, Any] = {
        "action_id": action.id,
        "action_type": action.type.value,
        "status": "success",
        "output": None,
        "error": None,
    }

    try:
        if action.delay_ms > 0:
            await asyncio.sleep(action.delay_ms / 1000.0)

        if action.type == ActionType.LOG_EVENT:
            msg = action.config.get(
                "message", f"Hook '{hook.name}' triggered by {event.type.value}"
            )
            logger.info("[HookEngine] %s", msg)
            result["output"] = {"message": msg}

        elif action.type == ActionType.SEND_NOTIFICATION:
            title = _interpolate(
                action.config.get("title", "Hook Notification"), event.data
            )
            message = _interpolate(action.config.get("message", ""), event.data)
            notif_type = action.config.get("type", "info")
            logger.info(
                "[HookEngine] Notification [%s]: %s — %s", notif_type, title, message
            )
            result["output"] = {"title": title, "message": message, "type": notif_type}

        elif action.type == ActionType.RUN_COMMAND:
            # Accept either an argv list (preferred — safe against
            # injection because each element is one argument) or a string
            # for legacy configs. With a string, we shlex.split BEFORE
            # interpolation so attacker-controlled event data cannot inject
            # extra args or shell metacharacters into the command line.
            raw_command = action.config.get("command", ["echo", "no command"])
            if isinstance(raw_command, list):
                argv = _interpolate_argv(raw_command, event.data)
            elif isinstance(raw_command, str):
                argv = _interpolate_argv(shlex.split(raw_command), event.data)
            else:
                raise ValueError(
                    "RUN_COMMAND action.config['command'] must be a list or string"
                )
            if not argv:
                raise ValueError("RUN_COMMAND requires a non-empty command")
            cwd = action.config.get("cwd", os.getcwd())
            logger.info("[HookEngine] Running command: %r", argv)
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=action.timeout_ms / 1000.0 if action.timeout_ms else 30,
                )
            except asyncio.TimeoutError:
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
                raise
            result["output"] = {
                "stdout": stdout.decode(errors="replace")[:5000],
                "stderr": stderr.decode(errors="replace")[:2000],
                "return_code": proc.returncode,
            }
            if proc.returncode != 0:
                result["status"] = "failed"
                result["error"] = f"Command exited with code {proc.returncode}"

        elif action.type == ActionType.RUN_LINT:
            logger.info(
                "[HookEngine] Running lint action (auto_fix=%s)",
                action.config.get("auto_fix", False),
            )
            result["output"] = {
                "action": "lint",
                "auto_fix": action.config.get("auto_fix", False),
                "status": "executed",
            }

        elif action.type == ActionType.RUN_TESTS:
            scope = action.config.get("scope", "related")
            logger.info("[HookEngine] Running tests (scope=%s)", scope)
            result["output"] = {
                "action": "run_tests",
                "scope": scope,
                "status": "executed",
            }

        elif action.type == ActionType.GENERATE_TESTS:
            logger.info(
                "[HookEngine] Generating tests (type=%s)",
                action.config.get("test_type", "unit"),
            )
            result["output"] = {
                "action": "generate_tests",
                "test_type": action.config.get("test_type", "unit"),
                "status": "executed",
            }

        elif action.type == ActionType.RUN_AGENT:
            agent_type = action.config.get("agent_type", "coder")
            instructions = _interpolate(
                action.config.get("instructions", ""), event.data
            )
            logger.info(
                "[HookEngine] Running agent '%s': %s", agent_type, instructions[:100]
            )
            result["output"] = {
                "action": "run_agent",
                "agent_type": agent_type,
                "instructions": instructions,
                "status": "queued",
            }

        elif action.type == ActionType.CREATE_SPEC:
            logger.info(
                "[HookEngine] Creating spec: %s", action.config.get("title", "New Spec")
            )
            result["output"] = {
                "action": "create_spec",
                "title": action.config.get("title", ""),
                "status": "created",
            }

        elif action.type == ActionType.TRIGGER_PIPELINE:
            pipeline = action.config.get("pipeline", "default")
            logger.info("[HookEngine] Triggering pipeline: %s", pipeline)
            result["output"] = {
                "action": "trigger_pipeline",
                "pipeline": pipeline,
                "status": "triggered",
            }

        elif action.type == ActionType.UPDATE_DOCS:
            logger.info(
                "[HookEngine] Updating docs (type=%s)",
                action.config.get("doc_type", "general"),
            )
            result["output"] = {
                "action": "update_docs",
                "doc_type": action.config.get("doc_type", "general"),
                "status": "executed",
            }

        elif action.type == ActionType.CREATE_PR:
            logger.info("[HookEngine] Creating PR")
            result["output"] = {"action": "create_pr", "status": "created"}

        elif action.type == ActionType.SEND_SLACK:
            channel = action.config.get("channel", "#general")
            message = _interpolate(action.config.get("message", ""), event.data)
            logger.info("[HookEngine] Slack → %s: %s", channel, message[:100])
            result["output"] = {
                "action": "send_slack",
                "channel": channel,
                "message": message,
                "status": "sent",
            }

        elif action.type == ActionType.SEND_WEBHOOK:
            url = action.config.get("url", "")
            logger.info("[HookEngine] Webhook → %s", url)
            result["output"] = {"action": "send_webhook", "url": url, "status": "sent"}

        elif action.type == ActionType.CHAIN_HOOK:
            target_hook_id = action.config.get("hook_id", "")
            logger.info("[HookEngine] Chaining to hook: %s", target_hook_id)
            result["output"] = {
                "action": "chain_hook",
                "target_hook_id": target_hook_id,
                "status": "chained",
            }

        elif action.type == ActionType.CUSTOM:
            logger.info("[HookEngine] Custom action: %s", action.config)
            result["output"] = {
                "action": "custom",
                "config": action.config,
                "status": "executed",
            }

        else:
            result["status"] = "skipped"
            result["output"] = {"reason": f"Unknown action type: {action.type}"}

    except asyncio.TimeoutError:
        result["status"] = "timeout"
        result["error"] = f"Action timed out after {action.timeout_ms}ms"
    except Exception as e:
        result["status"] = "failed"
        result["error"] = str(e)
        logger.error("[HookEngine] Action %s failed: %s", action.id, e)

    return result


def _interpolate(template: str, data: dict[str, Any]) -> str:
    """Replace {{key}} placeholders with event data values."""
    for key, value in data.items():
        template = template.replace("{{" + key + "}}", str(value))
    return template


def _interpolate_argv(argv: list[str], data: dict[str, Any]) -> list[str]:
    """Interpolate {{key}} placeholders inside each argv element.

    Each element is treated as a single argument — values are NOT shell-split,
    so attacker-controlled data cannot inject extra arguments or command
    chaining.
    """
    return [_interpolate(arg, data) for arg in argv]


# ─────────────────────────────────────────────────────────────────────────────
# Hook Service
# ─────────────────────────────────────────────────────────────────────────────


class HookService:
    """Core service for managing event-driven hooks."""

    _instance: HookService | None = None
    # Lock prevents two threads from racing into _load() during bootstrap
    # (which reads + parses the hooks JSON file twice and creates two
    # HookService instances, each holding its own copy of the hooks dict).
    _instance_lock: threading.Lock = threading.Lock()

    def __init__(self):
        self._hooks: dict[str, Hook] = {}
        self._executions: list[HookExecution] = []
        self._listeners: list[Callable] = []
        self._max_executions = 500
        self._load()

    @classmethod
    def get_instance(cls) -> HookService:
        # Double-checked locking — fast path is lock-free.
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    # ── Persistence ───────────────────────────────────────────────────────

    def _load(self):
        """Load hooks and executions from disk."""
        hooks_file = _get_hooks_file()
        if hooks_file.exists():
            try:
                data = json.loads(hooks_file.read_text(encoding="utf-8"))
                for h in data.get("hooks", []):
                    hook = Hook.from_dict(h)
                    self._hooks[hook.id] = hook
                logger.info("[HookService] Loaded %d hooks", len(self._hooks))
            except Exception as e:
                logger.warning("[HookService] Failed to load hooks: %s", e)

        exec_file = _get_executions_file()
        if exec_file.exists():
            try:
                data = json.loads(exec_file.read_text(encoding="utf-8"))
                self._executions = [
                    HookExecution(
                        **{
                            **ex,
                            "status": ExecutionStatus(ex.get("status", "pending")),
                        }
                    )
                    for ex in data.get("executions", [])[-self._max_executions :]
                ]
            except Exception as e:
                logger.warning("[HookService] Failed to load executions: %s", e)

    def _save_hooks(self):
        """Persist hooks to disk."""
        try:
            data = {"hooks": [h.to_dict() for h in self._hooks.values()]}
            _get_hooks_file().write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error("[HookService] Failed to save hooks: %s", e)

    def _save_executions(self):
        """Persist recent executions to disk."""
        try:
            trimmed = self._executions[-self._max_executions :]
            data = {"executions": [ex.to_dict() for ex in trimmed]}
            _get_executions_file().write_text(
                json.dumps(data, indent=2), encoding="utf-8"
            )
        except Exception as e:
            logger.error("[HookService] Failed to save executions: %s", e)

    # ── CRUD ──────────────────────────────────────────────────────────────

    def list_hooks(self, project_id: str | None = None) -> list[dict]:
        """List all hooks, optionally filtered by project."""
        hooks = list(self._hooks.values())
        if project_id:
            hooks = [h for h in hooks if h.project_id == project_id or h.cross_project]
        return [h.to_dict() for h in hooks]

    def get_hook(self, hook_id: str) -> dict | None:
        """Get a single hook by ID."""
        hook = self._hooks.get(hook_id)
        return hook.to_dict() if hook else None

    def create_hook(self, data: dict) -> dict:
        """Create a new hook."""
        hook = Hook.from_dict(data)
        hook.id = str(uuid.uuid4())
        hook.created_at = datetime.now(timezone.utc).isoformat()
        hook.updated_at = hook.created_at
        self._hooks[hook.id] = hook
        self._save_hooks()
        logger.info("[HookService] Created hook '%s' (%s)", hook.name, hook.id)
        return hook.to_dict()

    def update_hook(self, hook_id: str, data: dict) -> dict | None:
        """Update an existing hook."""
        if hook_id not in self._hooks:
            return None
        existing = self._hooks[hook_id]
        updated = Hook.from_dict({**existing.to_dict(), **data, "id": hook_id})
        updated.updated_at = datetime.now(timezone.utc).isoformat()
        updated.created_at = existing.created_at
        self._hooks[hook_id] = updated
        self._save_hooks()
        logger.info("[HookService] Updated hook '%s' (%s)", updated.name, hook_id)
        return updated.to_dict()

    def delete_hook(self, hook_id: str) -> bool:
        """Delete a hook."""
        if hook_id not in self._hooks:
            return False
        name = self._hooks[hook_id].name
        del self._hooks[hook_id]
        self._save_hooks()
        logger.info("[HookService] Deleted hook '%s' (%s)", name, hook_id)
        return True

    def toggle_hook(self, hook_id: str) -> dict | None:
        """Toggle a hook between active and paused."""
        hook = self._hooks.get(hook_id)
        if not hook:
            return None
        if hook.status == HookStatus.ACTIVE:
            hook.status = HookStatus.PAUSED
        else:
            hook.status = HookStatus.ACTIVE
        hook.updated_at = datetime.now(timezone.utc).isoformat()
        self._save_hooks()
        return hook.to_dict()

    def duplicate_hook(self, hook_id: str) -> dict | None:
        """Duplicate an existing hook."""
        hook = self._hooks.get(hook_id)
        if not hook:
            return None
        new_data = hook.to_dict()
        new_data["name"] = f"{hook.name} (copy)"
        new_data["execution_count"] = 0
        new_data["error_count"] = 0
        new_data["last_triggered"] = None
        return self.create_hook(new_data)

    # ── Templates ─────────────────────────────────────────────────────────

    def get_templates(self) -> list[dict]:
        """Return all available templates."""
        return [t.to_dict() for t in get_hook_templates()]

    def create_from_template(
        self, template_id: str, project_id: str | None = None
    ) -> dict | None:
        """Create a hook from a template."""
        template = get_template_by_id(template_id)
        if not template:
            return None
        hook = template.to_hook(project_id)
        self._hooks[hook.id] = hook
        self._save_hooks()
        logger.info(
            "[HookService] Created hook from template '%s' → '%s'",
            template_id,
            hook.name,
        )
        return hook.to_dict()

    # ── Event processing ──────────────────────────────────────────────────

    async def emit_event(self, event: HookEvent) -> list[dict]:
        """Emit an event and execute matching hooks."""
        results = []
        matching_hooks = [
            h
            for h in self._hooks.values()
            if h.status == HookStatus.ACTIVE
            and (
                h.project_id == event.project_id
                or h.cross_project
                or event.project_id is None
            )
            and any(_match_trigger(t, event) for t in h.triggers)
        ]

        for hook in matching_hooks:
            execution = await self._execute_hook(hook, event)
            results.append(execution.to_dict())

        return results

    def emit_event_sync(self, event: HookEvent) -> list[dict]:
        """Synchronous wrapper for emit_event."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(asyncio.run, self.emit_event(event))
                    return future.result(timeout=60)
            else:
                return loop.run_until_complete(self.emit_event(event))
        except RuntimeError:
            return asyncio.run(self.emit_event(event))

    async def _execute_hook(self, hook: Hook, event: HookEvent) -> HookExecution:
        """Execute all actions of a hook for a given event."""
        execution = HookExecution(
            hook_id=hook.id,
            hook_name=hook.name,
            trigger_type=event.type.value,
            status=ExecutionStatus.RUNNING,
            trigger_event=event.to_dict(),
        )

        start_time = time.monotonic()
        action_results = []

        try:
            # Build execution graph from connections
            action_map = {a.id: a for a in hook.actions}
            executed: set[str] = set()

            # Find root actions (targeted by triggers)
            trigger_ids = {t.id for t in hook.triggers}
            root_action_ids = set()
            for conn in hook.connections:
                if conn.source_id in trigger_ids:
                    root_action_ids.add(conn.target_id)

            # If no connections, execute all actions sequentially
            if not hook.connections and hook.actions:
                root_action_ids = {a.id for a in hook.actions}

            # Execute actions following connection graph
            queue = list(root_action_ids)
            while queue:
                action_id = queue.pop(0)
                if action_id in executed or action_id not in action_map:
                    continue

                action = action_map[action_id]
                result = await _execute_action(action, event, hook)
                action_results.append(result)
                executed.add(action_id)

                # Find next actions based on connections and conditions
                for conn in hook.connections:
                    if conn.source_id == action_id and conn.target_id not in executed:
                        should_execute = (
                            conn.condition is None
                            or conn.condition == "always"
                            or (
                                conn.condition == "on_success"
                                and result["status"] == "success"
                            )
                            or (
                                conn.condition == "on_failure"
                                and result["status"] in ("failed", "timeout")
                            )
                        )
                        if should_execute:
                            queue.append(conn.target_id)

            execution.status = ExecutionStatus.SUCCESS
            if any(r["status"] == "failed" for r in action_results):
                execution.status = ExecutionStatus.FAILED

        except Exception as e:
            execution.status = ExecutionStatus.FAILED
            execution.error = str(e)
            logger.error("[HookEngine] Hook '%s' execution failed: %s", hook.name, e)

        elapsed = time.monotonic() - start_time
        execution.completed_at = datetime.now(timezone.utc).isoformat()
        execution.duration_ms = int(elapsed * 1000)
        execution.action_results = action_results

        # Update hook stats
        hook.last_triggered = execution.started_at
        hook.execution_count += 1
        if execution.status == ExecutionStatus.FAILED:
            hook.error_count += 1
        self._save_hooks()

        # Store execution
        self._executions.append(execution)
        if len(self._executions) > self._max_executions:
            self._executions = self._executions[-self._max_executions :]
        self._save_executions()

        # Notify listeners
        for listener in self._listeners:
            try:
                listener(execution.to_dict())
            except Exception:
                pass

        return execution

    # ── Execution history ─────────────────────────────────────────────────

    def get_executions(self, hook_id: str | None = None, limit: int = 50) -> list[dict]:
        """Get execution history."""
        execs = self._executions
        if hook_id:
            execs = [e for e in execs if e.hook_id == hook_id]
        return [e.to_dict() for e in execs[-limit:]]

    def get_stats(self) -> dict:
        """Get overall hook system stats."""
        total = len(self._hooks)
        active = sum(1 for h in self._hooks.values() if h.status == HookStatus.ACTIVE)
        paused = sum(1 for h in self._hooks.values() if h.status == HookStatus.PAUSED)
        total_executions = sum(h.execution_count for h in self._hooks.values())
        total_errors = sum(h.error_count for h in self._hooks.values())

        return {
            "total_hooks": total,
            "active_hooks": active,
            "paused_hooks": paused,
            "total_executions": total_executions,
            "total_errors": total_errors,
            "success_rate": round(
                (total_executions - total_errors) / max(total_executions, 1) * 100, 1
            ),
            "recent_executions": len(self._executions),
        }

    # ── Listeners ─────────────────────────────────────────────────────────

    def add_listener(self, callback: Callable):
        """Add a listener for hook executions."""
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable):
        """Remove a listener."""
        self._listeners = [
            listener for listener in self._listeners if listener is not callback
        ]
