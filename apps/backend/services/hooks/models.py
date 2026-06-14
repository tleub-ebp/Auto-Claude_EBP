"""
Event-Driven Hooks System — Data Models

Defines all core types: HookEvent, Trigger, Action, Hook, HookExecution, HookTemplate.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TriggerType(str, Enum):
    FILE_SAVED = "file_saved"
    FILE_CREATED = "file_created"
    FILE_DELETED = "file_deleted"
    TEST_FAILED = "test_failed"
    TEST_PASSED = "test_passed"
    PR_OPENED = "pr_opened"
    PR_MERGED = "pr_merged"
    PR_REVIEW_REQUESTED = "pr_review_requested"
    BUILD_STARTED = "build_started"
    BUILD_COMPLETED = "build_completed"
    BUILD_FAILED = "build_failed"
    DEPENDENCY_OUTDATED = "dependency_outdated"
    CODE_PATTERN_DETECTED = "code_pattern_detected"
    LINT_ERROR = "lint_error"
    BRANCH_CREATED = "branch_created"
    COMMIT_PUSHED = "commit_pushed"
    AGENT_COMPLETED = "agent_completed"
    AGENT_FAILED = "agent_failed"
    SCHEDULE = "schedule"
    MANUAL = "manual"
    WEBHOOK = "webhook"
    CUSTOM = "custom"


class ActionType(str, Enum):
    RUN_AGENT = "run_agent"
    SEND_NOTIFICATION = "send_notification"
    CREATE_SPEC = "create_spec"
    TRIGGER_PIPELINE = "trigger_pipeline"
    RUN_COMMAND = "run_command"
    RUN_LINT = "run_lint"
    RUN_TESTS = "run_tests"
    GENERATE_TESTS = "generate_tests"
    UPDATE_DOCS = "update_docs"
    CREATE_PR = "create_pr"
    SEND_SLACK = "send_slack"
    SEND_TEAMS = "send_teams"
    SEND_DISCORD = "send_discord"
    SEND_GOOGLE_CHAT = "send_google_chat"
    SEND_WEBHOOK = "send_webhook"
    LOG_EVENT = "log_event"
    CHAIN_HOOK = "chain_hook"
    CUSTOM = "custom"


class HookStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    DISABLED = "disabled"
    ERROR = "error"


class ExecutionStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMEOUT = "timeout"


# ─────────────────────────────────────────────────────────────────────────────
# Data classes
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class TriggerCondition:
    """A filter/condition on a trigger (e.g. file glob, branch name, pattern)."""

    field: str
    operator: str  # equals, contains, matches, startsWith, endsWith, glob
    value: str


@dataclass
class Trigger:
    """Defines *when* a hook fires."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    type: TriggerType = TriggerType.MANUAL
    conditions: list[TriggerCondition] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    # For SCHEDULE type
    cron_expression: str | None = None
    # Visual editor position
    position: dict[str, float] = field(default_factory=lambda: {"x": 0, "y": 0})

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type.value,
            "conditions": [
                {"field": c.field, "operator": c.operator, "value": c.value}
                for c in self.conditions
            ],
            "config": self.config,
            "cron_expression": self.cron_expression,
            "position": self.position,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Trigger:
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            type=TriggerType(data.get("type", "manual")),
            conditions=[TriggerCondition(**c) for c in data.get("conditions", [])],
            config=data.get("config", {}),
            cron_expression=data.get("cron_expression"),
            position=data.get("position", {"x": 0, "y": 0}),
        )


