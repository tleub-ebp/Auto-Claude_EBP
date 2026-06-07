"""HTTP tests for the SOC2 + GDPR export endpoints."""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest
from audit_trail.api import _trails, router
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_trail_registry() -> None:
    # The api module caches AuditTrail instances by (storage_dir, name).
    # Reset between tests so each fixture sees a clean slate.
    _trails.clear()
    yield
    _trails.clear()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed_via_api(client: TestClient, storage_dir: Path) -> None:
    # Two events on spec-1 (different actors) + one on spec-2.
    events = [
        ("agent_invoked", "planner", "spec-1", "planner started"),
        ("agent_invoked", "coder", "spec-1", "coder started"),
        ("agent_completed", "coder", "spec-2", "coder finished other spec"),
    ]
    for kind, actor, cid, summary in events:
        resp = client.post(
            "/api/audit-trail/append",
            json={
                "storage_dir": str(storage_dir),
                "trail_name": "default",
                "kind": kind,
                "actor": actor,
                "correlation_id": cid,
                "summary": summary,
            },
        )
        assert resp.json()["success"]


# ---------------------------------------------------------------------------
# /export/soc2


class TestExportSoc2:
    def test_returns_csv_with_header(self, client: TestClient, tmp_path: Path) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/soc2",
            params={"storage_dir": str(tmp_path)},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert "attachment" in resp.headers.get("content-disposition", "")
        rows = list(csv.DictReader(io.StringIO(resp.text)))
        assert len(rows) == 3

    def test_since_filter_narrows_response(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed_via_api(client, tmp_path)
        # Pull all events first to find a cutoff.
        all_resp = client.get(
            "/api/audit-trail/events", params={"storage_dir": str(tmp_path)}
        )
        all_events = all_resp.json()["events"]
        cutoff = float(all_events[1]["timestamp"]) - 0.0001
        resp = client.get(
            "/api/audit-trail/export/soc2",
            params={"storage_dir": str(tmp_path), "since": cutoff},
        )
        rows = list(csv.DictReader(io.StringIO(resp.text)))
        assert len(rows) == 2


# ---------------------------------------------------------------------------
# /export/gdpr


class TestExportGdpr:
    def test_actor_subject(self, client: TestClient, tmp_path: Path) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/gdpr",
            params={"storage_dir": str(tmp_path), "actor": "coder"},
        )
        body = resp.json()
        assert body["success"] is True
        assert body["bundle"]["subject"] == "coder"
        assert body["bundle"]["subject_kind"] == "actor"
        assert body["bundle"]["event_count"] == 2

    def test_correlation_id_subject(self, client: TestClient, tmp_path: Path) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/gdpr",
            params={
                "storage_dir": str(tmp_path),
                "correlation_id": "spec-1",
            },
        )
        body = resp.json()
        assert body["success"] is True
        assert body["bundle"]["subject"] == "spec-1"
        assert body["bundle"]["subject_kind"] == "correlation_id"
        assert body["bundle"]["event_count"] == 2

    def test_missing_subject_returns_error(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/gdpr",
            params={"storage_dir": str(tmp_path)},
        )
        body = resp.json()
        assert body["success"] is False
        assert "exactly one" in body["error"]

    def test_both_subjects_returns_error(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/gdpr",
            params={
                "storage_dir": str(tmp_path),
                "actor": "coder",
                "correlation_id": "spec-1",
            },
        )
        body = resp.json()
        assert body["success"] is False

    def test_integrity_block_present(self, client: TestClient, tmp_path: Path) -> None:
        _seed_via_api(client, tmp_path)
        resp = client.get(
            "/api/audit-trail/export/gdpr",
            params={"storage_dir": str(tmp_path), "actor": "coder"},
        )
        body = resp.json()
        assert body["bundle"]["integrity"]["intact"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
