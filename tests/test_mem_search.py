"""Tests for `mem-search`: the staircase, and the two ways it can be defeated.

The layering only saves anything if two things hold.

**Layer 1 fits.** An index that grows with the archive is not an index; the
budget has to be enforced by dropping entries, and the caller has to be told
how many were dropped so it knows to narrow the query.

**Layer 1 does not read layer 3.** A source that loads every record in order to
list them has moved the cost, not removed it, and nothing about the output
would reveal it. The spy source below is the only way to catch that.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from mem_search import (  # noqa: E402
    INDEX_TOKEN_BUDGET,
    MemoryRecord,
    MemoryRef,
    MemorySearch,
    PatternSource,
    TaskLogSource,
    TimelineEntry,
    default_sources,
    estimate_tokens,
    search_for,
)


class SpySource:
    """Counts which layer was asked for what."""

    name = "spy"

    def __init__(self, count: int = 50):
        self.count = count
        self.refs_calls = 0
        self.summarise_calls: list[str] = []
        self.load_calls: list[str] = []

    def refs(self, query: str, limit: int) -> list[MemoryRef]:
        self.refs_calls += 1
        return [
            MemoryRef(
                id=f"spy:{i}",
                kind="task",
                label=f"episode number {i} about retries and timeouts",
                when="2026-08-01",
                score=1.0 - i / 1000,
            )
            for i in range(self.count)
        ]

    def summarise(self, ref_id: str) -> TimelineEntry | None:
        self.summarise_calls.append(ref_id)
        if not ref_id.startswith("spy:"):
            return None
        return TimelineEntry(ref_id, "task", "label", "2026-08-01", "two lines here")

    def load(self, ref_id: str) -> MemoryRecord | None:
        self.load_calls.append(ref_id)
        if not ref_id.startswith("spy:"):
            return None
        return MemoryRecord(ref_id, "task", "label", "2026-08-01", "x" * 50_000)


class ExplodingSource:
    name = "exploding"

    def refs(self, query, limit):
        raise RuntimeError("store is unreachable")

    def summarise(self, ref_id):
        raise RuntimeError("store is unreachable")

    def load(self, ref_id):
        raise RuntimeError("store is unreachable")


# ── layer 1: the budget ───────────────────────────────────────────────────────


def test_the_index_fits_in_its_token_budget():
    """The headline promise: ~100 tokens however much is in memory."""
    memory = MemorySearch([SpySource(count=500)])
    result = memory.index("retries and timeouts")
    assert result.tokens <= INDEX_TOKEN_BUDGET
    assert result.refs, "budget enforced by returning nothing is not an index"


@pytest.mark.parametrize("archive_size", [10, 100, 1000, 5000])
def test_the_index_does_not_grow_with_the_archive(archive_size: int):
    memory = MemorySearch([SpySource(count=archive_size)])
    assert memory.index("timeouts").tokens <= INDEX_TOKEN_BUDGET


def test_what_was_dropped_is_reported_not_hidden():
    """`+N more` is the signal to ask a narrower question."""
    memory = MemorySearch([SpySource(count=200)])
    result = memory.index("timeouts")
    assert result.truncated > 0
    assert "more — narrow the query" in result.render()


def test_the_more_line_is_itself_inside_the_budget():
    """Adding the footer must not push the output past the ceiling."""
    memory = MemorySearch([SpySource(count=200)])
    result = memory.index("timeouts", budget_tokens=30)
    assert estimate_tokens(result.render()) <= 30


def test_a_caller_can_buy_a_bigger_index():
    small = MemorySearch([SpySource(count=200)]).index("t", budget_tokens=50)
    large = MemorySearch([SpySource(count=200)]).index("t", budget_tokens=400)
    assert len(large.refs) > len(small.refs)
    assert large.tokens <= 400


def test_long_labels_are_trimmed_rather_than_wrapped():
    class LongLabels(SpySource):
        def refs(self, query, limit):
            return [MemoryRef("spy:0", "task", "y" * 500, "2026-08-01", 1.0)]

    result = MemorySearch([LongLabels()]).index("q")
    assert result.refs
    assert result.tokens <= INDEX_TOKEN_BUDGET
    assert result.render().endswith("…")


def test_an_empty_memory_indexes_to_nothing():
    result = MemorySearch([SpySource(count=0)]).index("anything")
    assert result.refs == []
    assert result.render() == ""


# ── the laziness that makes the budget mean something ─────────────────────────


def test_the_index_never_loads_a_record():
    spy = SpySource(count=200)
    MemorySearch([spy]).index("timeouts")
    assert spy.refs_calls == 1
    assert spy.load_calls == [], "layer 1 read bodies: the cost was moved, not removed"
    assert spy.summarise_calls == []


def test_the_timeline_never_loads_a_record():
    spy = SpySource()
    MemorySearch([spy]).timeline(["spy:1", "spy:2"])
    assert spy.summarise_calls == ["spy:1", "spy:2"]
    assert spy.load_calls == []


def test_detail_loads_exactly_the_id_that_was_asked_for():
    spy = SpySource(count=200)
    memory = MemorySearch([spy])
    index = memory.index("timeouts")
    assert len(index.refs) > 1

    memory.detail("spy:3")
    assert spy.load_calls == ["spy:3"]


def test_the_full_record_is_only_reachable_through_detail():
    spy = SpySource()
    memory = MemorySearch([spy])
    rendered = memory.index("timeouts").render()
    summaries = " ".join(e.summary for e in memory.timeline(["spy:0"]))
    assert "x" * 100 not in rendered
    assert "x" * 100 not in summaries
    assert "x" * 100 in memory.detail("spy:0").body


def test_detail_on_an_unknown_id_is_none_not_an_exception():
    assert MemorySearch([SpySource()]).detail("nope:1") is None


# ── one broken store must not take the search down ────────────────────────────


def test_a_failing_source_is_skipped_not_fatal():
    memory = MemorySearch([ExplodingSource(), SpySource(count=5)])
    result = memory.index("timeouts")
    assert result.refs, "one unreachable store silenced the ones that work"
    assert memory.timeline(["spy:0"])
    assert memory.detail("spy:0") is not None


# ── the real adapters ─────────────────────────────────────────────────────────


@pytest.fixture
def project(tmp_path: Path) -> Path:
    specs = tmp_path / ".workpilot" / "specs"
    for name in ("041-fix-flaky-timeout", "042-add-widget"):
        spec = specs / name
        spec.mkdir(parents=True)
        (spec / "task_logs.json").write_text(
            json.dumps(
                {
                    "spec_id": name,
                    "updated_at": "2026-08-20T10:00:00Z",
                    "phases": {
                        "coding": {
                            "status": "completed",
                            "entries": [{"content": "z" * 20_000}],
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

    learning = tmp_path / ".workpilot" / "learning_loop"
    learning.mkdir(parents=True)
    (learning / "patterns.json").write_text(
        json.dumps(
            [
                {
                    "pattern_id": "p-17",
                    "description": "retry a flaky timeout once before reporting it",
                    "category": "qa_pattern",
                    "pattern_type": "success",
                    "source": "build_analysis",
                    "confidence": 0.8,
                    "occurrence_count": 4,
                    "agent_phase": "qa_review",
                    "context_tags": ["python", "flaky"],
                    "actionable_instruction": "w" * 5_000,
                    "last_seen": "2026-08-21T09:00:00Z",
                    "enabled": True,
                },
                {
                    "pattern_id": "p-18",
                    "description": "disabled pattern nobody should see",
                    "category": "qa_pattern",
                    "pattern_type": "success",
                    "source": "build_analysis",
                    "confidence": 0.2,
                    "occurrence_count": 1,
                    "agent_phase": "coding",
                    "context_tags": [],
                    "actionable_instruction": "no",
                    "last_seen": "2026-08-01T09:00:00Z",
                    "enabled": False,
                },
            ]
        ),
        encoding="utf-8",
    )
    return tmp_path


def test_the_index_finds_both_kinds_of_memory(project: Path):
    result = search_for(project).index("flaky timeout")
    kinds = {r.kind for r in result.refs}
    assert kinds == {"pattern", "task"}
    assert result.tokens <= INDEX_TOKEN_BUDGET


def test_the_index_over_real_stores_never_opens_a_log(project: Path, monkeypatch):
    """The task log is one file that can run to megabytes.

    Indexing reads the spec directory names, so a large archive costs a
    directory listing rather than a read per spec.
    """
    opened: list[str] = []
    real_read = Path.read_text

    def spy_read(self, *a, **kw):
        opened.append(self.name)
        return real_read(self, *a, **kw)

    monkeypatch.setattr(Path, "read_text", spy_read)
    TaskLogSource(project).refs("flaky", 40)
    assert "task_logs.json" not in opened


def test_a_disabled_pattern_is_not_indexed(project: Path):
    result = search_for(project).index("disabled pattern nobody")
    assert "pattern:p-18" not in result.ids()


def test_the_timeline_summarises_without_the_body(project: Path):
    memory = search_for(project)
    entries = memory.timeline(["task:042-add-widget", "pattern:p-17"])
    assert len(entries) == 2
    joined = " ".join(e.summary for e in entries)
    assert "coding: completed" in joined
    assert "seen 4×" in joined
    assert "z" * 100 not in joined
    assert "w" * 100 not in joined


def test_detail_returns_the_whole_record(project: Path):
    memory = search_for(project)
    assert "z" * 100 in memory.detail("task:042-add-widget").body
    assert "w" * 100 in memory.detail("pattern:p-17").body


def test_ids_from_the_index_resolve_at_the_other_two_layers(project: Path):
    """The ids the index prints are the ids the other layers accept, verbatim."""
    memory = search_for(project)
    for ref_id in memory.index("flaky timeout").ids():
        assert memory.timeline([ref_id]), ref_id
        assert memory.detail(ref_id) is not None, ref_id


def test_a_project_with_no_memory_yet_returns_an_empty_index(tmp_path: Path):
    result = search_for(tmp_path).index("anything")
    assert result.refs == []
    assert result.truncated == 0


def test_patterns_are_preferred_over_task_logs(project: Path):
    """A distilled pattern answers the question; a task log points at it."""
    sources = default_sources(project)
    assert isinstance(sources[0], PatternSource)
    assert isinstance(sources[1], TaskLogSource)


def test_a_corrupt_store_does_not_break_the_search(project: Path):
    (project / ".workpilot" / "learning_loop" / "patterns.json").write_text(
        "{ not json", encoding="utf-8"
    )
    result = search_for(project).index("flaky timeout")
    assert {r.kind for r in result.refs} == {"task"}


# ── the skill's CLI ───────────────────────────────────────────────────────────


def test_the_skill_script_is_shipped_and_parses():
    script = (
        REPO_ROOT / "skills" / "tooling" / "mem-search" / "scripts" / "mem_search.py"
    )
    assert script.is_file(), "the skill documents a script it does not ship"
    compile(script.read_text(encoding="utf-8"), str(script), "exec")


def test_the_skill_documents_the_three_layers():
    skill = REPO_ROOT / "skills" / "tooling" / "mem-search" / "SKILL.md"
    body = skill.read_text(encoding="utf-8")
    for layer in ("index", "timeline", "detail"):
        assert f"mem_search.py {layer}" in body, f"{layer} is undocumented"
