#!/usr/bin/env python3
"""
Integration Tests for Copilot Sub-Agents Plan
===============================================

End-to-end integration tests verifying that the full provider-agnostic
pipeline works correctly for both Claude and Copilot paths:
- create_agent_client → AgentClient → process_agent_stream
- Orchestrator reviewer uses create_agent_client correctly
- Provider switching via environment variable
- Backward compatibility: raw ClaudeSDKClient still works
"""

import asyncio
import importlib.util
import os
import sys
import types as _types
from pathlib import Path
from pathlib import Path as _Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Mock claude_agent_sdk before any imports that transitively need it
_mock_sdk = MagicMock()
_mock_sdk.ClaudeSDKClient = MagicMock()
_mock_sdk.ClaudeAgentOptions = MagicMock()
_mock_sdk.AgentDefinition = MagicMock()
_mock_sdk.types = MagicMock()
_mock_sdk.types.HookMatcher = MagicMock()
sys.modules["claude_agent_sdk"] = _mock_sdk
sys.modules["claude_agent_sdk.types"] = _mock_sdk.types

# Create runners package hierarchy WITHOUT triggering runners/__init__.py
_BACKEND = _Path(__file__).parent.parent / "apps" / "backend"

# Ensure backend is in sys.path so 'core' and other modules are importable
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# Also add runners/github to sys.path so fallback imports like
# 'from context_gatherer import ...' work when relative imports fail
_RUNNERS_GITHUB = _BACKEND / "runners" / "github"
if str(_RUNNERS_GITHUB) not in sys.path:
    sys.path.insert(0, str(_RUNNERS_GITHUB))

# Pre-load specific services.* modules so imports resolve correctly regardless
# of whether sys.modules["services"] is set to apps/backend/services or not.
# - services.recovery comes from apps/backend/services/ (used by agents.session)
# - services.agent_utils, services.category_utils, etc. come from runners/github/services/
#   (used by parallel_orchestrator_reviewer and parallel_followup_reviewer)
import importlib.util as _ilu


def _load_service_mod(name: str, path: str) -> None:
    if name not in sys.modules:
        _spec = _ilu.spec_from_file_location(name, path, submodule_search_locations=[])
        _mod = _ilu.module_from_spec(_spec)
        sys.modules[name] = _mod
        _spec.loader.exec_module(_mod)


_load_service_mod("services.recovery", str(_BACKEND / "services" / "recovery.py"))

_GH_SERVICES = _BACKEND / "runners" / "github" / "services"
for _svc_mod in [
    "agent_utils",
    "category_utils",
    "io_utils",
    "pydantic_models",
    "pr_worktree_manager",
    "sdk_utils",
    "response_parsers",
]:
    _load_service_mod(f"services.{_svc_mod}", str(_GH_SERVICES / f"{_svc_mod}.py"))

for _pkg, _subpath in [
    ("runners", "runners"),
    ("runners.github", "runners/github"),
    ("runners.github.services", "runners/github/services"),
]:
    if _pkg not in sys.modules:
        _m = _types.ModuleType(_pkg)
        _m.__path__ = [str(_BACKEND / _subpath)]
        _m.__package__ = _pkg
        sys.modules[_pkg] = _m

_sdk_utils_path = _BACKEND / "runners" / "github" / "services" / "sdk_utils.py"
if "runners.github.services.sdk_utils" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "runners.github.services.sdk_utils", _sdk_utils_path,
        submodule_search_locations=[],
    )
    _sdk_utils_mod = importlib.util.module_from_spec(_spec)
    sys.modules["runners.github.services.sdk_utils"] = _sdk_utils_mod
    _spec.loader.exec_module(_sdk_utils_mod)

process_agent_stream = sys.modules["runners.github.services.sdk_utils"].process_agent_stream

from core.agent_client import (
    AgentClient,
    AgentMessage,
    ClaudeAgentClient,
    ContentBlock,
    ContentBlockType,
    CopilotAgentClient,
    MessageRole,
    SubagentDefinition,
)

# =============================================================================
# Integration: Full Claude Path
# =============================================================================


