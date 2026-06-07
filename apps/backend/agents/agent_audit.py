"""Thin facade around AuditTrail for the existing agents (coder, planner, qa).

Goals:
  * Single-import: agents only need ``from agents.agent_audit import audit_agent``.
  * Lazy + best-effort: if AuditTrail or storage path is unavailable, the helpers
    no-op rather than blowing up an in-flight build.
  * Per-project trail at ``<project>/.workpilot/audit-trail/`` so events from
    multiple specs end up in one chain that can be replayed cross-spec.

Design choices that should be revisited if usage grows:
  * One trail per project, name ``"default"``. If multi-tenant or per-feature
    audit becomes a thing, switch to per-spec trails.
  * ``correlation_id`` defaults to ``spec_dir.name`` (the spec_id). All events
    from the same spec end up grouped by ``trail.replay(spec_id)``.
  * We never raise from the helpers — auditing must never block work.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Import lazily-tolerant: if audit_trail isn't on the path, the helpers degrade
# to no-ops. This keeps the agents importable in stripped-down environments.
try:
    from audit_trail import AuditEventKind, AuditTrail
except ImportError:  # pragma: no cover — import-time fallback
    AuditTrail = None  # type: ignore[assignment]
    AuditEventKind = None  # type: ignore[assignment]


_TRAIL_DIRNAME = ".workpilot"
_TRAIL_SUBDIR = "audit-trail"
_DEFAULT_TRAIL_NAME = "default"


def _project_trail_dir(project_dir: Path) -> Path:
    return Path(project_dir) / _TRAIL_DIRNAME / _TRAIL_SUBDIR


def _open_trail(project_dir: Path, name: str = _DEFAULT_TRAIL_NAME):
    """Return an AuditTrail or None if unavailable."""
    if AuditTrail is None:
        return None
    try:
        storage_dir = _project_trail_dir(project_dir)
        storage_dir.mkdir(parents=True, exist_ok=True)
        return AuditTrail(storage_dir=storage_dir, name=name)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not open audit trail at %s: %s", project_dir, exc)
        return None


def audit_event(
    project_dir: Path,
    *,
    kind: str,
    actor: str,
    correlation_id: str,
    summary: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Append a single event. Best-effort — never raises."""
    trail = _open_trail(project_dir)
    if trail is None:
        return
    try:
        trail.append(
            kind=kind,
            actor=actor,
            correlation_id=correlation_id,
            summary=summary,
            payload=payload or {},
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Audit append failed (%s): %s", kind, exc)


@contextmanager
def audit_agent(
    project_dir: Path,
    *,
    actor: str,
    spec_dir: Path | None = None,
    correlation_id: str | None = None,
    summary: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Iterator[None]:
    """Wrap an agent run with ``agent_invoked`` + ``agent_completed/failed`` events.

    Use as::

        async def run():
            with audit_agent(project_dir, actor="coder", spec_dir=spec_dir,
                             metadata={"model": model}):
                await do_work()

    If the trail is not available the context is a plain pass-through. Re-raises
    any in-block exception after recording a failure event, so call-sites keep
    their existing error handling.
    """
    cid = correlation_id or (spec_dir.name if spec_dir else actor)
    base_payload = dict(metadata or {})
    if spec_dir is not None:
        base_payload.setdefault("spec_dir", str(spec_dir))

    audit_event(
        project_dir,
        kind="agent_invoked",
        actor=actor,
        correlation_id=cid,
        summary=summary or f"{actor} invoked",
        payload=base_payload,
    )

    try:
        yield
    except Exception as exc:
        audit_event(
            project_dir,
            kind="agent_failed",
            actor=actor,
            correlation_id=cid,
            summary=f"{actor} failed: {type(exc).__name__}",
            payload={**base_payload, "error": str(exc)[:500]},
        )
        raise
    else:
        audit_event(
            project_dir,
            kind="agent_completed",
            actor=actor,
            correlation_id=cid,
            summary=f"{actor} completed",
            payload=base_payload,
        )


def audit_decision(
    project_dir: Path,
    *,
    actor: str,
    spec_dir: Path | None,
    decision_id: str,
    title: str,
    chosen: str,
    rationale: str,
    rejected: tuple[str, ...] = (),
    correlation_id: str | None = None,
) -> None:
    """Record an explicit decision (model fallback, retry strategy, etc)."""
    trail = _open_trail(Path(project_dir))
    if trail is None:
        return
    try:
        from audit_trail import Decision

        cid = correlation_id or (spec_dir.name if spec_dir else actor)
        trail.append_decision(
            actor=actor,
            correlation_id=cid,
            decision=Decision(
                decision_id=decision_id,
                title=title,
                chosen_option=chosen,
                rejected_options=tuple(rejected),
                rationale=rationale,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Audit decision append failed: %s", exc)
