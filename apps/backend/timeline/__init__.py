"""UI-friendly timeline view of an audit_trail correlation_id.

Wraps :func:`audit_trail.AuditTrail.replay` and adds the formatting the
Kanban drawer needs: ISO timestamps, relative deltas between events,
high-level event categories grouped by phase (planner / coder / qa /
system).

Read-only. Never raises into the caller.
"""

from .builder import (
    PHASE_ORDER,
    TimelineEntry,
    TimelineSnapshot,
    build_timeline,
)

__all__ = [
    "PHASE_ORDER",
    "TimelineEntry",
    "TimelineSnapshot",
    "build_timeline",
]
