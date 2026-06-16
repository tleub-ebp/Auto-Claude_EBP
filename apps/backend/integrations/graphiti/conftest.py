"""
conftest.py for integrations/graphiti tests.
These tests require external services (Ollama, LadybugDB) that are not
available in the standard test environment. All tests are skipped.
"""

import pytest


@pytest.fixture(autouse=True)
def skip_external_service_tests(request):
    """Skip tests in this directory that require live Ollama and LadybugDB.

    Tests whose function carries a ``stubbed_e2e`` attribute run against a
    stub Ollama server and the embedded LadybugDB, so they are CI-safe and
    must not be skipped here.
    """
    test_fn = getattr(request, "function", None)
    if getattr(test_fn, "stubbed_e2e", False):
        return
    pytest.skip("requires external services: Ollama/LadybugDB")


# Fixtures to prevent collection errors from non-standard test signatures
@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path)


@pytest.fixture
def database():
    return "test_db"


@pytest.fixture
def test_db_path(tmp_path):
    return tmp_path
