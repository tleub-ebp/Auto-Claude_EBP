"""Tests for declarative workflow resolution.

Two properties the product depends on:

* the effort the user picked changes how much work happens — before this, a
  typo fix and an architectural change ran the same number of passes;
* a hard gate survives every level. "Do the tests pass" is not a budget
  decision, and no effort setting may quietly turn it off.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.spec import effort_at_least  # noqa: E402

from workflows import (  # noqa: E402
    EFFORT_ORDER,
    WorkflowError,
    load_workflow,
    resolve_profile,
)

WORKFLOW_PATH = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"


@pytest.fixture
def workflow():
    return load_workflow(WORKFLOW_PATH)


def write_workflow(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "workflow.yaml"
    p.write_text(body, encoding="utf-8")
    return p


class TestSpecParsing:
    def test_the_shipped_workflow_loads(self, workflow):
        assert workflow.name == "feature-build"
        assert [p.id for p in workflow.phases][:2] == ["brainstorm", "spec"]

    def test_every_phase_names_an_implementation(self, workflow):
        for phase in workflow.phases:
            assert "/" in phase.impl, f"{phase.id} has no <pack>/<skill> impl"

    @pytest.mark.parametrize(
        "body,message",
        [
            ("name: x\n", "non-empty list"),
            ("name: x\nphases:\n  - impl: a/b\n", "missing 'id'"),
            ("name: x\nphases:\n  - id: a\n", "missing 'impl'"),
            (
                "name: x\nphases:\n  - id: a\n    impl: a/b\n    min_effort: huge\n",
                "min_effort",
            ),
            (
                "name: x\nphases:\n  - id: a\n    impl: a/b\n    dispatch: telepathy\n",
                "dispatch",
            ),
            (
                "name: x\nphases:\n  - id: a\n    impl: a/b\n    gate: rubber-stamp\n",
                "gate",
            ),
            (
                'name: x\nphases:\n  - id: a\n    impl: a/b\n    when: "sometimes"\n',
                "unsupported condition",
            ),
            (
                "name: x\nphases:\n  - id: a\n    impl: a/b\n  - id: a\n    impl: c/d\n",
                "duplicate phase id",
            ),
        ],
    )
    def test_malformed_workflows_are_rejected_not_guessed(
        self, tmp_path, body, message
    ):
        # Guessing at a broken workflow runs the wrong phases, which is worse
        # than refusing to run.
        with pytest.raises(WorkflowError, match=message):
            load_workflow(write_workflow(tmp_path, body))


class TestEffortOrdering:
    def test_levels_are_ordered_weakest_to_strongest(self):
        assert EFFORT_ORDER == ("none", "low", "medium", "high", "ultrathink")

    @pytest.mark.parametrize(
        "actual,minimum,expected",
        [
            ("low", "none", True),
            ("low", "medium", False),
            ("ultrathink", "high", True),
            ("high", "ultrathink", False),
            ("medium", "medium", True),
        ],
    )
    def test_comparison(self, actual, minimum, expected):
        assert effort_at_least(actual, minimum) is expected

    def test_an_unknown_level_raises(self):
        with pytest.raises(WorkflowError):
            effort_at_least("turbo", "low")


class TestEffortPruning:
    def test_low_effort_runs_less_than_ultrathink(self, workflow):
        low = resolve_profile(workflow, "low", changed_files=[])
        top = resolve_profile(workflow, "ultrathink", changed_files=[])
        assert set(low.phase_ids) < set(top.phase_ids)

    def test_each_level_buys_something_the_one_below_did_not(self, workflow):
        """The dial has to be monotone *and* strict.

        A top level identical to the one below it is worse than not offering
        it: the user pays for ultrathink, sees the same plan, and has no way to
        tell that the setting did nothing.
        """
        profiles = [
            (level, set(resolve_profile(workflow, level, changed_files=[]).phase_ids))
            for level in EFFORT_ORDER
        ]
        for (lower, below), (higher, above) in zip(profiles, profiles[1:]):
            assert below < above, (
                f"effort {higher!r} runs the same phases as {lower!r} — "
                f"the setting buys nothing"
            )

    def test_the_cheapest_level_runs_only_what_cannot_be_skipped(self, workflow):
        """Coding, the hard gate, and the near-free observation. Nothing else."""
        profile = resolve_profile(workflow, "none", changed_files=[])
        assert set(profile.phase_ids) == {"coding", "verify", "observe"}

    def test_ultrathink_buys_the_second_opinion(self, workflow):
        """What the top level is for: a reading that did not write the code.

        Both passes run in a fresh context, so neither inherits the reasoning
        it is supposed to attack.
        """
        profile = resolve_profile(workflow, "ultrathink", changed_files=[])
        assert profile.will_run("adversarial-review")
        assert profile.will_run("spec-conformance")
        for phase_id in ("adversarial-review", "spec-conformance"):
            resolved = next(r for r in profile.run if r.id == phase_id)
            assert resolved.dispatch == "fresh-context"

        below = resolve_profile(workflow, "high", changed_files=[])
        assert not below.will_run("adversarial-review")
        assert not below.will_run("spec-conformance")

    def test_expensive_phases_only_appear_where_they_earn_it(self, workflow):
        assert not resolve_profile(workflow, "low", changed_files=[]).will_run(
            "brainstorm"
        )
        assert resolve_profile(workflow, "high", changed_files=[]).will_run(
            "brainstorm"
        )

    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_the_hard_gate_survives_every_effort_level(self, workflow, effort):
        profile = resolve_profile(workflow, effort, changed_files=[])
        assert profile.will_run("verify"), f"hard gate pruned at effort {effort!r}"

    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_always_phases_survive_every_effort_level(self, workflow, effort):
        assert resolve_profile(workflow, effort, changed_files=[]).will_run("observe")

    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_deterministic_phases_are_never_pruned(self, workflow, effort):
        """impeccable's detector costs no tokens, so no level saves anything."""
        profile = resolve_profile(workflow, effort, changed_files=["src/App.tsx"])
        assert profile.will_run("design-check"), f"pruned at effort {effort!r}"

    def test_skips_carry_a_reason(self, workflow):
        profile = resolve_profile(workflow, "low", changed_files=[])
        assert ("brainstorm", "effort") in [(p.id, why) for p, why in profile.skipped]


