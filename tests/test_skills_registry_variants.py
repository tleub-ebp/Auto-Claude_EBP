"""Pack variants: what happens when upstream ships something that breaks.

The promise this file exists to hold: **a project targeting an older toolchain
keeps resolving to the skills written for it, whatever ships afterwards.**

Skill-level targets already deliver that when one skill in a pack forks
(`test_skills_registry_resolver.py` pins that down). This is the other case —
the whole pack forks, because upstream removed skills or narrowed what they
apply to. Taking that in place would silently move a project pinned to .NET 8
onto .NET 10 guidance, and nothing in the build would say so.

Two halves, tested separately because they fail differently:

* **classification** — deciding that a release breaks. Getting this wrong in
  the permissive direction is the expensive one, so the ambiguous cases are
  asserted to land on "breaking".
* **forking** — preserving the current cut before taking the new one, and the
  resolver then handing each project the cut it is on.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.acquire import AcquireError, fork_variant  # noqa: E402
from skills_registry.classify import (  # noqa: E402
    ChangeCategory,
    SkillFacts,
    classify_pack_diff,
    facts_from_sources,
)
from skills_registry.packs import PackError, load_pack, load_packs  # noqa: E402
from skills_registry.project import ProjectConfig  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402


def facts(name: str, **kw) -> SkillFacts:
    kw.setdefault("body_digest", "d0")
    return SkillFacts(name=name, **kw)


def write_skill(pack_dir: Path, name: str, *, targets=None, body="do it") -> Path:
    d = pack_dir / name
    d.mkdir(parents=True, exist_ok=True)
    meta = f"name: {name}\ndescription: {name} does things\n"
    if targets is not None:
        meta += f"metadata:\n  workpilot:\n    targets: {json.dumps(targets)}\n"
    (d / "SKILL.md").write_text(f"---\n{meta}---\n\n{body}\n", encoding="utf-8")
    return d


def write_pack(root: Path, name: str, version: str, targets: dict, **extra) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    manifest = {"name": name, "version": version, "targets": targets}
    manifest.update(extra)
    (d / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    return d


def cfg(project_dir: Path, targets: dict, packs=None) -> ProjectConfig:
    return ProjectConfig(project_dir=project_dir, targets=targets, packs=packs or {})


# ── classification ────────────────────────────────────────────────────────────


def test_adding_a_skill_is_not_breaking():
    diff = classify_pack_diff("p", [facts("a")], [facts("a"), facts("b")])
    assert diff.category is ChangeCategory.NON_BREAKING
    assert not diff.needs_variant


def test_removing_a_skill_is_breaking():
    """A workflow phase naming `pack/skill` stops resolving. So does a palette entry."""
    diff = classify_pack_diff("p", [facts("a"), facts("b")], [facts("a")])
    assert diff.is_breaking
    assert diff.needs_variant
    assert "removed" in diff.summary()


def test_narrowing_targets_is_breaking():
    """A removal wearing a disguise: the skill is there, just not for you."""
    diff = classify_pack_diff(
        "p",
        [facts("a", targets={"dotnet": ">=8.0"})],
        [facts("a", targets={"dotnet": ">=10.0"})],
    )
    assert diff.is_breaking
    assert "narrowed" in diff.summary()


def test_dropping_a_target_constraint_is_a_widening():
    """Strictly more projects resolve it than before, so nobody loses it."""
    diff = classify_pack_diff(
        "p",
        [facts("a", targets={"dotnet": ">=8.0", "node": ">=20"})],
        [facts("a", targets={"dotnet": ">=8.0"})],
    )
    assert diff.category is ChangeCategory.NON_BREAKING


def test_adding_a_requires_is_breaking():
    """The skill stops being emitted anywhere the new prerequisite is absent."""
    diff = classify_pack_diff(
        "p", [facts("a")], [facts("a", requires={"runtime": "_bmad/x.xml"})]
    )
    assert diff.is_breaking


def test_dropping_a_requires_is_not_breaking():
    diff = classify_pack_diff(
        "p", [facts("a", requires={"command": "bun"})], [facts("a")]
    )
    assert diff.category is ChangeCategory.NON_BREAKING


def test_a_changed_body_is_potentially_breaking_and_is_not_forked():
    """It is an instruction an agent will follow, so it can change behaviour
    without changing anything a resolver can see. Reported for a person to
    read — forking on every reworded sentence would produce a variant a week
    and make the mechanism meaningless."""
    diff = classify_pack_diff(
        "p", [facts("a", body_digest="d0")], [facts("a", body_digest="d1")]
    )
    assert diff.category is ChangeCategory.POTENTIALLY_BREAKING
    assert not diff.needs_variant


def test_a_skill_that_becomes_an_agent_is_breaking():
    diff = classify_pack_diff(
        "p", [facts("a", kind="skill")], [facts("a", kind="agent")]
    )
    assert diff.is_breaking


def test_the_worst_change_in_a_release_decides_the_action():
    diff = classify_pack_diff(
        "p",
        [facts("a"), facts("b")],
        [facts("a"), facts("c")],  # b removed, c added
    )
    assert diff.is_breaking


def test_an_identical_release_is_a_no_op():
    diff = classify_pack_diff("p", [facts("a")], [facts("a")])
    assert diff.changes == []
    assert "no consumer-visible change" in diff.summary()


def test_a_quiet_release_earns_a_patch():
    """Upstream moved, but nothing a consumer can observe did."""
    diff = classify_pack_diff("p", [facts("a")], [facts("a")])
    assert diff.bump("2.4.0") == "2.4.1"


def test_a_breaking_release_takes_the_next_major():
    diff = classify_pack_diff("p", [facts("a"), facts("b")], [facts("a")])
    assert diff.bump("2.4.0") == "3.0.0"


def test_a_body_change_earns_a_minor():
    diff = classify_pack_diff(
        "p", [facts("a", body_digest="d0")], [facts("a", body_digest="d1")]
    )
    assert diff.bump("2.4.0") == "2.5.0"


def test_facts_come_from_real_sources(tmp_path: Path):
    root = tmp_path / "skills"
    pack_dir = write_pack(root, "demo", "1.0.0", {})
    write_skill(pack_dir, "hello", targets={"node": ">=20"})
    pack = load_pack(pack_dir)

    got = facts_from_sources(pack.skills())
    assert [f.name for f in got] == ["hello"]
    assert got[0].targets == {"node": ">=20"}
    assert got[0].body_digest


def test_a_body_edit_shows_up_in_the_digest(tmp_path: Path):
    root = tmp_path / "skills"
    pack_dir = write_pack(root, "demo", "1.0.0", {})
    write_skill(pack_dir, "hello", body="original")
    before = facts_from_sources(load_pack(pack_dir).skills())

    write_skill(pack_dir, "hello", body="rewritten")
    after = facts_from_sources(load_pack(pack_dir).skills())

    assert classify_pack_diff("demo", before, after).category is (
        ChangeCategory.POTENTIALLY_BREAKING
    )


# ── forking ───────────────────────────────────────────────────────────────────


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


def test_forking_preserves_the_pinned_cut_and_moves_the_root(repo: Path):
    write_pack(repo / "skills", "dotnet", "2.4.0", {"dotnet": ">=8.0 <10.0"})
    variant = fork_variant(repo, "dotnet", new_version="3.0.0")

    manifest = json.loads((repo / "skills" / "dotnet" / "pack.json").read_text())
    assert manifest["version"] == "3.0.0"
    assert manifest["variants"] == [
        {
            "version": "2.4.0",
            "dir": "v2",
            "targets": {"dotnet": ">=8.0 <10.0"},
        }
    ]
    assert variant.dir == "v2"
    assert variant.targets == {"dotnet": ">=8.0 <10.0"}


def test_forking_twice_keeps_both_older_cuts_newest_first(repo: Path):
    write_pack(repo / "skills", "dotnet", "2.4.0", {"dotnet": ">=8.0 <10.0"})
    fork_variant(repo, "dotnet", new_version="3.0.0")
    fork_variant(repo, "dotnet", new_version="4.0.0")

    manifest = json.loads((repo / "skills" / "dotnet" / "pack.json").read_text())
    assert [v["version"] for v in manifest["variants"]] == ["3.0.0", "2.4.0"]
    assert manifest["version"] == "4.0.0"


def test_forking_refuses_to_collide_two_cuts_in_one_major(repo: Path):
    """Two breaking releases inside one major need the second named by hand.

    The variant directory is derived from the major, so a second fork out of
    2.x would land on `v2` again and overwrite the cut already parked there.
    Refusing beats silently replacing the thing this mechanism exists to keep.
    """
    write_pack(
        repo / "skills",
        "dotnet",
        "2.9.0",
        {},
        variants=[{"version": "2.4.0", "dir": "v2", "targets": {}}],
    )
    with pytest.raises(AcquireError, match="already occupies"):
        fork_variant(repo, "dotnet", new_version="3.0.0")


def test_forking_refuses_a_no_op(repo: Path):
    write_pack(repo / "skills", "dotnet", "2.4.0", {})
    with pytest.raises(AcquireError, match="into itself"):
        fork_variant(repo, "dotnet", new_version="2.4.0")


def test_forking_an_unknown_pack_is_an_error(repo: Path):
    with pytest.raises(AcquireError, match="no pack named"):
        fork_variant(repo, "nope", new_version="1.0.0")


# ── the promise, end to end ───────────────────────────────────────────────────


@pytest.fixture
def forked_repo(tmp_path: Path) -> Path:
    """A pack that has taken a breaking release, exactly as the sync leaves it.

    Root targets .NET 10 and offers the modern skill; the `v2` variant keeps
    .NET 8 and the skill the release removed.
    """
    root = tmp_path / "skills"
    pack_dir = write_pack(
        root,
        "dotnet",
        "3.0.0",
        {"dotnet": ">=10.0"},
        variants=[
            {"version": "2.4.0", "dir": "v2", "targets": {"dotnet": ">=8.0 <10.0"}}
        ],
    )
    write_skill(pack_dir, "net-developer", body="C# 14 guidance")
    legacy = pack_dir / "v2"
    write_skill(legacy, "net-developer", body="C# 12 guidance")
    write_skill(legacy, "removed-upstream", body="the skill the release dropped")
    return tmp_path


def test_a_project_on_the_old_toolchain_resolves_the_preserved_cut(forked_repo: Path):
    """The whole point. .NET 8 keeps what it had, including the dropped skill."""
    r = resolve(load_packs(forked_repo / "skills"), cfg(forked_repo, {"dotnet": "8.0"}))
    assert {s.name for s in r.selected} == {"net-developer", "removed-upstream"}
    body = next(s for s in r.selected if s.name == "net-developer").body
    assert "C# 12" in body


def test_a_project_on_the_new_toolchain_resolves_the_root(forked_repo: Path):
    r = resolve(
        load_packs(forked_repo / "skills"), cfg(forked_repo, {"dotnet": "10.0"})
    )
    assert {s.name for s in r.selected} == {"net-developer"}
    body = next(iter(r.selected)).body
    assert "C# 14" in body


def test_a_variants_skills_do_not_leak_into_the_root(forked_repo: Path):
    """`v2/` is a variant directory, not a skill directory."""
    pack = load_pack(forked_repo / "skills" / "dotnet")
    assert {s.name for s in pack.skills()} == {"net-developer"}
    assert pack.variant_dirs() == {"v2"}


def test_a_project_no_variant_covers_is_told_so(forked_repo: Path):
    r = resolve(load_packs(forked_repo / "skills"), cfg(forked_repo, {"dotnet": "6.0"}))
    assert r.selected == []
    reasons = [rej.reason for rej in r.rejected]
    assert any("no variant of dotnet targets this toolchain" in x for x in reasons)


def test_the_pin_is_evaluated_against_the_resolved_cut(forked_repo: Path):
    """Pinning `^2` means the 2.x line, not the 2.x line of today's root."""
    packs = load_packs(forked_repo / "skills")
    on_eight = resolve(packs, cfg(forked_repo, {"dotnet": "8.0"}, {"dotnet": "^2"}))
    assert {s.name for s in on_eight.selected} == {"net-developer", "removed-upstream"}

    on_ten = resolve(packs, cfg(forked_repo, {"dotnet": "10.0"}, {"dotnet": "^2"}))
    assert on_ten.selected == [], "the 3.x root should not satisfy a ^2 pin"


