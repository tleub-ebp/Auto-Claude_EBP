"""`hard_gate` stops being a claim nobody checks.

The flag did exactly one thing before: keep a phase out of the effort pruner.
Its docstring said "tests passing is not negotiable" and nothing anywhere
evaluated whether they passed, so a build could conclude green with a red
suite — the failure a hard gate exists to make impossible.

Two rules are pinned here. A gate that **failed** is reported as failed. A gate
that could not be evaluated is reported as **unknown**, not as either outcome:
blocking on missing evidence would make every project without a QA report
unbuildable, and passing on it would restore the exact hole this closes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.hard_gates import HardGateReport, HardGateResult  # noqa: E402

from workflows import (  # noqa: E402
    evaluate_hard_gates,
    load_workflow,
    resolve_profile,
)

WORKFLOW = load_workflow(REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml")


def _profile(effort="medium"):
    return resolve_profile(WORKFLOW, effort, changed_files=None)


# ── the shipped workflow ──────────────────────────────────────────────────────


def test_the_workflow_declares_a_hard_gate():
    """If this stops being true, the rest of the file tests nothing."""
    gates = [p.hard_gate for p in WORKFLOW.phases if p.hard_gate]
    assert gates == ["tests-pass"]


@pytest.mark.parametrize("effort", ["none", "low", "medium", "high", "ultrathink"])
def test_the_gate_is_evaluated_at_every_effort_level(tmp_path: Path, effort: str):
    report = evaluate_hard_gates(_profile(effort), tmp_path, tests_passed=True)
    assert [r.phase_id for r in report.results] == ["verify"], effort


# ── the three outcomes ────────────────────────────────────────────────────────


def test_green_tests_hold_the_gate(tmp_path: Path):
    report = evaluate_hard_gates(_profile(), tmp_path, tests_passed=True)
    assert report.results[0].held is True
    assert not report.blocking
    assert "✓" in report.describe()


def test_red_tests_break_the_gate(tmp_path: Path):
    """The case that used to pass silently."""
    report = evaluate_hard_gates(_profile(), tmp_path, tests_passed=False)
    assert report.results[0].held is False
    assert report.blocking
    assert "NOT MET" in report.describe()
    assert "records failing tests" in report.results[0].detail


def test_missing_evidence_is_unknown_and_does_not_block(tmp_path: Path):
    report = evaluate_hard_gates(_profile(), tmp_path, tests_passed=None)
    assert report.results[0].held is None
    assert report.unknown
    assert not report.blocking, "blocked a build on evidence that was merely absent"
    assert "does not record" in report.results[0].detail


def test_unknown_is_not_reported_as_a_pass(tmp_path: Path):
    report = evaluate_hard_gates(_profile(), tmp_path, tests_passed=None)
    assert "✓" not in report.describe()


# ── robustness ────────────────────────────────────────────────────────────────


def test_a_typo_in_the_gate_name_does_not_switch_it_off(tmp_path: Path):
    """A gate nothing evaluates must say so, not quietly succeed."""
    import copy

    workflow = copy.deepcopy(WORKFLOW)
    for phase in workflow.phases:
        if phase.hard_gate:
            object.__setattr__(phase, "hard_gate", "tests-passs")
    report = evaluate_hard_gates(
        resolve_profile(workflow, "medium", changed_files=None),
        tmp_path,
        tests_passed=True,
    )
    assert report.results[0].held is None
    assert "unknown gate" in report.results[0].detail


def test_a_profile_with_no_hard_gate_reports_nothing(tmp_path: Path):
    class Empty:
        run: list = []

    report = evaluate_hard_gates(Empty(), tmp_path, tests_passed=False)
    assert report.results == []
    assert not report.blocking
    assert report.describe() == ""


def test_evaluation_never_raises(tmp_path: Path):
    class Exploding:
        @property
        def run(self):
            raise RuntimeError("profile is corrupt")

    report = evaluate_hard_gates(Exploding(), tmp_path, tests_passed=True)
    assert report.results == []


def test_only_a_definite_failure_blocks():
    report = HardGateReport(
        results=[
            HardGateResult("verify", "tests-pass", None),
            HardGateResult("other", "tests-pass", True),
        ]
    )
    assert not report.blocking
    assert report.unknown


# ── the gate and the learning loop read the same evidence ─────────────────────


def test_the_gate_and_observe_cannot_disagree(tmp_path: Path):
    """Both are handed the same `tests_passed`, not two parsers of one file.

    Two readings of `qa_report.md` that drifted apart would let the gate fail a
    build while the learning loop recorded the run as corroboration.
    """
    from learning_loop.observe import BuildOutcome, signals_from_outcome
    from learning_loop.skill_proposer import ExternalSignal

    for value in (True, False, None):
        report = evaluate_hard_gates(_profile(), tmp_path, tests_passed=value)
        signals = signals_from_outcome(BuildOutcome(spec_id="x", tests_passed=value))
        gate_held = report.results[0].held
        recorded = ExternalSignal.TESTS_PASSED in signals
        assert gate_held is value
        assert recorded is (value is True)
