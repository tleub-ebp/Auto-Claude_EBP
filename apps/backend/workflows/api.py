"""What the chosen effort level buys, before the build starts.

Chantier 4 asks for the resolved profile to be shown *before* execution, so the
user sees what their effort setting bought or cost rather than inferring it
afterwards from a log. Until now it was printed to a terminal the Kanban user
never looks at.

This endpoint answers three questions the CLI banner answers, plus one it
cannot:

* which phases will run, in the order the workflow declares them;
* which were dropped, and by what — an effort level, or a change set with no
  matching files;
* which asked for a dispatch this provider cannot give;
* and **what the next level up would add**, which is the actual question
  someone is asking when they look at an effort selector.

Side effects
------------
None, deliberately. Provider resolution goes through `get_phase_provider`,
which reads metadata and the IPC selection and nothing else. The other
resolution path (`_get_active_provider`) consumes the single-shot
RESUME_WITH_PROVIDER marker, and an endpoint the UI may poll must never eat a
choice the next build was supposed to honour.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflow-profile", tags=["workflow-profile"])

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_WORKFLOW = "feature-build"


# A caller-supplied path is capped before it is touched, so a pathological
# string cannot be walked at all. Same ceiling as the sibling endpoint.
_MAX_PATH_LEN = 4096


def _validate_dir(raw: str, label: str, base: Path | None = None) -> Path:
    """Resolve a caller-supplied directory, refusing traversal.

    `base` is for paths that are *supposed* to stay under a known root — the
    spec directory under its project. It is deliberately not applied to
    `project_dir` itself: a user's project lives wherever they keep it, and
    almost never inside this repository. `slash_commands.api._safe_project_dir`
    settled that policy for the sibling endpoint, with the same reasoning that
    applies here — this endpoint is read-only and side-effect free, so an
    unknown path yields an error, never a disclosure.

    Anchoring `project_dir` to `_REPO_ROOT` instead made the endpoint reject
    every real call, since the Kanban sends the project the user opened; a
    later rule that the path be *relative* rejected the rest, an absolute path
    being the only thing the renderer has.
    """
    if not raw or raw.strip().startswith("-"):
        raise ValueError(f"{label} must be a non-empty path not starting with '-'")
    if len(raw) > _MAX_PATH_LEN:
        raise ValueError(f"{label} is longer than {_MAX_PATH_LEN} characters")

    candidate = Path(raw).expanduser()
    if ".." in candidate.parts:
        raise ValueError(f"{label} must not contain parent-directory traversal")

    p = candidate.resolve()
    if base is not None:
        b = base.expanduser().resolve()
        try:
            p.relative_to(b)
        except ValueError:
            raise ValueError(f"{label} escapes the directory it belongs to") from None
    if not p.exists() or not p.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory")
    return p


def _resolve_spec_dir(
    spec_dir: str | None, project_dir: str | None, spec_id: str | None
) -> Path:
    """The spec directory, given either the path or the pair that names it.

    The renderer knows a task by its project and its spec id, not by an
    absolute path — so accepting the pair keeps the `.workpilot/specs/` layout
    written down once, here, instead of once here and once in TypeScript.
    """
    if spec_dir:
        return _validate_dir(spec_dir, "spec_dir")
    if not (project_dir and spec_id):
        raise ValueError("pass spec_dir, or both project_dir and spec_id")
    if "/" in spec_id or "\\" in spec_id or spec_id in ("", ".", ".."):
        raise ValueError(f"spec_id is not a directory name: {spec_id!r}")
    root = _validate_dir(project_dir, "project_dir")
    candidate = (root / ".workpilot" / "specs" / spec_id).resolve()
    if not str(candidate).startswith(str(root) + os.sep):
        raise ValueError("spec_id escapes the project directory")
    # Re-checked against the project root: `spec_id` is the untrusted half of
    # this pair, and the containment test is what keeps it from naming a
    # directory outside the project it claims to belong to.
    return _validate_dir(str(candidate), "spec_dir", base=root)


def _workflow_path(name: str) -> Path:
    """Resolve a workflow by name, refusing anything that escapes the folder."""
    candidate = (_REPO_ROOT / "workflows" / name / "workflow.yaml").resolve()
    root = (_REPO_ROOT / "workflows").resolve()
    if not str(candidate).startswith(str(root) + os.sep):
        raise ValueError(f"unknown workflow: {name}")
    return candidate


def _engine_enabled() -> bool:
    flag = os.environ.get("WORKPILOT_WORKFLOW_ENGINE", "1").strip().lower()
    return flag not in ("0", "false", "off", "no")


def _phase_payload(phase, *, resolved=None, skip_reason: str | None = None) -> dict:
    """One row of the pipeline, run or not.

    Dropped phases are returned too, in their declared position. A selector
    that only lists what survived cannot answer "what would I get for one level
    more", which is the whole reason someone opens it.
    """
    return {
        "id": phase.id,
        "impl": phase.impl,
        "pack": phase.pack,
        "skill": phase.skill,
        "description": phase.description.strip(),
        "minEffort": phase.min_effort,
        "hardGate": phase.hard_gate,
        "always": phase.always,
        "gate": phase.gate,
        "conditional": bool(phase.when_globs),
        "whenGlobs": list(phase.when_globs),
        "runs": resolved is not None,
        "dispatch": resolved.dispatch if resolved else phase.dispatch,
        "degradedFrom": resolved.degraded_from if resolved else None,
        "degradedReason": resolved.reason if resolved else "",
        "skipReason": skip_reason,
    }


def _serialise(workflow, profile, *, missing: list | None = None) -> dict:
    from .engine import DETERMINISTIC_PACKS

    by_id = {r.id: r for r in profile.run}
    skipped = {p.id: reason for p, reason in profile.skipped}

    phases = []
    for phase in workflow.phases:
        payload = _phase_payload(
            phase,
            resolved=by_id.get(phase.id),
            skip_reason=skipped.get(phase.id),
        )
        payload["deterministic"] = phase.pack in DETERMINISTIC_PACKS
        phases.append(payload)

    return {
        "workflow": workflow.name,
        "description": workflow.description.strip(),
        "effort": profile.effort,
        "provider": profile.provider,
        "enabled": _engine_enabled(),
        "phases": phases,
        "runCount": len(profile.run),
        "missing": [
            {"phaseId": m.phase_id, "impl": m.impl, "pack": m.pack, "reason": m.reason}
            for m in (missing or [])
        ],
    }


def _levels(workflow, provider: str | None) -> list[dict]:
    """What each effort level runs, so the UI can price a change of level.

    Resolved with no change set, which is the same forecast the CLI banner
    prints before a build: nothing is written yet, so a conditional phase can
    only be predicted, and the engine's "unknown means run it" rule makes that
    prediction the inclusive one.
    """
    from .engine import resolve_profile
    from .spec import EFFORT_ORDER

    out = []
    for level in EFFORT_ORDER:
        if level == "none":
            continue
        profile = resolve_profile(workflow, level, provider=provider)
        out.append(
            {
                "effort": level,
                "phaseIds": [r.id for r in profile.run],
                "count": len(profile.run),
            }
        )
    return out


def _missing_impls(workflow, profile) -> list:
    """Phases whose pack is not installed. Advisory, never fatal."""
    try:
        from skills_registry.packs import load_packs

        from .engine import validate_impls

        available = {
            p.name: {s.name for s in p.skills()}
            for p in load_packs(_REPO_ROOT / "skills")
        }
        return [
            m
            for m in validate_impls(workflow, available)
            if profile.will_run(m.phase_id)
        ]
    except Exception as exc:  # noqa: BLE001 - advisory only
        logger.debug("could not check phase implementations: %s", exc)
        return []


@router.get("/")
def workflow_profile(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
    effort: str | None = Query(None, description="Override the task's effort level"),
    provider: str | None = Query(None, description="Override the resolved provider"),
    workflow: str = Query(_DEFAULT_WORKFLOW),
    include_levels: bool = Query(True, alias="includeLevels"),
):
    """The resolved execution profile for a spec."""
    try:
        sd = _resolve_spec_dir(spec_dir, project_dir, spec_id)
        path = _workflow_path(workflow)
    except ValueError as exc:
        # The reason, not a generic string: every branch above rejects
        # something the *caller* sent, and the renderer has nothing to show
        # otherwise. `_validate_dir` and `_workflow_path` are written to keep
        # resolved server paths out of these messages; the internal-error path
        # below stays opaque, because that one can carry anything.
        logger.warning("invalid workflow profile request parameters: %s", exc)
        return {"success": False, "error": str(exc)}

    try:
        from phase_config import get_phase_provider, get_phase_thinking

        from .engine import resolve_profile
        from .spec import load_workflow

        loaded = load_workflow(path)
        level = effort or get_phase_thinking(sd, "coding")
        # Side-effect-free provider resolution. See the module docstring.
        resolved_provider = provider or get_phase_provider(sd, phase="coding")

        profile = resolve_profile(loaded, level, provider=resolved_provider)
        payload = _serialise(loaded, profile, missing=_missing_impls(loaded, profile))
        if include_levels:
            payload["levels"] = _levels(loaded, resolved_provider)
        return {"success": True, "profile": payload}
    except Exception as exc:  # noqa: BLE001
        logger.exception("workflow profile resolution failed")
        return {"success": False, "error": "An internal error has occurred."}
