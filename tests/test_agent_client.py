#!/usr/bin/env python3
"""
Tests for Agent Client Abstraction Layer
==========================================

Unit tests for core/agent_client.py covering:
- Abstract AgentClient interface contract
- ClaudeAgentClient wrapping of SDK messages
- CopilotAgentClient API interactions and sub-agent mechanism
- Message normalization (AgentMessage, ContentBlock)
- SubagentDefinition dataclass
"""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

# Mock claude_agent_sdk before any imports that transitively need it
if "claude_agent_sdk" not in sys.modules:
    _mock_sdk = MagicMock()
    _mock_sdk.ClaudeSDKClient = MagicMock()
    _mock_sdk.ClaudeAgentOptions = MagicMock()
    _mock_sdk.AgentDefinition = MagicMock()
    sys.modules["claude_agent_sdk"] = _mock_sdk
    sys.modules["claude_agent_sdk.types"] = MagicMock()

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
# Dataclass / Enum Tests
# =============================================================================


class TestContentBlock:
    """Tests for ContentBlock dataclass."""

    def test_text_block(self):
        block = ContentBlock(type=ContentBlockType.TEXT, text="hello")
        assert block.type == ContentBlockType.TEXT
        assert block.text == "hello"
        assert block.tool_name is None

    def test_tool_use_block(self):
        block = ContentBlock(
            type=ContentBlockType.TOOL_USE,
            tool_name="Read",
            tool_id="tool_1",
            tool_input={"file_path": "/foo.py"},
        )
        assert block.type == ContentBlockType.TOOL_USE
        assert block.tool_name == "Read"
        assert block.tool_id == "tool_1"
        assert block.tool_input == {"file_path": "/foo.py"}

    def test_tool_result_block(self):
        block = ContentBlock(
            type=ContentBlockType.TOOL_RESULT,
            tool_use_id="tool_1",
            is_error=False,
            result_content="file contents",
        )
        assert block.type == ContentBlockType.TOOL_RESULT
        assert block.tool_use_id == "tool_1"
        assert block.is_error is False
        assert block.result_content == "file contents"

    def test_thinking_block(self):
        block = ContentBlock(type=ContentBlockType.THINKING, text="Let me think...")
        assert block.type == ContentBlockType.THINKING
        assert block.text == "Let me think..."

    def test_structured_output_block(self):
        data = {"findings": []}
        block = ContentBlock(
            type=ContentBlockType.STRUCTURED_OUTPUT, structured_output=data
        )
        assert block.structured_output == {"findings": []}

    def test_result_block_with_subtype(self):
        block = ContentBlock(
            type=ContentBlockType.RESULT,
            subtype="error_max_structured_output_retries",
        )
        assert block.subtype == "error_max_structured_output_retries"


class TestAgentMessage:
    """Tests for AgentMessage dataclass."""

    def test_basic_message(self):
        msg = AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[ContentBlock(type=ContentBlockType.TEXT, text="Hello")],
        )
        assert msg.role == MessageRole.ASSISTANT
        assert len(msg.content) == 1
        assert msg.raw is None

    def test_type_name_without_raw(self):
        msg = AgentMessage(role=MessageRole.ASSISTANT)
        assert msg.type_name == "AssistantMessage"

    def test_type_name_with_raw(self):
        raw = SimpleNamespace()
        msg = AgentMessage(role=MessageRole.SYSTEM, raw=raw)
        assert msg.type_name == "SimpleNamespace"


class TestSubagentDefinition:
    """Tests for SubagentDefinition dataclass."""

    def test_defaults(self):
        defn = SubagentDefinition(description="test", prompt="do stuff")
        assert defn.description == "test"
        assert defn.prompt == "do stuff"
        assert defn.tools == []
        assert defn.model == "inherit"

    def test_with_tools(self):
        defn = SubagentDefinition(
            description="sec", prompt="check", tools=["Read", "Bash"], model="gpt-4o"
        )
        assert defn.tools == ["Read", "Bash"]
        assert defn.model == "gpt-4o"


