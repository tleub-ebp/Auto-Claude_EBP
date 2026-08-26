"""Tests for promoting a learned pattern into a reviewable skill patch.

The property that matters: **nothing is promoted on the agent's own say-so.**
The documented failure mode of self-improving agents is that an agent grading
its own homework agrees with itself, so a pattern's confidence score — which is
the agent's assessment of the agent — must never be sufficient on its own.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.models import (  # noqa: E402
    LearningPattern,
    PatternCategory,
    PatternSource,
    PatternType,
)
from learning_loop.skill_proposer import (  # noqa: E402
    MIN_OCCURRENCES,
    MIN_VERIFIED_OUTCOMES,
    Evidence,
    ExternalSignal,
    LedgerKey,
    RejectionReason,
    SkillProposal,
    evaluate,
    ledger_path,
    record_outcome,
    write_proposal,
)


def make_pattern(occurrences: int = 5, confidence: float = 0.9, enabled: bool = True):
    return LearningPattern(
        pattern_id="p-1",
        category=PatternCategory.TOOL_SEQUENCE,
        pattern_type=PatternType.SUCCESS,
        source=PatternSource.BUILD_ANALYSIS,
        description="run the narrow test first",
        confidence=confidence,
        occurrence_count=occurrences,
        agent_phase="coding",
        context_tags=["python"],
        actionable_instruction="Run the single failing test before the suite.",
        enabled=enabled,
    )


def verified(n: int = MIN_VERIFIED_OUTCOMES) -> Evidence:
    ev = Evidence()
    for i in range(n):
        ev.add(ExternalSignal.TESTS_PASSED, f"build-{i}")
    return ev


class TestGates:
    def test_a_well_evidenced_pattern_is_promoted(self):
        ok, reason, why = evaluate(make_pattern(), verified())
        assert ok and reason is None
        assert "corroborated by" in why

    def test_one_sighting_is_an_anecdote(self):
        ok, reason, _ = evaluate(make_pattern(occurrences=1), verified())
        assert not ok and reason is RejectionReason.TOO_RARE

    def test_high_confidence_alone_is_not_enough(self):
        """The core guard: the agent's own score cannot promote anything."""
        ok, reason, why = evaluate(make_pattern(confidence=1.0), Evidence())
        assert not ok
        assert reason is RejectionReason.UNVERIFIED
        assert "agent's assessment of the agent" in why

    @pytest.mark.parametrize("n", range(MIN_VERIFIED_OUTCOMES))
    def test_partial_corroboration_is_still_rejected(self, n):
        ok, reason, _ = evaluate(make_pattern(), verified(n))
        assert not ok and reason is RejectionReason.UNVERIFIED

    def test_a_replay_regression_blocks_promotion(self):
        ev = verified()
        ev.replay_ran = True
        ev.replay_regressions = 1
        ok, reason, _ = evaluate(make_pattern(), ev)
        assert not ok and reason is RejectionReason.REPLAY_REGRESSION

    def test_a_clean_replay_is_recorded_in_the_explanation(self):
        ev = verified()
        ev.replay_ran = True
        ok, _, why = evaluate(make_pattern(), ev)
        assert ok and "clean replay" in why

    def test_a_disabled_pattern_is_never_promoted(self):
        ok, reason, _ = evaluate(make_pattern(enabled=False), verified())
        assert not ok and reason is RejectionReason.DISABLED

    def test_every_external_signal_is_something_the_agent_cannot_fake(self):
        # If a self-reported outcome ever lands in this enum, the gate is gone.
        assert {s.value for s in ExternalSignal} == {
            "tests_passed",
            "qa_clean",
            "detector_clean",
            "pr_merged",
        }


class TestLedgerScoping:
    def test_lessons_are_keyed_per_agent_language_and_workflow(self):
        a = LedgerKey("test-runner", "rust", "feature-build")
        b = LedgerKey("test-runner", "typescript", "feature-build")
        c = LedgerKey("code-reviewer", "rust", "feature-build")
        assert len({a.slug(), b.slug(), c.slug()}) == 3

    def test_slug_is_filesystem_safe(self):
        assert LedgerKey("Test Runner!", "C#", "feature/build").slug() == (
            "test-runner-c-feature-build"
        )

    def test_recording_an_outcome_creates_a_scoped_ledger(self, tmp_path):
        key = LedgerKey("test-runner", "python")
        record_outcome(tmp_path, key, "p-1", ExternalSignal.TESTS_PASSED, "build-7")
        path = ledger_path(tmp_path, key)
        assert path.is_file()
        assert "build-7" in path.read_text(encoding="utf-8")

    def test_recording_never_raises(self, tmp_path):
        # Bookkeeping must not be able to fail the build that produced the data.
        blocked = tmp_path / "file-not-a-dir"
        blocked.write_text("x", encoding="utf-8")
        record_outcome(blocked, LedgerKey("a"), "p", ExternalSignal.QA_CLEAN)


class TestProposalFiles:
    def _proposal(self) -> SkillProposal:
        return SkillProposal(
            key=LedgerKey("test-runner", "python"),
            pattern_id="p-1",
            title="Run the narrow test first",
            instruction="Run the single failing test before the whole suite.",
            evidence=verified(),
            occurrence_count=5,
        )

    def test_writes_into_the_proposed_directory(self, tmp_path):
        path = write_proposal(tmp_path, self._proposal(), "because")
        assert path is not None
        assert path.parent == tmp_path / "skills" / "_proposed"

    def test_the_file_carries_the_evidence_not_just_the_conclusion(self, tmp_path):
        path = write_proposal(tmp_path, self._proposal(), "seen 5×, tests passed")
        text = path.read_text(encoding="utf-8")
        assert "seen 5×, tests passed" in text
        assert "tests_passed" in text
        assert "build-0" in text

    def test_a_proposal_is_not_a_pack_so_the_resolver_ignores_it(self, tmp_path):
        from skills_registry.packs import load_packs

        write_proposal(tmp_path, self._proposal(), "because")
        # `_proposed` starts with an underscore, which load_packs skips.
        assert load_packs(tmp_path / "skills") == []

    def test_the_same_proposal_is_not_written_twice(self, tmp_path):
        # Re-proposing nightly turns the review queue into noise.
        assert write_proposal(tmp_path, self._proposal(), "because") is not None
        assert write_proposal(tmp_path, self._proposal(), "because") is None

    def test_it_proposes_and_never_applies(self, tmp_path):
        """The whole contract: this module writes a candidate and stops."""
        (tmp_path / "skills" / "real-pack").mkdir(parents=True)
        marker = tmp_path / "skills" / "real-pack" / "pack.json"
        marker.write_text('{"name":"real-pack","version":"1.0.0"}', encoding="utf-8")
        before = marker.read_text(encoding="utf-8")
        write_proposal(tmp_path, self._proposal(), "because")
        assert marker.read_text(encoding="utf-8") == before
