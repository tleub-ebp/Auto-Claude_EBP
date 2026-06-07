"""Build a UI-friendly timeline from the audit_trail."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Phase ordering used to group events for the Kanban drawer. Anything not
# in this map ends up in "system".
_ACTOR_TO_PHASE: dict[str, str] = {
    "planner": "planning",
    "coder": "coding",
    "qa_reviewer": "qa",
    "qa_fixer": "qa",
    "documenter": "documentation",
    "model_router": "system",
    "domain_agents": "system",
    "cognitive_context": "system",
}

PHASE_ORDER: tuple[str, ...] = (
    "planning",
    "coding",
    "qa",
    "documentation",
    "system",
)


def _isoformat(unix_ts: float) -> str:
    return (
        datetime.fromtimestamp(unix_ts, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _phase_for(actor: str) -> str:
    return _ACTOR_TO_PHASE.get(actor, "system")


@dataclass
class TimelineEntry:
    sequence: int
    timestamp_unix: float
    timestamp_iso: str
    delta_seconds: float  # Time since the previous entry in the timeline.
    kind: str
    actor: str
    phase: str
    summary: str
    payload: dict[str, Any] = field(default_factory=dict)
    event_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "timestamp_unix": self.timestamp_unix,
            "timestamp_iso": self.timestamp_iso,
            "delta_seconds": round(self.delta_seconds, 3),
            "kind": self.kind,
            "actor": self.actor,
            "phase": self.phase,
            "summary": self.summary,
            "payload": dict(self.payload),
            "event_hash": self.event_hash,
        }


@dataclass
class TimelineSnapshot:
    correlation_id: str
    entries: list[TimelineEntry] = field(default_factory=list)
    integrity_intact: bool = True
    integrity_reason: str | None = None
    duration_seconds: float = 0.0
    phase_counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "correlation_id": self.correlation_id,
            "entries": [e.to_dict() for e in self.entries],
            "entry_count": len(self.entries),
            "integrity": {
                "intact": self.integrity_intact,
                "reason": self.integrity_reason,
            },
            "duration_seconds": round(self.duration_seconds, 3),
            "phase_counts": dict(self.phase_counts),
        }


def build_timeline(
    project_dir: Path,
    correlation_id: str,
    *,
    trail_name: str = "default",
    actor_filter: str | None = None,
    kind_filter: str | None = None,
) -> TimelineSnapshot:
    """Build a TimelineSnapshot for the given spec/correlation_id.

    Reads ``<project>/.workpilot/audit-trail/<trail_name>.audit.jsonl`` —
    the same path :mod:`agents.agent_audit` writes to. Returns an empty
    snapshot if the trail doesn't exist or the correlation_id is unknown.

    Never raises.
    """
    project_dir = Path(project_dir)
    storage_dir = project_dir / ".workpilot" / "audit-trail"

    try:
        from audit_trail import AuditTrail
    except ImportError:
        logger.debug("audit_trail not available — empty timeline")
        return TimelineSnapshot(correlation_id=correlation_id)

    if not storage_dir.is_dir():
        return TimelineSnapshot(correlation_id=correlation_id)

    try:
        trail = AuditTrail(storage_dir=storage_dir, name=trail_name)
        bundle = trail.replay(correlation_id)
        integrity = trail.verify()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not build timeline: %s", exc)
        return TimelineSnapshot(correlation_id=correlation_id)

    raw_events = list(bundle.events)
    if actor_filter:
        raw_events = [e for e in raw_events if e.actor == actor_filter]
    if kind_filter:
        raw_events = [e for e in raw_events if e.kind.value == kind_filter]

    entries: list[TimelineEntry] = []
    prev_ts: float | None = None
    phase_counts: dict[str, int] = {}
    for evt in raw_events:
        delta = 0.0 if prev_ts is None else evt.timestamp - prev_ts
        phase = _phase_for(evt.actor)
        phase_counts[phase] = phase_counts.get(phase, 0) + 1
        entries.append(
            TimelineEntry(
                sequence=evt.sequence,
                timestamp_unix=evt.timestamp,
                timestamp_iso=_isoformat(evt.timestamp),
                delta_seconds=delta,
                kind=evt.kind.value,
                actor=evt.actor,
                phase=phase,
                summary=evt.summary,
                payload=evt.payload or {},
                event_hash=evt.event_hash,
            )
        )
        prev_ts = evt.timestamp

    duration = 0.0
    if entries:
        duration = entries[-1].timestamp_unix - entries[0].timestamp_unix

    return TimelineSnapshot(
        correlation_id=correlation_id,
        entries=entries,
        integrity_intact=integrity.is_intact,
        integrity_reason=integrity.breakage_reason,
        duration_seconds=duration,
        phase_counts=phase_counts,
    )
