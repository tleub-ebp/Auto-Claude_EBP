"""Deterministic gates: the first workflow phase the engine actually executes.

Everything else in `workflow.yaml` is still run by the hard-coded pipeline
behind `WORKPILOT_WORKFLOW_ENGINE=1`. A deterministic gate is different: it
needs no provider, no session and no budget, so the engine can run it today —
which is what turns the declaration into something that happens.

The property that matters most is not that a gate runs. It is that a gate which
*did not* run is reported as unknown. `GateRun.all_clean` feeds
`BuildOutcome.detector_clean`, which feeds the learning loop's external-signal
gate; collapsing "the tool was not installed" into "clean" would manufacture
exactly the corroboration the promotion rules exist to refuse.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.packs import load_pack  # noqa: E402
from workflows.gates import GateRun, GateVerdict  # noqa: E402

from workflows import (  # noqa: E402
    load_workflow,
    resolve_profile,
    run_deterministic_gates,
)

WORKFLOW = load_workflow(REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml")


@dataclass
class FakePack:
    name: str
    gate: dict


def _profile(changed_files=None, effort="medium"):
    return resolve_profile(WORKFLOW, effort, changed_files=changed_files)


def _packs(command, name="impeccable"):
    return {name: FakePack(name, {"command": command} if command else {})}


# ── what runs ─────────────────────────────────────────────────────────────────


def test_a_frontend_change_runs_the_gate(tmp_path: Path):
    run = run_deterministic_gates(_profile(["src/App.tsx"]), tmp_path, _packs(["true"]))
    assert [v.phase_id for v in run.verdicts] == ["design-check"]
    assert run.all_clean is True


def test_a_backend_change_runs_no_frontend_gate(tmp_path: Path):
    run = run_deterministic_gates(
        _profile(["apps/backend/core/client.py"]), tmp_path, _packs(["true"])
    )
    assert run.verdicts == []
    assert run.all_clean is None


def test_an_unknown_change_set_runs_the_gate(tmp_path: Path):
    """One extra local check beats skipping a design review that applied."""
    run = run_deterministic_gates(_profile(None), tmp_path, _packs(["true"]))
    assert [v.phase_id for v in run.verdicts] == ["design-check"]


@pytest.mark.parametrize("effort", ["none", "low", "medium", "high", "ultrathink"])
def test_the_gate_runs_at_every_effort_level(tmp_path: Path, effort: str):
    """It costs no tokens, so there is no level at which skipping it saves."""
    run = run_deterministic_gates(
        _profile(["src/App.tsx"], effort), tmp_path, _packs(["true"])
    )
    assert [v.phase_id for v in run.verdicts] == ["design-check"], effort


def test_a_pack_with_no_gate_is_skipped(tmp_path: Path):
    """Most deterministic packs are guidance; only some ship a checker."""
    run = run_deterministic_gates(_profile(["src/App.tsx"]), tmp_path, _packs(None))
    assert run.verdicts == []


def test_a_missing_pack_is_skipped(tmp_path: Path):
    run = run_deterministic_gates(_profile(["src/App.tsx"]), tmp_path, {})
    assert run.verdicts == []


# ── verdicts ──────────────────────────────────────────────────────────────────


def test_a_non_zero_exit_is_a_finding(tmp_path: Path):
    run = run_deterministic_gates(
        _profile(["src/App.tsx"]), tmp_path, _packs(["false"])
    )
    assert run.all_clean is False
    assert run.verdicts[0].clean is False


def test_findings_are_counted_from_the_json_output(tmp_path: Path):
    script = tmp_path / "detect.py"
    script.write_text(
        'import sys, json\nprint(json.dumps({"findings": [1, 2, 3]}))\nsys.exit(1)\n',
        encoding="utf-8",
    )
    run = run_deterministic_gates(
        _profile(["src/App.tsx"]), tmp_path, _packs([sys.executable, str(script)])
    )
    assert run.verdicts[0].findings == 3


def test_unparseable_output_degrades_the_message_not_the_verdict(tmp_path: Path):
    """The verdict is the exit status, which is the contract the pack declares."""
    script = tmp_path / "detect.py"
    script.write_text("import sys\nprint('not json')\nsys.exit(1)\n", encoding="utf-8")
    run = run_deterministic_gates(
        _profile(["src/App.tsx"]), tmp_path, _packs([sys.executable, str(script)])
    )
    assert run.verdicts[0].clean is False
    assert run.verdicts[0].findings == 0


def test_a_gate_that_is_not_installed_is_unknown_not_clean(tmp_path: Path):
    """The failure this file exists to prevent."""
    run = run_deterministic_gates(
        _profile(["src/App.tsx"]), tmp_path, _packs(["definitely-not-a-command"])
    )
    assert run.verdicts[0].clean is None
    assert run.all_clean is None, "an unrunnable gate was reported as corroboration"
    assert "skills:bootstrap" in run.verdicts[0].detail


def test_a_gate_that_crashes_is_unknown_not_a_failure(tmp_path: Path):
    run = GateRun(
        verdicts=[GateVerdict("design-check", "impeccable", None, detail="boom")]
    )
    assert run.all_clean is None
    assert not run.ran


def test_one_unknown_gate_makes_the_whole_run_unknown():
    run = GateRun(
        verdicts=[
            GateVerdict("a", "impeccable", True),
            GateVerdict("b", "impeccable", None, detail="not installed"),
        ]
    )
    assert run.all_clean is None


def test_an_empty_run_is_unknown_not_clean():
    assert GateRun().all_clean is None


# ── what the learning loop is handed ──────────────────────────────────────────


@pytest.mark.parametrize(
    "all_clean,expects_signal",
    [(True, True), (False, False), (None, False)],
)
def test_only_a_clean_verdict_becomes_an_external_signal(all_clean, expects_signal):
    from learning_loop.observe import BuildOutcome, signals_from_outcome
    from learning_loop.skill_proposer import ExternalSignal

    signals = signals_from_outcome(BuildOutcome(spec_id="x", detector_clean=all_clean))
    assert (ExternalSignal.DETECTOR_CLEAN in signals) is expects_signal


# ── the report ────────────────────────────────────────────────────────────────


def test_the_report_says_which_gate_and_what_it_found(tmp_path: Path):
    run = run_deterministic_gates(
        _profile(["src/App.tsx"]), tmp_path, _packs(["false"])
    )
    summary = run.describe()
    assert "design-check" in summary
    assert "impeccable" in summary


def test_an_empty_run_reports_nothing():
    assert GateRun().describe() == ""


# ── the pack this repo ships ──────────────────────────────────────────────────


def test_impeccable_declares_its_gate():
    """The command is data, not a branch in the engine."""
    pack = load_pack(REPO_ROOT / "skills" / "impeccable")
    assert pack.gate.get("command"), "impeccable ships no gate command"
    assert "detect" in pack.gate["command"]
    assert pack.gate.get("clean_when") == "exit_zero"


def test_a_pack_without_a_gate_parses_fine(tmp_path: Path):
    d = tmp_path / "plain"
    d.mkdir()
    (d / "pack.json").write_text(
        json.dumps({"name": "plain", "version": "1.0.0"}), encoding="utf-8"
    )
    assert load_pack(d).gate == {}
