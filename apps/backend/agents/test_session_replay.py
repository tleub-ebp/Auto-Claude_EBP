"""Tests for the conversation-replay wire-up in agents/session.py.

Covers the two helpers that the agent session calls at startup to feed any
prior conversation back into the (possibly new) provider:

- `_maybe_replay_conversation` — deserialise conversation.jsonl, call resume()
- `_maybe_inject_pending_tool_use_note` — prepend a directive if the last
  assistant turn was an un-dispatched tool_use
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.conversation_log import CONVERSATION_LOG_FILENAME, append_message


def _write_history(spec_dir: Path, messages: list[AgentMessage]) -> None:
    """Persist a fake conversation by reusing the real append_message()."""
    for m in messages:
        append_message(spec_dir, m, phase="coding", provider="claude", model="opus-4-7")


@pytest.mark.asyncio
async def test_replay_noop_when_no_log_exists(tmp_path: Path) -> None:
    """No conversation.jsonl — resume() must NOT be called at all (avoids
    cost of an empty preamble round-trip)."""
    from agents.session import _maybe_replay_conversation

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")
    fake_client.resume.assert_not_called()


@pytest.mark.asyncio
async def test_replay_deserializes_log_and_calls_resume(tmp_path: Path) -> None:
    """When the log has entries they should be deserialised and passed to
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
    await _maybe_replay_conversation(fake_client, tmp_path, "copilot", "gpt-4o")

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
    """A long-running task accumulated >1000 messages in conversation.jsonl,
    and every new session start replayed the whole thing as a transcript
    preamble — which made the very next query trip "Prompt is too long" before
    the model could do any actual work.

    The replay helper must cap the resume window (MAX_REPLAY_MESSAGES), keep
    the most recent tail, and archive the full log so we keep the audit trail.
    """
    from agents.session import MAX_REPLAY_MESSAGES, _maybe_replay_conversation

    # Seed N entries where N is well above the cap so we exercise both the
    # archive path AND the on-disk trim. Use append_message so the on-disk
    # format is identical to what the production code writes.
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
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")

    # Resume was called once with the trimmed tail, not the full history.
    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == MAX_REPLAY_MESSAGES, (
        f"resume should have received {MAX_REPLAY_MESSAGES} messages, "
        f"got {len(history_arg)}"
    )
    # The tail must be the MOST RECENT messages (not the first N).
    assert history_arg[-1].content[0].text == f"turn {over_cap - 1}"
    assert history_arg[0].content[0].text == f"turn {over_cap - MAX_REPLAY_MESSAGES}"

    # Full history is archived alongside.
    archives = list(tmp_path.glob("conversation.*.trimmed.jsonl"))
    assert len(archives) == 1, f"expected one .trimmed archive, found {archives}"

    # On-disk log is now also trimmed so subsequent sessions don't re-do the work.
    live_log = tmp_path / CONVERSATION_LOG_FILENAME
    with live_log.open("r", encoding="utf-8") as f:
        live_lines = f.readlines()
    assert len(live_lines) == MAX_REPLAY_MESSAGES


@pytest.mark.asyncio
async def test_replay_drops_system_noise_and_preamble_dupes(tmp_path: Path) -> None:
    """The conversation log accumulates a lot of cruft that's poison if
    re-injected: empty system turns, tool-result-only system turns, the giant
    "⛔ ISOLATED WORKTREE" preamble that the prompt generator already rebuilds
    fresh every session, and bare "Prompt is too long" assistant echoes.

    Replay must skip all of these — they're up to 90% of the on-disk log in
    a long-running task and were the actual reason the prompt kept blowing
    the context window even after our message-count cap.
    """
    from agents.session import _maybe_replay_conversation

    # Mix of useful and useless entries. The useful ones are the two
    # plain-text turns the model actually needs for continuity.
    _write_history(
        tmp_path,
        [
            # KEEP — real user turn
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="please fix bug X")
                ],
            ),
            # DROP — giant preamble duplicate (the prompt generator rebuilds it)
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text="## ⛔ ISOLATED WORKTREE - CRITICAL\n\nYou are in an isolated...",
                    )
                ],
            ),
            # KEEP — real assistant work
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="reading file...")
                ],
            ),
            # DROP — bare "Prompt is too long" echo
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="Prompt is too long")
                ],
            ),
            # DROP — empty system noise (no content)
            AgentMessage(role=MessageRole.SYSTEM, content=[]),
        ],
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    # Only the 2 useful turns should survive.
    assert len(history_arg) == 2, (
        f"expected 2 useful turns, got {len(history_arg)}: "
        f"{[m.content[0].text[:30] for m in history_arg]}"
    )
    assert history_arg[0].content[0].text == "please fix bug X"
    assert history_arg[1].content[0].text == "reading file..."


