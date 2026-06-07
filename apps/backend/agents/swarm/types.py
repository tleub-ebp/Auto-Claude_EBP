"""
Swarm Mode Types
================

Data models for the swarm orchestration system.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class SwarmPhase(str, Enum):
    """Current phase of the swarm execution."""

    INITIALIZING = "initializing"
    ANALYZING_DEPENDENCIES = "analyzing_dependencies"
    EXECUTING_WAVE = "executing_wave"
    MERGING_WAVE = "merging_wave"
    COMPLETE = "complete"
    FAILED = "failed"


class SubtaskState(str, Enum):
    """Execution state of an individual subtask within a wave."""

    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"
    SKIPPED = "skipped"


@dataclass
class SwarmConfig:
    """Configuration for swarm execution."""

    max_parallel_agents: int = 4
    fail_fast: bool = False
    max_retries_per_subtask: int = 2
    merge_after_each_wave: bool = True
    profile_distribution: str = "round_robin"  # round_robin | least_loaded | dedicated
    enable_ai_merge: bool = True
    dry_run: bool = False
    # Hard cap on a single subtask's subprocess. Without this, a wedged child
    # (network hang, infinite loop) blocks asyncio.gather and stalls the
    # entire swarm; cancel_all() only fires on explicit cancel. Default 30
    # minutes is generous for real coding tasks while still bounding damage.
    subtask_timeout_seconds: float = 30 * 60.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_parallel_agents": self.max_parallel_agents,
            "fail_fast": self.fail_fast,
            "max_retries_per_subtask": self.max_retries_per_subtask,
            "merge_after_each_wave": self.merge_after_each_wave,
            "profile_distribution": self.profile_distribution,
            "enable_ai_merge": self.enable_ai_merge,
            "dry_run": self.dry_run,
            "subtask_timeout_seconds": self.subtask_timeout_seconds,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SwarmConfig:
        return cls(
            max_parallel_agents=data.get("max_parallel_agents", 4),
            fail_fast=data.get("fail_fast", False),
            max_retries_per_subtask=data.get("max_retries_per_subtask", 2),
            merge_after_each_wave=data.get("merge_after_each_wave", True),
            profile_distribution=data.get("profile_distribution", "round_robin"),
            enable_ai_merge=data.get("enable_ai_merge", True),
            dry_run=data.get("dry_run", False),
            subtask_timeout_seconds=data.get("subtask_timeout_seconds", 30 * 60.0),
        )


@dataclass
class SubtaskNode:
    """A subtask in the dependency graph with its metadata and edges."""

    id: str
    phase_name: str
    description: str
    files_to_modify: list[str] = field(default_factory=list)
    files_to_create: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    state: SubtaskState = SubtaskState.PENDING
    wave_index: int = -1
    worktree_path: Path | None = None
    error: str | None = None
    retry_count: int = 0
    started_at: float | None = None
    completed_at: float | None = None
    process_pid: int | None = None

    @property
    def all_files(self) -> set[str]:
        """All files this subtask touches (modify + create)."""
        return set(self.files_to_modify) | set(self.files_to_create)

    @property
    def duration_seconds(self) -> float | None:
        if self.started_at and self.completed_at:
            return self.completed_at - self.started_at
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "phase_name": self.phase_name,
            "description": self.description,
            "files_to_modify": self.files_to_modify,
            "files_to_create": self.files_to_create,
            "depends_on": self.depends_on,
            "state": self.state.value,
            "wave_index": self.wave_index,
            "worktree_path": str(self.worktree_path) if self.worktree_path else None,
            "error": self.error,
            "retry_count": self.retry_count,
            "duration_seconds": self.duration_seconds,
        }


@dataclass
class Wave:
    """A group of subtasks that can execute in parallel."""

    index: int
    subtask_ids: list[str] = field(default_factory=list)
    state: SubtaskState = SubtaskState.PENDING
    started_at: float | None = None
    completed_at: float | None = None
    merge_success: bool | None = None

    @property
    def duration_seconds(self) -> float | None:
        if self.started_at and self.completed_at:
            return self.completed_at - self.started_at
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "subtask_ids": self.subtask_ids,
            "state": self.state.value,
            "duration_seconds": self.duration_seconds,
            "merge_success": self.merge_success,
        }


@dataclass
class SwarmStatus:
    """Overall status of the swarm execution."""

    phase: SwarmPhase = SwarmPhase.INITIALIZING
    total_subtasks: int = 0
    completed_subtasks: int = 0
    failed_subtasks: int = 0
    running_subtasks: int = 0
    total_waves: int = 0
    current_wave: int = -1
    waves: list[Wave] = field(default_factory=list)
    nodes: dict[str, SubtaskNode] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    error: str | None = None
    config: SwarmConfig = field(default_factory=SwarmConfig)

    @property
    def progress_percent(self) -> int:
        if self.total_subtasks == 0:
            return 0
        return int((self.completed_subtasks / self.total_subtasks) * 100)

    @property
    def is_complete(self) -> bool:
        return self.phase in (SwarmPhase.COMPLETE, SwarmPhase.FAILED)

    @property
    def duration_seconds(self) -> float:
        end = self.completed_at or time.time()
        return end - self.started_at

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase.value,
            "total_subtasks": self.total_subtasks,
            "completed_subtasks": self.completed_subtasks,
            "failed_subtasks": self.failed_subtasks,
            "running_subtasks": self.running_subtasks,
            "total_waves": self.total_waves,
            "current_wave": self.current_wave,
            "waves": [w.to_dict() for w in self.waves],
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "progress_percent": self.progress_percent,
            "duration_seconds": self.duration_seconds,
            "error": self.error,
            "config": self.config.to_dict(),
        }
