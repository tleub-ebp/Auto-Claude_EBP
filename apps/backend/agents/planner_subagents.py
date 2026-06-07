"""
Default subagent definitions for the planner agent.

The planner spends a large chunk of its turns exploring the existing
architecture before producing implementation_plan.json. Delegating the
exploration to a read-only subagent keeps the parent context focused on
the plan itself.

See: https://code.claude.com/docs/en/agent-sdk/subagents
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

try:
    from claude_agent_sdk import AgentDefinition

    _SDK_AVAILABLE = True
except ImportError:
    AgentDefinition = None  # type: ignore[assignment,misc]
    _SDK_AVAILABLE = False


def get_default_planner_subagents() -> dict[str, Any] | None:
    """Subagents the planner can delegate exploration work to."""
    if not _SDK_AVAILABLE or AgentDefinition is None:
        return None

    return {
        "architecture-analyst": AgentDefinition(
            description=(
                "Read-only architecture analyst. Use when the planner needs "
                "to understand existing module boundaries, dependency graphs, "
                "or framework conventions before writing a plan."
            ),
            prompt=(
                "You are a software architecture analyst.\n\n"
                "When the planner asks you about a feature area:\n"
                "1. Map the relevant directories with Glob.\n"
                "2. Identify the entry points, primary classes, and shared "
                "utilities with Grep + Read.\n"
                "3. Report a concise structural summary: where things live, "
                "which patterns are used, which conventions matter.\n\n"
                "Never modify files. Return at most ~400 words."
            ),
            tools=["Read", "Grep", "Glob"],
            model="sonnet",
        ),
        "dependency-tracer": AgentDefinition(
            description=(
                "Traces how a function, class or file is used across the "
                "codebase. Use when the planner needs blast-radius "
                "information for a refactor."
            ),
            prompt=(
                "You are a dependency tracer.\n\n"
                "Given a target symbol or file path:\n"
                "1. Grep for direct and indirect references.\n"
                "2. Group call sites by module / feature area.\n"
                "3. Flag obviously hot code paths (called from many places, "
                "called from tests, called from public API surfaces).\n\n"
                "Return a structured list. Never edit anything."
            ),
            tools=["Read", "Grep", "Glob"],
            model="sonnet",
        ),
    }


def merge_with_user_agents(
    user_agents: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Merge planner defaults with caller-supplied agents. Caller wins."""
    defaults = get_default_planner_subagents()
    if not defaults and not user_agents:
        return None
    merged: dict[str, Any] = {}
    if defaults:
        merged.update(defaults)
    if user_agents:
        merged.update(user_agents)
    return merged or None
