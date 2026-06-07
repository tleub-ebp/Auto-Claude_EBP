"""Optional Fernet encryption-at-rest for the audit trail JSONL files.

Mirrors the pattern in ``validated_keys_db``: opt-in via env var
``AUDIT_TRAIL_FERNET_KEY``. When set, each event line written to disk is
wrapped with Fernet and prefixed with ``"fernet:"``. Lines without that
prefix are treated as legacy cleartext (back-compat). Reading an
encrypted line without a key raises — the trail refuses to silently
return blanks for tamper-evident data.

Important: encryption happens **after** the hash chain is computed. The
on-disk encryption layer is opaque to the integrity check — verify()
still reads cleartext events (decrypted in memory) and rehashes them.
This means the hash chain is independent of the encryption key, so a key
rotation does NOT invalidate the chain.
"""

from __future__ import annotations

import base64
import logging
import os
import secrets

logger = logging.getLogger(__name__)

ENCRYPTION_PREFIX = "fernet:"
FERNET_ENV_VAR = "AUDIT_TRAIL_FERNET_KEY"

_cipher_cache = None  # populated on first use


def _get_cipher():
    """Return a cached Fernet cipher, or None if encryption is opt-out.

    Returns None silently when:
      * ``AUDIT_TRAIL_FERNET_KEY`` is unset (default — encryption disabled).
      * ``cryptography`` isn't installed (a logged warning fires once).
      * The supplied key fails the Fernet format check.

    Returning None is the "stay in cleartext" path — callers must NOT
    fall back to plaintext when they have an encrypted line, only when
    they're writing fresh.
    """
    global _cipher_cache
    if _cipher_cache is not None:
        return _cipher_cache

    raw_key = os.environ.get(FERNET_ENV_VAR, "").strip()
    if not raw_key:
        return None

    try:
        from cryptography.fernet import Fernet  # type: ignore[import-not-found]
    except ImportError:
        logger.warning(
            "%s is set but `cryptography` is not installed — "
            "audit trail will be written in cleartext.",
            FERNET_ENV_VAR,
        )
        return None

    try:
        _cipher_cache = Fernet(raw_key.encode("ascii"))
    except (ValueError, TypeError) as exc:
        logger.warning("%s is invalid: %s", FERNET_ENV_VAR, exc)
        return None
    return _cipher_cache


def reset_cipher_cache() -> None:
    """Test-only: drop the cached cipher so env var changes take effect."""
    global _cipher_cache
    _cipher_cache = None


def encryption_enabled() -> bool:
    """True iff a usable Fernet cipher is currently available."""
    return _get_cipher() is not None


def maybe_encrypt_line(line: str) -> str:
    """Wrap a JSONL line with Fernet if encryption is enabled.

    Idempotent: lines already prefixed with ``fernet:`` are returned as-is.
    """
    if line.startswith(ENCRYPTION_PREFIX):
        return line
    cipher = _get_cipher()
    if cipher is None:
        return line
    token = cipher.encrypt(line.encode("utf-8")).decode("ascii")
    return f"{ENCRYPTION_PREFIX}{token}"


def maybe_decrypt_line(line: str) -> str:
    """Reverse of :func:`maybe_encrypt_line`.

    Lines without the prefix pass through unchanged (legacy cleartext).
    Lines WITH the prefix require a key — raise if none is configured,
    so callers don't silently return wrong data.
    """
    if not line.startswith(ENCRYPTION_PREFIX):
        return line
    cipher = _get_cipher()
    if cipher is None:
        raise ValueError(
            f"Encrypted audit trail line found but {FERNET_ENV_VAR} is not "
            "set. Refusing to read tamper-evident data without the key."
        )
    token = line[len(ENCRYPTION_PREFIX) :].encode("ascii")
    return cipher.decrypt(token).decode("utf-8")


def generate_fernet_key() -> str:
    """Helper for ops: emit a fresh key suitable for ``AUDIT_TRAIL_FERNET_KEY``."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
