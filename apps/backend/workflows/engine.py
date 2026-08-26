"""Resolving a workflow against the effort, the provider and the change set.

This is where "the same pipeline whatever the provider" and "respect the LLM
and effort the user chose" become one mechanism instead of two.

Pruning by effort
-----------------
Today the pipeline runs the same number of passes on `low`/Haiku as on
`ultrathink`/Opus. That is the wrong answer in both directions: it wastes money
on a typo fix and under-thinks an architectural change. Each phase declares the
effort it earns its keep at, and the resolver drops the rest.

Two things are never pruned:

* ``hard_gate`` — the tests passing is not a budget decision.
* deterministic phases — a detector that runs locally with no API call costs
  nothing, so there is no level at which skipping it saves anything.

Degrading by provider
---------------------
A phase asking for ``subagent-per-task`` on a provider with no subagents cannot
have it. It degrades to sequential execution with a context reset — same
isolation, no parallelism — rather than silently pretending to dispatch.
"""

from __future__ import annotations

import fnmatch
import logging
from dataclasses import dataclass, field
from pathlib import Path

from .spec import Phase, Workflow, effort_at_least

logger = logging.getLogger(__name__)

__all__ = [
    "ResolvedPhase",
    "ExecutionProfile",
    "MissingImpl",
    "resolve_profile",
    "validate_impls",
    "DETERMINISTIC_PACKS",
    "BUILTIN_PACKS",
]

# Phases implemented by WorkPilot's own Python, not by a skill pack.
BUILTIN_PACKS = frozenset({"workpilot"})

# Packs whose phases run without an API call. Pruning them by effort saves
# nothing, so they run at every level.
DETERMINISTIC_PACKS = frozenset({"impeccable"})

_SKIP_EFFORT = "effort"
_SKIP_UNTOUCHED = "untouched"


@dataclass(frozen=True)
class ResolvedPhase:
    phase: Phase
    dispatch: str
    """What will actually happen, after provider degradation."""
    degraded_from: str | None = None
    reason: str = ""

    @property
    def id(self) -> str:
        return self.phase.id


@dataclass
class ExecutionProfile:
    workflow: str
    effort: str
    provider: str | None
    run: list[ResolvedPhase] = field(default_factory=list)
    skipped: list[tuple[Phase, str]] = field(default_factory=list)

    @property
    def phase_ids(self) -> list[str]:
        return [r.id for r in self.run]

    def will_run(self, phase_id: str) -> bool:
        return any(r.id == phase_id for r in self.run)

    def describe(self) -> str:
        """A short, human-readable summary printed before a build starts.

        The user picked an effort level; they should be able to see what it
        bought or cost before the run rather than infer it afterwards.
        """
        lines = [
            f"Workflow '{self.workflow}' at effort '{self.effort}'"
            + (f" on {self.provider}" if self.provider else "")
        ]
        # Width from the actual ids: a fixed pad silently breaks the columns
        # the first time someone adds a phase with a longer name.
        ids = [r.id for r in self.run] + [p.id for p, _ in self.skipped]
        width = max((len(i) for i in ids), default=0)

        for resolved in self.run:
            suffix = ""
            if resolved.degraded_from:
                suffix = f"  [{resolved.degraded_from} → {resolved.dispatch}: {resolved.reason}]"
            elif resolved.dispatch != "inline":
                suffix = f"  [{resolved.dispatch}]"
            marker = "!" if resolved.phase.hard_gate else " "
            lines.append(
                f"  {marker} {resolved.id:<{width}} {resolved.phase.impl}{suffix}"
            )
        for phase, why in self.skipped:
            detail = (
                f"needs effort ≥ {phase.min_effort}"
                if why == _SKIP_EFFORT
                else "no matching files changed"
            )
            lines.append(f"  - {phase.id:<{width}} skipped ({detail})")
        return "\n".join(lines)


def _touched(globs: tuple[str, ...], changed_files: list[str] | None) -> bool:
    """Whether any changed file matches. Unknown change set means run it.

    Erring towards running a conditional phase is the safe direction: the cost
    is one extra pass, whereas skipping a design review on a change that did
    touch the UI is a defect that ships.
    """
    if not globs:
        return True
    if changed_files is None:
        return True
    for path in changed_files:
        normalised = str(path).replace("\\", "/")
        for pattern in globs:
            if fnmatch.fnmatch(normalised, pattern) or fnmatch.fnmatch(
                Path(normalised).name, pattern
            ):
                return True
    return False


def _degrade(phase: Phase, supports_subagents: bool) -> ResolvedPhase:
    if phase.dispatch == "subagent-per-task" and not supports_subagents:
        return ResolvedPhase(
            phase=phase,
            dispatch="sequential-reset",
            degraded_from="subagent-per-task",
            reason="provider runs no subagents",
        )
    return ResolvedPhase(phase=phase, dispatch=phase.dispatch)


def resolve_profile(
    workflow: Workflow,
    effort: str,
    *,
    provider: str | None = None,
    changed_files: list[str] | None = None,
) -> ExecutionProfile:
    """Decide which phases run, and how."""
    supports_subagents = True
    if provider:
        try:
            from skills_registry.providers import get_provider_capabilities

            supports_subagents = get_provider_capabilities(provider).supports_subagents
        except Exception as exc:  # capability lookup must not block a build
            logger.debug("provider capability lookup failed: %s", exc)

    profile = ExecutionProfile(workflow=workflow.name, effort=effort, provider=provider)

    for phase in workflow.phases:
        deterministic = phase.pack in DETERMINISTIC_PACKS

        if phase.prunable and not deterministic:
            if not effort_at_least(effort, phase.min_effort):
                profile.skipped.append((phase, _SKIP_EFFORT))
                continue

        # A hard gate still runs, but a conditional phase with nothing to look
        # at has no work to do regardless of its gate status.
        if not _touched(phase.when_globs, changed_files):
            profile.skipped.append((phase, _SKIP_UNTOUCHED))
            continue

        profile.run.append(_degrade(phase, supports_subagents))

    return profile


@dataclass(frozen=True)
class MissingImpl:
    """A phase whose implementation is not installed."""

    phase_id: str
    impl: str
    pack: str
    reason: str


def validate_impls(
    workflow: Workflow, available: dict[str, set[str]]
) -> list[MissingImpl]:
    """Report phases whose implementation cannot be found.

    ``available`` maps pack name to the skill names it provides.

    Reported, never fatal. Several packs are vendored on demand, so a fresh
    clone legitimately has phases it cannot run yet; the answer is to tell the
    user which bootstrap they are missing, not to refuse to build. Discovering
    it mid-run, on the other hand, wastes a whole build.
    """
    missing: list[MissingImpl] = []
    for phase in workflow.phases:
        if phase.pack in BUILTIN_PACKS:
            continue
        skills = available.get(phase.pack)
        if skills is None:
            missing.append(
                MissingImpl(
                    phase.id,
                    phase.impl,
                    phase.pack,
                    f"pack {phase.pack!r} is not installed "
                    f"(pnpm run skills:bootstrap --pack {phase.pack})",
                )
            )
        elif phase.skill not in skills:
            missing.append(
                MissingImpl(
                    phase.id,
                    phase.impl,
                    phase.pack,
                    f"pack {phase.pack!r} provides no skill named {phase.skill!r}",
                )
            )
    return missing
