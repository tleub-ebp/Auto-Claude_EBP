"""
Internal helpers for sanitizing user-controlled artifact names.

Both `BrowserController` (screenshots) and `VisualRegressionEngine`
(baselines) accept a `name: str` from caller code that may originate
from an LLM tool call. Without sanitization, `name="../../etc/evil"`
escapes the artifact directory and writes/unlinks arbitrary host files.

This module centralizes the sanitization rule so the two surfaces stay
in sync — previously each module had its own copy and they could drift.
"""

from __future__ import annotations

import re
from pathlib import Path

# Restrict artifact names to a conservative alnum + `._-` charset.
# Stripping leading `.` and `_` avoids hidden-file shenanigans.
_UNSAFE_CHAR_RE = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_name(name: str, *, fallback: str, max_len: int = 128) -> str:
    """Reduce a user-supplied name to a safe single filename token.

    Args:
        name: Raw name from caller (may be LLM-controlled).
        fallback: Returned when `name` is empty or fully sanitized away.
        max_len: Hard cap on the returned name length.

    Returns:
        A string containing only `[A-Za-z0-9._-]`, never starting with
        `.` or `_`, and never longer than `max_len`.
    """
    if not name:
        return fallback
    cleaned = _UNSAFE_CHAR_RE.sub("_", name).strip("._")
    return (cleaned or fallback)[:max_len]


def safe_artifact_path(root: Path, name: str, suffix: str, *, fallback: str) -> Path:
    """Build `root/<sanitized name><suffix>` and assert it stays under root.

    The sanitization should be enough by itself (no path separators
    survive), but we re-check via `resolve()` as defense in depth — any
    surprising symlink or weird Windows path handling that ends up
    outside `root` raises `ValueError`.
    """
    safe = sanitize_name(name, fallback=fallback)
    candidate = (root / f"{safe}{suffix}").resolve()
    root_resolved = root.resolve()
    if root_resolved != candidate and root_resolved not in candidate.parents:
        raise ValueError(f"Artifact path escapes {root}: {name!r}")
    return candidate
