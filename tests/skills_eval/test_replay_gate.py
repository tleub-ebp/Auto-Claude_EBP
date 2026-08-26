"""The A/B replay gate, and the promotion decision that hangs off it.

Everything here is about one question: can a proposal get promoted without
having been measured? The answer has to be no through every route, so the tests
below try the routes.

No network and no API key. The grader is a recorded table, which exercises the
comparison arithmetic — the part where a bug approves a regression in silence —
without paying for a session per episode.
"""

from __future__ import annotations

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
from learning_loop.replay import (  # noqa: E402
    BASELINE,
    CANDIDATE,
    ArmResult,
    BudgetExhausted,
    Episode,
    ReplayBudget,
    load_episodes,
    replay_ab,
    table_grader,
)
from learning_loop.skill_proposer import (  # noqa: E402
    Evidence,
    ExternalSignal,
    LedgerKey,
    RejectionReason,
    SkillProposal,
    evaluate,
    proposal_dir,
    write_proposal,
)

GOLDEN = Path(__file__).parent / "golden"

BASELINE_INSTRUCTION = "Run the tests and report the result."
CANDIDATE_INSTRUCTION = (
    "Read the head of the test output before the tail: a collection error "
    "reports zero tests, which is not an empty suite."
)


def episode(eid: str, *, signals=(), agent="test-runner", **kw) -> Episode:
    return Episode(
        episode_id=eid,
        agent_id=agent,
        task=f"task for {eid}",
        baseline_signals=tuple(signals),
        **kw,
    )


def run(episodes, outcomes, **kw):
    return replay_ab(
        episodes,
        agent_id="test-runner",
        baseline_instruction=BASELINE_INSTRUCTION,
        candidate_instruction=CANDIDATE_INSTRUCTION,
        grader=table_grader(outcomes),
        **kw,
    )


def pattern(**kw) -> LearningPattern:
    defaults = {
        "pattern_id": "p1",
        "category": PatternCategory.QA_PATTERN,
        "pattern_type": PatternType.SUCCESS,
        "source": PatternSource.BUILD_ANALYSIS,
        "description": "read the head of the output",
        "confidence": 0.95,
        "occurrence_count": 5,
        "agent_phase": "qa_review",
        "context_tags": ["python"],
        "actionable_instruction": CANDIDATE_INSTRUCTION,
    }
    defaults.update(kw)
    return LearningPattern(**defaults)


# ── the arithmetic ────────────────────────────────────────────────────────────


def test_a_candidate_that_breaks_nothing_is_clean():
    episodes = [
        episode("a", signals=[ExternalSignal.TESTS_PASSED]),
        episode("b", signals=[ExternalSignal.TESTS_PASSED]),
    ]
    result = run(
        episodes,
        {
            ("a", CANDIDATE): [ExternalSignal.TESTS_PASSED],
            ("b", CANDIDATE): [ExternalSignal.TESTS_PASSED],
        },
    )
    assert result.clean
    assert result.regressions == []


def test_one_regression_sinks_a_candidate_that_fixed_three():
    """The asymmetry is the point, not an oversight."""
    episodes = [
        episode("fixed-1"),
        episode("fixed-2"),
        episode("fixed-3"),
        episode("broke", signals=[ExternalSignal.TESTS_PASSED]),
    ]
    result = run(
        episodes,
        {
            ("fixed-1", CANDIDATE): [ExternalSignal.TESTS_PASSED],
            ("fixed-2", CANDIDATE): [ExternalSignal.TESTS_PASSED],
            ("fixed-3", CANDIDATE): [ExternalSignal.TESTS_PASSED],
            ("broke", CANDIDATE): [],
        },
    )
    assert len(result.improvements) == 3
    assert len(result.regressions) == 1
    assert not result.clean


def test_an_episode_both_arms_fail_is_not_a_regression():
    """Something already broken is not something the candidate broke."""
    result = run([episode("hard")], {("hard", CANDIDATE): []})
    assert result.regressions == []
    assert result.improvements == []
    assert result.clean


def test_a_baseline_that_regressed_since_archiving_is_not_blamed_on_the_candidate():
    """Both arms are re-graded, so shared drift cancels out.

    A dependency moved and the archived episode no longer passes for either
    arm. Reusing the stale archived verdict as the baseline would book that as
    the candidate's regression and reject a proposal that changed nothing.
    """
    result = run(
        [episode("drifted", signals=[ExternalSignal.TESTS_PASSED])],
        {("drifted", BASELINE): [], ("drifted", CANDIDATE): []},
    )
    assert result.regressions == []


