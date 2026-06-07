"""HTTP route to invoke the virtual reviewer (advisory mode).

Mounted at `/api/virtual-reviewer`. Two endpoints:

* `GET  /summary`  — compute the input summary (read-only, no SDK)
* `POST /run`      — execute the reviewer (always uses the deterministic
  stub here; the real SDK-backed call needs an in-process client and is
  better wired from inside the agent runtime).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .reviewer import (
    VIRTUAL_REVIEW_FILENAME,
    compute_review_summary,
    run_virtual_review,
    virtual_reviewer_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/virtual-reviewer", tags=["virtual-reviewer"])


def _validate_dir(raw: str, label: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError(f"{label} must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory: {p}")
    return p


@router.get("/summary")
def summary(
    spec_dir: str = Query(...),
    project_dir: str = Query(...),
):
    try:
        sd = _validate_dir(spec_dir, "spec_dir")
        pd = _validate_dir(project_dir, "project_dir")
    except ValueError as e:
        return {"success": False, "error": str(e)}
    summary = compute_review_summary(sd, pd)
    return {
        "success": True,
        "summary": summary.to_dict(),
        "enabled": virtual_reviewer_enabled(),
    }


class RunRequest(BaseModel):
    spec_dir: str = Field(...)
    project_dir: str = Field(...)


@router.post("/run")
def run(req: RunRequest):
    """Run the virtual reviewer (deterministic-stub mode from HTTP).

    The full SDK-backed call requires an in-process invokable client and
    is wired from inside the agent runtime, not from this HTTP route.
    Calling this endpoint always writes the stub fallback so callers
    have a predictable artefact to display.
    """
    try:
        sd = _validate_dir(req.spec_dir, "spec_dir")
        pd = _validate_dir(req.project_dir, "project_dir")
    except ValueError as e:
        return {"success": False, "error": str(e)}

    if not virtual_reviewer_enabled():
        return {
            "success": False,
            "error": (
                "virtual reviewer is disabled — "
                "set WORKPILOT_VIRTUAL_REVIEWER_ENABLED=1 to enable"
            ),
        }

    try:
        # client=None → stub fallback. The full SDK-backed run is opt-in
        # from the agent runtime; this HTTP endpoint stays simple.
        path = asyncio.run(run_virtual_review(None, sd, pd))
        if path is None:
            return {"success": False, "error": "virtual_review write failed"}
        return {
            "success": True,
            "written_to": str(path),
            "filename": VIRTUAL_REVIEW_FILENAME,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("run_virtual_review failed")
        return {"success": False, "error": str(e)}
