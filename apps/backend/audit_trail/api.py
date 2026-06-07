"""HTTP routes for the AuditTrail.

Mounted at `/api/audit-trail`. Endpoints:

* `POST /append`              — append one event
* `POST /append-decision`     — convenience for DECISION_MADE events
* `GET  /events`              — filter events (actor / kind / since / until)
* `GET  /replay/{cid}`        — replay all events for a correlation_id
* `GET  /verify`              — confirm chain integrity
* `GET  /trails`              — list trails on disk
* `GET  /export/soc2`         — flat CSV log for SOC2 audits
* `GET  /export/gdpr`         — JSON DSAR bundle for GDPR data subject requests
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, Query
from fastapi import Path as PathParam
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from .exports import build_dsar_bundle, render_soc2_csv
from .trail import AuditEventKind, AuditTrail, Decision

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audit-trail", tags=["audit-trail"])

# One trail instance per (storage_dir, name) so concurrent appends
# don't cross streams.
_trails: dict[tuple[str, str], AuditTrail] = {}
_trails_lock = Lock()


def _allowed_storage_roots() -> list[Path]:
    """Roots under which audit-trail storage_dir is allowed to live.

    Why: every endpoint accepts ``storage_dir`` from the HTTP request and
    creates the directory if missing (via Path.mkdir). Without an allowlist,
    a caller on the same host could trigger arbitrary directory creation
    and write JSONL files to surprising locations. We restrict to the env
    var ``AUDIT_TRAIL_ALLOWED_ROOTS`` (os-pathsep separated) when set, or
    fall back to the current working directory only.
    """
    raw = os.environ.get("AUDIT_TRAIL_ALLOWED_ROOTS", "").strip()
    if not raw:
        return [Path.cwd().resolve()]
    return [Path(p).expanduser().resolve() for p in raw.split(os.pathsep) if p.strip()]


def _validate_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("storage_dir must not be empty or start with '-'")
    p = Path(raw).expanduser().resolve()
    allowed = _allowed_storage_roots()
    if not any(p == root or p.is_relative_to(root) for root in allowed):
        raise ValueError(
            "storage_dir is not under any allowed root "
            "(set AUDIT_TRAIL_ALLOWED_ROOTS to extend the allowlist)"
        )
    p.mkdir(parents=True, exist_ok=True)
    return p


def _get_trail(storage_dir: str, name: str) -> AuditTrail:
    path = _validate_dir(storage_dir)
    key = (str(path), name)
    with _trails_lock:
        trail = _trails.get(key)
        if trail is None:
            trail = AuditTrail(storage_dir=path, name=name)
            _trails[key] = trail
        return trail


class AppendRequest(BaseModel):
    storage_dir: str
    trail_name: str = Field("default", min_length=1, max_length=128)
    kind: str = Field(..., min_length=1)
    actor: str = Field(..., min_length=1)
    correlation_id: str = Field(..., min_length=1)
    summary: str = ""
    payload: dict[str, Any] | None = None


class AppendDecisionRequest(BaseModel):
    storage_dir: str
    trail_name: str = Field("default", min_length=1, max_length=128)
    actor: str = Field(..., min_length=1)
    correlation_id: str = Field(..., min_length=1)
    decision_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    chosen_option: str = Field(..., min_length=1)
    rejected_options: list[str] | None = None
    rationale: str = ""
    risk_score: float = 0.0


@router.post("/append")
def append(req: AppendRequest):
    try:
        trail = _get_trail(req.storage_dir, req.trail_name)
        evt = trail.append(
            kind=req.kind,
            actor=req.actor,
            correlation_id=req.correlation_id,
            summary=req.summary,
            payload=req.payload,
        )
        return {"success": True, "event": evt.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("append failed")
        return {"success": False, "error": str(e)}


@router.post("/append-decision")
def append_decision(req: AppendDecisionRequest):
    try:
        trail = _get_trail(req.storage_dir, req.trail_name)
        decision = Decision(
            decision_id=req.decision_id,
            title=req.title,
            chosen_option=req.chosen_option,
            rejected_options=tuple(req.rejected_options or ()),
            rationale=req.rationale,
            risk_score=req.risk_score,
        )
        evt = trail.append_decision(
            actor=req.actor,
            correlation_id=req.correlation_id,
            decision=decision,
        )
        return {"success": True, "event": evt.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("append_decision failed")
        return {"success": False, "error": str(e)}


@router.get("/events")
def events(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    actor: str | None = Query(None),
    kind: str | None = Query(None),
    since: float | None = Query(None),
    until: float | None = Query(None),
):
    try:
        trail = _get_trail(storage_dir, trail_name)
        # Validate the kind early to give a clean 400 instead of leaking
        # the underlying ValueError later.
        if kind is not None:
            try:
                AuditEventKind(kind)
            except ValueError as e:
                return {"success": False, "error": str(e)}
        results = trail.filter(actor=actor, kind=kind, since=since, until=until)
        return {
            "success": True,
            "events": [e.to_dict() for e in results],
            "count": len(results),
        }
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("events failed")
        return {"success": False, "error": str(e)}


@router.get("/replay/{correlation_id}")
def replay(
    correlation_id: str = PathParam(..., min_length=1, max_length=256),
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
):
    try:
        trail = _get_trail(storage_dir, trail_name)
        bundle = trail.replay(correlation_id)
        return {"success": True, "bundle": bundle.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("replay failed")
        return {"success": False, "error": str(e)}


@router.get("/verify")
def verify(storage_dir: str = Query(...), trail_name: str = Query("default")):
    try:
        trail = _get_trail(storage_dir, trail_name)
        report = trail.verify()
        return {"success": True, "integrity": report.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("verify failed")
        return {"success": False, "error": str(e)}


@router.get("/trails")
def list_trails(storage_dir: str = Query(...)):
    try:
        path = _validate_dir(storage_dir)
        return {"success": True, "trails": AuditTrail.list_trails(path)}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("list_trails failed")
        return {"success": False, "error": str(e)}


@router.get("/export/soc2")
def export_soc2(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    since: float | None = Query(None),
    until: float | None = Query(None),
):
    """Return the trail as a SOC2-formatted CSV (text/csv)."""
    try:
        trail = _get_trail(storage_dir, trail_name)
        events = trail.filter(since=since, until=until)
        csv_text = render_soc2_csv(events)
        return PlainTextResponse(
            content=csv_text,
            media_type="text/csv",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="audit_trail_{trail_name}_soc2.csv"'
                ),
            },
        )
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("export_soc2 failed")
        return {"success": False, "error": str(e)}


@router.get("/export/gdpr")
def export_gdpr(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    actor: str | None = Query(None),
    correlation_id: str | None = Query(None),
):
    """Return a GDPR DSAR bundle (JSON) for the given data subject.

    Exactly one of ``actor`` / ``correlation_id`` must be supplied.
    """
    try:
        trail = _get_trail(storage_dir, trail_name)
        bundle = build_dsar_bundle(trail, actor=actor, correlation_id=correlation_id)
        return {"success": True, "bundle": bundle.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("export_gdpr failed")
        return {"success": False, "error": str(e)}
