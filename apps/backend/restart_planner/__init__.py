"""Restart planning for autonomous builds.

Read-only module that inspects a spec's state and reports which restart
modes are available — without triggering anything. The frontend already
knows how to spawn agents via existing IPC handlers; this module just
tells it which buttons to enable and what cleanup is needed first.

Three restart modes:
  * ``qa``    — re-run only the QA phase (reviewer + fixer). Cheap, safe.
                Available when coding completed at least once.
  * ``coder`` — re-run the coder from the first failed/incomplete
                subtask. Preserves earlier completed subtasks.
  * ``full``  — restart the whole build (planner + coder + qa). Most
                expensive; equivalent to deleting the spec's progress.
"""

from .planner import (
    RestartMode,
    RestartPlan,
    plan_restart,
    prepare_restart,
)

__all__ = [
    "RestartMode",
    "RestartPlan",
    "plan_restart",
    "prepare_restart",
]
