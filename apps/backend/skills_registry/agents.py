"""Emitting the subagent registry as harness-readable agent definitions.

`apps/backend/agents/subagents/` is where WorkPilot's specialists are written,
and until now it was the only place they existed. That made them invisible to
anyone driving Copilot or Codex directly: the pipeline had a `test-runner` that
knew the project's commands, and the developer in their editor had nothing.

This is the same "one source, N outputs" rule the skills follow, applied to
agents. The registry stays the source; `.agents/agents/`, `.github/agents/` and
`.codex/agents/` become build output, verified by `skills:check` like the rest.

Tool names are translated
-------------------------
The registry is written in Claude Code's vocabulary because that is what the
SDK takes. Copilot calls `Read` `view` and `Bash` `runCommands`. Emitting the
canonical names into `.github/agents/` produces a definition the harness cannot
match, and a tool list a harness cannot match is a tool list it ignores — so
the agent silently gets everything instead of the read-only set it was scoped
to. `capabilities/harnesses.yaml` carries the mapping and the build applies it.

An unmapped name is emitted unchanged **and reported**. See
`Harness.translate_tools` for why that beats dropping it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .harnesses import Harness

logger = logging.getLogger(__name__)

__all__ = [
    "EmittedAgent",
    "AgentEmission",
    "collect_registry_agents",
    "render_agent",
    "emit_for_harness",
]


@dataclass(frozen=True)
class EmittedAgent:
    """One agent about to be written, before any harness translation."""

    name: str
    description: str
    prompt: str
    tools: tuple[str, ...] = ()
    model: str | None = None
    origin: str = ""
    """Which roster it came from — `kanban`, `qa`, `pr-review`, …"""


@dataclass
class AgentEmission:
    """What was rendered for one harness, and what could not be translated."""

    harness: str
    files: dict[str, str] = field(default_factory=dict)
    """Relative path -> file content."""
    untranslated: dict[str, list[str]] = field(default_factory=dict)
    """Agent name -> tool names this harness has no word for."""

    def warnings(self) -> list[str]:
        return [
            f"{self.harness}: {agent} names tool(s) with no mapping "
            f"({', '.join(tools)}) — add them to capabilities/harnesses.yaml"
            for agent, tools in sorted(self.untranslated.items())
        ]


def collect_registry_agents() -> list[EmittedAgent]:
    """Every agent the Python registry describes.

    Reads the declarative specs rather than building SDK objects, so this works
    in an environment that has no `claude_agent_sdk` — which the build must,
    since emitting `.github/agents/` has nothing to do with Anthropic's SDK
    being installed.

    Degrades to an empty list rather than raising: a repo that vendors the
    registry away should still be able to build its skills.
    """
    found: list[EmittedAgent] = []
    try:
        from agents.subagents.phases import all_specs

        for phase, roster in all_specs().items():
            found.extend(
                EmittedAgent(
                    name=name,
                    description=spec.description,
                    prompt=spec.prompt,
                    tools=tuple(spec.tools),
                    model=spec.model,
                    origin=phase,
                )
                for name, spec in roster.items()
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("phase specs unavailable: %s", exc)

    try:
        from agents.subagents.pr_review import PR_REVIEW_SPECIALISTS

        found.extend(
            EmittedAgent(
                name=spec.name,
                description=spec.description,
                # The real prompt is a file under prompts/github/ that the
                # runner loads at review time and prefixes with a worktree
                # path. Neither is knowable here, so the emitted definition
                # carries the fallback and says where the full text lives.
                prompt=(
                    f"{spec.fallback}\n\n"
                    f"The full instructions for this role are in "
                    f"`apps/backend/prompts/github/{spec.prompt_file}`."
                ),
                tools=tuple(spec.tools),
                model="inherit",
                origin="pr-review",
            )
            for spec in PR_REVIEW_SPECIALISTS
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("pr-review specs unavailable: %s", exc)

    # Deduplicate by name, first roster wins, so a phase agent is not shadowed
    # by a later one with the same name.
    seen: set[str] = set()
    unique: list[EmittedAgent] = []
    for agent in found:
        if agent.name in seen:
            logger.debug("duplicate agent name %r, keeping the first", agent.name)
            continue
        seen.add(agent.name)
        unique.append(agent)
    return sorted(unique, key=lambda a: a.name)


def _yaml_scalar(text: str) -> str:
    """Quote a frontmatter value only when it would otherwise be ambiguous."""
    if (
        text
        and not any(ch in text for ch in ":#\n\"'{}[]&*!|>%@`")
        and text.strip() == text
    ):
        return text
    escaped = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{escaped}"'


def render_agent(agent: EmittedAgent, harness: Harness) -> tuple[str, list[str]]:
    """One agent as a markdown file for one harness, plus its unmapped tools."""
    tools, unknown = harness.translate_tools(list(agent.tools))

    lines = [
        "---",
        f"name: {agent.name}",
        f"description: {_yaml_scalar(agent.description)}",
    ]
    if tools:
        lines.append("tools: [" + ", ".join(_yaml_scalar(t) for t in tools) + "]")
    if agent.model:
        lines.append(f"model: {agent.model}")
    lines += [
        "metadata:",
        "  workpilot:",
        f"    roster: {agent.origin or 'unknown'}",
        "    source: apps/backend/agents/subagents/",
        "---",
        "",
        agent.prompt.rstrip(),
        "",
    ]
    return "\n".join(lines), unknown


def emit_for_harness(
    harness: Harness, agents: list[EmittedAgent] | None = None
) -> AgentEmission:
    """Render every registry agent into this harness's agents directory.

    A harness with no `agents_path` gets nothing. That is not an omission: it
    has no subagents, and writing personas into its *skills* directory would
    present a delegation target as instructions the user is meant to follow.
    """
    emission = AgentEmission(harness=harness.name)
    if not harness.agents_path:
        return emission

    for agent in agents if agents is not None else collect_registry_agents():
        body, unknown = render_agent(agent, harness)
        emission.files[f"{harness.agents_path}/{agent.name}.md"] = body
        if unknown:
            emission.untranslated[agent.name] = unknown
    return emission
