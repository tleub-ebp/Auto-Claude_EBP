"""Loading skill packs from source.

A *pack* is a directory under ``skills/`` holding a ``pack.json`` plus one
directory per skill and, optionally, an ``agents/`` directory of subagent
definitions.

::

    skills/
      dotnet/
        pack.json
        net-developer/SKILL.md
        agents/net-architect.md

Two facts live in two places, on purpose:

* ``pack.json`` owns what is true for the whole pack — its name, its semver,
  and the default toolchain targets.
* a ``SKILL.md`` owns what is true for that skill alone — an override of the
  targets, its runtime prerequisites, the effort it is worth running at.

Nothing is duplicated between them, so nothing can drift. Fields the build
*derives* (pack name, pack version, provenance) are never authored by hand:
they are injected into the materialised output by ``build.py``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from .frontmatter import parse_frontmatter, workpilot_meta

logger = logging.getLogger(__name__)

__all__ = [
    "Pack",
    "PackVariant",
    "SkillSource",
    "PackError",
    "load_packs",
    "load_pack",
]

SkillKind = Literal["skill", "agent"]


class PackError(Exception):
    """A pack manifest is missing or malformed. Always fatal: a build that
    guesses at a broken manifest ships the wrong skills."""


@dataclass(frozen=True)
class SkillSource:
    """One authored skill or agent, before resolution."""

    name: str
    kind: SkillKind
    pack: str
    path: Path
    """The SKILL.md / agent .md file itself."""
    meta: dict[str, Any]
    body: str
    targets: dict[str, str]
    """Effective targets: the skill's own override, else the pack default."""
    requires: dict[str, Any] = field(default_factory=dict)
    min_effort: str | None = None

    @property
    def dir(self) -> Path:
        """The directory whose contents travel with the skill."""
        return self.path.parent if self.kind == "skill" else self.path


@dataclass(frozen=True)
class PackVariant:
    """An earlier cut of a pack, kept for the toolchains it was written for.

    A pack forks when upstream ships something the older toolchain cannot use.
    The answer is never to rewrite the pinned one in place — a project on .NET 8
    would silently start getting .NET 10 guidance — so the new work becomes the
    root pack and the old one moves into a subdirectory with the targets it
    serves. Both stay resolvable; which one a project gets is decided by what
    that project is actually on.
    """

    version: str
    dir: str
    """Subdirectory of the pack, holding that variant's skills."""
    targets: dict[str, str] = field(default_factory=dict)
    note: str = ""


@dataclass(frozen=True)
class Pack:
    """A versioned bundle of skills and agents."""

    name: str
    version: str
    description: str
    targets: dict[str, str]
    path: Path
    maintainer: str = ""
    source: str = "local"
    """Where the pack came from: ``local`` or an upstream ``owner/repo``."""
    bootstrap: dict[str, Any] = field(default_factory=dict)
    """How to materialise this pack's runtime, when it needs one.

    ``{"command": [...], "produces": "<relative path>"}``. Declared by the pack
    rather than hardcoded in the CLI, so a second vendored runtime does not
    mean a second special case."""
    variants: tuple[PackVariant, ...] = ()
    """Older cuts, newest first. Empty for a pack that has never forked."""
    gate: dict[str, Any] = field(default_factory=dict)
    """A deterministic check this pack provides, if any.

    ``{"command": [...], "clean_when": "exit_zero"}``. Declared here rather
    than hardcoded in the engine so a second deterministic pack is not a second
    special case — the same reasoning as ``bootstrap``."""

    def skills(self) -> list[SkillSource]:
        return _discover(self)

    def variant_dirs(self) -> set[str]:
        """Subdirectories that belong to a variant, not to this pack's skills."""
        return {v.dir for v in self.variants}

    def resolve_variant(self, project_targets: dict[str, str]) -> Pack | None:
        """The cut of this pack a project on ``project_targets`` should get.

        Returns ``self`` when the root pack applies, a variant rendered as a
        Pack when an older one does, or None when nothing here fits — which the
        caller reports rather than papering over, because silently handing a
        project the wrong variant is the failure this mechanism exists to stop.

        The root is tried first and variants in declared order, so the newest
        applicable cut wins. Variants are declared newest-first for that reason.
        """
        from .targets import targets_match

        if targets_match(self.targets, project_targets)[0]:
            return self
        for variant in self.variants:
            if targets_match(variant.targets, project_targets)[0]:
                return replace(
                    self,
                    version=variant.version,
                    targets=dict(variant.targets),
                    path=self.path / variant.dir,
                    variants=(),
                )
        return None


_REQUIRED_FIELDS = ("name", "version")


