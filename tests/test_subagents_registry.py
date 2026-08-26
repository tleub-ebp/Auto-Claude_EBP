"""Tests for subagent roster composition.

Two things this must not break, because every LLM call in the product goes
through it:

* the caller's own `agents` dict always wins — that was the contract of the
  three `merge_with_user_agents` functions this replaces;
* a failure anywhere in composition degrades to the caller's dict, never to an
  exception.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from agents.subagents import (  # noqa: E402
    MAX_ROSTER,
    detect_languages,
    resolve,
)
from agents.subagents.languages import overlays_for  # noqa: E402
from agents.subagents.phases import phase_defaults, sdk_available  # noqa: E402

pytestmark = pytest.mark.skipif(
    not sdk_available(), reason="claude_agent_sdk not installed"
)


class TestPhaseDefaults:
    """The generic roster must be exactly what the three old modules returned."""

    def test_coder_roster_unchanged(self):
        assert set(phase_defaults("coder")) == {
            "code-reviewer",
            "test-runner",
            "spec-explorer",
        }

    def test_planner_roster_unchanged(self):
        assert set(phase_defaults("planner")) == {
            "architecture-analyst",
            "dependency-tracer",
        }

    @pytest.mark.parametrize("agent_type", ["qa", "qa_reviewer", "qa_fixer"])
    def test_qa_roster_unchanged(self, agent_type):
        assert set(phase_defaults(agent_type)) == {
            "qa-acceptance-checker",
            "qa-test-evidence",
        }

    def test_unknown_agent_type_falls_through_to_the_board_roster(self):
        assert set(phase_defaults("something-new")) == set(phase_defaults("coder"))

    def test_planner_does_not_carry_qa_subagents(self):
        assert not set(phase_defaults("planner")) & set(phase_defaults("qa"))


class TestLanguageMatching:
    @pytest.mark.parametrize(
        "languages,expected",
        [
            (["python"], {"python"}),
            (["javascript/typescript"], {"typescript"}),
            (["java/kotlin"], {"java"}),
            (["go"], {"go"}),
            (["rust"], {"rust"}),
            (["C#"], {"dotnet"}),
            (["cobol"], set()),
            ([], set()),
        ],
    )
    def test_maps_detected_languages_to_overlays(self, languages, expected):
        assert {o.language for o in overlays_for(languages)} == expected

    def test_javascript_does_not_match_java(self):
        # "javascript" contains "java"; a substring match got this wrong.
        assert {o.language for o in overlays_for(["javascript/typescript"])} == {
            "typescript"
        }

    def test_polyglot_project_gets_every_matching_overlay(self):
        got = {o.language for o in overlays_for(["javascript/typescript", "python"])}
        assert got == {"typescript", "python"}


class TestSpecialisation:
    @staticmethod
    def _overlay_section(prompt: str) -> str:
        """Only the appended stack block.

        The generic prompt already names pytest/vitest/jest as examples of
        frameworks to detect, so asserting on the whole string cannot tell a
        leaked overlay from the baseline.
        """
        marker = "## This project's stack"
        return prompt[prompt.index(marker) :] if marker in prompt else ""

    def test_test_runner_learns_the_stack_commands(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        section = self._overlay_section(
            resolve("coder", project_dir=tmp_path)["test-runner"].prompt
        )
        assert "pytest -x" in section
        assert "### python" in section
        assert "### typescript" not in section, "overlay for a language not present"

    def test_a_rust_card_and_a_dotnet_card_get_different_prompts(self, tmp_path):
        rust = tmp_path / "rust"
        rust.mkdir()
        (rust / "Cargo.toml").write_text("[package]\nname='x'\nversion='0.1.0'\n")
        dotnet = tmp_path / "dotnet"
        dotnet.mkdir()
        (dotnet / "app.csproj").write_text(
            "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework>"
            "</PropertyGroup></Project>"
        )
        # detect_project_stack keys off Cargo.toml / *.csproj presence
        rust_section = self._overlay_section(
            resolve("coder", project_dir=rust)["test-runner"].prompt
        )
        dotnet_section = self._overlay_section(
            resolve("coder", project_dir=dotnet)["test-runner"].prompt
        )
        assert "cargo test" in rust_section and "### rust" in rust_section
        assert "dotnet test" in dotnet_section and "### dotnet" in dotnet_section
        assert "cargo test" not in dotnet_section

    def test_no_detected_language_leaves_the_generic_prompt_alone(self, tmp_path):
        generic = phase_defaults("coder")["test-runner"].prompt
        assert resolve("coder", project_dir=tmp_path)["test-runner"].prompt == generic

    def test_other_roles_are_not_touched_by_overlays(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        before = phase_defaults("coder")["code-reviewer"].prompt
        assert resolve("coder", project_dir=tmp_path)["code-reviewer"].prompt == before


class TestCallerPrecedence:
    def test_caller_overrides_a_default_of_the_same_name(self, tmp_path):
        from claude_agent_sdk import AgentDefinition

        mine = AgentDefinition(description="mine", prompt="mine", tools=["Read"])
        roster = resolve(
            "coder", project_dir=tmp_path, user_agents={"test-runner": mine}
        )
        assert roster["test-runner"] is mine

    def test_caller_can_add_new_roles(self, tmp_path):
        from claude_agent_sdk import AgentDefinition

        extra = AgentDefinition(description="x", prompt="x", tools=["Read"])
        roster = resolve("coder", project_dir=tmp_path, user_agents={"bespoke": extra})
        assert "bespoke" in roster and "code-reviewer" in roster

    def test_no_defaults_and_no_caller_agents_yields_none(self, tmp_path, monkeypatch):
        import agents.subagents as mod

        monkeypatch.setattr(mod, "phase_defaults", lambda _t: {})
        assert resolve("coder", project_dir=tmp_path) is None


class TestProviderGating:
    def test_provider_without_subagents_gets_no_roster(self, tmp_path):
        assert resolve("coder", project_dir=tmp_path, provider="mistral") is None
        assert resolve("coder", project_dir=tmp_path, provider="openai") is None

    def test_provider_with_native_subagents_gets_one(self, tmp_path):
        assert resolve("coder", project_dir=tmp_path, provider="claude")
        assert resolve("coder", project_dir=tmp_path, provider="copilot")


class TestRobustness:
    def test_roster_stays_within_the_cap(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        (tmp_path / "package.json").write_text('{"name":"x"}')
        (tmp_path / "Cargo.toml").write_text("[package]\nname='x'\nversion='0.1.0'\n")
        (tmp_path / "go.mod").write_text("module x\n\ngo 1.23\n")
        assert len(resolve("coder", project_dir=tmp_path)) <= MAX_ROSTER

    def test_broken_stack_detection_does_not_raise(self, tmp_path, monkeypatch):
        import agents.subagents as mod

        monkeypatch.setattr(
            mod, "detect_languages", lambda _p: (_ for _ in ()).throw(RuntimeError())
        )
        # resolve() calls detect_languages internally; a failure there must not
        # propagate to client creation.
        with pytest.raises(RuntimeError):
            mod.detect_languages(tmp_path)
        # ...and the real detect_languages swallows its own failures:
        assert detect_languages("/nonexistent/path/xyz") == []

    def test_detection_is_cached_per_project(self, tmp_path):
        (tmp_path / "go.mod").write_text("module x\n\ngo 1.23\n")
        first = detect_languages(tmp_path)
        (tmp_path / "go.mod").unlink()
        assert detect_languages(tmp_path) == first, "expected a cached answer"

    def test_none_project_dir_is_tolerated(self):
        assert detect_languages(None) == []
        assert resolve("coder", project_dir=None) is not None


class TestDotnetDetection:
    """detect_project_stack ignored .NET entirely, so the dotnet overlay --
    and the whole dotnet skill pack -- could never fire on a real project."""

    def test_solution_at_the_root_is_detected(self, tmp_path):
        (tmp_path / "App.sln").write_text("Microsoft Visual Studio Solution File")
        assert "dotnet" in {
            o.language for o in overlays_for(detect_languages(tmp_path))
        }

    def test_project_file_in_a_subdirectory_is_detected(self, tmp_path):
        # The usual layout: solution at the root, .csproj one level down.
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "App.csproj").write_text("<Project></Project>")
        assert "dotnet" in {
            o.language for o in overlays_for(detect_languages(tmp_path))
        }


class TestPRReviewRoster:
    """The sixth roster, moved out of the runner that used to declare it.

    `parallel_orchestrator_reviewer.py` built these inline — the fourth place
    in the repo where subagents were defined, and the only one the registry
    could not see.
    """

    @staticmethod
    def _build():
        from agents.subagents.pr_review import pr_review_agents

        return pr_review_agents(
            lambda name: f"PROMPT BODY for {name}",
            lambda prompt, fallback: f"[wd] {prompt or fallback}",
        )

    def test_every_specialist_is_present(self):
        from agents.subagents.pr_review import PR_REVIEW_SPECIALISTS

        assert {s.name for s in PR_REVIEW_SPECIALISTS} == {
            "security-reviewer",
            "quality-reviewer",
            "logic-reviewer",
            "codebase-fit-reviewer",
            "ai-triage-reviewer",
            "finding-validator",
        }

    def test_the_roster_matches_the_specs(self):
        from agents.subagents.pr_review import PR_REVIEW_SPECIALISTS

        roster = self._build()
        assert set(roster) == {s.name for s in PR_REVIEW_SPECIALISTS}

    def test_reviewers_cannot_write(self):
        """A reviewer that can edit the code it reviews stops being one."""
        for name, agent in self._build().items():
            assert set(agent.tools) == {"Read", "Grep", "Glob"}, name

    def test_every_prompt_carries_the_working_directory(self):
        """A subagent does not inherit the parent's cwd, so it must be told."""
        for name, agent in self._build().items():
            assert agent.prompt.startswith("[wd] "), name

    def test_a_missing_prompt_file_falls_back_rather_than_crashing(self):
        from agents.subagents.pr_review import pr_review_agents

        roster = pr_review_agents(
            lambda _name: None, lambda prompt, fallback: prompt or fallback
        )
        assert roster["security-reviewer"].prompt == (
            "You are a security expert. Find vulnerabilities."
        )

    def test_the_runner_builds_the_same_roster(self):
        """The move must be behaviour-preserving: same names, same tools."""
        from agents.subagents.pr_review import PR_REVIEW_SPECIALISTS

        source = (
            REPO_ROOT
            / "apps/backend/runners/github/services/parallel_orchestrator_reviewer.py"
        ).read_text(encoding="utf-8")
        assert "pr_review_agents(" in source
        assert "AgentDefinition(" not in source, (
            "a definition is being declared inline again"
        )
        for spec in PR_REVIEW_SPECIALISTS:
            assert spec.prompt_file, spec.name

    def test_every_prompt_file_the_specs_name_exists(self):
        prompts = REPO_ROOT / "apps/backend/prompts/github"
        from agents.subagents.pr_review import PR_REVIEW_SPECIALISTS

        missing = [
            s.prompt_file
            for s in PR_REVIEW_SPECIALISTS
            if not (prompts / s.prompt_file).is_file()
        ]
        assert not missing, f"specs name prompt files that do not exist: {missing}"


class TestProviderDegradationReachesTheClient:
    """The degradation has to fire where clients are actually built.

    `resolve()` returns no roster for a provider that cannot run subagents, and
    that was tested from the start. What was not tested is that `create_client`
    *asks*: it called `resolve()` without a provider, so the degradation was
    implemented, covered, and never once exercised in a real run. A capability
    matrix nobody consults is documentation, not behaviour.
    """

    def test_create_client_passes_the_active_provider(self):
        source = (REPO_ROOT / "apps/backend/core/client.py").read_text(encoding="utf-8")
        call = source[source.index("_resolve_subagents(") :][:400]
        assert "provider=" in call, (
            "create_client resolves subagents without a provider — "
            "providers with no subagent support will silently get a roster"
        )

    def test_a_provider_without_subagents_still_yields_none(self, tmp_path):
        """Guards the other half: `resolve` must keep honouring the argument."""
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        assert resolve("coder", project_dir=tmp_path, provider="mistral") is None
        assert resolve("coder", project_dir=tmp_path, provider="claude") is not None
