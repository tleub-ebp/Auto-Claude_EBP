"""
Agent Wrapper for Streaming Mode.

Connects to the streaming WebSocket server as a client to publish events.
The WebSocket server (a separate process) then broadcasts these events to
all frontend subscribers.

Architecture:
  Agent process  --ws-->  WebSocket server process  --ws-->  Frontend clients
  (this wrapper)          (websocket_server.py)              (StreamingSession.tsx)
"""

import asyncio
import json
import logging
import time
from typing import Any

from .session_recorder import SessionRecorder

logger = logging.getLogger(__name__)

# Try to import websockets for client connection
try:
    import websockets

    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False


class StreamingAgentWrapper:
    """
    Wraps agent execution to publish events to the streaming WebSocket server.

    Instead of using the in-process StreamingManager (which has no subscribers
    since the frontend connects to the separate WebSocket server process),
    this wrapper connects to the WebSocket server as a client and sends events
    through it.
    """

    def __init__(
        self,
        session_id: str,
        enable_recording: bool = True,
        ws_host: str = "localhost",
        ws_port: int = 8765,
    ):
        self.session_id = session_id
        self.enable_recording = enable_recording
        self.recorder = SessionRecorder() if enable_recording else None
        self._is_active = False
        self._ws_host = ws_host
        self._ws_port = ws_port
        self._ws: Any | None = None
        self._connected = False

    async def _connect(self) -> bool:
        """Connect to the WebSocket server, trying multiple addresses."""
        if not WEBSOCKETS_AVAILABLE:
            logger.warning("websockets package not installed, streaming unavailable")
            return False

        # Try multiple URLs in case of IPv4/IPv6 issues
        urls_to_try = [
            f"ws://{self._ws_host}:{self._ws_port}/stream/{self.session_id}",
            f"ws://127.0.0.1:{self._ws_port}/stream/{self.session_id}",
            f"ws://[::1]:{self._ws_port}/stream/{self.session_id}",
        ]

        for url in urls_to_try:
            try:
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        url,
                        ping_interval=20,
                        ping_timeout=10,
                        close_timeout=5,
                    ),
                    timeout=5.0,
                )
                # Send init_session to subscribe to the correct session
                await self._ws.send(
                    json.dumps(
                        {
                            "type": "init_session",
                            "session_id": self.session_id,
                            "role": "agent",
                        }
                    )
                )
                self._connected = True
                return True
            except asyncio.TimeoutError:
                # Log at debug — silently dropping made misconfigured ports
                # invisible to operators ("agents start successfully but
                # emit zero events" was unsolvable without raising log
                # level on a hidden code path).
                logger.debug("WS connect timed out for %s", url)
            except Exception as exc:
                logger.debug("WS connect failed for %s: %s", url, exc)

        logger.warning("Could not connect to streaming server on any address")
        self._ws = None
        self._connected = False
        return False

    async def _disconnect(self):
        """Disconnect from the WebSocket server."""
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
            self._connected = False

    async def _send_event(self, event_type: str, data: dict[str, Any]):
        """Send an event to the WebSocket server for broadcasting."""
        if not self._connected or not self._ws:
            return

        try:
            message = {
                "type": "agent_event",
                "event": {
                    "event_type": event_type,
                    "timestamp": time.time(),
                    "data": data,
                    "session_id": self.session_id,
                },
            }
            await self._ws.send(json.dumps(message))
        except Exception as e:
            logger.warning(f"Failed to send streaming event: {e}")
            self._connected = False

    async def start_session(self, metadata: dict[str, Any]):
        """Start a streaming session."""
        self._is_active = True

        # Connect to WebSocket server
        connected = await self._connect()
        if not connected:
            logger.warning(
                f"Session {self.session_id} started but WebSocket not connected"
            )

        # Send session_start event
        await self._send_event(
            "session_start",
            {
                "session_id": self.session_id,
                "metadata": metadata,
            },
        )

        if self.recorder:
            self.recorder.start_recording(self.session_id, metadata)

    async def end_session(self):
        """End a streaming session."""
        self._is_active = False

        await self._send_event(
            "session_end",
            {
                "session_id": self.session_id,
            },
        )

        if self.recorder:
            recording = self.recorder.stop_recording(self.session_id)
            if recording:
                # Recording was saved successfully
                pass

        await self._disconnect()

    async def emit_file_change(
        self,
        file_path: str,
        operation: str = "update",
        content: str | None = None,
    ):
        """Emit a file change event."""
        if not self._is_active:
            return
        await self._send_event(
            f"file_{operation}",
            {
                "file_path": file_path,
                "content": content,
            },
        )

    async def emit_command(self, command: str, cwd: str | None = None):
        """Emit a command execution event."""
        if not self._is_active:
            return
        await self._send_event(
            "command_run",
            {
                "command": command,
                "cwd": cwd,
            },
        )

    async def emit_command_output(self, output: str, is_error: bool = False):
        """Emit command output event."""
        if not self._is_active:
            return
        await self._send_event(
            "command_output",
            {
                "output": output,
                "is_error": is_error,
            },
        )

    async def emit_agent_thinking(self, thinking: str):
        """Emit agent thinking/reasoning event."""
        if not self._is_active:
            return
        await self._send_event(
            "agent_thinking",
            {
                "thinking": thinking,
            },
        )

    async def emit_agent_response(self, response: str, tokens_used: int | None = None):
        """Emit agent response event."""
        if not self._is_active:
            return
        await self._send_event(
            "agent_response",
            {
                "response": response,
                "tokens_used": tokens_used,
            },
        )

    async def emit_test_run(self, test_command: str):
        """Emit test run event."""
        if not self._is_active:
            return
        await self._send_event(
            "test_run",
            {
                "test_command": test_command,
            },
        )

    async def emit_test_result(self, success: bool, details: str | None = None):
        """Emit test result event."""
        if not self._is_active:
            return
        await self._send_event(
            "test_result",
            {
                "success": success,
                "details": details,
            },
        )

    async def emit_progress(
        self,
        progress: float,
        status: str,
        current_step: str | None = None,
    ):
        """Emit progress update event."""
        if not self._is_active:
            return
        await self._send_event(
            "progress_update",
            {
                "progress": progress,
                "status": status,
                "current_step": current_step,
            },
        )

    async def emit_tool_use(self, tool_name: str, tool_input: str | None = None):
        """Emit a tool use event for real-time activity display."""
        if not self._is_active:
            return
        await self._send_event(
            "tool_use",
            {
                "tool_name": tool_name,
                "tool_input": tool_input,
            },
        )

    async def emit_chat_message(
        self,
        message: str,
        author: str = "Agent",
        author_type: str = "agent",
    ):
        """Emit a chat message from the agent."""
        if not self._is_active:
            return
        await self._send_event(
            "chat_message",
            {
                "message": message,
                "author": author,
                "author_type": author_type,
            },
        )


# Convenience function to create a wrapper
def create_streaming_wrapper(
    session_id: str, enable_recording: bool = True
) -> StreamingAgentWrapper:
    """Create a streaming agent wrapper."""
    return StreamingAgentWrapper(session_id, enable_recording)
