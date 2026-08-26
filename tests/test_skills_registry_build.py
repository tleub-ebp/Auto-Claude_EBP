"""Tests for materialising skills into harness outputs.

Three properties matter more than the rest:

* **Reproducible** — two machines must produce byte-identical output, or the
  CI `skills:check` gate fires on the path separator rather than on real drift.
* **Bounded ownership** — the build removes only what it emitted last time.
  `.agents/skills/` currently also holds 76 hand-committed BMAD directories; a
  generator that owned the whole directory would delete them on first run.
* **Idempotent** — a second build writes nothing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.build import apply_build, content_hash, plan_build  # noqa: E402
from skills_registry.frontmatter import parse_frontmatter, workpilot_meta  # noqa: E402
from skills_registry.packs import load_packs  # noqa: E402
from skills_registry.project import ProjectConfig  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402


@pytest.fixture
def source(tmp_path: Path) -> Path:
    """A miniature source repo: one pack, one skill with a bundled resource."""
    root = tmp_path / "src"
    (root / "capabilities").mkdir(parents=True)
    (root / "capabilities" / "harnesses.yaml").write_text(
        "agnostic:\n"
        "  skills_path: .agents/skills\n"
        "  agents_path: .agents/agents\n"
        "  commands_path: null\n"
        "  format: skill-dir\n"
        "  default: true\n"
        "gemini:\n"
        "  skills_path: .agents/skills\n"
        "  agents_path: null\n"
        "  commands_path: .gemini/commands\n"
        "  format: toml-command\n"
        "  default: false\n",
        encoding="utf-8",
    )
    pack = root / "skills" / "demo"
    (pack / "hello").mkdir(parents=True)
    (pack / "pack.json").write_text(
        json.dumps({"name": "demo", "version": "1.4.2", "targets": {}}),
        encoding="utf-8",
    )
    (pack / "hello" / "SKILL.md").write_text(
        "---\nname: hello\ndescription: says hello\n---\n\nSay hello.\n",
        encoding="utf-8",
    )
    (pack / "hello" / "reference.md").write_text("deep detail\n", encoding="utf-8")
    (pack / "agents").mkdir()
    (pack / "agents" / "greeter.md").write_text(
        "---\nname: greeter\ndescription: greets\n---\n\nGreet.\n", encoding="utf-8"
    )
    return root


def build(source: Path, out: Path, harnesses=("agnostic",), check_only=False):
    packs = load_packs(source / "skills")
    config = ProjectConfig(project_dir=out, targets={}, packs={})
    resolution = resolve(packs, config)
    plan = plan_build(source, resolution, list(harnesses))
    return apply_build(
        out,
        resolution,
        plan,
        list(harnesses),
        source_root=source,
        check_only=check_only,
    )


class TestOutputs:
    def test_emits_skill_agent_bundled_resource_and_lockfile(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        assert (out / ".agents/skills/hello/SKILL.md").is_file()
        assert (
            out / ".agents/skills/hello/reference.md"
        ).read_text() == "deep detail\n"
        assert (out / ".agents/agents/greeter.md").is_file()
        assert (out / "skills-lock.json").is_file()

    def test_injects_derived_provenance_into_frontmatter(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        meta, body = parse_frontmatter(
            (out / ".agents/skills/hello/SKILL.md").read_text(encoding="utf-8")
        )
        wp = workpilot_meta(meta)
        assert wp["pack"] == "demo"
        assert wp["version"] == "1.4.2"
        assert len(wp["content_sha256"]) == 64
        assert meta["name"] == "hello" and meta["description"] == "says hello"
        assert body.strip() == "Say hello."

    def test_body_carries_no_generator_preamble(self, source, tmp_path):
        """The note is for humans; in the body it would cost tokens on every run."""
        out = tmp_path / "out"
        build(source, out)
        _, body = parse_frontmatter(
            (out / ".agents/skills/hello/SKILL.md").read_text(encoding="utf-8")
        )
        assert not body.lstrip().startswith("<!--")

    def test_gemini_harness_emits_toml_commands(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out, harnesses=("agnostic", "gemini"))
        toml = (out / ".gemini/commands/hello.toml").read_text(encoding="utf-8")
        assert 'description = "says hello"' in toml
        assert "Say hello." in toml

    def test_lockfile_records_provenance_and_rejections(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        lock = json.loads((out / "skills-lock.json").read_text(encoding="utf-8"))
        assert lock["packs"]["demo"]["version"] == "1.4.2"
        assert lock["skills"]["hello"]["source"] == "skills/demo/hello/SKILL.md"
        assert len(lock["skills"]["hello"]["contentSha256"]) == 64
        assert ".agents/skills/hello/SKILL.md" in lock["emitted"]


class TestReproducibility:
    def test_no_absolute_paths_leak_into_the_output(self, source, tmp_path):
        # An absolute path would make `skills:check` fail on CI purely because
        # the checkout lives somewhere else.
        out = tmp_path / "out"
        build(source, out)
        for f in out.rglob("*"):
            if f.is_file() and f.suffix in (".md", ".json", ".toml"):
                text = f.read_text(encoding="utf-8")
                assert str(tmp_path) not in text, f"{f} leaks an absolute path"

    def test_same_source_two_destinations_gives_identical_documents(
        self, source, tmp_path
    ):
        a, b = tmp_path / "a", tmp_path / "b"
        build(source, a)
        build(source, b)
        assert (a / ".agents/skills/hello/SKILL.md").read_text() == (
            b / ".agents/skills/hello/SKILL.md"
        ).read_text()

    def test_content_hash_covers_bundled_resources(self, source, tmp_path):
        packs = load_packs(source / "skills")
        skill = next(s for s in packs[0].skills() if s.name == "hello")
        before = content_hash(skill)
        (source / "skills/demo/hello/reference.md").write_text(
            "changed\n", encoding="utf-8"
        )
        after = content_hash(
            next(
                s
                for s in load_packs(source / "skills")[0].skills()
                if s.name == "hello"
            )
        )
        assert before != after, "a change to a bundled file must move the hash"


class TestIdempotenceAndOwnership:
    def test_second_build_writes_nothing(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        second = build(source, out)
        assert not second.changed
        assert second.written == [] and second.removed == []

    def test_check_mode_passes_on_fresh_output_and_writes_nothing(
        self, source, tmp_path
    ):
        out = tmp_path / "out"
        build(source, out)
        result = build(source, out, check_only=True)
        assert not result.changed

    def test_check_mode_detects_a_hand_edit(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        target = out / ".agents/skills/hello/SKILL.md"
        original = target.read_text(encoding="utf-8")
        target.write_text(original + "\nsomeone edited the output\n", encoding="utf-8")
        result = build(source, out, check_only=True)
        assert result.changed
        # check mode must not repair it -- reporting is its whole job
        assert "someone edited" in target.read_text(encoding="utf-8")

    def test_files_the_build_never_emitted_are_left_alone(self, source, tmp_path):
        """The 76 hand-committed BMAD directories depend on this."""
        out = tmp_path / "out"
        build(source, out)
        foreign = out / ".agents/skills/hand-written/SKILL.md"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("---\nname: hand-written\n---\nbody\n", encoding="utf-8")
        build(source, out)
        assert foreign.is_file(), "the build deleted a file it never owned"

    def test_a_skill_that_stops_resolving_is_removed(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        emitted = out / ".agents/skills/hello/SKILL.md"
        assert emitted.is_file()
        # Make the skill inapplicable to this project.
        (source / "skills/demo/pack.json").write_text(
            json.dumps(
                {"name": "demo", "version": "1.4.2", "targets": {"dotnet": ">=99"}}
            ),
            encoding="utf-8",
        )
        result = build(source, out)
        assert not emitted.exists()
        assert Path(".agents/skills/hello/SKILL.md") in result.removed


class TestRuntimeGating:
    """The BMAD failure, pinned.

    76 SKILL.md wrappers were committed pointing at `_bmad/...`, a tree that is
    gitignored and generated by BMAD's own installer. On a fresh clone every one
    of them listed in the command palette and failed on invocation. A skill
    whose runtime is absent must not be emitted at all.
    """

    @staticmethod
    def _pack_with_runtime_gate(root: Path):
        pack = root / "skills" / "gated"
        (pack / "needs-alpha").mkdir(parents=True)
        (pack / "needs-beta").mkdir(parents=True)
        (pack / "pack.json").write_text(
            json.dumps({"name": "gated", "version": "1.0.0", "targets": {}}),
            encoding="utf-8",
        )
        for name, runtime in (
            ("needs-alpha", "_rt/alpha/workflow.yaml"),
            ("needs-beta", "_rt/beta/workflow.yaml"),
        ):
            (pack / name / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: {name}\n"
                f'metadata:\n  workpilot:\n    requires: {{ runtime: "{runtime}" }}\n'
                f"---\n\nbody\n",
                encoding="utf-8",
            )

    def test_nothing_is_emitted_while_the_runtime_is_missing(self, source, tmp_path):
        self._pack_with_runtime_gate(source)
        out = tmp_path / "out"
        build(source, out)
        assert not (out / ".agents/skills/needs-alpha").exists()
        assert not (out / ".agents/skills/needs-beta").exists()

    def test_they_appear_once_it_is_bootstrapped(self, source, tmp_path):
        self._pack_with_runtime_gate(source)
        out = tmp_path / "out"
        build(source, out)
        for rel in ("_rt/alpha/workflow.yaml", "_rt/beta/workflow.yaml"):
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("runtime\n", encoding="utf-8")
        build(source, out)
        assert (out / ".agents/skills/needs-alpha/SKILL.md").is_file()
        assert (out / ".agents/skills/needs-beta/SKILL.md").is_file()

    def test_gating_is_per_runtime_not_all_or_nothing(self, source, tmp_path):
        """Removing one BMAD module must not take the others down with it."""
        self._pack_with_runtime_gate(source)
        out = tmp_path / "out"
        for rel in ("_rt/alpha/workflow.yaml", "_rt/beta/workflow.yaml"):
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("runtime\n", encoding="utf-8")
        build(source, out)
        (out / "_rt/beta/workflow.yaml").unlink()
        build(source, out)
        assert (out / ".agents/skills/needs-alpha/SKILL.md").is_file()
        assert not (out / ".agents/skills/needs-beta").exists()


class TestRealBmadPack:
    def test_every_bmad_skill_declares_the_runtime_it_loads(self):
        """A wrapper without a gate is a command that fails on invocation."""
        from skills_registry.frontmatter import parse_frontmatter, workpilot_meta

        ungated = []
        for f in sorted((REPO_ROOT / "skills" / "bmad").glob("*/SKILL.md")):
            meta, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            requires = workpilot_meta(meta).get("requires") or {}
            if "runtime" not in requires:
                ungated.append(f.parent.name)
        assert not ungated, f"BMAD skills with no runtime gate: {ungated}"

    def test_declared_runtimes_point_inside_the_bmad_tree(self):
        from skills_registry.frontmatter import parse_frontmatter, workpilot_meta

        for f in sorted((REPO_ROOT / "skills" / "bmad").glob("*/SKILL.md")):
            meta, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            runtime = (workpilot_meta(meta).get("requires") or {}).get("runtime", "")
            assert runtime.startswith("_bmad/"), f"{f.parent.name}: {runtime!r}"


# ── harness detection ─────────────────────────────────────────────────────────
#
# Replaces `src/hybrid/ide_detector.py`, which answered a similar question from
# 421 lines of regexes over process names and environment variables, maintained
# apart from the capability matrix and already drifted from it. Deriving the
# answer from the matrix means there is one place to be right.


def test_a_bare_project_shows_no_harness_evidence(tmp_path: Path):
    """No evidence is the honest answer; the caller falls back to defaults."""
    from skills_registry.harnesses import detect_harnesses, load_harnesses

    assert detect_harnesses(tmp_path, load_harnesses(REPO_ROOT)) == []


def test_a_shared_skills_path_is_not_evidence_for_anyone(tmp_path: Path):
    """`.agents/skills/` is read by six of these tools.

    Counting it would report every harness on every repo, which is the same as
    reporting none while looking authoritative.
    """
    from skills_registry.harnesses import detect_harnesses, load_harnesses

    (tmp_path / ".agents" / "skills").mkdir(parents=True)
    assert detect_harnesses(tmp_path, load_harnesses(REPO_ROOT)) == []


@pytest.mark.parametrize(
    "marker,expected",
    [
        (".claude/settings.local.json", "claude-code"),
        (".github/hooks", "copilot"),
        (".cursor/hooks.json", "cursor"),
        (".gemini/commands", "gemini"),
        (".codex/hooks.json", "codex"),
    ],
)
def test_a_harness_specific_path_identifies_its_harness(
    tmp_path: Path, marker: str, expected: str
):
    from skills_registry.harnesses import detect_harnesses, load_harnesses

    path = tmp_path / marker
    if path.suffix:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    else:
        path.mkdir(parents=True)
    assert expected in detect_harnesses(tmp_path, load_harnesses(REPO_ROOT))


def test_detection_reports_every_harness_in_use(tmp_path: Path):
    from skills_registry.harnesses import detect_harnesses, load_harnesses

    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.local.json").write_text("{}", encoding="utf-8")
    (tmp_path / ".gemini" / "commands").mkdir(parents=True)
    found = detect_harnesses(tmp_path, load_harnesses(REPO_ROOT))
    assert set(found) == {"claude-code", "gemini"}


def test_detection_never_removes_the_default_outputs():
    """`--harness=auto` adds mirrors; it must not drop the canonical output.

    `.agents/skills/` is what the backend serves to the Kanban palette whatever
    editor the developer happens to run, so a build that omitted it because
    nobody had `.agents/` open would break the product.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "skills_cli", REPO_ROOT / "scripts" / "skills_cli.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    from skills_registry.harnesses import load_harnesses

    defaults = {n for n, h in load_harnesses(REPO_ROOT).items() if h.default}
    resolved = set(module._resolve_harnesses("auto", [], REPO_ROOT))
    assert defaults <= resolved


