"""
Abstract Agent Client Interface
================================

Provides a provider-agnostic abstraction layer over agent execution backends.
This enables transparent switching between Claude Agent SDK and GitHub Copilot
without altering the Kanban task processing pipeline.

Architecture:
    AgentClient (ABC)
    ├── ClaudeAgentClient  — wraps claude_agent_sdk.ClaudeSDKClient
    └── CopilotAgentClient — uses GitHub Copilot Models API (OpenAI-compatible)

Usage:
    from core.agent_client import create_agent_client

    client = create_agent_client(
        provider="claude",  # or "copilot"
        project_dir=project_dir,
        spec_dir=spec_dir,
        model=model,
        agent_type="coder",
    )

    async with client:
        await client.query("Implement the feature")
        async for msg in client.receive_response():
            ...
"""

from __future__ import annotations

import logging
import os
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from apps.backend.models_registry import get_pricing

# Common token-optimization trunk shared by every generic (OpenAI-style)
# multi-turn loop: head+tail tool-result truncation and over-budget history
# compaction. The module is importable under both package layouts.
try:
    from core.llm_optimization import compact_messages, truncate_tool_result
except ImportError:  # pragma: no cover - alternate package layout
    from apps.backend.core.llm_optimization import (
        compact_messages,
        truncate_tool_result,
    )

logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    """Read a float tunable from the environment, falling back to ``default``.

    Lets operators widen the Copilot HTTP timeouts for slow/reasoning models
    without editing code (e.g. ``COPILOT_REQUEST_TOTAL_TIMEOUT=900``).
    """
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[CopilotAgentClient] Invalid %s=%r — using %.0f", name, raw, default
        )
        return default


def _parse_retry_after(headers: object, cap_seconds: float) -> float | None:
    """Extract a wait time (seconds) from an HTTP ``Retry-After`` header.

    GitHub Copilot (and most APIs) return ``Retry-After`` on a 429 to say how
    long to wait before retrying. It can be either an integer number of seconds
    or an HTTP-date. We support both, clamp the result to ``[0, cap_seconds]``,
    and return ``None`` when the header is absent or unparseable so the caller
    can fall back to exponential back-off.
    """
    if headers is None:
        return None
    try:
        raw = headers.get("Retry-After") or headers.get("retry-after")
    except AttributeError:
        return None
    if not raw:
        return None
    raw = str(raw).strip()

    # Shape 1: delta in seconds (e.g. "Retry-After: 30").
    try:
        seconds = float(raw)
        return max(0.0, min(seconds, cap_seconds))
    except (TypeError, ValueError):
        pass

    # Shape 2: HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
    try:
        from email.utils import parsedate_to_datetime

        reset_dt = parsedate_to_datetime(raw)
        if reset_dt is None:
            return None
        from datetime import datetime, timezone

        now = datetime.now(reset_dt.tzinfo or timezone.utc)
        seconds = (reset_dt - now).total_seconds()
        return max(0.0, min(seconds, cap_seconds))
    except (TypeError, ValueError, OverflowError):
        return None


# =============================================================================
# Constants
# =============================================================================

CONTENT_TYPE_JSON = "application/json"

# Copilot API enforces a prompt token limit that varies by model.
# These are safe upper bounds (in characters, ≈ 4 chars/token) for the
# history preamble injected on provider switch.  We leave ~20 % headroom
# for the system prompt, tool definitions, and user message.
# Key: Copilot model id as used in the API payload.
_COPILOT_HISTORY_CHAR_LIMIT: dict[str, int] = {
    # 1 M-token models — generous budget
    "gpt-4.1": 2_000_000,
    "gemini-2.5-pro": 2_000_000,
    # 200 k-token models (Claude 4.x, o-series) — 160 k token budget
    "claude-opus-4.8": 640_000,
    "claude-opus-4.7": 640_000,
    "claude-opus-4.6": 640_000,
    "claude-opus-4.5": 640_000,
    "claude-sonnet-4.6": 640_000,
    "claude-sonnet-4.5": 640_000,
    "claude-3.7-sonnet": 640_000,
    "o1": 640_000,
    "o3": 640_000,
    "o3-mini": 640_000,
    "o4-mini": 640_000,
    # GPT-5.x — assume 200 k by default
    "gpt-5.5": 640_000,
    "gpt-5.4": 640_000,
    # 128 k-token models — 100 k token budget
    "gpt-4o": 400_000,
    "gpt-4o-mini": 400_000,
    "gpt-4.1-mini": 400_000,
    "claude-haiku-4.5": 400_000,
    "gemini-2.0-flash": 400_000,
    "o1-mini": 400_000,
}
# Default for unknown Copilot models: 100 k tokens (~400 k chars)
_COPILOT_HISTORY_CHAR_LIMIT_DEFAULT = 400_000

# L'API GitHub Copilot exige la notation pointée pour les modèles Claude
# (ex. "claude-sonnet-4.5"). Les identifiants au format natif Anthropic,
# versionnés par tirets (ex. "claude-sonnet-4-5-20250929", "claude-opus-4-6"),
# sont rejetés avec « 400 model_not_supported ». Cette regex capture la famille
# et la version pour reconstruire la forme pointée attendue par Copilot.
_COPILOT_VERSIONED_MODEL_RE = re.compile(
    r"^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(?:-\d+)?$"
)

# Modèle Copilot de repli largement disponible, utilisé lorsqu'un modèle reste
# rejeté après normalisation (ex. un flagship pas encore servi par le plan
# Copilot de l'utilisateur, comme "claude-opus-4.8").
_COPILOT_DEFAULT_FALLBACK_MODEL = "claude-sonnet-4.5"


def _normalize_copilot_model_id(model: str | None) -> str | None:
    """Convertit un id Claude au format natif Anthropic vers la notation Copilot.

    L'API Copilot utilise la notation pointée (``claude-sonnet-4.5``) alors que
    les tâches peuvent transporter l'id natif Anthropic versionné par tirets
    (``claude-sonnet-4-5-20250929``), que Copilot rejette avec
    ``400 model_not_supported``. La date de version éventuelle est supprimée.

    Les identifiants déjà au bon format (point) ou non-Claude sont renvoyés tels
    quels. Reflète le comportement de ``phase_config._resolve_provider_model``.
    """
    if not model:
        return model
    match = _COPILOT_VERSIONED_MODEL_RE.match(model)
    if match:
        family, major, minor = match.group(1), match.group(2), match.group(3)
        return f"{family}-{major}.{minor}"
    return model


def _copilot_fallback_model(model: str) -> str:
    """Retourne un modèle Copilot de repli quand ``model`` est rejeté (400).

    Tente d'abord la normalisation tirets→point (qui récupère l'intention du
    modèle d'origine) ; si l'id est déjà au format pointé mais reste non
    supporté, bascule vers un modèle Copilot par défaut.
    """
    normalized = _normalize_copilot_model_id(model)
    if normalized and normalized != model:
        return normalized
    return _COPILOT_DEFAULT_FALLBACK_MODEL


# Planner/spec_writer sessions MUST finish by writing their output file
# (implementation_plan.json) via the Write tool. On large brownfield codebases
# the model can burn its whole turn budget on investigation (run_command /
# read_file / list_files) and never write the plan, making the planning phase
# fail with "Did not create plan file". When this many turns (or fewer) remain
# and the Write tool is still unused, we inject a one-time directive forcing the
# model to stop exploring and produce the file now.
_WRITE_NUDGE_TURNS_REMAINING = 8
# Tool names that satisfy the "produced the required output file" condition.
_FILE_WRITE_TOOL_NAMES = ("Write", "write_file")

# Per-request HTTP timeouts for the Copilot chat-completions call. Without an
# explicit timeout a genuinely hung response freezes the whole agent loop
# (the socket stays open, no bytes arrive), which surfaces as a build that is
# "stuck and never restarts" and a frozen frontend.
#
# CRITICAL: these requests are sent with ``stream: False``. A non-streaming
# completion sends NO bytes until the ENTIRE response has been generated, so
# ``sock_read`` measures the full generation time — NOT connection liveness.
# A reasoning model (e.g. Opus 4.8 with "Ultra Think") working over a large
# prompt legitimately produces no bytes for several minutes; a tight 90 s
# ``sock_read`` therefore kills healthy slow turns. The symptom: a turn that
# takes >90 s to generate is aborted, retried ~4× (≈6 min of invisible
# stalls), then the phase loops and repeats — the task "seems blocked".
#
# The values below must accommodate the slowest expected SINGLE-TURN
# generation while still eventually catching a truly dead socket. They are
# env-overridable so operators can widen them further for very slow models.
_COPILOT_REQUEST_TOTAL_TIMEOUT = _env_float("COPILOT_REQUEST_TOTAL_TIMEOUT", 600.0)
_COPILOT_REQUEST_CONNECT_TIMEOUT = _env_float("COPILOT_REQUEST_CONNECT_TIMEOUT", 20.0)
# Silence-between-reads guard. For non-streaming requests this is effectively
# "max time the model may take to produce the whole completion". Kept slightly
# below ``total`` so a stall is attributed to read-silence (clearer logs)
# rather than the overall ceiling.
_COPILOT_REQUEST_SOCK_READ_TIMEOUT = _env_float(
    "COPILOT_REQUEST_SOCK_READ_TIMEOUT", 540.0
)
# A transient CONNECTION error (reset/disconnect/DNS) is cheap to retry — it
# usually fails within seconds — so we retry it several times before failing.
_COPILOT_REQUEST_MAX_RETRIES = 3
# A full-duration TIMEOUT is different: the server held the connection open for
# the entire (now generous) ceiling without completing. Retrying the identical
# payload rarely helps and each retry costs another full ceiling, so cap timeout
# retries to bound the worst-case "stuck" window (2 retries → at most 3 ×
# ceiling before the turn surfaces an error instead of looping invisibly).
_COPILOT_TIMEOUT_MAX_RETRIES = int(_env_float("COPILOT_TIMEOUT_MAX_RETRIES", 2))
# Base back-off (seconds) between retries; grows linearly per attempt.
_COPILOT_REQUEST_RETRY_BACKOFF = 2.0

# HTTP statuses that are TRANSIENT and should be ridden out with a back-off
# retry instead of aborting the turn:
#   * 429 — GitHub Copilot enforces a per-MINUTE request-rate limit that is
#     entirely separate from the token/usage quota. Bursting subtasks (the loop
#     auto-continues every few seconds) can trip it even when plenty of tokens
#     remain — exactly the "I still have tokens but get 429" symptom. The right
#     answer is to wait the short reset window (honouring ``Retry-After`` when
#     present) and retry, NOT to surface an error and burn an attempt.
#   * 500/502/503/529 — momentary server-side hiccups that usually clear on the
#     next request.
_COPILOT_RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 529})
# How many times to retry a transient/rate-limited response before giving up.
# Generous because a per-minute window can need several short waits to clear.
_COPILOT_RATE_LIMIT_MAX_RETRIES = int(_env_float("COPILOT_RATE_LIMIT_MAX_RETRIES", 6))
# Base back-off (seconds) when the server does NOT send a ``Retry-After``
# header; grows exponentially per attempt, capped by the MAX below.
_COPILOT_RATE_LIMIT_BACKOFF = _env_float("COPILOT_RATE_LIMIT_BACKOFF", 5.0)
# Upper bound (seconds) for a single rate-limit back-off wait, whether derived
# from ``Retry-After`` or exponential growth. Keeps the worst-case stall sane.
_COPILOT_RATE_LIMIT_MAX_BACKOFF = _env_float("COPILOT_RATE_LIMIT_MAX_BACKOFF", 60.0)

# Claude served through the OpenAI-compatible Copilot API occasionally returns
# ``finish_reason=tool_calls`` with an EMPTY ``tool_calls`` array — the model
# "intended" to call a tool but no call materialised. We re-prompt ("nudge") and
# retry, which normally recovers on the next turn. This caps the number of
# CONSECUTIVE empty re-samples so a pathological model that never emits a real
# tool call can no longer burn the entire turn budget spinning in place. The
# counter resets to zero as soon as a turn produces actual work (a tool call or
# a genuine stop), so legitimate intermittent empties never trip it.
_COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS = 5

# The Copilot API occasionally returns a 200 response whose ``choices`` array is
# EMPTY — no message, no tool call, nothing. This is almost always a transient
# server-side hiccup (rate limiting, content filtering, a momentary glitch)
# rather than a real "the model is done" signal. Previously a single empty
# response ended the whole session ("(Empty response from Copilot)"), aborting
# the phase mid-cycle. Instead we re-issue the same turn after a short back-off,
# up to this many CONSECUTIVE times, before finally giving up. The counter
# resets to zero as soon as a turn returns a usable response, so isolated
# empties never accumulate toward the cap.
_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES = int(
    _env_float("COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES", 4)
)
# Base back-off (seconds) between empty-response re-samples; grows linearly.
_COPILOT_EMPTY_RESPONSE_BACKOFF = _env_float("COPILOT_EMPTY_RESPONSE_BACKOFF", 2.0)

# =============================================================================
# Message Types for provider-agnostic stream processing
# =============================================================================


class MessageRole(str, Enum):
    """Role of a message in the agent conversation."""

    ASSISTANT = "assistant"
    USER = "user"
    SYSTEM = "system"


class ContentBlockType(str, Enum):
    """Type of content block within a message."""

    TEXT = "text"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    THINKING = "thinking"
    STRUCTURED_OUTPUT = "structured_output"
    RESULT = "result"


@dataclass
class ContentBlock:
    """A single content block within an agent message.

    This normalizes the various block types from different providers
    into a common structure.
    """

    type: ContentBlockType
    text: str | None = None
    # Tool use fields
    tool_name: str | None = None
    tool_id: str | None = None
    tool_input: dict[str, Any] | None = None
    # Tool result fields
    tool_use_id: str | None = None
    is_error: bool = False
    result_content: Any = None
    # Structured output
    structured_output: dict[str, Any] | None = None
    # Result message fields
    subtype: str | None = None


@dataclass
class AgentMessage:
    """A normalized message from the agent stream.

    Wraps messages from any provider (Claude SDK, Copilot API) into
    a common format that process_agent_stream() can handle uniformly.
    """

    role: MessageRole
    content: list[ContentBlock] = field(default_factory=list)
    # Pass through the raw provider message for backward compatibility
    raw: Any = None

    @property
    def type_name(self) -> str:
        """Return a type name compatible with existing SDK message type checks."""
        if self.raw is not None:
            return type(self.raw).__name__
        return f"{self.role.value.capitalize()}Message"


