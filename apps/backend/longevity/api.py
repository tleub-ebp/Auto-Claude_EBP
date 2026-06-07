"""HTTP routes for the Longevity Scorer.

Mounted at `/api/longevity`. One endpoint:

* `POST /score`  — run a full debt scan + scoring on a project path,
  optionally enriched with a Cobertura ``coverage.xml`` and the latest
  Dependency Sentinel snapshot (auto-discovered).
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .ingest import CoverageParseError
from .scorer import score_codebase, score_codebase_with_signals

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/longevity", tags=["longevity"])


class ScoreRequest(BaseModel):
    project_path: str = Field(..., description="Absolute path to the project root.")
    coverage_xml: str | None = Field(
        None,
        description=(
            "Optional path to a Cobertura coverage.xml — if provided, the "
            "scorer applies a low-coverage penalty (linear ramp 0.20→max, 0.80→0)."
        ),
    )
    auto_load_sentinel: bool = Field(
        True,
        description=(
            "If true (default), reads .workpilot/continuous-ai/deps/latest_scan.json "
            "from the project root and feeds the vulnerabilities into the scorer."
        ),
    )


def _validate_project_path(raw: str) -> Path:
    """Same defensive validation we apply to other path-taking endpoints."""
    if not raw or not isinstance(raw, str):
        raise ValueError("project_path must be a non-empty string")
    if raw.strip().startswith("-"):
        raise ValueError("project_path must not start with '-'")
    resolved = Path(raw).expanduser().resolve()
    if not resolved.exists():
        raise ValueError(f"project_path does not exist: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"project_path is not a directory: {resolved}")
    return resolved


@router.post("/score")
def score(req: ScoreRequest):
    """Compute a fresh longevity score for the project at `project_path`.

    When ``coverage_xml`` or ``auto_load_sentinel=true`` are supplied, the
    response includes the corresponding penalties in ``report.penalties``
    and the raw signals in ``report.summary``.
    """
    try:
        path = _validate_project_path(req.project_path)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    has_signals = req.coverage_xml is not None or req.auto_load_sentinel
    try:
        if has_signals:
            report = score_codebase_with_signals(
                path,
                coverage_xml=req.coverage_xml,
                auto_load_sentinel=req.auto_load_sentinel,
            )
        else:
            report = score_codebase(path)
        return {"success": True, "report": report.to_dict()}
    except CoverageParseError as e:
        return {"success": False, "error": f"coverage_xml: {e}"}
    except Exception as e:  # noqa: BLE001
        logger.exception("LongevityScorer.score_codebase failed")
        return {"success": False, "error": str(e)}
