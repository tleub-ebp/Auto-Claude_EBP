"""User directory + per-user integration secrets."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from server.auth.deps import CurrentUser, get_current_user
from server.db.engine import get_db
from server.db.models import User
from server.schemas import SecretKindsResponse, SetSecretRequest, UserPublic
from server.services.secrets import (
    SECRET_KINDS,
    SecretsVaultError,
    delete_user_secret,
    list_user_secret_kinds,
    set_user_secret,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserPublic])
async def list_users(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[UserPublic]:
    """Directory for member pickers — any authenticated user may list."""
    users = await db.scalars(
        select(User).where(User.is_active.is_(True)).order_by(User.display_name)
    )
    return [UserPublic.model_validate(u) for u in users]


@router.get("/me/secrets", response_model=SecretKindsResponse)
async def my_secret_kinds(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SecretKindsResponse:
    """Which integration secrets the caller has configured (never the values)."""
    return SecretKindsResponse(kinds=await list_user_secret_kinds(db, user.id))


@router.put("/me/secrets")
async def set_my_secret(
    body: SetSecretRequest,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.kind not in SECRET_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown secret kind '{body.kind}'. Allowed: {sorted(SECRET_KINDS)}",
        )
    try:
        await set_user_secret(db, user.id, body.kind, body.value)
    except SecretsVaultError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"saved": True}


@router.delete("/me/secrets/{kind}")
async def delete_my_secret(
    kind: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"deleted": await delete_user_secret(db, user.id, kind)}
