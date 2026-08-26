"""Promoting a learned pattern into a durable skill or agent patch.

The learning loop already has episodic memory (`pattern_extractor` mining
finished builds) and semantic memory (`pattern_storage`, and the prompt
injection that feeds patterns back at run time). What it has never had is
**procedural** memory: nothing a run learns ever reaches the skill and agent
definitions, so the same lesson is re-learned every session.

This module is that missing step. It does not apply anything. It writes a
candidate to `skills/_proposed/` and stops, because the promotion has to be a
reviewable diff.

Why the gates are strict
------------------------
The failure mode for self-improving agents is well documented and it is not
subtle: an agent grading its own homework agrees with itself. A pattern's own
confidence score is the agent's opinion of the agent, so it is necessary but
nowhere near sufficient. A candidate is only promoted when an **external**
signal agrees — tests that went green, a QA pass with no findings, a
deterministic detector that came back clean, a pull request that merged and was
not reverted.

The four gates, all of which must hold:

1. **Frequency** — seen at least ``MIN_OCCURRENCES`` times. One build is an
   anecdote.
2. **External corroboration** — at least ``MIN_VERIFIED_OUTCOMES`` outcomes
   verified by something that is not the agent.
3. **Replay** — the candidate must not regress the golden episodes. Enforced by
   the caller (`tests/skills_eval/`), recorded here.
4. **Human merge** — this module writes a file; a person merges the PR.

Per-agent ledgers
-----------------
Experience is keyed by ``(agent_id, language, workflow)``. `test-runner` on a
Rust project learns from `test-runner` on Rust projects, not from
`code-reviewer` on TypeScript ones. Pooling them produces advice that is true
on average and wrong everywhere.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from .models import LearningPattern

logger = logging.getLogger(__name__)

__all__ = [
    "ExternalSignal",
    "Evidence",
    "LedgerKey",
    "SkillProposal",
    "RejectionReason",
    "MIN_OCCURRENCES",
    "MIN_VERIFIED_OUTCOMES",
    "evaluate",
    "write_proposal",
    "proposal_dir",
]

MIN_OCCURRENCES = 3
MIN_VERIFIED_OUTCOMES = 2

PROPOSED_SUBDIR = Path("skills") / "_proposed"

_SLUG_RE = re.compile(r"[^a-z0-9]+")


class ExternalSignal(str, Enum):
    """Outcomes that are not the agent's opinion of itself.

    Deliberately excludes anything self-reported. `AGENT_CONFIDENCE` is not a
    member of this enum, and that is the point.
    """

    TESTS_PASSED = "tests_passed"
    QA_CLEAN = "qa_clean"
    DETECTOR_CLEAN = "detector_clean"
    PR_MERGED = "pr_merged"


class RejectionReason(str, Enum):
    TOO_RARE = "too_rare"
    UNVERIFIED = "unverified"
    REPLAY_REGRESSION = "replay_regression"
    DISABLED = "disabled"
    ALREADY_PROPOSED = "already_proposed"


@dataclass(frozen=True)
class LedgerKey:
    """Scopes a lesson to the agent that learned it."""

    agent_id: str
    language: str = ""
    workflow: str = ""

    def slug(self) -> str:
        parts = [p for p in (self.agent_id, self.language, self.workflow) if p]
        return _SLUG_RE.sub("-", "-".join(parts).lower()).strip("-")


@dataclass
class Evidence:
    """What actually happened after this pattern was applied."""

    signals: list[ExternalSignal] = field(default_factory=list)
    build_ids: list[str] = field(default_factory=list)
    replay_regressions: int = 0
    replay_ran: bool = False

    @property
    def verified_count(self) -> int:
        """How many separate times something external agreed.

        Counted in **builds**, not signals. One run that passed its tests and
        its QA is two witnesses to a single event, not two events — and the
        gate is asking whether the lesson held up more than once, which one run
        cannot answer however many verifiers it satisfied.

        Falls back to the signal count when no build recorded itself, so a
        caller that has corroboration but no build id is not silently stuck at
        zero.
        """
        return len(set(self.build_ids)) if self.build_ids else len(self.signals)

    def add(self, signal: ExternalSignal, build_id: str = "") -> None:
        self.signals.append(signal)
        if build_id:
            self.build_ids.append(build_id)


@dataclass
class SkillProposal:
    """A candidate patch, and the reasoning behind it."""

    key: LedgerKey
    pattern_id: str
    title: str
    instruction: str
    evidence: Evidence
    occurrence_count: int
    created_at: str = ""

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat()

    def filename(self) -> str:
        return f"{self.key.slug()}--{self.pattern_id}.md"


def evaluate(
    pattern: LearningPattern, evidence: Evidence
) -> tuple[bool, RejectionReason | None, str]:
    """Decide whether ``pattern`` has earned a proposal.

    Returns ``(promote, reason, explanation)``. The explanation is written into
    the proposal so a reviewer sees the evidence, not just the conclusion.
    """
    if not pattern.enabled:
        return False, RejectionReason.DISABLED, "pattern is disabled"

    if pattern.occurrence_count < MIN_OCCURRENCES:
        return (
            False,
            RejectionReason.TOO_RARE,
            f"seen {pattern.occurrence_count}×, needs {MIN_OCCURRENCES}",
        )

    if evidence.verified_count < MIN_VERIFIED_OUTCOMES:
        return (
            False,
            RejectionReason.UNVERIFIED,
            f"corroborated on {evidence.verified_count} build(s), "
            f"needs {MIN_VERIFIED_OUTCOMES}. The pattern's own confidence "
            f"({pattern.confidence:.2f}) does not count: it is the agent's "
            f"assessment of the agent.",
        )

    if evidence.replay_ran and evidence.replay_regressions:
        return (
            False,
            RejectionReason.REPLAY_REGRESSION,
            f"replay regressed {evidence.replay_regressions} golden episode(s)",
        )

    signals = ", ".join(sorted({s.value for s in evidence.signals}))
    return (
        True,
        None,
        f"seen {pattern.occurrence_count}×, corroborated by {signals}"
        + (" and a clean replay" if evidence.replay_ran else ""),
    )


def proposal_dir(repo_root: Path) -> Path:
    return repo_root / PROPOSED_SUBDIR


def write_proposal(
    repo_root: Path, proposal: SkillProposal, explanation: str
) -> Path | None:
    """Write a candidate to ``skills/_proposed/``.

    Returns the path written, or None when an identical proposal is already
    waiting for review — re-proposing the same thing every night turns the
    review queue into noise and the loop into a spam generator.
    """
    target_dir = proposal_dir(repo_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / proposal.filename()
    if path.exists():
        logger.debug("proposal already pending: %s", path.name)
        return None

    body = f"""---
