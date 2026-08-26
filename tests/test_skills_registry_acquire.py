"""Tests for the editing side of the registry: add, update and remove.

Three properties matter here and none of them are about the happy path.

**Adding twice must not damage anything.** A pack's `pack.json` is authored —
BMAD's names its own installer — so re-running `add` has to leave it alone, and
must not write an ignore block over a pack whose content is committed.

**Removing must take everything with it.** A pack that is gone from `skills/`
but still pinned in `skills.toml`, still ignored in `.gitignore` and still
listed in `skills-lock.json` is three pieces of debris that make the next
build's diff unreadable.

**Nothing here may touch the network.** The fetch is `npx skills`, which the
CLI shells out to; every test below plans, writes and deletes on a tmp tree.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.acquire import (  # noqa: E402
    AcquireError,
    add_gitignore_block,
    apply_add,
    apply_remove,
    bootstrap_satisfied,
    pin_pack,
    plan_add,
    plan_remove,
    remove_gitignore_block,
    unpin_pack,
    vendored_skill_count,
)
from skills_registry.packs import Pack, load_pack  # noqa: E402
from skills_registry.upstream import (  # noqa: E402
    forget_pack,
    parse_source,
    record_shas,
    recorded_shas,
)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
    (tmp_path / ".workpilot" / "skills.toml").write_text(
        '[targets]\npython = "3.13"\n\n[packs]\n# a comment worth keeping\ncomms = "^1"\n',
        encoding="utf-8",
    )
    (tmp_path / "skills-lock.json").write_text(
        json.dumps({"lockfileVersion": 1, "packs": {}, "emitted": ["a.md"]}),
        encoding="utf-8",
    )
    return tmp_path


def write_pack(repo: Path, name: str, **manifest) -> Path:
    d = repo / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    base = {"name": name, "version": "1.0.0", "targets": {}}
    base.update(manifest)
    (d / "pack.json").write_text(json.dumps(base), encoding="utf-8")
    return d


def write_skill(pack_dir: Path, name: str) -> Path:
    d = pack_dir / name
    d.mkdir(parents=True, exist_ok=True)
    path = d / "SKILL.md"
    path.write_text(
        f"---\nname: {name}\ndescription: d\n---\n\nbody\n", encoding="utf-8"
    )
    return path


# ── parsing what a person types ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,slug,ref",
    [
        ("obra/superpowers", "obra/superpowers", "HEAD"),
        ("obra/superpowers@v2.1.0", "obra/superpowers", "v2.1.0"),
        ("https://github.com/pbakaus/impeccable", "pbakaus/impeccable", "HEAD"),
        ("https://github.com/pbakaus/impeccable.git", "pbakaus/impeccable", "HEAD"),
        ("git@github.com:mattpocock/skills.git", "mattpocock/skills", "HEAD"),
    ],
)
def test_parse_source_recognises_github(raw, slug, ref):
    spec = parse_source(raw)
    assert spec.slug == slug
    assert spec.ref == ref
    assert spec.is_github


def test_parse_source_keeps_unknown_forms_verbatim():
    """`npx skills` resolves more forms than we want to reimplement.

    Passing an unrecognised string through unchanged lets it fail loudly at
    fetch time, which beats guessing at a slug and vendoring the wrong repo.
    """
    spec = parse_source("some-registry-entry")
    assert spec.slug is None
    assert spec.raw == "some-registry-entry"


def test_pack_name_defaults_to_the_repo_name():
    assert parse_source("obra/superpowers").default_pack_name == "superpowers"
    assert parse_source("mattpocock/skills@v1").default_pack_name == "skills"


# ── add ───────────────────────────────────────────────────────────────────────


def test_add_writes_manifest_ignore_block_and_pin(repo: Path):
    plan = plan_add(repo, "obra/superpowers")
    apply_add(repo, plan, project_dir=repo)

    manifest = json.loads((repo / "skills" / "superpowers" / "pack.json").read_text())
    assert manifest["source"] == "obra/superpowers"
    # A git clone, not `npx skills add`: that tool writes into every harness
    # directory it knows and overwrites skills-lock.json at the repo root.
    assert manifest["bootstrap"]["command"][:2] == [
        "python3",
        "scripts/vendor_pack.py",
    ]
    assert "--into" in manifest["bootstrap"]["command"]

    ignore = (repo / ".gitignore").read_text()
    assert "skills/superpowers/*" in ignore
    assert "!skills/superpowers/pack.json" in ignore

    config = (repo / ".workpilot" / "skills.toml").read_text()
    assert 'superpowers = "latest"' in config
    assert "# a comment worth keeping" in config, "editing the pins ate the comments"


def test_add_records_the_ref_when_one_is_pinned(repo: Path):
    plan = plan_add(repo, "obra/superpowers@v3.0.0")
    apply_add(repo, plan, project_dir=repo)
    manifest = json.loads((repo / "skills" / "superpowers" / "pack.json").read_text())
    command = manifest["bootstrap"]["command"]
    assert "--ref" in command and "v3.0.0" in command
    assert manifest["source"] == "obra/superpowers"


def test_add_leaves_an_authored_manifest_alone(repo: Path):
    """Re-adding BMAD must not replace its installer with a generic fetch."""
    write_pack(
        repo,
        "bmad",
        version="6.0.0",
        source="bmad-code-org/BMAD-METHOD",
        bootstrap={"command": ["npx", "bmad-method@6", "install"], "produces": "_bmad"},
    )
    plan = plan_add(repo, "bmad-code-org/BMAD-METHOD", name="bmad")
    apply_add(repo, plan, project_dir=repo)

    manifest = json.loads((repo / "skills" / "bmad" / "pack.json").read_text())
    assert manifest["bootstrap"]["command"] == ["npx", "bmad-method@6", "install"]
    assert manifest["version"] == "6.0.0"


def test_add_does_not_untrack_a_committed_pack(repo: Path):
    """`skills/bmad/` holds 76 committed wrappers; ignoring it would drop them."""
    write_pack(repo, "bmad", source="bmad-code-org/BMAD-METHOD")
    plan = plan_add(repo, "bmad-code-org/BMAD-METHOD", name="bmad")
    apply_add(repo, plan, project_dir=repo)
    assert "skills/bmad/*" not in (repo / ".gitignore").read_text()


def test_add_refuses_to_repoint_an_existing_pack(repo: Path):
    write_pack(repo, "superpowers", source="obra/superpowers")
    with pytest.raises(AcquireError, match="already exists and points at"):
        plan_add(repo, "someone-else/superpowers")


@pytest.mark.parametrize("name", ["skills", "agents", "_proposed", "Bad Name", "-x"])
def test_add_rejects_unusable_pack_names(repo: Path, name: str):
    with pytest.raises(AcquireError):
        plan_add(repo, "owner/repo", name=name)


def test_add_can_skip_the_pin(repo: Path):
    plan = plan_add(repo, "obra/superpowers", pin="")
    apply_add(repo, plan, project_dir=repo)
    assert "superpowers" not in (repo / ".workpilot" / "skills.toml").read_text()


def test_add_is_idempotent(repo: Path):
    plan_one = plan_add(repo, "obra/superpowers")
    apply_add(repo, plan_one, project_dir=repo)
    first = (
        (repo / ".gitignore").read_text(),
        (repo / ".workpilot" / "skills.toml").read_text(),
    )

    plan_two = plan_add(repo, "obra/superpowers")
    apply_add(repo, plan_two, project_dir=repo)
    second = (
        (repo / ".gitignore").read_text(),
        (repo / ".workpilot" / "skills.toml").read_text(),
    )

    assert first == second


# ── skills.toml editing ───────────────────────────────────────────────────────


def test_pin_replaces_an_existing_entry_in_place(repo: Path):
    assert pin_pack(repo, "comms", "^2") is True
    text = (repo / ".workpilot" / "skills.toml").read_text()
    assert 'comms = "^2"' in text
    assert 'comms = "^1"' not in text
    assert text.count("comms =") == 1


def test_pin_is_a_no_op_when_already_correct(repo: Path):
    assert pin_pack(repo, "comms", "^1") is False


def test_pin_creates_the_packs_table_when_missing(tmp_path: Path):
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / "skills.toml").write_text(
        '[targets]\npython = "3.13"\n', encoding="utf-8"
    )
    pin_pack(tmp_path, "tooling", "^1")
    text = (tmp_path / ".workpilot" / "skills.toml").read_text()
    assert "[packs]" in text
    assert 'tooling = "^1"' in text


def test_pin_creates_the_file_when_missing(tmp_path: Path):
    pin_pack(tmp_path, "tooling", "latest")
    assert 'tooling = "latest"' in (tmp_path / ".workpilot" / "skills.toml").read_text()


def test_unpin_only_touches_the_packs_table(repo: Path):
    """A `python` key under [targets] must survive unpinning a `python` pack."""
    path = repo / ".workpilot" / "skills.toml"
    path.write_text(
        '[targets]\npython = "3.13"\n\n[packs]\npython = "^1"\n', encoding="utf-8"
    )
    assert unpin_pack(repo, "python") is True
    text = path.read_text()
    assert '[targets]\npython = "3.13"' in text
    assert text.count("python =") == 1


def test_unpin_reports_when_there_was_nothing_to_do(repo: Path):
    assert unpin_pack(repo, "never-pinned") is False


# ── .gitignore editing ────────────────────────────────────────────────────────


def test_gitignore_block_round_trips(repo: Path):
    before = (repo / ".gitignore").read_text()
    assert add_gitignore_block(repo, "sp") is True
    assert add_gitignore_block(repo, "sp") is False, "added a duplicate block"
    assert remove_gitignore_block(repo, "sp") is True
    assert (repo / ".gitignore").read_text().rstrip("\n") == before.rstrip("\n")


def test_gitignore_removal_leaves_other_packs_alone(repo: Path):
    add_gitignore_block(repo, "one")
    add_gitignore_block(repo, "two")
    remove_gitignore_block(repo, "one")
    text = (repo / ".gitignore").read_text()
    assert "skills/one/*" not in text
    assert "skills/two/*" in text
    assert "node_modules/" in text


# ── remove ────────────────────────────────────────────────────────────────────


def test_remove_takes_the_pin_the_ignore_block_and_the_lock_entry(repo: Path):
    plan = plan_add(repo, "obra/superpowers")
    apply_add(repo, plan, project_dir=repo)
    write_skill(repo / "skills" / "superpowers", "brainstorming")
    record_shas(repo / "skills-lock.json", {"superpowers": "abc123"})

    removal = plan_remove(repo, "superpowers")
    assert removal.vendored
    assert removal.recoverable, "fetched content should not need --yes"
    apply_remove(repo, removal, project_dir=repo)

    assert not (repo / "skills" / "superpowers").exists()
    assert "skills/superpowers/*" not in (repo / ".gitignore").read_text()
    assert "superpowers" not in (repo / ".workpilot" / "skills.toml").read_text()
    assert "superpowers" not in recorded_shas(repo / "skills-lock.json")


def test_remove_flags_a_locally_authored_pack_as_unrecoverable(repo: Path):
    pack_dir = write_pack(repo, "comms", source="local")
    write_skill(pack_dir, "brand-guidelines")
    plan = plan_remove(repo, "comms")
    assert not plan.vendored
    assert plan.authored_files > 0
    assert not plan.recoverable, "deleting authored source must require --yes"


def test_remove_flags_local_edits_inside_a_vendored_pack(repo: Path):
    pack_dir = write_pack(repo, "sp", source="obra/superpowers")
    (pack_dir / "LOCAL_NOTES.md").write_text("hand-written", encoding="utf-8")
    plan = plan_remove(repo, "sp")
    assert plan.vendored
    assert plan.authored_files == 1
    assert not plan.recoverable


def test_remove_rejects_an_unknown_pack(repo: Path):
    with pytest.raises(AcquireError, match="no pack named"):
        plan_remove(repo, "nope")


def test_remove_leaves_the_emitted_list_for_the_build_to_settle(repo: Path):
    """Provenance is ours; the emitted files belong to the next build."""
    write_pack(repo, "sp", source="obra/superpowers")
    record_shas(repo / "skills-lock.json", {"sp": "deadbeef"})
    apply_remove(repo, plan_remove(repo, "sp"), project_dir=repo)
    lock = json.loads((repo / "skills-lock.json").read_text())
    assert lock["emitted"] == ["a.md"]
    assert "sp" not in lock["packs"]


# ── bootstrap verification ────────────────────────────────────────────────────


def make_pack(path: Path, **kw) -> Pack:
    return Pack(
        name=path.name,
        version="0.0.0",
        description="",
        targets={},
        path=path,
        **kw,
    )


def test_bootstrap_is_satisfied_by_a_declared_produces_path(repo: Path):
    pack = make_pack(
        repo / "skills" / "bmad", bootstrap={"command": ["x"], "produces": "_bmad"}
    )
    assert bootstrap_satisfied(repo, pack) is False
    (repo / "_bmad").mkdir()
    assert bootstrap_satisfied(repo, pack) is True


def test_bootstrap_falls_back_to_whether_skills_turned_up(repo: Path):
    """`npx skills add` writes no marker file.

    Checking for one would report failure after every successful fetch, so a
    pack that declares no `produces` is verified by what it actually produced.
    """
    pack_dir = write_pack(repo, "sp", source="obra/superpowers")
    pack = make_pack(pack_dir, bootstrap={"command": ["npx", "skills"]})
    assert bootstrap_satisfied(repo, pack) is False
    write_skill(pack_dir, "brainstorming")
    assert bootstrap_satisfied(repo, pack) is True


def test_vendored_skill_count_sees_agents_too(repo: Path):
    pack_dir = write_pack(repo, "sp")
    write_skill(pack_dir, "one")
    (pack_dir / "agents").mkdir()
    (pack_dir / "agents" / "reviewer.md").write_text("---\nname: r\n---\n", "utf-8")
    assert vendored_skill_count(pack_dir) == 2


# ── lockfile provenance ───────────────────────────────────────────────────────


def test_record_shas_preserves_everything_the_build_owns(repo: Path):
    lock = repo / "skills-lock.json"
    record_shas(lock, {"sp": "abc"})
    data = json.loads(lock.read_text())
    assert data["packs"]["sp"]["upstreamTreeSha"] == "abc"
    assert data["emitted"] == ["a.md"], "provenance write clobbered the emitted list"


def test_record_shas_ignores_empty_values(repo: Path):
    """An unreachable upstream records nothing rather than an empty SHA."""
    lock = repo / "skills-lock.json"
    record_shas(lock, {"sp": ""})
    assert "sp" not in json.loads(lock.read_text())["packs"]


def test_forget_pack_is_a_no_op_for_an_absent_entry(repo: Path):
    lock = repo / "skills-lock.json"
    before = lock.read_text()
    forget_pack(lock, "never-there")
    assert lock.read_text() == before


def test_real_repo_manifests_all_declare_a_reachable_source():
    """Every vendored pack in this repo names an upstream `update` can check."""
    for pack_dir in sorted((REPO_ROOT / "skills").iterdir()):
        if not pack_dir.is_dir() or pack_dir.name.startswith(("_", ".")):
            continue
        pack = load_pack(pack_dir)
        if pack.source == "local":
            continue
        assert "/" in pack.source, (
            f"{pack.name}: source {pack.source!r} is not owner/repo"
        )
        assert pack.bootstrap.get("command"), f"{pack.name}: vendored but no bootstrap"


# ── optional packs ────────────────────────────────────────────────────────────


def test_a_pack_can_declare_itself_opt_in(repo: Path):
    """A heavier alternative to something already here is declared, not installed."""
    write_pack(
        repo,
        "claude-mem",
        source="thedotmack/claude-mem",
        bootstrap={"command": ["npx", "skills"], "optional": True},
    )
    pack = load_pack(repo / "skills" / "claude-mem")
    assert pack.bootstrap.get("optional") is True


def test_the_repo_declares_claude_mem_as_optional():
    """6d: the pattern was adopted, the daemon was not.

    It stays in the catalogue for anyone running Claude Code without the
    WorkPilot backend, but a bare `skills:bootstrap` must not stand up a fourth
    memory with its own worker and its own two stores.
    """
    pack = load_pack(REPO_ROOT / "skills" / "claude-mem")
    assert pack.bootstrap.get("optional") is True
    assert "mem-search" in pack.bootstrap.get("note", "")
