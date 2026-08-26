"""Classifying what an upstream pack release did, and what to do about it.

The weekly sync notices that a pack moved. What it must decide next is whether
the move can be taken in place or whether it has to become a new variant, and
that decision is the whole non-regression promise: take a breaking change in
place and a project pinned to the old toolchain silently starts receiving
guidance written for a newer one.

`api_watcher.breaking_change_detector` already owns the vocabulary for this —
``ChangeCategory`` with its non-breaking / potentially-breaking / breaking
ladder — and that is what is reused. Its `diff()` is not: it compares API
contracts, endpoints and typed fields, and a skill pack is a set of named
instructions. The categories transfer; the comparison does not.

What breaks a consumer of a skill pack
--------------------------------------
Not the prose. What consumers depend on is:

* **a skill existing under its name** — a `workflow.yaml` phase says
  `superpowers/test-driven-development`, and a command palette lists it. A
  removal or rename breaks both.
* **it still resolving where it used to** — tightening `targets` or adding a
  `requires` removes the skill from projects that had it, which is a removal
  wearing a disguise.

A changed body is *potentially* breaking, and honestly so: it is an instruction
an agent will follow on real code, so it can change behaviour without changing
anything a resolver can see. It is reported for a human to read, which is why
the sync opens a pull request instead of merging one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "SkillFacts",
    "PackChange",
    "PackDiff",
    "classify_pack_diff",
    "facts_from_sources",
    "ChangeCategory",
]

try:  # the enum is the point of the reuse; a missing module must not be fatal
    from api_watcher.breaking_change_detector import ChangeCategory
except ImportError:  # pragma: no cover - only when api_watcher is unavailable
    from enum import Enum

    class ChangeCategory(str, Enum):  # type: ignore[no-redef]
        NON_BREAKING = "non_breaking"
        POTENTIALLY_BREAKING = "potentially_breaking"
        BREAKING = "breaking"


@dataclass(frozen=True)
class SkillFacts:
    """What a consumer can depend on about one skill.

    Everything a resolver reads, plus a digest of the body. Not the body
    itself: the point is to compare two releases, and holding two copies of
    every instruction in memory to answer "did it change?" is a waste when a
    hash answers it.
    """

    name: str
    kind: str = "skill"
    targets: dict[str, str] = field(default_factory=dict)
    requires: dict[str, Any] = field(default_factory=dict)
    body_digest: str = ""


@dataclass(frozen=True)
class PackChange:
    skill: str
    category: ChangeCategory
    detail: str


@dataclass
class PackDiff:
    pack: str
    changes: list[PackChange] = field(default_factory=list)

    @property
    def category(self) -> ChangeCategory:
        """The worst thing in the release, which is what decides the action."""
        for level in (
            ChangeCategory.BREAKING,
            ChangeCategory.POTENTIALLY_BREAKING,
            ChangeCategory.NON_BREAKING,
        ):
            if any(c.category == level for c in self.changes):
                return level
        return ChangeCategory.NON_BREAKING

    @property
    def is_breaking(self) -> bool:
        return self.category == ChangeCategory.BREAKING

    @property
    def needs_variant(self) -> bool:
        """Whether this release has to be taken as a new variant.

        Only an outright break. A potentially-breaking change is a prose change
        a reviewer reads; forking the pack for every reworded instruction would
        produce a variant a week and make the mechanism meaningless.
        """
        return self.is_breaking

    def bump(self, current: str) -> str:
        """The version this release earns, from the current one.

        Breaking goes to the next major, and that major becomes the *new*
        variant's version — the old one keeps the number it was pinned at.
        """
        parts = (list(map(int, current.split("."))) + [0, 0, 0])[:3]
        if self.is_breaking:
            return f"{parts[0] + 1}.0.0"
        if self.category == ChangeCategory.POTENTIALLY_BREAKING:
            return f"{parts[0]}.{parts[1] + 1}.0"
        return f"{parts[0]}.{parts[1]}.{parts[2] + 1}"

    def summary(self) -> str:
        if not self.changes:
            return f"`{self.pack}` — no consumer-visible change"
        counts: dict[str, int] = {}
        for change in self.changes:
            counts[change.category.value] = counts.get(change.category.value, 0) + 1
        tally = ", ".join(f"{n} {label}" for label, n in sorted(counts.items()))
        lines = [f"`{self.pack}` — {self.category.value} ({tally})"]
        lines += [
            f"  - {c.skill}: {c.detail}"
            for c in self.changes
            if c.category != ChangeCategory.NON_BREAKING
        ]
        return "\n".join(lines)


def classify_pack_diff(
    pack: str, before: list[SkillFacts], after: list[SkillFacts]
) -> PackDiff:
    """Compare two releases of a pack on what consumers can depend on."""
    old = {f.name: f for f in before}
    new = {f.name: f for f in after}
    diff = PackDiff(pack=pack)

    for name in sorted(old.keys() - new.keys()):
        diff.changes.append(
            PackChange(
                name,
                ChangeCategory.BREAKING,
                "removed — a workflow phase or palette entry naming it stops resolving",
            )
        )

    for name in sorted(new.keys() - old.keys()):
        diff.changes.append(PackChange(name, ChangeCategory.NON_BREAKING, "added"))

    for name in sorted(old.keys() & new.keys()):
        diff.changes.extend(_compare(old[name], new[name]))

    return diff


def _compare(old: SkillFacts, new: SkillFacts) -> list[PackChange]:
    changes: list[PackChange] = []

    if old.kind != new.kind:
        changes.append(
            PackChange(
                new.name,
                ChangeCategory.BREAKING,
                f"changed from {old.kind} to {new.kind} — it is emitted somewhere else now",
            )
        )

    if old.targets != new.targets:
        # A widened target adds projects and removes none. A narrowed or
        # replaced one takes the skill away from projects that had it, which is
        # a removal for everyone it happens to.
        widened = _is_widening(old.targets, new.targets)
        changes.append(
            PackChange(
                new.name,
                ChangeCategory.NON_BREAKING if widened else ChangeCategory.BREAKING,
                (
                    f"targets widened {old.targets or '{}'} → {new.targets or '{}'}"
                    if widened
                    else f"targets narrowed {old.targets or '{}'} → {new.targets or '{}'}"
                    " — projects that resolved it no longer will"
                ),
            )
        )

    if old.requires != new.requires:
        added = set(new.requires) - set(old.requires)
        changes.append(
            PackChange(
                new.name,
                ChangeCategory.BREAKING if added else ChangeCategory.NON_BREAKING,
                f"requires now {new.requires or '{}'} (was {old.requires or '{}'})",
            )
        )

    if old.body_digest != new.body_digest:
        changes.append(
            PackChange(
                new.name,
                ChangeCategory.POTENTIALLY_BREAKING,
                "instructions changed — read them, the agent will follow them",
            )
        )

    return changes


def _is_widening(old: dict[str, str], new: dict[str, str]) -> bool:
    """Whether the new targets can only apply to more projects than the old.

    Only one case is provably a widening without evaluating every version in
    existence: dropping a constraint. Anything else — a changed range, a new
    tool — is treated as narrowing, because being wrong in that direction costs
    a variant nobody needed, and being wrong in the other costs a project the
    guidance it was written for.
    """
    if not new:
        return bool(old)
    return set(new) < set(old) and all(new[k] == old[k] for k in new)


def facts_from_sources(sources: list) -> list[SkillFacts]:
    """Build the comparable facts from resolved `SkillSource`s."""
    from .build import content_hash

    return [
        SkillFacts(
            name=src.name,
            kind=src.kind,
            targets=dict(src.targets),
            requires=dict(src.requires),
            body_digest=content_hash(src),
        )
        for src in sources
    ]
