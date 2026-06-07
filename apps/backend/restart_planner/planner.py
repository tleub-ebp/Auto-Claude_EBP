"""Inspect a spec dir + decide which restart modes are available.

Pure functions, no subprocess, no SDK. Designed to be called from an
HTTP endpoint (or directly) before the user picks a restart action. The
``prepare_restart`` helper does ONLY filesystem cleanup that's safe
without launching an agent (e.g. removing ``QA_FIX_REQUEST.md``); it
never spawns anything.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class RestartMode(str, Enum):
    QA = "qa"
    CODER = "coder"
    FULL = "full"


@dataclass
class RestartPlan:
    """What the frontend needs to render restart options."""

    spec_id: str
    can_restart_qa: bool
    can_restart_coder: bool
    can_restart_full: bool  # always True (restart from scratch is always possible)
    reasons: dict[str, str] = field(default_factory=dict)
    next_subtask_for_coder: str | None = None  # subtask_id or None
    completed_subtasks: int = 0
    total_subtasks: int = 0
    files_to_clean: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "can_restart_qa": self.can_restart_qa,
            "can_restart_coder": self.can_restart_coder,
            "can_restart_full": self.can_restart_full,
            "reasons": dict(self.reasons),
            "next_subtask_for_coder": self.next_subtask_for_coder,
            "completed_subtasks": self.completed_subtasks,
            "total_subtasks": self.total_subtasks,
            "files_to_clean": {k: list(v) for k, v in self.files_to_clean.items()},
        }


# Files we may clean before each restart mode. Listed here so the frontend
# can show a "this will delete X" warning without us having to actually
# touch the disk in the read-only `plan_restart` call.
_CLEANUP_BY_MODE: dict[RestartMode, tuple[str, ...]] = {
    RestartMode.QA: (
        "qa_report.md",
        "QA_FIX_REQUEST.md",
        "qa_signoff.json",
    ),
    RestartMode.CODER: (
        "QA_FIX_REQUEST.md",
        "qa_report.md",
    ),
    RestartMode.FULL: (
        "qa_report.md",
        "QA_FIX_REQUEST.md",
        "qa_signoff.json",
        "implementation_plan.json",  # planner regenerates this
    ),
}


def _load_plan(spec_dir: Path) -> dict | None:
    plan_path = spec_dir / "implementation_plan.json"
    if not plan_path.exists():
        return None
    try:
        return json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _count_subtasks(plan: dict) -> tuple[int, int, str | None]:
    """Return (completed, total, first_non_completed_subtask_id)."""
    completed = 0
    total = 0
    first_non_completed: str | None = None
    for phase in plan.get("phases", []) or []:
        for subtask in phase.get("subtasks", []) or []:
            total += 1
            status = (subtask.get("status") or "").lower()
            if status == "completed":
                completed += 1
            elif first_non_completed is None:
                first_non_completed = subtask.get("id") or subtask.get("name")
    return completed, total, first_non_completed


def _existing_files(spec_dir: Path, names: tuple[str, ...]) -> list[str]:
    return [n for n in names if (spec_dir / n).exists()]


def plan_restart(spec_dir: Path) -> RestartPlan:
    """Inspect the spec and report which restart modes are available.

    Side-effect free.
    """
    spec_dir = Path(spec_dir)
    spec_id = spec_dir.name
    reasons: dict[str, str] = {}

    if not spec_dir.exists() or not spec_dir.is_dir():
        return RestartPlan(
            spec_id=spec_id,
            can_restart_qa=False,
            can_restart_coder=False,
            can_restart_full=False,
            reasons={
                "all": f"spec_dir does not exist: {spec_dir}",
            },
        )

    plan = _load_plan(spec_dir)
    if plan is None:
        # No plan = nothing has run yet → only "full" makes sense.
        reasons["qa"] = "no implementation_plan.json — nothing to QA yet"
        reasons["coder"] = "no implementation_plan.json — coder hasn't run"
        return RestartPlan(
            spec_id=spec_id,
            can_restart_qa=False,
            can_restart_coder=False,
            can_restart_full=True,
            reasons=reasons,
            files_to_clean={
                RestartMode.FULL.value: _existing_files(
                    spec_dir, _CLEANUP_BY_MODE[RestartMode.FULL]
                ),
            },
        )

    completed, total, next_subtask = _count_subtasks(plan)

    can_restart_coder = completed < total
    if not can_restart_coder:
        reasons["coder"] = (
            f"all {total} subtask(s) already completed — use full restart to redo"
        )

    can_restart_qa = completed > 0
    if not can_restart_qa:
        reasons["qa"] = "no completed subtasks — coding hasn't produced anything to QA"

    return RestartPlan(
        spec_id=spec_id,
        can_restart_qa=can_restart_qa,
        can_restart_coder=can_restart_coder,
        can_restart_full=True,
        reasons=reasons,
        next_subtask_for_coder=next_subtask,
        completed_subtasks=completed,
        total_subtasks=total,
        files_to_clean={
            mode.value: _existing_files(spec_dir, _CLEANUP_BY_MODE[mode])
            for mode in RestartMode
        },
    )


def prepare_restart(spec_dir: Path, mode: RestartMode | str) -> dict[str, Any]:
    """Filesystem cleanup for the given restart mode. No agent spawned.

    Returns a dict with ``deleted`` (list of paths actually removed) and
    ``mode`` (string). Best-effort: missing files are silently skipped,
    permission errors are swallowed (and reported in ``warnings``).
    """
    spec_dir = Path(spec_dir)
    if not spec_dir.is_dir():
        raise ValueError(f"spec_dir does not exist or is not a directory: {spec_dir}")

    mode_enum = RestartMode(mode) if isinstance(mode, str) else mode
    candidates = _CLEANUP_BY_MODE.get(mode_enum, ())
    deleted: list[str] = []
    warnings: list[str] = []

    for name in candidates:
        target = spec_dir / name
        if not target.exists():
            continue
        try:
            target.unlink()
            deleted.append(name)
        except OSError as exc:
            warnings.append(f"could not delete {name}: {exc}")

    return {
        "mode": mode_enum.value,
        "deleted": deleted,
        "warnings": warnings,
    }
