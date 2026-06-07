"""
Streaming Manager - WebSocket-based real-time event broadcasting.

Broadcasts development session events to connected clients for the "Streaming Development" mode.
Think Twitch, but for AI coding sessions.
"""

import asyncio
import json
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any


class EventType(str, Enum):
    """Types of streaming events."""

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    CODE_CHANGE = "code_change"
    FILE_CREATE = "file_create"
    FILE_UPDATE = "file_update"
    FILE_DELETE = "file_delete"
    COMMAND_RUN = "command_run"
    COMMAND_OUTPUT = "command_output"
    AGENT_THINKING = "agent_thinking"
    AGENT_RESPONSE = "agent_response"
    ERROR = "error"
    TEST_RUN = "test_run"
    TEST_RESULT = "test_result"
    COMMIT = "commit"
    CHAT_MESSAGE = "chat_message"
    INTERVENTION = "intervention"
    PROGRESS_UPDATE = "progress_update"
    TOOL_USE = "tool_use"
    SESSION_CONFIRMED = "session_confirmed"
    FILE_OPERATION = "file_operation"


@dataclass
class StreamingEvent:
    """A single streaming event."""

    event_type: EventType
    timestamp: float
    data: dict[str, Any]
    session_id: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "event_type": self.event_type.value,
            "timestamp": self.timestamp,
            "data": self.data,
            "session_id": self.session_id,
        }


