"""Declarative agentic workflows.

`workflows/<name>/workflow.yaml` describes the phases of a build; this package
loads one and resolves it against the effort level the user chose, the
provider's capabilities and the files a task touched.
"""

from .engine import (
    ExecutionProfile,
    MissingImpl,
    ResolvedPhase,
    resolve_profile,
    validate_impls,
)
from .gates import GateRun, GateVerdict, run_deterministic_gates
from .hard_gates import HardGateReport, HardGateResult, evaluate_hard_gates
from .spec import EFFORT_ORDER, Phase, Workflow, WorkflowError, load_workflow

__all__ = [
    "EFFORT_ORDER",
    "ExecutionProfile",
    "GateRun",
    "GateVerdict",
    "HardGateReport",
    "HardGateResult",
    "MissingImpl",
    "Phase",
    "ResolvedPhase",
    "Workflow",
    "WorkflowError",
    "evaluate_hard_gates",
    "load_workflow",
    "resolve_profile",
    "run_deterministic_gates",
    "validate_impls",
]
