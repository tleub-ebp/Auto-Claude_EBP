"""
Streaming Agent Wrapper Tests
============================

Unit tests for the StreamingAgentWrapper and related streaming functionality.
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from streaming.agent_wrapper import StreamingAgentWrapper, create_streaming_wrapper


class TestStreamingAgentWrapper:
    """Test cases for StreamingAgentWrapper class."""

    @pytest.fixture
    def streaming_wrapper(self):
        """Create streaming wrapper with mocked dependencies."""
        wrapper = StreamingAgentWrapper("test-session-123", enable_recording=False)
        wrapper._connect = AsyncMock(return_value=True)
        wrapper._send_event = AsyncMock()
        return wrapper

    def test_init(self, streaming_wrapper):
        """Test wrapper initialization."""
        assert streaming_wrapper.session_id == "test-session-123"
        assert streaming_wrapper.enable_recording is False
        assert streaming_wrapper.recorder is None
        assert streaming_wrapper._is_active is False

    @pytest.mark.asyncio
    async def test_start_session(self, streaming_wrapper):
        """Test starting a streaming session."""
        metadata = {
            "session_id": "test-session-123",
            "task": "test-task",
            "project_path": "/test/path",
            "agent_type": "coder",
            "model": "claude-3",
        }

        await streaming_wrapper.start_session(metadata)

        assert streaming_wrapper._is_active is True
        streaming_wrapper._connect.assert_called_once()

    @pytest.mark.asyncio
    async def test_end_session(self, streaming_wrapper):
        """Test ending a streaming session."""
        # First start the session
        await streaming_wrapper.start_session({"session_id": "test-session-123"})
        assert streaming_wrapper._is_active is True

        # Then end it
        await streaming_wrapper.end_session()

        assert streaming_wrapper._is_active is False

    @pytest.mark.asyncio
    async def test_emit_agent_thinking(self, streaming_wrapper):
        """Test emitting agent thinking events."""
        await streaming_wrapper.start_session({"session_id": "test-session-123"})

        # Reset mock to count only calls after session start
        streaming_wrapper._send_event.reset_mock()

        thinking = "Analyzing the code structure..."
        await streaming_wrapper.emit_agent_thinking(thinking)

        streaming_wrapper._send_event.assert_called_once_with(
            "agent_thinking", {"thinking": thinking}
        )

    @pytest.mark.asyncio
    async def test_emit_agent_response(self, streaming_wrapper):
        """Test emitting agent response events."""
        await streaming_wrapper.start_session({"session_id": "test-session-123"})

        # Reset mock to count only calls after session start
        streaming_wrapper._send_event.reset_mock()

        response = "I'll implement the feature using React hooks..."
        await streaming_wrapper.emit_agent_response(response)

        streaming_wrapper._send_event.assert_called_once_with(
            "agent_response", {"response": response, "tokens_used": None}
        )

    @pytest.mark.asyncio
    async def test_emit_file_change(self, streaming_wrapper):
        """Test emitting file change events."""
        await streaming_wrapper.start_session({"session_id": "test-session-123"})

        # Reset mock to count only calls after session start
        streaming_wrapper._send_event.reset_mock()

        file_path = "/test/path/src/components/Test.tsx"
        content = "export default function Test() { return <div>Test</div>; }"
        await streaming_wrapper.emit_file_change(file_path, content=content)

        streaming_wrapper._send_event.assert_called_once_with(
            "file_update", {"file_path": file_path, "content": content}
        )

    @pytest.mark.asyncio
    async def test_emit_command(self, streaming_wrapper):
        """Test emitting command events."""
        await streaming_wrapper.start_session({"session_id": "test-session-123"})

        # Reset mock to count only calls after session start
        streaming_wrapper._send_event.reset_mock()

        command = "npm install"
        await streaming_wrapper.emit_command(command, "/test/path")

        streaming_wrapper._send_event.assert_called_once_with(
            "command_run", {"command": command, "cwd": "/test/path"}
        )

    @pytest.mark.asyncio
    async def test_emit_command_output(self, streaming_wrapper):
        """Test emitting command output events."""
        await streaming_wrapper.start_session({"session_id": "test-session-123"})

        # Reset mock to count only calls after session start
        streaming_wrapper._send_event.reset_mock()

        error_msg = "Failed to compile TypeScript"
        await streaming_wrapper.emit_command_output(error_msg, is_error=True)

        streaming_wrapper._send_event.assert_called_once_with(
            "command_output", {"output": error_msg, "is_error": True}
        )

    @pytest.mark.asyncio
    async def test_no_emit_when_inactive(self, streaming_wrapper):
        """Test that events are not emitted when session is inactive."""
        # Don't start the session
        assert streaming_wrapper._is_active is False

        await streaming_wrapper.emit_agent_thinking("test thinking")
        await streaming_wrapper.emit_agent_response("test response")
        await streaming_wrapper.emit_file_change("/test/file", content="content")

        # Should not have been called
        streaming_wrapper._send_event.assert_not_called()


class TestCreateStreamingWrapper:
    """Test cases for create_streaming_wrapper function."""

    def test_create_wrapper_success(self):
        """Test successful wrapper creation."""
        result = create_streaming_wrapper("test-session", enable_recording=True)

        assert isinstance(result, StreamingAgentWrapper)
        assert result.session_id == "test-session"
        assert result.enable_recording is True

    def test_create_wrapper_default_recording(self):
        """Test wrapper creation with default recording setting."""
        result = create_streaming_wrapper("test-session")

        assert isinstance(result, StreamingAgentWrapper)
        assert result.session_id == "test-session"
        assert result.enable_recording is True


class TestStreamingIntegration:
    """Integration tests for streaming functionality."""

    @pytest.mark.asyncio
    async def test_full_session_lifecycle(self):
        """Test complete session lifecycle with multiple events."""
        # Create wrapper with mocked WebSocket methods
        wrapper = StreamingAgentWrapper("integration-test", enable_recording=False)
        wrapper._connect = AsyncMock(return_value=True)
        wrapper._send_event = AsyncMock()

        # Start session
        metadata = {
            "session_id": "integration-test",
            "task": "integration-test-task",
            "project_path": "/test",
            "agent_type": "coder",
        }
        await wrapper.start_session(metadata)

        # Emit various events (5 events after session_start)
        await wrapper.emit_agent_thinking("Starting implementation...")
        await wrapper.emit_file_change("/test/app.ts", content="console.log('test');")
        await wrapper.emit_command("npm run build", "/test")
        await wrapper.emit_agent_response("Implementation completed successfully")
        await wrapper.emit_command_output(
            "Warning: Deprecated API used", is_error=False
        )

        # Verify events were sent: session_start + 5 events = 6 total
        assert wrapper._send_event.call_count == 6

        # End session
        await wrapper.end_session()

        # Verify session is inactive
        assert wrapper._is_active is False

        # Check specific event types from call args list
        call_args_list = wrapper._send_event.call_args_list
        event_types = [call[0][0] for call in call_args_list]
        assert "session_start" in event_types
        assert "agent_thinking" in event_types
        assert "file_update" in event_types
        assert "command_run" in event_types
        assert "agent_response" in event_types
        assert "command_output" in event_types


class TestStreamingReconnection:
    """The wrapper must self-heal a lost/failed WebSocket connection.

    Regression: the wrapper connected only once in start_session. If that
    connect failed (race with the server starting) or the connection later
    dropped, _send_event silently early-returned forever and the live view
    showed zero events ("0 fichiers", stuck on "waiting for code changes").
    """

    @pytest.mark.asyncio
    async def test_send_event_reconnects_when_disconnected(self):
        wrapper = StreamingAgentWrapper("s", enable_recording=False)
        wrapper._is_active = True
        fake_ws = AsyncMock()

        async def fake_connect():
            wrapper._ws = fake_ws
            wrapper._connected = True
            return True

        wrapper._connect = AsyncMock(side_effect=fake_connect)

        assert wrapper._connected is False
        await wrapper.emit_agent_thinking("hi")

        wrapper._connect.assert_awaited_once()
        fake_ws.send.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_send_failure_drops_socket_and_next_event_reconnects(self):
        wrapper = StreamingAgentWrapper("s", enable_recording=False)
        wrapper._is_active = True

        bad_ws = AsyncMock()
        bad_ws.send.side_effect = ConnectionError("boom")
        good_ws = AsyncMock()
        attempts: list = []

        async def fake_connect():
            ws = bad_ws if not attempts else good_ws
            attempts.append(ws)
            wrapper._ws = ws
            wrapper._connected = True
            return True

        wrapper._connect = AsyncMock(side_effect=fake_connect)

        # First emit connects to the failing socket; send fails -> socket dropped
        await wrapper.emit_agent_thinking("one")
        assert wrapper._connected is False
        assert wrapper._ws is None

        # Bypass the reconnect throttle, then the next emit must reconnect
        wrapper._last_reconnect_attempt = 0.0
        await wrapper.emit_agent_thinking("two")

        assert wrapper._connect.await_count == 2
        good_ws.send.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_reconnect_attempts_are_throttled(self):
        wrapper = StreamingAgentWrapper("s", enable_recording=False)
        wrapper._is_active = True
        wrapper._connect = AsyncMock(return_value=False)  # server unreachable

        await wrapper.emit_agent_thinking("one")  # attempt 1
        await wrapper.emit_agent_thinking("two")  # within throttle window -> skip
        assert wrapper._connect.await_count == 1

        # Once the throttle window elapses, a new attempt is allowed
        wrapper._last_reconnect_attempt = 0.0
        await wrapper.emit_agent_thinking("three")
        assert wrapper._connect.await_count == 2


if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])
