"""
LiteLLMRuntime: AgentRuntime for provider-agnostic LLMs via LiteLLM
Implements agent loop with tool execution for OpenAI-compatible LLMs
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

logger = logging.getLogger(__name__)

from core.llm_client import (
    ConcreteLLMClient,
    LLMToolResponse,
)
from core.runtime import (
    AgentRuntime,
    SessionResult,
    SessionStatus,
    StreamEvent,
)
from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions

if TYPE_CHECKING:
    from src.connectors.llm_config import ProviderConfig


def _get_provider_config():
    """Lazy import to avoid sys.path shadowing by apps/backend/src/__init__.py."""
    project_root = Path(__file__).parent.parent.parent.parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    from src.connectors.llm_config import ProviderConfig  # noqa: PLC0415

    return ProviderConfig


class LiteLLMRuntime(AgentRuntime):
    def __init__(
        self,
        spec_dir: str,
        phase: str,
        project_dir: str,
        agent_type: str,
        config: ProviderConfig,
        cli_thinking: int | None = None,
    ):
        self.spec_dir = spec_dir
        self.phase = phase
        self.project_dir = project_dir
        self.agent_type = agent_type
        self.config = config
        self.cli_thinking = cli_thinking
        self.llm_client = ConcreteLLMClient.from_provider_config(config)
        self.tool_executor = ToolExecutor(project_dir)
        self.tool_definitions = get_tool_definitions(agent_type)
        self.max_turns = 10

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        # Cleanup LLM client if needed
        if hasattr(self.llm_client, "close"):
            await self.llm_client.close()

    async def run_session(
        self, prompt: str, tools: list[dict[str, Any]] | None = None, **kwargs
    ) -> SessionResult:
        turn = 0
        last_response = None
        error_info = None
        usage = None
        while turn < self.max_turns:
            try:
                llm_response: LLMToolResponse = (
                    await self.llm_client.complete_with_tools(
                        prompt, tools or self.tool_definitions, **kwargs
                    )
                )
                usage = llm_response.usage
                if llm_response.has_tool_calls:
                    tool_results = {}
                    for tool_call in llm_response.tool_calls:
                        try:
                            result = await self.tool_executor.execute(
                                tool_call.name, tool_call.arguments
                            )
                            tool_results[tool_call.id] = result
                        except Exception as e:
                            tool_results[tool_call.id] = {"error": str(e)}
                    prompt = self._build_tool_result_prompt(prompt, tool_results)
                    turn += 1
                    continue
                else:
                    last_response = llm_response.content
                    break
            except Exception as e:
                # `str(e)` can include API key fragments for some LiteLLM
                # provider errors. Log the full traceback locally; expose
                # only the exception class name to the caller / persisted
                # SessionResult so we don't leak credentials into audit logs
                # or the streaming UI.
                logger.exception("LLM call failed")
                error_info = type(e).__name__
                break
        status = SessionStatus.COMPLETE if last_response else SessionStatus.ERROR
        return SessionResult(
            status=status, output=last_response, error=error_info, usage=usage
        )

    async def stream_session(
        self, prompt: str, tools: list[dict[str, Any]] | None = None, **kwargs
    ):
        turn = 0
        while turn < self.max_turns:
            try:
                llm_response: LLMToolResponse = (
                    await self.llm_client.complete_with_tools(
                        prompt, tools or self.tool_definitions, **kwargs
                    )
                )
                if llm_response.has_tool_calls:
                    tool_results = {}
                    for tool_call in llm_response.tool_calls:
                        yield StreamEvent(StreamEvent.Type.TOOL_START, tool_call.name)
                        try:
                            result = await self.tool_executor.execute(
                                tool_call.name, tool_call.arguments
                            )
                            tool_results[tool_call.id] = result
                            yield StreamEvent(StreamEvent.Type.TOOL_END, result)
                        except Exception as e:
                            tool_results[tool_call.id] = {"error": str(e)}
                            yield StreamEvent(StreamEvent.Type.ERROR, str(e))
                    prompt = self._build_tool_result_prompt(prompt, tool_results)
                    turn += 1
                    continue
                else:
                    yield StreamEvent(StreamEvent.Type.TEXT, llm_response.content)
                    break
            except Exception as e:
                logger.exception("LLM streaming call failed")
                # Don't echo str(e) — provider errors can include API key
                # fragments and are visible to all WS subscribers.
                yield StreamEvent(StreamEvent.Type.ERROR, type(e).__name__)
                break
        yield StreamEvent(StreamEvent.Type.DONE, None)

    def _build_tool_result_prompt(
        self, prompt: str, tool_results: dict[str, Any]
    ) -> str:
        # Simple prompt augmentation for tool results
        tool_result_str = "\n".join(
            [f"Tool {tid}: {res}" for tid, res in tool_results.items()]
        )
        return f"{prompt}\n{tool_result_str}"