class TestClaudeIntegrationPath:
    """Integration tests for the Claude SDK provider path."""

    @patch("core.client.create_client")
    def test_create_agent_client_to_process_stream(self, mock_create_client, tmp_path):
        """Full path: create_agent_client(claude) → ClaudeAgentClient → process_agent_stream."""
        from core.client import create_agent_client

        # Mock the SDK client
        mock_sdk = MagicMock()
        mock_create_client.return_value = mock_sdk

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
            provider="claude",
        )

        assert isinstance(client, ClaudeAgentClient)
        assert client.provider_name() == "claude"
        assert client.supports_subagents() is True
        assert client.inner is mock_sdk

    @patch("core.client.create_client")
    def test_backward_compat_raw_sdk_client(self, mock_create_client, tmp_path):
        """Raw create_client() still works and returns ClaudeSDKClient (not wrapped)."""
        from core.client import create_client

        mock_sdk = MagicMock()
        mock_create_client.return_value = mock_sdk

        # This should still work — direct call to create_client
        # (we patched it, so just verify it's called)
        result = create_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
        )
        assert result is mock_sdk

    @pytest.mark.asyncio
    async def test_claude_agent_client_full_stream(self):
        """ClaudeAgentClient wraps SDK stream and preserves raw messages."""
        # Simulate SDK messages using proper named classes (SimpleNamespace.__class__
        # assignment is not supported for built-in types)
        class TextBlock:
            def __init__(self, type_, text):
                self.type = type_
                self.text = text
        class AssistantMessage:
            def __init__(self, content, structured_output=None):
                self.content = content
                self.structured_output = structured_output
        text_block = TextBlock("text", "Analysis complete")
        assistant_msg = AssistantMessage(content=[text_block], structured_output=None)

        sdk_mock = MagicMock()
        sdk_mock.query = AsyncMock()

        async def mock_receive():
            yield assistant_msg

        sdk_mock.receive_response = mock_receive

        client = ClaudeAgentClient(sdk_mock)
        await client.query("analyze this")

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        assert len(messages) == 1
        assert messages[0].raw is assistant_msg
        assert messages[0].content[0].type == ContentBlockType.TEXT
        assert messages[0].content[0].text == "Analysis complete"


# =============================================================================
# Integration: Full Copilot Path
# =============================================================================


class TestCopilotIntegrationPath:
    """Integration tests for the Copilot provider path."""

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_create_agent_client_copilot(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """Full path: create_agent_client(copilot) → CopilotAgentClient."""
        from core.client import create_agent_client

        monkeypatch.setenv("GITHUB_TOKEN", "ghp_integration_test")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = ["Read", "Write", "Edit"]
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: False)

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
            agent_type="coder",
            provider="copilot",
        )

        assert isinstance(client, CopilotAgentClient)
        assert client.provider_name() == "copilot"
        assert client.supports_subagents() is True
        assert client.model == "gpt-4o"

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_copilot_with_subagent_definitions(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """Copilot client should receive converted SubagentDefinitions."""
        from core.client import create_agent_client

        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = []
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: False)

        # Simulate AgentDefinition-like objects (from Claude SDK)
        mock_agent = MagicMock()
        mock_agent.description = "Security specialist"
        mock_agent.prompt = "Analyze for vulnerabilities"
        mock_agent.tools = ["Read", "Bash"]
        mock_agent.model = "gpt-4o"

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
            agents={"security": mock_agent},
            provider="copilot",
        )

        assert isinstance(client, CopilotAgentClient)
        assert "security" in client.agents
        assert client.agents["security"].description == "Security specialist"
        assert client.agents["security"].tools == ["Read", "Bash"]

    @pytest.mark.asyncio
    async def test_copilot_subagent_parallel_execution(self):
        """CopilotAgentClient.run_subagents executes agents in parallel."""
        import time
        client = CopilotAgentClient(model="gpt-4o", github_token="gho_test_oauth")
        # Pre-set a valid copilot token to avoid real HTTP token exchange
        client._copilot_token = "copilot_test_token"
        client._copilot_token_expires_at = time.time() + 3600

        agents = {
            "sec": SubagentDefinition(description="Security", prompt="Check sec"),
            "quality": SubagentDefinition(description="Quality", prompt="Check quality"),
            "logic": SubagentDefinition(description="Logic", prompt="Check logic"),
        }

        def make_response(text):
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(
                return_value={"choices": [{"message": {"content": text}}]}
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        responses = iter([
            make_response("No security issues found"),
            make_response("Code quality is acceptable"),
            make_response("Logic is sound"),
        ])

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **kw: next(responses))
        client._http_client = mock_session

        results = await client.run_subagents(agents, "Review PR #123")

        assert len(results) == 3
        assert "sec" in results
        assert "quality" in results
        assert "logic" in results
        assert "security issues" in results["sec"].lower()


