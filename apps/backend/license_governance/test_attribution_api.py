"""HTTP test for the /attribution endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from license_governance import ATTRIBUTION_FILENAME
from license_governance.api import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed_npm_project(root: Path) -> None:
    (root / "package.json").write_text(
        '{"name":"demo","version":"0.0.1",'
        '"dependencies":{"react":"^18.0.0","leftpad":"^1.0.0"},'
        '"license":"MIT"}',
        encoding="utf-8",
    )


class TestAttributionEndpoint:
    def test_inline_render(self, client: TestClient, tmp_path: Path) -> None:
        _seed_npm_project(tmp_path)
        resp = client.post(
            "/api/license-governance/attribution",
            json={
                "project_path": str(tmp_path),
                "project_name": "demo-app",
                "license_overrides": [
                    {"name": "react", "license": "MIT"},
                    {"name": "leftpad", "license": "MIT"},
                ],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "demo-app" in body["attribution_md"]
        assert "react" in body["attribution_md"]
        assert body["dependency_count"] >= 2
        # Inline mode = nothing written to disk.
        assert not (tmp_path / ATTRIBUTION_FILENAME).exists()
        assert "written_to" not in body

    def test_write_to_disk(self, client: TestClient, tmp_path: Path) -> None:
        _seed_npm_project(tmp_path)
        resp = client.post(
            "/api/license-governance/attribution",
            json={
                "project_path": str(tmp_path),
                "license_overrides": [{"name": "react", "license": "MIT"}],
                "write_to_disk": True,
            },
        )
        body = resp.json()
        assert body["success"] is True
        target = tmp_path / ATTRIBUTION_FILENAME
        assert body["written_to"] == str(target)
        assert target.exists()
        assert "react" in target.read_text(encoding="utf-8")

    def test_invalid_project_path_returns_error(self, client: TestClient) -> None:
        resp = client.post(
            "/api/license-governance/attribution",
            json={"project_path": "/does/not/exist/anywhere"},
        )
        body = resp.json()
        assert body["success"] is False
        assert "project_path" in body["error"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
