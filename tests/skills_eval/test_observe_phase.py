"""The `observe` phase: what it records, and what it refuses to touch.

The phase's whole value rests on two promises. It must never modify a skill —
a promotion is a diff a person merges, not something a build does to itself at
3am. And it must never manufacture corroboration: a verifier that did not run
is unknown, not passed, or a low-effort run becomes evidence for a promotion it
never tested.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.models import (  # noqa: E402
    LearningPattern,
    PatternCategory,
    PatternSource,
    PatternType,
)
from learning_loop.observe import (  # noqa: E402
    BuildOutcome,
    golden_corpus,
    run_observe,
    signals_from_outcome,
)
from learning_loop.replay import (  # noqa: E402
    CANDIDATE,
    Episode,
    ReplayResult,
    replay_ab,
    table_grader,
)
from learning_loop.skill_proposer import (  # noqa: E402
    ExternalSignal,
    LedgerKey,
    RejectionReason,
    ledger_path,
    proposal_dir,
)

INSTRUCTION = "Check the acceptance criteria against the assertions, not the diff."


def pattern(pattern_id="p1", *, phase="qa_review", count=5, enabled=True):
    return LearningPattern(
        pattern_id=pattern_id,
        category=PatternCategory.QA_PATTERN,
        pattern_type=PatternType.SUCCESS,
        source=PatternSource.BUILD_ANALYSIS,
        description="verify criteria, not vibes",
        confidence=0.9,
        occurrence_count=count,
        agent_phase=phase,
        context_tags=["python"],
        actionable_instruction=INSTRUCTION,
        enabled=enabled,
    )


def outcome(**kw) -> BuildOutcome:
    base = {
        "spec_id": "042-add-widget",
        "qa_approved": True,
        "tests_passed": True,
        "language": "python",
        "workflow": "feature-build",
    }
    base.update(kw)
    return BuildOutcome(**base)


# ── signals ───────────────────────────────────────────────────────────────────


def test_a_verifier_that_did_not_run_contributes_nothing():
    """Skipped is not passed. Otherwise a cheap run corroborates for free."""
    assert signals_from_outcome(outcome(qa_approved=None, tests_passed=None)) == []


def test_a_verifier_that_failed_contributes_nothing():
    assert ExternalSignal.QA_CLEAN not in signals_from_outcome(
        outcome(qa_approved=False)
    )


def test_each_passing_verifier_contributes_its_own_signal():
    signals = signals_from_outcome(outcome(detector_clean=True, pr_merged=True))
    assert set(signals) == {
        ExternalSignal.TESTS_PASSED,
        ExternalSignal.QA_CLEAN,
        ExternalSignal.DETECTOR_CLEAN,
        ExternalSignal.PR_MERGED,
    }


# ── recording ─────────────────────────────────────────────────────────────────


def test_outcomes_land_in_the_ledger_of_the_agent_that_earned_them(tmp_path: Path):
    report = run_observe(tmp_path, outcome(), [pattern()])
    assert report.outcomes_recorded > 0

    key = LedgerKey("qa-acceptance-checker", "python", "feature-build")
    data = json.loads(ledger_path(tmp_path, key).read_text(encoding="utf-8"))
    assert ExternalSignal.QA_CLEAN.value in data["p1"]["signals"]
    assert "042-add-widget" in data["p1"]["builds"]


def test_ledgers_are_scoped_per_agent_language_and_workflow(tmp_path: Path):
    """`test-runner` on Rust must not inherit what it learned on Python."""
    run_observe(tmp_path, outcome(), [pattern()])
    run_observe(tmp_path, outcome(spec_id="043", language="rust"), [pattern()])

    python_key = LedgerKey("test-runner", "python", "feature-build")
    rust_key = LedgerKey("test-runner", "rust", "feature-build")
    assert ledger_path(tmp_path, python_key).is_file()
    assert ledger_path(tmp_path, rust_key).is_file()
    assert python_key.slug() != rust_key.slug()


def test_a_build_with_no_external_signal_records_nothing(tmp_path: Path):
    report = run_observe(
        tmp_path, outcome(qa_approved=None, tests_passed=None), [pattern()]
    )
    assert report.signals == []
    assert report.outcomes_recorded == 0
    assert not proposal_dir(tmp_path).exists()


def test_a_pattern_from_an_unmapped_phase_is_filed_nowhere(tmp_path: Path):
    """A lesson attributed to every agent is a lesson attributed to none."""
    report = run_observe(tmp_path, outcome(), [pattern(phase="documentation")])
    assert report.outcomes_recorded == 0


# ── promotion ─────────────────────────────────────────────────────────────────


def test_one_build_is_not_enough_to_promote(tmp_path: Path):
    """Two verifiers agreeing in one run is one corroboration, not two.

    A single build that passes its tests and its QA has two witnesses to one
    event. If that cleared the gate, every green build would promote whatever
    pattern it happened to touch.
    """
    report = run_observe(tmp_path, outcome(), [pattern()])
    assert len(report.signals) == 2
    assert report.proposals_written == []
    assert RejectionReason.UNVERIFIED in {r for _, r in report.rejected}


def test_repeated_corroboration_eventually_earns_a_proposal(tmp_path: Path):
    written = []
    for i in range(3):
        written += run_observe(
            tmp_path, outcome(spec_id=f"spec-{i}"), [pattern()]
        ).proposals_written

    # One per agent whose ledger the pattern was filed against — a lesson about
    # QA review is a lesson for the acceptance checker and for the test runner,
    # and each gets its own reviewable candidate. The third build re-proposes
    # neither: what is already waiting for review is not proposed again.
    assert len(written) == 2, [p.name for p in written]
    assert {p.name.split("-python-")[0] for p in written} == {
        "qa-acceptance-checker",
        "test-runner",
    }
    body = written[0].read_text(encoding="utf-8")
    assert INSTRUCTION in body
    assert "qa_clean" in body


def test_a_disabled_pattern_is_never_proposed(tmp_path: Path):
    reports = [
        run_observe(tmp_path, outcome(spec_id=f"spec-{i}"), [pattern(enabled=False)])
        for i in range(3)
    ]
    assert all(r.proposals_written == [] for r in reports)
    assert RejectionReason.DISABLED in {r for rep in reports for _, r in rep.rejected}


def test_a_replay_regression_blocks_a_promotion_that_would_otherwise_pass(
    tmp_path: Path,
):
    regressing = replay_ab(
        [
            Episode(
                episode_id="qa-acceptance-checker/spec-drift",
                agent_id="qa-acceptance-checker",
                task="t",
                baseline_signals=(ExternalSignal.QA_CLEAN,),
            )
        ],
        agent_id="qa-acceptance-checker",
        baseline_instruction="old",
        candidate_instruction=INSTRUCTION,
        grader=table_grader({("qa-acceptance-checker/spec-drift", CANDIDATE): []}),
    )
    assert regressing.regressions

    reports = [
        run_observe(
            tmp_path, outcome(spec_id=f"spec-{i}"), [pattern()], replay=regressing
        )
        for i in range(3)
    ]
    assert all(r.proposals_written == [] for r in reports)
    assert RejectionReason.REPLAY_REGRESSION in {
        r for rep in reports for _, r in rep.rejected
    }


def test_the_phase_writes_only_under_proposed(tmp_path: Path):
    """No file under `skills/<pack>/` is touched by observing."""
    pack = tmp_path / "skills" / "tooling" / "mcp-builder"
    pack.mkdir(parents=True)
    skill = pack / "SKILL.md"
    skill.write_text("---\nname: mcp-builder\n---\nbody\n", encoding="utf-8")
    before = skill.read_text(encoding="utf-8")

    for i in range(3):
        run_observe(tmp_path, outcome(spec_id=f"spec-{i}"), [pattern()])

    assert skill.read_text(encoding="utf-8") == before
    written = {p.relative_to(tmp_path).parts[:2] for p in tmp_path.rglob("*.md")}
    assert written <= {("skills", "_proposed"), ("skills", "tooling")}


def test_dry_run_reports_without_writing(tmp_path: Path):
    report = run_observe(tmp_path, outcome(), [pattern()], write=False)
    assert report.signals
    assert not proposal_dir(tmp_path).exists()


def test_the_phase_never_raises(tmp_path: Path):
    """A build that produced working code is not failed by its bookkeeping."""

    class Exploding:
        pattern_id = "boom"

        def __getattr__(self, name):
            raise RuntimeError("pattern storage is corrupt")

    report = run_observe(tmp_path, outcome(), [Exploding()])
    assert report.proposals_written == []


def test_the_report_says_what_happened(tmp_path: Path):
    report = run_observe(tmp_path, outcome(), [pattern()])
    text = report.describe()
    assert "external signal" in text
    assert "qa_clean" in text


# ── the corpus this repo ships ────────────────────────────────────────────────


def test_the_repo_corpus_is_reachable_from_the_phase():
    """`golden_corpus` must point at the directory the eval suite maintains."""
    episodes = golden_corpus(REPO_ROOT)
    assert episodes
    assert golden_corpus(REPO_ROOT, "test-runner")
    assert not golden_corpus(REPO_ROOT, "no-such-agent")


@pytest.mark.parametrize(
    "agent_id", ["test-runner", "code-reviewer", "qa-acceptance-checker"]
)
def test_every_agent_the_phase_files_against_has_golden_cases(agent_id: str):
    """An agent with a ledger but no episodes can accumulate evidence it can
    never measure, which is a promotion waiting to happen unchecked."""
    assert golden_corpus(REPO_ROOT, agent_id), f"no golden episodes for {agent_id}"


def test_an_empty_replay_result_does_not_claim_the_gate():
    empty = ReplayResult(agent_id="test-runner")
    assert not empty.clean
    assert "nothing was measured" in empty.describe()