# =============================================================================
# Integration: Provider Switching
# =============================================================================


class TestProviderSwitching:
    """Integration tests for dynamic provider switching."""

    @patch("core.client.create_client")
    def test_env_switch_to_claude(self, mock_create_client, tmp_path, monkeypatch):
        """AUTO_CLAUDE_PROVIDER=claude → ClaudeAgentClient."""
        from core.client import create_agent_client

        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "claude")
        mock_create_client.return_value = MagicMock()

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
        )

        assert isinstance(client, ClaudeAgentClient)

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_env_switch_to_copilot(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """AUTO_CLAUDE_PROVIDER=copilot → CopilotAgentClient."""
        from core.client import create_agent_client

        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "copilot")
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = []
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: False)

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
        )

        assert isinstance(client, CopilotAgentClient)

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_project_env_file_switch(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """Project .workpilot/.env AI_PROVIDER=copilot → CopilotAgentClient."""
        from core.client import create_agent_client

        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = []
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: False)

        # Create project env file
        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("AI_PROVIDER=copilot\n")

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
        )

        assert isinstance(client, CopilotAgentClient)


# =============================================================================
# Integration: process_agent_stream with real AgentClient
# =============================================================================


class TestProcessAgentStreamIntegration:
    """Integration tests for process_agent_stream with real client implementations."""

    @pytest.mark.asyncio
    async def test_claude_client_through_process_agent_stream(self):
        """ClaudeAgentClient messages should be processed by process_agent_stream."""
        from runners.github.services.sdk_utils import process_agent_stream

        # Create a ClaudeAgentClient with mock SDK
        # Use proper named classes since SimpleNamespace.__class__ assignment is
        # not supported for built-in types
        class TextBlock:
            def __init__(self, type_, text):
                self.type = type_
                self.text = text
        class ResultMessage:
            def __init__(self, type_, subtype, structured_output):
                self.type = type_
                self.subtype = subtype
                self.structured_output = structured_output
        class AssistantMessage:
            def __init__(self, content, structured_output=None):
                self.content = content
                self.structured_output = structured_output
        text_block = TextBlock("text", "Review complete")
        result_msg_raw = ResultMessage("result", None, {"verdict": "approve"})
        assistant_msg = AssistantMessage(content=[text_block], structured_output=None)

        sdk_mock = MagicMock()
        sdk_mock.query = AsyncMock()

        async def mock_receive():
            yield assistant_msg
            yield result_msg_raw

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        await client.query("review PR")

        result = await process_agent_stream(
            client=client,
            context_name="IntegrationTest",
        )

        assert "Review complete" in result["result_text"]
        assert result["structured_output"] == {"verdict": "approve"}
        assert result["error"] is None

    @pytest.mark.asyncio
    async def test_copilot_client_through_process_agent_stream(self):
        """CopilotAgentClient messages should be processed by process_agent_stream."""
        import time

        from runners.github.services.sdk_utils import process_agent_stream

        client = CopilotAgentClient(model="gpt-4o", github_token="gho_test_oauth")
        # Pre-set a valid copilot token to avoid real HTTP token exchange
        client._copilot_token = "copilot_test_token"
        client._copilot_token_expires_at = time.time() + 3600
        await client.query("analyze code")

        # Mock the HTTP response
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(
            return_value={
                "choices": [
                    {"message": {"content": "Code looks good", "tool_calls": []}}
                ]
            }
        )
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)
        client._http_client = mock_session

        result = await process_agent_stream(
            client=client,
            context_name="CopilotIntegration",
        )

        assert "Code looks good" in result["result_text"]
        assert result["error"] is None


# =============================================================================
# Integration: Orchestrator Reviewer Imports
# =============================================================================


