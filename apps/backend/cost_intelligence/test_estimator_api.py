"""HTTP tests for the cost estimator endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from cost_intelligence.api import router
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestPreviewEndpoint:
    def test_returns_estimate_for_valid_spec(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        (tmp_path / "spec.md").write_text("# Spec\nDo X\nDo Y", encoding="utf-8")
        resp = client.post(
            "/api/cost-estimator/preview",
            json={"spec_dir": str(tmp_path)},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "estimate" in body
        assert body["estimate"]["spec_id"] == tmp_path.name
        assert len(body["estimate"]["phases"]) == 3

    def test_invalid_spec_dir_returns_error(self, client: TestClient) -> None:
        resp = client.post(
            "/api/cost-estimator/preview",
            json={"spec_dir": "/does/not/exist/anywhere"},
        )
        body = resp.json()
        assert body["success"] is False
        assert "spec_dir" in body["error"]

    def test_dash_prefixed_path_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/cost-estimator/preview",
            json={"spec_dir": "-rf /"},
        )
        body = resp.json()
        assert body["success"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