def test_a_third_release_does_not_disturb_either_existing_cut(forked_repo: Path):
    """The non-regression promise under continued upstream churn."""
    packs = load_packs(forked_repo / "skills")
    before = {
        s.name for s in resolve(packs, cfg(forked_repo, {"dotnet": "8.0"})).selected
    }

    write_skill(forked_repo / "skills" / "dotnet", "brand-new", body="C# 15 guidance")
    after = {
        s.name
        for s in resolve(
            load_packs(forked_repo / "skills"), cfg(forked_repo, {"dotnet": "8.0"})
        ).selected
    }
    assert before == after == {"net-developer", "removed-upstream"}


# ── manifest validation ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "variants,message",
    [
        ("not-a-list", "must be a list"),
        ([["v2"]], "must be an object"),
        ([{"version": "2.0.0"}], "missing dir"),
        ([{"dir": "v2"}], "missing version"),
        ([{"version": "2.0.0", "dir": "v2", "targets": "no"}], "must be an object"),
        (
            [{"version": "2.0.0", "dir": "v2"}, {"version": "2.1.0", "dir": "v2"}],
            "both use dir",
        ),
    ],
)
def test_a_malformed_variant_is_fatal(tmp_path: Path, variants, message):
    """A build that guesses at a broken manifest ships the wrong skills."""
    pack_dir = write_pack(tmp_path / "skills", "demo", "1.0.0", {}, variants=variants)
    with pytest.raises(PackError, match=message):
        load_pack(pack_dir)


