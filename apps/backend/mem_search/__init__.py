"""`mem-search` — progressive retrieval over the memories WorkPilot already has.

    from mem_search import search_for

    memory = search_for(project_dir)
    index = memory.index("flaky timeout in the integration suite")   # ~100 tokens
    memory.timeline(index.ids()[:3])                                 # a few lines each
    memory.detail("task:042-add-widget")                             # the whole record

Three layers, each paid for only when the previous one justified it. See
`layers.py` for why, and `sources.py` for what is behind them.
"""

from __future__ import annotations

from pathlib import Path

from .layers import (
    INDEX_TOKEN_BUDGET,
    IndexResult,
    MemoryRecord,
    MemoryRef,
    MemorySearch,
    MemorySource,
    TimelineEntry,
    estimate_tokens,
)
from .sources import PatternSource, TaskLogSource, default_sources

__all__ = [
    "MemorySearch",
    "MemorySource",
    "MemoryRef",
    "MemoryRecord",
    "TimelineEntry",
    "IndexResult",
    "PatternSource",
    "TaskLogSource",
    "default_sources",
    "estimate_tokens",
    "search_for",
    "INDEX_TOKEN_BUDGET",
]


def search_for(project_dir: Path | str) -> MemorySearch:
    """A `MemorySearch` over whichever stores this project actually has."""
    return MemorySearch(default_sources(Path(project_dir)))
