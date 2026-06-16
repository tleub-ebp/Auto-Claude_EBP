"""Local accounts: email + password (argon2id).

Local accounts are the fallback/admin path; employees normally sign in
through Entra ID. Registration is admin-only (no self-service signup).
"""

from __future__ import annotations

import hashlib
import logging
import urllib.error
import urllib.request

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from server.config import get_settings
from server.db.models import GlobalRole, IdentityProvider, User, UserIdentity
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

logger = logging.getLogger(__name__)

_hasher = PasswordHasher()  # argon2id with library defaults

# Absolute floor; the effective minimum is max(this, settings.password_min_length).
MIN_PASSWORD_LENGTH = 12

# A few obviously trivial passwords rejected regardless of length.
_TRIVIAL_PASSWORDS = frozenset(
    {
        "password1234",
        "motdepasse12",
        "azertyuiop12",
        "qwertyuiop12",
        "123456789012",
        "workpilot123",
    }
)

_HIBP_TIMEOUT_SECONDS = 3


class LocalAuthError(Exception):
    pass


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False


def _is_pwned(password: str) -> bool:
    """Have I Been Pwned range query (k-anonymity).

    Only the first 5 chars of the SHA-1 hash leave the process; the full
    password is never sent. Fail-open on any network/error so that an
    outage cannot lock out signups.
    """
    # SHA-1 is mandated by the HIBP range API and is not used as a security
    # primitive here (real password storage uses argon2 via `_hasher`), so the
    # weak-hash warning does not apply — flag it as non-security to both tools.
    digest = (
        hashlib.sha1(password.encode("utf-8"), usedforsecurity=False)
        .hexdigest()
        .upper()
    )
    prefix, suffix = digest[:5], digest[5:]
    try:
        req = urllib.request.Request(
            f"https://api.pwnedpasswords.com/range/{prefix}",
            headers={"User-Agent": "WorkPilot-AI"},
        )
        with urllib.request.urlopen(req, timeout=_HIBP_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.warning("[Password] HIBP check skipped (%s)", exc)
        return False
    for line in body.splitlines():
        hash_suffix, _, _count = line.partition(":")
        if hash_suffix.strip().upper() == suffix:
            return True
    return False


def _validate_password(password: str, email: str | None = None) -> None:
    settings = get_settings()
    min_length = max(MIN_PASSWORD_LENGTH, settings.password_min_length)
    if len(password) < min_length:
        raise LocalAuthError(f"Password must be at least {min_length} characters")
    lowered = password.strip().lower()
    if lowered in _TRIVIAL_PASSWORDS:
        raise LocalAuthError("This password is too common")
    if email:
        email_lc = email.strip().lower()
        local_part = email_lc.split("@", 1)[0]
        if lowered == email_lc or (len(local_part) >= 4 and lowered == local_part):
            raise LocalAuthError("Password must not match your email address")
    if settings.password_hibp_check and _is_pwned(password):
        raise LocalAuthError(
            "This password has appeared in a known data breach; choose another"
        )


async def create_local_user(
    db: AsyncSession,
    email: str,
    password: str,
    display_name: str,
    role: str = GlobalRole.MEMBER.value,
) -> User:
    """Create a user with a local-password identity (admin action)."""
    email = email.strip().lower()
    if not email or "@" not in email:
        raise LocalAuthError("Invalid email address")
    _validate_password(password, email=email)

    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise LocalAuthError("A user with this email already exists")

    user = User(email=email, display_name=display_name.strip() or email, role=role)
    db.add(user)
    await db.flush()
    db.add(
        UserIdentity(
            user_id=user.id,
            provider=IdentityProvider.LOCAL.value,
            subject=email,
            password_hash=hash_password(password),
        )
    )
    await db.commit()
    logger.info("Created local user %s (role=%s)", email, role)
    return user


async def authenticate_local(db: AsyncSession, email: str, password: str) -> User:
    """Verify email+password; raises LocalAuthError on any failure.

    The error message is identical for "no such user" and "wrong password"
    to avoid account enumeration.
    """
    email = email.strip().lower()
    identity = await db.scalar(
        select(UserIdentity)
        .options(selectinload(UserIdentity.user))
        .where(
            UserIdentity.provider == IdentityProvider.LOCAL.value,
            UserIdentity.subject == email,
        )
    )
    generic_error = "Invalid email or password"
    if identity is None or not identity.password_hash:
        # Burn comparable time so timing doesn't leak which emails exist.
        _hasher.hash(password)
        raise LocalAuthError(generic_error)
    if not verify_password(identity.password_hash, password):
        raise LocalAuthError(generic_error)
    user = identity.user
    if user is None or not user.is_active:
        raise LocalAuthError("Account is disabled")
    if _hasher.check_needs_rehash(identity.password_hash):
        identity.password_hash = hash_password(password)
        await db.commit()
    return user


async def change_password(
    db: AsyncSession, user: User, current_password: str, new_password: str
) -> None:
    _validate_password(new_password, email=user.email)
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.user_id == user.id,
            UserIdentity.provider == IdentityProvider.LOCAL.value,
        )
    )
    if identity is None or not identity.password_hash:
        raise LocalAuthError("This account has no local password")
    if not verify_password(identity.password_hash, current_password):
        raise LocalAuthError("Current password is incorrect")
    identity.password_hash = hash_password(new_password)
    await db.commit()
