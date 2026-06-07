"""Tests for the resume/replay primitives on AgentClient.

Covers:
- `_format_history_as_preamble` — lossless rendering of past messages
- `_consume_resumed_history_as_system_message` — single-shot consumption
- default `resume()` queueing behavior
- Claude provider's `query()` preamble injection
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    AgentClient,
    AgentMessage,
    ClaudeAgentClient,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)


def _make_text_msg(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


def _make_tool_use_msg(name: str, inp: dict[str, Any]) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[
            ContentBlock(
                type=ContentBlockType.TOOL_USE,
                tool_name=name,
                tool_input=inp,
                tool_id="t1",
            )
        ],
    )


def test_format_history_as_preamble_includes_all_text_messages() -> None:
    history = [
        _make_text_msg(MessageRole.USER, "What's the weather?"),
        _make_text_msg(MessageRole.ASSISTANT, "Let me check."),
    ]
    preamble = AgentClient._format_history_as_preamble(history)
    assert "PRIOR CONVERSATION" in preamble
    assert "[user]" in preamble
    assert "What's the weather?" in preamble
    assert "[assistant]" in preamble
    assert "Let me check." in preamble


def test_format_history_drops_thinking_blocks() -> None:
    """Thinking blocks are provider-specific and don't replay well across SDKs."""
    msg = AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[
            ContentBlock(type=ContentBlockType.THINKING, text="hidden reasoning"),
            ContentBlock(type=ContentBlockType.TEXT, text="visible output"),
        ],
    )
    preamble = AgentClient._format_history_as_preamble([msg])
    assert "visible output" in preamble
    assert "hidden reasoning" not in preamble


def test_format_history_renders_tool_use_and_results() -> None:
    history = [
        _make_tool_use_msg("Read", {"file_path": "foo.py"}),
        AgentMessage(
            role=MessageRole.USER,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id="t1",
                    result_content="contents of foo.py",
                    is_error=False,
                )
            ],
        ),
    ]
    preamble = AgentClient._format_history_as_preamble(history)
    assert "<tool_use name=Read>" in preamble
    assert "foo.py" in preamble
    assert "<tool_result>" in preamble
    assert "contents of foo.py" in preamble


def test_format_history_marks_tool_errors() -> None:
    msg = AgentMessage(
        role=MessageRole.USER,
        content=[
            ContentBlock(
                type=ContentBlockType.TOOL_RESULT,
                tool_use_id="t1",
                result_content="permission denied",
                is_error=True,
            )
        ],
    )
    preamble = AgentClient._format_history_as_preamble([msg])
    assert "[ERROR]" in preamble


def test_format_history_empty_returns_empty_string() -> None:
    assert AgentClient._format_history_as_preamble([]) == ""


def test_consume_resumed_history_injects_system_message() -> None:
    """The helper appends a single system message when history was queued and
    clears the queue so a second call is a no-op."""

    # Use a Claude client as a concrete subclass (the helper lives on the ABC).
    client = ClaudeAgentClient(sdk_client=object())
    client._resumed_history = [_make_text_msg(MessageRole.USER, "earlier turn")]

    messages: list[dict[str, Any]] = [{"role": "system", "content": "you are helpful"}]
    client._consume_resumed_history_as_system_message(messages)

    # Should now have the original system + the preamble system message.
    assert len(messages) == 2
    assert messages[1]["role"] == "system"
    assert "earlier turn" in messages[1]["content"]

    # Queue must be cleared so the next call is a no-op.
    assert client._resumed_history == []
    messages2 = [{"role": "system", "content": "you are helpful"}]
    client._consume_resumed_history_as_system_message(messages2)
    assert len(messages2) == 1  # unchanged


def test_consume_resumed_history_noop_when_no_history() -> None:
    client = ClaudeAgentClient(sdk_client=object())
    messages: list[dict[str, Any]] = [{"role": "user", "content": "x"}]
    client._consume_resumed_history_as_system_message(messages)
    assert messages == [{"role": "user", "content": "x"}]


@pytest.mark.asyncio
async def test_default_resume_queues_history_for_query() -> None:
    """The default `resume()` implementation stores history on the client; the
    next query() consumes it. Verified via Claude's override which prepends a
    preamble to the prompt."""
    fake_sdk = AsyncMock()
    client = ClaudeAgentClient(sdk_client=fake_sdk)

    await client.resume([_make_text_msg(MessageRole.USER, "previous turn")])
    assert len(client._resumed_history) == 1

    await client.query("continue from where we left off")

    # Claude's overridden query() prepends a transcript preamble to the prompt.
    assert fake_sdk.query.await_count == 1
    sent_prompt = fake_sdk.query.await_args.args[0]
    assert "PRIOR CONVERSATION" in sent_prompt
    assert "previous turn" in sent_prompt
    assert "continue from where we left off" in sent_prompt

    # Queue consumed — second query() doesn't repeat the preamble.
    await client.query("next message")
    second_prompt = fake_sdk.query.await_args.args[0]
    assert "PRIOR CONVERSATION" not in second_prompt
    assert second_prompt == "next message"


@pytest.mark.asyncio
async def test_resume_with_empty_history_is_noop() -> None:
    fake_sdk = AsyncMock()
    client = ClaudeAgentClient(sdk_client=fake_sdk)

    await client.resume([])
    await client.query("hello")

    sent_prompt = fake_sdk.query.await_args.args[0]
    assert sent_prompt == "hello"
    assert "PRIOR CONVERSATION" not in sent_prompt
