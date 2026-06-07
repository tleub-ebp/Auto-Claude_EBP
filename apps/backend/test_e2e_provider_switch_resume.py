"""End-to-end test: provider switch + conversation replay (Niveau 3b).

Simulates the full ground-truth scenario:

1. A Claude session writes 3 messages to {spec_dir}/conversation.jsonl
2. The user hits the rate limit; the frontend writes a RESUME_WITH_PROVIDER
   marker asking to resume on Copilot.
3. The next session starts → _get_active_provider() honors the marker and
   returns "copilot".
4. _maybe_replay_conversation() loads the 3 prior messages and hands them
   to the new (mock) Copilot client via resume().
5. When the new Copilot client builds its next OpenAI-style messages list,
   it injects the prior transcript as a system message.

This test deliberately avoids spinning up real provider clients (which need
network and tokens). Instead it composes the real backend helpers against
in-memory fakes to prove the wiring holds end-to-end.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.client import (
    RESUME_WITH_PROVIDER_FILE,
    _consume_resume_with_provider_marker,
)
from core.conversation_log import append_message


def _seed_claude_conversation(spec_dir: Path) -> None:
    """Persist 3 messages as if a Claude session had been running."""
    append_message(
        spec_dir,
        AgentMessage(
            role=MessageRole.USER,
            content=[
                ContentBlock(
                    type=ContentBlockType.TEXT,
                    text="Refactor the rate-limit code to use the shared shield",
                )
            ],
        ),
        phase="coding",
        provider="claude",
        model="claude-opus-4-7",
    )
    append_message(
        spec_dir,
        AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(
                    type=ContentBlockType.TEXT,
                    text="Looking at qa/loop.py first to understand the existing pattern.",
                ),
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="Read",
                    tool_input={"file_path": "apps/backend/qa/loop.py"},
                    tool_id="t_claude_1",
                ),
            ],
        ),
        phase="coding",
        provider="claude",
        model="claude-opus-4-7",
    )
    append_message(
        spec_dir,
        AgentMessage(
            role=MessageRole.USER,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id="t_claude_1",
                    result_content="(file contents...)",
                    is_error=False,
                )
            ],
        ),
        phase="coding",
        provider="claude",
        model="claude-opus-4-7",
    )


class _FakeCopilotClient(AgentClient):
    """Minimal AgentClient that records resume() and produces OpenAI-format
    messages so we can verify the preamble gets injected end-to-end."""

    def __init__(self) -> None:
        self.model = "gpt-4o"
        self.resume_calls: list[list[AgentMessage]] = []
        self.captured_messages: list[dict[str, Any]] = []

    def provider_name(self) -> str:
        return "copilot"

    def supports_subagents(self) -> bool:
        return False

    async def query(self, prompt: str) -> None:
        # Mimic what real CopilotAgentClient does: build OpenAI messages
        # list and call the shared helper to inject any queued history.
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": "you are a helpful coding agent"}
        ]
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})
        self.captured_messages = messages

    async def receive_response(self):
        # Empty stream — this test doesn't exercise the read path.
        if False:
            yield  # pragma: no cover
        return

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return None

    async def resume(self, history: list[AgentMessage]) -> None:
        # Track the call for assertions, then fall through to the ABC's
        # default behavior so the history is queued for query().
        self.resume_calls.append(history)
        await super().resume(history)


@pytest.mark.asyncio
async def test_e2e_claude_to_copilot_provider_switch_with_replay(
    tmp_path: Path,
) -> None:
    """Walk the full pause-and-resume-with-different-provider flow."""
    from agents.session import _maybe_replay_conversation

    spec_dir = tmp_path

    # --- Setup: Claude wrote 3 messages, then the user picked Copilot in
    # the pause modal (frontend writes RESUME_WITH_PROVIDER) ---
    _seed_claude_conversation(spec_dir)
    (spec_dir / RESUME_WITH_PROVIDER_FILE).write_text("copilot", encoding="utf-8")

    # --- Step 1: session startup reads the marker, override wins ---
    override = _consume_resume_with_provider_marker(spec_dir)
    assert override == "copilot"
    # Marker is single-shot — gone after consumption.
    assert not (spec_dir / RESUME_WITH_PROVIDER_FILE).exists()

    # --- Step 2: the new Copilot client is created and the session replays ---
    copilot = _FakeCopilotClient()
    await _maybe_replay_conversation(
        copilot, spec_dir, provider="copilot", model="gpt-4o"
    )

    # resume() was called once with the full 3-message history in order.
    assert len(copilot.resume_calls) == 1
    history = copilot.resume_calls[0]
    assert len(history) == 3
    assert history[0].role == MessageRole.USER
    assert "Refactor the rate-limit" in history[0].content[0].text
    assert history[1].role == MessageRole.ASSISTANT
    # The assistant's tool_use survived the round-trip.
    tool_use = next(
        (b for b in history[1].content if b.type == ContentBlockType.TOOL_USE),
        None,
    )
    assert tool_use is not None
    assert tool_use.tool_name == "Read"
    assert history[2].role == MessageRole.USER
    # The tool_result survived too.
    tool_result = next(
        (b for b in history[2].content if b.type == ContentBlockType.TOOL_RESULT),
        None,
    )
    assert tool_result is not None

    # --- Step 3: when Copilot fires its next query, the preamble is
    # injected as a system message containing the Claude transcript ---
    await copilot.query("now finish the refactor")

    messages = copilot.captured_messages
    # Expect: [system: identity, system: preamble, user: prompt]
    assert len(messages) == 3
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "system"
    assert "PRIOR CONVERSATION" in messages[1]["content"]
    assert "Refactor the rate-limit" in messages[1]["content"]
    assert "Read" in messages[1]["content"]  # tool_use rendered
    assert messages[2] == {"role": "user", "content": "now finish the refactor"}

    # And the queue is consumed — a second query() must NOT repeat the preamble.
    await copilot.query("anything else?")
    messages_2 = copilot.captured_messages
    assert len(messages_2) == 2
    assert messages_2[0]["role"] == "system"
    assert "PRIOR CONVERSATION" not in messages_2[0]["content"]
    assert messages_2[1] == {"role": "user", "content": "anything else?"}


@pytest.mark.asyncio
async def test_e2e_no_marker_means_default_provider_kept(tmp_path: Path) -> None:
    """If no RESUME_WITH_PROVIDER marker is written, the override step
    returns None and the rest of _get_active_provider() resolution applies.
    The conversation replay should still happen with whatever client is
    chosen (proving replay is independent of the override mechanism)."""
    from agents.session import _maybe_replay_conversation

    spec_dir = tmp_path
    _seed_claude_conversation(spec_dir)

    # No marker written.
    assert _consume_resume_with_provider_marker(spec_dir) is None

    # Replay still fires (provider choice is orthogonal).
    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, spec_dir, "claude", "opus")
    fake_client.resume.assert_awaited_once()