def test_an_empty_replay_is_not_a_pass():
    """No golden cases means unmeasured, and unmeasured is not clean."""
    result = run([], {})
    assert not result.ran
    assert not result.clean


def test_passing_means_an_external_signal_not_a_claim():
    """`ArmResult.passed` is derived from signals; there is no way to assert it."""
    assert not ArmResult("e", CANDIDATE, ()).passed
    assert ArmResult("e", CANDIDATE, (ExternalSignal.QA_CLEAN,)).passed
    assert not hasattr(ExternalSignal, "AGENT_CONFIDENCE")


# ── the budget ────────────────────────────────────────────────────────────────


def test_the_replay_stops_at_its_episode_cap():
    episodes = [episode(f"e{i}") for i in range(10)]
    with pytest.raises(BudgetExhausted):
        run(episodes, {}, budget=ReplayBudget(max_episodes=3))


def test_the_replay_stops_at_its_money_cap():
    episodes = [episode(f"e{i}") for i in range(10)]
    with pytest.raises(BudgetExhausted, match=r"\$"):
        run(
            episodes,
            {},
            budget=ReplayBudget(max_episodes=100, max_usd=1.0),
            cost_of=lambda _e: 0.40,
        )


def test_exhaustion_raises_rather_than_returning_a_partial_clean_result():
    """Half a replay that found no regression has not found no regression."""
    episodes = [
        episode("ok", signals=[ExternalSignal.TESTS_PASSED]),
        episode("broken-later", signals=[ExternalSignal.TESTS_PASSED]),
    ]
    with pytest.raises(BudgetExhausted):
        run(
            episodes,
            {
                ("ok", CANDIDATE): [ExternalSignal.TESTS_PASSED],
                ("broken-later", CANDIDATE): [],
            },
            budget=ReplayBudget(max_episodes=1),
        )


# ── the promotion decision ────────────────────────────────────────────────────


def test_a_proposal_without_an_external_signal_is_rejected():
    """The pattern's own confidence is the agent's opinion of the agent."""
    promote, reason, why = evaluate(pattern(confidence=0.99), Evidence())
    assert not promote
    assert reason is RejectionReason.UNVERIFIED
    assert "does not count" in why


def test_a_proposal_that_regresses_the_replay_is_rejected():
    evidence = Evidence(
        signals=[ExternalSignal.TESTS_PASSED, ExternalSignal.PR_MERGED],
        build_ids=["b1", "b2"],
    )
    run(
        [episode("broke", signals=[ExternalSignal.TESTS_PASSED])],
        {("broke", CANDIDATE): []},
    ).apply_to(evidence)

    promote, reason, _ = evaluate(pattern(), evidence)
    assert not promote
    assert reason is RejectionReason.REPLAY_REGRESSION


def test_a_regressing_proposal_writes_no_file(tmp_path: Path):
    """No file under `skills/_proposed/` means no PR: the loop stays silent."""
    evidence = Evidence(signals=[ExternalSignal.TESTS_PASSED, ExternalSignal.QA_CLEAN])
    run(
        [episode("broke", signals=[ExternalSignal.TESTS_PASSED])],
        {("broke", CANDIDATE): []},
    ).apply_to(evidence)

    promote, _, why = evaluate(pattern(), evidence)
    if promote:  # pragma: no cover - the assertion below is the real check
        write_proposal(
            tmp_path,
            SkillProposal(
                key=LedgerKey("test-runner", "python"),
                pattern_id="p1",
                title="t",
                instruction=CANDIDATE_INSTRUCTION,
                evidence=evidence,
                occurrence_count=5,
            ),
            why,
        )
    assert not promote
    assert not proposal_dir(tmp_path).exists()


