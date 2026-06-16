#!/usr/bin/env python3
"""
Tests for QA Coverage Enforcement Gate
======================================

Couvre ``qa/coverage_gate.py`` :
- parsing des valeurs de couverture
- évaluation par rapport au seuil (pass / fail / best-effort e2e / données manquantes)
- pilotage par la variable d'environnement ``WORKPILOT_QA_MIN_COVERAGE``
- lecture depuis ``implementation_plan.json`` (``run_coverage_gate``)
- génération de la demande de correctif
"""

import json
import sys
from pathlib import Path

import pytest

# Add tests directory to path for helper imports
sys.path.insert(0, str(Path(__file__).parent))

from qa_report_helpers import cleanup_qa_report_mocks, setup_qa_report_mocks

setup_qa_report_mocks()

from qa.coverage_gate import (  # noqa: E402
    build_coverage_issues,
    evaluate_coverage,
    get_min_coverage,
    is_coverage_gate_enabled,
    mark_signoff_rejected,
    parse_coverage_value,
    render_coverage_fix_request,
    run_coverage_gate,
    write_coverage_fix_request,
)


@pytest.fixture(scope="module", autouse=True)
def cleanup_mocked_modules():
    """Restore original modules after all tests in this module complete."""
    yield
    cleanup_qa_report_mocks()


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """Ensure a clean coverage threshold env between tests (default 100)."""
    monkeypatch.delenv("WORKPILOT_QA_MIN_COVERAGE", raising=False)


# =============================================================================
# parse_coverage_value
# =============================================================================


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (100, 100.0),
        (87.5, 87.5),
        ("100", 100.0),
        ("87.5%", 87.5),
        ("  100 % ", 100.0),
        ("42/42", 100.0),
        ("21/42", 50.0),
        (0, 0.0),
        ("0", 0.0),
    ],
)
def test_parse_coverage_value_valid(value, expected):
    assert parse_coverage_value(value) == pytest.approx(expected)


@pytest.mark.parametrize(
    "value",
    [None, True, False, "", "abc", "10/0", "150", 150, -5, "-5", {}, []],
)
def test_parse_coverage_value_invalid(value):
    assert parse_coverage_value(value) is None


# =============================================================================
# get_min_coverage / enabled
# =============================================================================


def test_min_coverage_defaults_to_100():
    assert get_min_coverage() == 100
    assert is_coverage_gate_enabled() is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("0", 0), ("30", 30), ("100", 100), ("200", 100), ("-5", 0), ("oops", 100)],
)
def test_min_coverage_from_env(monkeypatch, raw, expected):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", raw)
    assert get_min_coverage() == expected


def test_gate_disabled_when_threshold_zero(monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "0")
    assert is_coverage_gate_enabled() is False


# =============================================================================
# evaluate_coverage
# =============================================================================


def test_evaluate_pass_full_coverage():
    report = evaluate_coverage(
        {"unit": 100, "integration": 100, "e2e": 100}, 100
    )
    assert report["passed"] is True
    assert report["enabled"] is True
    assert report["failures"] == []
    assert report["measured"] is True


def test_evaluate_fail_unit_below_threshold():
    report = evaluate_coverage({"unit": 80, "integration": 100}, 100)
    assert report["passed"] is False
    assert any("unit" in f for f in report["failures"])


def test_evaluate_fail_missing_required():
    report = evaluate_coverage({"unit": 100}, 100)
    assert report["passed"] is False
    assert any("integration" in f for f in report["failures"])


def test_evaluate_e2e_is_best_effort_only():
    # e2e below threshold must NOT block (warning only)
    report = evaluate_coverage(
        {"unit": 100, "integration": 100, "e2e": 10}, 100
    )
    assert report["passed"] is True
    assert report["warnings"]
    assert any("e2e" in w for w in report["warnings"])


def test_evaluate_progressive_threshold():
    report = evaluate_coverage({"unit": 85, "integration": 90}, 80)
    assert report["passed"] is True


def test_evaluate_disabled_threshold_zero():
    report = evaluate_coverage({}, 0)
    assert report["passed"] is True
    assert report["enabled"] is False


def test_evaluate_explicit_unmeasured_blocks():
    report = evaluate_coverage(
        {"measured": False, "unit": 100, "integration": 100}, 100
    )
    assert report["passed"] is False


# =============================================================================
# run_coverage_gate (reads implementation_plan.json)
# =============================================================================


def _write_plan(spec_dir: Path, coverage: dict | None) -> None:
    signoff = {"status": "approved"}
    if coverage is not None:
        signoff["coverage"] = coverage
    plan = {"qa_signoff": signoff}
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def test_run_coverage_gate_pass(tmp_path):
    _write_plan(tmp_path, {"unit": 100, "integration": 100, "e2e": 100})
    report = run_coverage_gate(tmp_path)
    assert report["passed"] is True


def test_run_coverage_gate_fail(tmp_path):
    _write_plan(tmp_path, {"unit": 50, "integration": 100})
    report = run_coverage_gate(tmp_path)
    assert report["passed"] is False


def test_run_coverage_gate_missing_coverage_blocks(tmp_path):
    _write_plan(tmp_path, None)
    report = run_coverage_gate(tmp_path)
    assert report["passed"] is False


def test_run_coverage_gate_fallback_location(tmp_path):
    # coverage nested under tests_passed is also accepted
    plan = {
        "qa_signoff": {
            "status": "approved",
            "tests_passed": {"coverage": {"unit": 100, "integration": 100}},
        }
    }
    (tmp_path / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    report = run_coverage_gate(tmp_path)
    assert report["passed"] is True


# =============================================================================
# fix request
# =============================================================================


def test_build_coverage_issues():
    report = evaluate_coverage({"unit": 10, "integration": 20}, 100)
    issues = build_coverage_issues(report)
    assert issues
    assert all(i["type"] == "coverage_gap" for i in issues)


def test_render_and_write_fix_request(tmp_path):
    report = evaluate_coverage({"unit": 10, "integration": 20}, 100)
    text = render_coverage_fix_request(report)
    assert "Couverture" in text
    assert "100%" in text

    assert write_coverage_fix_request(tmp_path, report) is True
    assert (tmp_path / "QA_FIX_REQUEST.md").exists()


def test_mark_signoff_rejected_overrides_approved(tmp_path):
    # Reviewer wrote "approved" but coverage is insufficient.
    _write_plan(tmp_path, {"unit": 40, "integration": 100})
    plan_file = tmp_path / "implementation_plan.json"
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    plan["qa_signoff"]["status"] = "approved"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")

    report = run_coverage_gate(tmp_path)
    assert report["passed"] is False

    assert mark_signoff_rejected(tmp_path, report) is True

    updated = json.loads(plan_file.read_text(encoding="utf-8"))
    signoff = updated["qa_signoff"]
    assert signoff["status"] == "rejected"
    assert signoff["ready_for_qa_revalidation"] is False
    assert any(
        i.get("type") == "coverage_gap" for i in signoff["issues_found"]
    )


def test_mark_signoff_rejected_is_idempotent(tmp_path):
    _write_plan(tmp_path, {"unit": 40, "integration": 100})
    report = run_coverage_gate(tmp_path)
    mark_signoff_rejected(tmp_path, report)
    mark_signoff_rejected(tmp_path, report)
    plan = json.loads(
        (tmp_path / "implementation_plan.json").read_text(encoding="utf-8")
    )
    gaps = [
        i
        for i in plan["qa_signoff"]["issues_found"]
        if i.get("type") == "coverage_gap"
    ]
    # No duplicate accumulation across repeated calls.
    assert len(gaps) == 1
