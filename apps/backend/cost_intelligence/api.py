"""HTTP route for the pre-build cost estimator.

Mounted at `/api/cost-estimator`. One endpoint:

* `POST /preview` — given a spec directory, return per-phase token /
  cost estimates so the UI can show a "do you want to proceed?" modal
  before the agent burns real tokens.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .estimator import estimate_build_cost

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cost-estimator", tags=["cost-estimator"])


class PreviewRequest(BaseModel):
    spec_dir: str = Field(..., description="Absolute path to the spec directory.")


def _validate_spec_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("spec_dir must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"spec_dir does not exist or is not a directory: {p}")
    return p


@router.post("/preview")
def preview(req: PreviewRequest):
    """Estimate build cost without spending any tokens. Always 200."""
    try:
        spec_dir = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    try:
        estimate = estimate_build_cost(spec_dir)
        return {"success": True, "estimate": estimate.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("estimate_build_cost failed")
        return {"success": False, "error": str(e)}