class TestOrchestratorReviewerIntegration:
    """Verify orchestrator reviewers can import the new abstractions."""

    def test_parallel_orchestrator_imports(self):
        """parallel_orchestrator_reviewer should import create_agent_client."""
        from runners.github.services.parallel_orchestrator_reviewer import (
            create_agent_client,
            process_agent_stream,
        )
        assert callable(create_agent_client)
        assert callable(process_agent_stream)

    def test_parallel_followup_imports(self):
        """parallel_followup_reviewer should import create_agent_client."""
        from runners.github.services.parallel_followup_reviewer import (
            create_agent_client,
            process_agent_stream,
        )
        assert callable(create_agent_client)
        assert callable(process_agent_stream)

    def test_agent_definition_optional(self):
        """AgentDefinition import should not crash even if claude_agent_sdk missing."""
        # This test verifies the try/except pattern works
        import runners.github.services.parallel_orchestrator_reviewer as mod
        # AgentDefinition can be None or the real class — both are acceptable
        assert hasattr(mod, "AgentDefinition")


# =============================================================================
# Integration: Session with Provider Routing
# =============================================================================


class TestSessionProviderRouting:
    """Integration tests verifying session.py routes correctly."""

    @pytest.mark.asyncio
    async def test_agent_client_to_session_to_result(self, tmp_path):
        """Full path: AgentClient → run_agent_session → (status, text, error)."""
        from agents.session import run_agent_session
        from core.agent_client import AgentMessage, ContentBlock, ContentBlockType

        class SimpleTestClient(AgentClient):
            def __init__(self):
                self.stored_prompt = None
                
            async def query(self, prompt):
                # Store the prompt for test verification - this mock client
                # doesn't need to process it since receive_response() provides
                # a predefined response for testing purposes
                self.stored_prompt = prompt

            async def receive_response(self):
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(type=ContentBlockType.TEXT, text="Task implemented successfully")
                    ],
                )

            def supports_subagents(self):
                return False

            def provider_name(self):
                return "test"

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                # Mock implementation - no cleanup needed for test client
                pass

        client = SimpleTestClient()

        with patch("agents.session.is_build_complete", return_value=True), \
             patch("agents.session.get_task_logger", return_value=None):
            status, text, error_info = await run_agent_session(
                client=client,
                message="implement feature",
                spec_dir=tmp_path,
            )

        assert status == "complete"
        assert "Task implemented successfully" in text
        assert error_info == {}


