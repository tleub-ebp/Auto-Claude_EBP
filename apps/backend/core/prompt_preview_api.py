"""HTTP route for the system prompt preview (debug helper).

Mounted at `/api/prompt-preview`. One endpoint:

* `GET /` — given a project + spec + agent_type, return the system
  prompt that would be assembled by ``create_client``, plus the resolved
  model, provider, and allowed tools. No SDK call, no spawn.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query

from .prompt_preview import build_prompt_preview

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt-preview", tags=["prompt-preview"])


def _validate_dir(raw: str, label: str) -> Path:
    if not raw or raw.strip().startswith("-"):
        raise ValueError(f"{label} must be a non-empty path not starting with '-'")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory: {p}")
    return p


@router.get("/")
def preview(
    project_dir: str = Query(...),
    spec_dir: str = Query(...),
    agent_type: str = Query("coder"),
):
    """Reconstruct the would-be system prompt for the given agent."""
    try:
        pdir = _validate_dir(project_dir, "project_dir")
        sdir = _validate_dir(spec_dir, "spec_dir")
    except ValueError as e:
        return {"success": False, "error": str(e)}

    try:
        snapshot = build_prompt_preview(pdir, sdir, agent_type=agent_type)
        return {"success": True, "preview": snapshot.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("build_prompt_preview failed")
        return {"success": False, "error": str(e)}
