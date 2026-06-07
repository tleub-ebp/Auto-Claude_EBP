"""
Cross-Agent Consensus Arbiter — Resolve conflicts between agent outputs.

When multiple agents produce contradictory recommendations (e.g. QA vs
Performance, Security vs UX), the arbiter collects all opinions, scores
them by confidence and domain authority, and produces a consensus or
escalates to a human.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class AgentDomain(str, Enum):
    SECURITY = "security"
    PERFORMANCE = "performance"
    QA = "qa"
    UX = "ux"
    ARCHITECTURE = "architecture"
    DATABASE = "database"
    DEVOPS = "devops"
    ACCESSIBILITY = "accessibility"
    COST = "cost"


class ConflictSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ResolutionStrategy(str, Enum):
    HIGHEST_CONFIDENCE = "highest_confidence"
    DOMAIN_AUTHORITY = "domain_authority"
    MAJORITY_VOTE = "majority_vote"
    HUMAN_ESCALATION = "human_escalation"
    WEIGHTED_MERGE = "weighted_merge"


@dataclass
class AgentOpinion:
    """A single agent's recommendation on a topic."""

    agent_name: str
    domain: AgentDomain
    recommendation: str
    confidence: float = 0.5  # 0.0-1.0
    reasoning: str = ""
    affected_files: list[str] = field(default_factory=list)


@dataclass
class Conflict:
    """A detected conflict between agent opinions."""

    topic: str
    opinions: list[AgentOpinion] = field(default_factory=list)
    severity: ConflictSeverity = ConflictSeverity.MEDIUM
    resolved: bool = False
    resolution: str = ""
    strategy_used: ResolutionStrategy | None = None


@dataclass
class ConsensusResult:
    """Result of the arbitration process."""

    conflicts: list[Conflict] = field(default_factory=list)
    resolved_count: int = 0
    escalated_count: int = 0
    consensus_summary: str = ""

    @property
    def all_resolved(self) -> bool:
        return all(c.resolved for c in self.conflicts)


# Domain authority weights for common conflict scenarios
_DOMAIN_AUTHORITY: dict[tuple[str, AgentDomain], float] = {
    ("security", AgentDomain.SECURITY): 1.0,
    ("performance", AgentDomain.PERFORMANCE): 1.0,
    ("accessibility", AgentDomain.ACCESSIBILITY): 1.0,
    ("database", AgentDomain.DATABASE): 1.0,
    ("testing", AgentDomain.QA): 1.0,
    ("ux", AgentDomain.UX): 1.0,
    ("cost", AgentDomain.COST): 0.8,
}


