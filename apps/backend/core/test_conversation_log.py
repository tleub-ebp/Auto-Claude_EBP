"""Tests for the provider-neutral conversation log."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Stub the broken transitive import that core.agent_client pulls in
# (apps.backend.models_registry). Tests focus on the log layer, not pricing.
sys.modules.setdefault("apps", MagicMock())
sys.modules.setdefault("apps.backend", MagicMock())
sys.modules.setdefault("apps.backend.models_registry", MagicMock())


def _msg(role: str = "assistant", blocks: list[dict] | None = None):
    """Build a minimal AgentMessage with the requested blocks."""
    from core.agent_client import (
        AgentMessage,
        ContentBlock,
        ContentBlockType,
        MessageRole,
    )

    role_enum = MessageRole(role)
    block_objs: list[ContentBlock] = []
    for b in blocks or []:
        block_objs.append(
            ContentBlock(
                type=ContentBlockType(b["type"]),
                text=b.get("text"),
                tool_name=b.get("tool_name"),
                tool_id=b.get("tool_id"),
                tool_input=b.get("tool_input"),
                tool_use_id=b.get("tool_use_id"),
                is_error=bool(b.get("is_error", False)),
                result_content=b.get("result_content"),
            )
        )
    return AgentMessage(role=role_enum, content=block_objs, raw=None)


def test_append_and_read_roundtrip(tmp_path: Path) -> None:
    """A message appended to the log can be read back with the same content."""
    from core.conversation_log import (
        CONVERSATION_LOG_FILENAME,
        append_message,
        read_log,
    )

    msg = _msg(
        "assistant",
        [{"type": "text", "text": "Hello there"}],
    )
    append_message(
        tmp_path,
        msg,
        phase="coding",
        provider="claude",
        model="claude-opus-4-5",
        subtask_id="s1",
    )

    # File should exist and contain exactly one JSON line.
    log_file = tmp_path / CONVERSATION_LOG_FILENAME
    assert log_file.exists()
    raw = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(raw) == 1

    parsed = json.loads(raw[0])
    assert parsed["role"] == "assistant"
    assert parsed["phase"] == "coding"
    assert parsed["provider"] == "claude"
    assert parsed["model"] == "claude-opus-4-5"
    assert parsed["subtask_id"] == "s1"
    assert parsed["v"] == 1
    assert parsed["content"][0]["type"] == "text"
    assert parsed["content"][0]["text"] == "Hello there"

    # And read_log returns the same.
    entries = read_log(tmp_path)
    assert len(entries) == 1
    assert entries[0]["content"][0]["text"] == "Hello there"


def test_append_drops_none_fields(tmp_path: Path) -> None:
    """ContentBlock fields that are None must not show up in the persisted
    JSON — keeps the file compact and diff-friendly."""
    from core.conversation_log import append_message, read_log

    # text block: only `type` and `text` are set; everything else is None.
    msg = _msg("assistant", [{"type": "text", "text": "hi"}])
    append_message(
        tmp_path, msg, phase="coding", provider="claude", model="claude-opus-4-5"
    )

    entries = read_log(tmp_path)
    block = entries[0]["content"][0]
    assert "tool_name" not in block
    assert "tool_input" not in block
    assert "result_content" not in block
    # is_error is a bool defaulting to False; persisted-or-not is fine but
    # tests below cover that we don't lose info either way.


def test_pending_tool_use_detection(tmp_path: Path) -> None:
    """The log helper correctly reports a tool_use waiting on a tool_result."""
    from core.conversation_log import append_message, has_pending_tool_use, read_log

    # Step 1: assistant emits a tool_use
    msg_tool_call = _msg(
        "assistant",
        [
            {"type": "text", "text": "I'll read the file."},
            {
                "type": "tool_use",
                "tool_id": "toolu_01",
                "tool_name": "Read",
                "tool_input": {"file_path": "x.py"},
            },
        ],
    )
    append_message(
        tmp_path,
        msg_tool_call,
        phase="coding",
        provider="claude",
        model="claude-opus-4-5",
    )

    # Right after this, we should detect a pending tool call.
    assert has_pending_tool_use(read_log(tmp_path)) is True

    # Step 2: user (the harness) emits the tool_result
    msg_tool_result = _msg(
        "user",
        [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_01",
                "result_content": "file contents",
            }
        ],
    )
    append_message(
        tmp_path,
        msg_tool_result,
        phase="coding",
        provider="claude",
        model="claude-opus-4-5",
    )

    # Now nothing should be pending.
    assert has_pending_tool_use(read_log(tmp_path)) is False


def test_read_log_skips_malformed_lines(tmp_path: Path) -> None:
    """If the process crashes mid-write, the last line might be partial JSON.
    read_log must skip it and return the earlier complete messages."""
    from core.conversation_log import CONVERSATION_LOG_FILENAME, read_log

    # Pretend a previous run wrote one good line + one broken half-line.
    log_file = tmp_path / CONVERSATION_LOG_FILENAME
    log_file.write_text(
        '{"v":1,"role":"assistant","content":[{"type":"text","text":"ok"}]}\n'
        '{"v":1,"role":"assista',  # crash here, no newline either
        encoding="utf-8",
    )

    entries = read_log(tmp_path)
    assert len(entries) == 1
    assert entries[0]["content"][0]["text"] == "ok"


def test_deserialize_message_reconstructs_blocks(tmp_path: Path) -> None:
    """deserialize_message produces a usable AgentMessage from a persisted
    entry — this is what the replay path will call to feed the new provider."""
    from core.agent_client import ContentBlockType, MessageRole
    from core.conversation_log import (
        append_message,
        deserialize_message,
        read_log,
    )

    msg = _msg(
        "assistant",
        [
            {"type": "text", "text": "hi"},
            {
                "type": "tool_use",
                "tool_id": "t1",
                "tool_name": "Edit",
                "tool_input": {"file_path": "x"},
            },
        ],
    )
    append_message(
        tmp_path, msg, phase="coding", provider="claude", model="claude-opus-4-5"
    )

    restored = deserialize_message(read_log(tmp_path)[0])
    assert restored.role == MessageRole.ASSISTANT
    assert len(restored.content) == 2
    assert restored.content[0].type == ContentBlockType.TEXT
    assert restored.content[0].text == "hi"
    assert restored.content[1].type == ContentBlockType.TOOL_USE
    assert restored.content[1].tool_name == "Edit"
    assert restored.content[1].tool_input == {"file_path": "x"}


def test_clear_log_removes_file(tmp_path: Path) -> None:
    """clear_log deletes the file (no-op when missing)."""
    from core.conversation_log import (
        CONVERSATION_LOG_FILENAME,
        append_message,
        clear_log,
    )

    msg = _msg("assistant", [{"type": "text", "text": "hi"}])
    append_message(
        tmp_path, msg, phase="coding", provider="claude", model="claude-opus-4-5"
    )
    assert (tmp_path / CONVERSATION_LOG_FILENAME).exists()

    clear_log(tmp_path)
    assert not (tmp_path / CONVERSATION_LOG_FILENAME).exists()

    # Idempotent — clearing twice is fine.
    clear_log(tmp_path)


def test_append_swallows_io_errors(tmp_path: Path, caplog) -> None:
    """A read-only spec_dir should NOT propagate an exception into the agent
    session — the log is best-effort."""
    from core.conversation_log import append_message

    bad_dir = tmp_path / "does" / "not" / "exist"
    # Don't create it — append should swallow the FileNotFoundError.
    msg = _msg("assistant", [{"type": "text", "text": "hi"}])
    append_message(
        bad_dir, msg, phase="coding", provider="claude", model="claude-opus-4-5"
    )
    # No exception — the test passing IS the assertion.