class TestConditionalPhases:
    def test_frontend_phase_runs_on_a_frontend_change(self, workflow):
        assert resolve_profile(
            workflow, "medium", changed_files=["apps/frontend/src/App.tsx"]
        ).will_run("design-check")

    def test_and_not_on_a_backend_change(self, workflow):
        assert not resolve_profile(
            workflow, "medium", changed_files=["apps/backend/core/client.py"]
        ).will_run("design-check")

    def test_an_unknown_change_set_errs_towards_running(self, workflow):
        # Skipping a design review on a change that did touch the UI is a
        # defect that ships; one extra pass is not.
        assert resolve_profile(workflow, "medium", changed_files=None).will_run(
            "design-check"
        )


class TestProviderDegradation:
    def test_subagent_dispatch_survives_on_a_capable_provider(self, workflow):
        profile = resolve_profile(
            workflow, "medium", provider="claude", changed_files=[]
        )
        coding = next(r for r in profile.run if r.id == "coding")
        assert coding.dispatch == "subagent-per-task"
        assert coding.degraded_from is None

    @pytest.mark.parametrize("provider", ["mistral", "openai", "google"])
    def test_it_degrades_to_sequential_where_there_are_no_subagents(
        self, workflow, provider
    ):
        profile = resolve_profile(
            workflow, "medium", provider=provider, changed_files=[]
        )
        coding = next(r for r in profile.run if r.id == "coding")
        assert coding.dispatch == "sequential-reset"
        assert coding.degraded_from == "subagent-per-task"
        assert "no subagents" in coding.reason

    def test_degradation_removes_no_phases(self, workflow):
        capable = resolve_profile(workflow, "high", provider="claude", changed_files=[])
        limited = resolve_profile(
            workflow, "high", provider="mistral", changed_files=[]
        )
        assert capable.phase_ids == limited.phase_ids


class TestDescribe:
    def test_summary_names_what_runs_and_what_was_dropped(self, workflow):
        text = resolve_profile(
            workflow, "low", provider="mistral", changed_files=[]
        ).describe()
        assert "feature-build" in text and "low" in text
        assert "verify" in text
        assert "brainstorm" in text and "skipped" in text
        assert "sequential-reset" in text
