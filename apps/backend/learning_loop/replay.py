"""A/B replay: measuring a proposed instruction instead of believing it.

`skill_proposer` decides whether a pattern has earned a proposal. Three of its
four gates are cheap — count the occurrences, count the external signals, wait
for a human to merge. The third is not: *does the new instruction actually do
better than the one it replaces?*

Answering it by asking the agent is the failure mode the whole module exists to
avoid. So the answer comes from replaying both arms — the instruction as it
stands and the candidate — over the same archived episodes, and comparing what
the **external verifiers** said. Tests passing, QA finding nothing, the
detector coming back clean. Nobody's opinion of their own output.

What an episode is
------------------
A real task the product already ran, archived with everything needed to run it
again and the ground truth of how it turned out. `task_logger` and
`pattern_extractor` already produce the raw material; an episode is that
material frozen so the same input can be replayed a year later.

Why grading is injected
-----------------------
Grading an arm means re-running the agent and then re-running the verifiers,
which costs money and is not deterministic. That is right for production and
impossible for CI, so `replay_ab` takes a `Grader`. Production passes one that
drives a real session; `tests/skills_eval/` passes one backed by a recorded
table, and gets the same arithmetic with no API call. The comparison logic —
which is where a subtle bug would silently approve a regression — is identical
in both.

What counts as a regression
---------------------------
An episode the baseline got right and the candidate got wrong. Deliberately
asymmetric: a candidate that fixes three episodes and breaks one is *not*
promoted. A regression is a thing that used to work and now does not, which
users experience as the tool breaking; three improvements do not undo that, and
the candidate can come back once it stops breaking the fourth.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .skill_proposer import Evidence, ExternalSignal

logger = logging.getLogger(__name__)

__all__ = [
    "Episode",
    "ArmResult",
    "EpisodeComparison",
    "ReplayResult",
    "ReplayBudget",
    "Grader",
    "BudgetExhausted",
    "replay_ab",
    "load_episodes",
    "table_grader",
    "BASELINE",
    "CANDIDATE",
]

BASELINE = "baseline"
CANDIDATE = "candidate"


class BudgetExhausted(Exception):
    """The replay stopped early because it ran out of its allowance.

    Raised rather than returned so a partial result can never be mistaken for a
    clean one. Half a replay that found no regression has not found no
    regression; it has not looked.
    """


@dataclass(frozen=True)
class Episode:
    """One archived task, with the ground truth of how it went.

    ``baseline_signals`` is what the external verifiers reported at the time.
    It is not a prediction and not a score — it is what happened.
    """

    episode_id: str
    agent_id: str
    task: str
    """What was asked. Replayed verbatim, so it must be self-contained."""
    language: str = ""
    workflow: str = ""
    baseline_signals: tuple[ExternalSignal, ...] = ()
    context: dict[str, Any] = field(default_factory=dict)
    """Anything the grader needs: changed files, the diff, the failing test."""

    @property
    def baseline_passed(self) -> bool:
        return bool(self.baseline_signals)

    def matches(self, agent_id: str, language: str = "", workflow: str = "") -> bool:
        """Whether this episode is evidence about that agent in that context.

        An empty field on either side means "any": a golden case recorded
        without a workflow is evidence for every workflow, and a query without
        one asks about all of them.
        """
        if self.agent_id != agent_id:
            return False
        if language and self.language and self.language != language:
            return False
        return not (workflow and self.workflow and self.workflow != workflow)


@dataclass(frozen=True)
class ArmResult:
    """What the verifiers said about one arm on one episode."""

    episode_id: str
    arm: str
    signals: tuple[ExternalSignal, ...] = ()
    note: str = ""

    @property
    def passed(self) -> bool:
        """Passing is having an external signal, never claiming to have one."""
        return bool(self.signals)


class Grader(Protocol):
    """Runs one arm on one episode and reports what the verifiers found."""

    def __call__(self, episode: Episode, arm: str, instruction: str) -> ArmResult: ...


@dataclass(frozen=True)
class EpisodeComparison:
    episode: Episode
    baseline: ArmResult
    candidate: ArmResult

    @property
    def regressed(self) -> bool:
        return self.baseline.passed and not self.candidate.passed

    @property
    def improved(self) -> bool:
        return not self.baseline.passed and self.candidate.passed

    def describe(self) -> str:
        if self.regressed:
            verdict = "REGRESSED"
        elif self.improved:
            verdict = "improved"
        else:
            verdict = "unchanged"
        detail = self.candidate.note or self.baseline.note
        return f"{self.episode.episode_id:<28} {verdict}" + (
            f"  ({detail})" if detail else ""
        )


@dataclass
class ReplayResult:
    agent_id: str
    comparisons: list[EpisodeComparison] = field(default_factory=list)

    @property
    def regressions(self) -> list[EpisodeComparison]:
        return [c for c in self.comparisons if c.regressed]

    @property
    def improvements(self) -> list[EpisodeComparison]:
        return [c for c in self.comparisons if c.improved]

    @property
    def ran(self) -> bool:
        return bool(self.comparisons)

    @property
    def clean(self) -> bool:
        """A replay that examined at least one episode and broke none of them.

        An empty replay is not clean. Treating "no episodes" as a pass is how a
        gate quietly stops being a gate: every new agent starts with no golden
        cases, and that is exactly when the check matters most.
        """
        return self.ran and not self.regressions

    def apply_to(self, evidence: Evidence) -> Evidence:
        """Record this replay on the evidence `skill_proposer.evaluate` reads."""
        evidence.replay_ran = self.ran
        evidence.replay_regressions = len(self.regressions)
        return evidence

    def describe(self) -> str:
        if not self.ran:
            return f"{self.agent_id}: no golden episodes — nothing was measured"
        head = (
            f"{self.agent_id}: {len(self.comparisons)} episode(s), "
            f"{len(self.improvements)} improved, {len(self.regressions)} regressed"
        )
        return "\n".join([head, *(f"  {c.describe()}" for c in self.comparisons)])


@dataclass
class ReplayBudget:
    """A cap on how much one replay may spend.

    Mirrors the daily cap `continuous_ai` already enforces
    (`ContinuousAIStatus.is_over_budget`), for the same reason: the learning
    loop runs unattended, and an unattended loop with no ceiling is a way to
    find out what your API bill can reach.
    """

    max_episodes: int = 50
    max_usd: float = 0.0
    """0 means no monetary cap — the offline graders in CI cost nothing."""

    spent_usd: float = 0.0
    graded: int = 0

    @property
    def exhausted(self) -> bool:
        if self.graded >= self.max_episodes:
            return True
        return bool(self.max_usd) and self.spent_usd >= self.max_usd

    def charge(self, usd: float = 0.0) -> None:
        self.graded += 1
        self.spent_usd += usd


def replay_ab(
    episodes: Iterable[Episode],
    *,
    agent_id: str,
    baseline_instruction: str,
    candidate_instruction: str,
    grader: Grader,
    budget: ReplayBudget | None = None,
    cost_of: Callable[[Episode], float] | None = None,
) -> ReplayResult:
    """Run both arms over the same episodes and compare the verdicts.

    Both arms are graded even where the archive already records the baseline's
    outcome. Re-grading it is what keeps the comparison honest: a flaky test or
    a moved dependency changes both arms together, and reusing a stale baseline
    would book that drift as a regression caused by the candidate.
    """
    budget = budget or ReplayBudget()
    result = ReplayResult(agent_id=agent_id)

    for episode in episodes:
        if budget.exhausted:
            raise BudgetExhausted(
                f"replay stopped after {budget.graded} episode(s) "
                f"(${budget.spent_usd:.2f}); raise the budget or trim the corpus"
            )
        cost = cost_of(episode) if cost_of else 0.0
        baseline = grader(episode, BASELINE, baseline_instruction)
        candidate = grader(episode, CANDIDATE, candidate_instruction)
        budget.charge(cost)
        result.comparisons.append(
            EpisodeComparison(episode=episode, baseline=baseline, candidate=candidate)
        )

    return result


# ── the golden corpus ─────────────────────────────────────────────────────────


def load_episodes(root: Path, *, agent_id: str = "") -> list[Episode]:
    """Read the golden corpus, optionally narrowed to one agent.

    One JSON file per episode rather than one big file: episodes are added by
    different runs at different times, and a single file would make every
    addition a merge conflict.
    """
    if not root.is_dir():
        return []
    episodes: list[Episode] = []
    for path in sorted(root.rglob("*.json")):
        if path.name.startswith("_"):
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}: invalid episode JSON — {exc}") from exc
        episode = _episode_from_dict(raw, path)
        if agent_id and episode.agent_id != agent_id:
            continue
        episodes.append(episode)
    return episodes


def _episode_from_dict(raw: dict[str, Any], path: Path) -> Episode:
    missing = [f for f in ("episode_id", "agent_id", "task") if not raw.get(f)]
    if missing:
        raise ValueError(f"{path}: episode is missing {', '.join(missing)}")
    try:
        signals = tuple(ExternalSignal(s) for s in (raw.get("baseline_signals") or []))
    except ValueError as exc:
        # A typo'd signal name would silently become "this episode failed",
        # which turns a passing candidate into a false improvement.
        raise ValueError(f"{path}: unknown external signal — {exc}") from exc
    return Episode(
        episode_id=str(raw["episode_id"]),
        agent_id=str(raw["agent_id"]),
        task=str(raw["task"]),
        language=str(raw.get("language", "")),
        workflow=str(raw.get("workflow", "")),
        baseline_signals=signals,
        context=raw.get("context") or {},
    )


def table_grader(
    outcomes: dict[tuple[str, str], list[ExternalSignal] | list[str]],
    *,
    default_to_baseline: bool = True,
) -> Grader:
    """A grader backed by recorded outcomes, for tests and for dry runs.

    ``outcomes`` maps ``(episode_id, arm)`` to the signals that arm produced.
    With ``default_to_baseline``, an unlisted baseline entry falls back to what
    the episode itself recorded, so a table only has to state what the
    *candidate* changed.
    """

    def grade(episode: Episode, arm: str, instruction: str) -> ArmResult:
        key = (episode.episode_id, arm)
        if key in outcomes:
            raw = outcomes[key]
            signals = tuple(
                s if isinstance(s, ExternalSignal) else ExternalSignal(s) for s in raw
            )
            return ArmResult(episode.episode_id, arm, signals, note="recorded")
        if arm == BASELINE and default_to_baseline:
            return ArmResult(
                episode.episode_id, arm, episode.baseline_signals, note="archived"
            )
        return ArmResult(episode.episode_id, arm, (), note="no recorded outcome")

    return grade
