"""HTTP tests for the restart planner endpoints."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from restart_planner.api import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed(tmp_path: Path) -> Path:
    spec_dir = tmp_path / "spec-1"
    spec_dir.mkdir()
    plan = {
        "feature": "demo",
        "phases": [
            {
                "name": "p1",
                "subtasks": [
                    {"id": "a", "status": "completed"},
                    {"id": "b", "status": "pending"},
                ],
            }
        ],
    }
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    return spec_dir


class TestPlanEndpoint:
    def test_returns_plan_for_valid_spec(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        spec = _seed(tmp_path)
        resp = client.get("/api/restart/plan", params={"spec_dir": str(spec)})
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        plan_dict = body["plan"]
        assert plan_dict["can_restart_qa"] is True
        assert plan_dict["can_restart_coder"] is True
        assert plan_dict["next_subtask_for_coder"] == "b"

    def test_invalid_spec_dir_returns_error(self, client: TestClient) -> None:
        resp = client.get("/api/restart/plan", params={"spec_dir": "/does/not/exist"})
        body = resp.json()
        assert body["success"] is False


class TestPrepareEndpoint:
    def test_qa_cleanup_via_endpoint(self, client: TestClient, tmp_path: Path) -> None:
        spec = _seed(tmp_path)
        (spec / "qa_report.md").write_text("x", encoding="utf-8")
        resp = client.post(
            "/api/restart/prepare",
            json={"spec_dir": str(spec), "mode": "qa"},
        )
        body = resp.json()
        assert body["success"] is True
        assert "qa_report.md" in body["deleted"]
        assert not (spec / "qa_report.md").exists()

    def test_unknown_mode_returns_error(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        spec = _seed(tmp_path)
        resp = client.post(
            "/api/restart/prepare",
            json={"spec_dir": str(spec), "mode": "wrong"},
        )
        body = resp.json()
        assert body["success"] is False
        assert "unknown restart mode" in body["error"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
