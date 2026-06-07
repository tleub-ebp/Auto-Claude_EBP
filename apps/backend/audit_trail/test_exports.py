"""Tests for SOC2 CSV + GDPR DSAR exports."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest
from audit_trail import (
    AuditTrail,
    build_dsar_bundle,
    export_gdpr_dsar,
    export_soc2_csv,
    render_soc2_csv,
)
from audit_trail.exports import SOC2_COLUMNS


def _seed_trail(tmp_path: Path) -> AuditTrail:
    trail = AuditTrail(storage_dir=tmp_path, name="t1")
    trail.append(
        kind="agent_invoked",
        actor="planner",
        correlation_id="spec-1",
        summary="planner started",
        payload={"model": "opus"},
    )
    trail.append(
        kind="agent_invoked",
        actor="coder",
        correlation_id="spec-1",
        summary="coder started",
        payload={"model": "opus", "iter": 1},
    )
    trail.append(
        kind="agent_completed",
        actor="coder",
        correlation_id="spec-2",
        summary="coder finished other spec",
        payload={},
    )
    return trail


# ---------------------------------------------------------------------------
# SOC2 CSV


class TestRenderSoc2Csv:
    def test_columns_in_stable_order(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out = render_soc2_csv(trail.all())
        # First line is the header — must match SOC2_COLUMNS exactly.
        header = out.splitlines()[0]
        assert header == ",".join(SOC2_COLUMNS)

    def test_one_row_per_event(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out = render_soc2_csv(trail.all())
        rows = list(csv.DictReader(io.StringIO(out)))
        assert len(rows) == 3

    def test_payload_serialised_as_json(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out = render_soc2_csv(trail.all())
        rows = list(csv.DictReader(io.StringIO(out)))
        # Row 0 = planner start with model=opus.
        decoded = json.loads(rows[0]["payload_json"])
        assert decoded == {"model": "opus"}

    def test_isoformat_uses_utc_z_suffix(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out = render_soc2_csv(trail.all())
        rows = list(csv.DictReader(io.StringIO(out)))
        for row in rows:
            assert row["timestamp_iso"].endswith("Z")

    def test_event_hash_is_present_for_audit(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out = render_soc2_csv(trail.all())
        rows = list(csv.DictReader(io.StringIO(out)))
        for row in rows:
            # SHA-256 hex = 64 chars.
            assert len(row["event_hash"]) == 64
            assert row["prev_hash"]  # never empty (genesis or previous hash)


class TestExportSoc2Csv:
    def test_writes_file_at_given_path(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out_file = tmp_path / "exports" / "audit.csv"
        result = export_soc2_csv(trail, out_file)
        assert result == out_file
        assert out_file.exists()
        content = out_file.read_text(encoding="utf-8")
        assert content.startswith(",".join(SOC2_COLUMNS))

    def test_since_filter_narrows_export(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        all_events = trail.all()
        # Cut between event 0 and 1.
        cutoff = all_events[1].timestamp - 0.0001
        out_file = tmp_path / "narrow.csv"
        export_soc2_csv(trail, out_file, since=cutoff)
        rows = list(csv.DictReader(io.StringIO(out_file.read_text(encoding="utf-8"))))
        # Only events ≥ cutoff: should be 2 (events 1 + 2).
        assert len(rows) == 2


# ---------------------------------------------------------------------------
# GDPR DSAR bundle


class TestBuildDsarBundle:
    def test_actor_subject_returns_only_actor_events(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        bundle = build_dsar_bundle(trail, actor="coder")
        assert bundle.subject == "coder"
        assert bundle.subject_kind == "actor"
        assert all(e["actor"] == "coder" for e in bundle.events)
        assert len(bundle.events) == 2

    def test_correlation_id_subject_returns_only_that_chain(
        self, tmp_path: Path
    ) -> None:
        trail = _seed_trail(tmp_path)
        bundle = build_dsar_bundle(trail, correlation_id="spec-1")
        assert bundle.subject_kind == "correlation_id"
        assert all(e["correlation_id"] == "spec-1" for e in bundle.events)
        # 2 events have spec-1.
        assert len(bundle.events) == 2

    def test_requires_exactly_one_subject_kind(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        with pytest.raises(ValueError, match="exactly one"):
            build_dsar_bundle(trail)
        with pytest.raises(ValueError, match="exactly one"):
            build_dsar_bundle(trail, actor="coder", correlation_id="spec-1")

    def test_integrity_block_reports_intact_chain(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        bundle = build_dsar_bundle(trail, actor="coder")
        assert bundle.integrity_intact is True
        assert bundle.integrity_reason is None

    def test_integrity_block_reports_tampered_chain(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        # Tamper directly on disk.
        lines = trail.path.read_text(encoding="utf-8").splitlines()
        evil = json.loads(lines[1])
        evil["summary"] = "I changed my mind"
        lines[1] = json.dumps(evil, separators=(",", ":"))
        trail.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        # Reload and bundle.
        trail2 = AuditTrail(storage_dir=tmp_path, name="t1")
        bundle = build_dsar_bundle(trail2, actor="coder")
        assert bundle.integrity_intact is False
        assert "hash mismatch" in (bundle.integrity_reason or "")

    def test_to_dict_serialises_to_json(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        bundle = build_dsar_bundle(trail, actor="coder")
        # Must round-trip through json.dumps without error.
        s = json.dumps(bundle.to_dict())
        decoded = json.loads(s)
        assert decoded["subject"] == "coder"
        assert decoded["event_count"] == 2
        assert decoded["integrity"]["intact"] is True

    def test_unknown_subject_returns_empty_bundle(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        bundle = build_dsar_bundle(trail, actor="ghost-actor")
        assert bundle.events == []
        assert bundle.integrity_intact is True


class TestExportGdprDsar:
    def test_writes_json_file(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out_file = tmp_path / "exports" / "dsar.json"
        result = export_gdpr_dsar(trail, out_file, actor="coder")
        assert result == out_file
        loaded = json.loads(out_file.read_text(encoding="utf-8"))
        assert loaded["subject"] == "coder"
        assert loaded["subject_kind"] == "actor"
        assert loaded["event_count"] == 2

    def test_preserves_payload_in_export(self, tmp_path: Path) -> None:
        trail = _seed_trail(tmp_path)
        out_file = tmp_path / "dsar.json"
        export_gdpr_dsar(trail, out_file, correlation_id="spec-1")
        loaded = json.loads(out_file.read_text(encoding="utf-8"))
        # Both events on spec-1 must be in the export with their payloads.
        models = [e["payload"].get("model") for e in loaded["events"]]
        assert "opus" in models


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
