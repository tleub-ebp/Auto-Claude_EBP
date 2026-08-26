"""Three-layer retrieval: an index you can afford, details you ask for.

WorkPilot already has three memories. `task_logger/` captures what happened,
`integrations/graphiti/` holds the knowledge graph, `learning_loop/` distils
patterns. What it has never had is a way to *look* at them that does not cost a
context window: the existing readers return whole records, so an agent asking
"have we hit this before?" pays for every candidate in order to discard most of
them.

claude-mem's answer to the same problem is worth taking, and it is a query
shape rather than a dependency — installing the tool itself would add a fourth
memory, with its own worker, its own SQLite file and its own vector store,
redundant with all three of the above. What it gets right is the staircase:

1. **index** — a compact list of what exists. One line each: an id, a kind, a
   date, a label. Sized to a token budget and hard-trimmed to fit.
2. **timeline** — for the handful of ids that looked relevant, a couple of
   lines each: what happened, and what it connects to.
3. **detail** — the full record, one id at a time, and only when asked.

The discipline is in the layering, not in any one layer: the index must be
*cheap to produce as well as cheap to read*. A source that loads every record
to build its index has moved the cost rather than removed it, so `MemorySource`
splits `refs()` from `load()` and this module never calls the second while
building the first.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

logger = logging.getLogger(__name__)

__all__ = [
    "MemoryRef",
    "TimelineEntry",
    "MemoryRecord",
    "MemorySource",
    "MemorySearch",
    "IndexResult",
    "estimate_tokens",
    "INDEX_TOKEN_BUDGET",
]

# The index has to fit in the space an agent will spend on "is there anything
# here?" before it has decided the answer is yes.
INDEX_TOKEN_BUDGET = 100

# Characters per token. Rough by design: the budget is a discipline, not an
# accounting system, and a tokeniser dependency here would be a heavier import
# than the thing it measures.
_CHARS_PER_TOKEN = 4

_MAX_LABEL = 56


def estimate_tokens(text: str) -> int:
    """A deliberately cheap token estimate, rounded up."""
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


@dataclass(frozen=True)
class MemoryRef:
    """Layer 1. Enough to decide whether to look, never enough to read."""

    id: str
    kind: str
    """task | pattern | qa | insight — what asking for the detail will cost."""
    label: str
    when: str = ""
    """Date only. A full timestamp is four tokens spent on nothing."""
    score: float = 0.0

    def line(self) -> str:
        label = self.label.strip().replace("\n", " ")
        if len(label) > _MAX_LABEL:
            label = label[: _MAX_LABEL - 1].rstrip() + "…"
        return f"{self.id} {self.kind} {self.when} {label}".strip()


@dataclass(frozen=True)
class TimelineEntry:
    """Layer 2. What happened, in the space of a couple of lines."""

    id: str
    kind: str
    label: str
    when: str
    summary: str
    related: tuple[str, ...] = ()


@dataclass(frozen=True)
class MemoryRecord:
    """Layer 3. The whole thing, fetched one id at a time."""

    id: str
    kind: str
    label: str
    when: str
    body: str
    meta: dict[str, Any] = field(default_factory=dict)


class MemorySource(Protocol):
    """One store, exposed as the staircase.

    The split is the contract. ``refs`` must be answerable without reading the
    bodies — from filenames, an index, a header — because an implementation
    that loads everything to list it has kept all of the cost and lost the
    point.
    """

    name: str

    def refs(self, query: str, limit: int) -> list[MemoryRef]: ...

    def summarise(self, ref_id: str) -> TimelineEntry | None: ...

    def load(self, ref_id: str) -> MemoryRecord | None: ...


@dataclass
class IndexResult:
    """Layer 1's output, with the arithmetic that kept it small."""

    query: str
    refs: list[MemoryRef] = field(default_factory=list)
    truncated: int = 0
    """How many matches were dropped to stay inside the budget."""
    budget_tokens: int = INDEX_TOKEN_BUDGET

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.render())

    def render(self) -> str:
        """What the agent actually reads.

        No header, no blank lines, no framing prose. Every token of decoration
        here is a token not spent on a candidate, and the agent knows what it
        asked for.
        """
        lines = [ref.line() for ref in self.refs]
        if self.truncated:
            lines.append(f"+{self.truncated} more — narrow the query")
        return "\n".join(lines)

    def ids(self) -> list[str]:
        return [ref.id for ref in self.refs]


class MemorySearch:
    """The staircase, over however many sources are configured."""

    def __init__(self, sources: list[MemorySource]):
        self.sources = sources

    # ── layer 1 ───────────────────────────────────────────────────────────────

    def index(
        self,
        query: str,
        *,
        limit: int = 40,
        budget_tokens: int = INDEX_TOKEN_BUDGET,
    ) -> IndexResult:
        """What exists, ranked, trimmed to fit the budget.

        The budget is enforced by dropping entries, not by shortening the ones
        that stay: a list of truncated ids is unusable, and the count of what
        was dropped tells the agent to ask a narrower question — which is the
        correct next move and costs one line.
        """
        candidates: list[MemoryRef] = []
        for source in self.sources:
            try:
                candidates.extend(source.refs(query, limit))
            except Exception as exc:  # noqa: BLE001 - one bad store, not no search
                logger.warning("memory source %r failed: %s", source.name, exc)

        candidates.sort(key=lambda r: (-r.score, r.when, r.id))

        result = IndexResult(query=query, budget_tokens=budget_tokens)
        used = 0
        for ref in candidates[:limit]:
            cost = estimate_tokens(ref.line()) + 1  # the newline
            if used + cost > budget_tokens:
                break
            result.refs.append(ref)
            used += cost
        result.truncated = len(candidates) - len(result.refs)

        # The "+N more" line is part of the output, so it has to be paid for.
        # Dropping one more entry to make room beats silently exceeding the
        # budget the caller asked to be held to.
        while result.refs and result.tokens > budget_tokens:
            result.refs.pop()
            result.truncated += 1
        return result

    # ── layer 2 ───────────────────────────────────────────────────────────────

    def timeline(self, ref_ids: list[str]) -> list[TimelineEntry]:
        """A couple of lines each, for ids the index already surfaced."""
        entries: list[TimelineEntry] = []
        for ref_id in ref_ids:
            for source in self.sources:
                try:
                    entry = source.summarise(ref_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("memory source %r failed: %s", source.name, exc)
                    continue
                if entry is not None:
                    entries.append(entry)
                    break
        return entries

    # ── layer 3 ───────────────────────────────────────────────────────────────

    def detail(self, ref_id: str) -> MemoryRecord | None:
        """The full record. One id, on request, never in bulk."""
        for source in self.sources:
            try:
                record = source.load(ref_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory source %r failed: %s", source.name, exc)
                continue
            if record is not None:
                return record
        return None