def load_pack(pack_dir: Path) -> Pack:
    manifest = pack_dir / "pack.json"
    if not manifest.is_file():
        raise PackError(f"{pack_dir}: no pack.json")
    try:
        raw = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PackError(f"{manifest}: invalid JSON — {exc}") from exc
    if not isinstance(raw, dict):
        raise PackError(f"{manifest}: expected a JSON object")

    missing = [f for f in _REQUIRED_FIELDS if not raw.get(f)]
    if missing:
        raise PackError(f"{manifest}: missing required field(s) {', '.join(missing)}")

    targets = raw.get("targets") or {}
    if not isinstance(targets, dict):
        raise PackError(f"{manifest}: 'targets' must be an object")

    name = str(raw["name"])
    if name != pack_dir.name:
        raise PackError(
            f"{manifest}: pack name {name!r} does not match its directory "
            f"{pack_dir.name!r} — the directory is what callers reference"
        )

    return Pack(
        name=name,
        version=str(raw["version"]),
        description=str(raw.get("description", "")),
        targets={str(k): str(v) for k, v in targets.items()},
        path=pack_dir,
        maintainer=str(raw.get("maintainer", "")),
        source=str(raw.get("source", "local")),
        bootstrap=raw.get("bootstrap") or {},
        variants=_load_variants(raw, manifest),
        gate=raw.get("gate") or {},
    )


def _load_variants(raw: dict[str, Any], manifest: Path) -> tuple[PackVariant, ...]:
    declared = raw.get("variants") or []
    if not isinstance(declared, list):
        raise PackError(f"{manifest}: 'variants' must be a list")
    out: list[PackVariant] = []
    seen: set[str] = set()
    for entry in declared:
        if not isinstance(entry, dict):
            raise PackError(f"{manifest}: each variant must be an object")
        missing = [f for f in ("version", "dir") if not entry.get(f)]
        if missing:
            raise PackError(f"{manifest}: variant is missing {', '.join(missing)}")
        directory = str(entry["dir"])
        if directory in seen:
            raise PackError(f"{manifest}: two variants both use dir {directory!r}")
        seen.add(directory)
        variant_targets = entry.get("targets") or {}
        if not isinstance(variant_targets, dict):
            raise PackError(f"{manifest}: variant 'targets' must be an object")
        out.append(
            PackVariant(
                version=str(entry["version"]),
                dir=directory,
                targets={str(k): str(v) for k, v in variant_targets.items()},
                note=str(entry.get("note", "")),
            )
        )
    return tuple(out)


def load_packs(skills_root: Path) -> list[Pack]:
    """Load every pack under ``skills_root``, sorted by name.

    Directories starting with ``_`` are skipped: ``skills/_proposed/`` holds
    candidates emitted by the learning loop, which are not shippable until a
    human promotes them into a real pack.
    """
    if not skills_root.is_dir():
        return []
    packs: list[Pack] = []
    for entry in sorted(skills_root.iterdir()):
        if not entry.is_dir() or entry.name.startswith((".", "_")):
            continue
        packs.append(load_pack(entry))
    return packs


def _read_source(
    path: Path, kind: SkillKind, pack: Pack, fallback_name: str
) -> SkillSource:
    meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    wp = workpilot_meta(meta)

    raw_targets = wp.get("targets")
    if raw_targets is not None and not isinstance(raw_targets, dict):
        raise PackError(f"{path}: metadata.workpilot.targets must be a mapping")
    # `targets: {}` written out is not the same as no `targets` key at all.
    # The first says "applies everywhere" and must override a restrictive pack
    # default; only the second inherits.
    targets = (
        dict(pack.targets)
        if raw_targets is None
        else {str(k): str(v) for k, v in raw_targets.items()}
    )

    raw_requires = wp.get("requires") or {}
    if not isinstance(raw_requires, dict):
        raise PackError(f"{path}: metadata.workpilot.requires must be a mapping")

    return SkillSource(
        name=str(meta.get("name") or fallback_name),
        kind=kind,
        pack=pack.name,
        path=path,
        meta=meta,
        body=body,
        targets=targets,
        requires={str(k): v for k, v in raw_requires.items()},
        min_effort=(str(wp["min_effort"]) if wp.get("min_effort") else None),
    )


def _discover(pack: Pack) -> list[SkillSource]:
    found: list[SkillSource] = []

    skip = {"agents"} | pack.variant_dirs()
    for skill_dir in sorted(pack.path.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name in skip:
            continue
        skill_file = skill_dir / "SKILL.md"
        if skill_file.is_file():
            found.append(_read_source(skill_file, "skill", pack, skill_dir.name))
        else:
            logger.warning("%s: directory without a SKILL.md, ignored", skill_dir)

    agents_dir = pack.path / "agents"
    if agents_dir.is_dir():
        for agent_file in sorted(agents_dir.glob("*.md")):
            found.append(_read_source(agent_file, "agent", pack, agent_file.stem))

    return found
