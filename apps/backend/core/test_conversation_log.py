"""Tests for the provider-neutral conversation log (per-model files)."""

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

# A stable (provider, model) used by most tests.
_PROV = "claude"
_MODEL = "claude-opus-4-5"


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


def test_append_writes_per_model_file_and_reads_back(tmp_path: Path) -> None:
    """A message is written to the (provider, model)-specific file and read back
    with read_log(provider, model)."""
    from core.conversation_log import (
        append_message,
        conversation_log_path,
        read_log,
    )

    msg = _msg("assistant", [{"type": "text", "text": "Hello there"}])
    append_message(
        tmp_path, msg, phase="coding", provider=_PROV, model=_MODEL, subtask_id="s1"
    )

    # The per-model file exists and holds exactly one JSON line.
    log_file = conversation_log_path(tmp_path, _PROV, _MODEL)
    assert log_file.exists()
    assert "claude-claude-opus-4-5" in log_file.name
    raw = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(raw) == 1
    parsed = json.loads(raw[0])
    assert parsed["provider"] == _PROV
    assert parsed["model"] == _MODEL
    assert parsed["subtask_id"] == "s1"
    assert parsed["content"][0]["text"] == "Hello there"

    # read_log scoped to the same model returns it.
    entries = read_log(tmp_path, _PROV, _MODEL)
    assert len(entries) == 1
    assert entries[0]["content"][0]["text"] == "Hello there"


def test_per_model_logs_are_isolated(tmp_path: Path) -> None:
    """Two different models keep separate histories — the core of the feature:
    switching a phase's LLM must not mix contexts, and switching back resumes
    the right one."""
    from core.conversation_log import append_message, read_log

    append_message(
        tmp_path,
        _msg("assistant", [{"type": "text", "text": "from qwen"}]),
        phase="planning",
        provider="ollama",
        model="qwen2.5-coder:latest",
    )
    append_message(
        tmp_path,
        _msg("assistant", [{"type": "text", "text": "from llama"}]),
        phase="planning",
        provider="ollama",
        model="llama3.1",
    )

    qwen = read_log(tmp_path, "ollama", "qwen2.5-coder:latest")
    llama = read_log(tmp_path, "ollama", "llama3.1")
    assert [e["content"][0]["text"] for e in qwen] == ["from qwen"]
    assert [e["content"][0]["text"] for e in llama] == ["from llama"]
    # A never-used model starts fresh.
    assert read_log(tmp_path, "ollama", "mistral") == []


def test_log_slug_is_filesystem_safe(tmp_path: Path) -> None:
    """Model ids with ':' and '/' become safe filenames; very long ids are
    truncated with a hash so they stay under filesystem limits."""
    from core.conversation_log import _log_slug, conversation_log_path

    assert _log_slug("ollama", "qwen2.5-coder:latest") == "ollama-qwen2.5-coder-latest"
    p = conversation_log_path(tmp_path, "ollama", "hf.co/Qwen/Qwen2.5-Coder-7B:latest")
    assert "/" not in p.name and ":" not in p.name
    assert p.name.startswith("conversation.") and p.name.endswith(".jsonl")

    long_model = "x" * 200
    slug = _log_slug("ollama", long_model)
    assert len(slug) <= 80


