"""Provider-agnostic routing for ``TestGeneratorAgent._call_llm``.

Guards the fix that stopped test generation from silently doing nothing for
anyone not authenticated with Claude: the call must go through
``core.oneshot.oneshot_completion`` (which honours the user's selected provider),
forward the project path, and fail loudly on an empty response.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from agents.test_generator import TestGeneratorAgent


def test_call_llm_routes_through_oneshot_with_project_path() -> None:
    agent = TestGeneratorAgent()
    captured: dict[str, object] = {}

    async def fake_oneshot(prompt, system_prompt=None, project_dir=None):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        captured["project_dir"] = project_dir
        return '{"ok": true}'

    with patch("core.oneshot.oneshot_completion", side_effect=fake_oneshot):
        result = asyncio.run(agent._call_llm("PROMPT", "/my/project"))

    assert result == '{"ok": true}'
    assert captured["prompt"] == "PROMPT"
    assert captured["project_dir"] == "/my/project"
    assert captured["system_prompt"]  # a non-empty system prompt is supplied


def test_call_llm_raises_on_empty_response() -> None:
    agent = TestGeneratorAgent()

    async def empty(*_a, **_k):
        return "   "

    with (
        patch("core.oneshot.oneshot_completion", side_effect=empty),
        pytest.raises(RuntimeError),
    ):
        asyncio.run(agent._call_llm("PROMPT"))
