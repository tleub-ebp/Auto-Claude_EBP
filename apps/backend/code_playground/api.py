"""HTTP routes for the Code Playground.

Mounted at `/api/code-playground`. Two endpoints:

* `GET  /languages` — which interpreters are installed on the host
* `POST /run`       — execute a snippet, returns structured stdout/stderr/exit

Safety surface (defence in depth — most of these are already enforced by the
runner, the API just adds input bounds + per-request timeout caps):

* snippet length capped at 64 KiB → reject obvious payload bombs early
* timeout capped at 30 s          → no caller can hold a worker indefinitely
* stdin capped at 16 KiB
* language must be one of the installed interpreters
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .runner import (
    PlaygroundLanguage,
    PlaygroundRunner,
    PlaygroundTimeout,
    available_languages,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/code-playground", tags=["code-playground"])

MAX_SNIPPET_BYTES = 64 * 1024
MAX_STDIN_BYTES = 16 * 1024
MAX_TIMEOUT_SECONDS = 30.0


class RunRequest(BaseModel):
    snippet: str = Field(..., description="Source code to execute.")
    language: str = Field(
        "python", description="One of the values returned by GET /languages."
    )
    timeout_seconds: float = Field(
        10.0,
        gt=0,
        le=MAX_TIMEOUT_SECONDS,
        description=f"Wall-clock cap. Hard ceiling = {MAX_TIMEOUT_SECONDS}s.",
    )
    stdin: str = Field("", description="Bytes piped to the snippet's stdin.")


@router.get("/languages")
def list_languages() -> dict[str, list[str]]:
    """Languages whose interpreter is available on the host's PATH."""
    return {"languages": [lang.value for lang in available_languages()]}


@router.post("/run")
def run(req: RunRequest) -> dict:
    if len(req.snippet.encode("utf-8")) > MAX_SNIPPET_BYTES:
        return {
            "success": False,
            "error": f"snippet exceeds {MAX_SNIPPET_BYTES} bytes",
        }
    if len(req.stdin.encode("utf-8")) > MAX_STDIN_BYTES:
        return {"success": False, "error": f"stdin exceeds {MAX_STDIN_BYTES} bytes"}

    try:
        language = PlaygroundLanguage(req.language)
    except ValueError:
        return {
            "success": False,
            "error": f"unknown language {req.language!r} — try GET /languages",
        }

    if language not in available_languages():
        return {
            "success": False,
            "error": f"interpreter for {language.value!r} is not installed",
        }

    runner = PlaygroundRunner(timeout_seconds=req.timeout_seconds)
    try:
        result = runner.run(req.snippet, language, stdin=req.stdin)
    except PlaygroundTimeout as exc:
        return {"success": False, "error": str(exc), "timed_out": True}
    except Exception:
        # Defensive — runner errors should not 500 the whole API.
        logger.exception("Code playground run failed")
        return {"success": False, "error": "internal playground error"}

    payload = result.to_dict()
    payload["success"] = True
    return payload
