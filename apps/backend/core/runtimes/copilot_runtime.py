"""
CopilotRuntime: AgentRuntime for GitHub Copilot CLI (gh copilot)

Delegates LLM calls through the `gh copilot` CLI extension.
Copilot CLI supports two modes:
  - `gh copilot suggest`: code/shell suggestions
  - `gh copilot explain`: code explanations

This runtime wraps the CLI invocation in an async subprocess,
mirroring the LiteLLMRuntime interface so it can be swapped in
via the factory in __init__.py.
"""

import asyncio
import shutil
from typing import Any

from core.runtime import AgentRuntime, SessionResult, SessionStatus


class CopilotRuntime(AgentRuntime):
    """Agent runtime that delegates to GitHub Copilot CLI (gh copilot)."""

    def __init__(
        self,
        spec_dir: str,
        phase: str,
        project_dir: str,
        agent_type: str,
        config: Any = None,
        cli_thinking: int | None = None,
        gh_path: str | None = None,
    ):
        self.spec_dir = spec_dir
        self.phase = phase
        self.project_dir = project_dir
        self.agent_type = agent_type
        self.config = config
        self.cli_thinking = cli_thinking
        # Resolve gh binary path
        self.gh_path = gh_path or shutil.which("gh") or "gh"
        self.max_turns = 10

    async def _invoke_copilot(self, prompt: str, mode: str = "suggest") -> str:
        """
        Invoke `gh copilot <mode>` with the given prompt.

        Args:
            prompt: The user prompt to send to Copilot
            mode: Either 'suggest' or 'explain'

        Returns:
            The raw stdout from the CLI invocation.

        Raises:
            RuntimeError: If the subprocess exits with a non-zero code.
        """
        cmd = [self.gh_path, "copilot", mode, "-t", "shell", prompt]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.project_dir,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            # Without this, asyncio.wait_for cancels the future but the gh
            # subprocess keeps running, holding stdout/stderr file
            # descriptors. Repeated timeouts exhaust fds and leave zombie
            # `gh` processes. Kill explicitly and reap before re-raising.
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass
            raise
        stdout_str = stdout.decode("utf-8", errors="replace").strip()
        stderr_str = stderr.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0:
            raise RuntimeError(
                f"gh copilot {mode} failed (exit {proc.returncode}): {stderr_str or stdout_str}"
            )
        return stdout_str

    async def run_session(
        self,
        prompt: str,
        tools: list[dict[str, Any]] | None = None,
        **kwargs,
    ) -> SessionResult:
        """
        Run a single Copilot CLI session.

        Copilot CLI does not support tool-use loops, so this performs a
        single invocation and returns the result.
        """
        try:
            # Determine mode based on prompt heuristic or agent_type
            mode = "explain" if self.agent_type in ("qa", "review") else "suggest"
            response = await self._invoke_copilot(prompt, mode=mode)

            return SessionResult(
                status=SessionStatus.COMPLETE,
                response=response,
                error_info=None,
                tool_calls_count=0,
                usage=None,
            )
        except Exception as e:
            return SessionResult(
                status=SessionStatus.ERROR,
                response=None,
                error_info=str(e),
                tool_calls_count=0,
                usage=None,
            )

    async def stream_session(
        self,
        prompt: str,
        tools: list[dict[str, Any]] | None = None,
        **kwargs,
    ):
        """
        Copilot CLI does not support streaming natively.
        Falls back to run_session and yields the complete result.
        """
        result = await self.run_session(prompt, tools, **kwargs)
        # Yield a single event with the full response
        yield {
            "type": "content",
            "content": result.response or result.error_info or "",
        }