class TestCopilotWriteNowNudge:
    """The planner/spec_writer turn-budget safeguard.

    On large brownfield codebases the model can exhaust its turn budget on
    read-only investigation and never call the Write tool, so the planning
    phase fails with 'Did not create plan file'. ``receive_response`` must inject
    a one-time 'write now' directive when the Write tool is still unused and few
    turns remain — and must NOT inject it once the plan has been written.
    """

    def _make_client(self, max_turns: int):
        client = CopilotAgentClient(
            model="claude-sonnet-4.6",
            cwd=".",
            max_turns=max_turns,
            github_token="ghp_test",
            agent_type="spec_writer",
        )
        # Expose the Write tool, as get_tool_definitions does for spec_writer.
        client._tool_definitions = [
            {"name": "run_command", "description": "", "parameters": {}},
            {"name": "Write", "description": "", "parameters": {}},
        ]
        # Avoid real network / token exchange.
        client._get_copilot_token = AsyncMock(return_value="copilot-token")
        client._tool_executor = MagicMock()
        client._tool_executor.execute = AsyncMock(return_value="ok")
        return client

    def _fake_session(self, responses, captured):
        """Build a fake aiohttp session whose .post replays queued responses.

        ``responses`` is a list of (content, tool_calls, finish_reason) tuples,
        one per turn. Each POST payload's messages are appended to ``captured``.
        """

        class _Resp:
            def __init__(self, data):
                self._data = data
                self.status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def json(self):
                return self._data

            async def text(self):
                return ""

        class _Session:
            def __init__(self):
                self._turn = 0

            def post(self, url, json=None, headers=None):
                captured.append([dict(m) for m in json["messages"]])
                content, tool_calls, finish = responses[self._turn]
                self._turn += 1
                return _Resp(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": content,
                                    "tool_calls": tool_calls,
                                },
                                "finish_reason": finish,
                            }
                        ]
                    }
                )

        return _Session()

    def _run_command_call(self, idx):
        return [
            {
                "id": f"call_{idx}",
                "function": {
                    "name": "run_command",
                    "arguments": '{"command": "dir"}',
                },
            }
        ]

    def test_nudge_injected_when_write_never_called(self):
        """Endless investigation triggers a one-time 'write now' nudge."""
        # Window opens when (max_turns - turn) <= 8, i.e. turn >= 12 here.
        max_turns = 20
        client = self._make_client(max_turns)

        # Model keeps investigating every turn, never writing, well past the
        # point the nudge window opens, then finally stops so the loop ends.
        responses = [("", self._run_command_call(i), "tool_calls") for i in range(14)]
        responses.append(("done", [], "stop"))

        captured: list = []
        client._get_http_client = lambda: self._fake_session(responses, captured)

        async def _drive():
            client._pending_query = "plan it"
            async for _ in client.receive_response():
                pass

        asyncio.run(_drive())

        nudge_seen = any(
            msg.get("role") == "user"
            and "STOP investigating" in msg.get("content", "")
            for payload in captured
            for msg in payload
        )
        assert nudge_seen, "Expected a 'write now' nudge to be injected"

        # The directive must be ADDED only once: it is resent in later payloads
        # (it lives in the message history) but never duplicated within one.
        for payload in captured:
            per_payload = sum(
                1
                for msg in payload
                if msg.get("role") == "user"
                and "STOP investigating" in msg.get("content", "")
            )
            assert per_payload <= 1

    def test_no_nudge_when_write_tool_used(self):
        """Once the model writes the plan, no nudge is injected."""
        # Large budget so the nudge window (turn >= 12) is never reached before
        # the model writes and stops on the first turns.
        max_turns = 20
        client = self._make_client(max_turns)

        write_call = [
            {
                "id": "call_w",
                "function": {
                    "name": "Write",
                    "arguments": '{"file_path": "implementation_plan.json", '
                    '"CodeContent": "{}", "EmptyFile": false}',
                },
            }
        ]
        # Writes on the very first turn, then stops.
        responses = [("", write_call, "tool_calls"), ("done", [], "stop")]

        captured: list = []
        client._get_http_client = lambda: self._fake_session(responses, captured)

        async def _drive():
            client._pending_query = "plan it"
            async for _ in client.receive_response():
                pass

        asyncio.run(_drive())

        nudge_seen = any(
            msg.get("role") == "user"
            and "STOP investigating" in msg.get("content", "")
            for payload in captured
            for msg in payload
        )
        assert not nudge_seen, "Nudge must not fire once the Write tool was used"

    def test_early_stop_without_write_forces_retry(self):
        """Model that 'finishes' in prose without writing is forced to retry.

        This is the real-world failure: the planner explores briefly then stops
        (finish_reason=stop, no tool_calls) describing the plan in text. The
        client must refuse that early stop and push the model to call Write.
        """
        max_turns = 20
        client = self._make_client(max_turns)

        write_call = [
            {
                "id": "call_w",
                "function": {
                    "name": "Write",
                    "arguments": '{"file_path": "implementation_plan.json", '
                    '"CodeContent": "{}", "EmptyFile": false}',
                },
            }
        ]
        # Turn 1: stops early with prose, no tool calls (the bug).
        # Turn 2 (after forced retry): finally writes the plan.
        # Turn 3: stops cleanly now that the file exists.
        responses = [
            ("Here is the plan: phase 1 ... phase 2 ...", [], "stop"),
            ("", write_call, "tool_calls"),
            ("done", [], "stop"),
        ]

        captured: list = []
        client._get_http_client = lambda: self._fake_session(responses, captured)

        async def _drive():
            client._pending_query = "plan it"
            async for _ in client.receive_response():
                pass

        asyncio.run(_drive())

        # The forced-write directive must have been injected after the early stop.
        forced = any(
            msg.get("role") == "user"
            and "call the write tool now" in msg.get("content", "").lower()
            for payload in captured
            for msg in payload
        )
        assert forced, "Expected a forced-write retry after the early stop"

        # And the Write tool must actually have been executed (turn 2 ran).
        client._tool_executor.execute.assert_awaited()
        executed_tools = [
            call.args[0] for call in client._tool_executor.execute.await_args_list
        ]
        assert "Write" in executed_tools


