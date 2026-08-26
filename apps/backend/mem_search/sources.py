"""Adapters over the memories WorkPilot already keeps.

Nothing here stores anything. Each adapter exposes an existing store through
the `MemorySource` staircase, which is the whole reason this is a query layer
rather than a fourth memory: `task_logger/` keeps the traces, `learning_loop/`
keeps the distilled patterns, `integrations/graphiti/` keeps the graph, and
they go on doing exactly that.

The rule every adapter follows: **`refs()` must not read a body.** A spec's
task log is a single JSON file that can run to megabytes, so the index is built
from directory names and the small header each store already keeps, and the log
is opened only when someone asks for that id's detail.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .layers import MemoryRecord, MemoryRef, TimelineEntry

logger = logging.getLogger(__name__)

__all__ = [
    "TaskLogSource",
    "PatternSource",
    "default_sources",
]

_STOPWORDS = frozenset(
    {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "we"}
)


def _terms(query: str) -> list[str]:
    return [t for t in query.lower().split() if t and t not in _STOPWORDS]


def _score(text: str, terms: list[str]) -> float:
    """Fraction of the query's terms present. No terms means everything ties.

    A lexical score, deliberately. The semantic layer is graphiti's job and it
    is a separate source; making the cheap index depend on an embedding call
    would put a network round trip in front of the question "is there anything
    here at all?".
    """
    if not terms:
        return 0.5
    haystack = text.lower()
    return sum(1 for t in terms if t in haystack) / len(terms)


def _date_of(timestamp: str) -> str:
    return (timestamp or "")[:10]


class TaskLogSource:
    """Finished builds, from `.workpilot/specs/*/task_logs.json`.

    Indexed from the spec directory names, which is why listing is cheap: the
    log files themselves are opened only by `summarise` and `load`.
    """

    name = "task-log"
    LOG_FILE = "task_logs.json"

    def __init__(self, project_dir: Path):
        self.specs_dir = Path(project_dir) / ".workpilot" / "specs"

    def _log_path(self, spec_id: str) -> Path:
        return self.specs_dir / spec_id / self.LOG_FILE

    def refs(self, query: str, limit: int) -> list[MemoryRef]:
        if not self.specs_dir.is_dir():
            return []
        terms = _terms(query)
        found: list[MemoryRef] = []
        for spec_dir in sorted(self.specs_dir.iterdir(), reverse=True):
            if not spec_dir.is_dir() or not self._log_path(spec_dir.name).is_file():
                continue
            # The directory name is `NNN-kebab-case-goal`, which is a usable
            # label and costs nothing to read.
            label = spec_dir.name.split("-", 1)[-1].replace("-", " ")
            score = _score(spec_dir.name.replace("-", " "), terms)
            if terms and score == 0:
                continue
            found.append(
                MemoryRef(
                    id=f"task:{spec_dir.name}",
                    kind="task",
                    label=label,
                    when=_mtime_date(self._log_path(spec_dir.name)),
                    score=score,
                )
            )
            if len(found) >= limit:
                break
        return found

    def _read(self, ref_id: str) -> dict | None:
        if not ref_id.startswith("task:"):
            return None
        path = self._log_path(ref_id.split(":", 1)[1])
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.debug("could not read %s: %s", path, exc)
            return None

    def summarise(self, ref_id: str) -> TimelineEntry | None:
        data = self._read(ref_id)
        if data is None:
            return None
        phases = data.get("phases") or {}
        parts = [
            f"{name}: {phase.get('status', '?')} "
            f"({len(phase.get('entries') or [])} entries)"
            for name, phase in phases.items()
        ]
        return TimelineEntry(
            id=ref_id,
            kind="task",
            label=str(data.get("spec_id", ref_id)),
            when=_date_of(str(data.get("updated_at", ""))),
            summary="; ".join(parts) or "no phases recorded",
        )

    def load(self, ref_id: str) -> MemoryRecord | None:
        data = self._read(ref_id)
        if data is None:
            return None
        return MemoryRecord(
            id=ref_id,
            kind="task",
            label=str(data.get("spec_id", ref_id)),
            when=_date_of(str(data.get("updated_at", ""))),
            body=json.dumps(data, indent="\t", ensure_ascii=False),
            meta={"phases": list((data.get("phases") or {}).keys())},
        )


class PatternSource:
    """Distilled patterns, from `learning_loop`'s store.

    Patterns are already short, so all three layers come from the same file.
    The staircase still holds: the index shows the description, the timeline
    adds the evidence, and only the detail carries the full instruction.
    """

    name = "pattern"

    def __init__(self, project_dir: Path):
        self.path = Path(project_dir) / ".workpilot" / "learning_loop" / "patterns.json"
        self._cache: list[dict] | None = None

    def _all(self) -> list[dict]:
        if self._cache is not None:
            return self._cache
        self._cache = []
        if self.path.is_file():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self._cache = [p for p in raw if isinstance(p, dict)]
            except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                logger.debug("could not read %s: %s", self.path, exc)
        return self._cache

    def _find(self, ref_id: str) -> dict | None:
        if not ref_id.startswith("pattern:"):
            return None
        wanted = ref_id.split(":", 1)[1]
        return next((p for p in self._all() if p.get("pattern_id") == wanted), None)

    def refs(self, query: str, limit: int) -> list[MemoryRef]:
        terms = _terms(query)
        found: list[MemoryRef] = []
        for pattern in self._all():
            if not pattern.get("enabled", True):
                continue
            text = f"{pattern.get('description', '')} {' '.join(pattern.get('context_tags') or [])}"
            score = _score(text, terms)
            if terms and score == 0:
                continue
            found.append(
                MemoryRef(
                    id=f"pattern:{pattern.get('pattern_id', '?')}",
                    kind="pattern",
                    label=str(pattern.get("description", "")),
                    when=_date_of(str(pattern.get("last_seen", ""))),
                    score=score,
                )
            )
        found.sort(key=lambda r: -r.score)
        return found[:limit]

    def summarise(self, ref_id: str) -> TimelineEntry | None:
        pattern = self._find(ref_id)
        if pattern is None:
            return None
        return TimelineEntry(
            id=ref_id,
            kind="pattern",
            label=str(pattern.get("description", "")),
            when=_date_of(str(pattern.get("last_seen", ""))),
            summary=(
                f"seen {pattern.get('occurrence_count', 0)}× in "
                f"{pattern.get('agent_phase', 'unknown')}, "
                f"applied {pattern.get('applied_count', 0)}×"
            ),
            related=tuple(pattern.get("source_build_ids") or []),
        )

    def load(self, ref_id: str) -> MemoryRecord | None:
        pattern = self._find(ref_id)
        if pattern is None:
            return None
        return MemoryRecord(
            id=ref_id,
            kind="pattern",
            label=str(pattern.get("description", "")),
            when=_date_of(str(pattern.get("last_seen", ""))),
            body=str(pattern.get("actionable_instruction", "")),
            meta=pattern,
        )


def _mtime_date(path: Path) -> str:
    from datetime import datetime, timezone

    try:
        stamp = path.stat().st_mtime
    except OSError:
        return ""
    return datetime.fromtimestamp(stamp, tz=timezone.utc).date().isoformat()


def default_sources(project_dir: Path) -> list:
    """The stores a project has, in the order the index should prefer them.

    Patterns first: they are already distilled, so a hit there answers the
    question outright, while a task log hit is a pointer to somewhere the
    answer might be.
    """
    return [PatternSource(project_dir), TaskLogSource(project_dir)]
