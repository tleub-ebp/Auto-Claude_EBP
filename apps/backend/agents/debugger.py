"""
Agent Debugger — interactive breakpoint + inspection layer for agent sessions.

Provider-agnostic by design: the debugger intercepts Claude Agent SDK tool
invocations before they run, so it works uniformly whether the underlying
model is Anthropic, OpenAI, Copilot, Windsurf, Ollama, etc. — the SDK
normalises tool calls across all providers.

Core model
----------
- :class:`Breakpoint` — a predicate describing when to pause (tool name +
  optional path / content / command pattern).
- :class:`DebugFrame` — the captured state at a breakpoint hit (tool name,
  tool input, context snapshot, timestamp).
- :class:`DebuggerSession` — a per-agent-session container of breakpoints,
  pending frames, and a waiter that coroutines can ``await`` to resume.
- :class:`DebuggerRegistry` — process-wide singleton mapping session ids to
  sessions. IPC handlers use it to attach / list / resume.

The debugger hook is intended to be plugged as a ``PreToolUse`` hook on
``core.client.create_client`` when the session is marked as "debug".
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Breakpoint:
    """A condition that pauses the agent before a tool runs."""

    id: str
    tool: str  # "Write" | "Edit" | "Bash" | "*"
    path_pattern: str | None = None
    content_pattern: str | None = None
    command_pattern: str | None = None
    enabled: bool = True

    def matches(self, tool_name: str, tool_input: dict[str, Any]) -> bool:
        if not self.enabled:
            return False
        if self.tool != "*" and self.tool != tool_name:
            return False

        if tool_name == "Bash":
            command = str(tool_input.get("command", ""))
            if self.command_pattern and not re.search(self.command_pattern, command):
                return False
            return True

        path = str(tool_input.get("file_path") or tool_input.get("path") or "")
        if self.path_pattern and not re.search(self.path_pattern, path):
            return False

        content = str(tool_input.get("content") or tool_input.get("new_string") or "")
        if self.content_pattern and not re.search(self.content_pattern, content):
            return False
        return True


@dataclass
class DebugFrame:
    """State captured when a breakpoint fires."""

    frame_id: str
    session_id: str
    breakpoint_id: str
    tool_name: str
    tool_input: dict[str, Any]
    captured_at: float = field(default_factory=time.time)
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    resume_decision: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame_id": self.frame_id,
            "session_id": self.session_id,
            "breakpoint_id": self.breakpoint_id,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "captured_at": self.captured_at,
            "context_snapshot": self.context_snapshot,
        }


@dataclass
class DebuggerSession:
    """A single agent session with its breakpoints and pending frames."""

    session_id: str
    breakpoints: dict[str, Breakpoint] = field(default_factory=dict)
    frames: list[DebugFrame] = field(default_factory=list)
    _waiters: dict[str, asyncio.Event] = field(default_factory=dict)

    def add_breakpoint(self, bp: Breakpoint) -> None:
        self.breakpoints[bp.id] = bp

    def remove_breakpoint(self, bp_id: str) -> bool:
        return self.breakpoints.pop(bp_id, None) is not None

    def list_breakpoints(self) -> list[Breakpoint]:
        return list(self.breakpoints.values())

    def list_frames(self) -> list[DebugFrame]:
        return [f for f in self.frames if f.resume_decision is None]

    def find_match(
        self, tool_name: str, tool_input: dict[str, Any]
    ) -> Breakpoint | None:
        for bp in self.breakpoints.values():
            if bp.matches(tool_name, tool_input):
                return bp
        return None

    async def pause(self, frame: DebugFrame, timeout: float = 300.0) -> dict[str, Any]:
        """Record the frame and block until ``resume`` is called for it."""
        event = asyncio.Event()
        self._waiters[frame.frame_id] = event
        self.frames.append(frame)
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "Debugger resume timeout for frame %s — auto-continuing.",
                frame.frame_id,
            )
            return {"action": "continue", "reason": "timeout"}
        finally:
            self._waiters.pop(frame.frame_id, None)
        return frame.resume_decision or {"action": "continue"}

    def resume(self, frame_id: str, decision: dict[str, Any]) -> bool:
        """Resume a paused frame with a decision (continue / skip / modify)."""
        event = self._waiters.get(frame_id)
        frame = next((f for f in self.frames if f.frame_id == frame_id), None)
        if frame is None or event is None:
            return False
        frame.resume_decision = decision
        event.set()
        return True


class DebuggerRegistry:
    """Process-wide registry of debugger sessions."""

    _instance: DebuggerRegistry | None = None
    _instance_lock: threading.Lock = threading.Lock()

    def __init__(self) -> None:
        self._sessions: dict[str, DebuggerSession] = {}

    @classmethod
    def instance(cls) -> DebuggerRegistry:
        # Double-checked locking — the previous TOCTOU could create two
        # DebuggerRegistry instances under concurrent access, splitting
        # the session dict between them.
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def attach(self, session_id: str) -> DebuggerSession:
        session = self._sessions.get(session_id)
        if session is None:
            session = DebuggerSession(session_id=session_id)
            self._sessions[session_id] = session
        return session

    def detach(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    def get(self, session_id: str) -> DebuggerSession | None:
        return self._sessions.get(session_id)

    def list_sessions(self) -> list[str]:
        return list(self._sessions.keys())


# ---------------------------------------------------------------------------
# SDK hook
# ---------------------------------------------------------------------------


def make_debugger_hook(session_id: str):
    """Return a PreToolUse hook that respects breakpoints for ``session_id``."""

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,  # noqa: ARG001
        context: Any | None = None,  # noqa: ARG001
    ) -> dict[str, Any]:
        session = DebuggerRegistry.instance().get(session_id)
        if session is None:
            return {}

        tool_name = str(input_data.get("tool_name") or "")
        tool_input = input_data.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            return {}

        bp = session.find_match(tool_name, tool_input)
        if bp is None:
            return {}

        frame = DebugFrame(
            frame_id=str(uuid.uuid4()),
            session_id=session_id,
            breakpoint_id=bp.id,
            tool_name=tool_name,
            tool_input=dict(tool_input),
        )
        decision = await session.pause(frame)

        if decision.get("action") == "skip":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": decision.get(
                        "reason", "Skipped by debugger"
                    ),
                }
            }
        if decision.get("action") == "modify":
            modified = decision.get("tool_input")
            if isinstance(modified, dict):
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "modifiedToolInput": modified,
                    }
                }
        return {}

    return _hook
