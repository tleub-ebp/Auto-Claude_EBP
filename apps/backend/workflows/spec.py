"""The shape of a declarative workflow.

`cli/build_commands.py` hard-codes the sequence planning → coding → QA in
Python. There is no way to insert a phase, skip one, or run a different
methodology's implementation of one without editing that function. A
`workflow.yaml` makes the sequence data.

The phase vocabulary deliberately extends the one that already exists
(`spec`, `planning`, `coding`, `qa` from `phase_config.DEFAULT_PHASE_MODELS`)
rather than inventing a parallel one, so per-phase model and effort resolution
keeps working unchanged.

Phase fields
------------
``id``          the phase name; drives model/effort lookup via phase_config
``impl``        ``<pack>/<skill>`` — which methodology implements this phase
``min_effort``  pruned below this effort level (default: never pruned)
``hard_gate``   never pruned at any effort. Tests passing is not negotiable.
``always``      never pruned, but not a gate — for near-free phases like observation
``dispatch``    ``subagent-per-task`` | ``fresh-context`` | ``inline``
``when``        ``touches("<globs>")`` — run only when matching files changed
``gate``        ``human`` — stop for approval before continuing
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "EFFORT_ORDER",
    "Phase",
    "Workflow",
    "WorkflowError",
    "load_workflow",
    "effort_at_least",
]

# Ordered weakest to strongest. Mirrors phase_config.THINKING_BUDGET_MAP, which
# is the vocabulary the UI already exposes.
EFFORT_ORDER: tuple[str, ...] = ("none", "low", "medium", "high", "ultrathink")

_DISPATCH = {"subagent-per-task", "fresh-context", "inline"}
_TOUCHES_RE = re.compile(r'^touches\(\s*"(?P<globs>[^"]*)"\s*\)$')


class WorkflowError(Exception):
    """A workflow file is malformed. Fatal: guessing at a broken workflow runs
    the wrong phases, which is worse than not running."""


def effort_at_least(actual: str, minimum: str) -> bool:
    """Whether ``actual`` is at least as strong as ``minimum``."""
    try:
        return EFFORT_ORDER.index(actual) >= EFFORT_ORDER.index(minimum)
    except ValueError as exc:
        raise WorkflowError(
            f"unknown effort level; expected one of {', '.join(EFFORT_ORDER)}"
        ) from exc


@dataclass(frozen=True)
class Phase:
    id: str
    impl: str
    min_effort: str = "none"
    hard_gate: str | None = None
    always: bool = False
    dispatch: str = "inline"
    when_globs: tuple[str, ...] = ()
    gate: str | None = None
    description: str = ""

    @property
    def prunable(self) -> bool:
        return not (self.always or self.hard_gate)

    @property
    def pack(self) -> str:
        return self.impl.split("/", 1)[0]

    @property
    def skill(self) -> str:
        return self.impl.split("/", 1)[1] if "/" in self.impl else self.impl


@dataclass(frozen=True)
class Workflow:
    name: str
    phases: tuple[Phase, ...]
    description: str = ""
    path: Path | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def phase(self, phase_id: str) -> Phase | None:
        return next((p for p in self.phases if p.id == phase_id), None)


def _parse_when(raw: Any, phase_id: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, str):
        raise WorkflowError(f"phase {phase_id!r}: 'when' must be a string")
    m = _TOUCHES_RE.match(raw.strip())
    if not m:
        raise WorkflowError(
            f"phase {phase_id!r}: unsupported condition {raw!r}. "
            'The only form is touches("glob,glob").'
        )
    return tuple(g.strip() for g in m.group("globs").split(",") if g.strip())


def _parse_phase(raw: Any, index: int) -> Phase:
    if not isinstance(raw, dict):
        raise WorkflowError(f"phase #{index}: expected a mapping")
    phase_id = raw.get("id")
    if not phase_id:
        raise WorkflowError(f"phase #{index}: missing 'id'")
    impl = raw.get("impl")
    if not impl:
        raise WorkflowError(f"phase {phase_id!r}: missing 'impl'")

    min_effort = str(raw.get("min_effort", "none"))
    if min_effort not in EFFORT_ORDER:
        raise WorkflowError(
            f"phase {phase_id!r}: min_effort {min_effort!r} is not one of "
            f"{', '.join(EFFORT_ORDER)}"
        )
    dispatch = str(raw.get("dispatch", "inline"))
    if dispatch not in _DISPATCH:
        raise WorkflowError(
            f"phase {phase_id!r}: dispatch {dispatch!r} is not one of "
            f"{', '.join(sorted(_DISPATCH))}"
        )
    gate = raw.get("gate")
    if gate not in (None, "human"):
        raise WorkflowError(f"phase {phase_id!r}: gate {gate!r} — only 'human' exists")

    return Phase(
        id=str(phase_id),
        impl=str(impl),
        min_effort=min_effort,
        hard_gate=(str(raw["hard_gate"]) if raw.get("hard_gate") else None),
        always=bool(raw.get("always", False)),
        dispatch=dispatch,
        when_globs=_parse_when(raw.get("when"), str(phase_id)),
        gate=gate,
        description=str(raw.get("description", "")),
    )


def load_workflow(path: Path) -> Workflow:
    if not path.is_file():
        raise WorkflowError(f"no workflow at {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise WorkflowError(f"{path}: invalid YAML — {exc}") from exc
    if not isinstance(raw, dict):
        raise WorkflowError(f"{path}: expected a mapping at the top level")

    phases_raw = raw.get("phases")
    if not isinstance(phases_raw, list) or not phases_raw:
        raise WorkflowError(f"{path}: 'phases' must be a non-empty list")

    phases = tuple(_parse_phase(p, i) for i, p in enumerate(phases_raw))
    seen: set[str] = set()
    for phase in phases:
        if phase.id in seen:
            raise WorkflowError(f"{path}: duplicate phase id {phase.id!r}")
        seen.add(phase.id)

    return Workflow(
        name=str(raw.get("name") or path.parent.name),
        phases=phases,
        description=str(raw.get("description", "")),
        path=path,
        metadata=raw.get("metadata") or {},
    )