def test_migrate_legacy_log_splits_by_model(tmp_path: Path) -> None:
    """A pre-multi-model conversation.jsonl is split into per-model files, each
    line landing in the file of the (provider, model) that produced it."""
    from core.conversation_log import (
        CONVERSATION_LOG_FILENAME,
        migrate_legacy_log,
        read_log,
    )

    legacy = tmp_path / CONVERSATION_LOG_FILENAME
    legacy.write_text(
        json.dumps(
            {
                "v": 1,
                "provider": "ollama",
                "model": "qwen2.5-coder:latest",
                "role": "assistant",
                "content": [{"type": "text", "text": "q1"}],
            }
        )
        + "\n"
        + json.dumps(
            {
                "v": 1,
                "provider": "ollama",
                "model": "llama3.1",
                "role": "assistant",
                "content": [{"type": "text", "text": "l1"}],
            }
        )
        + "\n"
        + json.dumps(
            {
                "v": 1,
                "provider": "ollama",
                "model": "qwen2.5-coder:latest",
                "role": "assistant",
                "content": [{"type": "text", "text": "q2"}],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    migrate_legacy_log(tmp_path)

    # Legacy file archived (not re-split), per-model files created.
    assert not legacy.exists()
    assert (tmp_path / f"{CONVERSATION_LOG_FILENAME}.migrated").exists()
    qwen = read_log(tmp_path, "ollama", "qwen2.5-coder:latest")
    llama = read_log(tmp_path, "ollama", "llama3.1")
    assert [e["content"][0]["text"] for e in qwen] == ["q1", "q2"]
    assert [e["content"][0]["text"] for e in llama] == ["l1"]
    # Idempotent — a second call is a no-op (legacy already gone).
    migrate_legacy_log(tmp_path)
    assert len(read_log(tmp_path, "ollama", "qwen2.5-coder:latest")) == 2


def test_read_log_migrates_then_reads(tmp_path: Path) -> None:
    """read_log(provider, model) transparently migrates a legacy file first."""
    from core.conversation_log import CONVERSATION_LOG_FILENAME, read_log

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text(
        json.dumps(
            {
                "v": 1,
                "provider": "ollama",
                "model": "llama3.1",
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    entries = read_log(tmp_path, "ollama", "llama3.1")
    assert [e["content"][0]["text"] for e in entries] == ["hi"]


def test_pending_tool_use_detection(tmp_path: Path) -> None:
    """has_pending_tool_use works on a per-model log."""
    from core.conversation_log import append_message, has_pending_tool_use, read_log

    append_message(
        tmp_path,
        _msg(
            "assistant",
            [
                {
                    "type": "tool_use",
                    "tool_id": "toolu_01",
                    "tool_name": "Read",
                    "tool_input": {"file_path": "x.py"},
                }
            ],
        ),
        phase="coding",
        provider=_PROV,
        model=_MODEL,
    )
    assert has_pending_tool_use(read_log(tmp_path, _PROV, _MODEL)) is True

    append_message(
        tmp_path,
        _msg(
            "user",
            [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_01",
                    "result_content": "file contents",
                }
            ],
        ),
        phase="coding",
        provider=_PROV,
        model=_MODEL,
    )
    assert has_pending_tool_use(read_log(tmp_path, _PROV, _MODEL)) is False


def test_read_log_skips_malformed_lines(tmp_path: Path) -> None:
    """A partial last line (process crash mid-write) is skipped."""
    from core.conversation_log import conversation_log_path, read_log

    log_file = conversation_log_path(tmp_path, _PROV, _MODEL)
    log_file.write_text(
        '{"v":1,"role":"assistant","content":[{"type":"text","text":"ok"}]}\n'
        '{"v":1,"role":"assista',  # crash here, no newline
        encoding="utf-8",
    )
    entries = read_log(tmp_path, _PROV, _MODEL)
    assert len(entries) == 1
    assert entries[0]["content"][0]["text"] == "ok"


def test_clear_log_per_model_vs_all(tmp_path: Path) -> None:
    """clear_log(provider, model) removes one model's log; clear_log() removes
    every conversation log (the whole-task reset)."""
    from core.conversation_log import append_message, clear_log, conversation_log_path

    for prov, mdl, txt in [
        ("ollama", "qwen2.5-coder:latest", "q"),
        ("ollama", "llama3.1", "l"),
    ]:
        append_message(
            tmp_path,
            _msg("assistant", [{"type": "text", "text": txt}]),
            phase="coding",
            provider=prov,
            model=mdl,
        )

    # Targeted clear: only qwen.
    clear_log(tmp_path, "ollama", "qwen2.5-coder:latest")
    assert not conversation_log_path(
        tmp_path, "ollama", "qwen2.5-coder:latest"
    ).exists()
    assert conversation_log_path(tmp_path, "ollama", "llama3.1").exists()

    # Whole-task clear: everything gone.
    clear_log(tmp_path)
    assert not conversation_log_path(tmp_path, "ollama", "llama3.1").exists()
    # Idempotent.
    clear_log(tmp_path)


def test_archive_all_logs_moves_active_logs(tmp_path: Path) -> None:
    """archive_all_logs renames active per-model logs aside (prompt-too-long
    escape hatch) and skips already-archived files."""
    from core.conversation_log import append_message, archive_all_logs

    append_message(
        tmp_path,
        _msg("assistant", [{"type": "text", "text": "x"}]),
        phase="coding",
        provider="ollama",
        model="llama3.1",
    )
    moved = archive_all_logs(tmp_path, "too-long")
    assert moved == 1
    assert list(tmp_path.glob("conversation.*.too-long.jsonl"))
    # Active log is gone; a second call moves nothing (only archives remain).
    assert archive_all_logs(tmp_path, "too-long") == 0


def test_append_swallows_io_errors(tmp_path: Path) -> None:
    """A missing spec_dir must NOT propagate — the log is best-effort."""
    from core.conversation_log import append_message

    bad_dir = tmp_path / "does" / "not" / "exist"
    append_message(
        bad_dir,
        _msg("assistant", [{"type": "text", "text": "hi"}]),
        phase="coding",
        provider=_PROV,
        model=_MODEL,
    )  # no exception == pass
