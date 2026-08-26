"""Enforcing the gates a workflow says are not negotiable.

`hard_gate: tests-pass` was declared on the `verify` phase and applied nowhere.
The flag did one thing — kept the phase out of the effort pruner — and the
docstring said "tests passing is not negotiable" while nothing checked whether
they passed. A build could conclude green with a red suite.

What a hard gate is, and is not
-------------------------------
It is a **claim about the build's outcome**, evaluated from evidence the build
already produced. It is not a phase that runs an agent: `verify`'s
implementation is a skill that tells a model how to check its work, and that
still runs through the ordinary pipeline. This module answers the separate
question the flag was always making — *did it actually hold?*

Unknown is not a pass, and not a failure either
-----------------------------------------------
A QA report that does not say whether tests ran leaves the gate `None`. That is
deliberate and it is the same rule as everywhere else in this refactor: the
build is not blocked on an absent signal, and the absent signal is never
recorded as corroboration. A gate that could not be evaluated is reported as
such, loudly enough that someone notices the evidence is missing.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "HardGateResult",
    "HardGateReport",
    "evaluate_hard_gates",
    "TESTS_PASS",
]

TESTS_PASS = "tests-pass"


@dataclass(frozen=True)
class HardGateResult:
    phase_id: str
    gate: str
    held: bool | None
    """None when the evidence to decide was not there."""
    detail: str = ""

    def describe(self) -> str:
        if self.held is None:
            return f"  ?  {self.phase_id}: {self.gate} — {self.detail or 'no evidence'}"
        mark = "✓" if self.held else "✗"
        return f"  {mark}  {self.phase_id}: {self.gate}" + (
            f" — {self.detail}" if self.detail else ""
        )


@dataclass
class HardGateReport:
    results: list[HardGateResult] = field(default_factory=list)

    @property
    def failed(self) -> list[HardGateResult]:
        return [r for r in self.results if r.held is False]

    @property
    def unknown(self) -> list[HardGateResult]:
        return [r for r in self.results if r.held is None]

    @property
    def blocking(self) -> bool:
        """Whether a gate was evaluated and did not hold.

        Only a definite failure blocks. An unevaluable gate is surfaced but
        does not stop a build that may be perfectly fine — refusing on missing
        evidence would make every project without a QA report unbuildable.
        """
        return bool(self.failed)

    def describe(self) -> str:
        if not self.results:
            return ""
        head = "Hard gates:"
        if self.blocking:
            head = "Hard gates — NOT MET:"
        return "\n".join([head, *(r.describe() for r in self.results)])


def evaluate_hard_gates(profile, spec_dir: Path, *, tests_passed: bool | None = None):
    """Check every hard gate the profile kept, against what the build produced.

    ``tests_passed`` is the caller's reading of the test evidence — the same
    value `observe` records — so the two agree by construction rather than by
    two parsers happening to say the same thing.

    Never raises. A gate reports; the caller decides what a failure means.
    """
    report = HardGateReport()
    try:
        for resolved in profile.run:
            gate = resolved.phase.hard_gate
            if not gate:
                continue
            if gate == TESTS_PASS:
                report.results.append(
                    HardGateResult(
                        phase_id=resolved.id,
                        gate=gate,
                        held=tests_passed,
                        detail=(
                            ""
                            if tests_passed
                            else "the QA report does not record a passing test run"
                            if tests_passed is None
                            else "the QA report records failing tests"
                        ),
                    )
                )
            else:
                # An unknown gate name is reported, never silently satisfied.
                # A typo in `workflow.yaml` must not switch a gate off.
                report.results.append(
                    HardGateResult(
                        phase_id=resolved.id,
                        gate=gate,
                        held=None,
                        detail=f"unknown gate {gate!r} — nothing evaluates it",
                    )
                )
    except Exception as exc:  # noqa: BLE001 - a gate reports, it does not crash
        logger.warning("hard gate evaluation failed: %s", exc)
    return report