@pytest.mark.asyncio
async def test_replay_total_payload_capped_even_when_count_under_limit(
    tmp_path: Path,
) -> None:
    """Even if the message count is below MAX_REPLAY_MESSAGES, the TOTAL
    payload size must stay under MAX_REPLAY_TOTAL_CHARS. A handful of huge
    tool outputs can blow the context window on their own."""
    from agents.session import (
        MAX_REPLAY_TOTAL_CHARS,
        _maybe_replay_conversation,
    )

    # 10 messages of ~100 KB each = ~1 MB, well over the 600 KB cap.
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
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    total_chars = sum(len(m.content[0].text) for m in history_arg)
    # Allow one over-cap message at the tail (we keep at least one even if it
    # overshoots, so the model has SOMETHING to ground on).
    assert total_chars <= MAX_REPLAY_TOTAL_CHARS + 110_000, (
        f"total replay payload {total_chars} chars > cap {MAX_REPLAY_TOTAL_CHARS}"
    )
    # And it must be the MOST RECENT messages that survive.
    assert history_arg[-1].content[0].text.startswith("9 ")


@pytest.mark.asyncio
async def test_replay_passes_through_when_log_under_cap(tmp_path: Path) -> None:
    """If the log is comfortably under the cap, nothing is trimmed or archived
    — the resume window is the entire log as before."""
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
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == 5
    assert not list(tmp_path.glob("conversation.*.trimmed.jsonl"))


@pytest.mark.asyncio
async def test_replay_swallows_corrupt_log_silently(tmp_path: Path) -> None:
    """A garbage conversation.jsonl must NEVER take down session start —
    just log a warning and fall through with an empty history."""
    from agents.session import _maybe_replay_conversation

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text(
        "{not valid json\n", encoding="utf-8"
    )

    fake_client = AsyncMock()
    # Should not raise.
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")
    # read_log returns [] on malformed lines, so resume() isn't even called.
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

    out = _maybe_inject_pending_tool_use_note("now please write a summary", tmp_path)
    assert out.startswith("[Resume directive]")
    assert "now please write a summary" in out


def test_inject_pending_tool_use_noop_when_no_pending(tmp_path: Path) -> None:
    """When the last assistant turn is plain text (no pending tool_use), the
    message must pass through unchanged."""
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

    out = _maybe_inject_pending_tool_use_note("next task", tmp_path)
    assert out == "next task"


def test_inject_pending_tool_use_noop_when_no_log(tmp_path: Path) -> None:
    """No log at all → unchanged message (fresh task)."""
    from agents.session import _maybe_inject_pending_tool_use_note

    out = _maybe_inject_pending_tool_use_note("hello", tmp_path)
    assert out == "hello"


def test_inject_pending_tool_use_handles_corrupt_log(tmp_path: Path) -> None:
    """Corrupt log must not crash session startup."""
    from agents.session import _maybe_inject_pending_tool_use_note

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text("garbage\n", encoding="utf-8")
    out = _maybe_inject_pending_tool_use_note("hello", tmp_path)
    # On malformed entries read_log returns [], so no directive is added.
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

    out = _maybe_inject_pending_tool_use_note("continue", tmp_path)
    assert out == "continue"  # tool_use was already answered