class ArbiterEngine:
    """Resolve conflicts between multiple agent recommendations.

    Usage::

        arbiter = ArbiterEngine()
        result = arbiter.resolve([conflict1, conflict2])
    """

    def __init__(
        self,
        default_strategy: ResolutionStrategy = ResolutionStrategy.DOMAIN_AUTHORITY,
        escalation_threshold: float = 0.3,
    ) -> None:
        self._default_strategy = default_strategy
        self._escalation_threshold = escalation_threshold

    def detect_conflicts(self, opinions: list[AgentOpinion]) -> list[Conflict]:
        """Detect conflicts among a list of agent opinions.

        Groups opinions by affected files and detects contradictions.
        """
        # Group by affected files
        file_opinions: dict[str, list[AgentOpinion]] = {}
        for op in opinions:
            for f in op.affected_files:
                file_opinions.setdefault(f, []).append(op)

        conflicts: list[Conflict] = []
        for file_path, ops in file_opinions.items():
            if len(ops) < 2:
                continue
            # Simple conflict detection: different recommendations on the same file
            recs = {op.recommendation for op in ops}
            if len(recs) > 1:
                conflicts.append(
                    Conflict(
                        topic=f"Conflicting recommendations for {file_path}",
                        opinions=ops,
                        severity=self._assess_severity(ops),
                    )
                )

        return conflicts

    def resolve(self, conflicts: list[Conflict]) -> ConsensusResult:
        """Resolve a list of conflicts using the configured strategy."""
        result = ConsensusResult(conflicts=conflicts)

        for conflict in conflicts:
            if conflict.severity == ConflictSeverity.CRITICAL:
                self._escalate(conflict)
                result.escalated_count += 1
            else:
                self._resolve_conflict(conflict)
                if conflict.resolved:
                    result.resolved_count += 1
                else:
                    result.escalated_count += 1

        summaries = []
        for c in conflicts:
            status = "resolved" if c.resolved else "escalated"
            summaries.append(f"{c.topic}: {status}")
        result.consensus_summary = "; ".join(summaries)

        return result

    def _resolve_conflict(self, conflict: Conflict) -> None:
        strategy = self._default_strategy

        if strategy == ResolutionStrategy.HIGHEST_CONFIDENCE:
            self._resolve_by_confidence(conflict)
        elif strategy == ResolutionStrategy.DOMAIN_AUTHORITY:
            self._resolve_by_authority(conflict)
        elif strategy == ResolutionStrategy.MAJORITY_VOTE:
            self._resolve_by_vote(conflict)
        else:
            self._escalate(conflict)

    def _resolve_by_confidence(self, conflict: Conflict) -> None:
        if not conflict.opinions:
            return
        best = max(conflict.opinions, key=lambda o: o.confidence)
        gap = best.confidence - min(o.confidence for o in conflict.opinions)
        if gap < self._escalation_threshold:
            self._escalate(conflict)
            return
        conflict.resolved = True
        conflict.resolution = best.recommendation
        conflict.strategy_used = ResolutionStrategy.HIGHEST_CONFIDENCE

    def _resolve_by_authority(self, conflict: Conflict) -> None:
        if not conflict.opinions:
            return
        topic_lower = conflict.topic.lower()

        def authority_score(op: AgentOpinion) -> float:
            for (kw, domain), weight in _DOMAIN_AUTHORITY.items():
                if kw in topic_lower and op.domain == domain:
                    return op.confidence * weight
            return op.confidence * 0.5

        best = max(conflict.opinions, key=authority_score)
        conflict.resolved = True
        conflict.resolution = best.recommendation
        conflict.strategy_used = ResolutionStrategy.DOMAIN_AUTHORITY

    def _resolve_by_vote(self, conflict: Conflict) -> None:
        if not conflict.opinions:
            return
        votes: dict[str, int] = {}
        for op in conflict.opinions:
            votes[op.recommendation] = votes.get(op.recommendation, 0) + 1
        # Detect ties: `max(votes, ...)` returns the first-seen winner, which
        # is non-deterministic and produces unreviewed decisions when two
        # opposing recommendations have equal support. Escalate instead.
        max_count = max(votes.values())
        winners = [rec for rec, count in votes.items() if count == max_count]
        if len(winners) > 1:
            self._escalate(conflict)
            return
        conflict.resolved = True
        conflict.resolution = winners[0]
        conflict.strategy_used = ResolutionStrategy.MAJORITY_VOTE

    @staticmethod
    def _escalate(conflict: Conflict) -> None:
        conflict.resolved = False
        conflict.strategy_used = ResolutionStrategy.HUMAN_ESCALATION
        conflict.resolution = "Escalated to human reviewer"

    @staticmethod
    def _assess_severity(opinions: list[AgentOpinion]) -> ConflictSeverity:
        if any(o.domain == AgentDomain.SECURITY for o in opinions):
            return ConflictSeverity.HIGH
        avg_conf = sum(o.confidence for o in opinions) / len(opinions)
        if avg_conf > 0.8:
            return ConflictSeverity.HIGH
        if avg_conf > 0.5:
            return ConflictSeverity.MEDIUM
        return ConflictSeverity.LOW
