"""HTTP tests for the prompt preview endpoint."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.prompt_preview_api import router
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestPreviewEndpoint:
    def test_returns_snapshot(self, client: TestClient, tmp_path: Path) -> None:
        resp = client.get(
            "/api/prompt-preview/",
            params={
                "project_dir": str(tmp_path),
                "spec_dir": str(tmp_path),
                "agent_type": "coder",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "preview" in body
        assert body["preview"]["agent_type"] == "coder"

    def test_invalid_dir_returns_error(self, client: TestClient) -> None:
        resp = client.get(
            "/api/prompt-preview/",
            params={
                "project_dir": "/does/not/exist",
                "spec_dir": "/does/not/exist",
            },
        )
        body = resp.json()
        assert body["success"] is False

    def test_domain_addendum_visible_via_endpoint(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        (tmp_path / "requirements.json").write_text(
            json.dumps({"domain": "fintech"}), encoding="utf-8"
        )
        resp = client.get(
            "/api/prompt-preview/",
            params={"project_dir": str(tmp_path), "spec_dir": str(tmp_path)},
        )
        body = resp.json()
        assert body["preview"]["domain_addendum_included"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
