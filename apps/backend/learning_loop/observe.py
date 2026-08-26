"""The `observe` phase — what the build noticed, turned into candidates.

`workflows/feature-build/workflow.yaml` ends every run with an `observe` phase
marked ``always: true``. This is what it does.

Three things get looked at, which is what task-observer watches for and what the
plan adopted from it: corrections the user made to an agent's output, work no
skill covered, and the agent's own blind spots. What comes out is a file under
``skills/_proposed/`` and nothing else. **No skill under ``skills/<pack>/`` is
ever modified here.** A promotion is a diff a person reads and merges, so the
phase writes candidates and stops.

Why the phase lives here and not in the skill
---------------------------------------------
task-observer, as published, needs a `.claude/skills/` directory to read and a
filesystem to write to, and degrades to emitting a "handoff document" when it
has neither. We do not need that degradation: this phase is executed by our own
engine, which runs whichever provider is driving, and writes through
`skill_proposer`. So the provider-dependent half of the upstream skill is
replaced by Python, and the part that is actually about noticing things stays a
skill.

Grounding
---------
Everything recorded here is an *external* signal — the QA verdict, whether the
tests went green, whether a deterministic detector came back clean. The agent's
own confidence in its work is not collected, because an agent grading its own
homework agrees with itself. That is enforced by the type: `ExternalSignal` has
no member for it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .replay import ReplayResult, load_episodes
from .skill_proposer import (
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

logger = logging.getLogger(__name__)

__all__ = [
    "BuildOutcome",
    "ObserveReport",
    "signals_from_outcome",
    "run_observe",
    "GOLDEN_RELPATH",
]

GOLDEN_RELPATH = Path("tests") / "skills_eval" / "golden"


@dataclass(frozen=True)
class BuildOutcome:
    """What is externally knowable about a finished build.

    Deliberately small and deliberately boolean. Each field is something a
    verifier reported, not something an agent concluded — which is why there is
    no field for how confident the coder was.
    """

    spec_id: str
    qa_approved: bool | None = None
    """None when QA did not run at this effort level: absent, not failed."""
    tests_passed: bool | None = None
    detector_clean: bool | None = None
    pr_merged: bool | None = None
    language: str = ""
    workflow: str = ""


@dataclass
class ObserveReport:
    """What the phase did, for the build log and for the tests."""

    spec_id: str
    signals: list[ExternalSignal] = field(default_factory=list)
    outcomes_recorded: int = 0
    proposals_written: list[Path] = field(default_factory=list)
    rejected: list[tuple[str, RejectionReason]] = field(default_factory=list)
    replay: ReplayResult | None = None

    def describe(self) -> str:
        if not self.signals and not self.outcomes_recorded:
            return "observe: nothing externally verified to learn from"
        parts = [
            f"observe: {len(self.signals)} external signal(s)"
            + (f" — {', '.join(s.value for s in self.signals)}" if self.signals else "")
        ]
        if self.outcomes_recorded:
            parts.append(f"  recorded against {self.outcomes_recorded} agent ledger(s)")
        for path in self.proposals_written:
            parts.append(f"  proposed  skills/_proposed/{path.name}")
        for pattern_id, reason in self.rejected:
            parts.append(f"  held back {pattern_id} ({reason.value})")
        if self.replay and self.replay.ran:
            parts.append(f"  replay    {len(self.replay.regressions)} regression(s)")
        return "\n".join(parts)


def signals_from_outcome(outcome: BuildOutcome) -> list[ExternalSignal]:
    """Translate a finished build into the signals it actually earned.

    A verifier that did not run contributes nothing. Treating "QA was skipped"
    as "QA passed" is how a low-effort run ends up looking like corroborating
    evidence for a promotion it never tested.
    """
    signals: list[ExternalSignal] = []
    if outcome.tests_passed:
        signals.append(ExternalSignal.TESTS_PASSED)
    if outcome.qa_approved:
        signals.append(ExternalSignal.QA_CLEAN)
    if outcome.detector_clean:
        signals.append(ExternalSignal.DETECTOR_CLEAN)
    if outcome.pr_merged:
        signals.append(ExternalSignal.PR_MERGED)
    return signals


def _agents_for(pattern: Any) -> list[str]:
    """Which subagent ledger a pattern belongs in.

    Keyed by the phase that produced it, because that is the granularity the
    extractor records. A pattern with no phase is not filed anywhere: a lesson
    attributed to every agent is a lesson attributed to none.
    """
    phase_agents = {
        "coding": ["code-reviewer", "test-runner"],
        "qa_review": ["qa-acceptance-checker", "test-runner"],
        "qa_fixing": ["test-runner"],
        "planning": ["spec-explorer"],
    }
    return phase_agents.get(getattr(pattern, "agent_phase", ""), [])


def run_observe(
    repo_root: Path,
    outcome: BuildOutcome,
    patterns: list[Any],
    *,
    replay: ReplayResult | None = None,
    write: bool = True,
) -> ObserveReport:
    """Record what the build verified, and propose what it has earned.

    ``patterns`` are `LearningPattern`s the extractor mined from this build.
    ``replay`` is the A/B result when one was run; without it the replay gate is
    simply not claimed, and `evaluate` says so in the explanation rather than
    pretending the candidate was measured.

    Never raises. A learning-loop failure must not fail a build that otherwise
    succeeded — the work is done, and losing the observation is cheaper than
    losing the run.
    """
    report = ObserveReport(spec_id=outcome.spec_id)
    try:
        report.signals = signals_from_outcome(outcome)
        report.replay = replay

        if not report.signals:
            # Nothing external agreed with anything, so there is nothing to
            # record and certainly nothing to promote.
            return report

        seen_ledgers: set[str] = set()
        for pattern in patterns:
            for agent_id in _agents_for(pattern):
                key = LedgerKey(agent_id, outcome.language, outcome.workflow)
                if write:
                    for signal in report.signals:
                        record_outcome(
                            repo_root,
                            key,
                            pattern.pattern_id,
                            signal,
                            build_id=outcome.spec_id,
                        )
                seen_ledgers.add(key.slug())

                evidence = _evidence_for(repo_root, key, pattern.pattern_id, replay)
                promote, reason, why = evaluate(pattern, evidence)
                if not promote:
                    if reason is not None:
                        report.rejected.append((pattern.pattern_id, reason))
                    continue
                if not write:
                    continue
                path = write_proposal(
                    repo_root,
                    SkillProposal(
                        key=key,
                        pattern_id=pattern.pattern_id,
                        title=pattern.description,
                        instruction=pattern.actionable_instruction,
                        evidence=evidence,
                        occurrence_count=pattern.occurrence_count,
                    ),
                    why,
                )
                if path is not None:
                    report.proposals_written.append(path)

        report.outcomes_recorded = len(seen_ledgers)
    except Exception as exc:  # noqa: BLE001 - observation must not break a build
        logger.warning("observe phase failed, build unaffected: %s", exc)
    return report


def _evidence_for(
    repo_root: Path,
    key: LedgerKey,
    pattern_id: str,
    replay: ReplayResult | None,
) -> Evidence:
    """Everything externally verified about this pattern, across all builds.

    Read back from the ledger rather than taken from the current run: the
    frequency gate asks whether a lesson has held up repeatedly, and one build
    can only ever answer "once".
    """
    evidence = Evidence()
    try:
        import json

        path = ledger_path(repo_root, key)
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            entry = data.get(pattern_id) or {}
            for raw in entry.get("signals", []):
                try:
                    evidence.signals.append(ExternalSignal(raw))
                except ValueError:
                    logger.debug("ledger %s: unknown signal %r", path.name, raw)
            evidence.build_ids = list(entry.get("builds", []))
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not read ledger for %s: %s", key.slug(), exc)

    if replay is not None:
        replay.apply_to(evidence)
    return evidence


def golden_corpus(repo_root: Path, agent_id: str = ""):
    """The archived episodes available to grade a candidate against."""
    return load_episodes(repo_root / GOLDEN_RELPATH, agent_id=agent_id)