@dataclass
class SubagentDefinition:
    """Provider-agnostic definition of a sub-agent.

    For Claude SDK, this maps to claude_agent_sdk.AgentDefinition.
    For Copilot, this maps to a parallel API session configuration.
    """

    description: str
    prompt: str
    tools: list[str] = field(default_factory=list)
    model: str = "inherit"


# =============================================================================
# Abstract Agent Client
# =============================================================================


class AgentClient(ABC):
    """Abstract interface for an agent execution client.

    Implementations must support:
    - Sending queries to the agent
    - Receiving streamed responses as AgentMessage objects
    - Async context manager protocol for resource lifecycle
    - Declaring sub-agent support capability
    """

    @abstractmethod
    async def query(self, prompt: str) -> None:
        """Send a prompt/query to the agent.

        Args:
            prompt: The user message to send to the agent.
        """
        ...

    @abstractmethod
    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Receive the agent's response as a stream of messages.

        Yields:
            AgentMessage instances normalized from the provider's native format.
        """
        ...

    @abstractmethod
    def supports_subagents(self) -> bool:
        """Whether this client supports native sub-agent execution.

        Returns:
            True if the provider supports parallel sub-agent execution
            (e.g., Claude SDK Task tool), False otherwise.
        """
        ...

    @abstractmethod
    def provider_name(self) -> str:
        """Return the provider identifier (e.g., 'claude', 'copilot')."""
        ...

    async def resume(self, history: list[AgentMessage]) -> None:
        """Preload a conversation history before the next query() call.

        Used when a task was paused (rate-limit, auth, user) and is being
        resumed — possibly under a different provider than the one that
        produced the original transcript. Implementations should preseed
        their internal message buffer (when the SDK exposes one) or stash
        the history for the next query() to prepend it as context.

        Default implementation stores history on `self._resumed_history` and
        relies on subclasses to consult it from `query()`. Override entirely
        when a provider exposes a native `messages=[...]` parameter.

        Args:
            history: Ordered list of past AgentMessage objects to replay
                (oldest first). May contain user, assistant and system
                messages with text/tool_use/tool_result blocks.
        """
        self._resumed_history = history or []
        if history:
            logger.info(
                "[%s] resume queued: %d historical messages will be injected "
                "into the next query as a transcript preamble.",
                self.provider_name(),
                len(history),
            )

    # Async context manager protocol
    async def __aenter__(self):
        return self

    @abstractmethod
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    # ------------------------------------------------------------------
    # Helpers for subclasses implementing resume()
    # ------------------------------------------------------------------
    def _consume_resumed_history_as_system_message(
        self, messages: list[dict[str, Any]]
    ) -> None:
        """If resume(history) was queued, append a system message containing the
        formatted preamble to `messages` (mutates in place) and clear the queue.

        Call this once per request, after `system_prompt` is added and before
        the user message. No-op when no resume() has been called.
        """
        history = getattr(self, "_resumed_history", None)
        if not history:
            return
        preamble = self._format_history_as_preamble(history)
        if preamble:
            messages.append({"role": "system", "content": preamble})
        self._resumed_history = []  # consume

    @staticmethod
    def _format_history_as_preamble(history: list[AgentMessage]) -> str:
        """Render a conversation history as a plain-text preamble.

        Used by subclasses whose SDK doesn't expose a structured messages
        parameter. The output is condensed but lossless enough for the LLM
        to reconstruct context: each message becomes a role-labeled block,
        each tool_use becomes a "called tool X with input ..." line, and
        each tool_result becomes a "got: ..." line.
        """
        if not history:
            return ""

        lines: list[str] = [
            "=== PRIOR CONVERSATION (replayed after provider switch) ===",
            "",
        ]
        for msg in history:
            role = msg.role.value if isinstance(msg.role, Enum) else str(msg.role)
            lines.append(f"[{role}]")
            for block in msg.content:
                if block.type == ContentBlockType.TEXT and block.text:
                    lines.append(block.text)
                elif block.type == ContentBlockType.THINKING and block.text:
                    # Drop thinking by default — it's provider-specific
                    # metadata that doesn't replay well across SDKs.
                    continue
                elif block.type == ContentBlockType.TOOL_USE:
                    tool = block.tool_name or "unknown"
                    inp = block.tool_input or {}
                    lines.append(f"<tool_use name={tool}> {inp!r}")
                elif block.type == ContentBlockType.TOOL_RESULT:
                    res = str(block.result_content or "")[:1000]
                    flag = " [ERROR]" if block.is_error else ""
                    lines.append(f"<tool_result{flag}> {res}")
            lines.append("")
        lines.append("=== END PRIOR CONVERSATION — continue from here ===")
        return "\n".join(lines)


# =============================================================================
# Claude Agent Client — wraps ClaudeSDKClient
# =============================================================================


class ClaudeAgentClient(AgentClient):
    """Agent client backed by Claude Agent SDK (ClaudeSDKClient).

    This is a thin wrapper that adapts ClaudeSDKClient messages into
    the AgentMessage format. For backward compatibility, the raw SDK
    messages are preserved in AgentMessage.raw so that existing
    stream processors (process_sdk_stream) can still inspect them
    with hasattr()/getattr() patterns.
    """

    def __init__(self, sdk_client: Any):
        """
        Args:
            sdk_client: A configured ClaudeSDKClient instance.
        """
        self._client = sdk_client
        # Captured during the last receive_response() iteration so callers
        # on the provider-agnostic path (session.py:_run_agent_client_session)
        # can persist session_id / usage just like the raw SDK path does.
        self.last_result_msg: Any | None = None
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None
        # Optional history queued by resume() for the next query() call.
        self._resumed_history: list[AgentMessage] = []

    async def query(self, prompt: str) -> None:
        # Reset per-query observables so callers always see fresh data.
        self.last_result_msg = None
        self.last_session_id = None
        self.last_usage = None
        # If resume(history) was called, prepend the transcript so the LLM
        # has the same context the previous provider had. Consumed once.
        if self._resumed_history:
            preamble = self._format_history_as_preamble(self._resumed_history)
            self._resumed_history = []  # consume
            prompt = preamble + "\n\n" + prompt
        await self._client.query(prompt)

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Yield AgentMessages wrapping raw SDK messages.

        The raw SDK message is preserved in AgentMessage.raw so that
        existing code using hasattr(msg, 'content') patterns continues
        to work during the migration period.
        """
        async for raw_msg in self._client.receive_response():
            # Snapshot the ResultMessage for post-loop consumers (usage,
            # session_id persistence). This is the only place we can see it
            # on the AgentClient path — without it, the Kanban "Reprendre"
            # button can't find a session_id when the user uses the
            # provider-agnostic factory.
            if type(raw_msg).__name__ == "ResultMessage":
                self.last_result_msg = raw_msg
                self.last_session_id = getattr(raw_msg, "session_id", None)
                _u = getattr(raw_msg, "usage", None)
                if isinstance(_u, dict):
                    self.last_usage = {
                        "input_tokens": _u.get("input_tokens", 0),
                        "output_tokens": _u.get("output_tokens", 0),
                        "cost_usd": getattr(raw_msg, "total_cost_usd", None) or 0.0,
                        "cache_creation_input_tokens": _u.get(
                            "cache_creation_input_tokens", 0
                        ),
                        "cache_read_input_tokens": _u.get("cache_read_input_tokens", 0),
                    }
            yield self._wrap_sdk_message(raw_msg)

    def _wrap_sdk_message(self, raw_msg: Any) -> AgentMessage:
        """Convert a raw Claude SDK message to AgentMessage.

        For backward compatibility, the raw message is attached so that
        existing stream processing code can still access SDK-specific
        attributes (e.g., msg.raw.content, msg.raw.structured_output).
        """
        msg_type = type(raw_msg).__name__

        # Determine role from SDK message type
        if msg_type == "AssistantMessage":
            role = MessageRole.ASSISTANT
        elif msg_type == "UserMessage":
            role = MessageRole.USER
        elif msg_type == "SystemMessage":
            role = MessageRole.SYSTEM
        else:
            # ThinkingBlock, ToolUseBlock, ToolResultBlock, ResultMessage
            # are content-level objects, not message-level. Wrap them
            # as system messages with appropriate content blocks.
            role = MessageRole.SYSTEM

        blocks = self._extract_content_blocks(raw_msg, msg_type)
        return AgentMessage(role=role, content=blocks, raw=raw_msg)

    def _extract_content_blocks(
        self, raw_msg: Any, msg_type: str
    ) -> list[ContentBlock]:
        """Extract ContentBlocks from a raw SDK message."""
        blocks: list[ContentBlock] = []

        # ThinkingBlock
        if msg_type == "ThinkingBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "thinking"
        ):
            thinking_text = getattr(raw_msg, "thinking", "") or getattr(
                raw_msg, "text", ""
            )
            if thinking_text:
                blocks.append(
                    ContentBlock(type=ContentBlockType.THINKING, text=thinking_text)
                )
            return blocks

        # ToolUseBlock (top-level)
        if msg_type == "ToolUseBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "tool_use"
        ):
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name=getattr(raw_msg, "name", ""),
                    tool_id=getattr(raw_msg, "id", "unknown"),
                    tool_input=getattr(raw_msg, "input", {}),
                )
            )
            return blocks

        # ToolResultBlock (top-level)
        if msg_type == "ToolResultBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "tool_result"
        ):
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id=getattr(raw_msg, "tool_use_id", "unknown"),
                    is_error=getattr(raw_msg, "is_error", False),
                    result_content=getattr(raw_msg, "content", ""),
                )
            )
            return blocks

        # ResultMessage
        if msg_type == "ResultMessage" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "result"
        ):
            block = ContentBlock(
                type=ContentBlockType.RESULT,
                subtype=getattr(raw_msg, "subtype", None),
            )
            if hasattr(raw_msg, "structured_output") and raw_msg.structured_output:
                block.structured_output = raw_msg.structured_output
            blocks.append(block)
            return blocks

        # AssistantMessage / UserMessage with .content list
        if hasattr(raw_msg, "content"):
            for item in raw_msg.content:
                item_type = type(item).__name__
                if item_type == "TextBlock" and hasattr(item, "text"):
                    blocks.append(
                        ContentBlock(type=ContentBlockType.TEXT, text=item.text)
                    )
                elif (
                    item_type == "ToolUseBlock"
                    or getattr(item, "type", "") == "tool_use"
                ):
                    blocks.append(
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=getattr(item, "name", ""),
                            tool_id=getattr(item, "id", "unknown"),
                            tool_input=getattr(item, "input", {}),
                        )
                    )
                elif (
                    item_type == "ToolResultBlock"
                    or getattr(item, "type", "") == "tool_result"
                ):
                    result_content = getattr(item, "content", "")
                    if isinstance(result_content, list):
                        result_content = " ".join(
                            str(getattr(c, "text", c)) for c in result_content
                        )
                    blocks.append(
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=getattr(item, "tool_use_id", "unknown"),
                            is_error=getattr(item, "is_error", False),
                            result_content=result_content,
                        )
                    )

        # Structured output on any message
        if hasattr(raw_msg, "structured_output") and raw_msg.structured_output:
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.STRUCTURED_OUTPUT,
                    structured_output=raw_msg.structured_output,
                )
            )

        return blocks

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "claude"

    async def __aenter__(self):
        if hasattr(self._client, "__aenter__"):
            await self._client.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if hasattr(self._client, "__aexit__"):
            await self._client.__aexit__(exc_type, exc_val, exc_tb)

    @property
    def inner(self) -> Any:
        """Access the underlying ClaudeSDKClient for backward-compatible code paths."""
        return self._client


# =============================================================================
# Copilot Agent Client — uses GitHub Copilot Models API
# =============================================================================


