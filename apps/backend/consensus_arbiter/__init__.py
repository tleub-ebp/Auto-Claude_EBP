"""
Cross-Agent Consensus Arbiter — Resolve inter-agent conflicts.

Scores opinions by confidence and domain authority, applies resolution
strategies, and escalates unresolvable conflicts to humans.
"""

from .arbiter_engine import (
    AgentDomain,
    AgentOpinion,
    ArbiterEngine,
    Conflict,
    ConflictSeverity,
    ConsensusResult,
    ResolutionStrategy,
)
from .opinion_writer import (
    build_qa_reviewer_opinions,
    build_security_opinions,
    get_task_changed_files,
    opinions_dir,
    record_qa_reviewer_opinion,
    record_security_opinions,
    write_opinions,
)

__all__ = [
    "ArbiterEngine",
    "ConsensusResult",
    "Conflict",
    "AgentOpinion",
    "AgentDomain",
    "ConflictSeverity",
    "ResolutionStrategy",
    # Opinion producer (feeds the runner's agent-opinions directory)
    "record_security_opinions",
    "record_qa_reviewer_opinion",
    "build_security_opinions",
    "build_qa_reviewer_opinions",
    "get_task_changed_files",
    "write_opinions",
    "opinions_dir",
]
