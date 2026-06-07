"""HTTP routes for local-Arena variations."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .planner import compare_variations, create_variations, list_variations

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/parallel-variations", tags=["parallel-variations"])


def _validate_spec_dir(raw: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError("spec_dir must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"spec_dir does not exist or is not a directory: {p}")
    return p


@router.get("/list")
def list_endpoint(spec_dir: str = Query(...)):
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    return {"success": True, "manifest": list_variations(sd).to_dict()}


class CreateRequest(BaseModel):
    spec_dir: str = Field(...)
    count: int = Field(..., ge=1)


@router.post("/create")
def create_endpoint(req: CreateRequest):
    try:
        sd = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    try:
        manifest = create_variations(sd, req.count)
        return {"success": True, "manifest": manifest.to_dict()}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("create_variations failed")
        return {"success": False, "error": str(e)}


@router.get("/compare")
def compare_endpoint(spec_dir: str = Query(...)):
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    try:
        return {"success": True, "comparison": compare_variations(sd).to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("compare_variations failed")
        return {"success": False, "error": str(e)}