class CopilotAgentClient(AgentClient):
    """Agent client backed by GitHub Copilot API.

    Authentication flow (two-step):
    1. Exchange a GitHub OAuth token (ghu_... / ghp_...) for a short-lived
       Copilot session token via:
           GET https://api.github.com/copilot_internal/v2/token
    2. Use that session token as Bearer auth against:
           POST https://api.githubcopilot.com/chat/completions

    The session token expires roughly every 30 minutes and is refreshed
    automatically before each request.

    Required IDE headers (enforced by GitHub, missing → 400/421):
        editor-version, editor-plugin-version, Copilot-Integration-Id,
        openai-intent, user-agent, x-github-api-version

    Sub-agent Strategy:
    When sub-agents are defined, CopilotAgentClient spawns parallel
    asyncio tasks — each making its own chat/completions call with
    the sub-agent's specialized system prompt. Results are collected
    and injected back into the orchestrator's context as tool results.
    """

    # IDE impersonation headers — required by the Copilot API gateway.
    # Omitting any of these causes 400 / 421 errors on Copilot Enterprise.
    # Versions verified against working open-source implementations (2025).
    _IDE_HEADERS = {
        "editor-version": "vscode/1.104.3",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "x-vscode-user-agent-library-version": "electron-fetch",
    }

    def __init__(
        self,
        model: str = "gpt-4o",
        system_prompt: str | None = None,
        allowed_tools: list[str] | None = None,
        agents: dict[str, SubagentDefinition] | None = None,
        cwd: str | None = None,
        max_turns: int = 50,
        github_token: str | None = None,
        agent_type: str = "coder",
    ):
        import os

        self.model = _normalize_copilot_model_id(model) or "gpt-4o"
        self.system_prompt = system_prompt
        self.allowed_tools = allowed_tools or []
        self.agents = agents or {}
        self.cwd = cwd
        self.max_turns = max_turns
        self._agent_type = agent_type
        self.github_token = (
            github_token
            or os.environ.get("GITHUB_TOKEN", "")
            or self._get_github_token_from_cli()
        )

        # Real Copilot chat endpoint (not api.github.com)
        self._api_base = "https://api.githubcopilot.com/chat/completions"
        # Fallback: GitHub Models API (works when org blocks api.githubcopilot.com)
        self._github_models_api_base = (
            "https://models.inference.ai.azure.com/chat/completions"
        )
        # Token-exchange endpoint: GitHub token → short-lived Copilot session token
        self._token_exchange_url = "https://api.github.com/copilot_internal/v2/token"
        # Whether we've fallen back to GitHub Models API
        self._using_github_models = False

        self._messages: list[dict[str, Any]] = []
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None
        self._tool_definitions: list[dict[str, Any]] = []

        # Copilot session token cache (expires ~30 min)
        self._copilot_token: str = ""
        self._copilot_token_expires_at: float = 0.0
        # Usage tracking (Copilot API doesn't expose token counts — subscription-based)
        self.last_usage: dict | None = None

    @staticmethod
    def _get_github_token_from_cli() -> str:
        """Attempt to retrieve a GitHub token via `gh auth token` (GitHub CLI).

        The frontend passes SELECTED_LLM_PROVIDER=copilot but does not inject
        GITHUB_TOKEN into the subprocess environment because Copilot auth is
        managed by the GitHub CLI (`gh`). This fallback calls `gh auth token`
        to obtain the current OAuth token so the Copilot session-token exchange
        can proceed without any manual token configuration.

        Returns an empty string if `gh` is unavailable or not authenticated.
        """
        import os
        import shutil
        import subprocess

        # Prefer GITHUB_CLI_PATH set by the Electron frontend (handles Windows where
        # the subprocess PATH may not include the user's `gh` installation).
        gh_exe = os.environ.get("GITHUB_CLI_PATH") or shutil.which("gh")
        if not gh_exe:
            logger.warning(
                "[CopilotAgentClient] `gh` CLI not found on PATH or GITHUB_CLI_PATH. "
                "Install GitHub CLI and run `gh auth login` to enable Copilot."
            )
            return ""

        try:
            result = subprocess.run(
                [gh_exe, "auth", "token", "--hostname", "github.com"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            token = result.stdout.strip()
            if result.returncode == 0 and token:
                # Check that the token has the 'copilot' scope.
                # gh auth status shows scopes like: Token scopes: 'gist', 'repo', 'copilot'
                # Without the copilot scope the token exchange endpoint returns 404.
                try:
                    status_result = subprocess.run(
                        [gh_exe, "auth", "status", "--hostname", "github.com"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    status_output = (
                        status_result.stdout + status_result.stderr
                    ).lower()
                    if (
                        "token scopes" in status_output
                        and "'copilot'" not in status_output
                    ):
                        logger.warning(
                            "[CopilotAgentClient] GitHub token is missing the 'copilot' scope. "
                            "Run: gh auth refresh -s copilot --hostname github.com"
                        )
                        print(
                            "[CopilotAgentClient] ⚠️  GitHub token missing 'copilot' scope. "
                            "Fix: gh auth refresh -s copilot --hostname github.com",
                            flush=True,
                        )
                except Exception:
                    pass  # scope check is best-effort; proceed anyway

                logger.info(
                    "[CopilotAgentClient] Retrieved GitHub token via `gh auth token`"
                )
                return token
            else:
                stderr = result.stderr.strip()
                logger.warning(
                    "[CopilotAgentClient] `gh auth token` returned no token "
                    "(exit %d, stderr: %s). Run `gh auth login` first.",
                    result.returncode,
                    stderr or "(none)",
                )
                return ""
        except Exception as exc:
            logger.warning(
                "[CopilotAgentClient] Failed to call `gh auth token`: %s", exc
            )
            return ""

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession with shared IDE headers."""
        if self._http_client is None:
            try:
                import aiohttp

                # Explicit timeout so a hung/stalled response is detected and
                # retried instead of freezing the agent loop indefinitely.
                timeout = aiohttp.ClientTimeout(
                    total=_COPILOT_REQUEST_TOTAL_TIMEOUT,
                    sock_connect=_COPILOT_REQUEST_CONNECT_TIMEOUT,
                    sock_read=_COPILOT_REQUEST_SOCK_READ_TIMEOUT,
                )
                # Authorization is injected per-request (token refreshes)
                self._http_client = aiohttp.ClientSession(
                    timeout=timeout,
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                        **self._IDE_HEADERS,
                    },
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for CopilotAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    async def _get_copilot_token(self) -> str:
        """Return a valid Copilot session token, refreshing if needed.

        Two-path authentication:
        1. (Preferred) Exchange a GitHub OAuth token at copilot_internal/v2/token
           for a short-lived session token (~30 min TTL).
        2. (Fallback) Some Copilot Business/Enterprise accounts managed by an
           organisation have the token-exchange endpoint restricted (returns 404).
           In that case the raw GitHub OAuth token (gho_…) is accepted directly
           as a Bearer token by api.githubcopilot.com.  We cache this as the
           "session token" with a 30-minute TTL to match normal behaviour.
        """
        import time

        # Return cached token if still valid (60-second safety buffer)
        if self._copilot_token and time.time() < self._copilot_token_expires_at - 60:
            return self._copilot_token

        import aiohttp

        if not self.github_token:
            raise ValueError(
                "Copilot auth error: No GitHub token available. "
                "Run `gh auth login` and ensure GitHub CLI is installed."
            )

        # Warn if token looks like a classic PAT (ghp_) — these do NOT work with
        # the Copilot internal API. Only OAuth tokens (gho_) are accepted.
        if self.github_token.startswith("ghp_"):
            logger.warning(
                "[CopilotAgentClient] Token appears to be a classic PAT (ghp_). "
                "The Copilot API requires an OAuth token (gho_). "
                "Re-authenticate with: gh auth login --web"
            )
            print(
                "[CopilotAgentClient] ⚠️  Classic PAT detected (ghp_). "
                "Copilot requires OAuth token (gho_). Fix: gh auth login --web",
                flush=True,
            )

        exchange_headers = {
            "Authorization": f"token {self.github_token}",
            "Accept": "application/json",
            "x-github-api-version": "2022-11-28",
            **self._IDE_HEADERS,
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(
                self._token_exchange_url, headers=exchange_headers
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    self._copilot_token = data["token"]
                    # expires_at is a Unix timestamp; default to 30 min if absent
                    self._copilot_token_expires_at = data.get(
                        "expires_at", time.time() + 1800
                    )
                    logger.info(
                        "[CopilotAgentClient] Session token refreshed via exchange"
                    )
                    return self._copilot_token
                elif resp.status == 404:
                    # Copilot Business/Enterprise accounts managed by an organisation
                    # often restrict the internal token-exchange endpoint.  Fall back
                    # to using the raw GitHub OAuth token directly as Bearer auth —
                    # api.githubcopilot.com accepts it for these account types.
                    logger.info(
                        "[CopilotAgentClient] Token exchange endpoint returned 404 "
                        "(organisation-managed Copilot). Using GitHub token directly as Bearer."
                    )
                    print(
                        "[CopilotAgentClient] [INFO] Token exchange not available "
                        "(Copilot Business/Enterprise). Using GitHub token directly.",
                        flush=True,
                    )
                    self._copilot_token = self.github_token
                    self._copilot_token_expires_at = time.time() + 1800
                    return self._copilot_token
                else:
                    error_text = await resp.text()
                    token_hint = ""
                    if self.github_token.startswith("ghp_"):
                        token_hint = (
                            " (Your token is a classic PAT (ghp_) — Copilot requires an OAuth "
                            "token (gho_). Fix: run `gh auth login --web` to re-authenticate.)"
                        )
                    raise ValueError(
                        f"Copilot token exchange failed ({resp.status}): {error_text}{token_hint}"
                    )

    async def resume(self, history: list[AgentMessage]) -> None:
        """Preload conversation history, truncating to Copilot's context window.

        Copilot models have varying prompt-token limits (128 k – 1 M).  When
        switching from a provider with a larger context (e.g. Claude Code at
        200 k+), the accumulated conversation can easily exceed those limits,
        causing a 400 ``model_max_prompt_tokens_exceeded`` error.

        This override drops the *oldest* messages one-by-one until the
        rendered preamble fits within the model's safe character budget.
        """
        if not history:
            await super().resume(history)
            return

        char_limit = _COPILOT_HISTORY_CHAR_LIMIT.get(
            self.model, _COPILOT_HISTORY_CHAR_LIMIT_DEFAULT
        )

        truncated = list(history)
        while len(truncated) > 1:
            preamble = self._format_history_as_preamble(truncated)
            if len(preamble) <= char_limit:
                break
            truncated = truncated[1:]  # drop oldest message

        dropped = len(history) - len(truncated)
        if dropped:
            logger.warning(
                "[CopilotAgentClient] History truncated on provider switch: "
                "dropped %d oldest message(s) to fit within the %s context window "
                "(%d → %d messages, limit ≈ %d chars).",
                dropped,
                self.model,
                len(history),
                len(truncated),
                char_limit,
            )
            print(
                f"[CopilotAgentClient] ⚠️  History truncated: {dropped} old "
                f"message(s) dropped to respect {self.model} context limit.",
                flush=True,
            )

        await super().resume(truncated)

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against the Copilot Models API.

        Implements a full multi-turn tool-use loop:
        1. Send messages + tool definitions to API
        2. If response contains tool_calls → execute each tool locally, add results, continue
        3. If no tool_calls → yield final text response and stop
        4. Repeat up to max_turns
        """
        import json as _json

        if not self._pending_query:
            return

        # Copilot is subscription-based — no token counts in API response.
        # Mark as "recorded" immediately so session.py always logs a Copilot entry.
        self.last_usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}

        prompt = self._pending_query
        self._pending_query = None

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        # Build OpenAI-format tool definitions
        tools = [
            {
                "type": "function",
                "function": {
                    "name": td["name"],
                    "description": td.get("description", ""),
                    "parameters": td.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for td in self._tool_definitions
        ]

        request_headers = {
            "Authorization": "",  # set per-call after token refresh
            "Copilot-Integration-Id": "vscode-chat",
            "openai-intent": "conversation-panel",
            "x-github-api-version": "2025-04-01",
        }

        logger.info(
            f"[CopilotAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, prompt_len={len(prompt)})"
        )
        print(
            f"[CopilotAgentClient] 🤖 Starting Copilot session "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        session = self._get_http_client()

        # Track whether this session must end by writing an output file (planner/
        # spec_writer sessions expose the Write tool) and whether it has done so.
        # Used to inject a budget-aware "write now" nudge before turns run out.
        has_write_tool = any(
            td.get("name") in _FILE_WRITE_TOOL_NAMES for td in self._tool_definitions
        )
        write_tool_used = False
        write_nudge_sent = False
        # Number of CONSECUTIVE turns that returned finish_reason=tool_calls with
        # an empty tool_calls array. Reset whenever a turn does real work.
        consecutive_empty_tool_calls = 0
        # Number of CONSECUTIVE turns whose response contained no usable choices
        # (a transient API hiccup). Reset whenever a turn returns a real choice.
        consecutive_empty_responses = 0
        # Whether we already swapped the model after a 400 "model_not_supported"
        # rejection. Guards against an infinite retry loop if even the fallback
        # model is unavailable on the user's Copilot plan.
        model_fallback_attempted = False

        for turn in range(self.max_turns):
            try:
                copilot_token = await self._get_copilot_token()
            except Exception as e:
                logger.error(f"[CopilotAgentClient] Token refresh failed: {e}")
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT, text=f"Copilot auth error: {e}"
                        )
                    ],
                )
                return

            request_headers["Authorization"] = f"Bearer {copilot_token}"

            # Budget-aware "write now" nudge: when a planner/spec_writer session
            # is about to run out of turns but has never called the Write tool,
            # force it to stop investigating and produce its output file. Without
            # this, large-codebase planning loops exhaust max_turns on read-only
            # exploration and the phase fails with "Did not create plan file".
            if (
                has_write_tool
                and not write_tool_used
                and not write_nudge_sent
                and (self.max_turns - turn) <= _WRITE_NUDGE_TURNS_REMAINING
            ):
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "You are about to run out of turns. STOP investigating "
                            "now — do not run any more exploration commands. "
                            "Immediately call the Write tool to create the required "
                            "output file (implementation_plan.json) in the spec "
                            "directory with the COMPLETE JSON content, based on what "
                            "you already know. This is mandatory: if you do not write "
                            "the file now, the whole task fails."
                        ),
                    }
                )
                write_nudge_sent = True
                logger.warning(
                    "[CopilotAgentClient] Injected write-now nudge "
                    f"(turn {turn + 1}/{self.max_turns}, Write tool still unused)"
                )

            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"

            logger.info(
                f"[CopilotAgentClient] Turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages..."
            )

            # Determine which endpoint to use
            api_url = (
                self._github_models_api_base
                if self._using_github_models
                else self._api_base
            )

            # For GitHub Models API, use the raw GitHub token directly (not the Copilot session token)
            if self._using_github_models:
                request_headers["Authorization"] = f"Bearer {self.github_token}"

            import asyncio as _asyncio

            import aiohttp

            data = None
            # Two independent retry budgets so a burst of rate-limit (429)
            # responses never eats the connection-error budget and vice-versa.
            connection_attempts = 0
            rate_limit_attempts = 0
            while True:
                try:
                    async with session.post(
                        api_url, json=payload, headers=request_headers
                    ) as resp:
                        if resp.status == 403 and not self._using_github_models:
                            # Copilot API blocked (org restriction) — fallback to GitHub Models API
                            error_text = await resp.text()
                            logger.warning(
                                f"[CopilotAgentClient] Copilot API returned 403 — "
                                f"falling back to GitHub Models API at {self._github_models_api_base}"
                            )
                            print(
                                "[CopilotAgentClient] [INFO] Copilot API blocked by org. "
                                "Falling back to GitHub Models API.",
                                flush=True,
                            )
                            self._using_github_models = True
                            request_headers["Authorization"] = (
                                f"Bearer {self.github_token}"
                            )
                            # Retry this turn with the GitHub Models API
                            async with session.post(
                                self._github_models_api_base,
                                json=payload,
                                headers=request_headers,
                            ) as retry_resp:
                                if retry_resp.status != 200:
                                    retry_error = await retry_resp.text()
                                    logger.error(
                                        f"[CopilotAgentClient] GitHub Models API error ({retry_resp.status}): {retry_error[:500]}"
                                    )
                                    yield AgentMessage(
                                        role=MessageRole.SYSTEM,
                                        content=[
                                            ContentBlock(
                                                type=ContentBlockType.TEXT,
                                                text=f"GitHub Models API error ({retry_resp.status}): {retry_error}",
                                            )
                                        ],
                                    )
                                    return
                                data = await retry_resp.json()
                        elif resp.status in _COPILOT_RETRYABLE_STATUSES:
                            # Transient failure (429 rate-limit or 5xx hiccup).
                            # Wait — honouring ``Retry-After`` when the server
                            # sends it, else exponential back-off — and retry
                            # instead of aborting the turn. This is what keeps
                            # subtasks flowing through short Copilot per-minute
                            # rate-limit windows rather than surfacing a 429.
                            error_text = await resp.text()
                            if rate_limit_attempts < _COPILOT_RATE_LIMIT_MAX_RETRIES:
                                rate_limit_attempts += 1
                                retry_after = _parse_retry_after(
                                    resp.headers, _COPILOT_RATE_LIMIT_MAX_BACKOFF
                                )
                                if retry_after is not None:
                                    wait_s = retry_after
                                else:
                                    wait_s = min(
                                        _COPILOT_RATE_LIMIT_BACKOFF
                                        * (2 ** (rate_limit_attempts - 1)),
                                        _COPILOT_RATE_LIMIT_MAX_BACKOFF,
                                    )
                                kind = (
                                    "rate limited"
                                    if resp.status == 429
                                    else f"transient error {resp.status}"
                                )
                                logger.warning(
                                    f"[CopilotAgentClient] {kind} — retry "
                                    f"{rate_limit_attempts}/"
                                    f"{_COPILOT_RATE_LIMIT_MAX_RETRIES} "
                                    f"in {wait_s:.0f}s"
                                )
                                print(
                                    f"[CopilotAgentClient] [WARN] Copilot {kind} "
                                    f"— waiting {wait_s:.0f}s then retrying "
                                    f"({rate_limit_attempts}/"
                                    f"{_COPILOT_RATE_LIMIT_MAX_RETRIES})...",
                                    flush=True,
                                )
                                await _asyncio.sleep(wait_s)
                                continue
                            # Budget exhausted — surface the error as before.
                            logger.error(
                                f"[CopilotAgentClient] API error ({resp.status}) "
                                f"after {rate_limit_attempts} retries: "
                                f"{error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error ({resp.status}): {error_text}",
                                    )
                                ],
                            )
                            return
                        elif (
                            resp.status == 400
                            and not model_fallback_attempted
                            and not self._using_github_models
                        ):
                            # The Copilot API rejected the requested model. This
                            # happens when a task carries an Anthropic-native
                            # versioned id (e.g. "claude-sonnet-4-5") or a
                            # flagship not yet served by the user's Copilot plan
                            # (e.g. "claude-opus-4.8"). Swap to a supported model
                            # and retry the turn instead of failing the phase.
                            error_text = await resp.text()
                            if "model_not_supported" in error_text:
                                fallback = _copilot_fallback_model(self.model)
                                model_fallback_attempted = True
                                logger.warning(
                                    "[CopilotAgentClient] Model "
                                    f"'{self.model}' not supported by Copilot — "
                                    f"falling back to '{fallback}' and retrying."
                                )
                                print(
                                    "[CopilotAgentClient] [WARN] Model "
                                    f"'{self.model}' not supported — switching to "
                                    f"'{fallback}'.",
                                    flush=True,
                                )
                                self.model = fallback
                                payload["model"] = fallback
                                continue
                            # A different 400 (e.g. malformed request) — surface.
                            logger.error(
                                f"[CopilotAgentClient] API error (400): {error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error (400): {error_text}",
                                    )
                                ],
                            )
                            return
                        elif resp.status != 200:
                            error_text = await resp.text()
                            logger.error(
                                f"[CopilotAgentClient] API error ({resp.status}): {error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error ({resp.status}): {error_text}",
                                    )
                                ],
                            )
                            return
                        else:
                            data = await resp.json()
                    break  # request succeeded — leave the retry loop
                except (
                    _asyncio.TimeoutError,
                    aiohttp.ClientError,
                ) as e:
                    # A hung/stalled or transient connection error. Retry before
                    # failing so a single bad response no longer freezes the whole
                    # phase. A full-duration TIMEOUT gets a tighter retry budget
                    # than a (cheap, fast-failing) connection error: each timeout
                    # retry costs another full ceiling, so we cap it to bound the
                    # worst-case "stuck" window.
                    is_timeout = isinstance(e, _asyncio.TimeoutError)
                    max_retries = (
                        _COPILOT_TIMEOUT_MAX_RETRIES
                        if is_timeout
                        else _COPILOT_REQUEST_MAX_RETRIES
                    )
                    if connection_attempts < max_retries:
                        backoff = _COPILOT_REQUEST_RETRY_BACKOFF * (
                            connection_attempts + 1
                        )
                        logger.warning(
                            f"[CopilotAgentClient] Request stalled/failed "
                            f"({type(e).__name__}: {e}) — retry "
                            f"{connection_attempts + 1}/{max_retries} "
                            f"in {backoff:.0f}s"
                        )
                        print(
                            "[CopilotAgentClient] [WARN] Copilot API request "
                            f"stalled — retrying ({connection_attempts + 1}/"
                            f"{max_retries})...",
                            flush=True,
                        )
                        connection_attempts += 1
                        await _asyncio.sleep(backoff)
                        continue
                    logger.error(
                        f"[CopilotAgentClient] Request failed after "
                        f"{connection_attempts + 1} attempt(s): {e}"
                    )
                    yield AgentMessage(
                        role=MessageRole.SYSTEM,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text=f"Copilot API error (timeout/connection): {e}",
                            )
                        ],
                    )
                    return
                except Exception as e:
                    logger.error(f"[CopilotAgentClient] Request failed: {e}")
                    yield AgentMessage(
                        role=MessageRole.SYSTEM,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text=f"Copilot API error: {e}",
                            )
                        ],
                    )
                    return

            if data is None:
                # All retries exhausted without a usable response.
                logger.error("[CopilotAgentClient] No response data after retries")
                return

            choices = data.get("choices", [])
            if not choices:
                # A 200 response with no choices is almost always a transient
                # server-side hiccup, not a genuine "done" signal. Re-issue the
                # same turn after a short back-off instead of killing the whole
                # session on the first empty response. Only give up once the
                # consecutive-empty budget is exhausted.
                consecutive_empty_responses += 1
                if (
                    consecutive_empty_responses
                    <= _COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES
                ):
                    backoff = (
                        _COPILOT_EMPTY_RESPONSE_BACKOFF * consecutive_empty_responses
                    )
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: empty choices in "
                        f"response — retrying "
                        f"({consecutive_empty_responses}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES}) "
                        f"in {backoff:.0f}s"
                    )
                    print(
                        "[CopilotAgentClient] [WARN] Empty response from Copilot "
                        f"— retrying ({consecutive_empty_responses}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES})...",
                        flush=True,
                    )
                    await _asyncio.sleep(backoff)
                    continue  # retry — don't end the session on a transient empty
                logger.error(
                    f"[CopilotAgentClient] {consecutive_empty_responses} consecutive "
                    "empty responses — giving up"
                )
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Copilot)",
                        )
                    ],
                )
                return

            # A usable choice arrived — clear the transient-empty guard counter.
            consecutive_empty_responses = 0

            message = choices[0].get("message", {})
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls", [])
            finish_reason = choices[0].get("finish_reason", "")

            logger.info(
                f"[CopilotAgentClient] Turn {turn + 1}: "
                f"content_len={len(content)}, tool_calls={len(tool_calls)}, "
                f"finish_reason={finish_reason}"
            )

            # Yield text content if present
            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            # No tool calls returned
            if not tool_calls:
                if finish_reason == "tool_calls":
                    # Copilot API returned finish_reason=tool_calls but no actual tool_calls —
                    # this can occur with Claude models via the OpenAI-compatible Copilot API.
                    # Add the partial assistant message and prompt the model to proceed with tools.
                    consecutive_empty_tool_calls += 1
                    if (
                        consecutive_empty_tool_calls
                        > _COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS
                    ):
                        # The model keeps "intending" to call a tool but never
                        # emits one. Stop re-sampling so we don't spin through the
                        # entire turn budget producing no work. End the session
                        # with whatever content we have so the phase can surface a
                        # real failure instead of silently looping.
                        logger.error(
                            f"[CopilotAgentClient] Turn {turn + 1}: "
                            f"{consecutive_empty_tool_calls} consecutive empty "
                            "tool_calls responses — aborting to avoid a spin loop"
                        )
                        yield AgentMessage(
                            role=MessageRole.SYSTEM,
                            content=[
                                ContentBlock(
                                    type=ContentBlockType.TEXT,
                                    text=(
                                        "Copilot API returned no actionable tool "
                                        f"calls for {consecutive_empty_tool_calls} "
                                        "consecutive turns — stopping to avoid an "
                                        "infinite loop."
                                    ),
                                )
                            ],
                        )
                        return
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: finish_reason=tool_calls "
                        "but no tool_calls in response — retrying with nudge "
                        f"({consecutive_empty_tool_calls}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS})"
                    )
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": "Please proceed by calling the appropriate tools to complete your task.",
                        }
                    )
                    continue  # retry — don't return early

                # The model wants to STOP. For planner/spec_writer sessions the
                # output file (implementation_plan.json) is mandatory, yet the
                # model often "finishes" by DESCRIBING the plan in prose without
                # ever calling the Write tool — leaving the planning phase to fail
                # with "Did not create plan file". If Write is required and still
                # unused, refuse the early stop once and force the model to write.
                if (
                    has_write_tool
                    and not write_tool_used
                    and not write_nudge_sent
                    and turn < self.max_turns - 1
                ):
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "You have NOT yet created the required output file. "
                                "Do not stop and do not just describe the plan in "
                                "text. You MUST call the Write tool now to create "
                                "implementation_plan.json in the spec directory with "
                                "the COMPLETE JSON content, based on your "
                                "investigation so far. Call the Write tool now."
                            ),
                        }
                    )
                    write_nudge_sent = True
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: model tried to stop "
                        "without writing the plan — forcing a Write retry"
                    )
                    continue  # retry — don't return early

                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Copilot)",
                            )
                        ],
                    )
                logger.info(
                    f"[CopilotAgentClient] Session complete after {turn + 1} turn(s)"
                )
                return

            # Add assistant message (with tool_calls) to conversation history
            # Real tool calls arrived — the model is making progress, so clear the
            # empty-response guard counter.
            consecutive_empty_tool_calls = 0
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if content:
                assistant_msg["content"] = content
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            # Execute each tool call
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                tool_id = tc.get("id", f"call_{turn}_{tool_name}")

                try:
                    args = _json.loads(func.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    f"[CopilotAgentClient] Turn {turn + 1}: tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[CopilotAgentClient] 🔧 Tool: {tool_name}", flush=True)

                if tool_name in _FILE_WRITE_TOOL_NAMES:
                    write_tool_used = True

                # Yield TOOL_USE block so session handler can log it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=args,
                        )
                    ],
                )

                # Execute tool locally
                result_text = ""
                is_error = False
                if self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                        logger.warning(
                            f"[CopilotAgentClient] Tool {tool_name} failed: {e}"
                        )
                else:
                    result_text = "Tool executor not available"
                    is_error = True

                # Yield TOOL_RESULT block so session handler can log it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Add tool result for next API call (head+tail truncation —
                # build/test verdicts sit at the END of the output)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": truncate_tool_result(result_text),
                    }
                )

            # Elide stale tool results once the conversation exceeds the char
            # budget (no-op below budget, preserving the cacheable prefix).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[CopilotAgentClient] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn sends updated messages with tool results

        logger.warning(
            f"[CopilotAgentClient] Reached max_turns ({self.max_turns}) — stopping tool loop"
        )
        print(
            f"[CopilotAgentClient] ⚠️ Reached max turns ({self.max_turns})", flush=True
        )

    async def run_subagents(
        self,
        agents: dict[str, SubagentDefinition],
        context_prompt: str,
    ) -> dict[str, str]:
        """Run sub-agents in parallel using the Copilot Models API.

        Each sub-agent gets its own API call with its specialized
        system prompt and the shared context. Results are returned
        as a dict mapping agent_name -> response_text.

        Args:
            agents: Dict of agent_name -> SubagentDefinition
            context_prompt: Shared context/prompt for all agents

        Returns:
            Dict mapping agent_name -> agent response text
        """
        import asyncio

        async def _run_one(name: str, defn: SubagentDefinition) -> tuple[str, str]:
            """Run a single sub-agent API call."""
            messages = [
                {"role": "system", "content": defn.prompt},
                {"role": "user", "content": context_prompt},
            ]

            copilot_token = await self._get_copilot_token()
            session = self._get_http_client()
            payload = {
                "model": (
                    _normalize_copilot_model_id(defn.model)
                    if defn.model != "inherit"
                    else self.model
                ),
                "messages": messages,
                "stream": False,
            }
            request_headers = {
                "Authorization": f"Bearer {copilot_token}",
                "Copilot-Integration-Id": "vscode-chat",
                "openai-intent": "conversation-panel",
                "x-github-api-version": "2025-04-01",
            }

            try:
                async with session.post(
                    self._api_base, json=payload, headers=request_headers
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return (name, f"Error ({resp.status}): {error_text}")
                    data = await resp.json()

                choices = data.get("choices", [])
                if choices:
                    return (name, choices[0].get("message", {}).get("content", ""))
                return (name, "")
            except Exception as e:
                logger.error(f"[CopilotSubagent:{name}] Error: {e}")
                return (name, f"Error: {e}")

        # Run all sub-agents in parallel
        tasks = [_run_one(name, defn) for name, defn in agents.items()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        output: dict[str, str] = {}
        for result in results:
            if isinstance(result, Exception):
                logger.error(f"[CopilotSubagent] Task failed: {result}")
                continue
            name, text = result
            output[name] = text

        return output

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "copilot"

    async def __aenter__(self):
        if self.cwd:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(self.cwd)
                self._tool_definitions = get_tool_definitions(self._agent_type)
                logger.info(
                    f"[CopilotAgentClient] Tool execution enabled: "
                    f"{len(self._tool_definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[CopilotAgentClient] Tool executor init failed (text-only mode): {e}"
                )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None


# =============================================================================
# OpenAI Agent Client — direct REST calls to OpenAI API
# =============================================================================


def _openai_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate cost in USD for an OpenAI API call using registry lookup."""
    # Try exact match
    entry = get_pricing("openai", model)
    if entry:
        in_rate = entry.price_input
        out_rate = entry.price_output
        return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000

    # Try prefix match (e.g. "gpt-4o-2024-11-20" → "gpt-4o")
    # This handles dated snapshots by checking if model starts with a known model
    from apps.backend.models_registry import list_provider

    for registry_entry in list_provider("openai"):
        if model.startswith(registry_entry.model_id):
            in_rate = registry_entry.price_input
            out_rate = registry_entry.price_output
            return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000

    return 0.0


class OpenAIAgentClient(AgentClient):
    """Agent client backed by OpenAI API (direct REST calls).

    Requires a valid OpenAI API key (sk-...) from https://platform.openai.com/api-keys.
    Uses /v1/chat/completions with full tool-use loop.
    """

    def __init__(
        self,
        model: str = "gpt-4o",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        reasoning_effort: str | None = None,
        prompt_cache_key: str | None = None,
    ):
        import os as _os

        self.model = model
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self._project_dir = project_dir
        self._agent_type = agent_type
        # Token optimizations (provider-specific layer on the common trunk):
        # reasoning_effort maps the Kanban thinking level to OpenAI reasoning
        # models; prompt_cache_key routes same-task sessions to the same
        # automatic-prompt-cache shard. Both omitted from payload when None.
        self._reasoning_effort = reasoning_effort
        self._prompt_cache_key = prompt_cache_key
        self._api_key: str = _os.environ.get("OPENAI_API_KEY", "")
        self._api_base = "https://api.openai.com/v1/chat/completions"
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None
        self._tool_definitions: list[dict[str, Any]] = []
        # Optional MCP bridge: configured MCP servers (CUSTOM_MCP_SERVERS) are
        # surfaced as extra OpenAI tools so OpenAI/Google/local agents can use
        # them just like the Claude SDK path. Initialised in __aenter__.
        self._mcp_manager: Any = None
        # Usage accumulated across the session's turns
        self.last_usage: dict | None = None

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession."""
        if self._http_client is None:
            try:
                import aiohttp

                self._http_client = aiohttp.ClientSession(
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                    }
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for OpenAIAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    async def __aenter__(self):
        if self._project_dir:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(self._project_dir)
                self._tool_definitions = get_tool_definitions(self._agent_type)
                logger.info(
                    f"[OpenAIAgentClient] Tool execution enabled: "
                    f"{len(self._tool_definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[OpenAIAgentClient] Tool executor init failed (text-only mode): {e}"
                )
        # Bridge configured MCP servers (best-effort) so their tools are exposed
        # alongside the built-in toolset. Never fail client setup on MCP errors.
        try:
            from core.mcp_tools import MCPToolManager, load_mcp_server_configs

            servers = load_mcp_server_configs(self._project_dir)
            if servers:
                manager = MCPToolManager(self._project_dir, servers)
                await manager.connect()
                mcp_defs = manager.tool_definitions()
                if mcp_defs:
                    self._mcp_manager = manager
                    self._tool_definitions = list(self._tool_definitions) + mcp_defs
                    logger.info(
                        f"[OpenAIAgentClient] MCP enabled: {len(mcp_defs)} tool(s) "
                        f"from {len(servers)} server(s)"
                    )
                else:
                    await manager.aclose()
        except Exception as e:  # noqa: BLE001 — MCP must never block client setup
            logger.warning(f"[OpenAIAgentClient] MCP bridge unavailable: {e}")
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._mcp_manager is not None:
            await self._mcp_manager.aclose()
            self._mcp_manager = None
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against the OpenAI API (/v1/chat/completions).

        Requires a valid OpenAI API key (sk-...) from https://platform.openai.com/api-keys.
        Implements a full multi-turn tool-use loop.
        """
        import json as _json

        if not self._pending_query:
            return

        if not self._api_key:
            yield AgentMessage(
                role=MessageRole.SYSTEM,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text="OpenAI auth error: OPENAI_API_KEY not set.",
                    )
                ],
            )
            return

        prompt = self._pending_query
        self._pending_query = None

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        tools = [
            {
                "type": "function",
                "function": {
                    "name": td["name"],
                    "description": td.get("description", ""),
                    "parameters": td.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for td in self._tool_definitions
        ]

        request_headers = {
            "Authorization": f"Bearer {self._api_key}",
        }

        logger.info(
            f"[OpenAIAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, prompt_len={len(prompt)})"
        )
        print(
            f"[OpenAIAgentClient] 🤖 Starting OpenAI session "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        session = self._get_http_client()

        _total_in = 0
        _total_out = 0

        for turn in range(self.max_turns):
            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"
            # Provider-specific token optimizations (omitted when None):
            if self._reasoning_effort:
                payload["reasoning_effort"] = self._reasoning_effort
            if self._prompt_cache_key:
                payload["prompt_cache_key"] = self._prompt_cache_key

            logger.info(
                f"[OpenAIAgentClient] Turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages..."
            )

            try:
                async with session.post(
                    self._api_base, json=payload, headers=request_headers
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        logger.error(
                            f"[OpenAIAgentClient] API error ({resp.status}): {error_text[:500]}"
                        )
                        yield AgentMessage(
                            role=MessageRole.SYSTEM,
                            content=[
                                ContentBlock(
                                    type=ContentBlockType.TEXT,
                                    text=f"OpenAI API error ({resp.status}): {error_text}",
                                )
                            ],
                        )
                        return
                    data = await resp.json()
            except Exception as e:
                logger.error(f"[OpenAIAgentClient] Request failed: {e}")
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=self._describe_request_error(e),
                        )
                    ],
                )
                return

            # Accumulate token usage from each turn
            _u = data.get("usage", {})
            _total_in += _u.get("prompt_tokens", 0)
            _total_out += _u.get("completion_tokens", 0)

            choices = data.get("choices", [])
            if not choices:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from OpenAI)",
                        )
                    ],
                )
                return

            message = choices[0].get("message", {})
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls", [])
            finish_reason = choices[0].get("finish_reason", "")

            logger.info(
                f"[OpenAIAgentClient] Turn {turn + 1}: "
                f"content_len={len(content)}, tool_calls={len(tool_calls)}, "
                f"finish_reason={finish_reason}"
            )

            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            if not tool_calls:
                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from OpenAI)",
                            )
                        ],
                    )
                logger.info(
                    f"[OpenAIAgentClient] Session complete after {turn + 1} turn(s)"
                )
                self.last_usage = {
                    "input_tokens": _total_in,
                    "output_tokens": _total_out,
                    "cost_usd": _openai_cost_usd(self.model, _total_in, _total_out),
                }
                return

            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if content:
                assistant_msg["content"] = content
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                tool_id = tc.get("id", f"call_{turn}_{tool_name}")

                try:
                    args = _json.loads(func.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    f"[OpenAIAgentClient] Turn {turn + 1}: tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[OpenAIAgentClient] 🔧 Tool: {tool_name}", flush=True)

                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=args,
                        )
                    ],
                )

                result_text = ""
                is_error = False
                if self._mcp_manager is not None and self._mcp_manager.has_tool(
                    tool_name
                ):
                    try:
                        result = await self._mcp_manager.call(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"MCP tool error: {e}"
                        is_error = True
                        logger.warning(
                            f"[OpenAIAgentClient] MCP tool {tool_name} failed: {e}"
                        )
                elif self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                        logger.warning(
                            f"[OpenAIAgentClient] Tool {tool_name} failed: {e}"
                        )
                else:
                    result_text = "Tool executor not available"
                    is_error = True

                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": truncate_tool_result(result_text),
                    }
                )

            # Elide stale tool results once the conversation exceeds the char
            # budget (no-op below budget, preserving OpenAI's automatic
            # prefix cache for normal-sized sessions).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[OpenAIAgentClient] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

        logger.warning(
            f"[OpenAIAgentClient] Reached max_turns ({self.max_turns}) — stopping tool loop"
        )
        print(f"[OpenAIAgentClient] ⚠️ Reached max turns ({self.max_turns})", flush=True)
        self.last_usage = {
            "input_tokens": _total_in,
            "output_tokens": _total_out,
            "cost_usd": _openai_cost_usd(self.model, _total_in, _total_out),
        }

    def provider_name(self) -> str:
        return "openai"

    @staticmethod
    def _is_connection_error(exc: Exception) -> bool:
        """True when the request failed to even reach the server (vs an API error).

        Covers aiohttp's ClientConnectorError, raw ConnectionRefusedError, and the
        textual forms seen on Windows ("Cannot connect to host", "refused").
        """
        if isinstance(exc, (ConnectionRefusedError, OSError)):
            return True
        try:
            import aiohttp

            if isinstance(exc, aiohttp.ClientConnectorError):
                return True
        except ImportError:
            pass
        text = str(exc).lower()
        return "cannot connect to host" in text or "refused" in text

    def _describe_request_error(self, exc: Exception) -> str:
        """Human-friendly text for a failed chat request. Overridable per provider."""
        return f"OpenAI API error: {exc}"

    def supports_subagents(self) -> bool:
        return False

    async def run_subagents(
        self,
        agents: dict[str, SubagentDefinition],
        context_prompt: str,
    ) -> dict[str, str]:
        """Not implemented for OpenAI client; returns empty dict."""
        return {}


# =============================================================================
# Google Gemini Agent Client — OpenAI-compatible endpoint
# =============================================================================


class GoogleAgentClient(OpenAIAgentClient):
    """Agent client for Google Gemini via its OpenAI-compatible API.

    Gemini exposes an OpenAI-compatible Chat Completions endpoint
    (https://generativelanguage.googleapis.com/v1beta/openai/), so we reuse the
    proven OpenAI tool-use loop verbatim and only swap three things:
      - the base URL,
      - the API key (GEMINI_API_KEY, falling back to GOOGLE_API_KEY),
      - the default model.

    The OpenAI-only `reasoning_effort` / `prompt_cache_key` payload params are
    not part of Gemini's compatibility layer, so they are forced off here.
    """

    def __init__(
        self,
        model: str = "gemini-2.5-pro",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        reasoning_effort: str | None = None,  # accepted for parity; unused on Gemini
        prompt_cache_key: str | None = None,  # accepted for parity; unused on Gemini
    ):
        import os as _os

        super().__init__(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=project_dir,
            agent_type=agent_type,
            reasoning_effort=None,
            prompt_cache_key=None,
        )
        self._api_key = _os.environ.get("GEMINI_API_KEY") or _os.environ.get(
            "GOOGLE_API_KEY", ""
        )
        self._api_base = (
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        )


# =============================================================================
# Local LLM Agent Client — any OpenAI-compatible local server
# =============================================================================


def _normalize_local_base_url(raw: str | None) -> str:
    """Normalize a local LLM base URL into a full chat-completions endpoint.

    Accepts whatever the user typed (root, ``/v1``, or the full path, with or
    without a trailing slash) and returns ``{root}/v1/chat/completions``.
    Works for any OpenAI-compatible local server — Ollama (11434), LM Studio
    (1234), llama.cpp, vLLM, LocalAI.

    Examples::

        http://localhost:11434              -> http://localhost:11434/v1/chat/completions
        http://localhost:1234/v1            -> http://localhost:1234/v1/chat/completions
        http://localhost:1234/v1/chat/completions (idempotent)
    """
    base = (raw or "").strip().rstrip("/")
    if not base:
        base = "http://localhost:11434"
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base + "/chat/completions"


def _resolve_local_base_url(explicit: str | None) -> str:
    """Resolve the local LLM base URL by priority: explicit arg → env →
    saved provider config → default Ollama localhost. Returns the full
    chat-completions endpoint (already normalized)."""
    import os as _os

    resolved = (
        explicit
        or _os.environ.get("OLLAMA_BASE_URL")
        or _os.environ.get("LOCAL_LLM_BASE_URL")
        or _os.environ.get("LMSTUDIO_BASE_URL")
    )
    if not resolved:
        # Fall back to the saved provider config (~/.work_pilot_ai_llm_providers.json).
        # Lazy import — src.connectors may not be on sys.path in every caller.
        try:
            from src.connectors.llm_config import load_provider_config

            cfg = load_provider_config("ollama") or load_provider_config("local") or {}
            resolved = cfg.get("base_url")
        except Exception:  # noqa: BLE001 — never block client creation on this
            resolved = None
    return _normalize_local_base_url(resolved)


class LocalAgentClient(OpenAIAgentClient):
    """Agent client for any OpenAI-compatible **local** LLM server.

    Reuses the proven OpenAI tool-use loop verbatim and only swaps:
      - the base URL (Ollama / LM Studio / llama.cpp / vLLM / LocalAI),
      - the API key (optional — local servers usually accept any value; a
        placeholder is used so the inherited ``if not self._api_key`` guard
        passes),
      - the default model.

    The OpenAI-only ``reasoning_effort`` / ``prompt_cache_key`` payload params
    are not part of these servers' compatibility layer, so they are forced off.
    """

    def __init__(
        self,
        model: str = "llama3.3",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        base_url: str | None = None,
        reasoning_effort: str | None = None,  # accepted for parity; unused locally
        prompt_cache_key: str | None = None,  # accepted for parity; unused locally
    ):
        import os as _os

        super().__init__(
            model=model or "llama3.3",
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=project_dir,
            agent_type=agent_type,
            reasoning_effort=None,
            prompt_cache_key=None,
        )
        # Optional key — local servers don't need one. Placeholder keeps the
        # inherited missing-key guard from aborting; "Bearer local" is harmless.
        self._api_key = (
            _os.environ.get("OLLAMA_API_KEY")
            or _os.environ.get("LOCAL_LLM_API_KEY")
            or _os.environ.get("LMSTUDIO_API_KEY")
            or "local"
        )
        self._api_base = _resolve_local_base_url(base_url)
        # A large local model in non-streaming mode can legitimately take
        # minutes to produce a full completion; the aiohttp default (5 min)
        # would cut healthy slow turns. Generous, env-overridable ceiling.
        self._request_timeout = _env_float("LOCAL_LLM_REQUEST_TIMEOUT", 600.0)

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession with a generous local timeout."""
        if self._http_client is None:
            try:
                import aiohttp

                timeout = aiohttp.ClientTimeout(
                    total=self._request_timeout, sock_connect=20.0
                )
                self._http_client = aiohttp.ClientSession(
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                    },
                    timeout=timeout,
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for LocalAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    def provider_name(self) -> str:
        return "ollama"

    async def resume(self, history: list[AgentMessage]) -> None:
        """Truncate a replayed transcript to fit the local context window.

        Local servers load models with a modest context (``num_ctx``; the managed
        launcher raises the floor to 8192). Replaying a long transcript — e.g.
        150+ messages after switching from Claude mid-task — overflows it and the
        request fails with ``exceeds the available context size``. Drop the oldest
        messages until the rendered preamble fits a conservative budget derived
        from ``OLLAMA_CONTEXT_LENGTH``. Mirrors ``CopilotAgentClient.resume``.
        """
        if not history:
            await super().resume(history)
            return

        import os as _os

        try:
            ctx_tokens = int(_os.environ.get("OLLAMA_CONTEXT_LENGTH", "8192"))
        except (TypeError, ValueError):
            ctx_tokens = 8192
        # Spend ~55 % of the window on replayed history; reserve the rest for the
        # system prompt, tool definitions, the current turn and the reply.
        # ~3 chars/token is a safe average for mixed code + prose.
        char_limit = max(512, int(ctx_tokens * 0.55)) * 3

        truncated = list(history)
        while len(truncated) > 1:
            if len(self._format_history_as_preamble(truncated)) <= char_limit:
                break
            truncated = truncated[1:]  # drop oldest

        dropped = len(history) - len(truncated)
        if dropped:
            logger.warning(
                "[LocalAgentClient] History truncated on provider switch: dropped "
                "%d oldest message(s) to fit the local context window "
                "(~%d tokens, %d → %d messages).",
                dropped,
                ctx_tokens,
                len(history),
                len(truncated),
            )
            print(
                f"[LocalAgentClient] ⚠️  Historique tronqué : {dropped} ancien(s) "
                f"message(s) retiré(s) pour tenir dans le contexte local "
                f"(~{ctx_tokens} tokens).",
                flush=True,
            )

        await super().resume(truncated)

    def _native_chat_url(self) -> str:
        """Ollama's native chat endpoint (root of the OpenAI-compatible base)."""
        root = self._api_base.split("/v1/")[0] or self._api_base
        return f"{root.rstrip('/')}/api/chat"

    def _num_ctx(self) -> int:
        """Context window to request, raised well above Ollama's 4096 default."""
        import os as _os

        try:
            return max(2048, int(_os.environ.get("OLLAMA_CONTEXT_LENGTH", "8192")))
        except (TypeError, ValueError):
            return 8192

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Run the tool-use loop against Ollama's NATIVE ``/api/chat`` endpoint.

        Why not the inherited OpenAI loop: Ollama's OpenAI-compatible endpoint
        ignores ``num_ctx``, so models load with a 4096-token window and large
        agent prompts fail with "exceeds the available context size". The native
        API accepts ``options.num_ctx`` per request — the only way to set context
        that works for ANY server (system or app-managed) and any model name
        (including ``hf.co/org/model``), with no model re-creation or restart.

        Message/tool shapes stay native throughout (tool-call arguments are
        objects, tool results use ``role: "tool"``), so multi-turn tool calling
        round-trips correctly.
        """
        import json as _json

        if not self._pending_query:
            return

        prompt = self._pending_query
        self._pending_query = None

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        # Tool definitions use the same {type:function, function:{…}} shape the
        # native API accepts.
        tools = [
            {
                "type": "function",
                "function": {
                    "name": td["name"],
                    "description": td.get("description", ""),
                    "parameters": td.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for td in self._tool_definitions
        ]

        url = self._native_chat_url()
        num_ctx = self._num_ctx()
        session = self._get_http_client()
        _total_in = 0
        _total_out = 0

        logger.info(
            f"[LocalAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, num_ctx={num_ctx})"
        )
        print(
            f"[LocalAgentClient] 🤖 Starting Ollama session "
            f"(model={self.model}, {len(tools)} tools, num_ctx={num_ctx})",
            flush=True,
        )

        for turn in range(self.max_turns):
            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "options": {"num_ctx": num_ctx},
            }
            if tools:
                payload["tools"] = tools

            try:
                async with session.post(url, json=payload) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        logger.error(
                            f"[LocalAgentClient] API error ({resp.status}): "
                            f"{error_text[:500]}"
                        )
                        yield AgentMessage(
                            role=MessageRole.SYSTEM,
                            content=[
                                ContentBlock(
                                    type=ContentBlockType.TEXT,
                                    text=f"Ollama API error ({resp.status}): {error_text}",
                                )
                            ],
                        )
                        return
                    data = await resp.json()
            except Exception as e:
                logger.error(f"[LocalAgentClient] Request failed: {e}")
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=self._describe_request_error(e),
                        )
                    ],
                )
                return

            _total_in += int(data.get("prompt_eval_count", 0) or 0)
            _total_out += int(data.get("eval_count", 0) or 0)

            message = data.get("message") or {}
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls") or []

            logger.info(
                f"[LocalAgentClient] Turn {turn + 1}: content_len={len(content)}, "
                f"tool_calls={len(tool_calls)}"
            )

            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            if not tool_calls:
                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Ollama)",
                            )
                        ],
                    )
                self.last_usage = {
                    "input_tokens": _total_in,
                    "output_tokens": _total_out,
                    "cost_usd": 0.0,
                }
                return

            # Keep the assistant turn (native shape) in history for context.
            messages.append(
                {"role": "assistant", "content": content, "tool_calls": tool_calls}
            )

            for i, tc in enumerate(tool_calls):
                func = tc.get("function", {}) or {}
                tool_name = func.get("name", "")
                # Native arguments are already an object; tolerate a string too.
                raw_args = func.get("arguments", {})
                if isinstance(raw_args, str):
                    try:
                        args = _json.loads(raw_args or "{}")
                    except (_json.JSONDecodeError, TypeError):
                        args = {}
                else:
                    args = raw_args or {}
                tool_id = tc.get("id") or f"call_{turn}_{i}_{tool_name}"

                logger.info(
                    f"[LocalAgentClient] Turn {turn + 1}: "
                    f"tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[LocalAgentClient] 🔧 Tool: {tool_name}", flush=True)

                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=args,
                        )
                    ],
                )

                result_text = ""
                is_error = False
                if self._mcp_manager is not None and self._mcp_manager.has_tool(
                    tool_name
                ):
                    try:
                        result = await self._mcp_manager.call(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"MCP tool error: {e}"
                        is_error = True
                elif self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                else:
                    result_text = "Tool executor not available"
                    is_error = True

                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Native tool result message.
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": tool_name,
                        "content": truncate_tool_result(result_text),
                    }
                )

            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[LocalAgentClient] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

        logger.warning(
            f"[LocalAgentClient] Reached max_turns ({self.max_turns}) — stopping"
        )
        self.last_usage = {
            "input_tokens": _total_in,
            "output_tokens": _total_out,
            "cost_usd": 0.0,
        }

    def _describe_request_error(self, exc: Exception) -> str:
        """Turn a raw connection failure into an actionable, localized hint.

        A local server that isn't running surfaces as a cryptic aiohttp
        "Cannot connect to host …" line. For a local LLM that almost always
        means the daemon isn't started, so we say exactly that and how to fix it.
        """
        if self._is_connection_error(exc):
            # Show the server root (strip the /v1/chat/completions suffix).
            root = self._api_base.split("/v1/")[0] or self._api_base
            return (
                f"⚠️ Ollama ne répond pas sur {root} — le serveur local n'est pas "
                "démarré. Ouvrez les réglages du fournisseur « Ollama (Local) » et "
                "cliquez « Télécharger & démarrer » (installation et lancement "
                "automatiques), ou lancez « ollama serve » manuellement."
            )
        return f"Erreur API LLM local: {exc}"


# =============================================================================
# Windsurf Agent Client — dual-mode (gRPC proxy + REST fallback)
# =============================================================================


class WindsurfAgentClient(AgentClient):
    """Agent client backed by Windsurf/Codeium with dual-mode support.

    Mode 1 (gRPC, for sk-ws-* IDE keys): gRPC to local Windsurf IDE language server.
        Routes through the running Windsurf IDE → Codeium cloud.
        Consumes Windsurf credits.  Tool execution via text-based tool calling
        (tool definitions in system prompt, ``<tool_call>`` XML tags parsed
        from model output).
        Requires Windsurf IDE to be running and authenticated.

    Mode 2 (REST, for SSO/enterprise/API keys): OpenAI-compatible REST API.
        Uses stored API key, SSO token, or OAuth token.
        Supports full agentic tool execution via OpenAI function calling.
        API key sourced from: env vars → state.vscdb → running IDE process.

    Authentication:
    - gRPC mode: CSRF token + API key from running language server process
    - REST mode: Bearer token from WINDSURF_API_KEY, state.vscdb, or IDE credentials
    """

    # Anthropic model names → Windsurf-compatible model names
    _MODEL_NAME_MAP: dict[str, str] = {
        # Anthropic SDK format → Windsurf format
        "claude-sonnet-4-5-20250929": "claude-4.5-sonnet",
        "claude-sonnet-4-20250514": "claude-4-sonnet",
        "claude-opus-4-20250514": "claude-4-opus",
        "claude-3-7-sonnet-20250219": "claude-3.7-sonnet",
        "claude-3-5-sonnet-20241022": "claude-3.5-sonnet",
        "claude-3-5-sonnet-20240620": "claude-3.5-sonnet",
        "claude-3-5-haiku-20241022": "claude-3.5-haiku",
        "claude-3-opus-20240229": "claude-3-opus",
        "claude-3-sonnet-20240229": "claude-3-sonnet",
        "claude-3-haiku-20240307": "claude-3-haiku",
        # Common aliases
        "claude-sonnet-4": "claude-4-sonnet",
        "claude-opus-4": "claude-4-opus",
        "claude-sonnet-4.5": "claude-4.5-sonnet",
        "claude-opus-4.5": "claude-4.5-opus",
        "claude-sonnet-4.6": "claude-4.6-sonnet",
        "claude-opus-4.6": "claude-4.6-opus",
    }

    def __init__(
        self,
        model: str = "claude-4-sonnet",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
    ):
        import os as _os

        # Normalize model name to Windsurf-compatible format
        original_model = model
        self.model = self._MODEL_NAME_MAP.get(model, model)
        if self.model != original_model:
            logger.info(
                f"[WindsurfAgent] Model name normalized: '{original_model}' → '{self.model}'"
            )

        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self._project_dir = project_dir
        self._agent_type = agent_type
        self._credentials: Any = None  # WindsurfCredentials (Mode 1)
        self._use_local_grpc = False
        self._api_key: str | None = None  # For Mode 2
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None  # ToolExecutor instance
        self._tool_definitions: list[dict[str, Any]] = []
        # Usage accumulated across REST turns (gRPC mode: credits only, no token count)
        self.last_usage: dict | None = None
        # Ordered list of base URLs to try.  `server.codeium.com` is the
        # documented base for analytics/billing, but chat completions may live
        # elsewhere — or may not be exposed at all for sk-ws-* keys.
        # An explicit WINDSURF_BASE_URL env-var overrides the probing list.
        env_url = _os.environ.get("WINDSURF_BASE_URL")
        if env_url:
            self._rest_base_urls: list[str] = [env_url]
        else:
            self._rest_base_urls = [
                "https://windsurf.com/api/v1",
                "https://api.codeium.com/v1",
                "https://server.codeium.com/api/v1",
            ]
        self._rest_base_url = self._rest_base_urls[0]
        self._rest_url_probed = False  # True once we've found a working URL

    async def __aenter__(self):
        import os as _os

        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            get_api_key,
            is_windsurf_running,
        )

        # =====================================================================
        # Step 1: Discover API key from all sources
        # =====================================================================
        # For agentic sessions (project_dir set), we ALWAYS prefer REST mode
        # because it supports OpenAI function calling (tool execution loop).
        # gRPC mode is text-only and cannot do tool execution.

        # 1a. Check environment variables first
        self._api_key = (
            _os.environ.get("WINDSURF_API_KEY")
            or _os.environ.get("WINDSURF_OAUTH_TOKEN")
            or _os.environ.get("CODEIUM_API_KEY")
        )
        if self._api_key:
            logger.info("[WindsurfAgent] Found API key from environment variable")

        # 1b. Try reading from Windsurf's local state.vscdb (SSO/enterprise tokens)
        if not self._api_key:
            try:
                self._api_key = get_api_key()
                logger.info("[WindsurfAgent] Found API key/SSO token from state.vscdb")
            except Exception as e:
                logger.debug(f"[WindsurfAgent] state.vscdb key lookup failed: {e}")

        # 1c. For sk-ws-* keys from env var, check if state.vscdb has a fresher key.
        # After a Windsurf re-login, state.vscdb is updated with the new key but the
        # env var still carries the stale key injected from saved frontend settings.
        # state.vscdb always reflects the current login session, so prefer it.
        if self._api_key and self._api_key.startswith("sk-ws-"):
            try:
                from integrations.windsurf_proxy.auth import _get_api_key_from_state_db

                db_key = _get_api_key_from_state_db()
                if db_key and db_key != self._api_key:
                    logger.info(
                        "[WindsurfAgent] state.vscdb has a different key than env var "
                        "(user likely re-logged into Windsurf) — preferring state.vscdb key"
                    )
                    self._api_key = db_key
            except Exception as e:
                logger.debug(f"[WindsurfAgent] state.vscdb freshness check failed: {e}")

        # 1c. If Windsurf IDE is running, extract API key from its credentials
        if not self._api_key and is_windsurf_running():
            try:
                creds = discover_credentials()
                self._api_key = creds.api_key
                logger.info(
                    "[WindsurfAgent] Extracted API key from running Windsurf IDE"
                )
            except Exception as e:
                logger.warning(f"[WindsurfAgent] Failed to extract key from IDE: {e}")

        # =====================================================================
        # Step 2: Choose mode based on API key type and IDE availability
        # =====================================================================
        # sk-ws-* keys → gRPC through local Windsurf IDE (consumes credits)
        # Other keys (SSO/enterprise) → REST API with function calling
        # No key but IDE running → gRPC through local IDE

        is_ide_key = bool(self._api_key and self._api_key.startswith("sk-ws-"))

        # Check if REST mode is forced via environment variable
        # NOTE: sk-ws-* keys are designed for gRPC only and should ignore WINDSURF_FORCE_REST
        force_rest = _os.environ.get("WINDSURF_FORCE_REST", "").lower() in (
            "1",
            "true",
            "yes",
        )

        # sk-ws-* keys ALWAYS use gRPC mode (ignore WINDSURF_FORCE_REST)
        # These keys are specifically designed for Windsurf IDE gRPC communication
        if is_ide_key:
            # sk-ws-* keys only work through the local Windsurf IDE language
            # server (gRPC).  They do NOT work with any REST chat completions
            # endpoint.  Tool execution is handled via text-based tool calling.
            if is_windsurf_running():
                try:
                    self._credentials = discover_credentials()
                    self._use_local_grpc = True
                    logger.info(
                        f"[WindsurfAgent] Mode 1 (gRPC): sk-ws-* key → routing "
                        f"through local Windsurf IDE at localhost:{self._credentials.port} "
                        f"(model={self.model}, consumes Windsurf credits, "
                        f"text-based tool execution)"
                    )
                    print(
                        "[WindsurfAgent] Using Windsurf IDE (gRPC) — credits will be consumed",
                        flush=True,
                    )
                except Exception as e:
                    raise RuntimeError(
                        f"Windsurf: sk-ws-* key detected but gRPC credential "
                        f"discovery failed: {e}.\n"
                        "Please ensure Windsurf IDE is running and accessible."
                    )
            else:
                raise RuntimeError(
                    "Windsurf: sk-ws-* key detected but Windsurf IDE is not running.\n"
                    "sk-ws-* keys only work through the local Windsurf IDE.\n"
                    "Please start Windsurf IDE to use your Windsurf credits."
                )
        elif self._api_key:
            # Non-IDE key (SSO/enterprise/OAuth token).
            # PREFER REST mode for OAuth tokens - it supports full tool execution via
            # OpenAI function calling and doesn't require Windsurf IDE to be running.
            # Only fall back to gRPC if REST fails or if explicitly configured.

            # Debug logging (sanitized: do not log API key contents/metadata)
            logger.info("[WindsurfAgent] API key found")
            logger.info(
                f"[WindsurfAgent] Windsurf IDE running: {is_windsurf_running()}"
            )

            # Check if this is an OAuth token (starts with specific prefixes or is long)
            is_oauth_token = (
                self._api_key.startswith("oauth_")
                or self._api_key.startswith("sso_")
                or len(self._api_key) > 100  # OAuth tokens are typically long
            )

            logger.info("[WindsurfAgent] OAuth token detection completed")

            if is_oauth_token:
                # OAuth token → prefer REST mode for reliability
                self._use_local_grpc = False
                logger.info(
                    "[WindsurfAgent] Mode 2 (REST): OAuth token detected → using REST API "
                    "with function calling (model=%s)",
                    self.model,
                )
                print(
                    "[WindsurfAgent] Using REST API (OAuth token) - full tool execution support",
                    flush=True,
                )
            elif is_windsurf_running():
                # Non-OAuth token (SSO/enterprise) + IDE running → try gRPC first
                try:
                    self._credentials = discover_credentials()
                    self._use_local_grpc = True
                    logger.info(
                        f"[WindsurfAgent] Mode 1 (gRPC): SSO/enterprise token + IDE running → "
                        f"routing through local language server at localhost:{self._credentials.port} "
                        f"(model={self.model})"
                    )
                    print(
                        "[WindsurfAgent] Using Windsurf IDE gRPC (SSO/enterprise token, IDE running)",
                        flush=True,
                    )
                except Exception as e:
                    # gRPC discovery failed — fall back to REST with a warning
                    logger.warning(
                        f"[WindsurfAgent] gRPC discovery failed ({e}), falling back to REST"
                    )
                    self._use_local_grpc = False
                    logger.info(
                        "[WindsurfAgent] Mode 2 (REST): %s (model=%s)",
                        self._rest_base_url,
                        self.model,
                    )
                    print(
                        "[WindsurfAgent] ⚠️ gRPC failed, falling back to REST API",
                        flush=True,
                    )
            else:
                # No IDE running — try REST (may not work if no enterprise endpoint configured)
                self._use_local_grpc = False
                logger.warning(
                    "[WindsurfAgent] Mode 2 (REST): Windsurf IDE not running. "
                    "REST chat endpoints may return 404. "
                    "Start Windsurf IDE or set WINDSURF_BASE_URL to a valid enterprise endpoint."
                )
                print(
                    "[WindsurfAgent] ⚠️ Windsurf IDE not running — REST mode may fail. "
                    "Start Windsurf IDE for reliable operation.",
                    flush=True,
                )
        elif is_windsurf_running():
            # No key in env but IDE running: gRPC mode
            try:
                self._credentials = discover_credentials()
                self._use_local_grpc = True
                logger.info(
                    f"[WindsurfAgent] Mode 1 (gRPC): no explicit key, using "
                    f"local Windsurf IDE at localhost:{self._credentials.port} "
                    f"(model={self.model}, text-based tool execution)"
                )
            except Exception as e:
                raise RuntimeError(
                    f"Windsurf: no API key found and gRPC discovery failed: {e}.\n"
                    "Please set WINDSURF_API_KEY or start Windsurf IDE."
                )
        else:
            raise RuntimeError(
                "Windsurf: no API key found (checked env vars, state.vscdb, running IDE).\n"
                "Please either:\n"
                "  1. Start Windsurf IDE (for sk-ws-* key via gRPC), or\n"
                "  2. Set WINDSURF_API_KEY environment variable, or\n"
                "  3. Set WINDSURF_OAUTH_TOKEN or CODEIUM_API_KEY env var."
            )

        # =====================================================================
        # Step 3: Initialize tool execution support (both gRPC and REST)
        # =====================================================================
        # gRPC mode uses text-based tool calling (tool definitions in prompt,
        # tool calls parsed from text output).
        # REST mode uses OpenAI function calling (native tool_calls).
        if self._project_dir:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(self._project_dir)
                self._tool_definitions = get_tool_definitions(self._agent_type)
                mode_label = (
                    "gRPC text-based"
                    if self._use_local_grpc
                    else "REST function calling"
                )
                logger.info(
                    f"[WindsurfAgent] Tool execution enabled ({mode_label}): "
                    f"{len(self._tool_definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[WindsurfAgent] Tool executor init failed (text-only mode): {e}"
                )

        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against Windsurf.

        Routes to gRPC (Mode 1) or REST (Mode 2) based on connection state.
        REST mode uses a full tool execution loop with OpenAI function calling.
        """
        if not self._pending_query:
            return

        prompt = self._pending_query
        self._pending_query = None

        if self._use_local_grpc:
            if self._tool_executor and self._tool_definitions:
                async for msg in self._grpc_response_with_tools(prompt):
                    yield msg
            else:
                yield await self._grpc_response(prompt)
        else:
            async for msg in self._rest_response_with_tools(prompt):
                yield msg

    # =================================================================
    # gRPC mode (text-based tool calling through local Windsurf IDE)
    # =================================================================

    async def _grpc_response(self, prompt: str) -> AgentMessage:
        """Send prompt via gRPC to local Windsurf language server (no tools)."""
        from integrations.windsurf_proxy import grpc_client as _grpc_mod
        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            invalidate_process_cache,
        )
        from integrations.windsurf_proxy.cascade_client import cascade_chat
        from integrations.windsurf_proxy.grpc_client import stream_chat
        from integrations.windsurf_proxy.models import requires_cascade, resolve_model

        model_enum, model_name = resolve_model(self.model)
        use_cascade = requires_cascade(self.model)
        messages = []

        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        last_error: Exception | None = None
        text_parts: list[str] = []
        for attempt in range(2):
            if attempt > 0:
                # Refresh credentials to get a fresh CSRF token and re-init panel.
                # IMPORTANT: invalidate the process-info cache first — without this,
                # discover_credentials() returns the same stale CSRF token (10s TTL).
                logger.warning(
                    "[WindsurfAgent] Refreshing credentials before retry (attempt 2)"
                )
                _grpc_mod._panel_initialized = False
                invalidate_process_cache()
                # Brief pause: lets Windsurf's internal session recover before we re-init.
                import asyncio as _asyncio

                await _asyncio.sleep(1.5)
                try:
                    self._credentials = discover_credentials()
                except Exception as refresh_err:
                    logger.error(
                        f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                    )
                    break

            text_parts = []
            try:
                if use_cascade:
                    full = await cascade_chat(
                        credentials=self._credentials,
                        messages=messages,
                        model_enum=model_enum,
                        model_uid=model_name,
                    )
                    if full:
                        text_parts.append(full)
                else:
                    async for chunk in stream_chat(
                        credentials=self._credentials,
                        messages=messages,
                        model_enum=model_enum,
                        model_name=model_name,
                        system_prompt=self.system_prompt,
                    ):
                        text_parts.append(chunk)
                last_error = None
            except Exception as e:
                last_error = e
                err_str = str(e).lower()
                if attempt == 0 and (
                    "failed_precondition" in err_str or "cascade session" in err_str
                ):
                    logger.warning(
                        f"[WindsurfAgent] Cascade session error (exception), retrying: {e}"
                    )
                    _grpc_mod._panel_initialized = False
                    continue
                logger.error(f"[WindsurfAgent] gRPC streaming error: {e}")
                break

            # Windsurf sometimes streams the error as text (HTTP 200) with no real content.
            # Detect this: if the full response is only the error message, retry.
            full_text = "".join(text_parts)
            if (
                "failed_precondition" in full_text.lower()
                and "cascade session" in full_text.lower()
                and attempt == 0
            ):
                logger.warning(
                    "[WindsurfAgent] Cascade session error in response text, retrying with fresh credentials"
                )
                _grpc_mod._panel_initialized = False
                invalidate_process_cache()
                import asyncio as _asyncio

                await _asyncio.sleep(1.5)
                try:
                    self._credentials = discover_credentials()
                except Exception as refresh_err:
                    logger.error(
                        f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                    )
                    break
                continue

            break  # success or non-retryable error

        if last_error is not None:
            return AgentMessage(
                role=MessageRole.SYSTEM,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text=f"Windsurf gRPC error: {last_error}",
                    )
                ],
            )

        full_text = "".join(text_parts)
        if not full_text:
            full_text = "(Empty response from Windsurf)"

        return AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=full_text)],
        )

    def _build_tool_prompt_text(self) -> str:
        """Format tool definitions as text for the gRPC system prompt.

        In gRPC mode the model doesn't have native function calling, so we
        describe the tools in the system prompt and ask it to emit structured
        ``<tool_call>`` XML tags that we parse client-side.
        """
        if not self._tool_definitions:
            return ""

        lines = [
            "\n\n## Available Tools",
            "",
            "You can use the following tools. To call a tool, output a "
            "`<tool_call>` XML tag containing a JSON object with `name` and "
            "`arguments` keys:",
            "",
            "```",
            "<tool_call>",
            '{"name": "tool_name", "arguments": {"param": "value"}}',
            "</tool_call>",
            "```",
            "",
            "You may make multiple tool calls in a single response. After each "
            "tool call I will provide the result in `<tool_result>` tags. "
            "Continue working based on the results.",
            "",
            "When you are finished and have no more tool calls, provide your "
            "final answer WITHOUT any `<tool_call>` tags.",
            "",
            "### Tool Definitions",
            "",
        ]

        for td in self._tool_definitions:
            name = td["name"]
            desc = td.get("description", "")
            params = td.get("parameters", {})
            props = params.get("properties", {})
            required = params.get("required", [])

            lines.append(f"**{name}** — {desc}")
            if props:
                for pname, pinfo in props.items():
                    req_marker = " (required)" if pname in required else ""
                    pdesc = pinfo.get("description", "")
                    ptype = pinfo.get("type", "string")
                    lines.append(f"  - `{pname}` ({ptype}{req_marker}): {pdesc}")
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _parse_tool_calls_from_text(text: str) -> tuple[str, list[dict[str, Any]]]:
        """Parse ``<tool_call>`` blocks from model text output.

        Returns:
            (clean_text, tool_calls) where *clean_text* is the response with
            ``<tool_call>`` blocks removed and *tool_calls* is a list of dicts
            with ``name`` and ``arguments`` keys.
        """
        import json as _json
        import re as _re

        tool_calls: list[dict[str, Any]] = []
        clean_parts: list[str] = []
        last_end = 0

        for match in _re.finditer(
            r"<tool_call>\s*(.*?)\s*</tool_call>", text, _re.DOTALL
        ):
            clean_parts.append(text[last_end : match.start()])
            last_end = match.end()

            raw = match.group(1).strip()
            try:
                parsed = _json.loads(raw)
                if isinstance(parsed, dict) and "name" in parsed:
                    tool_calls.append(
                        {
                            "name": parsed["name"],
                            "arguments": parsed.get("arguments", {}),
                        }
                    )
                else:
                    logger.warning(
                        f"[WindsurfAgent] Skipping malformed tool_call (no 'name'): {raw[:200]}"
                    )
            except _json.JSONDecodeError as e:
                logger.warning(
                    f"[WindsurfAgent] Skipping unparseable tool_call JSON: {e} — {raw[:200]}"
                )

        clean_parts.append(text[last_end:])
        clean_text = "".join(clean_parts).strip()
        return clean_text, tool_calls

    async def _grpc_response_with_tools(
        self, prompt: str
    ) -> AsyncIterator[AgentMessage]:
        """Execute prompt via gRPC with text-based tool execution loop.

        The Windsurf language server (gRPC) does not support OpenAI function
        calling.  Instead we:
        1. Include tool definitions in the system prompt as structured text
        2. Parse ``<tool_call>`` XML blocks from the model's text response
        3. Execute tools locally via ``ToolExecutor``
        4. Feed results back as a new user message with ``<tool_result>`` tags
        5. Repeat until the model responds without tool calls (or max_turns)

        This consumes Windsurf credits because all inference goes through
        the local Windsurf IDE language server → Codeium cloud.
        """

        import asyncio as _asyncio

        from integrations.windsurf_proxy import grpc_client as _grpc_mod
        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            invalidate_process_cache,
        )
        from integrations.windsurf_proxy.cascade_client import cascade_chat
        from integrations.windsurf_proxy.grpc_client import stream_chat
        from integrations.windsurf_proxy.models import requires_cascade, resolve_model

        model_enum, model_name = resolve_model(self.model)
        use_cascade = requires_cascade(self.model)

        # Build system prompt with tool definitions appended
        tool_prompt = self._build_tool_prompt_text()
        full_system_prompt = (self.system_prompt or "") + tool_prompt

        # Conversation history for multi-turn
        messages: list[dict[str, str]] = []
        if full_system_prompt:
            messages.append({"role": "system", "content": full_system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        logger.info(
            f"[WindsurfAgent] gRPC+tools: starting (model={self.model}, "
            f"tools={len(self._tool_definitions)}, prompt_len={len(prompt)})"
        )
        print(
            f"[WindsurfAgent] 🔌 gRPC request via local Windsurf IDE "
            f"(model={self.model}, {len(self._tool_definitions)} tools, "
            f"consumes Windsurf credits)",
            flush=True,
        )

        for turn in range(self.max_turns):
            logger.info(
                f"[WindsurfAgent] gRPC turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages..."
            )

            # Send to Windsurf via gRPC — retry once with fresh credentials on Cascade session errors
            text_parts: list[str] = []
            turn_error: Exception | None = None
            for attempt in range(2):
                if attempt > 0:
                    # Invalidate process cache so discover_credentials() fetches a
                    # fresh CSRF token instead of returning the cached stale one.
                    logger.warning(
                        "[WindsurfAgent] Refreshing credentials before retry"
                    )
                    _grpc_mod._panel_initialized = False
                    invalidate_process_cache()
                    await _asyncio.sleep(1.5)
                    try:
                        self._credentials = discover_credentials()
                    except Exception as refresh_err:
                        logger.error(
                            f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                        )
                        break

                text_parts = []
                try:
                    if use_cascade:
                        # Cascade flattens the whole conversation into one
                        # text payload, so we pass the already-built messages
                        # list (incl. system prompt + tool preamble) and let
                        # cascade_chat stitch it server-side.
                        full = await cascade_chat(
                            credentials=self._credentials,
                            messages=messages,
                            model_enum=model_enum,
                            model_uid=model_name,
                        )
                        if full:
                            text_parts.append(full)
                    else:
                        async for chunk in stream_chat(
                            credentials=self._credentials,
                            messages=messages,
                            model_enum=model_enum,
                            model_name=model_name,
                            system_prompt=full_system_prompt,
                        ):
                            text_parts.append(chunk)
                    turn_error = None
                except Exception as e:
                    turn_error = e
                    err_str = str(e).lower()
                    if attempt == 0 and (
                        "failed_precondition" in err_str or "cascade session" in err_str
                    ):
                        logger.warning(
                            f"[WindsurfAgent] Cascade session error on turn {turn + 1}, retrying: {e}"
                        )
                        _grpc_mod._panel_initialized = False
                        continue
                    logger.error(
                        f"[WindsurfAgent] gRPC streaming error (turn {turn + 1}): {e}"
                    )
                    break

                # Windsurf sometimes returns the Cascade session error as HTTP 200 text.
                # Detect this and retry with fresh credentials (same as _grpc_response).
                if turn_error is None and attempt == 0:
                    partial_text = "".join(text_parts).lower()
                    if (
                        "failed_precondition" in partial_text
                        and "cascade session" in partial_text
                    ):
                        logger.warning(
                            f"[WindsurfAgent] Cascade session error in response text on turn {turn + 1}, "
                            "retrying with fresh credentials"
                        )
                        _grpc_mod._panel_initialized = False
                        invalidate_process_cache()
                        await _asyncio.sleep(1.5)
                        try:
                            self._credentials = discover_credentials()
                        except Exception as refresh_err:
                            logger.error(
                                f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                            )
                            break
                        continue  # retry with fresh credentials

                break  # success or non-retryable error

            if turn_error is not None:
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=f"Windsurf gRPC error: {turn_error}",
                        )
                    ],
                )
                return

            full_text = "".join(text_parts)
            if not full_text:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Windsurf)",
                        )
                    ],
                )
                return

            # Parse tool calls from text
            clean_text, tool_calls = self._parse_tool_calls_from_text(full_text)

            logger.info(
                f"[WindsurfAgent] gRPC turn {turn + 1}: "
                f"text_len={len(clean_text)}, tool_calls={len(tool_calls)}"
            )

            # Yield text content (the non-tool-call part)
            if clean_text:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=clean_text)],
                )

            # No tool calls → done
            if not tool_calls:
                if not clean_text:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Windsurf)",
                            )
                        ],
                    )
                logger.info(
                    f"[WindsurfAgent] gRPC session complete after {turn + 1} turn(s)"
                )
                return

            # Add assistant message to conversation history
            messages.append({"role": "assistant", "content": full_text})

            # Execute each tool call and collect results
            result_parts: list[str] = []
            for i, tc in enumerate(tool_calls):
                tool_name = tc["name"]
                tool_args = tc["arguments"]
                tool_id = f"grpc_{turn}_{i}_{tool_name}"

                logger.info(
                    f"[WindsurfAgent] gRPC turn {turn + 1}: "
                    f"tool_call {tool_name}({list(tool_args.keys())})"
                )
                print(f"[WindsurfAgent] 🔧 Tool: {tool_name}", flush=True)

                # Yield TOOL_USE block
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=tool_args,
                        )
                    ],
                )

                # Execute tool
                result_text = ""
                is_error = False
                try:
                    result = await self._tool_executor.execute(tool_name, tool_args)
                    result_text = str(result) if result is not None else ""
                except Exception as e:
                    result_text = f"Error: {e}"
                    is_error = True
                    logger.warning(f"[WindsurfAgent] Tool {tool_name} failed: {e}")

                # Yield TOOL_RESULT block
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Format result for next gRPC message (head+tail truncation —
                # build/test verdicts sit at the END of the output)
                status = "error" if is_error else "success"
                truncated = truncate_tool_result(result_text, limit=8000)
                result_parts.append(
                    f'<tool_result name="{tool_name}" status="{status}">\n'
                    f"{truncated}\n"
                    f"</tool_result>"
                )

            # Add tool results as a user message for the next turn
            results_message = "\n\n".join(result_parts)
            messages.append({"role": "user", "content": results_message})

            # Elide stale tool results once the conversation exceeds the char
            # budget (text-mode results are user messages starting with
            # <tool_result — compact_messages handles both shapes).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[WindsurfAgent] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn sends updated conversation

        logger.warning(
            f"[WindsurfAgent] gRPC reached max_turns ({self.max_turns}) — stopping"
        )
        print(
            f"[WindsurfAgent] ⚠️ Reached max turns ({self.max_turns})",
            flush=True,
        )

    # =================================================================
    # REST mode (OpenAI-compatible function calling)
    # =================================================================

    def _get_openai_tools(self) -> list[dict[str, Any]]:
        """Convert internal tool definitions to OpenAI function calling format."""
        if not self._tool_definitions:
            return []
        return [
            {
                "type": "function",
                "function": {
                    "name": td["name"],
                    "description": td.get("description", ""),
                    "parameters": td.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for td in self._tool_definitions
        ]

    def _ensure_http_client(self):
        """Lazy-init an aiohttp ClientSession for REST mode."""
        if self._http_client is None:
            try:
                import aiohttp
            except ImportError:
                raise ImportError(
                    "aiohttp is required for WindsurfAgentClient REST mode. "
                    "Install with: pip install aiohttp"
                )
            self._http_client = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": CONTENT_TYPE_JSON,
                    "Accept": CONTENT_TYPE_JSON,
                }
            )
        return self._http_client

    async def _rest_response_with_tools(
        self, prompt: str
    ) -> AsyncIterator[AgentMessage]:
        """Execute prompt via REST API with full tool execution loop.

        Implements OpenAI-compatible function calling:
        1. Send messages + tool definitions to API
        2. If response contains tool_calls → execute each tool, add results, continue
        3. If no tool_calls → yield final text response and stop
        4. Repeat up to max_turns
        """
        import json as _json

        session = self._ensure_http_client()

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        tools = self._get_openai_tools()
        url = f"{self._rest_base_url}/chat/completions"

        # Log initial request details for debugging (no key material)
        logger.info(
            "[WindsurfAgent] REST request: url=%s, model=%s, tools=%d, prompt_len=%d, key_present=%s",
            url,
            self.model,
            len(tools),
            len(prompt),
            bool(self._api_key),
        )
        print(
            f"[WindsurfAgent] Sending REST API request to {url} "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        _ws_total_in = 0
        _ws_total_out = 0

        for turn in range(self.max_turns):
            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages to API..."
            )

            # ----------------------------------------------------------
            # URL probing:  On the first request, try each base URL in
            # turn until one returns a non-404/non-502 status.  Once a
            # working URL is found it is cached for subsequent turns.
            # ----------------------------------------------------------
            urls_to_try: list[str]
            if not self._rest_url_probed:
                urls_to_try = [
                    f"{base}/chat/completions" for base in self._rest_base_urls
                ]
            else:
                urls_to_try = [url]

            data: dict[str, Any] | None = None
            last_error_status: int = 0
            last_error_text: str = ""

            for try_url in urls_to_try:
                try:
                    async with session.post(try_url, json=payload) as resp:
                        resp_status = resp.status
                        if resp_status == 200:
                            data = await resp.json()
                            # Cache the working base URL
                            if not self._rest_url_probed:
                                base = try_url.removesuffix("/chat/completions")
                                self._rest_base_url = base
                                url = try_url
                                self._rest_url_probed = True
                                logger.info(
                                    f"[WindsurfAgent] ✅ Found working endpoint: {try_url}"
                                )
                                print(
                                    f"[WindsurfAgent] ✅ Working endpoint: {try_url}",
                                    flush=True,
                                )
                            break  # success
                        else:
                            error_text = await resp.text()
                            logger.warning(
                                f"[WindsurfAgent] Endpoint {try_url} returned HTTP {resp_status}: {error_text[:200]}"
                            )
                            last_error_status = resp_status
                            last_error_text = error_text
                            # 404/502 → try next URL; other errors → stop probing
                            if resp_status not in (404, 502, 503):
                                break
                except Exception as probe_err:
                    logger.warning(
                        f"[WindsurfAgent] Endpoint {try_url} failed: {probe_err}"
                    )
                    last_error_status = 0
                    last_error_text = str(probe_err)

            if data is None:
                # All URLs failed
                self._rest_url_probed = True  # don't re-probe
                error_msg = (
                    f"Windsurf REST API error ({last_error_status}): {last_error_text}"
                    if last_error_status
                    else f"Windsurf REST API error: {last_error_text}"
                )
                logger.error(f"[WindsurfAgent] {error_msg}")
                print(
                    f"[WindsurfAgent] ❌ All endpoints failed: {error_msg[:200]}",
                    flush=True,
                )
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=error_msg,
                        )
                    ],
                )
                return

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}: API responded 200 OK "
                f"(keys={list(data.keys())})"
            )

            # Parse usage from response (for logging and cost tracking)
            usage = data.get("usage", {})
            if usage:
                logger.info(
                    f"[WindsurfAgent] Token usage: "
                    f"prompt={usage.get('prompt_tokens', '?')}, "
                    f"completion={usage.get('completion_tokens', '?')}, "
                    f"total={usage.get('total_tokens', '?')}"
                )
                _ws_total_in += usage.get("prompt_tokens", 0)
                _ws_total_out += usage.get("completion_tokens", 0)

            choices = data.get("choices", [])
            if not choices:
                logger.warning(f"[WindsurfAgent] Empty choices in response: {data}")
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Windsurf REST API)",
                        )
                    ],
                )
                return

            message = choices[0].get("message", {})
            content = message.get("content", "")
            tool_calls = message.get("tool_calls", [])
            finish_reason = choices[0].get("finish_reason", "")

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}: "
                f"content_len={len(content or '')}, "
                f"tool_calls={len(tool_calls)}, "
                f"finish_reason={finish_reason}"
            )

            # Yield text content if present
            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            # No tool calls → done
            if not tool_calls:
                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Windsurf)",
                            )
                        ],
                    )
                logger.info(
                    f"[WindsurfAgent] Session complete after {turn + 1} turn(s) "
                    f"(finish_reason={finish_reason})"
                )
                # Windsurf uses credits (not per-token billing) — store tokens, cost=0
                self.last_usage = {
                    "input_tokens": _ws_total_in,
                    "output_tokens": _ws_total_out,
                    "cost_usd": 0.0,
                }
                return

            # Add assistant message (with tool_calls) to conversation history
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if content:
                assistant_msg["content"] = content
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            # Execute each tool call
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                tool_id = tc.get("id", f"call_{turn}_{tool_name}")

                try:
                    args = _json.loads(func.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    f"[WindsurfAgent] Turn {turn + 1}: tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[WindsurfAgent] 🔧 Tool: {tool_name}", flush=True)

                # Yield TOOL_USE block so session handler counts it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=args,
                        )
                    ],
                )

                # Execute tool
                result_text = ""
                is_error = False
                if self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                        logger.warning(f"[WindsurfAgent] Tool {tool_name} failed: {e}")
                else:
                    result_text = "Tool executor not available (no project_dir)"
                    is_error = True

                # Yield TOOL_RESULT block so session handler logs it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Add tool result to conversation for next API call (head+tail
                # truncation — build/test verdicts sit at the END of the output)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": truncate_tool_result(result_text),
                    }
                )

            # Elide stale tool results once the conversation exceeds the char
            # budget (no-op below budget, preserving the cacheable prefix).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[WindsurfAgent] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn will send updated messages with tool results

        logger.warning(
            f"[WindsurfAgent] Reached max_turns ({self.max_turns}) — stopping tool loop"
        )
        print(
            f"[WindsurfAgent] ⚠️ Reached max turns ({self.max_turns})",
            flush=True,
        )
        self.last_usage = {
            "input_tokens": _ws_total_in,
            "output_tokens": _ws_total_out,
            "cost_usd": 0.0,
        }

    def supports_subagents(self) -> bool:
        return False

    def provider_name(self) -> str:
        return "windsurf"
