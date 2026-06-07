"""Compliance exports built on top of an existing :class:`AuditTrail`.

Two formats:

* :func:`export_soc2_csv` — SOC2-style flat CSV log of every event in the
  trail, with stable column order so external tooling can ingest it
  predictably.
* :func:`export_gdpr_dsar` — GDPR Data Subject Access Request: groups all
  events that touch a given subject (actor or correlation_id) into a
  JSON bundle, including the integrity verdict so the recipient can
  trust the export.

Both helpers are pure: they read from an :class:`AuditTrail` instance and
return / write — they never modify the trail or open external resources.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .trail import AuditEvent, AuditTrail

SOC2_COLUMNS = (
    "sequence",
    "timestamp_iso",
    "timestamp_unix",
    "kind",
    "actor",
    "correlation_id",
    "summary",
    "event_hash",
    "prev_hash",
    "payload_json",
)


def _isoformat(unix_ts: float) -> str:
    return (
        datetime.fromtimestamp(unix_ts, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _row_for_event(evt: AuditEvent) -> dict[str, str]:
    return {
        "sequence": str(evt.sequence),
        "timestamp_iso": _isoformat(evt.timestamp),
        "timestamp_unix": f"{evt.timestamp:.6f}",
        "kind": evt.kind.value,
        "actor": evt.actor,
        "correlation_id": evt.correlation_id,
        "summary": evt.summary,
        "event_hash": evt.event_hash,
        "prev_hash": evt.prev_hash,
        "payload_json": json.dumps(
            evt.payload, separators=(",", ":"), sort_keys=True, default=str
        ),
    }


# ---------------------------------------------------------------------------
# SOC2 CSV export


def render_soc2_csv(events: Iterable[AuditEvent]) -> str:
    """Render the trail as a SOC2-style CSV string."""
    buf = io.StringIO()
    writer = csv.DictWriter(
        buf, fieldnames=SOC2_COLUMNS, lineterminator="\n", extrasaction="ignore"
    )
    writer.writeheader()
    for evt in events:
        writer.writerow(_row_for_event(evt))
    return buf.getvalue()


def export_soc2_csv(
    trail: AuditTrail,
    out_path: Path,
    *,
    since: float | None = None,
    until: float | None = None,
) -> Path:
    """Write the trail's events to ``out_path`` as CSV. Returns the path.

    ``since`` / ``until`` are unix timestamps for slicing the export window.
    """
    events = trail.filter(since=since, until=until)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_soc2_csv(events), encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# GDPR DSAR (Data Subject Access Request)


@dataclass(frozen=True)
class DSARBundle:
    """JSON-serialisable response to a Data Subject Access Request."""

    subject: str
    subject_kind: str  # "actor" | "correlation_id"
    generated_at_iso: str
    events: list[dict[str, Any]]
    integrity_intact: bool
    integrity_reason: str | None
    trail_name: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "subject": self.subject,
            "subject_kind": self.subject_kind,
            "generated_at_iso": self.generated_at_iso,
            "trail_name": self.trail_name,
            "integrity": {
                "intact": self.integrity_intact,
                "reason": self.integrity_reason,
            },
            "event_count": len(self.events),
            "events": self.events,
        }


def build_dsar_bundle(
    trail: AuditTrail,
    *,
    actor: str | None = None,
    correlation_id: str | None = None,
) -> DSARBundle:
    """Collect every event referencing the subject and bundle it.

    Exactly one of ``actor`` / ``correlation_id`` must be supplied. The
    integrity verdict comes from :meth:`AuditTrail.verify` so the recipient
    knows whether the bundled events form a tamper-evident chain.
    """
    if (actor is None) == (correlation_id is None):
        raise ValueError(
            "Provide exactly one of `actor` or `correlation_id` to identify "
            "the data subject."
        )

    if actor is not None:
        subject = actor
        subject_kind = "actor"
        events = trail.filter(actor=actor)
    else:
        subject = correlation_id  # type: ignore[assignment]
        subject_kind = "correlation_id"
        # `replay()` returns the sub-chain for a correlation_id.
        bundle = trail.replay(correlation_id)  # type: ignore[arg-type]
        events = list(bundle.events)

    integrity = trail.verify()

    return DSARBundle(
        subject=subject,
        subject_kind=subject_kind,
        generated_at_iso=_isoformat(datetime.now(tz=timezone.utc).timestamp()),
        events=[evt.to_dict() for evt in events],
        integrity_intact=integrity.is_intact,
        integrity_reason=integrity.breakage_reason,
        trail_name=trail.name,
    )


def export_gdpr_dsar(
    trail: AuditTrail,
    out_path: Path,
    *,
    actor: str | None = None,
    correlation_id: str | None = None,
) -> Path:
    """Write the DSAR bundle to ``out_path`` as JSON. Returns the path."""
    bundle = build_dsar_bundle(trail, actor=actor, correlation_id=correlation_id)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(bundle.to_dict(), indent=2, sort_keys=False, default=str),
        encoding="utf-8",
    )
    return out_path
