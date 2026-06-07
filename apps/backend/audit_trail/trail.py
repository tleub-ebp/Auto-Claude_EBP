"""Audit Trail — append-only event log with hash chaining.

Storage: one JSON-Lines file per `AuditTrail` instance, plus a compact
in-memory index. Each event includes a SHA-256 over its content + the
previous event's hash, so any tampering is detectable by replaying the
chain.

Replay: given a `correlation_id` (e.g. spec id, task id, decision id),
return every event in causal order — that's the "rejouer cette décision"
feature.

This is intentionally **not a database**. It's a flat append-only log,
the simplest thing that gives the SOC2 / GDPR audit guarantees:

* **Append-only**: no `update` or `delete` API.
* **Tamper-evident**: hash chain detects any rewrite.
* **Replayable**: every event keeps enough context to reconstruct state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from threading import Lock
from typing import Any

logger = logging.getLogger(__name__)


# Whitelist for trail names — they end up in the filesystem path.
_TRAIL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class AuditEventKind(str, Enum):
    """Coarse event taxonomy. Add liberally — the kind is just metadata."""

    AGENT_INVOKED = "agent_invoked"
    AGENT_COMPLETED = "agent_completed"
    AGENT_FAILED = "agent_failed"
    AGENT_PAUSED = "agent_paused"
    DECISION_MADE = "decision_made"
    APPROVAL_GIVEN = "approval_given"
    APPROVAL_REVOKED = "approval_revoked"
    FILE_CHANGED = "file_changed"
    POLICY_VIOLATED = "policy_violated"
    USER_ACTION = "user_action"
    SYSTEM_EVENT = "system_event"


@dataclass(frozen=True)
class Decision:
    """A reusable structured payload for `DECISION_MADE` events."""

    decision_id: str
    title: str
    chosen_option: str
    rejected_options: tuple[str, ...] = ()
    rationale: str = ""
    risk_score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision_id": self.decision_id,
            "title": self.title,
            "chosen_option": self.chosen_option,
            "rejected_options": list(self.rejected_options),
            "rationale": self.rationale,
            "risk_score": self.risk_score,
        }


@dataclass(frozen=True)
class AuditEvent:
    """A single immutable entry in the trail."""

    sequence: int  # 0-based, monotonically increasing
    timestamp: float  # unix
    kind: AuditEventKind
    actor: str  # who did it (agent name, user id, "system")
    correlation_id: str  # spec id, task id, decision id… for replay grouping
    summary: str
    payload: dict[str, Any]
    prev_hash: str  # hex digest of the previous event ("genesis" for the first)
    event_hash: str  # hex digest of this event's canonical content + prev_hash

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> AuditEvent:
        return cls(
            sequence=int(raw["sequence"]),
            timestamp=float(raw["timestamp"]),
            kind=AuditEventKind(raw["kind"]),
            actor=raw["actor"],
            correlation_id=raw["correlation_id"],
            summary=raw["summary"],
            payload=raw.get("payload", {}),
            prev_hash=raw["prev_hash"],
            event_hash=raw["event_hash"],
        )


@dataclass
class IntegrityReport:
    is_intact: bool
    events_checked: int
    first_broken_sequence: int | None = None
    breakage_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReplayBundle:
    correlation_id: str
    events: list[AuditEvent] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "correlation_id": self.correlation_id,
            "events": [e.to_dict() for e in self.events],
            "event_count": len(self.events),
        }


# ----------------------------------------------------------------------
# Trail


_GENESIS_HASH = "genesis"


def _canonical_payload(payload: dict[str, Any]) -> str:
    """Stable JSON for hashing — sorted keys, no whitespace.

    We don't allow non-JSON-serialisable objects; the caller must supply
    a clean dict.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _compute_hash(
    sequence: int,
    timestamp: float,
    kind: str,
    actor: str,
    correlation_id: str,
    summary: str,
    payload: dict[str, Any],
    prev_hash: str,
) -> str:
    blob = "|".join(
        [
            str(sequence),
            f"{timestamp:.6f}",
            kind,
            actor,
            correlation_id,
            summary,
            _canonical_payload(payload),
            prev_hash,
        ]
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class AuditTrail:
    """Persistent, tamper-evident, append-only event log."""

    def __init__(
        self,
        storage_dir: Path | str,
        name: str = "default",
    ) -> None:
        if not _TRAIL_NAME_RE.fullmatch(name):
            raise ValueError(
                f"Invalid trail name {name!r}: must match {_TRAIL_NAME_RE.pattern}"
            )
        self.storage_dir = Path(storage_dir)
        self.name = name
        self.path = self.storage_dir / f"{name}.audit.jsonl"
        self._lock = Lock()
        self._events: list[AuditEvent] = []
        self._last_hash: str = _GENESIS_HASH
        self._loaded = False

    # ------------------------------------------------------------------
    # Persistence

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        from .encryption import maybe_decrypt_line

        self.storage_dir.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as fh:
                    for raw_line in fh:
                        stripped = raw_line.strip()
                        if not stripped:
                            continue
                        # Decrypt if the line was Fernet-wrapped at write
                        # time. Cleartext lines pass through unchanged.
                        decoded = maybe_decrypt_line(stripped)
                        raw = json.loads(decoded)
                        self._events.append(AuditEvent.from_dict(raw))
            except (OSError, json.JSONDecodeError) as e:
                logger.warning("Could not fully load trail %s: %s", self.path, e)
            if self._events:
                self._last_hash = self._events[-1].event_hash
        self._loaded = True

    def _append_to_disk(self, event: AuditEvent) -> None:
        from .encryption import maybe_encrypt_line

        # Hash chain is computed on the cleartext event (see _hash_for_event)
        # so encryption is purely a storage concern — key rotation does not
        # invalidate the chain.
        cleartext = json.dumps(event.to_dict(), separators=(",", ":"))
        line = maybe_encrypt_line(cleartext) + "\n"
        # Open in append mode — atomic at the line level on POSIX, good
        # enough for an audit log.
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except (OSError, AttributeError):
                # fsync isn't available on every FS; not fatal for tests.
                pass

    # ------------------------------------------------------------------
    # Public API

    def append(
        self,
        kind: AuditEventKind | str,
        actor: str,
        correlation_id: str,
        summary: str,
        payload: dict[str, Any] | None = None,
    ) -> AuditEvent:
        """Append an event. Thread-safe; hash-chained."""
        if not actor:
            raise ValueError("actor is required")
        if not correlation_id:
            raise ValueError("correlation_id is required")
        kind_enum = AuditEventKind(kind) if isinstance(kind, str) else kind
        clean_payload = payload or {}

        # Round-trip through JSON early so we fail fast if the payload
        # isn't serialisable. We use the strict encoder here (no `default=`
        # fallback) to catch sets, custom objects, etc.
        try:
            json.dumps(clean_payload, sort_keys=True)
        except (TypeError, ValueError) as e:
            raise ValueError(f"payload is not JSON-serialisable: {e}") from e

        with self._lock:
            self._ensure_loaded()
            sequence = len(self._events)
            timestamp = time.time()
            prev = self._last_hash
            event_hash = _compute_hash(
                sequence=sequence,
                timestamp=timestamp,
                kind=kind_enum.value,
                actor=actor,
                correlation_id=correlation_id,
                summary=summary,
                payload=clean_payload,
                prev_hash=prev,
            )
            event = AuditEvent(
                sequence=sequence,
                timestamp=timestamp,
                kind=kind_enum,
                actor=actor,
                correlation_id=correlation_id,
                summary=summary,
                payload=clean_payload,
                prev_hash=prev,
                event_hash=event_hash,
            )
            self._events.append(event)
            self._last_hash = event_hash
            self._append_to_disk(event)
            return event

    def append_decision(
        self,
        actor: str,
        correlation_id: str,
        decision: Decision,
    ) -> AuditEvent:
        """Convenience wrapper for `DECISION_MADE` events."""
        return self.append(
            kind=AuditEventKind.DECISION_MADE,
            actor=actor,
            correlation_id=correlation_id,
            summary=f"{decision.title}: chose {decision.chosen_option!r}",
            payload=decision.to_dict(),
        )

    # ------------------------------------------------------------------
    # Read API — never mutates state.

    def all(self) -> list[AuditEvent]:
        with self._lock:
            self._ensure_loaded()
            return list(self._events)

    def length(self) -> int:
        with self._lock:
            self._ensure_loaded()
            return len(self._events)

    def replay(self, correlation_id: str) -> ReplayBundle:
        """Return every event sharing a correlation_id, in causal order."""
        with self._lock:
            self._ensure_loaded()
            events = [e for e in self._events if e.correlation_id == correlation_id]
        return ReplayBundle(correlation_id=correlation_id, events=events)

    def filter(
        self,
        actor: str | None = None,
        kind: AuditEventKind | str | None = None,
        since: float | None = None,
        until: float | None = None,
    ) -> list[AuditEvent]:
        """Cheap server-side filter for UIs."""
        kind_enum = AuditEventKind(kind) if isinstance(kind, str) else kind
        with self._lock:
            self._ensure_loaded()
            result: list[AuditEvent] = []
            for e in self._events:
                if actor is not None and e.actor != actor:
                    continue
                if kind_enum is not None and e.kind != kind_enum:
                    continue
                if since is not None and e.timestamp < since:
                    continue
                if until is not None and e.timestamp > until:
                    continue
                result.append(e)
            return result

    # ------------------------------------------------------------------
    # Integrity

    def verify(self) -> IntegrityReport:
        """Walk the chain and confirm every hash matches.

        Returns the first broken event so the operator knows where the
        tampering happened.
        """
        with self._lock:
            self._ensure_loaded()
            events = list(self._events)

        prev_hash = _GENESIS_HASH
        for event in events:
            expected = _compute_hash(
                sequence=event.sequence,
                timestamp=event.timestamp,
                kind=event.kind.value,
                actor=event.actor,
                correlation_id=event.correlation_id,
                summary=event.summary,
                payload=event.payload,
                prev_hash=prev_hash,
            )
            if event.prev_hash != prev_hash:
                return IntegrityReport(
                    is_intact=False,
                    events_checked=event.sequence,
                    first_broken_sequence=event.sequence,
                    breakage_reason=(
                        f"prev_hash mismatch at sequence {event.sequence}: "
                        f"expected {prev_hash[:16]}…, got {event.prev_hash[:16]}…"
                    ),
                )
            if event.event_hash != expected:
                return IntegrityReport(
                    is_intact=False,
                    events_checked=event.sequence,
                    first_broken_sequence=event.sequence,
                    breakage_reason=(
                        f"event_hash mismatch at sequence {event.sequence}: "
                        f"the recorded payload doesn't match the stored hash"
                    ),
                )
            prev_hash = event.event_hash

        return IntegrityReport(is_intact=True, events_checked=len(events))

    # ------------------------------------------------------------------
    # Discovery

    @classmethod
    def list_trails(cls, storage_dir: Path | str) -> list[str]:
        root = Path(storage_dir)
        if not root.is_dir():
            return []
        return sorted(p.stem.removesuffix(".audit") for p in root.glob("*.audit.jsonl"))


def open_trail(storage_dir: Path | str, name: str = "default") -> AuditTrail:
    """Convenience constructor."""
    return AuditTrail(storage_dir=storage_dir, name=name)
