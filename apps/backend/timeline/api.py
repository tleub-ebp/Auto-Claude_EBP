"""HTTP route for the agent timeline (Kanban drawer)."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query

from .builder import build_timeline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/timeline", tags=["timeline"])


def _validate_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("project_dir must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"project_dir does not exist or is not a directory: {p}")
    return p


@router.get("/{correlation_id}")
def timeline(
    correlation_id: str,
    project_dir: str = Query(...),
    trail_name: str = Query("default"),
    actor: str | None = Query(None),
    kind: str | None = Query(None),
):
    """Return a UI-friendly timeline for a single correlation_id (spec)."""
    try:
        pdir = _validate_dir(project_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    try:
        snap = build_timeline(
            pdir,
            correlation_id,
            trail_name=trail_name,
            actor_filter=actor,
            kind_filter=kind,
        )
        return {"success": True, "timeline": snap.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("build_timeline failed")
        return {"success": False, "error": str(e)}
