"""Build the fine-grained progress indicator from on-disk artefacts."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ProgressIndicator:
    spec_id: str
    label: str  # short human label, e.g. "Coding subtask 3/8"
    phase: str  # "planning" | "coding" | "qa" | "idle" | "completed" | "unknown"
    sub_phase: str | None = None  # secondary status when relevant
    subtasks_completed: int = 0
    subtasks_total: int = 0
    current_subtask_id: str | None = None
    current_session: int | None = None
    last_activity_iso: str | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "label": self.label,
            "phase": self.phase,
            "sub_phase": self.sub_phase,
            "subtasks_completed": self.subtasks_completed,
            "subtasks_total": self.subtasks_total,
            "current_subtask_id": self.current_subtask_id,
            "current_session": self.current_session,
            "last_activity_iso": self.last_activity_iso,
            "warnings": list(self.warnings),
        }


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _count_plan_subtasks(plan: dict) -> tuple[int, int]:
    completed = 0
    total = 0
    for phase in plan.get("phases", []) or []:
        for subtask in phase.get("subtasks", []) or []:
            total += 1
            if (subtask.get("status") or "").lower() == "completed":
                completed += 1
    return completed, total


def _active_phase(task_logs: dict) -> tuple[str, dict | None]:
    """Return (phase_name, phase_dict) for the most recently active phase.

    Picks the phase with status="active" first; if none, the latest
    "completed" phase; falls back to "idle" if everything is still pending.
    """
    phases = task_logs.get("phases", {}) or {}
    # 1. an explicitly active phase wins
    for name in ("planning", "coding", "validation"):
        ph = phases.get(name) or {}
        if (ph.get("status") or "").lower() == "active":
            return name, ph
    # 2. otherwise pick the latest completed phase by completed_at
    completed = [
        (name, phases.get(name))
        for name in ("planning", "coding", "validation")
        if phases.get(name)
        and (phases[name].get("status") or "").lower() == "completed"
    ]
    if completed:
        # Sort by completed_at ISO timestamp (lex order works for ISO-8601).
        completed.sort(key=lambda kv: kv[1].get("completed_at") or "")
        name, ph = completed[-1]
        return name, ph
    return "idle", None


def _last_entry(phase: dict | None) -> dict | None:
    if not phase:
        return None
    entries = phase.get("entries") or []
    return entries[-1] if entries else None


def build_progress_indicator(spec_dir: Path) -> ProgressIndicator:
    """Build a ProgressIndicator. Never raises."""
    spec_dir = Path(spec_dir)
    spec_id = spec_dir.name
    warnings: list[str] = []

    if not spec_dir.is_dir():
        return ProgressIndicator(
            spec_id=spec_id,
            label="Unknown",
            phase="unknown",
            warnings=[f"spec_dir does not exist: {spec_dir}"],
        )

    plan = _read_json(spec_dir / "implementation_plan.json")
    task_logs = _read_json(spec_dir / "task_logs.json")

    completed, total = (0, 0)
    if plan is None:
        warnings.append("no implementation_plan.json yet")
    else:
        completed, total = _count_plan_subtasks(plan)

    if task_logs is None:
        warnings.append("no task_logs.json yet")
        # Best-effort: if the plan exists but we have no log, infer from
        # subtask counts.
        if total and completed >= total:
            return ProgressIndicator(
                spec_id=spec_id,
                label="Completed",
                phase="completed",
                subtasks_completed=completed,
                subtasks_total=total,
                warnings=warnings,
            )
        return ProgressIndicator(
            spec_id=spec_id,
            label="Idle / pre-build",
            phase="idle",
            subtasks_completed=completed,
            subtasks_total=total,
            warnings=warnings,
        )

    phase_name, active_phase = _active_phase(task_logs)
    last_entry = _last_entry(active_phase)
    last_activity = task_logs.get("updated_at")

    current_subtask = None
    current_session = None
    sub_phase = None
    if last_entry:
        current_subtask = last_entry.get("subtask_id")
        current_session = last_entry.get("session")
        sub_phase = last_entry.get("subphase")

    label = _format_label(
        phase_name=phase_name,
        active_phase=active_phase,
        completed=completed,
        total=total,
        current_subtask=current_subtask,
        current_session=current_session,
    )

    return ProgressIndicator(
        spec_id=spec_id,
        label=label,
        phase=_normalised_phase(phase_name),
        sub_phase=sub_phase,
        subtasks_completed=completed,
        subtasks_total=total,
        current_subtask_id=current_subtask,
        current_session=current_session,
        last_activity_iso=last_activity,
        warnings=warnings,
    )


def _normalised_phase(phase_name: str) -> str:
    """Map task_logger phase → consistent vocabulary used by the UI."""
    return {"validation": "qa"}.get(phase_name, phase_name)


def _format_label(
    *,
    phase_name: str,
    active_phase: dict | None,
    completed: int,
    total: int,
    current_subtask: str | None,
    current_session: int | None,
) -> str:
    """Render the short human label shown on the Kanban card."""
    if phase_name == "idle":
        return "Idle"
    if phase_name == "planning":
        return "Planning"
    if phase_name == "coding":
        if total > 0:
            return f"Coding subtask {min(completed + 1, total)}/{total}"
        return "Coding"
    if phase_name == "validation":
        # Distinguish reviewer vs fixer based on session activity if we can —
        # the QA loop bumps `session` on each fixer pass.
        if current_session and current_session > 1:
            return f"QA fixing — iteration {current_session}"
        return "QA validating"
    return "Working"