# ── one source, N outputs ─────────────────────────────────────────────────────


def _emitted_names(out: Path, harness) -> tuple[set[str], set[str]]:
    """(skills, agents) a harness's output actually offers.

    A TOML-command harness has one flat directory, so the two cannot be told
    apart from the filesystem — the caller compares their union there.
    """
    skills: set[str] = set()
    agents: set[str] = set()
    if harness.skills_path:
        base = out / harness.skills_path
        skills = (
            {p.parent.name for p in base.glob("*/SKILL.md")} if base.is_dir() else set()
        )
    if harness.agents_path:
        base = out / harness.agents_path
        agents = {p.stem for p in base.glob("*.md")} if base.is_dir() else set()
    if harness.format == "toml-command" and harness.commands_path:
        base = out / harness.commands_path
        skills |= {p.stem for p in base.glob("*.toml")} if base.is_dir() else set()
    return skills, agents


def test_every_harness_describes_the_same_set_of_skills(source, tmp_path):
    """One authored skill becomes N files — never N different sets.

    A mirror that drifts is worse than a missing one: the developer on Cursor
    and the developer on Gemini disagree about what the project can do, and
    neither has any reason to suspect it.

    Agents are held to the weaker promise their targets allow: they appear
    wherever the harness can carry them. Gemini has no subagents, so a persona
    is degraded to a slash command in the same flat directory as the skills —
    which is why that harness is compared on the union.

    Run against the repo's real capability matrix rather than the miniature
    one: the property is about the harnesses actually shipped, and a fixture
    listing two of them could not catch a third drifting.
    """
    import shutil

    from skills_registry.harnesses import load_harnesses

    shutil.copy(
        REPO_ROOT / "capabilities" / "harnesses.yaml",
        source / "capabilities" / "harnesses.yaml",
    )
    matrix = load_harnesses(REPO_ROOT)
    harnesses = ["agnostic", "claude-code", "copilot", "cursor", "gemini", "codex"]
    out = tmp_path / "out"
    build(source, out, harnesses=harnesses)

    from skills_registry.agents import collect_registry_agents

    expected_skills = {"hello"}
    # A harness that can hold agents gets the pack's own plus the Python
    # registry's — one source, N outputs, applied to agents as well as skills.
    expected_agents = {"greeter"} | {a.name for a in collect_registry_agents()}

    for name in harnesses:
        harness = matrix[name]
        skills, agents = _emitted_names(out, harness)
        if harness.format == "toml-command":
            # Gemini has no subagents, so a pack persona degrades to a command
            # in the same flat directory. The registry roster does not: those
            # are delegation targets, and a harness that cannot delegate has no
            # honest place for them.
            assert skills == expected_skills | {"greeter"}, name
            continue
        assert skills == expected_skills, f"{name} offers skills {sorted(skills)}"
        if harness.agents_path:
            assert agents == expected_agents, f"{name} offers agents {sorted(agents)}"


