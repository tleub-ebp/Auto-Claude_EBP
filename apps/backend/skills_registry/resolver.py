"""Deciding which skills a project actually gets.

Three gates, in order. A skill has to clear all three:

1. **Pack selection and pin** — ``skills.toml``'s ``[packs]`` table is a
   *want-list*: a pack it does not name is not resolved at all, and a pack it
   pins to ``^1`` is out at 2.0.0. The pin is the axis that lets a project stay
   on an older pack while newer ones ship.

   Opt-in rather than opt-out, and the reason is mechanical. `skills/` holds
   packs vendored on demand whose content is gitignored: with opt-out, the
   emitted set would depend on whether the developer had run
   `skills:bootstrap`, so `skills:check` would pass on a fresh clone and fail
   for anyone who had. The build output has to be a function of what is
   committed, and the want-list is the committed part.

   Before the pin is checked, the pack's *variant* is chosen. A pack that has
   forked keeps its older cuts in subdirectories with the targets they were
   written for, so a project on .NET 8 resolves to the .NET 8 variant rather
   than to nothing. Which cut applies is decided by the project's toolchain;
   the pin is then evaluated against that cut's version, because pinning
   ``^2`` means "the 2.x line", not "the 2.x line of whatever the root happens
   to be today".
2. **Toolchain targets** — the skill's content has to apply to what the project
   is on. This is the axis that keeps .NET 10 guidance away from a .NET
   Framework 4.8 codebase.
3. **Runtime prerequisites** — ``requires`` must be satisfiable *right now*.

Gate 3 is what fixes the failure this whole registry was built for: 76 BMAD
skills were committed pointing at ``_bmad/core/tasks/workflow.xml``, a path that
is gitignored and absent from a fresh clone. They were listed in the command
palette and every one of them failed on invocation. A skill whose runtime is
missing is not emitted at all, so the palette shows what actually works.

Every rejection carries a reason. ``skills-cli why`` prints them, because "my
skill disappeared" with no explanation is its own kind of broken.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .packs import Pack, SkillSource
from .project import ProjectConfig
from .targets import satisfies, targets_match

__all__ = ["Resolution", "Rejection", "resolve", "check_requires"]


@dataclass(frozen=True)
class Rejection:
    """One skill that did not make it, and why."""

    name: str
    kind: str
    pack: str
    gate: str
    """``pack-pin`` | ``targets`` | ``requires``"""
    reason: str


@dataclass
class Resolution:
    selected: list[SkillSource] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    packs: dict[str, Pack] = field(default_factory=dict)
    """Packs that cleared gate 1, by name — the build needs their versions."""

    def by_name(self) -> dict[str, SkillSource]:
        return {s.name: s for s in self.selected}

    def rejections_for(self, name: str) -> list[Rejection]:
        return [r for r in self.rejected if r.name == name]


def check_requires(requires: dict[str, Any], project_dir: Path) -> tuple[bool, str]:
    """Verify a skill's runtime prerequisites.

    Supported keys:

    ``runtime``
        A path, relative to the project root, that must exist. Used for skills
        that drive a vendored runtime (BMAD's ``workflow.xml``).
    ``command``
        An executable that must be on ``PATH``.

    An unknown key is a hard failure rather than a silent pass: a typo in
    ``requires`` must not quietly turn the gate off.
    """
    for key, value in requires.items():
        if key == "runtime":
            if not (project_dir / str(value)).exists():
                return False, f"runtime not present: {value}"
        elif key == "command":
            # A list means alternatives: `python3` on Unix, `python` on
            # Windows. Any one of them being present satisfies the gate.
            candidates = value if isinstance(value, list) else [value]
            if not any(shutil.which(str(c)) for c in candidates):
                return (
                    False,
                    f"none of these commands is on PATH: {', '.join(map(str, candidates))}",
                )
        else:
            return False, f"unknown requires key: {key!r}"
    return True, ""


def resolve(
    packs: list[Pack],
    config: ProjectConfig,
    *,
    ignore_requires: bool = False,
) -> Resolution:
    """Run the three gates over every skill in ``packs``.

    ``ignore_requires`` skips gate 3. It exists for ``skills-cli list``, which
    should be able to show what a project *would* get once its runtimes are
    bootstrapped — not for the build, which must only emit what works.
    """
    result = Resolution()

    for declared in packs:
        pack = (
            declared.resolve_variant(config.targets) if declared.variants else declared
        )
        if pack is None:
            for src in declared.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        declared.name,
                        "targets",
                        f"no variant of {declared.name} targets this toolchain "
                        f"({_describe(declared.targets)}; "
                        f"variants: {', '.join(v.dir for v in declared.variants)})",
                    )
                )
            continue

        if config.packs and pack.name not in config.packs:
            for src in pack.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        pack.name,
                        "pack-pin",
                        f"pack {pack.name} is not listed in this project's "
                        f"[packs] — add it to .workpilot/skills.toml to use it",
                    )
                )
            continue

        pin = config.packs.get(pack.name)
        if pin and pin != "latest" and not satisfies(pack.version, pin):
            for src in pack.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        pack.name,
                        "pack-pin",
                        f"pack {pack.name} {pack.version} does not satisfy pin {pin}",
                    )
                )
            continue

        result.packs[pack.name] = pack

        for src in pack.skills():
            ok, reason = targets_match(src.targets, config.targets)
            if not ok:
                result.rejected.append(
                    Rejection(src.name, src.kind, pack.name, "targets", reason)
                )
                continue

            if not ignore_requires and src.requires:
                ok, reason = check_requires(src.requires, config.project_dir)
                if not ok:
                    result.rejected.append(
                        Rejection(src.name, src.kind, pack.name, "requires", reason)
                    )
                    continue

            result.selected.append(src)

    result.selected.sort(key=lambda s: (s.kind, s.name))
    return result


def _describe(targets: dict[str, str]) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(targets.items())) or "no targets"
