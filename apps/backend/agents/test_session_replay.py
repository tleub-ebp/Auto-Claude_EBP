"""Tests for the conversation-replay wire-up in agents/session.py.

Covers the two helpers that the agent session calls at startup to feed any
prior conversation back into the model:

- `_maybe_replay_conversation` — read the CURRENT model's own log, call resume()
- `_maybe_inject_pending_tool_use_note` — prepend a directive if the last
  assistant turn was an un-dispatched tool_use

Per-model logs: each (provider, model) keeps its own history, so write and
replay must use the SAME (provider, model) — that's the whole point (switching
a phase's LLM resumes that model's own context, a new model starts fresh).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.conversation_log import (
    CONVERSATION_LOG_FILENAME,
    append_message,
    conversation_log_path,
)

# Consistent (provider, model) for write + replay across the tests.
_P = "claude"
_M = "opus"


def _write_history(
    spec_dir: Path,
    messages: list[AgentMessage],
    provider: str = _P,
    model: str = _M,
) -> None:
    """Persist a fake conversation by reusing the real append_message()."""
    for m in messages:
        append_message(spec_dir, m, phase="coding", provider=provider, model=model)


@pytest.mark.asyncio
async def test_replay_noop_when_no_log_exists(tmp_path: Path) -> None:
    """No log for this model — resume() must NOT be called (avoids the cost of
    an empty preamble round-trip)."""
    from agents.session import _maybe_replay_conversation

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)
    fake_client.resume.assert_not_called()


@pytest.mark.asyncio
async def test_replay_noop_for_a_different_model(tmp_path: Path) -> None:
    """History written under model A must NOT be replayed when model B runs —
    each model resumes only its own context."""
    from agents.session import _maybe_replay_conversation

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="task A")],
            )
        ],
        provider="ollama",
        model="qwen2.5-coder:latest",
    )

    fake_client = AsyncMock()
    # A different model → no log of its own → fresh start.
    await _maybe_replay_conversation(fake_client, tmp_path, "ollama", "llama3.1")
    fake_client.resume.assert_not_called()


@pytest.mark.asyncio
async def test_replay_deserializes_log_and_calls_resume(tmp_path: Path) -> None:
    """When the model's log has entries they are deserialised and passed to
    resume() in order."""
    from agents.session import _maybe_replay_conversation

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="task A")],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="working on it")
                ],
            ),
        ],
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == 2
    assert history_arg[0].role == MessageRole.USER
    assert history_arg[0].content[0].text == "task A"
    assert history_arg[1].role == MessageRole.ASSISTANT


@pytest.mark.asyncio
async def test_replay_trims_oversized_log_and_archives_full_history(
    tmp_path: Path,
) -> None:
    """The replay helper must cap the resume window (MAX_REPLAY_MESSAGES), keep
    the most recent tail, and archive the full log so we keep the audit trail."""
    from agents.session import MAX_REPLAY_MESSAGES, _maybe_replay_conversation

    over_cap = MAX_REPLAY_MESSAGES + 50
    msgs = [
        AgentMessage(
            role=MessageRole.USER,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=f"turn {i}")],
        )
        for i in range(over_cap)
    ]
    _write_history(tmp_path, msgs)

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == MAX_REPLAY_MESSAGES
    assert history_arg[-1].content[0].text == f"turn {over_cap - 1}"
    assert history_arg[0].content[0].text == f"turn {over_cap - MAX_REPLAY_MESSAGES}"

    # Full history archived alongside.
    archives = list(tmp_path.glob("conversation.*.trimmed.jsonl"))
    assert len(archives) == 1, f"expected one .trimmed archive, found {archives}"

    # On-disk per-model log is now trimmed too.
    live_log = conversation_log_path(tmp_path, _P, _M)
    with live_log.open("r", encoding="utf-8") as f:
        live_lines = f.readlines()
    assert len(live_lines) == MAX_REPLAY_MESSAGES


@pytest.mark.asyncio
async def test_replay_drops_system_noise_and_preamble_dupes(tmp_path: Path) -> None:
    """Replay must skip empty system turns, the giant ISOLATED WORKTREE preamble
    (rebuilt fresh each session) and bare 'Prompt is too long' echoes."""
    from agents.session import _maybe_replay_conversation

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="please fix bug X")
                ],
            ),
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text="## ⛔ ISOLATED WORKTREE - CRITICAL\n\nYou are in an isolated...",
                    )
                ],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="reading file...")
                ],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="Prompt is too long")
                ],
            ),
            AgentMessage(role=MessageRole.SYSTEM, content=[]),
        ],
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == 2
    assert history_arg[0].content[0].text == "please fix bug X"
    assert history_arg[1].content[0].text == "reading file..."


@pytest.mark.asyncio
async def test_replay_total_payload_capped_even_when_count_under_limit(
    tmp_path: Path,
) -> None:
    """Even below MAX_REPLAY_MESSAGES, the TOTAL payload must stay under
    MAX_REPLAY_TOTAL_CHARS — a few huge tool outputs can blow the window."""
    from agents.session import MAX_REPLAY_TOTAL_CHARS, _maybe_replay_conversation

    big = "x" * 100_000
    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text=f"{i} {big}")],
            )
            for i in range(10)
        ],
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    total_chars = sum(len(m.content[0].text) for m in history_arg)
    assert total_chars <= MAX_REPLAY_TOTAL_CHARS + 110_000
    assert history_arg[-1].content[0].text.startswith("9 ")


@pytest.mark.asyncio
async def test_replay_passes_through_when_log_under_cap(tmp_path: Path) -> None:
    """A log comfortably under the cap is replayed whole — nothing trimmed."""
    from agents.session import _maybe_replay_conversation

    msgs = [
        AgentMessage(
            role=MessageRole.USER,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=f"turn {i}")],
        )
        for i in range(5)
    ]
    _write_history(tmp_path, msgs)

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == 5
    assert not list(tmp_path.glob("conversation.*.trimmed.jsonl"))


@pytest.mark.asyncio
async def test_replay_swallows_corrupt_log_silently(tmp_path: Path) -> None:
    """A garbage legacy log must NEVER take down session start — migration skips
    the bad lines, leaving an empty per-model history (no resume)."""
    from agents.session import _maybe_replay_conversation

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text(
        "{not valid json\n", encoding="utf-8"
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, _P, _M)
    fake_client.resume.assert_not_called()


def test_inject_pending_tool_use_note_prepends_directive(tmp_path: Path) -> None:
    """Last assistant message ended on a tool_use with no matching tool_result
    → the next user message must be prefixed with a directive."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="please read foo.py")
                ],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="Read",
                        tool_input={"file_path": "foo.py"},
                        tool_id="t1",
                    )
                ],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note(
        "now please write a summary", tmp_path, _P, _M
    )
    assert out.startswith("[Resume directive]")
    assert "now please write a summary" in out