def test_a_harness_that_cannot_carry_agents_drops_them_rather_than_faking_them(
    source, tmp_path
):
    """Cursor is `modes-only`: there is nowhere honest to put a persona.

    Emitting it into `.cursor/skills/` would present an agent as a skill, and
    the user would invoke a delegation target as instructions.
    """
    import shutil

    shutil.copy(
        REPO_ROOT / "capabilities" / "harnesses.yaml",
        source / "capabilities" / "harnesses.yaml",
    )
    out = tmp_path / "out"
    build(source, out, harnesses=["cursor"])
    assert (out / ".cursor" / "skills" / "hello" / "SKILL.md").is_file()
    assert not (out / ".cursor" / "skills" / "greeter").exists()


def test_the_committed_outputs_of_this_repo_agree():
    """The same assertion, against what is actually checked in."""
    agnostic = {
        p.parent.name for p in (REPO_ROOT / ".agents" / "skills").glob("*/SKILL.md")
    }
    gemini = {p.stem for p in (REPO_ROOT / ".gemini" / "commands").glob("*.toml")}
    assert agnostic, ".agents/skills/ is empty"
    assert gemini == agnostic, f"gemini mirror has drifted: {agnostic ^ gemini}"


def test_the_plugin_marketplace_lists_what_was_emitted():
    import json

    manifest = json.loads(
        (REPO_ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
    )
    # Plugin names are namespaced so they do not collide with anyone else's in
    # a shared marketplace; the pack name is what the lockfile records.
    listed = {p["name"].removeprefix("workpilot-") for p in manifest.get("plugins", [])}
    lock = json.loads((REPO_ROOT / "skills-lock.json").read_text(encoding="utf-8"))
    packs_with_skills = {entry["pack"] for entry in (lock.get("skills") or {}).values()}
    assert listed >= packs_with_skills, (
        f"marketplace omits pack(s) that emitted skills: "
        f"{sorted(packs_with_skills - listed)}"
    )


def test_building_one_harness_does_not_delete_another(source, tmp_path):
    """`--harness=copilot` must leave `.agents/skills/` alone.

    The build owns its `emitted` list and prunes what a run no longer produces,
    which is right — but scoped to the harnesses that run produced. Without the
    scoping, asking for one mirror wiped the canonical output the backend
    serves, and reported it as ordinary cleanup.
    """
    import shutil

    shutil.copy(
        REPO_ROOT / "capabilities" / "harnesses.yaml",
        source / "capabilities" / "harnesses.yaml",
    )
    out = tmp_path / "out"
    build(source, out, harnesses=["agnostic"])
    assert (out / ".agents/skills/hello/SKILL.md").is_file()

    result = build(source, out, harnesses=["copilot"])
    assert (out / ".github/skills/hello/SKILL.md").is_file()
    assert (out / ".agents/skills/hello/SKILL.md").is_file(), (
        "a copilot-only build removed the agnostic output"
    )
    assert not [r for r in result.removed if ".agents" in str(r)]


def test_a_skill_that_stops_resolving_is_still_pruned_within_its_harness(
    source, tmp_path
):
    """Scoping the pruning must not turn it off."""
    import shutil

    shutil.copy(
        REPO_ROOT / "capabilities" / "harnesses.yaml",
        source / "capabilities" / "harnesses.yaml",
    )
    out = tmp_path / "out"
    build(source, out, harnesses=["agnostic"])
    assert (out / ".agents/skills/hello/SKILL.md").is_file()

    shutil.rmtree(source / "skills" / "demo" / "hello")
    build(source, out, harnesses=["agnostic"])
    assert not (out / ".agents/skills/hello/SKILL.md").exists()


def test_the_registry_agents_are_part_of_the_build(source, tmp_path):
    import shutil

    shutil.copy(
        REPO_ROOT / "capabilities" / "harnesses.yaml",
        source / "capabilities" / "harnesses.yaml",
    )
    out = tmp_path / "out"
    build(source, out, harnesses=["agnostic"])
    emitted = {p.stem for p in (out / ".agents" / "agents").glob("*.md")}
    assert "test-runner" in emitted, "the Python roster did not reach the output"
    assert "greeter" in emitted, "the pack's own agent was dropped"
