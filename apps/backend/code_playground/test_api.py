"""HTTP tests for the Code Playground endpoints."""

from __future__ import annotations

import pytest
from code_playground.api import (
    MAX_SNIPPET_BYTES,
    MAX_STDIN_BYTES,
    MAX_TIMEOUT_SECONDS,
    router,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /languages


class TestListLanguages:
    def test_returns_python_at_least(self, client: TestClient) -> None:
        resp = client.get("/api/code-playground/languages")
        assert resp.status_code == 200
        body = resp.json()
        assert "languages" in body
        assert "python" in body["languages"]


# ---------------------------------------------------------------------------
# POST /run — happy paths


class TestRunHappyPath:
    def test_python_print(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={"snippet": "print('http hello')", "language": "python"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["succeeded"] is True
        assert body["exit_code"] == 0
        assert "http hello" in body["stdout"]

    def test_stdin_forwarded(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={
                "snippet": "import sys\nprint(sys.stdin.read().strip().upper())",
                "language": "python",
                "stdin": "shouted",
            },
        )
        body = resp.json()
        assert body["success"] is True
        assert "SHOUTED" in body["stdout"]

    def test_nonzero_exit_is_not_an_http_error(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={
                "snippet": "import sys; sys.exit(3)",
                "language": "python",
            },
        )
        # HTTP 200 — the snippet ran, it just exited non-zero.
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["succeeded"] is False
        assert body["exit_code"] == 3


# ---------------------------------------------------------------------------
# POST /run — input validation


class TestInputValidation:
    def test_unknown_language_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={"snippet": "print(1)", "language": "haskell"},
        )
        # 200 with success=False — keeps clients on a single path.
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is False
        assert "haskell" in body["error"]

    def test_oversized_snippet_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={"snippet": "x" * (MAX_SNIPPET_BYTES + 1), "language": "python"},
        )
        body = resp.json()
        assert body["success"] is False
        assert "snippet" in body["error"]

    def test_oversized_stdin_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={
                "snippet": "print(1)",
                "language": "python",
                "stdin": "x" * (MAX_STDIN_BYTES + 1),
            },
        )
        body = resp.json()
        assert body["success"] is False
        assert "stdin" in body["error"]

    def test_timeout_above_cap_rejected_by_pydantic(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={
                "snippet": "print(1)",
                "language": "python",
                "timeout_seconds": MAX_TIMEOUT_SECONDS + 1,
            },
        )
        # Pydantic field validator → 422.
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# POST /run — timeout path


class TestTimeoutPath:
    def test_timeout_returns_success_false_with_flag(self, client: TestClient) -> None:
        resp = client.post(
            "/api/code-playground/run",
            json={
                "snippet": "import time; time.sleep(5)",
                "language": "python",
                "timeout_seconds": 0.5,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is False
        assert body.get("timed_out") is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
