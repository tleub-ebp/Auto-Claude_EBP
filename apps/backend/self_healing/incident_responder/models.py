"""
Incident Responder Data Models
===============================

Shared data models for the Self-Healing Codebase + Incident Responder system.
Covers all three modes: CI/CD, Production, and Proactive.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class IncidentMode(str, Enum):
    """Operating mode that detected the incident."""

    CICD = "cicd"
    PRODUCTION = "production"
    PROACTIVE = "proactive"


class IncidentSeverity(str, Enum):
    """Severity level of an incident."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class HealingStatus(str, Enum):
    """Status of a healing operation."""

    PENDING = "pending"
    ANALYZING = "analyzing"
    FIXING = "fixing"
    QA_RUNNING = "qa_running"
    PR_CREATED = "pr_created"
    RESOLVED = "resolved"
    ESCALATED = "escalated"
    FAILED = "failed"


class IncidentSource(str, Enum):
    """Source that reported the incident."""

    GIT_PUSH = "git_push"
    CI_FAILURE = "ci_failure"
    SENTRY = "sentry"
    DATADOG = "datadog"
    CLOUDWATCH = "cloudwatch"
    NEW_RELIC = "new_relic"
    PAGERDUTY = "pagerduty"
    PROACTIVE_SCAN = "proactive_scan"


def _generate_id() -> str:
    return uuid.uuid4().hex[:12]


