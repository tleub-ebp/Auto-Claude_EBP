"""
Data models and types for the migration system.
"""

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class MigrationState(Enum):
    """Migration execution state."""

    PLANNING = "planning"
    ANALYZING = "analyzing"
    TRANSFORMING = "transforming"
    VALIDATING = "validating"
    COMPLETE = "complete"
    ROLLED_BACK = "rolled_back"
    FAILED = "failed"
    PAUSED = "paused"


class RiskLevel(Enum):
    """Risk assessment levels."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ConfidenceLevel(Enum):
    """Transformation confidence levels."""

    VERY_LOW = 0.2
    LOW = 0.4
    MEDIUM = 0.6
    HIGH = 0.8
    VERY_HIGH = 1.0


@dataclass
class StackInfo:
    """Information about a technology stack."""

    framework: str  # e.g., "react", "vue", "django", "flask"
    language: str  # e.g., "typescript", "python", "java"
    version: str  # Version of the framework/language
    database: str | None = None  # e.g., "mysql", "postgresql"
    db_version: str | None = None
    dependencies: dict[str, str] = field(default_factory=dict)  # name → version
    additional_tools: list[str] = field(default_factory=list)  # e.g., webpack, docker
    package_manager: str = "npm"  # npm, pip, maven, etc.

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StackInfo":
        return cls(**data)


@dataclass
class MigrationStep:
    """Atomic migration step."""

    id: str
    title: str
    description: str
    category: str  # e.g., "component", "database", "config", "api"
    files_affected: list[str]
    transformation_type: str  # e.g., "api_mapping", "syntax_conversion"

    # Execution details
    expected_changes: int  # Expected number of file changes
    rollback_procedure: str | None = None
    validation_checks: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)  # Step IDs this depends on

    # Status tracking
    status: str = "pending"  # pending, in_progress, completed, failed
    error: str | None = None
    applied_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.applied_at:
            data["applied_at"] = self.applied_at.isoformat()
        return data


@dataclass
class MigrationPhase:
    """Group of related migration steps."""

    id: str
    name: str  # e.g., "Components", "Database Schema", "API Layer"
    description: str

    # Metadata
    estimated_effort: str = "medium"  # Low, Medium, High

    steps: list[MigrationStep] = field(default_factory=list)
    risk_level: RiskLevel = RiskLevel.MEDIUM
    requires_approval: bool = False

    # Status
    status: str = "pending"  # pending, in_progress, completed, failed
    started_at: datetime | None = None
    completed_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["steps"] = [step.to_dict() for step in self.steps]
        data["risk_level"] = self.risk_level.value
        if self.started_at:
            data["started_at"] = self.started_at.isoformat()
        if self.completed_at:
            data["completed_at"] = self.completed_at.isoformat()
        return data


@dataclass
class TransformationResult:
    """Result of a single code transformation."""

    file_path: str
    transformation_type: str
    before: str  # Original content
    after: str  # Transformed content
    changes_count: int  # Number of lines changed
    confidence: float  # 0-1 confidence in transformation quality

    # Validation
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    validation_passed: bool = False

    # Metadata
    applied: bool = False
    applied_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.applied_at:
            data["applied_at"] = self.applied_at.isoformat()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TransformationResult":
        data = dict(data)
        applied_at = data.get("applied_at")
        if isinstance(applied_at, str):
            data["applied_at"] = datetime.fromisoformat(applied_at)
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def get_diff(self) -> str:
        """Generate unified diff representation."""
        from difflib import unified_diff

        before_lines = self.before.splitlines(keepends=True)
        after_lines = self.after.splitlines(keepends=True)
        diff_lines = list(
            unified_diff(
                before_lines,
                after_lines,
                fromfile=f"{self.file_path}.before",
                tofile=f"{self.file_path}.after",
            )
        )
        return "".join(diff_lines)


@dataclass
class MigrationPlan:
    """Complete migration plan."""

    id: str
    source_stack: StackInfo
    target_stack: StackInfo

    # Plan details
    phases: list[MigrationPhase] = field(default_factory=list)
    total_steps: int = 0

    # Assessment
    estimated_effort: str = "medium"  # Low, Medium, High, Very High
    risk_level: RiskLevel = RiskLevel.MEDIUM
    estimated_duration_hours: float = 0.0

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    created_by: str = "claude"
    approvals_required: bool = False

    # Status
    status: str = "pending"  # pending, approved, in_progress, completed, failed

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source_stack"] = self.source_stack.to_dict()
        data["target_stack"] = self.target_stack.to_dict()
        data["phases"] = [phase.to_dict() for phase in self.phases]
        data["risk_level"] = self.risk_level.value
        data["created_at"] = self.created_at.isoformat()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MigrationPlan":
        """Deserialize from dict."""
        data = dict(data)
        data["source_stack"] = StackInfo.from_dict(data["source_stack"])
        data["target_stack"] = StackInfo.from_dict(data["target_stack"])
        data["risk_level"] = RiskLevel(data["risk_level"])
        # Phases would need similar reconstruction
        data["phases"] = []  # Simplified for now
        data["created_at"] = datetime.fromisoformat(data["created_at"])
        return cls(**data)


@dataclass
class MigrationContext:
    """Holds all migration state and information."""

    migration_id: str
    source_stack: StackInfo
    target_stack: StackInfo
    project_dir: str

    # Planning
    plan: MigrationPlan | None = None

    # Execution
    state: MigrationState = MigrationState.PLANNING
    transformations: list[TransformationResult] = field(default_factory=list)
    test_results: dict[str, Any] = field(default_factory=dict)

    # Tracking
    checkpoints: dict[str, str] = field(default_factory=dict)  # phase_id → git_commit
    rollback_available: bool = False
    current_phase: str | None = None

    # Metadata
    started_at: datetime | None = None
    paused_at: datetime | None = None
    completed_at: datetime | None = None
    last_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source_stack"] = self.source_stack.to_dict()
        data["target_stack"] = self.target_stack.to_dict()
        data["plan"] = self.plan.to_dict() if self.plan else None
        data["state"] = self.state.value
        data["transformations"] = [t.to_dict() for t in self.transformations]
        if self.started_at:
            data["started_at"] = self.started_at.isoformat()
        if self.paused_at:
            data["paused_at"] = self.paused_at.isoformat()
        if self.completed_at:
            data["completed_at"] = self.completed_at.isoformat()
        return data

    def save_to_file(self, filepath: str) -> None:
        """Save context to JSON file."""
        with open(filepath, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load_from_file(cls, filepath: str) -> "MigrationContext":
        """Load context from JSON file."""
        with open(filepath) as f:
            data = json.load(f)
        data["source_stack"] = StackInfo.from_dict(data["source_stack"])
        data["target_stack"] = StackInfo.from_dict(data["target_stack"])
        data["state"] = MigrationState(data["state"])
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class ValidationReport:
    """Report of migration validation."""

    passed: bool
    total_tests: int = 0
    passed_tests: int = 0
    failed_tests: int = 0
    skipped_tests: int = 0

    # Coverage
    before_coverage: float | None = None  # percentage
    after_coverage: float | None = None
    coverage_change: float | None = None

    # Regressions
    regression_detected: bool = False
    regressions: list[str] = field(default_factory=list)

    # Issues
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    # Metadata
    duration_seconds: float = 0.0
    completed_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["completed_at"] = self.completed_at.isoformat()
        return data


@dataclass
class RollbackCheckpoint:
    """Checkpoint for rollback recovery."""

    phase_id: str
    checkpoint_id: str
    git_commit: str
    timestamp: datetime
    state_file: str  # Path to saved context
    description: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase_id": self.phase_id,
            "checkpoint_id": self.checkpoint_id,
            "git_commit": self.git_commit,
            "timestamp": self.timestamp.isoformat(),
            "state_file": self.state_file,
            "description": self.description,
        }
