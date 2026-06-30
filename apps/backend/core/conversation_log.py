"""
Provider-neutral conversation log
==================================

Persists agent conversations in a provider-agnostic JSONL file so that:

1. If a task is paused (rate limit, auth failure, user stop), the conversation
   can be replayed when it resumes — even after a process restart.
2. The user can switch from one provider (e.g. Anthropic) to another (e.g.
   GitHub Copilot, OpenAI) at pause time, and the new provider picks up
   exactly where the previous one left off.

Why JSONL (one JSON object per line) instead of a single JSON file:

- Append-only writes — no read-modify-write cycle, no risk of corruption
  from interrupted writes mid-stream.
- Process-crash-safe — partially written lines can be discarded by readers
  without losing earlier complete messages.
- Each line is independently parseable, so tools like `tail -f` work for
  live monitoring.

Schema (one JSON object per line):

    {
        "v": 1,                       # schema version, for future migrations
        "ts": "2026-05-21T14:30:00Z", # ISO-8601 timestamp
        "phase": "coding",            # which agent phase produced this message
        "subtask_id": "subtask-2-1",  # optional, current subtask context
        "provider": "claude",         # provider that produced (or received) it
        "model": "claude-opus-4-5",   # exact model identifier
        "role": "assistant",          # message role (assistant/user/system)
        "content": [                  # list of normalized ContentBlock dicts
            {"type": "thinking", "text": "..."},
            {"type": "text", "text": "..."},
            {"type": "tool_use", "tool_id": "...", "tool_name": "...",
             "tool_input": {...}},
            {"type": "tool_result", "tool_use_id": "...",
             "result_content": ..., "is_error": false}
        ]
    }

The `raw` field of AgentMessage is intentionally NOT persisted — that's the
provider-specific blob we explicitly want to avoid coupling to. Persistence
goes through the neutral ContentBlock representation only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import OrderedDict
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole

logger = logging.getLogger(__name__)

# Legacy single-file name (pre multi-model). Kept for migration + backward
# compatibility with callers that don't pass a (provider, model).
CONVERSATION_LOG_FILENAME = "conversation.jsonl"

# Per-model logs are named "conversation.<provider>-<model>.jsonl" so switching
# a phase's LLM keeps each model's own history: switch away and back and the
# model resumes its own context, and a never-used model starts fresh.
_LOG_PREFIX = "conversation"
_LOG_SUFFIX = ".jsonl"

# Current schema version. Bump when changing the on-disk format.
SCHEMA_VERSION = 1


def _log_slug(provider: str | None, model: str | None) -> str:
    """Filesystem-safe slug identifying a (provider, model) pair.

    e.g. ("ollama", "qwen2.5-coder:latest") -> "ollama-qwen2.5-coder-latest".
    Keeps ``[A-Za-z0-9._-]``; everything else (':' '/' spaces) becomes '-'.
    Long ids (e.g. ``hf.co/org/Model-GGUF:latest``) are truncated with a short
    hash so the filename stays well under filesystem limits yet stays unique.
    """
    raw = f"{(provider or 'local').strip()}-{(model or 'default').strip()}"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-") or "default"
    if len(slug) > 80:
        digest = hashlib.sha1(  # noqa: S324 - filename uniqueness, not security
            raw.encode("utf-8"), usedforsecurity=False
        ).hexdigest()[:8]
        slug = slug[:60].rstrip("-") + "-" + digest
    return slug


def conversation_log_path(
    spec_dir: Path, provider: str | None, model: str | None
) -> Path:
    """Path of the conversation log for a given (provider, model)."""
    return spec_dir / f"{_LOG_PREFIX}.{_log_slug(provider, model)}{_LOG_SUFFIX}"


def migrate_legacy_log(spec_dir: Path) -> None:
    """One-time split of a pre-multi-model ``conversation.jsonl`` into per-model
    files.

    Each persisted line already carries its own ``provider``/``model``, so we
    group the legacy lines by (provider, model) and append them to the matching
    per-model file, then archive the legacy file (``.migrated``) so it isn't
    re-split. Idempotent and best-effort — never raises.
    """
    legacy = spec_dir / CONVERSATION_LOG_FILENAME
    if not legacy.exists():
        return
    try:
        groups: OrderedDict[tuple[str, str], list[str]] = OrderedDict()
        with legacy.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = (
                    entry.get("provider") or "local",
                    entry.get("model") or "default",
                )
                groups.setdefault(key, []).append(line)
        for (prov, mdl), lines in groups.items():
            target = conversation_log_path(spec_dir, prov, mdl)
            with target.open("ab") as f:
                for ln in lines:
                    f.write((ln + "\n").encode("utf-8"))
        legacy.rename(spec_dir / f"{CONVERSATION_LOG_FILENAME}.migrated")
        logger.info(
            "[conversation_log] Split legacy log in %s into %d per-model file(s)",
            spec_dir,
            len(groups),
        )
    except OSError as e:
        logger.warning("Could not migrate legacy conversation log %s: %s", legacy, e)


def _serialize_content_block(block: ContentBlock) -> dict[str, Any]:
    """Convert a ContentBlock into a plain JSON-serialisable dict.

    Drops any field that's None so the file stays small and humanly diffable.
    Enum values are turned into their string form.
    """
    raw = asdict(block) if is_dataclass(block) else dict(block.__dict__)
    out: dict[str, Any] = {}
    for key, value in raw.items():
        if value is None:
            continue
        if isinstance(value, Enum):
            out[key] = value.value
        else:
            out[key] = value
    return out


def append_message(
    spec_dir: Path,
    message: AgentMessage,
    *,
    phase: str,
    provider: str,
    model: str,
    subtask_id: str | None = None,
) -> None:
    """Append one normalized message to the conversation log.

    Safe to call from a tight stream loop — opens, writes one line, closes.
    A failure here must NEVER take down the agent session, so all I/O errors
    are logged at WARNING and swallowed.

    Args:
        spec_dir: Spec directory in which the conversation lives.
        message: The normalized AgentMessage to persist.
        phase: Which agent phase produced this message (e.g. "coding").
        provider: Provider identifier (e.g. "claude", "copilot").
        model: Exact model identifier (e.g. "claude-opus-4-5").
        subtask_id: Optional subtask context.
    """
    try:
        log_file = conversation_log_path(spec_dir, provider, model)
        entry = {
            "v": SCHEMA_VERSION,
            "ts": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "phase": phase,
            "provider": provider,
            "model": model,
            "role": (
                message.role.value
                if isinstance(message.role, Enum)
                else str(message.role)
            ),
            "content": [_serialize_content_block(b) for b in message.content],
        }
        if subtask_id:
            entry["subtask_id"] = subtask_id

        # Open in append-binary mode and write a newline-terminated UTF-8 line.
        # Binary mode avoids OS-specific newline translation that could split
        # records across lines.
        line = (json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8")
        with log_file.open("ab") as f:
            f.write(line)
    except Exception as e:
        # Persistence must never crash the agent — log and move on.
        logger.warning(f"Could not append conversation log entry to {spec_dir}: {e}")


def read_log(
    spec_dir: Path,
    provider: str | None = None,
    model: str | None = None,
) -> list[dict[str, Any]]:
    """Read all messages from a conversation log.

    When ``provider`` and ``model`` are given, reads that model's own log
    (migrating any pre-existing single-file log first) so each model resumes its
    own context. When omitted, falls back to the legacy single file (kept for
    backward-compatible callers).

    Skips partial/corrupted lines silently — process crashes mid-write are
    expected and must not block resume. Returns an empty list if the file
    doesn't exist.
    """
    if provider and model:
        migrate_legacy_log(spec_dir)
        log_file = conversation_log_path(spec_dir, provider, model)
    else:
        log_file = spec_dir / CONVERSATION_LOG_FILENAME
    if not log_file.exists():
        return []

    entries: list[dict[str, Any]] = []
    try:
        with log_file.open("r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    # Corrupted line (e.g. interrupted write). Skip.
                    logger.debug(
                        f"Skipping malformed conversation log line {line_num} in "
                        f"{log_file}"
                    )
                    continue
    except OSError as e:
        logger.warning(f"Could not read conversation log {log_file}: {e}")
        return []

    return entries


def deserialize_message(entry: dict[str, Any]) -> AgentMessage:
    """Reconstruct an AgentMessage from a persisted log entry.

    Fields not understood by the current schema are tolerated (forward
    compatibility — older readers shouldn't crash on newer files).
    """
    role_str = entry.get("role", "assistant")
    try:
        role = MessageRole(role_str)
    except ValueError:
        role = MessageRole.ASSISTANT

    blocks: list[ContentBlock] = []
    for raw_block in entry.get("content", []) or []:
        type_str = raw_block.get("type")
        try:
            block_type = ContentBlockType(type_str)
        except (ValueError, TypeError):
            # Unknown block type — preserve as TEXT with a JSON dump to avoid
            # data loss across schema versions.
            block_type = ContentBlockType.TEXT
            raw_block = {"text": json.dumps(raw_block, ensure_ascii=False)}

        blocks.append(
            ContentBlock(
                type=block_type,
                text=raw_block.get("text"),
                tool_name=raw_block.get("tool_name"),
                tool_id=raw_block.get("tool_id"),
                tool_input=raw_block.get("tool_input"),
                tool_use_id=raw_block.get("tool_use_id"),
                is_error=bool(raw_block.get("is_error", False)),
                result_content=raw_block.get("result_content"),
                structured_output=raw_block.get("structured_output"),
                subtype=raw_block.get("subtype"),
            )
        )

    return AgentMessage(role=role, content=blocks, raw=None)


def has_pending_tool_use(entries: list[dict[str, Any]]) -> bool:
    """True if the conversation ended with an assistant tool_use that wasn't
    followed by its corresponding tool_result.

    This is the typical state when a rate-limit hits mid-conversation: the
    assistant emitted a tool call, the tool was about to run, then we paused.
    On resume the replay must dispatch the pending tool result back to the
    new provider so the session can continue coherently.
    """
    pending_tool_ids: set[str] = set()
    for entry in entries:
        role = entry.get("role")
        for block in entry.get("content", []) or []:
            t = block.get("type")
            if t == "tool_use" and role == "assistant":
                tid = block.get("tool_id")
                if tid:
                    pending_tool_ids.add(tid)
            elif t == "tool_result":
                tid = block.get("tool_use_id")
                if tid:
                    pending_tool_ids.discard(tid)
    return bool(pending_tool_ids)


def archive_all_logs(spec_dir: Path, tag: str = "archived") -> int:
    """Move every active conversation log (legacy + per-model) aside, e.g. on a
    prompt-too-long halt, so the next run starts fresh while keeping an audit
    trail. Already-archived files are skipped. Returns the count moved.
    Best-effort — never raises.
    """
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    moved = 0
    seen: set[Path] = set()
    candidates = [
        spec_dir / CONVERSATION_LOG_FILENAME,
        *spec_dir.glob(f"{_LOG_PREFIX}.*{_LOG_SUFFIX}"),
    ]
    skip_markers = (".too-long.", ".trimmed.", ".archived.", ".migrated")
    for path in candidates:
        if path in seen or not path.exists():
            continue
        seen.add(path)
        if any(marker in path.name for marker in skip_markers):
            continue
        try:
            path.rename(spec_dir / f"{path.stem}.{timestamp}.{tag}.jsonl")
            moved += 1
        except OSError as e:
            logger.warning("Could not archive conversation log %s: %s", path, e)
    return moved


def clear_log(
    spec_dir: Path,
    provider: str | None = None,
    model: str | None = None,
) -> None:
    """Delete conversation log(s) so the next run isn't replayed against stale
    history.

    With ``provider``+``model``, deletes only that model's log. Without them,
    deletes EVERY conversation log for the spec (legacy single file + all
    per-model files) — the "reset the whole task" behavior.
    """
    try:
        if provider and model:
            conversation_log_path(spec_dir, provider, model).unlink(missing_ok=True)
            return
        # Whole-task reset: legacy file + every per-model log.
        legacy = spec_dir / CONVERSATION_LOG_FILENAME
        legacy.unlink(missing_ok=True)
        for path in spec_dir.glob(f"{_LOG_PREFIX}.*{_LOG_SUFFIX}"):
            try:
                path.unlink(missing_ok=True)
            except OSError as e:
                logger.warning(f"Could not delete conversation log {path}: {e}")
    except OSError as e:
        logger.warning(f"Could not delete conversation log(s) in {spec_dir}: {e}")
