"""The single frontmatter parser for SKILL.md and agent markdown files.

Before this module the repo carried four hand-rolled parsers with divergent
semantics (slash_commands/api.py, skills/skill_manager.py,
skills/versioned_skills.py, skills/dynamic_skill_manager.py). Three of them
located the closing delimiter with ``content.find("---", 3)``, which matches a
``---`` anywhere -- including inside a description -- and truncates the block
at the wrong place.

Parsing strategy, in order:

1. PyYAML, which handles quoting, nested maps (``metadata.workpilot.*``) and
   list syntax correctly.
2. A line-based ``key: value`` fallback when the block is not valid YAML.
   Several BMAD skills were hand-edited over time and a few still carry
   doubled-quote artefacts; degrading to the old behaviour keeps them readable
   instead of dropping their metadata entirely.

The fallback is what the rest of the codebase used to do everywhere, so no
caller gets *less* than it did before.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

try:  # pragma: no cover - exercised by the absence/presence of the dep
    import yaml

    _YAML_AVAILABLE = True
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore[assignment]
    _YAML_AVAILABLE = False

_DELIM = "---"

# Fields that callers expect as a list even when written as a bare scalar or
# as the ``[a, b]`` pseudo-syntax the legacy parsers accepted.
_LIST_FIELDS = ("triggers", "paths", "allowed-tools", "disallowed-tools", "arguments")


def split_frontmatter(text: str) -> tuple[str | None, str]:
    """Split ``text`` into (raw frontmatter, body).

    Returns ``(None, text)`` when there is no frontmatter block. The closing
    delimiter must sit alone on its own line, so a ``---`` inside a value never
    ends the block early.
    """
    if not text.startswith(_DELIM):
        return None, text

    # Skip the opening delimiter line, then look for a line that is exactly
    # "---" (trailing whitespace and CR tolerated).
    lines = text.split("\n")
    if lines[0].strip() != _DELIM:
        return None, text

    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == _DELIM:
            raw = "\n".join(lines[1:i])
            body = "\n".join(lines[i + 1 :]).lstrip("\n")
            return raw, body

    # Unterminated block: treat the whole file as body rather than guessing.
    return None, text


def _coerce_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if value is None:
        return []
    text = str(value).strip()
    if not text:
        return []
    # "[a, b]" and "a, b" both appear in the wild.
    text = text.removeprefix("[").removesuffix("]")
    return [part.strip().strip("\"'") for part in text.split(",") if part.strip()]


def _parse_lines(raw: str) -> dict[str, Any]:
    """Legacy ``key: value`` parser, kept as the fallback path."""
    meta: dict[str, Any] = {}
    for line in raw.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        # Only top-level keys: an indented line belongs to a nested map the
        # line parser cannot represent, and guessing would corrupt it.
        if line[:1].isspace():
            continue
        key, _, value = line.partition(":")
        key = key.strip().strip("\"'")
        value = value.strip().strip('"').strip("'")
        meta[key] = _coerce_list(value) if key in _LIST_FIELDS else value
    return meta


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Return ``(metadata, body)`` for a SKILL.md-style document.

    ``metadata`` is ``{}`` when there is no frontmatter. List-valued fields such
    as ``triggers`` and ``paths`` are always returned as ``list[str]``.
    """
    raw, body = split_frontmatter(text)
    if raw is None:
        return {}, body

    meta: dict[str, Any] | None = None
    if _YAML_AVAILABLE:
        try:
            loaded = yaml.safe_load(raw)
            if isinstance(loaded, dict):
                meta = loaded
            elif loaded is not None:
                logger.debug(
                    "Frontmatter is not a mapping (%r); using line parser", type(loaded)
                )
        except Exception as exc:  # yaml.YAMLError and friends
            logger.debug("YAML frontmatter parse failed (%s); using line parser", exc)

    if meta is None:
        meta = _parse_lines(raw)
    else:
        for field in _LIST_FIELDS:
            if field in meta:
                meta[field] = _coerce_list(meta[field])

    return meta, body


def workpilot_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Return the ``metadata.workpilot`` sub-map, or ``{}``.

    Claude Code ignores ``metadata`` and the Agent Skills spec leaves it free
    for tooling, so that is where every WorkPilot-specific field lives (pack,
    version, targets, requires, min_effort, provenance).
    """
    container = meta.get("metadata")
    if not isinstance(container, dict):
        return {}
    inner = container.get("workpilot")
    return inner if isinstance(inner, dict) else {}
