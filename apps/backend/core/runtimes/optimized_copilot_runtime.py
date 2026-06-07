"""
Optimized Copilot Runtime
=========================

Optimized version of CopilotRuntime with token awareness and hierarchical prompts.
This extends the original CopilotRuntime without affecting Claude Code agents.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

from ..optimization.dynamic_prompt_template import ContextInfo, DynamicPromptTemplate
from ..optimization.hierarchical_prompt import HierarchicalPrompt, PromptLevel
from ..optimization.token_aware_agent import (
    Task,
    TaskComplexity,
    TaskResult,
    TokenAwareAgentBase,
)
from .copilot_runtime import CopilotRuntime

logger = logging.getLogger(__name__)


class OptimizedCopilotRuntime(TokenAwareAgentBase):
    """
    Optimized Copilot runtime with token awareness and prompt optimization.

    This class extends TokenAwareAgentBase and wraps the original CopilotRuntime
    to provide token optimization without changing the core functionality.
    """

    def __init__(
        self,
        spec_dir: str,
        phase: str,
        project_dir: str,
        agent_type: str,
        config: Any = None,
        cli_thinking: int | None = None,
        gh_path: str | None = None,
        token_budget: int = 2000,
    ):
        """
        Initialize optimized Copilot runtime.

        Args:
            spec_dir: Specification directory
            phase: Phase identifier
            project_dir: Project directory
            agent_type: Type of agent
            config: Additional configuration
            cli_thinking: CLI thinking timeout
            gh_path: Path to GitHub CLI
            token_budget: Token budget for this runtime
        """
        super().__init__(f"copilot_runtime_{agent_type}", token_budget)

        # Initialize original CopilotRuntime
        self.original_runtime = CopilotRuntime(
            spec_dir=spec_dir,
            phase=phase,
            project_dir=project_dir,
            agent_type=agent_type,
            config=config,
            cli_thinking=cli_thinking,
            gh_path=gh_path,
        )

        # Optimization components
        self.hierarchical_prompt = HierarchicalPrompt()
        self.dynamic_prompt = DynamicPromptTemplate()

        # Runtime settings
        self.spec_dir = spec_dir
        self.phase = phase
        self.project_dir = project_dir
        self.agent_type = agent_type
        self.config = config
        self.cli_thinking = cli_thinking
        self.max_turns = 10

        # Optimization settings
        self.auto_optimize_prompts = True
        self.context_level = PromptLevel.STANDARD

        logger.info(
            f"Initialized OptimizedCopilotRuntime for {agent_type} with budget {token_budget}"
        )

    def execute_task_internal(self, task: Task) -> TaskResult:
        """
        Execute a task using optimized Copilot runtime.

        Args:
            task: Task to execute

        Returns:
            TaskResult with execution details
        """
        logger.info(f"Executing optimized Copilot task: {task.id}")

        try:
            # Optimize the prompt if enabled
            if self.auto_optimize_prompts:
                optimized_prompt = self._optimize_prompt(task)
                # Replace the task description with optimized prompt
                original_description = task.description
                task.description = optimized_prompt

            # Execute using original runtime
            session_result = self._execute_with_original_runtime(task)

            # Restore original description if modified
            if self.auto_optimize_prompts and hasattr(task, "original_description"):
                task.description = original_description

            # Convert to TaskResult
            return self._convert_to_task_result(task, session_result)

        except Exception as e:
            logger.error(f"Optimized Copilot task failed: {str(e)}")
            return TaskResult(
                task_id=task.id,
                success=False,
                error=str(e),
                tokens_used=self._estimate_task_tokens(task),
            )

    def _execute_with_original_runtime(self, task: Task):
        """Execute task using original CopilotRuntime.

        `asyncio.run()` accepts no `timeout=` kwarg (TypeError) AND cannot be
        called from inside a running event loop (RuntimeError). Both
        conditions hit in production, leaving this runtime dead-on-arrival.
        Use a fresh event loop on a worker thread when called from a sync
        context, and `asyncio.wait_for` for the timeout.
        """
        prompt = task.description

        async def _runner():
            return await asyncio.wait_for(
                self.original_runtime.run_session(prompt, tools=None),
                timeout=60,
            )

        try:
            # If we're inside a running loop, we cannot call asyncio.run.
            asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — safe to run directly.
            return asyncio.run(_runner())

        # Inside an event loop: dispatch to a worker thread that owns its own
        # loop so we don't reentrantly recurse into the active one.
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, _runner()).result()

    def _convert_to_task_result(self, task: Task, session_result) -> TaskResult:
        """Convert CopilotRuntime session result to TaskResult"""
        success = session_result.status.value == "COMPLETE"

        return TaskResult(
            task_id=task.id,
            success=success,
            result=session_result.response if success else None,
            error=session_result.error_info if not success else None,
            tokens_used=self._estimate_task_tokens(task),
            execution_time=0.0,  # Could be enhanced with timing
        )

    def _optimize_prompt(self, task: Task) -> str:
        """Optimize prompt using hierarchical and dynamic templates"""
        # Build context info
        context_info = self._build_context_info(task)

        # Build constraints
        constraints = self._build_constraints(task)

        # Determine optimal prompt level based on budget
        available_tokens = (
            self.token_budget
            - self.token_tracker.get_agent_stats(self.agent_id).total_tokens
        )

        if available_tokens < 500:
            level = PromptLevel.MINIMAL
        elif available_tokens < 1000:
            level = PromptLevel.STANDARD
        else:
            level = PromptLevel.COMPREHENSIVE

        # Generate optimized prompt
        if task.complexity in [TaskComplexity.SIMPLE, TaskComplexity.MEDIUM]:
            # Use hierarchical prompt for simpler tasks
            prompt = self.hierarchical_prompt.build_prompt(
                task_description=task.description,
                level=level,
                context=context_info,
                constraints=constraints,
            )
        else:
            # Use dynamic prompt for complex tasks
            prompt = self.dynamic_prompt.generate(
                task_description=task.description,
                context_info=context_info,
                constraints=constraints,
                max_tokens=available_tokens,
                output_format="text",
            )

        logger.debug(f"Optimized prompt for task {task.id} with level {level.value}")
        return prompt

    def _build_context_info(self, task: Task) -> ContextInfo:
        """Build context information for the task"""
        context_info = ContextInfo()

        # Add project context
        if self.project_dir:
            project_path = Path(self.project_dir)
            context_info.files = [
                str(f)
                for f in project_path.iterdir()
                if f.is_file() and f.suffix in [".py", ".js", ".ts", ".json"]
            ][:5]  # Limit to 5 files

        # Add phase context
        if self.phase:
            context_info.recent_history = [f"Current phase: {self.phase}"]

        # Add agent type context
        if self.agent_type:
            context_info.recent_history.append(f"Agent type: {self.agent_type}")

        # Add constraints from task
        if task.constraints:
            context_info.constraints = task.constraints

        return context_info

    def _build_constraints(self, task: Task) -> dict[str, Any]:
        """Build constraints for the task"""
        constraints = {}

        # Add task constraints
        if task.constraints:
            constraints.update(task.constraints)

        # Add runtime constraints
        constraints.update(
            {
                "max_turns": self.max_turns,
                "project_dir": self.project_dir,
                "agent_type": self.agent_type,
                "use_copilot_cli": True,
            }
        )

        # Add CLI thinking constraint
        if self.cli_thinking:
            constraints["cli_thinking"] = self.cli_thinking

        return constraints

    def _estimate_task_tokens(self, task: Task) -> int:
        """Estimate tokens needed for a task"""
        # Base estimation from prompt
        prompt_tokens = len(task.description) // 4

        # Add overhead for Copilot CLI
        overhead = 200  # Approximate overhead for CLI interaction

        # Add context tokens
        context_tokens = 150  # Approximate context tokens

        return prompt_tokens + overhead + context_tokens

    async def run_session(
        self, prompt: str, tools: list[dict[str, Any]] | None = None, **kwargs
    ) -> Any:
        """
        Run a session with the original Copilot runtime.

        This method maintains compatibility with the original interface.
        """
        logger.info("Running optimized Copilot session")

        # Create a task for internal tracking
        task = Task(
            id=f"session_{self.get_current_time()}",
            description=prompt,
            complexity=TaskComplexity.MEDIUM,
            priority="normal",
        )

        # Execute with optimization
        result = self.execute_task(task)

        # Return in original format
        if result.success:
            # Create a mock session result
            from .copilot_runtime import SessionResult, SessionStatus

            return SessionResult(
                status=SessionStatus.COMPLETE,
                response=result.result,
                error_info=None,
                tool_calls_count=0,
                usage=None,
            )
        else:
            # Return error result
            from .copilot_runtime import SessionResult, SessionStatus

            return SessionResult(
                status=SessionStatus.ERROR,
                response=None,
                error_info=result.error,
                tool_calls_count=0,
                usage=None,
            )

    async def stream_session(
        self, prompt: str, tools: list[dict[str, Any]] | None = None, **kwargs
    ):
        """
        Stream a session with the original Copilot runtime.

        This method maintains compatibility with the original interface.
        """
        # For streaming, we'll use the original runtime directly
        # but still track token usage

        # Estimate and record token usage
        estimated_tokens = len(prompt) // 4 + 350  # Approximate
        self.token_tracker.record_usage(
            agent_id=self.agent_id,
            task_id=f"stream_{self.get_current_time()}",
            token_type="input",
            tokens_used=estimated_tokens,
        )

        # Stream using original runtime
        async for chunk in self.original_runtime.stream_session(
            prompt, tools, **kwargs
        ):
            yield chunk

    def get_current_time(self) -> float:
        """Get current timestamp"""
        import time

        return time.time()

    def set_optimization_level(self, level: PromptLevel):
        """Set the optimization level for prompts"""
        self.context_level = level
        logger.info(f"Set optimization level to {level.value}")

    def enable_prompt_optimization(self, enabled: bool = True):
        """Enable or disable prompt optimization"""
        self.auto_optimize_prompts = enabled
        logger.info(f"Prompt optimization {'enabled' if enabled else 'disabled'}")

    def get_optimization_stats(self) -> dict[str, Any]:
        """Get optimization statistics"""
        base_stats = self.get_performance_stats()

        optimization_stats = {
            "auto_optimize_prompts": self.auto_optimize_prompts,
            "context_level": self.context_level.value,
            "original_runtime_active": True,
        }

        base_stats.update(optimization_stats)
        return base_stats