# =============================================================================
# Fake SDK message types (must have correct __name__ for type detection)
# =============================================================================


class AssistantMessage:
    def __init__(self, content=None, structured_output=None):
        self.content = content or []
        self.structured_output = structured_output


class TextBlock:
    def __init__(self, text=""):
        self.type = "text"
        self.text = text


class ToolUseBlock:
    def __init__(self, name="", id="", input=None):
        self.type = "tool_use"
        self.name = name
        self.id = id
        self.input = input or {}


class ThinkingBlock:
    def __init__(self, thinking=""):
        self.type = "thinking"
        self.thinking = thinking


class ToolResultBlock:
    def __init__(self, tool_use_id="", is_error=False, content=""):
        self.type = "tool_result"
        self.tool_use_id = tool_use_id
        self.is_error = is_error
        self.content = content


class ResultMessage:
    def __init__(self, subtype=None, structured_output=None):
        self.type = "result"
        self.subtype = subtype
        self.structured_output = structured_output


# =============================================================================
# ClaudeAgentClient Tests
# =============================================================================


class TestClaudeAgentClient:
    """Tests for ClaudeAgentClient wrapping ClaudeSDKClient."""

    def _make_client(self, sdk_mock=None):
        if sdk_mock is None:
            sdk_mock = MagicMock()
            sdk_mock.query = AsyncMock()
            sdk_mock.receive_response = AsyncMock()
        return ClaudeAgentClient(sdk_mock)

    def test_provider_name(self):
        client = self._make_client()
        assert client.provider_name() == "claude"

    def test_supports_subagents(self):
        client = self._make_client()
        assert client.supports_subagents() is True

    def test_inner_property(self):
        sdk_mock = MagicMock()
        client = ClaudeAgentClient(sdk_mock)
        assert client.inner is sdk_mock

    @pytest.mark.asyncio
    async def test_query_delegates(self):
        sdk_mock = MagicMock()
        sdk_mock.query = AsyncMock()
        client = ClaudeAgentClient(sdk_mock)

        await client.query("test prompt")
        sdk_mock.query.assert_awaited_once_with("test prompt")

    @pytest.mark.asyncio
    async def test_receive_response_wraps_assistant_text(self):
        """AssistantMessage with TextBlock yields TEXT content block."""
        raw_msg = AssistantMessage(
            content=[TextBlock(text="Hello world")],
            structured_output=None,
        )

        sdk_mock = MagicMock()
        sdk_mock.query = AsyncMock()

        async def mock_receive():
            yield raw_msg

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        assert len(messages) == 1
        assert messages[0].raw is raw_msg
        text_blocks = [
            b for b in messages[0].content if b.type == ContentBlockType.TEXT
        ]
        assert len(text_blocks) == 1
        assert text_blocks[0].text == "Hello world"

    @pytest.mark.asyncio
    async def test_receive_response_wraps_tool_use(self):
        """AssistantMessage with ToolUseBlock yields TOOL_USE content block."""
        raw_msg = AssistantMessage(
            content=[ToolUseBlock(name="Read", id="tool_abc", input={"path": "/x"})],
            structured_output=None,
        )

        sdk_mock = MagicMock()

        async def mock_receive():
            yield raw_msg

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        tool_blocks = [
            b for b in messages[0].content if b.type == ContentBlockType.TOOL_USE
        ]
        assert len(tool_blocks) == 1
        assert tool_blocks[0].tool_name == "Read"
        assert tool_blocks[0].tool_id == "tool_abc"
        assert tool_blocks[0].tool_input == {"path": "/x"}

    @pytest.mark.asyncio
    async def test_receive_response_wraps_thinking_block(self):
        """Top-level ThinkingBlock yields THINKING content block."""
        raw_msg = ThinkingBlock(thinking="deep thoughts")

        sdk_mock = MagicMock()

        async def mock_receive():
            yield raw_msg

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        thinking = [
            b for b in messages[0].content if b.type == ContentBlockType.THINKING
        ]
        assert len(thinking) == 1
        assert thinking[0].text == "deep thoughts"

    @pytest.mark.asyncio
    async def test_receive_response_wraps_tool_result_block(self):
        """Top-level ToolResultBlock yields TOOL_RESULT content block."""
        raw_msg = ToolResultBlock(
            tool_use_id="tool_abc",
            is_error=True,
            content="permission denied",
        )

        sdk_mock = MagicMock()

        async def mock_receive():
            yield raw_msg

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        results = [
            b for b in messages[0].content if b.type == ContentBlockType.TOOL_RESULT
        ]
        assert len(results) == 1
        assert results[0].tool_use_id == "tool_abc"
        assert results[0].is_error is True
        assert results[0].result_content == "permission denied"

    @pytest.mark.asyncio
    async def test_receive_response_wraps_result_message(self):
        """ResultMessage yields RESULT content block."""
        raw_msg = ResultMessage(
            subtype=None, structured_output={"score": 9}
        )

        sdk_mock = MagicMock()

        async def mock_receive():
            yield raw_msg

        sdk_mock.receive_response = mock_receive
        client = ClaudeAgentClient(sdk_mock)

        messages = []
        async for msg in client.receive_response():
            messages.append(msg)

        result_blocks = [
            b for b in messages[0].content if b.type == ContentBlockType.RESULT
        ]
        assert len(result_blocks) == 1
        assert result_blocks[0].structured_output == {"score": 9}

    @pytest.mark.asyncio
    async def test_async_context_manager_delegates(self):
        sdk_mock = AsyncMock()
        sdk_mock.__aenter__ = AsyncMock(return_value=sdk_mock)
        sdk_mock.__aexit__ = AsyncMock(return_value=None)

        client = ClaudeAgentClient(sdk_mock)
        async with client as c:
            assert c is client


