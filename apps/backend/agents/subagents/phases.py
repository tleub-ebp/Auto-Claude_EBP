"""Phase-default subagents, unchanged from the three modules they replace.

These are the generic roster: what every task of a given phase gets before any
language specialisation. `agents/kanban_subagents.py`,
`agents/planner_subagents.py` and `agents/qa_subagents.py` held exactly these
definitions and did nothing else; the prompts below are theirs, verbatim.

Selection by phase is deliberate — the planner should not carry QA subagents
into its context, and vice versa.

Declared as `AgentSpec`, converted on demand
--------------------------------------------
The rosters used to be built as `AgentDefinition`s directly, which tied them to
the Claude SDK being importable and made them unreadable to anything else. They
are plain data now, and `phase_defaults()` converts them at the point of use.

That is what lets `skills-cli build` emit the same roster into `.github/agents/`
and `.codex/agents/`: one source, N outputs, the same rule the skills follow.
A developer driving Copilot directly gets the specialists the pipeline uses
instead of a different set nobody maintains.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Imported lazily so this module can be imported in test environments where
# claude_agent_sdk is not installed.
try:
    from claude_agent_sdk import AgentDefinition

    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    AgentDefinition = None  # type: ignore[assignment,misc]
    _SDK_AVAILABLE = False

__all__ = [
    "AgentSpec",
    "sdk_available",
    "phase_defaults",
    "phase_specs",
    "all_specs",
    "PHASE_ALIASES",
]


@dataclass(frozen=True)
class AgentSpec:
    """One subagent, as data.

    Field names match `AgentDefinition`'s on purpose: converting is a splat,
    and a reader comparing the two does not have to translate.
    """

    description: str
    prompt: str
    tools: list[str] = field(default_factory=list)
    model: str | None = None

    def to_definition(self) -> Any:
        """The SDK object. Caller must have checked `sdk_available()`."""
        kwargs: dict[str, Any] = {
            "description": self.description,
            "prompt": self.prompt,
            "tools": list(self.tools),
        }
        if self.model:
            kwargs["model"] = self.model
        return AgentDefinition(**kwargs)


# agent_type -> phase. Everything unlisted falls through to "kanban", which is
# the roster for an ordinary board card.
PHASE_ALIASES: dict[str, str] = {
    "qa_reviewer": "qa",
    "qa_fixer": "qa",
    "qa": "qa",
    "planner": "planner",
    "architect": "planner",
}


def sdk_available() -> bool:
    return _SDK_AVAILABLE and AgentDefinition is not None


def _kanban() -> dict[str, AgentSpec]:
    return {
        "code-reviewer": AgentSpec(
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
        "test-runner": AgentSpec(
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
        "spec-explorer": AgentSpec(
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


def _planner() -> dict[str, AgentSpec]:
    return {
        "architecture-analyst": AgentSpec(
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
        "dependency-tracer": AgentSpec(
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


def _qa() -> dict[str, AgentSpec]:
    return {
        "qa-acceptance-checker": AgentSpec(
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
        "qa-test-evidence": AgentSpec(
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


_BUILDERS = {"kanban": _kanban, "planner": _planner, "qa": _qa}


def phase_specs(agent_type: str) -> dict[str, AgentSpec]:
    """The generic roster for ``agent_type``, as data.

    Available with or without the SDK, which is what the build needs: emitting
    `.github/agents/` must not depend on a Python package the harness in
    question has nothing to do with.
    """
    phase = PHASE_ALIASES.get(agent_type, "kanban")
    return _BUILDERS[phase]()


def all_specs() -> dict[str, dict[str, AgentSpec]]:
    """Every phase roster, keyed by phase. For the build, not for a run."""
    return {phase: builder() for phase, builder in _BUILDERS.items()}


def phase_defaults(agent_type: str) -> dict[str, Any]:
    """The generic roster for ``agent_type``. Empty when the SDK is absent."""
    if not sdk_available():
        return {}
    return {
        name: spec.to_definition() for name, spec in phase_specs(agent_type).items()
    }
