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
from .formula_matrix import compute_formula_matrix, discover_local_models

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


class FormulaMatrixRequest(BaseModel):
    ticket_id: str = Field(..., description="Identifier of the kanban ticket.")
    description: str = Field("", description="Task title/description.")
    project_root: str | None = Field(
        None, description="Project root, used to load cost/success history."
    )
    spec_dir: str | None = Field(
        None, description="Optional spec directory to refine the footprint."
    )
    providers: list[str] | None = Field(
        None, description="Restrict to these providers (lower-case)."
    )
    complexity_score: float | None = Field(
        None, description="Override the derived 1-13 complexity."
    )


@router.post("/formula-matrix")
def formula_matrix(req: FormulaMatrixRequest):
    """Compute every Provider × LLM × Effort formula for a ticket. Always 200."""
    try:
        # Discover the user's actually-installed local models (best-effort, never
        # blocks) so the Formula Lab compares their real local LLMs too.
        local_models = discover_local_models()
        matrix = compute_formula_matrix(
            ticket_id=req.ticket_id,
            description=req.description,
            spec_dir=Path(req.spec_dir).expanduser() if req.spec_dir else None,
            project_root=(
                Path(req.project_root).expanduser() if req.project_root else None
            ),
            providers=req.providers,
            complexity_score=req.complexity_score,
            local_models=local_models,
        )
        return {"success": True, "matrix": matrix.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("compute_formula_matrix failed")
        return {"success": False, "error": str(e)}
