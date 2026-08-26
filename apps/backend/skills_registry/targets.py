"""Toolchain version ranges — the first of the two axes skills are pinned on.

A skill declares which toolchain versions its content is valid for::

    metadata.workpilot.targets: { dotnet: ">=10.0" }

and a consuming project declares what it is actually on::

    [targets]
    dotnet = "8.0"

The resolver keeps a skill only when every one of its declared targets is
satisfied. This is what stops a project on .NET Framework 4.8 from being handed
guidance written for C# 14 — the two coexist in the repo today.

Supported range syntax, deliberately a small subset of npm semver:

===================  ==============================================
``>=10.0``           at least 10.0
``>=4.8 <5.0``       space-separated clauses, all must hold (AND)
``^2.1``             >=2.1.0 <3.0.0   (caret: same major)
``~2.1``             >=2.1.0 <2.2.0   (tilde: same minor)
``1.2.3`` / ``=1.2`` exact, with absent components meaning zero
``*`` / ``""``       anything
===================  ==============================================

Anything unparseable raises ``ValueError`` rather than silently matching: a
typo in a range must fail the build, not quietly ship the wrong variant.
"""

from __future__ import annotations

import re
from typing import NamedTuple

__all__ = ["Version", "parse_version", "satisfies", "targets_match"]

_VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$")
_CLAUSE_RE = re.compile(r"^(>=|<=|>|<|\^|~|=)?\s*(.+)$")


class Version(NamedTuple):
    """A comparable (major, minor, patch) triple."""

    major: int
    minor: int
    patch: int

    def __str__(self) -> str:  # pragma: no cover - debugging aid
        return f"{self.major}.{self.minor}.{self.patch}"


def parse_version(text: str) -> Version:
    """Parse ``"10"``, ``"10.1"``, ``"v10.1.2"``, ``"1.2.3-rc1"`` into a Version.

    Missing components are zero. Pre-release and build suffixes are dropped:
    the ranges here express toolchain applicability, not release ordering, and
    treating ``10.0.0-preview`` as 10.0.0 is the answer a skill author means.
    """
    m = _VERSION_RE.match(text.strip())
    if not m:
        raise ValueError(f"not a version: {text!r}")
    return Version(int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))


def _eval_clause(actual: Version, op: str, bound: Version) -> bool:
    if op == ">=":
        return actual >= bound
    if op == ">":
        return actual > bound
    if op == "<=":
        return actual <= bound
    if op == "<":
        return actual < bound
    if op == "^":
        upper = Version(bound.major + 1, 0, 0)
        return bound <= actual < upper
    if op == "~":
        upper = Version(bound.major, bound.minor + 1, 0)
        return bound <= actual < upper
    # "=" or bare
    return actual == bound


def satisfies(version: str, spec: str) -> bool:
    """Return whether ``version`` satisfies the range ``spec``.

    Raises ``ValueError`` on an unparseable version or range.
    """
    spec = (spec or "").strip()
    if spec in ("", "*", "x", "any", "latest"):
        return True

    actual = parse_version(version)
    for clause in spec.split():
        m = _CLAUSE_RE.match(clause.strip())
        if not m:
            raise ValueError(f"not a version range clause: {clause!r} (in {spec!r})")
        op = m.group(1) or "="
        bound = parse_version(m.group(2))
        if not _eval_clause(actual, op, bound):
            return False
    return True


def targets_match(
    declared: dict[str, str] | None, project: dict[str, str] | None
) -> tuple[bool, str]:
    """Check a skill's declared targets against a project's toolchain versions.

    Returns ``(ok, reason)``. ``reason`` is empty on success and human-readable
    on failure, so ``skills-cli why`` can explain a skip instead of leaving the
    user guessing.

    A target the project says nothing about is **not** a match: if a skill
    declares ``{dotnet: ">=10"}`` and the project has no .NET at all, the skill
    does not apply. Declaring no targets means "applies everywhere".
    """
    declared = declared or {}
    project = project or {}
    if not declared:
        return True, ""

    for tool, spec in declared.items():
        actual = project.get(tool)
        if actual is None:
            return False, f"project declares no {tool!r} version (skill needs {spec})"
        if not satisfies(str(actual), str(spec)):
            return False, f"{tool} {actual} does not satisfy {spec}"
    return True, ""
