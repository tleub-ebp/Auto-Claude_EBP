"""HTTP tests for the progress indicator endpoint."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from progress_indicator.api import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestIndicatorEndpoint:
    def test_returns_indicator_for_minimal_spec(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # Empty spec dir = idle / pre-build, but the endpoint must succeed.
        resp = client.get(
            "/api/progress-indicator/", params={"spec_dir": str(tmp_path)}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["indicator"]["phase"] == "idle"

    def test_invalid_spec_dir(self, client: TestClient) -> None:
        resp = client.get(
            "/api/progress-indicator/", params={"spec_dir": "/does/not/exist"}
        )
        body = resp.json()
        assert body["success"] is False

    def test_renders_coding_label(self, client: TestClient, tmp_path: Path) -> None:
        plan = {
            "feature": "demo",
            "phases": [
                {
                    "name": "p1",
                    "subtasks": [
                        {"id": "a", "status": "completed"},
                        {"id": "b", "status": "pending"},
                        {"id": "c", "status": "pending"},
                    ],
                }
            ],
        }
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
        logs = {
            "spec_id": tmp_path.name,
            "updated_at": "2026-04-30T10:00:00+00:00",
            "phases": {
                "planning": {"status": "completed", "entries": []},
                "coding": {
                    "status": "active",
                    "entries": [
                        {
                            "timestamp": "2026-04-30T10:00:00+00:00",
                            "type": "info",
                            "content": "x",
                            "phase": "coding",
                            "subtask_id": "b",
                            "session": 1,
                        }
                    ],
                },
                "validation": {"status": "pending", "entries": []},
            },
        }
        (tmp_path / "task_logs.json").write_text(json.dumps(logs), encoding="utf-8")
        resp = client.get(
            "/api/progress-indicator/", params={"spec_dir": str(tmp_path)}
        )
        body = resp.json()
        assert body["indicator"]["phase"] == "coding"
        assert "Coding subtask 2/3" in body["indicator"]["label"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
