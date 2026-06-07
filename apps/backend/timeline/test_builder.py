"""Tests for the agent timeline builder."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from audit_trail import AuditTrail
from timeline import build_timeline


def _seed(project_dir: Path, events: list[tuple[str, str, str, str]]) -> None:
    """events = [(kind, actor, correlation_id, summary), ...]"""
    storage = project_dir / ".workpilot" / "audit-trail"
    storage.mkdir(parents=True, exist_ok=True)
    trail = AuditTrail(storage_dir=storage, name="default")
    for kind, actor, cid, summary in events:
        trail.append(kind=kind, actor=actor, correlation_id=cid, summary=summary)


# ---------------------------------------------------------------------------
# Empty / missing data


class TestEmptyTimeline:
    def test_no_trail_dir_returns_empty(self, tmp_path: Path) -> None:
        snap = build_timeline(tmp_path, "spec-1")
        assert snap.entries == []
        assert snap.integrity_intact is True

    def test_unknown_correlation_id_returns_empty(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "x"),
            ],
        )
        snap = build_timeline(tmp_path, "ghost-spec")
        assert snap.entries == []


# ---------------------------------------------------------------------------
# Building entries


class TestEntries:
    def test_groups_events_for_correlation_id(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "planner started"),
                ("agent_invoked", "coder", "spec-1", "coder started"),
                ("agent_invoked", "coder", "spec-2", "other spec"),
                ("agent_completed", "qa_reviewer", "spec-1", "approved"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1")
        assert len(snap.entries) == 3
        assert [e.actor for e in snap.entries] == [
            "planner",
            "coder",
            "qa_reviewer",
        ]

    def test_assigns_phases_via_actor_map(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "x"),
                ("agent_invoked", "coder", "spec-1", "x"),
                ("agent_invoked", "qa_reviewer", "spec-1", "x"),
                ("agent_invoked", "qa_fixer", "spec-1", "x"),
                ("system_event", "model_router", "spec-1", "x"),
                ("system_event", "totally_unknown", "spec-1", "x"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1")
        phases = [e.phase for e in snap.entries]
        assert phases == [
            "planning",
            "coding",
            "qa",
            "qa",
            "system",
            "system",
        ]
        assert snap.phase_counts["coding"] == 1
        assert snap.phase_counts["qa"] == 2

    def test_first_entry_has_zero_delta(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "x"),
                ("agent_invoked", "coder", "spec-1", "x"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1")
        assert snap.entries[0].delta_seconds == 0.0
        assert snap.entries[1].delta_seconds >= 0.0

    def test_iso_timestamp_uses_utc_z(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [("agent_invoked", "planner", "spec-1", "x")],
        )
        snap = build_timeline(tmp_path, "spec-1")
        assert snap.entries[0].timestamp_iso.endswith("Z")


# ---------------------------------------------------------------------------
# Filters


class TestFilters:
    def test_actor_filter(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "p"),
                ("agent_invoked", "coder", "spec-1", "c"),
                ("agent_invoked", "qa_reviewer", "spec-1", "q"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1", actor_filter="coder")
        assert len(snap.entries) == 1
        assert snap.entries[0].actor == "coder"

    def test_kind_filter(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "p"),
                ("agent_completed", "planner", "spec-1", "p done"),
                ("agent_invoked", "coder", "spec-1", "c"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1", kind_filter="agent_completed")
        assert len(snap.entries) == 1
        assert snap.entries[0].summary == "p done"


# ---------------------------------------------------------------------------
# Integrity verdict


class TestIntegrity:
    def test_clean_chain_intact(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "x"),
                ("agent_invoked", "coder", "spec-1", "y"),
            ],
        )
        snap = build_timeline(tmp_path, "spec-1")
        assert snap.integrity_intact is True
        assert snap.integrity_reason is None

    def test_tampered_chain_flagged(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [
                ("agent_invoked", "planner", "spec-1", "x"),
                ("agent_invoked", "coder", "spec-1", "y"),
            ],
        )
        # Tamper with line 0 directly on disk.
        path = tmp_path / ".workpilot" / "audit-trail" / "default.audit.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        evil = json.loads(lines[0])
        evil["summary"] = "I changed my mind"
        lines[0] = json.dumps(evil, separators=(",", ":"))
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        snap = build_timeline(tmp_path, "spec-1")
        assert snap.integrity_intact is False


# ---------------------------------------------------------------------------
# JSON serialisation


class TestSerialisation:
    def test_to_dict_roundtrips_through_json(self, tmp_path: Path) -> None:
        _seed(
            tmp_path,
            [("agent_invoked", "planner", "spec-1", "x")],
        )
        snap = build_timeline(tmp_path, "spec-1")
        encoded = json.dumps(snap.to_dict())
        decoded = json.loads(encoded)
        assert decoded["correlation_id"] == "spec-1"
        assert decoded["entry_count"] == 1
        assert "phase_counts" in decoded


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