name: {proposal.key.slug()}
description: {proposal.title}
metadata:
  workpilot:
    proposal:
      agent: {proposal.key.agent_id}
      language: {proposal.key.language or "any"}
      workflow: {proposal.key.workflow or "any"}
      pattern_id: {proposal.pattern_id}
      created_at: {proposal.created_at}
---

<!--
  Proposed by the learning loop. Nothing here is active: a file under
  skills/_proposed/ is not a pack, so the resolver ignores it. To adopt it,
  fold the instruction into a real skill or subagent prompt and delete this
  file. To reject it, delete this file.
-->

## Proposed instruction

{proposal.instruction}

## Why

{explanation}

Observed {proposal.occurrence_count} time(s). External signals:
{chr(10).join(f"- {s.value}" for s in proposal.evidence.signals) or "- none"}

Builds: {", ".join(proposal.evidence.build_ids) or "not recorded"}
"""
    path.write_text(body, encoding="utf-8")
    logger.info("wrote skill proposal %s", path.name)
    return path


def ledger_path(repo_root: Path, key: LedgerKey) -> Path:
    """Where one agent's experience for one context is accumulated."""
    return proposal_dir(repo_root) / "_ledgers" / f"{key.slug()}.json"


def record_outcome(
    repo_root: Path,
    key: LedgerKey,
    pattern_id: str,
    signal: ExternalSignal,
    build_id: str = "",
) -> None:
    """Append one externally verified outcome to an agent's ledger.

    Best-effort: a learning-loop bookkeeping failure must never affect the
    build that produced the observation.
    """
    try:
        path = ledger_path(repo_root, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {}
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
        entry = data.setdefault(pattern_id, {"signals": [], "builds": []})
        entry["signals"].append(signal.value)
        if build_id:
            entry["builds"].append(build_id)
        data["_key"] = asdict(key)
        path.write_text(
            json.dumps(data, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except Exception as exc:  # pragma: no cover
        logger.debug("could not record outcome in ledger: %s", exc)
