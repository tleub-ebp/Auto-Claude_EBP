"""HTTP tests for the timeline endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from audit_trail import AuditTrail
from fastapi import FastAPI
from fastapi.testclient import TestClient
from timeline.api import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed(project_dir: Path) -> None:
    storage = project_dir / ".workpilot" / "audit-trail"
    storage.mkdir(parents=True, exist_ok=True)
    trail = AuditTrail(storage_dir=storage, name="default")
    trail.append(
        kind="agent_invoked",
        actor="planner",
        correlation_id="spec-1",
        summary="planner started",
    )
    trail.append(
        kind="agent_completed",
        actor="planner",
        correlation_id="spec-1",
        summary="planner done",
    )


class TestTimelineEndpoint:
    def test_returns_timeline_for_known_spec(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed(tmp_path)
        resp = client.get(
            "/api/timeline/spec-1",
            params={"project_dir": str(tmp_path)},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["timeline"]["entry_count"] == 2

    def test_invalid_project_dir(self, client: TestClient) -> None:
        resp = client.get(
            "/api/timeline/spec-1",
            params={"project_dir": "/does/not/exist/anywhere"},
        )
        body = resp.json()
        assert body["success"] is False

    def test_unknown_spec_returns_empty_timeline(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed(tmp_path)
        resp = client.get(
            "/api/timeline/ghost-spec",
            params={"project_dir": str(tmp_path)},
        )
        body = resp.json()
        assert body["success"] is True
        assert body["timeline"]["entry_count"] == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
