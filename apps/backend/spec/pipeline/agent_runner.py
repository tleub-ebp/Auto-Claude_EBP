"""
Agent Runner
============

Handles the execution of AI agents for the spec creation pipeline.
"""

from pathlib import Path

# Configure safe encoding before any output (fixes Windows encoding errors)
from ui.capabilities import configure_safe_encoding

configure_safe_encoding()

from debug import debug, debug_detailed, debug_error, debug_section, debug_success
from security.tool_input_validator import get_safe_tool_input
from task_logger import (
    LogEntryType,
    LogPhase,
    TaskLogger,
)

# Lazy import create_client to avoid circular import with core.client
# The import chain: spec.pipeline -> agent_runner -> core.client -> agents.tools_pkg -> spec.validate_pkg
# By deferring the import, we break the circular dependency.


class AgentRunner:
    """Manages agent execution with logging and error handling."""

    def __init__(
        self,
        project_dir: Path,
        spec_dir: Path,
        model: str,
        task_logger: TaskLogger | None = None,
    ):
        """Initialize the agent runner.

        Args:
            project_dir: The project root directory
            spec_dir: The spec directory
            model: The model to use for agent execution
            task_logger: Optional task logger for tracking progress
        """
        self.project_dir = project_dir
        self.spec_dir = spec_dir
        self.model = model
        self.task_logger = task_logger

    async def run_agent(
        self,
        prompt_file: str,
        additional_context: str = "",
        interactive: bool = False,
        thinking_budget: int | None = None,
        prior_phase_summaries: str | None = None,
    ) -> tuple[bool, str]:
        """Run an agent with the given prompt.

        Args:
            prompt_file: The prompt file to use (relative to prompts directory)
            additional_context: Additional context to add to the prompt
            interactive: Whether to run in interactive mode
            thinking_budget: Token budget for extended thinking (None = disabled)
            prior_phase_summaries: Summaries from previous phases for context

        Returns:
            Tuple of (success, response_text)
        """
        debug_section("agent_runner", f"Spec Agent - {prompt_file}")
        debug(
            "agent_runner",
            "Running spec creation agent",
            prompt_file=prompt_file,
            spec_dir=str(self.spec_dir),
            model=self.model,
            interactive=interactive,
        )

        prompt_path = Path(__file__).parent.parent.parent / "prompts" / prompt_file

        if not prompt_path.exists():
            debug_error("agent_runner", f"Prompt file not found: {prompt_path}")
            return False, f"Prompt not found: {prompt_path}"

        # Load prompt
        prompt = prompt_path.read_text(encoding="utf-8")

        # Keep spec/planning prompts in sync with the Coverage Enforcement Gate
        # threshold (WORKPILOT_QA_MIN_COVERAGE, default 100).
        if "{{MIN_COVERAGE}}" in prompt:
            try:
                from qa.coverage_gate import get_min_coverage

                min_coverage = get_min_coverage()
            except Exception:
                min_coverage = 100
            prompt = prompt.replace("{{MIN_COVERAGE}}", str(min_coverage))

        debug_detailed(
            "agent_runner",
            "Loaded prompt file",
            prompt_length=len(prompt),
        )

        # Add context
        prompt += f"\n\n---\n\n**Spec Directory**: {self.spec_dir}\n"
        prompt += f"**Project Directory**: {self.project_dir}\n"

        # Add summaries from previous phases (compaction)
        if prior_phase_summaries:
            prompt += f"\n{prior_phase_summaries}\n"
            debug_detailed(
                "agent_runner",
                "Added prior phase summaries",
                summaries_length=len(prior_phase_summaries),
            )

        if additional_context:
            prompt += f"\n{additional_context}\n"
            debug_detailed(
                "agent_runner",
                "Added additional context",
                context_length=len(additional_context),
            )

        # Create client with thinking budget
        # Log model/CWD prominently so issues are visible in task console
        debug(
            "agent_runner",
            "Creating agent client",
            model=self.model,
            thinking_budget=thinking_budget,
            project_dir=str(self.project_dir),
            project_dir_exists=self.project_dir.exists(),
            spec_dir=str(self.spec_dir),
            spec_dir_exists=self.spec_dir.exists(),
        )
        if self.task_logger:
            self.task_logger.log(
                f"Agent config: model={self.model}, thinking={thinking_budget}, "
                f"CWD exists={self.project_dir.exists()}",
                LogEntryType.TEXT,
                LogPhase.PLANNING,
                print_to_console=True,
            )

        # Determine which provider to use
        from core.client import _get_active_provider

        active_provider = _get_active_provider(self.spec_dir)
        debug("agent_runner", f"Active provider resolved: {active_provider}")

        if active_provider not in ("claude", "anthropic"):
            # Non-Claude providers (openai, windsurf, copilot, google, mistral,
            # deepseek, grok, meta, aws, ollama, etc.): use create_agent_client
            # which routes to the appropriate provider-specific AgentClient
            # (OpenAIAgentClient, WindsurfAgentClient, CopilotAgentClient, etc.)
            from core.client import create_agent_client

            debug(
                "agent_runner",
                f"Using create_agent_client for provider '{active_provider}' "
                f"(tokens will be consumed from {active_provider}, NOT Anthropic)",
            )
            client = create_agent_client(
                project_dir=self.project_dir,
                spec_dir=self.spec_dir,
                model=self.model,
                agent_type="spec_writer",
            )
            return await self._run_with_agent_client(client, prompt)

        # Claude/Anthropic provider: use raw SDK client (create_client) for full
        # SDK message type compatibility (AssistantMessage, ToolUseBlock, etc.)
        from core.client import create_client

        client = create_client(
            project_dir=self.project_dir,
            spec_dir=self.spec_dir,
            model=self.model,
            agent_type="spec_writer",  # Use spec_writer type for spec creation
            max_thinking_tokens=thinking_budget,
        )

        # Debug: Check if input files exist for spec_writer
        if prompt_file == "spec_writer.md":
            input_files = ["project_index.json", "requirements.json", "context.json"]
            for file_name in input_files:
                file_path = self.spec_dir / file_name
                exists = file_path.exists()
                debug("agent_runner", f"Input file {file_name} exists: {exists}")
                if exists:
                    size = file_path.stat().st_size
                    debug("agent_runner", f"Input file {file_name} size: {size} bytes")

        current_tool = None
        message_count = 0
        tool_count = 0

        try:
            async with client:
                debug("agent_runner", "Sending query to Claude SDK...")
                await client.query(prompt)
                debug_success("agent_runner", "Query sent successfully")

                response_text = ""
                debug("agent_runner", "Starting to receive response stream...")
                async for msg in client.receive_response():
                    msg_type = type(msg).__name__
                    message_count += 1
                    debug_detailed(
                        "agent_runner",
                        f"Received message #{message_count}",
                        msg_type=msg_type,
                    )

                    if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            block_type = type(block).__name__
                            if block_type == "TextBlock" and hasattr(block, "text"):
                                response_text += block.text
                                print(block.text, end="", flush=True)
                                if self.task_logger and block.text.strip():
                                    self.task_logger.log(
                                        block.text,
                                        LogEntryType.TEXT,
                                        LogPhase.PLANNING,
                                        print_to_console=False,
                                    )
                            elif block_type == "ToolUseBlock" and hasattr(
                                block, "name"
                            ):
                                tool_name = block.name
                                tool_count += 1

                                # Safely extract tool input (handles None, non-dict, etc.)
                                inp = get_safe_tool_input(block)
                                tool_input_display = self._extract_tool_input_display(
                                    inp
                                )

                                debug(
                                    "agent_runner",
                                    f"Tool call #{tool_count}: {tool_name}",
                                    tool_input=tool_input_display,
                                )

                                if self.task_logger:
                                    self.task_logger.tool_start(
                                        tool_name,
                                        tool_input_display,
                                        LogPhase.PLANNING,
                                        print_to_console=True,
                                    )
                                else:
                                    print(f"\n[Tool: {tool_name}]", flush=True)
                                current_tool = tool_name

                    elif msg_type == "UserMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            block_type = type(block).__name__
                            if block_type == "ToolResultBlock":
                                is_error = getattr(block, "is_error", False)
                                result_content = getattr(block, "content", "")
                                if is_error:
                                    debug_error(
                                        "agent_runner",
                                        f"Tool error: {current_tool}",
                                        error=str(result_content)[:200],
                                    )
                                else:
                                    debug_detailed(
                                        "agent_runner",
                                        f"Tool success: {current_tool}",
                                        result_length=len(str(result_content)),
                                    )
                                if self.task_logger and current_tool:
                                    detail_content = self._get_tool_detail_content(
                                        current_tool, result_content
                                    )
                                    self.task_logger.tool_end(
                                        current_tool,
                                        success=not is_error,
                                        detail=detail_content,
                                        phase=LogPhase.PLANNING,
                                    )
                                current_tool = None

                    else:
                        # Handle unknown/special message types from the SDK.
                        # The SDK may send SystemMessage, StreamEvent, or other types.
                        # With our monkey-patch (Bug #12), unknown types like
                        # "rate_limit_event" are converted to SystemMessage(subtype=...).
                        msg_subtype = getattr(msg, "subtype", None) or ""

                        # Check if this is a rate_limit_event that was converted
                        # to SystemMessage by our monkey-patch. These are informational
                        # pause signals from the CLI, NOT hard rate limits. The CLI
                        # handles the pause internally — we just log and continue.
                        if "rate_limit" in msg_subtype.lower():
                            print(
                                "\n⏳ Rate limit pause (CLI will retry automatically)...",
                                flush=True,
                            )
                            debug(
                                "agent_runner",
                                "Rate limit event received (subtype="
                                + msg_subtype
                                + "), "
                                "session continues — CLI handles retry internally",
                            )
                        else:
                            debug(
                                "agent_runner",
                                f"Received message type: {msg_type}",
                                subtype=msg_subtype,
                            )

                print()

                # Detect empty sessions: if the agent didn't call any tools
                # and produced no meaningful output, something went wrong
                # (e.g., auth failure, invalid CWD, prompt too long).
                if tool_count == 0 and len(response_text.strip()) < 50:
                    debug_error(
                        "agent_runner",
                        "Agent session completed but produced no tool calls and minimal output",
                        message_count=message_count,
                        tool_count=tool_count,
                        response_length=len(response_text),
                    )
                    # IMPORTANT: Do NOT include the words "rate limit" in the error message!
                    # The frontend rate-limit-detector.ts pattern-matches on /rate\s*limit/i
                    # in the process output, which causes a false positive detection.
                    if self.task_logger:
                        self.task_logger.log_error(
                            f"Agent session empty: 0 tool calls, {len(response_text)}b output "
                            f"— possible causes: usage cap reached, auth failure, invalid working directory, "
                            f"or model unavailable. Check Claude profile settings.",
                            LogPhase.PLANNING,
                        )
                    return False, (
                        f"Agent session empty (0 tools, {len(response_text)}b output). "
                        f"Possible causes: usage cap, auth failure, invalid CWD, model unavailable. "
                        f"Response: {response_text[:200]}"
                    )

                debug_success(
                    "agent_runner",
                    "Agent session completed successfully",
                    message_count=message_count,
                    tool_count=tool_count,
                    response_length=len(response_text),
                )
                return True, response_text

        except Exception as e:
            error_str = str(e).lower()
            debug_error(
                "agent_runner",
                f"Agent session error: {e}",
                exception_type=type(e).__name__,
            )

            # Detect "prompt too long" errors — these are permanent for the
            # current conversation, so we surface a sentinel the orchestrator
            # recognises to halt the pipeline instead of looping.
            if (
                "prompt is too long" in error_str
                or "prompt too long" in error_str
                or "context length exceeded" in error_str
                or "context_length_exceeded" in error_str
                or "maximum context length" in error_str
                or "input is too long" in error_str
            ):
                halt_msg = (
                    f"Prompt too long for the LLM context window: {e}. "
                    f"Reset the conversation or switch to a provider with a "
                    f"larger context."
                )
                debug_error("agent_runner", halt_msg)
                print(f"\n⛔ {halt_msg}", flush=True)
                if self.task_logger:
                    self.task_logger.log_error(halt_msg, LogPhase.PLANNING)
                return False, f"PROMPT_TOO_LONG_HALT::{halt_msg}::{e}"

            # Detect rate/usage limit exceptions from the SDK.
            # The Claude Agent SDK may raise exceptions like:
            #   "Unknown message type: rate_limit_event"
            # when the account has hit its usage cap. We need to surface
            # this clearly so the frontend rate-limit-detector picks it up.
            if "rate_limit" in error_str or "limit_event" in error_str:
                # Use "hit your limit" phrasing so frontend rate-limit-detector.ts
                # matches via /hit your limit/i pattern and triggers proper UI.
                cap_msg = (
                    f"You've hit your limit — Claude SDK error: {e}. "
                    f"Please wait for the limit to reset or switch to a different Claude profile."
                )
                debug_error("agent_runner", cap_msg)
                print(f"\n⚠️  {cap_msg}", flush=True)
                if self.task_logger:
                    self.task_logger.log_error(cap_msg, LogPhase.PLANNING)
                # Prefix with a sentinel the orchestrator recognises so it can
                # invoke the rate-limit shield and retry the same phase instead
                # of failing the spec pipeline outright.
                return False, f"RATE_LIMIT_RETRY_REQUIRED::{cap_msg}::{e}"

            if self.task_logger:
                self.task_logger.log_error(f"Agent error: {e}", LogPhase.PLANNING)
            return False, str(e)

    async def _run_with_agent_client(self, client, prompt: str) -> tuple[bool, str]:
        """Run a spec creation agent session using an AgentClient (Windsurf/Copilot).

        This processes AgentMessage objects from create_agent_client() instead of
        raw Claude SDK messages. Used when the active provider is not Claude.

        Args:
            client: An AgentClient instance (WindsurfAgentClient, CopilotAgentClient)
            prompt: The full prompt to send

        Returns:
            (success, response_text) tuple
        """
        from core.agent_client import ContentBlockType

        current_tool = None
        message_count = 0
        tool_count = 0

        try:
            async with client:
                provider = client.provider_name()
                debug("agent_runner", f"Sending query to {provider} agent client...")
                await client.query(prompt)
                debug_success("agent_runner", f"Query sent to {provider}")

                response_text = ""
                debug("agent_runner", f"Receiving {provider} response stream...")

                async for msg in client.receive_response():
                    message_count += 1

                    for block in msg.content:
                        if block.type == ContentBlockType.TEXT and block.text:
                            response_text += block.text
                            print(block.text, end="", flush=True)
                            if self.task_logger and block.text.strip():
                                self.task_logger.log(
                                    block.text,
                                    LogEntryType.TEXT,
                                    LogPhase.PLANNING,
                                    print_to_console=False,
                                )

                        elif block.type == ContentBlockType.TOOL_USE:
                            tool_name = block.tool_name or ""
                            tool_count += 1
                            tool_input_display = self._extract_tool_input_display(
                                block.tool_input or {}
                            )
                            debug(
                                "agent_runner",
                                f"Tool call #{tool_count}: {tool_name}",
                                tool_input=tool_input_display,
                            )
                            if self.task_logger:
                                self.task_logger.tool_start(
                                    tool_name,
                                    tool_input_display,
                                    LogPhase.PLANNING,
                                    print_to_console=True,
                                )
                            else:
                                print(f"\n[Tool: {tool_name}]", flush=True)
                            current_tool = tool_name

                        elif block.type == ContentBlockType.TOOL_RESULT:
                            is_error = block.is_error
                            result_content = block.result_content or ""
                            if is_error:
                                debug_error(
                                    "agent_runner",
                                    f"Tool error: {current_tool}",
                                    error=str(result_content)[:200],
                                )
                            else:
                                debug_detailed(
                                    "agent_runner",
                                    f"Tool success: {current_tool}",
                                    result_length=len(str(result_content)),
                                )
                            if self.task_logger and current_tool:
                                detail_content = self._get_tool_detail_content(
                                    current_tool, result_content
                                )
                                self.task_logger.tool_end(
                                    current_tool,
                                    success=not is_error,
                                    detail=detail_content,
                                    phase=LogPhase.PLANNING,
                                )
                            current_tool = None

                print()

                # Detect empty sessions
                if tool_count == 0 and len(response_text.strip()) < 50:
                    provider = client.provider_name()
                    debug_error(
                        "agent_runner",
                        f"[{provider}] Agent session empty: 0 tool calls, {len(response_text)}b",
                    )
                    if self.task_logger:
                        self.task_logger.log_error(
                            f"Agent session empty: 0 tool calls, {len(response_text)}b output "
                            f"— provider: {provider}. Check {provider} credentials and API access.",
                            LogPhase.PLANNING,
                        )
                    return False, (
                        f"Agent session empty (0 tools, {len(response_text)}b output, "
                        f"provider={provider}). Response: {response_text[:200]}"
                    )

                debug_success(
                    "agent_runner",
                    "Agent client session completed successfully",
                    provider=client.provider_name(),
                    message_count=message_count,
                    tool_count=tool_count,
                    response_length=len(response_text),
                )
                return True, response_text

        except Exception as e:
            debug_error(
                "agent_runner",
                f"Agent client session error: {e}",
                exception_type=type(e).__name__,
            )
            if self.task_logger:
                self.task_logger.log_error(f"Agent error: {e}", LogPhase.PLANNING)
            return False, str(e)

    @staticmethod
    def _extract_tool_input_display(inp: dict) -> str | None:
        """Extract meaningful tool input for display.

        Args:
            inp: The tool input dictionary

        Returns:
            A formatted string for display, or None
        """
        if not isinstance(inp, dict):
            return None

        # Show commands and paths in full so the activity feed reveals exactly
        # what the agent is doing; only pathologically long inputs are trimmed.
        if "pattern" in inp:
            return f"pattern: {inp['pattern']}"
        elif "file_path" in inp:
            fp = str(inp["file_path"])
            if len(fp) > 2000:
                fp = "..." + fp[-1997:]
            return fp
        elif "command" in inp:
            cmd = str(inp["command"])
            if len(cmd) > 2000:
                cmd = cmd[:1997] + "..."
            return cmd
        elif "path" in inp:
            return inp["path"]

        return None

    @staticmethod
    def _get_tool_detail_content(tool_name: str, result_content: str) -> str | None:
        """Get detail content for specific tools.

        Args:
            tool_name: The name of the tool
            result_content: The result content from the tool

        Returns:
            Detail content if relevant, otherwise None
        """
        if tool_name not in ("Read", "Grep", "Bash", "Edit", "Write"):
            return None

        result_str = str(result_content)
        if len(result_str) < 50000:
            return result_str

        return None
