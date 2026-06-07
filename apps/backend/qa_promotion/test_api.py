"""HTTP tests for the QA auto-promotion endpoints."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from qa_promotion import AUTO_PROMOTE_ENV_VAR
from qa_promotion.api import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed_approved(spec_dir: Path) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(
            {
                "feature": "demo",
                "phases": [],
                "qa_signoff": {"status": "approved", "qa_session": 1},
            }
        ),
        encoding="utf-8",
    )


class TestScoreEndpoint:
    def test_returns_score_for_approved_spec(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _seed_approved(tmp_path)
        resp = client.get("/api/qa-promotion/score", params={"spec_dir": str(tmp_path)})
        body = resp.json()
        assert body["success"] is True
        assert body["score"] == 90
        assert "breakdown" in body

    def test_invalid_dir(self, client: TestClient) -> None:
        resp = client.get("/api/qa-promotion/score", params={"spec_dir": "/nope"})
        body = resp.json()
        assert body["success"] is False


class TestDecideEndpoint:
    def test_promotes_above_threshold(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv(AUTO_PROMOTE_ENV_VAR, "85")
        _seed_approved(tmp_path)
        resp = client.post("/api/qa-promotion/decide", json={"spec_dir": str(tmp_path)})
        body = resp.json()
        assert body["success"] is True
        assert body["decision"]["promote"] is True
        assert body["decision"]["score"] == 90

    def test_no_threshold_does_not_promote(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv(AUTO_PROMOTE_ENV_VAR, raising=False)
        _seed_approved(tmp_path)
        resp = client.post("/api/qa-promotion/decide", json={"spec_dir": str(tmp_path)})
        body = resp.json()
        assert body["decision"]["promote"] is False
        assert body["decision"]["threshold"] is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