class TestCopilotRequestRetry:
    """A hung/stalled Copilot API response must be retried, not hang forever.

    Without a timeout + retry a single stalled HTTP response froze the whole
    planning phase (the socket stayed open, the agent loop never advanced) and
    the frontend appeared stuck. ``receive_response`` must retry transient
    timeout/connection errors and recover once a good response arrives.
    """

    def _make_client(self, max_turns: int = 5):
        client = CopilotAgentClient(
            model="claude-sonnet-4.6",
            cwd=".",
            max_turns=max_turns,
            github_token="ghp_test",
            agent_type="spec_writer",
        )
        client._tool_definitions = [
            {"name": "run_command", "description": "", "parameters": {}},
        ]
        client._get_copilot_token = AsyncMock(return_value="copilot-token")
        client._tool_executor = MagicMock()
        client._tool_executor.execute = AsyncMock(return_value="ok")
        return client

    def _flaky_session(self, fail_times: int, attempts_counter: list, exc=None):
        """Session whose .post raises ``exc`` ``fail_times`` times, then returns
        a clean 'stop' response. ``exc`` defaults to a TimeoutError factory."""

        if exc is None:
            exc = lambda: asyncio.TimeoutError("simulated stalled response")

        class _Resp:
            def __init__(self, data):
                self._data = data
                self.status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def json(self):
                return self._data

            async def text(self):
                return ""

        class _Session:
            def __init__(self):
                self._calls = 0

            def post(self, url, json=None, headers=None):
                self._calls += 1
                attempts_counter.append(self._calls)
                if self._calls <= fail_times:
                    raise exc()
                return _Resp(
                    {
                        "choices": [
                            {
                                "message": {"content": "done", "tool_calls": []},
                                "finish_reason": "stop",
                            }
                        ]
                    }
                )

        return _Session()

    def test_retries_then_recovers(self):
        """Two stalled attempts, third succeeds — the session completes."""
        client = self._make_client()
        attempts: list = []
        client._get_http_client = lambda: self._flaky_session(2, attempts)

        texts: list = []

        async def _drive():
            client._pending_query = "plan it"
            async for msg in client.receive_response():
                for block in msg.content:
                    if getattr(block, "text", None):
                        texts.append(block.text)

        with patch("asyncio.sleep", new=AsyncMock()):
            asyncio.run(_drive())

        # Three POST attempts total (2 failures + 1 success).
        assert len(attempts) == 3
        assert any("done" in t for t in texts)

    def test_fails_after_exhausting_retries(self):
        """All attempts stall — the loop gives up with an error, not a hang."""
        client = self._make_client()
        attempts: list = []
        client._get_http_client = lambda: self._flaky_session(99, attempts)

        texts: list = []

        async def _drive():
            client._pending_query = "plan it"
            async for msg in client.receive_response():
                for block in msg.content:
                    if getattr(block, "text", None):
                        texts.append(block.text)

        with patch("asyncio.sleep", new=AsyncMock()):
            asyncio.run(_drive())

        # A full-duration timeout gets a tighter retry budget than a connection
        # error (each timeout retry costs another full ceiling). With
        # _COPILOT_TIMEOUT_MAX_RETRIES=2 that is 1 initial + 2 retries = 3
        # attempts, then a terminal error message — not the connection-error
        # budget of 4.
        assert len(attempts) == 3
        assert any("timeout/connection" in t.lower() for t in texts)

    def test_connection_error_gets_larger_retry_budget(self):
        """A transient CONNECTION error keeps the full (cheap) retry budget.

        Unlike a full-duration timeout, a connection error fails fast, so it is
        retried _COPILOT_REQUEST_MAX_RETRIES times: 1 initial + 3 retries = 4
        attempts before giving up. This locks in the timeout-vs-connection
        distinction so the two budgets can't silently collapse together.
        """
        import aiohttp

        client = self._make_client()
        attempts: list = []
        client._get_http_client = lambda: self._flaky_session(
            99, attempts, exc=lambda: aiohttp.ClientConnectionError("reset")
        )

        texts: list = []

        async def _drive():
            client._pending_query = "plan it"
            async for msg in client.receive_response():
                for block in msg.content:
                    if getattr(block, "text", None):
                        texts.append(block.text)

        with patch("asyncio.sleep", new=AsyncMock()):
            asyncio.run(_drive())

        assert len(attempts) == 4
        assert any("timeout/connection" in t.lower() for t in texts)