def test_a_measured_corroborated_proposal_is_promoted_and_written(tmp_path: Path):
    evidence = Evidence(
        signals=[ExternalSignal.TESTS_PASSED, ExternalSignal.QA_CLEAN],
        build_ids=["b1", "b2"],
    )
    result = run(
        [
            episode("kept", signals=[ExternalSignal.TESTS_PASSED]),
            episode("fixed"),
        ],
        {
            ("kept", CANDIDATE): [ExternalSignal.TESTS_PASSED],
            ("fixed", CANDIDATE): [ExternalSignal.TESTS_PASSED],
        },
    )
    result.apply_to(evidence)
    assert result.clean

    promote, reason, why = evaluate(pattern(), evidence)
    assert promote, why
    assert reason is None
    assert "clean replay" in why

    path = write_proposal(
        tmp_path,
        SkillProposal(
            key=LedgerKey("test-runner", "python", "feature-build"),
            pattern_id="p1",
            title="Read the head of the test output",
            instruction=CANDIDATE_INSTRUCTION,
            evidence=evidence,
            occurrence_count=5,
        ),
        why,
    )
    assert path is not None
    body = path.read_text(encoding="utf-8")
    assert CANDIDATE_INSTRUCTION in body
    assert "tests_passed" in body


def test_promotion_writes_only_under_proposed(tmp_path: Path):
    """The observe phase proposes. It never edits a pack."""
    pack = tmp_path / "skills" / "tooling"
    pack.mkdir(parents=True)
    skill = pack / "mcp-builder"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: mcp-builder\n---\nbody\n", "utf-8")
    before = (skill / "SKILL.md").read_text(encoding="utf-8")

    evidence = Evidence(signals=[ExternalSignal.TESTS_PASSED, ExternalSignal.PR_MERGED])
    run(
        [episode("kept", signals=[ExternalSignal.TESTS_PASSED])],
        {("kept", CANDIDATE): [ExternalSignal.TESTS_PASSED]},
    ).apply_to(evidence)
    _, _, why = evaluate(pattern(), evidence)
    write_proposal(
        tmp_path,
        SkillProposal(
            key=LedgerKey("test-runner"),
            pattern_id="p1",
            title="t",
            instruction=CANDIDATE_INSTRUCTION,
            evidence=evidence,
            occurrence_count=5,
        ),
        why,
    )

    assert (skill / "SKILL.md").read_text(encoding="utf-8") == before
    assert list(proposal_dir(tmp_path).glob("*.md"))


def test_the_same_proposal_is_not_written_twice(tmp_path: Path):
    """Re-proposing nightly turns the review queue into noise."""
    evidence = Evidence(signals=[ExternalSignal.TESTS_PASSED, ExternalSignal.QA_CLEAN])
    proposal = SkillProposal(
        key=LedgerKey("test-runner", "python"),
        pattern_id="p1",
        title="t",
        instruction=CANDIDATE_INSTRUCTION,
        evidence=evidence,
        occurrence_count=5,
    )
    assert write_proposal(tmp_path, proposal, "why") is not None
    assert write_proposal(tmp_path, proposal, "why") is None


# ── replaying against the real corpus ─────────────────────────────────────────


def test_the_corpus_replays_end_to_end():
    """The gate runs over the committed episodes, offline, in one pass."""
    episodes = load_episodes(GOLDEN, agent_id="test-runner")
    assert episodes, "the test-runner corpus is empty"

    result = replay_ab(
        episodes,
        agent_id="test-runner",
        baseline_instruction=BASELINE_INSTRUCTION,
        candidate_instruction=CANDIDATE_INSTRUCTION,
        grader=table_grader(
            {
                (e.episode_id, CANDIDATE): list(e.baseline_signals)
                or [ExternalSignal.TESTS_PASSED]
                for e in episodes
            }
        ),
        budget=ReplayBudget(max_episodes=len(episodes)),
    )
    assert result.clean
    assert "regressed" in result.describe()


def test_episodes_are_scoped_to_the_agent_that_learned_from_them():
    """`test-runner` on Rust does not learn from `code-reviewer` on TypeScript."""
    every = load_episodes(GOLDEN)
    runners = load_episodes(GOLDEN, agent_id="test-runner")
    assert 0 < len(runners) < len(every)
    assert {e.agent_id for e in runners} == {"test-runner"}

    rust = [e for e in runners if e.matches("test-runner", language="rust")]
    assert rust and all(e.language == "rust" for e in rust)


def test_an_episode_with_no_language_is_evidence_everywhere():
    """A case recorded without a language is not silently excluded."""
    generic = episode("generic")
    assert generic.matches("test-runner", language="go")
    assert generic.matches("test-runner", workflow="hotfix")
    assert not generic.matches("code-reviewer")
