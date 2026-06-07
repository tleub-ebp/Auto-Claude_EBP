"""HTTP routes for restart planning.

Mounted at `/api/restart`. Two endpoints:

* `GET  /plan?spec_dir=...`   — read-only, lists which restart modes are
  available + cleanup that would happen
* `POST /prepare`              — performs cleanup only (deletes
  intermediate files); never spawns an agent. The frontend triggers the
  actual restart via its existing IPC handlers.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .planner import RestartMode, plan_restart, prepare_restart

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/restart", tags=["restart"])


def _validate_spec_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("spec_dir must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"spec_dir does not exist or is not a directory: {p}")
    return p


@router.get("/plan")
def plan(spec_dir: str = Query(...)):
    """Inspect a spec and report which restart modes are available."""
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    try:
        result = plan_restart(sd)
        return {"success": True, "plan": result.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("plan_restart failed")
        return {"success": False, "error": str(e)}


class PrepareRequest(BaseModel):
    spec_dir: str = Field(..., description="Spec directory.")
    mode: str = Field(..., description="One of: qa, coder, full.")


@router.post("/prepare")
def prepare(req: PrepareRequest):
    """Run filesystem cleanup for the given mode. Returns deleted files.

    Does NOT spawn an agent — the frontend triggers that separately via
    its IPC handlers, after this endpoint has cleaned up stale state.
    """
    try:
        sd = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    try:
        mode = RestartMode(req.mode)
    except ValueError:
        return {
            "success": False,
            "error": (
                f"unknown restart mode {req.mode!r}; "
                f"valid: {[m.value for m in RestartMode]}"
            ),
        }

    try:
        result = prepare_restart(sd, mode)
        return {"success": True, **result}
    except Exception as e:  # noqa: BLE001
        logger.exception("prepare_restart failed")
        return {"success": False, "error": str(e)}