class StreamingManager:
    """
    Manages streaming sessions and broadcasts events to connected clients.

    Features:
    - Real-time WebSocket broadcasting
    - Session recording for replay
    - Chat integration for live interaction
    - Intervention support (pause/hijack sessions)
    """

    def __init__(self):
        self._active_sessions: dict[str, dict[str, Any]] = {}
        self._subscribers: dict[
            str, set[Any]
        ] = {}  # session_id -> set of websocket connections
        self._event_queue: asyncio.Queue = asyncio.Queue()
        self._is_broadcasting = False

    async def start_session(self, session_id: str, metadata: dict[str, Any]) -> None:
        """Start a new streaming session."""
        self._active_sessions[session_id] = {
            "start_time": time.time(),
            "metadata": metadata,
            "status": "active",
            "event_count": 0,
        }
        # Preserve existing subscribers (frontend may connect before agent starts)
        if session_id not in self._subscribers:
            self._subscribers[session_id] = set()

        event = StreamingEvent(
            event_type=EventType.SESSION_START,
            timestamp=time.time(),
            data={
                "session_id": session_id,
                "metadata": metadata,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def end_session(self, session_id: str) -> None:
        """End a streaming session."""
        if session_id not in self._active_sessions:
            return

        self._active_sessions[session_id]["status"] = "completed"
        self._active_sessions[session_id]["end_time"] = time.time()

        event = StreamingEvent(
            event_type=EventType.SESSION_END,
            timestamp=time.time(),
            data={
                "session_id": session_id,
                "duration": time.time()
                - self._active_sessions[session_id]["start_time"],
                "event_count": self._active_sessions[session_id]["event_count"],
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_code_change(
        self,
        session_id: str,
        file_path: str,
        change_type: str,
        content: str | None = None,
        diff: str | None = None,
    ) -> None:
        """Emit a code change event."""
        event = StreamingEvent(
            event_type=EventType.CODE_CHANGE,
            timestamp=time.time(),
            data={
                "file_path": file_path,
                "change_type": change_type,
                "content": content,
                "diff": diff,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_file_operation(
        self,
        session_id: str,
        operation: str,
        file_path: str,
        content: str | None = None,
    ) -> None:
        """Emit a file operation event (create/update/delete)."""
        event_type_map = {
            "create": EventType.FILE_CREATE,
            "update": EventType.FILE_UPDATE,
            "delete": EventType.FILE_DELETE,
        }

        event = StreamingEvent(
            event_type=event_type_map.get(operation, EventType.FILE_UPDATE),
            timestamp=time.time(),
            data={
                "file_path": file_path,
                "content": content,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_command(
        self,
        session_id: str,
        command: str,
        cwd: str | None = None,
    ) -> None:
        """Emit a command execution event."""
        event = StreamingEvent(
            event_type=EventType.COMMAND_RUN,
            timestamp=time.time(),
            data={
                "command": command,
                "cwd": cwd,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_command_output(
        self,
        session_id: str,
        output: str,
        is_error: bool = False,
    ) -> None:
        """Emit command output event."""
        event = StreamingEvent(
            event_type=EventType.COMMAND_OUTPUT,
            timestamp=time.time(),
            data={
                "output": output,
                "is_error": is_error,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_agent_thinking(
        self,
        session_id: str,
        thinking: str,
    ) -> None:
        """Emit agent thinking/reasoning event."""
        event = StreamingEvent(
            event_type=EventType.AGENT_THINKING,
            timestamp=time.time(),
            data={
                "thinking": thinking,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_agent_response(
        self,
        session_id: str,
        response: str,
        tokens_used: int | None = None,
    ) -> None:
        """Emit agent response event."""
        event = StreamingEvent(
            event_type=EventType.AGENT_RESPONSE,
            timestamp=time.time(),
            data={
                "response": response,
                "tokens_used": tokens_used,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_test_run(
        self,
        session_id: str,
        test_command: str,
    ) -> None:
        """Emit test run event."""
        event = StreamingEvent(
            event_type=EventType.TEST_RUN,
            timestamp=time.time(),
            data={
                "test_command": test_command,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_test_result(
        self,
        session_id: str,
        success: bool,
        details: str | None = None,
    ) -> None:
        """Emit test result event."""
        event = StreamingEvent(
            event_type=EventType.TEST_RESULT,
            timestamp=time.time(),
            data={
                "success": success,
                "details": details,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_chat_message(
        self,
        session_id: str,
        message: str,
        author: str,
        author_type: str = "user",  # user or agent
    ) -> None:
        """Emit a chat message event."""
        event = StreamingEvent(
            event_type=EventType.CHAT_MESSAGE,
            timestamp=time.time(),
            data={
                "message": message,
                "author": author,
                "author_type": author_type,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def emit_progress(
        self,
        session_id: str,
        progress: float,
        status: str,
        current_step: str | None = None,
    ) -> None:
        """Emit a progress update event."""
        event = StreamingEvent(
            event_type=EventType.PROGRESS_UPDATE,
            timestamp=time.time(),
            data={
                "progress": progress,
                "status": status,
                "current_step": current_step,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def _broadcast_event(self, event: StreamingEvent) -> None:
        """Broadcast event to all subscribers of the session.

        Sends in parallel with a per-subscriber timeout. The previous
        sequential `await ws.send(...)` blocked the entire broadcast loop
        when any single subscriber was slow (laptop sleeping with an open
        browser tab) — every subsequent event was held back indefinitely
        for ALL viewers.
        """
        session_id = event.session_id

        # Update event count
        if session_id in self._active_sessions:
            self._active_sessions[session_id]["event_count"] += 1

        # Snapshot subscribers — set may be mutated during iteration via
        # disconnect callbacks.
        subscribers = list(self._subscribers.get(session_id, set()))
        if not subscribers:
            return

        payload = json.dumps(event.to_dict())

        async def _send_one(ws: Any) -> tuple[Any, bool]:
            try:
                await asyncio.wait_for(ws.send(payload), timeout=5.0)
                return ws, True
            except Exception:
                return ws, False

        results = await asyncio.gather(
            *(_send_one(ws) for ws in subscribers),
            return_exceptions=False,
        )

        # Drop subscribers that failed or timed out.
        # Cancelling ws.send mid-flight can leave the framing in an
        # indeterminate state — close the underlying websocket so the
        # client cannot keep receiving partially-framed messages.
        live_set = self._subscribers.get(session_id)
        if live_set is None:
            return
        for ws, ok in results:
            if not ok:
                live_set.discard(ws)
                close = getattr(ws, "close", None)
                if close is not None:
                    try:
                        result = close(code=1011)
                        if asyncio.iscoroutine(result):
                            asyncio.create_task(result)
                    except Exception:
                        pass

    def subscribe(self, session_id: str, websocket: Any) -> None:
        """Subscribe a websocket to a session."""
        if session_id not in self._subscribers:
            self._subscribers[session_id] = set()
        self._subscribers[session_id].add(websocket)

    def unsubscribe(self, session_id: str, websocket: Any) -> None:
        """Unsubscribe a websocket from a session."""
        if session_id in self._subscribers:
            self._subscribers[session_id].discard(websocket)

    async def pause_session(self, session_id: str) -> None:
        """Pause a streaming session."""
        if session_id not in self._active_sessions:
            return

        self._active_sessions[session_id]["status"] = "paused"
        self._active_sessions[session_id]["paused_at"] = time.time()

        event = StreamingEvent(
            event_type=EventType.PROGRESS_UPDATE,
            timestamp=time.time(),
            data={
                "session_id": session_id,
                "status": "Session paused",
                "is_paused": True,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    async def resume_session(self, session_id: str) -> None:
        """Resume a paused streaming session."""
        if session_id not in self._active_sessions:
            return

        if self._active_sessions[session_id]["status"] != "paused":
            return

        self._active_sessions[session_id]["status"] = "active"

        # Adjust start time if session was paused
        if "paused_at" in self._active_sessions[session_id]:
            pause_duration = (
                time.time() - self._active_sessions[session_id]["paused_at"]
            )
            self._active_sessions[session_id]["start_time"] += pause_duration
            del self._active_sessions[session_id]["paused_at"]

        event = StreamingEvent(
            event_type=EventType.PROGRESS_UPDATE,
            timestamp=time.time(),
            data={
                "session_id": session_id,
                "status": "Session resumed",
                "is_paused": False,
            },
            session_id=session_id,
        )
        await self._broadcast_event(event)

    def get_active_sessions(self) -> list[dict[str, Any]]:
        """Get list of active streaming sessions."""
        return [
            {
                "session_id": sid,
                **session_data,
                "subscriber_count": len(self._subscribers.get(sid, set())),
            }
            for sid, session_data in self._active_sessions.items()
            if session_data["status"] == "active"
        ]

    def get_session_info(self, session_id: str) -> dict[str, Any] | None:
        """Get info about a specific session."""
        if session_id not in self._active_sessions:
            return None

        return {
            "session_id": session_id,
            **self._active_sessions[session_id],
            "subscriber_count": len(self._subscribers.get(session_id, set())),
        }


# Global instance
_streaming_manager: StreamingManager | None = None


def get_streaming_manager() -> StreamingManager:
    """Get or create the global streaming manager instance."""
    global _streaming_manager
    if _streaming_manager is None:
        _streaming_manager = StreamingManager()
    return _streaming_manager