# =============================================================================
# CopilotAgentClient Tests
# =============================================================================


class TestCopilotAgentClient:
    """Tests for CopilotAgentClient."""

    def test_provider_name(self):
        client = CopilotAgentClient(model="gpt-4o")
        assert client.provider_name() == "copilot"

    def test_supports_subagents(self):
        client = CopilotAgentClient()
        assert client.supports_subagents() is True

    def test_default_init(self):
        client = CopilotAgentClient()
        assert client.model == "gpt-4o"
        assert client.system_prompt is None
        assert client.allowed_tools == []
        assert client.agents == {}
        assert client.max_turns == 50

    def test_custom_init(self):
        agents = {"sec": SubagentDefinition(description="sec", prompt="check security")}
        client = CopilotAgentClient(
            model="gpt-4",
            system_prompt="You are an expert.",
            allowed_tools=["Read"],
            agents=agents,
            cwd="/project",
            max_turns=10,
            github_token="ghp_test123",
        )
        assert client.model == "gpt-4"
        assert client.system_prompt == "You are an expert."
        assert client.github_token == "ghp_test123"
        assert "sec" in client.agents

    @pytest.mark.asyncio
    async def test_query_stores_pending(self):
        client = CopilotAgentClient()
        await client.query("do something")
        assert client._pending_query == "do something"

    @pytest.mark.asyncio
    async def test_receive_response_no_query_returns_nothing(self):
        client = CopilotAgentClient()
        messages = []
        async for msg in client.receive_response():
            messages.append(msg)
        assert messages == []

    @pytest.mark.asyncio
    async def test_receive_response_api_success(self):
        """Test successful API call returns text content."""
        client = CopilotAgentClient(github_token="ghp_test")
        await client.query("hello")

        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(
            return_value={
                "choices": [{"message": {"content": "Hi there!", "tool_calls": []}}]
            }
        )
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)

        client._http_client = mock_session
        
        # Mock the token method to bypass authentication
        with patch.object(client, '_get_copilot_token', return_value="mock_token"):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        assert len(messages) == 1
        assert messages[0].role == MessageRole.ASSISTANT
        text_blocks = [
            b for b in messages[0].content if b.type == ContentBlockType.TEXT
        ]
        assert len(text_blocks) == 1
        assert text_blocks[0].text == "Hi there!"

    @pytest.mark.asyncio
    async def test_receive_response_api_error(self):
        """Test API error returns error message."""
        client = CopilotAgentClient(github_token="ghp_test")
        await client.query("hello")

        mock_response = MagicMock()
        mock_response.status = 401
        mock_response.text = AsyncMock(return_value="Unauthorized")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)

        client._http_client = mock_session

        # Mock the token method to bypass authentication
        with patch.object(client, '_get_copilot_token', return_value="mock_token"):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        assert len(messages) == 1
        assert messages[0].role == MessageRole.SYSTEM
        assert "401" in messages[0].content[0].text

    @pytest.mark.asyncio
    async def test_receive_response_429_retries_then_recovers(self):
        """A 429 rate-limit must be retried (not aborted) and then recover.

        Reproduces the "I still have tokens but get a 429" symptom: GitHub
        Copilot's per-minute request rate limit returns 429 even with quota
        left. The client should ride out the short window and continue
        processing instead of surfacing a "Copilot API error (429)".
        """
        import core.agent_client as agent_client_module

        client = CopilotAgentClient(github_token="ghp_test", max_turns=5)
        await client.query("hello")

        def make_429():
            resp = MagicMock()
            resp.status = 429
            resp.headers = {"Retry-After": "1"}
            resp.text = AsyncMock(
                return_value='{"error":{"message":"rate-limited"}}'
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        def make_ok():
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(
                return_value={
                    "choices": [
                        {"message": {"content": "Recovered!", "tool_calls": []}}
                    ]
                }
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        # Two 429s (transient per-minute limit), then a successful turn.
        responses = iter([make_429(), make_429(), make_ok()])
        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **k: next(responses))
        client._http_client = mock_session

        with patch.object(
            client, "_get_copilot_token", return_value="mock_token"
        ), patch.object(
            agent_client_module, "_COPILOT_RATE_LIMIT_BACKOFF", 0.0
        ), patch("asyncio.sleep", new=AsyncMock()):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        texts = [
            b.text
            for m in messages
            for b in m.content
            if b.type == ContentBlockType.TEXT
        ]
        assert "Recovered!" in texts
        assert not any("429" in t for t in texts)

    @pytest.mark.asyncio
    async def test_receive_response_429_gives_up_after_cap(self):
        """Persistent 429s eventually surface the error after the retry budget."""
        import core.agent_client as agent_client_module

        client = CopilotAgentClient(github_token="ghp_test", max_turns=5)
        await client.query("hello")

        def make_429():
            resp = MagicMock()
            resp.status = 429
            resp.headers = {}
            resp.text = AsyncMock(return_value="rate-limited")
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **k: make_429())
        client._http_client = mock_session

        with patch.object(
            client, "_get_copilot_token", return_value="mock_token"
        ), patch.object(
            agent_client_module, "_COPILOT_RATE_LIMIT_MAX_RETRIES", 2
        ), patch.object(
            agent_client_module, "_COPILOT_RATE_LIMIT_BACKOFF", 0.0
        ), patch("asyncio.sleep", new=AsyncMock()) as mock_sleep:
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        # Retried exactly the budgeted number of times before giving up.
        assert mock_sleep.await_count == 2
        assert messages[-1].role == MessageRole.SYSTEM
        assert "429" in messages[-1].content[0].text

    def test_init_normalizes_anthropic_versioned_model_for_copilot(self):
        """Dash-versioned Anthropic ids are converted to Copilot dotted notation.

        Copilot rejects "claude-sonnet-4-5" with 400 model_not_supported; the
        client must send "claude-sonnet-4.5" instead.
        """
        client = CopilotAgentClient(
            model="claude-sonnet-4-5-20250929", github_token="ghp_test"
        )
        assert client.model == "claude-sonnet-4.5"

        client2 = CopilotAgentClient(model="claude-opus-4-6", github_token="ghp_test")
        assert client2.model == "claude-opus-4.6"

        # Already-dotted / non-Claude ids are left untouched.
        assert (
            CopilotAgentClient(
                model="claude-opus-4.8", github_token="ghp_test"
            ).model
            == "claude-opus-4.8"
        )
        assert (
            CopilotAgentClient(model="gpt-5.5", github_token="ghp_test").model
            == "gpt-5.5"
        )

    @pytest.mark.asyncio
    async def test_receive_response_400_model_not_supported_falls_back(self):
        """A 400 model_not_supported swaps the model and retries (no phase fail).

        Reproduces the QA validation failure where Copilot rejected the model
        with `{"code":"model_not_supported"}`. The client must fall back to a
        supported model and recover instead of surfacing the 400 error.
        """
        client = CopilotAgentClient(
            model="claude-opus-4.8", github_token="ghp_test", max_turns=5
        )
        await client.query("hello")

        def make_400():
            resp = MagicMock()
            resp.status = 400
            resp.headers = {}
            resp.text = AsyncMock(
                return_value=(
                    '{"error":{"message":"The requested model is not '
                    'supported.","code":"model_not_supported","param":"model",'
                    '"type":"invalid_request_error"}}'
                )
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        def make_ok():
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(
                return_value={
                    "choices": [
                        {"message": {"content": "Recovered!", "tool_calls": []}}
                    ]
                }
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        # First call rejects the model, second (after fallback) succeeds.
        responses = iter([make_400(), make_ok()])
        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **k: next(responses))
        client._http_client = mock_session

        with patch.object(client, "_get_copilot_token", return_value="mock_token"):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        texts = [
            b.text
            for m in messages
            for b in m.content
            if b.type == ContentBlockType.TEXT
        ]
        assert "Recovered!" in texts
        assert not any("model_not_supported" in t for t in texts)
        # Model was swapped to the supported fallback before retrying.
        assert client.model == "claude-sonnet-4.5"

    @pytest.mark.asyncio
    async def test_receive_response_with_tool_calls(self):
        """Test response with function-calling tool_calls."""
        client = CopilotAgentClient(github_token="ghp_test", max_turns=1)
        await client.query("read a file")

        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(
            return_value={
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "Read",
                                        "arguments": '{"file_path": "/foo.py"}',
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        )
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)
        client._http_client = mock_session

        # Mock the token method to bypass authentication
        with patch.object(client, '_get_copilot_token', return_value="mock_token"):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        assert len(messages) == 2  # Tool use + tool result
        tool_blocks = [
            b for b in messages[0].content if b.type == ContentBlockType.TOOL_USE
        ]
        assert len(tool_blocks) == 1
        assert tool_blocks[0].tool_name == "Read"
        assert tool_blocks[0].tool_id == "call_1"
        assert tool_blocks[0].tool_input == {"file_path": "/foo.py"}
        
        # Check tool result message
        result_blocks = [
            b for b in messages[1].content if b.type == ContentBlockType.TOOL_RESULT
        ]
        assert len(result_blocks) == 1
        assert "Tool executor not available" in result_blocks[0].result_content

    @pytest.mark.asyncio
    async def test_receive_response_empty_choices_retries_then_recovers(self):
        """A transient empty-choices response should be retried, not abort the session."""
        import core.agent_client as agent_client_module

        client = CopilotAgentClient(github_token="ghp_test", max_turns=5)
        await client.query("hello")

        def make_response(payload):
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(return_value=payload)
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        # First two turns return empty choices (transient hiccup), third succeeds.
        responses = iter(
            [
                make_response({"choices": []}),
                make_response({"choices": []}),
                make_response(
                    {"choices": [{"message": {"content": "Recovered!"}}]}
                ),
            ]
        )

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **k: next(responses))
        client._http_client = mock_session

        with patch.object(client, "_get_copilot_token", return_value="mock_token"), \
            patch.object(
                agent_client_module,
                "_COPILOT_EMPTY_RESPONSE_BACKOFF",
                0.0,
            ), \
            patch("asyncio.sleep", new=AsyncMock()):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        # Session must NOT have surfaced "(Empty response from Copilot)" — it
        # retried and recovered with the real content instead.
        texts = [
            b.text
            for m in messages
            for b in m.content
            if b.type == ContentBlockType.TEXT
        ]
        assert "Recovered!" in texts
        assert "(Empty response from Copilot)" not in texts

    @pytest.mark.asyncio
    async def test_receive_response_empty_choices_gives_up_after_cap(self):
        """Persistent empty choices eventually surface the empty-response message."""
        import core.agent_client as agent_client_module

        client = CopilotAgentClient(github_token="ghp_test", max_turns=20)
        await client.query("hello")

        def make_empty():
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(return_value={"choices": []})
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **k: make_empty())
        client._http_client = mock_session

        with patch.object(client, "_get_copilot_token", return_value="mock_token"), \
            patch.object(
                agent_client_module,
                "_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES",
                2,
            ), \
            patch.object(
                agent_client_module,
                "_COPILOT_EMPTY_RESPONSE_BACKOFF",
                0.0,
            ), \
            patch("asyncio.sleep", new=AsyncMock()):
            messages = []
            async for msg in client.receive_response():
                messages.append(msg)

        texts = [
            b.text
            for m in messages
            for b in m.content
            if b.type == ContentBlockType.TEXT
        ]
        assert "(Empty response from Copilot)" in texts

    @pytest.mark.asyncio
    async def test_run_subagents_parallel(self):
        """Test parallel sub-agent execution."""
        client = CopilotAgentClient(model="gpt-4o", github_token="ghp_test")

        agents = {
            "security": SubagentDefinition(
                description="Security", prompt="Check security"
            ),
            "quality": SubagentDefinition(
                description="Quality", prompt="Check quality"
            ),
        }

        call_count = 0

        def make_mock_response(content_text):
            nonlocal call_count
            call_count += 1
            resp = MagicMock()
            resp.status = 200
            resp.json = AsyncMock(
                return_value={
                    "choices": [{"message": {"content": content_text}}]
                }
            )
            resp.__aenter__ = AsyncMock(return_value=resp)
            resp.__aexit__ = AsyncMock(return_value=None)
            return resp

        responses = iter(
            [
                make_mock_response("No security issues"),
                make_mock_response("Code quality OK"),
            ]
        )

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=lambda *a, **kw: next(responses))
        client._http_client = mock_session

        # Mock the token method to bypass authentication
        with patch.object(client, '_get_copilot_token', return_value="mock_token"):
            results = await client.run_subagents(agents, "Review this PR")

        assert len(results) == 2
        assert "security" in results
        assert "quality" in results
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_context_manager_closes_session(self):
        """Test that __aexit__ closes the HTTP client."""
        client = CopilotAgentClient()
        mock_session = AsyncMock()
        client._http_client = mock_session

        async with client:
            # Context manager body is intentionally empty - we're testing __aexit__ behavior
            pass

        mock_session.close.assert_awaited_once()
        assert client._http_client is None


# =============================================================================
# Abstract AgentClient contract tests
# =============================================================================


class TestAgentClientContract:
    """Verify both implementations satisfy the AgentClient ABC contract."""

    def test_claude_is_agent_client(self):
        sdk_mock = MagicMock()
        client = ClaudeAgentClient(sdk_mock)
        assert isinstance(client, AgentClient)

    def test_copilot_is_agent_client(self):
        client = CopilotAgentClient()
        assert isinstance(client, AgentClient)

    def test_cannot_instantiate_abstract(self):
        """AgentClient cannot be instantiated directly."""
        with pytest.raises(TypeError):
            AgentClient()
