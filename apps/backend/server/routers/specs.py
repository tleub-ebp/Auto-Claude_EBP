"""Spec board endpoints: list (with FS reindex), claim/release, run history.

The exclusive-claim model: starting work on a spec sets ``claimed_by``;
while claimed, only the claim holder (or an owner/admin forcing release)
can act on the spec. Claims auto-release when the spec reaches
``human_review`` or ``done`` (see spec_indexer.RELEASING_STATUSES).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from server.auth.deps import (
    CurrentUser,
    get_project_role,
    require_project_role,
)
from server.db.engine import get_db
from server.db.models import (
    AgentRun,
    AuditLog,
    Project,
    ProjectRole,
    SpecIndex,
    User,
)
from server.schemas import AgentRunPublic, ClaimRequest, SpecPublic, StartRunRequest
from server.services.events import emit_board_event
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/specs", tags=["specs"])


async def _get_project_or_404(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _spec_to_public(db: AsyncSession, row: SpecIndex) -> SpecPublic:
    item = SpecPublic.model_validate(row)
    if row.claimed_by:
        item.claimed_by_name = await db.scalar(
            select(User.display_name).where(User.id == row.claimed_by)
        )
    return item


async def _get_spec_or_404(
    db: AsyncSession, project_id: str, spec_id: str
) -> SpecIndex:
    spec = await db.get(SpecIndex, spec_id)
    if spec is None or spec.project_id != project_id:
        raise HTTPException(status_code=404, detail="Spec not found")
    return spec


def ensure_can_act_on_spec(
    spec: SpecIndex, user: CurrentUser, role: str | None
) -> None:
    """409 if the spec is exclusively claimed by someone else.

    Owners/admins are NOT exempt: they must explicitly force-release first,
    so nobody silently stomps on a colleague's in-flight run.
    """
    if spec.claimed_by and spec.claimed_by != user.id:
        raise HTTPException(
            status_code=409,
            detail=f"Spec is claimed by another user (claimed_by={spec.claimed_by})",
        )


@router.get("", response_model=list[SpecPublic])
async def list_specs(
    project_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.VIEWER.value)),
    db: AsyncSession = Depends(get_db),
) -> list[SpecPublic]:
    """Board view: reconciles the index with the FS, then returns it."""
    from server.services.spec_indexer import reindex_project

    project = await _get_project_or_404(db, project_id)
    rows = await reindex_project(db, project)
    rows.sort(key=lambda r: r.spec_name)
    return [await _spec_to_public(db, row) for row in rows]


@router.post("/{spec_id}/claim", response_model=SpecPublic)
async def claim_spec(
    project_id: str,
    spec_id: str,
    body: ClaimRequest,
    user: CurrentUser = Depends(require_project_role(ProjectRole.MEMBER.value)),
    db: AsyncSession = Depends(get_db),
) -> SpecPublic:
    spec = await _get_spec_or_404(db, project_id, spec_id)

    if spec.claimed_by and spec.claimed_by != user.id:
        role = await get_project_role(db, user, project_id)
        if not (body.force and role == ProjectRole.OWNER.value):
            holder = await db.scalar(
                select(User.display_name).where(User.id == spec.claimed_by)
            )
            raise HTTPException(
                status_code=409,
                detail=f"Spec already claimed by {holder or 'another user'}",
            )
        db.add(
            AuditLog(
                user_id=user.id,
                project_id=project_id,
                action="spec.claim.forced",
                payload={"spec": spec.spec_name, "previous_holder": spec.claimed_by},
            )
        )

    spec.claimed_by = user.id
    spec.claimed_at = datetime.now(UTC)
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="spec.claimed",
            payload={"spec": spec.spec_name},
        )
    )
    await db.commit()
    emit_board_event(
        project_id,
        "spec_claimed",
        {
            "spec_id": spec.id,
            "spec_name": spec.spec_name,
            "user_id": user.id,
            "user_name": user.display_name,
        },
    )
    return await _spec_to_public(db, spec)


@router.post("/{spec_id}/release", response_model=SpecPublic)
async def release_spec(
    project_id: str,
    spec_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.MEMBER.value)),
    db: AsyncSession = Depends(get_db),
) -> SpecPublic:
    spec = await _get_spec_or_404(db, project_id, spec_id)
    if spec.claimed_by and spec.claimed_by != user.id:
        role = await get_project_role(db, user, project_id)
        if role != ProjectRole.OWNER.value:
            raise HTTPException(
                status_code=403, detail="Only the claim holder or an owner can release"
            )
    spec.claimed_by = None
    spec.claimed_at = None
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="spec.released",
            payload={"spec": spec.spec_name},
        )
    )
    await db.commit()
    emit_board_event(
        project_id,
        "spec_released",
        {
            "spec_id": spec.id,
            "spec_name": spec.spec_name,
            "user_id": user.id,
            "user_name": user.display_name,
        },
    )
    return await _spec_to_public(db, spec)


@router.post("/{spec_id}/runs", response_model=AgentRunPublic, status_code=202)
async def start_run(
    project_id: str,
    spec_id: str,
    body: StartRunRequest,
    user: CurrentUser = Depends(require_project_role(ProjectRole.MEMBER.value)),
    db: AsyncSession = Depends(get_db),
) -> AgentRunPublic:
    """Launch an agent run on the server. Auto-claims the spec for the caller."""
    from server.services.run_manager import RunManagerError, get_run_manager

    project = await _get_project_or_404(db, project_id)
    spec = await _get_spec_or_404(db, project_id, spec_id)
    ensure_can_act_on_spec(spec, user, None)

    if spec.claimed_by is None:
        spec.claimed_by = user.id
        spec.claimed_at = datetime.now(UTC)

    try:
        run = await get_run_manager().start_run(
            spec=spec,
            project_id=project_id,
            server_path=project.server_path,
            phase=body.phase,
            user_id=user.id,
            model=body.model,
        )
    except RunManagerError as e:
        raise HTTPException(status_code=409, detail=str(e))

    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="spec.run.started",
            payload={"spec": spec.spec_name, "phase": body.phase, "run_id": run.id},
        )
    )
    await db.commit()
    return AgentRunPublic.model_validate(run)


@router.post("/{spec_id}/runs/{run_id}/cancel")
async def cancel_run(
    project_id: str,
    spec_id: str,
    run_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.MEMBER.value)),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from server.services.run_manager import get_run_manager

    spec = await _get_spec_or_404(db, project_id, spec_id)
    ensure_can_act_on_spec(spec, user, None)
    cancelled = await get_run_manager().cancel_run(run_id)
    if cancelled:
        db.add(
            AuditLog(
                user_id=user.id,
                project_id=project_id,
                action="spec.run.cancelled",
                payload={"spec": spec.spec_name, "run_id": run_id},
            )
        )
        await db.commit()
    return {"cancelled": cancelled}


@router.get("/{spec_id}/runs", response_model=list[AgentRunPublic])
async def list_runs(
    project_id: str,
    spec_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.VIEWER.value)),
    db: AsyncSession = Depends(get_db),
) -> list[AgentRunPublic]:
    await _get_spec_or_404(db, project_id, spec_id)
    runs = await db.scalars(
        select(AgentRun)
        .where(AgentRun.spec_id == spec_id)
        .order_by(AgentRun.started_at.desc())
    )
    return [AgentRunPublic.model_validate(r) for r in runs]
