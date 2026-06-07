"""
Default subagent definitions for Kanban task execution.

Subagents isolate context: each one runs in its own fresh conversation, and
only its final summary returns to the parent. This keeps the main agent's
context window lean for long-running cards.

Wired into create_client() in core/client.py — the caller can pass their own
`agents` dict to override these on a per-card basis (caller wins on key
collision).

Docs: https://code.claude.com/docs/en/agent-sdk/subagents
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Import AgentDefinition lazily so the module can be imported in test
# environments where claude_agent_sdk isn't installed.
try:
    from claude_agent_sdk import AgentDefinition

    _SDK_AVAILABLE = True
except ImportError:
    AgentDefinition = None  # type: ignore[assignment,misc]
    _SDK_AVAILABLE = False


def get_default_kanban_subagents() -> dict[str, Any] | None:
    """
    Return the canonical Kanban subagent dict, or None if the SDK isn't loaded.

    Subagents:
      - code-reviewer: read-only quality/security review. Downgrade to Sonnet
        (lighter, cheaper) since reviews don't need Opus-level reasoning.
      - test-runner:   runs the test suite and analyses failures. Needs Bash.
      - spec-explorer: surveys the spec/ directory and returns a summary.
        Low effort — it's a directory scan, not deep reasoning.
    """
    if not _SDK_AVAILABLE or AgentDefinition is None:
        return None

    return {
        "code-reviewer": AgentDefinition(
            description=(
                "Read-only code quality and security reviewer. Use for diff "
                "reviews, PR audits, or any 'check this code before I commit' "
                "task. Cannot modify files."
            ),
            prompt=(
                "You are a senior code reviewer focused on quality, security, "
                "and maintainability.\n\n"
                "When reviewing code:\n"
                "- Flag security issues (injection, auth, secrets) first\n"
                "- Then correctness bugs, then maintainability concerns\n"
                "- Quote the exact file path and line number for each finding\n"
                "- Be specific — 'rename this variable' beats 'improve naming'\n"
                "- Skip cosmetic nits unless they hurt readability\n\n"
                "Return a structured summary the parent can act on, not prose."
            ),
            tools=["Read", "Grep", "Glob"],
            model="sonnet",
        ),
        "test-runner": AgentDefinition(
            description=(
                "Runs the project's test suite and reports failures with "
                "actionable detail. Use when a card asks for test execution "
                "or coverage analysis."
            ),
            prompt=(
                "You are a test execution specialist. Your job:\n"
                "1. Detect the test framework (pytest, vitest, jest, ...)\n"
                "2. Run the appropriate command\n"
                "3. Parse failures — for each, report the test name, the "
                "expected vs actual values, and the file:line of the assertion\n"
                "4. Do NOT attempt fixes. Just report.\n\n"
                "If the test command takes more than a few minutes, run it in "
                "the background and report partial results."
            ),
            tools=["Bash", "Read", "Grep", "Glob"],
        ),
        "spec-explorer": AgentDefinition(
            description=(
                "Surveys a spec/ directory (or any documentation tree) and "
                "returns a concise structural summary. Use when the parent "
                "needs to orient before deep work."
            ),
            prompt=(
                "You are a spec explorer. Map the directory you're given:\n"
                "- List every file with its purpose in one line\n"
                "- Flag inconsistencies (e.g. requirements that mention a "
                "feature missing from the implementation plan)\n"
                "- Surface TODOs, FIXMEs, and 'open question' markers\n\n"
                "Return only the summary. Do not edit files."
            ),
            tools=["Read", "Grep", "Glob"],
        ),
    }


def merge_with_user_agents(
    user_agents: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """
    Merge default Kanban subagents with caller-supplied ones.

    User-supplied entries win on key collision. Returns None if neither side
    has anything to contribute (so the SDK option is omitted entirely).
    """
    defaults = get_default_kanban_subagents()
    if not defaults and not user_agents:
        return None
    merged: dict[str, Any] = {}
    if defaults:
        merged.update(defaults)
    if user_agents:
        merged.update(user_agents)  # caller wins
    return merged or None