@dataclass
class Action:
    """Defines *what* happens when a hook fires."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    type: ActionType = ActionType.LOG_EVENT
    config: dict[str, Any] = field(default_factory=dict)
    # Delay before execution (ms)
    delay_ms: int = 0
    # Retry policy
    max_retries: int = 0
    retry_delay_ms: int = 1000
    # Timeout (ms), 0 = no timeout
    timeout_ms: int = 30000
    # Visual editor position
    position: dict[str, float] = field(default_factory=lambda: {"x": 250, "y": 0})

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type.value,
            "config": self.config,
            "delay_ms": self.delay_ms,
            "max_retries": self.max_retries,
            "retry_delay_ms": self.retry_delay_ms,
            "timeout_ms": self.timeout_ms,
            "position": self.position,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Action:
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            type=ActionType(data.get("type", "log_event")),
            config=data.get("config", {}),
            delay_ms=data.get("delay_ms", 0),
            max_retries=data.get("max_retries", 0),
            retry_delay_ms=data.get("retry_delay_ms", 1000),
            timeout_ms=data.get("timeout_ms", 30000),
            position=data.get("position", {"x": 250, "y": 0}),
        )


@dataclass
class HookConnection:
    """Visual connection between nodes in the editor."""

    source_id: str
    target_id: str
    source_handle: str = "output"
    target_handle: str = "input"
    condition: str | None = None  # e.g. "on_success", "on_failure", "always"

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "source_handle": self.source_handle,
            "target_handle": self.target_handle,
            "condition": self.condition,
        }

    @classmethod
    def from_dict(cls, data: dict) -> HookConnection:
        return cls(**data)


@dataclass
class Hook:
    """A complete event-driven hook with trigger(s) + action(s) + connections."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    description: str = ""
    project_id: str | None = None
    # Can apply across projects
    cross_project: bool = False
    status: HookStatus = HookStatus.ACTIVE
    triggers: list[Trigger] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)
    connections: list[HookConnection] = field(default_factory=list)
    # Metadata
    created_at: str = field(default_factory=_utcnow_iso)
    updated_at: str = field(default_factory=_utcnow_iso)
    last_triggered: str | None = None
    execution_count: int = 0
    error_count: int = 0
    # Template origin
    template_id: str | None = None
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "project_id": self.project_id,
            "cross_project": self.cross_project,
            "status": self.status.value,
            "triggers": [t.to_dict() for t in self.triggers],
            "actions": [a.to_dict() for a in self.actions],
            "connections": [c.to_dict() for c in self.connections],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_triggered": self.last_triggered,
            "execution_count": self.execution_count,
            "error_count": self.error_count,
            "template_id": self.template_id,
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Hook:
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            name=data.get("name", ""),
            description=data.get("description", ""),
            project_id=data.get("project_id"),
            cross_project=data.get("cross_project", False),
            status=HookStatus(data.get("status", "active")),
            triggers=[Trigger.from_dict(t) for t in data.get("triggers", [])],
            actions=[Action.from_dict(a) for a in data.get("actions", [])],
            connections=[
                HookConnection.from_dict(c) for c in data.get("connections", [])
            ],
            created_at=data.get("created_at", _utcnow_iso()),
            updated_at=data.get("updated_at", _utcnow_iso()),
            last_triggered=data.get("last_triggered"),
            execution_count=data.get("execution_count", 0),
            error_count=data.get("error_count", 0),
            template_id=data.get("template_id"),
            tags=data.get("tags", []),
        )


@dataclass
class HookExecution:
    """Record of a single hook execution."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    hook_id: str = ""
    hook_name: str = ""
    trigger_type: str = ""
    status: ExecutionStatus = ExecutionStatus.PENDING
    started_at: str = field(default_factory=_utcnow_iso)
    completed_at: str | None = None
    duration_ms: int | None = None
    trigger_event: dict[str, Any] = field(default_factory=dict)
    action_results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "hook_id": self.hook_id,
            "hook_name": self.hook_name,
            "trigger_type": self.trigger_type,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "duration_ms": self.duration_ms,
            "trigger_event": self.trigger_event,
            "action_results": self.action_results,
            "error": self.error,
        }


@dataclass
class HookEvent:
    """An event emitted by the system that can trigger hooks."""

    type: TriggerType
    data: dict[str, Any] = field(default_factory=dict)
    project_id: str | None = None
    timestamp: str = field(default_factory=_utcnow_iso)
    source: str = "system"

    def to_dict(self) -> dict:
        return {
            "type": self.type.value,
            "data": self.data,
            "project_id": self.project_id,
            "timestamp": self.timestamp,
            "source": self.source,
        }


@dataclass
class HookTemplate:
    """Pre-configured hook template."""

    id: str
    name: str
    description: str
    category: str  # automation, quality, notification, ci_cd, documentation
    icon: str  # emoji
    tags: list[str] = field(default_factory=list)
    triggers: list[dict] = field(default_factory=list)
    actions: list[dict] = field(default_factory=list)
    connections: list[dict] = field(default_factory=list)
    popularity: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "icon": self.icon,
            "tags": self.tags,
            "triggers": self.triggers,
            "actions": self.actions,
            "connections": self.connections,
            "popularity": self.popularity,
        }

    def to_hook(self, project_id: str | None = None) -> Hook:
        """Create a Hook instance from this template."""
        return Hook(
            name=self.name,
            description=self.description,
            project_id=project_id,
            triggers=[Trigger.from_dict(t) for t in self.triggers],
            actions=[Action.from_dict(a) for a in self.actions],
            connections=[HookConnection.from_dict(c) for c in self.connections],
            template_id=self.id,
            tags=self.tags,
        )
