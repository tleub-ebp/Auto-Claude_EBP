import pytest
import requests


def _server_available() -> bool:
    try:
        requests.get("http://localhost:9000/providers", timeout=1)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _server_available(),
    reason="Provider API server not running on localhost:9000",
)


def test_api_providers():
    r = requests.get("http://localhost:9000/providers", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert "providers" in data
    assert "status" in data
    assert isinstance(data["providers"], list)
    assert isinstance(data["status"], dict)

def test_api_select_provider():
    r = requests.post(
        "http://localhost:9000/providers/select?provider=openai", timeout=5
    )
    assert r.status_code == 200
    data = r.json()
    assert data["selected"] == "openai"