def test_inject_pending_tool_use_noop_when_no_pending(tmp_path: Path) -> None:
    """A plain-text last turn (no pending tool_use) passes through unchanged."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="done")],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note("next task", tmp_path, _P, _M)
    assert out == "next task"


def test_inject_pending_tool_use_noop_when_no_log(tmp_path: Path) -> None:
    """No log at all → unchanged message (fresh task)."""
    from agents.session import _maybe_inject_pending_tool_use_note

    out = _maybe_inject_pending_tool_use_note("hello", tmp_path, _P, _M)
    assert out == "hello"


def test_inject_pending_tool_use_handles_corrupt_log(tmp_path: Path) -> None:
    """Corrupt log must not crash session startup."""
    from agents.session import _maybe_inject_pending_tool_use_note

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text("garbage\n", encoding="utf-8")
    out = _maybe_inject_pending_tool_use_note("hello", tmp_path, _P, _M)
    assert out == "hello"


def test_inject_directive_only_when_tool_use_truly_pending(tmp_path: Path) -> None:
    """Tool_use FOLLOWED by tool_result in the log = NOT pending. No directive."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="Read",
                        tool_input={"file_path": "foo.py"},
                        tool_id="t1",
                    )
                ],
            ),
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_RESULT,
                        tool_use_id="t1",
                        result_content="contents",
                        is_error=False,
                    )
                ],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note("continue", tmp_path, _P, _M)
    assert out == "continue"
