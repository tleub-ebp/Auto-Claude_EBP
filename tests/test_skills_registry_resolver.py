"""Tests for skill resolution: the three gates, and the non-regression promise.

The promise this file pins down: **a project targeting an older toolchain keeps
resolving to the skills written for it, no matter what newer variants ship.**
That is the whole reason the registry exists, so it is tested against synthetic
packs (fully controlled) as well as the real ones in `skills/`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.packs import PackError, load_packs  # noqa: E402
from skills_registry.project import ProjectConfig, load_project_config  # noqa: E402
from skills_registry.resolver import check_requires, resolve  # noqa: E402


def write_skill(
    pack_dir: Path, name: str, *, targets=None, requires=None, body="do it"
):
    d = pack_dir / name
    d.mkdir(parents=True, exist_ok=True)
    wp = {}
    if targets is not None:
        wp["targets"] = targets
    if requires is not None:
        wp["requires"] = requires
    meta = f"name: {name}\ndescription: {name} description\n"
    if wp:
        meta += "metadata:\n  workpilot:\n"
        for key, value in wp.items():
            meta += f"    {key}: {json.dumps(value)}\n"
    (d / "SKILL.md").write_text(f"---\n{meta}---\n\n{body}\n", encoding="utf-8")
    return d


def write_pack(root: Path, name: str, version: str, targets: dict) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "pack.json").write_text(
        json.dumps({"name": name, "version": version, "targets": targets}),
        encoding="utf-8",
    )
    return d


@pytest.fixture
def skills_root(tmp_path: Path) -> Path:
    """A two-variant pack: modern skills plus one legacy specialist."""
    root = tmp_path / "skills"
    pack = write_pack(root, "demo", "2.0.0", {"dotnet": ">=10.0"})
    write_skill(pack, "modern-api")
    write_skill(pack, "modern-orm")
    write_skill(pack, "legacy-expert", targets={"dotnet": ">=4.8 <5.0"})
    write_skill(pack, "anywhere", targets={})
    return root


def cfg(tmp_path: Path, targets: dict, packs: dict | None = None) -> ProjectConfig:
    return ProjectConfig(project_dir=tmp_path, targets=targets, packs=packs or {})


class TestToolchainGate:
    def test_modern_project_gets_modern_skills_only(self, skills_root, tmp_path):
        r = resolve(load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}))
        assert {s.name for s in r.selected} == {"modern-api", "modern-orm", "anywhere"}
        assert r.rejections_for("legacy-expert")[0].gate == "targets"

    def test_legacy_project_gets_the_legacy_skill_only(self, skills_root, tmp_path):
        r = resolve(load_packs(skills_root), cfg(tmp_path, {"dotnet": "4.8"}))
        assert {s.name for s in r.selected} == {"legacy-expert", "anywhere"}

    def test_a_new_variant_shipping_does_not_disturb_the_legacy_project(
        self, skills_root, tmp_path
    ):
        """The non-regression promise, stated as a test.

        A newer skill lands in the pack. The project on .NET Framework 4.8 must
        resolve to exactly what it resolved to before.
        """
        before = {
            s.name
            for s in resolve(
                load_packs(skills_root), cfg(tmp_path, {"dotnet": "4.8"})
            ).selected
        }
        write_skill(skills_root / "demo", "brand-new", targets={"dotnet": ">=11.0"})
        after = {
            s.name
            for s in resolve(
                load_packs(skills_root), cfg(tmp_path, {"dotnet": "4.8"})
            ).selected
        }
        assert before == after == {"legacy-expert", "anywhere"}

    def test_targetless_skill_reaches_a_project_with_no_toolchain_at_all(
        self, skills_root, tmp_path
    ):
        r = resolve(load_packs(skills_root), cfg(tmp_path, {}))
        assert {s.name for s in r.selected} == {"anywhere"}


class TestPackPinGate:
    def test_pin_excludes_the_whole_pack(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}, {"demo": "^1"})
        )
        assert r.selected == []
        assert all(rej.gate == "pack-pin" for rej in r.rejected)

    def test_matching_pin_lets_the_pack_through(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}, {"demo": "^2"})
        )
        assert {s.name for s in r.selected} == {"modern-api", "modern-orm", "anywhere"}

    def test_pin_is_evaluated_before_targets(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root), cfg(tmp_path, {"dotnet": "4.8"}, {"demo": "^9"})
        )
        assert {rej.gate for rej in r.rejected} == {"pack-pin"}


class TestRequiresGate:
    def test_missing_runtime_is_rejected(self, tmp_path):
        root = tmp_path / "skills"
        pack = write_pack(root, "demo", "1.0.0", {})
        write_skill(
            pack, "needs-bmad", requires={"runtime": "_bmad/core/tasks/workflow.xml"}
        )
        r = resolve(load_packs(root), cfg(tmp_path, {}))
        assert r.selected == []
        assert r.rejections_for("needs-bmad")[0].gate == "requires"

    def test_present_runtime_passes(self, tmp_path):
        root = tmp_path / "skills"
        pack = write_pack(root, "demo", "1.0.0", {})
        write_skill(
            pack, "needs-bmad", requires={"runtime": "_bmad/core/tasks/workflow.xml"}
        )
        target = tmp_path / "_bmad" / "core" / "tasks"
        target.mkdir(parents=True)
        (target / "workflow.xml").write_text("<workflow/>", encoding="utf-8")
        r = resolve(load_packs(root), cfg(tmp_path, {}))
        assert [s.name for s in r.selected] == ["needs-bmad"]

    def test_ignore_requires_shows_what_bootstrap_would_unlock(self, tmp_path):
        root = tmp_path / "skills"
        pack = write_pack(root, "demo", "1.0.0", {})
        write_skill(pack, "needs-bmad", requires={"runtime": "_bmad/x.xml"})
        r = resolve(load_packs(root), cfg(tmp_path, {}), ignore_requires=True)
        assert [s.name for s in r.selected] == ["needs-bmad"]

    def test_command_accepts_alternatives(self, tmp_path):
        ok, _ = check_requires(
            {"command": ["definitely-not-a-real-binary", "sh"]}, tmp_path
        )
        assert ok
        ok, reason = check_requires(
            {"command": ["definitely-not-a-real-binary"]}, tmp_path
        )
        assert not ok and "is on PATH" in reason

    def test_unknown_requires_key_fails_closed(self, tmp_path):
        # A typo must not silently disable the gate.
        ok, reason = check_requires({"runtim": "x"}, tmp_path)
        assert not ok and "unknown requires key" in reason


class TestPackLoading:
    def test_pack_name_must_match_its_directory(self, tmp_path):
        root = tmp_path / "skills"
        d = root / "demo"
        d.mkdir(parents=True)
        (d / "pack.json").write_text(json.dumps({"name": "other", "version": "1.0.0"}))
        with pytest.raises(PackError, match="does not match its directory"):
            load_packs(root)

    def test_underscore_directories_are_not_packs(self, tmp_path):
        """`skills/_proposed/` holds learning-loop candidates, not shippables."""
        root = tmp_path / "skills"
        write_pack(root, "demo", "1.0.0", {})
        (root / "_proposed").mkdir()
        assert [p.name for p in load_packs(root)] == ["demo"]

    def test_missing_version_is_fatal(self, tmp_path):
        root = tmp_path / "skills"
        d = root / "demo"
        d.mkdir(parents=True)
        (d / "pack.json").write_text(json.dumps({"name": "demo"}))
        with pytest.raises(PackError, match="version"):
            load_packs(root)


class TestProjectConfig:
    def test_declared_target_beats_detection(self, tmp_path):
        (tmp_path / "package.json").write_text(
            json.dumps({"engines": {"node": ">=18"}})
        )
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / ".workpilot" / "skills.toml").write_text('[targets]\nnode = "22"\n')
        config = load_project_config(tmp_path)
        assert config.targets["node"] == "22"
        assert config.detected["node"] == "18"
        assert config.target_source("node") == "skills.toml"

    def test_detection_fills_what_the_file_omits(self, tmp_path):
        (tmp_path / "go.mod").write_text("module x\n\ngo 1.23\n")
        config = load_project_config(tmp_path)
        assert config.targets["go"] == "1.23"
        assert config.target_source("go") == "detected"

    def test_dotnet_target_framework_moniker_is_decoded(self, tmp_path):
        (tmp_path / "app.csproj").write_text(
            "<Project><PropertyGroup><TargetFramework>net48</TargetFramework>"
            "</PropertyGroup></Project>"
        )
        assert load_project_config(tmp_path).targets["dotnet"] == "4.8"

    def test_multi_targeting_picks_the_newest_runtime(self, tmp_path):
        (tmp_path / "app.csproj").write_text(
            "<Project><PropertyGroup><TargetFrameworks>net48;net10.0</TargetFrameworks>"
            "</PropertyGroup></Project>"
        )
        assert load_project_config(tmp_path).targets["dotnet"] == "10.0"

    def test_invalid_toml_is_reported_not_ignored(self, tmp_path):
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / ".workpilot" / "skills.toml").write_text("[targets\nbroken")
        with pytest.raises(ValueError, match="invalid TOML"):
            load_project_config(tmp_path)


class TestAgainstTheRealPacks:
    """The .NET 10 / .NET Framework 4.8 split in `skills/` is a real case."""

    def test_dotnet_10_excludes_the_framework_48_expert(self, tmp_path):
        packs = load_packs(REPO_ROOT / "skills")
        r = resolve(packs, cfg(tmp_path, {"dotnet": "10.0"}), ignore_requires=True)
        names = {s.name for s in r.selected}
        assert "net-developer" in names
        assert "dotnet-framework-48-expert" not in names

    def test_dotnet_48_excludes_the_modern_stack(self, tmp_path):
        packs = load_packs(REPO_ROOT / "skills")
        r = resolve(packs, cfg(tmp_path, {"dotnet": "4.8"}), ignore_requires=True)
        names = {s.name for s in r.selected}
        assert "dotnet-framework-48-expert" in names
        assert "net-developer" not in names
        assert "akka-net-patterns" not in names


class TestPackWantList:
    """`[packs]` is opt-in, and the reason is `skills:check` stability.

    `skills/` holds packs vendored on demand whose content is gitignored. Under
    the old opt-out rule the emitted set depended on whether the developer had
    run `skills:bootstrap`: the check passed on a fresh clone and failed for
    anyone who had, which is the worst kind of red — it accuses the person who
    did the extra setup.
    """

    def test_an_unlisted_pack_is_not_resolved(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}, {"other": "^1"})
        )
        assert r.selected == []
        assert r.rejections_for("modern-api")[0].gate == "pack-pin"
        assert "not listed" in r.rejections_for("modern-api")[0].reason

    def test_a_listed_pack_resolves(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root),
            cfg(tmp_path, {"dotnet": "10.0"}, {"demo": "latest"}),
        )
        assert {s.name for s in r.selected} == {"modern-api", "modern-orm", "anywhere"}

    def test_latest_accepts_any_version(self, skills_root, tmp_path):
        """ "latest" means "whatever is in skills/", not a version to satisfy."""
        r = resolve(
            load_packs(skills_root),
            cfg(tmp_path, {"dotnet": "10.0"}, {"demo": "latest"}),
        )
        assert r.selected

    def test_a_listed_pack_still_honours_its_pin(self, skills_root, tmp_path):
        r = resolve(
            load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}, {"demo": "^1"})
        )
        assert r.selected == [], "a 2.0.0 pack satisfied a ^1 pin"

    def test_an_empty_want_list_resolves_everything(self, skills_root, tmp_path):
        """A project with no `[packs]` table has expressed no preference.

        Refusing everything there would mean a fresh `.workpilot/skills.toml`
        silently produces an empty palette, which reads as the tool being broken.
        """
        r = resolve(load_packs(skills_root), cfg(tmp_path, {"dotnet": "10.0"}, {}))
        assert r.selected

    def test_the_emitted_set_does_not_depend_on_what_is_vendored(self, tmp_path):
        """The property the want-list exists to guarantee."""
        root = tmp_path / "skills"
        wanted = write_pack(root, "wanted", "1.0.0", {})
        write_skill(wanted, "mine")
        vendored = write_pack(root, "vendored", "0.0.0", {})

        config = cfg(tmp_path, {}, {"wanted": "latest"})
        before = {s.name for s in resolve(load_packs(root), config).selected}

        write_skill(vendored, "theirs")  # someone ran skills:bootstrap
        after = {s.name for s in resolve(load_packs(root), config).selected}

        assert before == after == {"mine"}
