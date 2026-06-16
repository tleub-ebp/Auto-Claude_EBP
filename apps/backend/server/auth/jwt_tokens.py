"""WorkPilot-issued JWTs: short-lived access tokens + rotating refresh tokens.

- Access token: HS256 JWT, ~15 min, carries ``sub`` (user id), ``role``,
  ``email`` and ``name`` so most requests never hit the users table.
- Refresh token: opaque random string. Only its SHA-256 hash is persisted
  (``auth_sessions.refresh_token_hash``). Each successful refresh revokes
  the old session row and issues a new pair (rotation).
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt as pyjwt
from server.config import get_settings
from server.db.models import AuthSession, User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


class TokenError(Exception):
    """Invalid, expired or revoked token."""


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int  # access token lifetime, seconds


def _utcnow() -> datetime:
    return datetime.now(UTC)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(user: User) -> tuple[str, int]:
    settings = get_settings()
    ttl = timedelta(minutes=settings.access_token_ttl_minutes)
    now = _utcnow()
    payload = {
        "iss": settings.jwt_issuer,
        "sub": user.id,
        "email": user.email,
        "name": user.display_name,
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    return (
        pyjwt.encode(payload, settings.jwt_secret, algorithm="HS256"),
        int(ttl.total_seconds()),
    )


def decode_access_token(token: str) -> dict:
    """Validate signature/expiry and return the claims dict."""
    settings = get_settings()
    try:
        return pyjwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "sub", "iss"]},
        )
    except pyjwt.PyJWTError as e:
        raise TokenError(f"Invalid access token: {type(e).__name__}") from e


async def issue_token_pair(
    db: AsyncSession,
    user: User,
    user_agent: str | None = None,
    ip: str | None = None,
) -> TokenPair:
    """Create a new refresh session and return access+refresh tokens."""
    settings = get_settings()
    refresh_token = secrets.token_urlsafe(48)
    db.add(
        AuthSession(
            user_id=user.id,
            refresh_token_hash=hash_refresh_token(refresh_token),
            user_agent=(user_agent or "")[:400] or None,
            ip=(ip or "")[:64] or None,
            expires_at=_utcnow() + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    await db.commit()
    access_token, expires_in = create_access_token(user)
    return TokenPair(
        access_token=access_token, refresh_token=refresh_token, expires_in=expires_in
    )


async def rotate_refresh_token(
    db: AsyncSession,
    refresh_token: str,
    user_agent: str | None = None,
    ip: str | None = None,
) -> tuple[TokenPair, User]:
    """Validate a refresh token, revoke its session, and issue a new pair."""
    session = await db.scalar(
        select(AuthSession).where(
            AuthSession.refresh_token_hash == hash_refresh_token(refresh_token)
        )
    )
    if session is None:
        raise TokenError("Unknown refresh token")
    if session.revoked_at is not None:
        raise TokenError("Refresh token was revoked")
    expires_at = session.expires_at
    if expires_at.tzinfo is None:  # SQLite returns naive datetimes
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at < _utcnow():
        raise TokenError("Refresh token expired")

    user = await db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise TokenError("User is disabled or gone")

    session.revoked_at = _utcnow()
    pair = await issue_token_pair(db, user, user_agent=user_agent, ip=ip)
    return pair, user


async def revoke_refresh_token(db: AsyncSession, refresh_token: str) -> bool:
    """Logout: revoke the session matching this refresh token."""
    session = await db.scalar(
        select(AuthSession).where(
            AuthSession.refresh_token_hash == hash_refresh_token(refresh_token)
        )
    )
    if session is None or session.revoked_at is not None:
        return False
    session.revoked_at = _utcnow()
    await db.commit()
    return True
