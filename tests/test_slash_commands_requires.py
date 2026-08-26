"""The Kanban palette must never list a command that cannot run.

This is the original bug, and the one thing the whole registry was built to
stop: a fresh clone showed 76 BMAD commands, every one of which failed on
invocation because `_bmad/` is generated and gitignored.

The build gate fixes it at the source — a skill whose runtime is missing is not
emitted. That is not sufficient on its own, because `.agents/skills/` is
**committed**. A developer who bootstraps BMAD locally emits the 76 wrappers and
commits them; the next clone then has the files and not the runtime, and the
palette is broken again by a different route. So the gate is enforced twice, and
this file pins down the second one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from slash_commands.api import _scan_skills_dir  # noqa: E402


def write_skill(project: Path, name: str, *, requires: dict | None = None) -> Path:
    d = project / ".agents" / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    meta = f"name: {name}\ndescription: what {name} does\n"
    if requires is not None:
        meta += f"metadata:\n  workpilot:\n    requires: {json.dumps(requires)}\n"
    path = d / "SKILL.md"
    path.write_text(f"---\n{meta}---\n\nbody\n", encoding="utf-8")
    return path


def names(project: Path) -> set[str]:
    return {c["name"] for c in _scan_skills_dir(project, "project")}


def test_a_skill_with_no_requires_is_listed(tmp_path: Path):
    write_skill(tmp_path, "webapp-testing")
    assert names(tmp_path) == {"webapp-testing"}


def test_a_committed_skill_whose_runtime_is_absent_is_hidden(tmp_path: Path):
    """The exact regression: the file is there, `_bmad/` is not."""
    write_skill(
        tmp_path,
        "bmad-bmm-create-prd",
        requires={"runtime": "_bmad/core/tasks/workflow.xml"},
    )
    assert names(tmp_path) == set()


def test_it_appears_once_the_runtime_is_bootstrapped(tmp_path: Path):
    write_skill(
        tmp_path,
        "bmad-bmm-create-prd",
        requires={"runtime": "_bmad/core/tasks/workflow.xml"},
    )
    runtime = tmp_path / "_bmad" / "core" / "tasks"
    runtime.mkdir(parents=True)
    (runtime / "workflow.xml").write_text("<workflow/>", encoding="utf-8")
    assert names(tmp_path) == {"bmad-bmm-create-prd"}


def test_gating_is_per_skill_not_all_or_nothing(tmp_path: Path):
    write_skill(tmp_path, "usable")
    write_skill(tmp_path, "gated", requires={"runtime": "_bmad/x.xml"})
    assert names(tmp_path) == {"usable"}


def test_a_command_requirement_is_checked_against_path(tmp_path: Path):
    write_skill(tmp_path, "needs-python", requires={"command": ["python3", "python"]})
    write_skill(
        tmp_path, "needs-nothing-real", requires={"command": "definitely-not-installed"}
    )
    listed = names(tmp_path)
    assert "needs-python" in listed
    assert "needs-nothing-real" not in listed


@pytest.mark.parametrize(
    "requires",
    ["not-a-mapping", ["runtime"], {"typo_key": "value"}],
)
def test_a_malformed_requires_hides_the_command(tmp_path: Path, requires):
    """A command that cannot run is worse than one that is missing.

    The user picks it, waits, and gets an error. Failing closed costs them a
    command they might have been able to use; failing open costs them a build.
    """
    write_skill(tmp_path, "suspect", requires=requires)
    assert names(tmp_path) == set()


def test_a_missing_skills_dir_is_empty_not_an_error(tmp_path: Path):
    assert _scan_skills_dir(tmp_path, "project") == []


def test_this_repos_committed_palette_is_all_runnable():
    """Nothing in `.agents/skills/` should be gated on this checkout.

    If this fails, an output was committed that the build would not have
    emitted here — someone hand-edited `.agents/skills/` or committed after a
    bootstrap that the next clone will not have.
    """
    listed = names(REPO_ROOT)
    on_disk = {
        p.parent.name for p in (REPO_ROOT / ".agents" / "skills").glob("*/SKILL.md")
    }
    assert listed == on_disk, f"committed but unusable here: {sorted(on_disk - listed)}"
