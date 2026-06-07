"""
Default subagent definitions for QA phases (qa_reviewer / qa_fixer).

Mirrors the pattern in agents/kanban_subagents.py. The main QA agent can
delegate to these isolated subagents so heavy file inspection or browser
runs don't accumulate in the parent's context window.

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


def get_default_qa_subagents() -> dict[str, Any] | None:
    """Read-only QA helpers that keep the main QA agent's context lean.

    - `qa-acceptance-checker`: Walks acceptance criteria in implementation_plan.json
      against the actual diff. Read-only so it can run in parallel with other checks.
    - `qa-test-evidence`: Executes the test commands declared in the plan and
      reports pass/fail summaries without dumping full stdout into the parent.
    """
    if not _SDK_AVAILABLE or AgentDefinition is None:
        return None

    return {
        "qa-acceptance-checker": AgentDefinition(
            description=(
                "Read-only acceptance criteria auditor. Use during qa_reviewer "
                "to verify each acceptance bullet against the diff without "
                "polluting the main agent's context."
            ),
            prompt=(
                "You are a QA acceptance auditor.\n\n"
                "Steps:\n"
                "1. Read implementation_plan.json to extract `final_acceptance` bullets.\n"
                "2. For each bullet, grep / read the diff to find evidence.\n"
                "3. Report a structured summary: which bullets are met, which "
                "are missing evidence, which have ambiguous evidence.\n\n"
                "Quote file:line for every claim. Never modify files."
            ),
            tools=["Read", "Grep", "Glob"],
            model="sonnet",
        ),
        "qa-test-evidence": AgentDefinition(
            description=(
                "Runs the project's test suite and returns a condensed pass/fail "
                "report. Use during qa_reviewer to gather evidence without "
                "loading megabytes of test output into the parent."
            ),
            prompt=(
                "You are a test-evidence collector.\n\n"
                "Detect the test framework (pytest, vitest, jest, …), run it, "
                "and produce a structured report:\n"
                "- Total / passed / failed / skipped counts.\n"
                "- For each failure: test name, file:line, one-line reason.\n"
                "Do NOT attempt any fix. Bash is allowed for execution only."
            ),
            tools=["Bash", "Read", "Grep", "Glob"],
        ),
    }


def merge_with_user_agents(
    user_agents: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Merge defaults with caller-supplied agents. Caller wins on key collision."""
    defaults = get_default_qa_subagents()
    if not defaults and not user_agents:
        return None
    merged: dict[str, Any] = {}
    if defaults:
        merged.update(defaults)
    if user_agents:
        merged.update(user_agents)
    return merged or None
