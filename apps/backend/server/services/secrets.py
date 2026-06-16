"""Per-user integration secrets, encrypted at rest with Fernet.

LLM keys are server-level (plain environment of the server process) and never
go through this module. What lives here: Azure DevOps PATs, Jira tokens, and
any future per-user integration credential — so actions on external services
are attributed to the actual user.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken
from server.config import get_settings
from server.db.models import UserSecret
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: Allowed secret kinds — keep in sync with the frontend settings UI.
SECRET_KINDS = {
    "azure_pat",
    "jira_token",
    "linear_api_key",
    "github_token",
    "gitlab_token",
}


class SecretsVaultError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = get_settings().secrets_master_key
    if not key:
        raise SecretsVaultError(
            "WORKPILOT_SECRETS_MASTER_KEY is not set — cannot store or read user secrets. "
            'Generate one with: python -c "from cryptography.fernet import Fernet; '
            'print(Fernet.generate_key().decode())"'
        )
    return Fernet(key.encode())


def encrypt_value(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_value(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise SecretsVaultError(
            "Could not decrypt a stored secret — WORKPILOT_SECRETS_MASTER_KEY "
            "probably changed since the secret was saved."
        ) from e


async def set_user_secret(
    db: AsyncSession, user_id: str, kind: str, value: str
) -> None:
    if kind not in SECRET_KINDS:
        raise SecretsVaultError(f"Unknown secret kind: {kind}")
    encrypted = encrypt_value(value)
    existing = await db.scalar(
        select(UserSecret).where(UserSecret.user_id == user_id, UserSecret.kind == kind)
    )
    if existing:
        existing.encrypted_value = encrypted
    else:
        db.add(UserSecret(user_id=user_id, kind=kind, encrypted_value=encrypted))
    await db.commit()


async def get_user_secret(db: AsyncSession, user_id: str, kind: str) -> str | None:
    row = await db.scalar(
        select(UserSecret).where(UserSecret.user_id == user_id, UserSecret.kind == kind)
    )
    if row is None:
        return None
    return decrypt_value(row.encrypted_value)


async def list_user_secret_kinds(db: AsyncSession, user_id: str) -> list[str]:
    """Kinds configured for a user — values are never listed back."""
    rows = await db.scalars(
        select(UserSecret.kind).where(UserSecret.user_id == user_id)
    )
    return sorted(rows)


async def delete_user_secret(db: AsyncSession, user_id: str, kind: str) -> bool:
    row = await db.scalar(
        select(UserSecret).where(UserSecret.user_id == user_id, UserSecret.kind == kind)
    )
    if row is None:
        return False
    await db.delete(row)
    await db.commit()
    return True
