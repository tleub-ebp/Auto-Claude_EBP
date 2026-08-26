"""Emitting the subagent registry, and translating tool names on the way out.

Two properties, and the second is the one that fails invisibly.

**The registry reaches every harness that can hold agents.** Before this, the
specialists existed only as Python objects, so a developer driving Copilot got
none of them — the pipeline had a `test-runner` that knew the project's
commands and the editor had nothing.

**Tool names are translated.** Copilot calls `Read` `view`. A tool list a
harness cannot match is a tool list it *ignores*, which means a read-only
reviewer silently receives every tool there is. Nothing about the emitted file
looks wrong; the agent just quietly stops being read-only.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.agents import (  # noqa: E402
    EmittedAgent,
    collect_registry_agents,
    emit_for_harness,
    render_agent,
)
from skills_registry.harnesses import load_harnesses  # noqa: E402

MATRIX = load_harnesses(REPO_ROOT)

READ_ONLY = EmittedAgent(
    name="code-reviewer",
    description="Reviews a diff without touching it.",
    prompt="You review code.",
    tools=("Read", "Grep", "Glob"),
    origin="kanban",
)


# ── the tool map ──────────────────────────────────────────────────────────────


def test_the_canonical_harnesses_need_no_translation():
    for name in ("agnostic", "claude-code"):
        translated, unknown = MATRIX[name].translate_tools(["Read", "Bash"])
        assert translated == ["Read", "Bash"]
        assert unknown == []


def test_copilot_gets_its_own_vocabulary():
    """The names `.github/chatmodes/` in this repo already uses."""
    translated, unknown = MATRIX["copilot"].translate_tools(
        ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
    )
    assert translated == ["view", "create", "edit", "runCommands", "grep", "glob"]
    assert unknown == []


def test_an_unmapped_tool_passes_through_and_is_reported():
    """Dropping it would leave an agent silently unable to do its job."""
    harness = MATRIX["copilot"]
    translated, unknown = harness.translate_tools(["Read", "WebFetch"])
    assert translated == ["view", "WebFetch"]
    assert unknown == ["WebFetch"]


def test_a_harness_with_an_empty_map_reports_nothing():
    """`{}` means "speaks the canonical vocabulary", not "mapping forgotten".

    Codex declares it deliberately: its real vocabulary is unverified, and a
    guess would produce definitions that look translated and grant nothing.
    """
    translated, unknown = MATRIX["codex"].translate_tools(["Read", "Bash"])
    assert translated == ["Read", "Bash"]
    assert unknown == []


def test_every_tool_the_registry_uses_is_mapped_for_copilot():
    """A gap here is a reviewer that quietly gains write access."""
    used = {tool for agent in collect_registry_agents() for tool in agent.tools}
    missing = used - set(MATRIX["copilot"].tools)
    assert not missing, f"copilot has no name for {sorted(missing)}"


# ── rendering ─────────────────────────────────────────────────────────────────


def test_the_rendered_file_carries_name_description_and_tools():
    body, _ = render_agent(READ_ONLY, MATRIX["agnostic"])
    assert body.startswith("---\n")
    assert "name: code-reviewer" in body
    assert "tools: [Read, Grep, Glob]" in body
    assert "You review code." in body


def test_the_rendered_file_says_where_it_came_from():
    """Editing a build output by hand is a mistake worth making obvious."""
    body, _ = render_agent(READ_ONLY, MATRIX["agnostic"])
    assert "roster: kanban" in body
    assert "source: apps/backend/agents/subagents/" in body


def test_a_description_with_a_colon_is_quoted():
    """An unquoted colon makes the frontmatter parse as a nested mapping."""
    agent = EmittedAgent(
        name="x", description="Does this: and that", prompt="p", tools=("Read",)
    )
    body, _ = render_agent(agent, MATRIX["agnostic"])
    assert 'description: "Does this: and that"' in body

    from skills_registry.frontmatter import parse_frontmatter

    meta, _rest = parse_frontmatter(body)
    assert meta["description"] == "Does this: and that"


def test_every_emitted_file_round_trips_through_the_frontmatter_parser():
    """The build's own parser has to be able to read the build's own output."""
    from skills_registry.frontmatter import parse_frontmatter

    for agent in collect_registry_agents():
        body, _ = render_agent(agent, MATRIX["agnostic"])
        meta, rest = parse_frontmatter(body)
        assert meta.get("name") == agent.name
        assert meta.get("description"), agent.name
        assert rest.strip(), f"{agent.name} rendered with an empty body"


def test_tools_are_translated_in_the_rendered_file():
    body, _ = render_agent(READ_ONLY, MATRIX["copilot"])
    assert "tools: [view, grep, glob]" in body
    assert "Read" not in body.split("---")[1], "canonical name leaked into copilot"


# ── emission per harness ──────────────────────────────────────────────────────


def test_agents_land_in_each_harness_own_directory():
    for name, expected in (
        ("agnostic", ".agents/agents"),
        ("claude-code", ".claude/agents"),
        ("copilot", ".github/agents"),
        ("codex", ".codex/agents"),
    ):
        emission = emit_for_harness(MATRIX[name], [READ_ONLY])
        assert list(emission.files) == [f"{expected}/code-reviewer.md"], name


@pytest.mark.parametrize("name", ["cursor", "gemini", "opencode"])
def test_a_harness_with_no_subagents_gets_no_agent_files(name: str):
    """Writing a persona into its skills directory would present a delegation
    target as instructions the user is meant to follow."""
    assert emit_for_harness(MATRIX[name], [READ_ONLY]).files == {}


def test_the_registry_is_not_empty():
    agents = collect_registry_agents()
    assert len(agents) >= 10, [a.name for a in agents]


def test_every_roster_is_represented():
    origins = {a.origin for a in collect_registry_agents()}
    assert {"kanban", "planner", "qa", "pr-review"} <= origins


def test_names_are_unique():
    names = [a.name for a in collect_registry_agents()]
    assert len(names) == len(set(names))


def test_pr_review_agents_point_at_their_real_prompt_file():
    """The emitted definition carries the fallback; the full text is a file the
    runner loads at review time, and the reader should be told where."""
    agents = {a.name: a for a in collect_registry_agents()}
    body = agents["security-reviewer"].prompt
    assert "prompts/github/pr_security_agent.md" in body


def test_warnings_name_the_agent_and_the_file_to_edit():
    emission = emit_for_harness(
        MATRIX["copilot"],
        [EmittedAgent("x", "d", "p", tools=("Read", "NotAThing"))],
    )
    warnings = emission.warnings()
    assert len(warnings) == 1
    assert "NotAThing" in warnings[0]
    assert "capabilities/harnesses.yaml" in warnings[0]


# ── what this repo has committed ──────────────────────────────────────────────


def test_the_committed_output_matches_the_registry():
    """`.agents/agents/` is build output, so it must equal what the code says."""
    on_disk = {p.stem for p in (REPO_ROOT / ".agents" / "agents").glob("*.md")}
    assert on_disk == {a.name for a in collect_registry_agents()}


def test_the_committed_output_is_byte_identical_to_a_fresh_render():
    for agent in collect_registry_agents():
        expected, _ = render_agent(agent, MATRIX["agnostic"])
        path = REPO_ROOT / ".agents" / "agents" / f"{agent.name}.md"
        assert path.read_text(encoding="utf-8") == expected, (
            f"{agent.name} was hand-edited; run `pnpm run skills:build`"
        )