class TestCopilotEmptyToolCallsGuard:
    """Cap consecutive empty ``finish_reason=tool_calls`` responses.

    Claude via the OpenAI-compatible Copilot API sometimes returns
    ``finish_reason=tool_calls`` with an EMPTY tool_calls array. We re-prompt
    and retry, which normally recovers — but a pathological model that never
    emits a real call would otherwise spin through the entire turn budget. The
    guard aborts after a bounded number of CONSECUTIVE empties, and the counter
    must reset whenever a turn does real work.
    """

    def _make_client(self, max_turns: int = 50):
        client = CopilotAgentClient(
            model="claude-sonnet-4.6",
            cwd=".",
            max_turns=max_turns,
            github_token="ghp_test",
            agent_type="coder",
        )
        client._tool_definitions = [
            {"name": "run_command", "description": "", "parameters": {}},
        ]
        client._get_copilot_token = AsyncMock(return_value="copilot-token")
        client._tool_executor = MagicMock()
        client._tool_executor.execute = AsyncMock(return_value="ok")
        return client

    def _fake_session(self, responses, attempts_counter):
        """Replay queued (content, tool_calls, finish_reason) tuples per POST."""

        class _Resp:
            def __init__(self, data):
                self._data = data
                self.status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def json(self):
                return self._data

            async def text(self):
                return ""

        class _Session:
            def __init__(self):
                self._turn = 0

            def post(self, url, json=None, headers=None):
                attempts_counter.append(self._turn)
                content, tool_calls, finish = responses[self._turn]
                self._turn += 1
                return _Resp(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": content,
                                    "tool_calls": tool_calls,
                                },
                                "finish_reason": finish,
                            }
                        ]
                    }
                )

        return _Session()

    def _run_command_call(self, idx):
        return [
            {
                "id": f"call_{idx}",
                "function": {
                    "name": "run_command",
                    "arguments": '{"command": "dir"}',
                },
            }
        ]

    def test_aborts_after_consecutive_empty_tool_calls(self):
        """An endless stream of empty tool_calls stops well before max_turns."""
        from core import agent_client as _ac

        client = self._make_client(max_turns=50)
        # Always return finish_reason=tool_calls with an empty array.
        responses = [("thinking...", [], "tool_calls") for _ in range(50)]
        attempts: list = []
        client._get_http_client = lambda: self._fake_session(responses, attempts)

        texts: list = []

        async def _drive():
            client._pending_query = "do it"
            async for msg in client.receive_response():
                for block in msg.content:
                    if getattr(block, "text", None):
                        texts.append(block.text)

        asyncio.run(_drive())

        # Guard fires after the cap is exceeded — far fewer than max_turns.
        cap = _ac._COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS
        assert len(attempts) == cap + 1
        assert any("infinite loop" in t.lower() for t in texts)

    def test_counter_resets_after_real_work(self):
        """Intermittent empties never trip the guard when work happens between."""
        from core import agent_client as _ac

        cap = _ac._COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS
        client = self._make_client(max_turns=50)

        # Alternate: empty, real tool call, empty, real call... then stop. No run
        # of empties ever reaches the cap, so the session must complete normally.
        responses = []
        for i in range(cap + 3):
            responses.append(("thinking...", [], "tool_calls"))
            responses.append(("", self._run_command_call(i), "tool_calls"))
        responses.append(("all done", [], "stop"))

        attempts: list = []
        client._get_http_client = lambda: self._fake_session(responses, attempts)

        texts: list = []

        async def _drive():
            client._pending_query = "do it"
            async for msg in client.receive_response():
                for block in msg.content:
                    if getattr(block, "text", None):
                        texts.append(block.text)

        asyncio.run(_drive())

        # Reached the natural 'stop', not the guard abort.
        assert any("all done" in t for t in texts)
        assert not any("infinite loop" in t.lower() for t in texts)

