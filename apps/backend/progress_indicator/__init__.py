"""Compute a UI-friendly fine-grained progress label for the Kanban card.

The Kanban already shows a global progress bar. What this module gives
back is the *current* sub-status — what the agent is actually doing
right now — for cards in `in_progress`. Examples:

    "Planning"
    "Coding subtask 3/8"
    "QA validating"
    "QA fixing — iteration 2"
    "Idle / between sessions"

Sources of truth (all read-only, no SDK):
  * ``task_logs.json`` (written by ``task_logger``) — gives the active
    phase + most recent log entry's subtask_id and session.
  * ``implementation_plan.json`` — gives the total subtask count + how
    many are completed.

Best-effort: returns "Idle" with a populated ``warnings`` list when the
artefacts are missing or unreadable.
"""

from .builder import (
    ProgressIndicator,
    build_progress_indicator,
)

__all__ = [
    "ProgressIndicator",
    "build_progress_indicator",
]
