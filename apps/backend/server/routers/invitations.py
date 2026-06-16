"""Invitation endpoints: admin issues/lists/revokes; invitee looks up + accepts.

Mounted under ``/auth/invitations``. The ``lookup`` and ``accept`` endpoints
are public (listed in ``PUBLIC_PATHS``) and rate-limited; everything else
requires an admin. Acceptance auto-logs the new user in by returning a fresh
token pair (same shape as ``/auth/login``).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import CurrentUser, require_admin
from server.auth.invitations import (
    InvitationError,
    accept_invitation,
    build_invite_link,
    create_invitation,
    list_pending,
    lookup_invitation,
)
from server.auth.invitations import revoke as revoke_invitation
from server.auth.jwt_tokens import issue_token_pair
from server.auth.local import LocalAuthError
from server.config import get_settings
from server.db.engine import get_db
from server.db.models import AuditLog
from server.ratelimit import limiter
from server.schemas import (
    AcceptInvitationRequest,
    CreateInvitationRequest,
    CreateInvitationResponse,
    InvitationLookupRequest,
    InvitationLookupResponse,
    InvitationPublic,
    TokenResponse,
    UserPublic,
)
from server.services.email import EmailError, send_invitation_email
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/invitations", tags=["invitations"])


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    return ua, ip


@router.post("", response_model=CreateInvitationResponse, status_code=201)
async def create_invitation_endpoint(
    body: CreateInvitationRequest,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CreateInvitationResponse:
    try:
        invitation, token = await create_invitation(
            db,
            email=str(body.email),
            role=body.role,
            invited_by=admin.id,
            project_id=body.project_id,
            project_role=body.project_role,
        )
    except InvitationError as e:
        raise HTTPException(status_code=400, detail=str(e))

    invite_link = build_invite_link(token)
    email_sent = False
    settings = get_settings()
    if settings.email_enabled:
        try:
            await send_invitation_email(
                invitation.email, invite_link, admin.display_name, invitation.role
            )
            email_sent = True
        except EmailError as e:
            # Non-fatal: the admin can still deliver invite_link manually.
            logger.warning("Invitation email not sent to %s: %s", invitation.email, e)

    return CreateInvitationResponse(
        **InvitationPublic.model_validate(invitation).model_dump(),
        invite_link=invite_link,
        email_sent=email_sent,
    )


@router.get("", response_model=list[InvitationPublic])
async def list_invitations_endpoint(
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[InvitationPublic]:
    return [InvitationPublic.model_validate(i) for i in await list_pending(db)]


@router.delete("/{invitation_id}")
async def revoke_invitation_endpoint(
    invitation_id: str,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    revoked = await revoke_invitation(db, invitation_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="No revocable invitation found")
    db.add(
        AuditLog(
            user_id=admin.id,
            action="auth.invitation.revoked",
            payload={"invitation_id": invitation_id},
        )
    )
    await db.commit()
    return {"revoked": True}


@router.post("/lookup", response_model=InvitationLookupResponse)
@limiter.limit("10/minute")
async def lookup_invitation_endpoint(
    request: Request,
    body: InvitationLookupRequest,
    db: AsyncSession = Depends(get_db),
) -> InvitationLookupResponse:
    try:
        invitation = await lookup_invitation(db, body.token)
    except InvitationError as e:
        # 404 regardless of the precise reason (don't leak which tokens exist).
        raise HTTPException(status_code=404, detail=str(e))
    return InvitationLookupResponse(email=invitation.email, role=invitation.role)


@router.post("/accept", response_model=TokenResponse)
@limiter.limit("5/minute")
async def accept_invitation_endpoint(
    request: Request,
    body: AcceptInvitationRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    try:
        user = await accept_invitation(db, body.token, body.display_name, body.password)
    except InvitationError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except LocalAuthError as e:
        # Password-policy / email-collision failures.
        raise HTTPException(status_code=400, detail=str(e))

    ua, ip = _client_meta(request)
    pair = await issue_token_pair(db, user, user_agent=ua, ip=ip)
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=UserPublic.model_validate(user),
    )
