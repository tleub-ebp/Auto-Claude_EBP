"""HTTP route for the fine-grained progress indicator."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query

from .builder import build_progress_indicator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/progress-indicator", tags=["progress-indicator"])


def _validate_spec_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("spec_dir must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"spec_dir does not exist or is not a directory: {p}")
    return p


@router.get("/")
def indicator(spec_dir: str = Query(...)):
    """Return the fine-grained progress label for a spec."""
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    try:
        snap = build_progress_indicator(sd)
        return {"success": True, "indicator": snap.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("build_progress_indicator failed")
        return {"success": False, "error": str(e)}