def test_a_pack_with_no_variants_behaves_exactly_as_before(tmp_path: Path):
    pack_dir = write_pack(tmp_path / "skills", "demo", "1.0.0", {})
    write_skill(pack_dir, "hello")
    pack = load_pack(pack_dir)
    assert pack.variants == ()
    assert pack.variant_dirs() == set()
    assert pack.resolve_variant({}) is pack


# ── the sync job's decision ───────────────────────────────────────────────────
#
# The plan's verification, literally: simulate a breaking upstream release and
# assert the job creates a variant and leaves the pinned lock entry alone.


def _sync_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "skills_sync", REPO_ROOT / "scripts" / "skills_sync.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def upstream_repo(tmp_path: Path, monkeypatch):
    """A vendored pack on disk, with the sync pointed at it instead of GitHub."""
    sync = _sync_module()
    root = tmp_path
    (root / "skills").mkdir()
    pack_dir = write_pack(
        root / "skills",
        "superpowers",
        "2.4.0",
        {"node": ">=20"},
        source="obra/superpowers",
        bootstrap={"command": ["true"]},
    )
    write_skill(pack_dir, "brainstorming")
    write_skill(pack_dir, "test-driven-development")
    (root / "skills-lock.json").write_text(
        json.dumps(
            {
                "lockfileVersion": 1,
                "packs": {
                    "superpowers": {
                        "version": "2.4.0",
                        "source": "obra/superpowers",
                        "upstreamTreeSha": "old" * 13 + "a",
                    }
                },
                "emitted": ["x.md"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sync, "REPO_ROOT", root)
    monkeypatch.setattr(sync, "LOCKFILE", root / "skills-lock.json")
    monkeypatch.setattr(sync, "fetch_tree_sha", lambda *a, **kw: "new" * 13 + "b")
    return sync, root, pack_dir


def test_a_breaking_upstream_release_forks_and_leaves_the_pin_alone(upstream_repo):
    sync, root, pack_dir = upstream_repo

    # The release: upstream dropped a skill.
    def fake_refetch(pack_name: str) -> bool:
        import shutil

        shutil.rmtree(pack_dir / "brainstorming")
        return True

    sync._refetch = fake_refetch
    report = "\n".join(
        sync._apply_release("superpowers", sync._pack_facts("superpowers"))
    )

    manifest = json.loads((pack_dir / "pack.json").read_text())
    assert manifest["version"] == "3.0.0"
    assert manifest["variants"] == [
        {
            "version": "2.4.0",
            "dir": "v2",
            "targets": {"node": ">=20"},
            "note": (
                "Kept because the release above removed or narrowed skills "
                "a project on these targets depends on."
            ),
        }
    ]
    assert "forked" in report
    assert "removed" in report


def test_a_quiet_upstream_release_is_taken_in_place(upstream_repo):
    sync, root, pack_dir = upstream_repo

    def fake_refetch(pack_name: str) -> bool:
        write_skill(pack_dir, "newly-added")
        return True

    sync._refetch = fake_refetch
    report = "\n".join(
        sync._apply_release("superpowers", sync._pack_facts("superpowers"))
    )

    manifest = json.loads((pack_dir / "pack.json").read_text())
    assert "variants" not in manifest, "a non-breaking release must not fork"
    assert manifest["version"] == "2.4.1"
    assert "bumped in place" in report


def test_a_release_that_cannot_be_fetched_changes_nothing(upstream_repo):
    sync, root, pack_dir = upstream_repo
    sync._refetch = lambda _pack: False

    before = (pack_dir / "pack.json").read_text()
    report = "\n".join(
        sync._apply_release("superpowers", sync._pack_facts("superpowers"))
    )

    assert (pack_dir / "pack.json").read_text() == before
    assert "not applied" in report


def test_an_unbootstrapped_pack_is_reported_unclassified_not_assumed_safe(
    tmp_path: Path, monkeypatch
):
    """Concluding "non-breaking" because we could not look is the one outcome
    this whole mechanism exists to avoid."""
    sync = _sync_module()
    (tmp_path / "skills").mkdir()
    write_pack(
        tmp_path / "skills",
        "superpowers",
        "2.4.0",
        {},
        source="obra/superpowers",
        bootstrap={"command": ["true"]},
    )
    monkeypatch.setattr(sync, "REPO_ROOT", tmp_path)
    sync._refetch = lambda _pack: True

    report = "\n".join(sync._apply_release("superpowers", []))
    assert "unclassified" in report
    manifest = json.loads(
        (tmp_path / "skills" / "superpowers" / "pack.json").read_text()
    )
    assert manifest["version"] == "2.4.0", "an unclassified release must not bump"