def _now_iso() -> str:
    """Return current UTC timestamp in ISO format (naive — no offset).

    Existing data on disk and external consumers parse this as a naive
    string; switching to tz-aware would change the wire format.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


@dataclass
class Incident:
    """Represents a detected incident across any mode."""

    id: str = field(default_factory=_generate_id)
    mode: IncidentMode = IncidentMode.CICD
    source: IncidentSource = IncidentSource.GIT_PUSH
    severity: IncidentSeverity = IncidentSeverity.MEDIUM
    title: str = ""
    description: str = ""
    status: HealingStatus = HealingStatus.PENDING
    created_at: str = field(default_factory=_now_iso)
    resolved_at: str | None = None
    # Source-specific data
    source_data: dict[str, Any] = field(default_factory=dict)
    # Analysis results
    root_cause: str | None = None
    affected_files: list[str] = field(default_factory=list)
    regression_commit: str | None = None
    # Fix tracking
    fix_branch: str | None = None
    fix_pr_url: str | None = None
    fix_worktree: str | None = None
    qa_result: dict[str, Any] | None = None
    # Error info
    error_message: str | None = None
    stack_trace: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode.value,
            "source": self.source.value,
            "severity": self.severity.value,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "created_at": self.created_at,
            "resolved_at": self.resolved_at,
            "source_data": self.source_data,
            "root_cause": self.root_cause,
            "affected_files": self.affected_files,
            "regression_commit": self.regression_commit,
            "fix_branch": self.fix_branch,
            "fix_pr_url": self.fix_pr_url,
            "fix_worktree": self.fix_worktree,
            "qa_result": self.qa_result,
            "error_message": self.error_message,
            "stack_trace": self.stack_trace,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Incident:
        return cls(
            id=data.get("id", _generate_id()),
            mode=IncidentMode(data.get("mode", "cicd")),
            source=IncidentSource(data.get("source", "git_push")),
            severity=IncidentSeverity(data.get("severity", "medium")),
            title=data.get("title", ""),
            description=data.get("description", ""),
            status=HealingStatus(data.get("status", "pending")),
            created_at=data.get("created_at", _now_iso()),
            resolved_at=data.get("resolved_at"),
            source_data=data.get("source_data", {}),
            root_cause=data.get("root_cause"),
            affected_files=data.get("affected_files", []),
            regression_commit=data.get("regression_commit"),
            fix_branch=data.get("fix_branch"),
            fix_pr_url=data.get("fix_pr_url"),
            fix_worktree=data.get("fix_worktree"),
            qa_result=data.get("qa_result"),
            error_message=data.get("error_message"),
            stack_trace=data.get("stack_trace"),
        )


@dataclass
class CICDIncidentData:
    """CI/CD-specific incident data."""

    commit_sha: str = ""
    branch: str = ""
    failing_tests: list[str] = field(default_factory=list)
    diff_summary: str = ""
    ci_log_url: str | None = None
    pipeline_id: str | None = None
    test_output: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "commit_sha": self.commit_sha,
            "branch": self.branch,
            "failing_tests": self.failing_tests,
            "diff_summary": self.diff_summary,
            "ci_log_url": self.ci_log_url,
            "pipeline_id": self.pipeline_id,
            "test_output": self.test_output,
        }


@dataclass
class ProductionIncidentData:
    """Production-specific incident data."""

    error_type: str = ""
    error_message: str = ""
    stack_trace: str = ""
    occurrence_count: int = 1
    first_seen: str = field(default_factory=_now_iso)
    last_seen: str = field(default_factory=_now_iso)
    affected_users: int = 0
    environment: str = "production"
    service_name: str | None = None
    event_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_type": self.error_type,
            "error_message": self.error_message,
            "stack_trace": self.stack_trace,
            "occurrence_count": self.occurrence_count,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "affected_users": self.affected_users,
            "environment": self.environment,
            "service_name": self.service_name,
            "event_url": self.event_url,
        }


@dataclass
class FragilityReport:
    """Report on code fragility/risk zones."""

    file_path: str = ""
    risk_score: float = 0.0  # 0-100
    cyclomatic_complexity: float = 0.0
    git_churn_count: int = 0  # commits in last 30 days
    test_coverage_percent: float = 0.0
    last_incident_days: int | None = None
    suggested_tests: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_path": self.file_path,
            "risk_score": self.risk_score,
            "cyclomatic_complexity": self.cyclomatic_complexity,
            "git_churn_count": self.git_churn_count,
            "test_coverage_percent": self.test_coverage_percent,
            "last_incident_days": self.last_incident_days,
            "suggested_tests": self.suggested_tests,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FragilityReport:
        return cls(
            file_path=data.get("file_path", ""),
            risk_score=data.get("risk_score", 0.0),
            cyclomatic_complexity=data.get("cyclomatic_complexity", 0.0),
            git_churn_count=data.get("git_churn_count", 0),
            test_coverage_percent=data.get("test_coverage_percent", 0.0),
            last_incident_days=data.get("last_incident_days"),
            suggested_tests=data.get("suggested_tests", []),
        )


@dataclass
class HealingStep:
    """A single step in a healing operation."""

    name: str = ""
    status: str = "pending"  # pending, running, completed, failed
    detail: str | None = None
    started_at: str | None = None
    completed_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }


@dataclass
class HealingOperation:
    """Tracks a complete healing operation from detection to resolution."""

    id: str = field(default_factory=_generate_id)
    incident: Incident | None = None
    started_at: str = field(default_factory=_now_iso)
    completed_at: str | None = None
    steps: list[HealingStep] = field(default_factory=list)
    duration_seconds: float | None = None
    success: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "incident": self.incident.to_dict() if self.incident else None,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "steps": [s.to_dict() for s in self.steps],
            "duration_seconds": self.duration_seconds,
            "success": self.success,
        }

    def add_step(
        self, name: str, status: str = "running", detail: str | None = None
    ) -> HealingStep:
        step = HealingStep(
            name=name,
            status=status,
            detail=detail,
            started_at=_now_iso(),
        )
        self.steps.append(step)
        return step

    def complete_step(
        self, step: HealingStep, status: str = "completed", detail: str | None = None
    ) -> None:
        step.status = status
        step.completed_at = _now_iso()
        if detail:
            step.detail = detail

    def finalize(self, success: bool) -> None:
        self.success = success
        self.completed_at = _now_iso()
        started = datetime.fromisoformat(self.started_at)
        completed = datetime.fromisoformat(self.completed_at)
        self.duration_seconds = (completed - started).total_seconds()


@dataclass
class SelfHealingStats:
    """Aggregated statistics for the dashboard."""

    total_incidents: int = 0
    resolved_incidents: int = 0
    active_incidents: int = 0
    avg_resolution_time: float = 0.0
    auto_fix_rate: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "totalIncidents": self.total_incidents,
            "resolvedIncidents": self.resolved_incidents,
            "activeIncidents": self.active_incidents,
            "avgResolutionTime": self.avg_resolution_time,
            "autoFixRate": self.auto_fix_rate,
        }
