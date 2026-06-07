"""Shared pytest fixtures and collection-time MagicMock cleanup.

Provides:
1. A ``pytest_collectstart`` hook that removes MagicMock entries from
   ``sys.modules`` before each test module is collected.  Several test
   files set ``sys.modules["core"] = MagicMock()`` (and similar) at
   module level so they can import backend code without all transitive
   dependencies.  This pollutes the module cache and causes *other*
   test files to fail with "'core' is not a package" errors.

   Some connector test files also replace ``sys.modules["src.connectors"]``
   with a plain ``type('Package', (), {})()`` object (not a MagicMock).
   These fake entries are cleaned up the same way.

2. Reusable fixtures for creating mock Azure DevOps API clients,
   sample API response objects, and pre-configured connector instances.
"""

import importlib
import sys
import types as _types
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# Constants for git initialization
INITIAL_BRANCH_MAIN = "--initial-branch=main"
GIT_CONFIG_USER_EMAIL = "user.email"
GIT_CONFIG_USER_NAME = "user.name"
INITIAL_COMMIT_MESSAGE = "Initial commit"

# Add the project root to the Python path
_PROJECT_ROOT = str(Path(__file__).parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# Add the backend root to sys.path so that `core`, `review`, etc. can be
# imported directly (without the `apps.backend.` prefix).
# Insert at position 1 (not 0) so that project-root "src.*" imports keep
# precedence — azure_devops tests rely on ``from src.config.settings import Settings``.
_BACKEND_ROOT = str(Path(__file__).parent.parent / "apps" / "backend")
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(1, _BACKEND_ROOT)

# ---------------------------------------------------------------------------
# Save real module objects BEFORE any test-file collection can pollute them.
#
# Several test files (test_spec_phases.py, test_qa_loop.py, …) inject
# ``sys.modules["core.platform"] = MagicMock()`` at *module level* during
# collection.  That replaces M1 (the real module) in the cache.  Later, when
# an unrelated test uses ``@patch("core.platform.is_windows", …)``, mock.patch
# looks up ``sys.modules["core.platform"]`` and gets a *new* module M2 (after
# our cleanup deleted the MagicMock), so the patch is applied to M2 — but the
# already-imported function objects (e.g. ``get_path_delimiter``) still hold
# a reference to M1's ``__dict__``.  Patching M2 has no effect on M1.
#
# The fix: save M1 right now (before any collection happens) and RESTORE it
# in the cleanup hook instead of deleting it.  That way sys.modules always
# points to M1, and @patch always patches the object the functions reference.
# ---------------------------------------------------------------------------
_MODULES_TO_PRESERVE = [
    "core",
    "core.agent_client",
    "core.platform",
    "core.auth",
    "review",
    "review.state",
]
_real_modules: dict[str, _types.ModuleType] = {}
for _mod_name in _MODULES_TO_PRESERVE:
    try:
        _real_modules[_mod_name] = importlib.import_module(_mod_name)
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Backend packages that are frequently polluted by MagicMock in test files.
# Before each test file is collected we remove any MagicMock entries so
# Python's import machinery can resolve real sub-modules.
# NOTE: Commented out apps/backend path addition as it interferes with connector tests
# _BACKEND = str(Path(__file__).parent.parent / "apps" / "backend")
# if _BACKEND not in sys.path:
#     sys.path.insert(0, _BACKEND)

# Packages that get polluted by test files setting sys.modules[name] = MagicMock().
# This list must cover EVERY top-level package name that any test file mocks via
# sys.modules so the cleanup hook can restore real imports between test files.
_PROTECTED_PACKAGES = [
    # Core infrastructure
    "core",
    "client",
    "init",
    "debug",
    # SDKs
    "claude_code_sdk",
    "claude_agent_sdk",
    # Agents & tools
    "agents",
    "runners",
    "context",
    # Spec system
    "spec",
    "validate_spec",
    "implementation_plan",
    # Security
    "security",
    # Prompts
    "prompts",
    "prompts_pkg",
    "prompt_generator",
    # Config & phases
    "phase_config",
    "phase_event",
    # Logging & UI
    "task_logger",
    "progress",
    "ui",
    "linear_updater",
    # Memory & graph
    "memory",
    "graphiti_config",
    "graphiti_providers",
    # Recovery & analysis
    "recovery",
    "insight_extractor",
    "review",
    "analysis",
    # QA system
    "qa",
    "qa_loop",
    # Integrations
    "integrations",
    # Utilities
    "rate_limiter",
    "file_lock",
]


# Modules that must always be evicted (even if they're real ModuleType objects)
# because they import from protected packages at module level and their bound
# names become stale after a protected package mock is cleaned up.
# For example, qa_loop.get_iteration_history was bound to mock_qa.get_iteration_history
# when qa was a MagicMock; evicting qa_loop forces a fresh re-import with real bindings.
# qa.criteria imports from `progress` which is frequently mocked; evicting it lets
# test files that mock progress get the correct is_build_complete binding.
_DEPENDENT_EVICT = {
    "qa_loop",
    "qa.criteria",
    "qa.report",
    "qa.loop",
    # models.py imports locked_json_write from file_lock; test_context_gatherer.py
    # patches file_lock.locked_json_write with a MagicMock, so models.py cached
    # with the mock binding must be evicted before test_github_pr_e2e.py runs.
    "models",
}


def _clean_mock_modules() -> None:
    """Remove fake or MagicMock entries from sys.modules for protected packages.

    This allows subsequent imports to find the real packages on disk
    instead of hitting a MagicMock or a plain ``type(...)`` fake object
    that cannot resolve sub-modules.

    Handles two kinds of pollution:
    - ``sys.modules[name] = MagicMock()`` — caught by the protected-packages list.
    - ``sys.modules["src.connectors"] = type('Package', (), {})()`` — caught by
      the non-ModuleType check for the ``src.connectors`` namespace.
    - Real modules listed in _DEPENDENT_EVICT — evicted unconditionally so they
      are re-imported fresh after their dependencies are cleaned up.
    """
    keys_to_remove = []
    for key, mod in sys.modules.items():
        # Remove MagicMocks for protected packages
        if isinstance(mod, MagicMock):
            for pkg in _PROTECTED_PACKAGES:
                if key == pkg or key.startswith(pkg + "."):
                    keys_to_remove.append(key)
                    break
        # Remove plain fake objects (not real ModuleType) under src.connectors
        elif not isinstance(mod, _types.ModuleType) and (
            key == "src.connectors" or key.startswith("src.connectors.")
        ):
            keys_to_remove.append(key)
        # Unconditionally evict dependent modules so they re-import with fresh bindings
        elif key in _DEPENDENT_EVICT:
            keys_to_remove.append(key)
    for key in keys_to_remove:
        if key in _real_modules:
            # Restore the original real module object so that @patch decorators
            # in test files always patch the same object that imported functions
            # reference (function.__globals__ points to M1's dict, not M2's).
            sys.modules[key] = _real_modules[key]
        else:
            del sys.modules[key]


def pytest_collectstart(collector) -> None:
    """Remove MagicMock pollution from sys.modules before collecting each file.

    This hook fires before each collector (test file) is imported, giving
    us a chance to clean up mocks left by previously-collected files.
    """
    _clean_mock_modules()


def pytest_runtest_setup(item) -> None:
    """Remove MagicMock pollution from sys.modules before each test runs.

    Some test files inject ``sys.modules[name] = MagicMock()`` at module
    level during *collection*.  The ``pytest_collectstart`` hook only fires
    before collection, so by the time tests *execute* those mocks are still
    present and break ``@patch`` decorators in unrelated test files (e.g.
    test_platform.py whose ``@patch("core.platform.is_windows", ...)`` ends
    up patching a MagicMock instead of the real module).

    Running the same cleanup before every test ensures that mocks injected
    during collection are evicted before any test that doesn't own them runs.
    Test files that rely on those mocks (spec_phases, qa_loop, etc.) have
    already imported their targets at module level, so this cleanup is safe.
    """
    _clean_mock_modules()


# ---------------------------------------------------------------------------
# Git repository fixture used by multiple test files
# ---------------------------------------------------------------------------

import subprocess


@pytest.fixture
def temp_git_repo(tmp_path):
    """Create a temporary directory with an initialised git repository.

    Yields the ``Path`` to the repository root.  The fixture isolates the
    git environment so that the host user's global git config does not
    interfere with tests (e.g. hooks, signing, templates).
    """
    repo = tmp_path / "repo"
    repo.mkdir()

    env = {
        "GIT_CONFIG_NOSYSTEM": "1",
        "HOME": str(tmp_path),
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": TEST_EMAIL,
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": TEST_EMAIL,
    }

    subprocess.run(
        ["git", "init", INITIAL_BRANCH_MAIN],
        cwd=repo,
        env={**subprocess.os.environ, **env},
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_EMAIL, TEST_EMAIL],
        cwd=repo,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_NAME, "Test"],
        cwd=repo,
        capture_output=True,
        check=True,
    )

    # Create an initial commit so HEAD exists
    readme = repo / "README.md"
    readme.write_text("# Test repo\n")
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", INITIAL_COMMIT_MESSAGE],
        cwd=repo,
        env={**subprocess.os.environ, **env},
        capture_output=True,
        check=True,
    )

    yield repo


# ---------------------------------------------------------------------------
# Azure DevOps connector imports and fixtures
# ---------------------------------------------------------------------------

try:
    from src.config.settings import Settings
    from src.connectors.azure_devops.client import AzureDevOpsClient
    from src.connectors.azure_devops.repos import AzureReposClient
    from src.connectors.azure_devops.work_items import AzureWorkItemsClient
    AZURE_DEVOPS_FIXTURES_AVAILABLE = True
except ImportError:
    Settings = None  # type: ignore[assignment,misc]
    AzureDevOpsClient = None  # type: ignore[assignment,misc]
    AzureReposClient = None  # type: ignore[assignment,misc]
    AzureWorkItemsClient = None  # type: ignore[assignment,misc]
    AZURE_DEVOPS_FIXTURES_AVAILABLE = False

# ── Constants for test data ──────────────────────────────────────────

TEST_PAT = "test-pat-token-value"
TEST_ORG_URL = "https://dev.azure.com/test-organization"
TEST_PROJECT = "TestProject"
TEST_REPO_ID = "abc12345-def6-7890-abcd-ef1234567890"
TEST_REPO_NAME = "test-repository"
TEST_EMAIL = "test@test.com"


# ── Settings fixtures ───────────────────────────────────────────────


@pytest.fixture
def sample_settings():
    """Create a Settings instance with valid test credentials."""
    return Settings(
        pat=TEST_PAT,
        organization_url=TEST_ORG_URL,
        project=TEST_PROJECT,
    )


@pytest.fixture
def settings_no_project():
    """Create a Settings instance without a default project."""
    return Settings(
        pat=TEST_PAT,
        organization_url=TEST_ORG_URL,
        project=None,
    )


# ── Mock API client fixtures ────────────────────────────────────────


@pytest.fixture
def mock_git_client():
    """Create a mock Azure DevOps Git API client.

    Returns a MagicMock with the same interface as the Azure DevOps
    GitClient, suitable for stubbing repository operation calls.
    """
    client = MagicMock()
    client.get_repositories = MagicMock(return_value=[])
    client.get_repository = MagicMock(return_value=None)
    client.get_items = MagicMock(return_value=[])
    client.get_item = MagicMock(return_value=None)
    return client


@pytest.fixture
def mock_wit_client():
    """Create a mock Azure DevOps Work Item Tracking API client.

    Returns a MagicMock with the same interface as the Azure DevOps
    WorkItemTrackingClient, suitable for stubbing work item calls.
    """
    client = MagicMock()
    client.query_by_wiql = MagicMock(return_value=MagicMock(work_items=[]))
    client.get_work_items = MagicMock(return_value=[])
    client.get_work_item = MagicMock(return_value=None)
    return client


@pytest.fixture
def mock_connection(mock_git_client, mock_wit_client):
    """Create a mock Azure DevOps Connection object.

    The connection exposes ``clients.get_git_client()`` and
    ``clients.get_work_item_tracking_client()`` that return the
    corresponding mock API clients.
    """
    connection = MagicMock()
    connection.clients.get_git_client.return_value = mock_git_client
    connection.clients.get_work_item_tracking_client.return_value = mock_wit_client
    return connection


# ── Azure DevOps client fixtures ────────────────────────────────────


@pytest.fixture
def azure_client(sample_settings, mock_connection):
    """Create an AzureDevOpsClient with a mocked connection.

    The client is configured with valid test settings and a mock
    connection is injected so that ``get_git_client()`` and
    ``get_wit_client()`` return controlled mock objects.
    """
    client = AzureDevOpsClient(sample_settings)
    client._connection = mock_connection
    return client


# ── Repos and Work Items client fixtures ────────────────────────────


@pytest.fixture
def repos_client(azure_client):
    """Create an AzureReposClient with a mocked underlying client."""
    return AzureReposClient(azure_client)


@pytest.fixture
def work_items_client(azure_client):
    """Create an AzureWorkItemsClient with a mocked underlying client."""
    return AzureWorkItemsClient(azure_client)


# ── Sample API response fixtures ────────────────────────────────────


@pytest.fixture
def sample_api_repo():
    """Create a mock Azure DevOps Git repository API response.

    Mimics the structure returned by ``git_client.get_repositories()``
    and ``git_client.get_repository()``.
    """
    repo = SimpleNamespace(
        id=TEST_REPO_ID,
        name=TEST_REPO_NAME,
        project=SimpleNamespace(name=TEST_PROJECT),
        default_branch="refs/heads/main",
        remote_url=f"{TEST_ORG_URL}/{TEST_PROJECT}/_git/{TEST_REPO_NAME}",
    )
    return repo


@pytest.fixture
def sample_api_repo_list(sample_api_repo):
    """Create a list of mock repository API responses.

    Returns a list with two repositories for testing list operations.
    """
    second_repo = SimpleNamespace(
        id="second-repo-id-0000-0000-000000000000",
        name="second-repository",
        project=SimpleNamespace(name=TEST_PROJECT),
        default_branch="refs/heads/develop",
        remote_url=f"{TEST_ORG_URL}/{TEST_PROJECT}/_git/second-repository",
    )
    return [sample_api_repo, second_repo]


@pytest.fixture
def sample_api_work_item():
    """Create a mock Azure DevOps work item API response.

    Mimics the structure returned by ``wit_client.get_work_item()``
    and ``wit_client.get_work_items()``. Includes all commonly used
    System.* and Microsoft.VSTS.* fields.
    """
    work_item = SimpleNamespace(
        id=42,
        fields={
            "System.Title": "Fix login page timeout",
            "System.State": "Active",
            "System.WorkItemType": "Bug",
            "System.AssignedTo": {"displayName": "John Doe"},
            "System.Description": "<p>Login page times out after 30s.</p>",
            "System.Tags": "frontend;urgent",
            "System.CreatedDate": datetime(2025, 1, 15, 10, 30, 0),
            "System.AreaPath": f"{TEST_PROJECT}\\Web",
            "System.IterationPath": f"{TEST_PROJECT}\\Sprint 5",
            "Microsoft.VSTS.Common.Priority": 1,
        },
        url=(f"{TEST_ORG_URL}/{TEST_PROJECT}/_apis/wit/workItems/42"),
    )
    return work_item


@pytest.fixture
def sample_api_work_item_minimal():
    """Create a work item API response with minimal fields.

    Tests graceful handling of missing optional fields such as
    AssignedTo, Tags, and Priority.
    """
    work_item = SimpleNamespace(
        id=99,
        fields={
            "System.Title": "Minimal work item",
            "System.State": "New",
            "System.WorkItemType": "Task",
        },
        url=None,
    )
    return work_item


@pytest.fixture
def sample_api_work_item_string_assigned():
    """Create a work item with AssignedTo as a plain string.

    Some Azure DevOps configurations return AssignedTo as a string
    rather than an identity object dictionary.
    """
    work_item = SimpleNamespace(
        id=55,
        fields={
            "System.Title": "Task with string assignee",
            "System.State": "Active",
            "System.WorkItemType": "User Story",
            "System.AssignedTo": "Jane Smith",
        },
        url=None,
    )
    return work_item


@pytest.fixture
def sample_wiql_result():
    """Create a mock WIQL query result with work item ID references.

    Mimics the structure returned by ``wit_client.query_by_wiql()``,
    which contains only work item IDs (not full details).
    """
    result = SimpleNamespace(
        work_items=[
            SimpleNamespace(id=42),
            SimpleNamespace(id=55),
            SimpleNamespace(id=99),
        ],
    )
    return result


@pytest.fixture
def sample_wiql_result_empty():
    """Create a mock WIQL query result with no matches."""
    return SimpleNamespace(work_items=[])


@pytest.fixture
def sample_api_file_item_blob():
    """Create a mock file item API response for a regular file (blob)."""
    item = SimpleNamespace(
        path="/src/main.py",
        git_object_type="blob",
        object_id="abc123def456",
        commit_id="commit789",
        url=f"{TEST_ORG_URL}/_apis/git/repositories/{TEST_REPO_ID}/items/src/main.py",
        size=1024,
    )
    return item


@pytest.fixture
def sample_api_file_item_tree():
    """Create a mock file item API response for a directory (tree)."""
    item = SimpleNamespace(
        path="/src",
        git_object_type="tree",
        object_id="tree123def456",
        commit_id="commit789",
        url=f"{TEST_ORG_URL}/_apis/git/repositories/{TEST_REPO_ID}/items/src",
        size=None,
    )
    return item


@pytest.fixture
def sample_api_file_list(sample_api_file_item_tree, sample_api_file_item_blob):
    """Create a list of file items mimicking a directory listing.

    Includes the scope path entry (directory itself) plus child items,
    matching the real Azure DevOps API behavior where the first item
    returned is the queried directory itself.
    """
    root_entry = SimpleNamespace(
        path="/",
        git_object_type="tree",
        object_id="root000",
        commit_id="commit789",
        url=f"{TEST_ORG_URL}/_apis/git/repositories/{TEST_REPO_ID}/items/",
        size=None,
    )
    return [root_entry, sample_api_file_item_tree, sample_api_file_item_blob]


@pytest.fixture
def sample_api_file_content():
    """Create a mock file item API response with content included.

    Mimics the response from ``git_client.get_item()`` when called
    with ``include_content=True``.
    """
    item = SimpleNamespace(
        path="/README.md",
        git_object_type="blob",
        object_id="readme123",
        commit_id="commit456",
        url=f"{TEST_ORG_URL}/_apis/git/repositories/{TEST_REPO_ID}/items/README.md",
        size=42,
        content="# Test Repository\n\nThis is a test README file.\n",
    )
    return item


# ============================================================================
# pytest-asyncio configuration for async tests
# ============================================================================

# ── Directory fixtures for spec tests ────────────────────────────────


@pytest.fixture
def temp_dir(tmp_path):
    """Create a temporary directory for testing."""
    return tmp_path


@pytest.fixture
def spec_dir(tmp_path):
    """Create a temporary spec directory for testing."""
    spec_path = tmp_path / "specs"
    spec_path.mkdir(exist_ok=True)
    return spec_path


@pytest.fixture
def mock_run_agent_fn():
    """Mock run_agent function."""
    from unittest.mock import AsyncMock

    def _create_mock(success=True, output="Success"):
        mock = AsyncMock(return_value=(success, output))
        return mock

    return _create_mock


@pytest.fixture
def mock_task_logger():
    """Mock task logger."""
    from unittest.mock import MagicMock
    return MagicMock()


@pytest.fixture
def mock_ui_module():
    """Mock UI module."""
    from unittest.mock import MagicMock
    return MagicMock()


@pytest.fixture
def mock_spec_validator():
    """Mock spec validator."""
    from unittest.mock import MagicMock
    
    def _create_mock(spec_valid=True, plan_valid=True, context_valid=True, all_valid=True):
        mock = MagicMock()
        
        # Create mock validation results
        class MockValidationResult:
            def __init__(self, valid, checkpoint, errors=None, fixes=None):
                self.valid = valid
                self.checkpoint = checkpoint
                self.errors = errors or []
                self.fixes = fixes or []
        
        # Mock validate_all method
        def validate_all():
            results = []
            # Use the individual valid flags, not the all_valid flag
            results.append(MockValidationResult(spec_valid, "spec"))
            results.append(MockValidationResult(plan_valid, "plan"))
            results.append(MockValidationResult(context_valid, "context"))
            return results
        
        mock.validate_all = validate_all
        mock.validate_all.return_value = validate_all()
        
        return mock
    
    return _create_mock

# Import asyncio event loop plugin
pytest_plugins = ('pytest_asyncio',)

# Configure asyncio mode for pytest
def pytest_configure(config):
    """Configure pytest-asyncio and register markers"""
    config.option.asyncio_mode = "auto"
    # Register markers to avoid PytestUnknownMarkWarning
    config.addinivalue_line("markers", "unit: Unit tests")
    config.addinivalue_line("markers", "integration: Integration tests")
    config.addinivalue_line("markers", "e2e: End-to-end tests")
    config.addinivalue_line("markers", "streaming: Streaming-specific tests")
    config.addinivalue_line("markers", "performance: Performance tests")


# ---------------------------------------------------------------------------
# Merge system fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def semantic_analyzer():
    """Create a SemanticAnalyzer instance for testing."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.semantic_analyzer import SemanticAnalyzer
    return SemanticAnalyzer()


@pytest.fixture
def temp_project(tmp_path):
    """Create a temporary project directory with a git repo and sample files.

    Sets up:
    - git repository with an initial commit
    - src/App.tsx and src/utils.py files
    """
    import subprocess

    repo = tmp_path / "project"
    repo.mkdir()

    env = {
        "GIT_CONFIG_NOSYSTEM": "1",
        "HOME": str(tmp_path),
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": TEST_EMAIL,
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": TEST_EMAIL,
    }
    merged_env = {**subprocess.os.environ, **env}

    subprocess.run(
        ["git", "init", INITIAL_BRANCH_MAIN],
        cwd=repo,
        env=merged_env,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_EMAIL, TEST_EMAIL],
        cwd=repo,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_NAME, "Test"],
        cwd=repo,
        capture_output=True,
        check=True,
    )

    # Create src directory and sample files
    src = repo / "src"
    src.mkdir()

    (src / "App.tsx").write_text(
        "import React from 'react';\n\nfunction App() {\n  return <div>Hello</div>;\n}\n\nexport default App;\n"
    )
    (src / "utils.py").write_text(
        '"""Sample Python module."""\nimport os\nfrom pathlib import Path\n\ndef hello():\n    """Say hello."""\n    print("Hello")\n\ndef goodbye():\n    """Say goodbye."""\n    print("Goodbye")\n\nclass Greeter:\n    """A greeter class."""\n\n    def greet(self, name: str) -> str:\n        return f"Hello, {name}"\n'
    )

    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", INITIAL_COMMIT_MESSAGE],
        cwd=repo,
        env=merged_env,
        capture_output=True,
        check=True,
    )

    yield repo


@pytest.fixture
def file_tracker(temp_project):
    """Create a FileEvolutionTracker instance for testing."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.file_evolution import FileEvolutionTracker
    return FileEvolutionTracker(project_dir=temp_project)


@pytest.fixture
def conflict_detector():
    """Create a ConflictDetector instance for testing."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.conflict_detector import ConflictDetector
    return ConflictDetector()


@pytest.fixture
def auto_merger():
    """Create an AutoMerger instance for testing."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.auto_merger import AutoMerger
    return AutoMerger()


@pytest.fixture
def ai_resolver():
    """Create an AIResolver instance without AI function (for testing fallback behaviour)."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.ai_resolver import AIResolver
    return AIResolver(ai_call_fn=None)


@pytest.fixture
def mock_ai_resolver():
    """Create an AIResolver instance with a mock AI function."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from merge.ai_resolver import AIResolver

    def _mock_ai_fn(system_prompt: str, user_prompt: str) -> str:
        # Return a simple merged code block that the resolver can parse
        return "```python\n# AI merged result\nmerged_code = True\n```"

    return AIResolver(ai_call_fn=_mock_ai_fn)


# ---------------------------------------------------------------------------
# QA loop fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def qa_signoff_approved():
    """Create an approved QA signoff dict."""
    return {
        "status": "approved",
        "qa_session": 1,
        "timestamp": "2024-01-01T12:00:00",
        "tests_passed": {
            "unit": True,
            "integration": True,
            "e2e": True,
        },
    }


@pytest.fixture
def qa_signoff_rejected():
    """Create a rejected QA signoff dict with issues."""
    return {
        "status": "rejected",
        "qa_session": 1,
        "timestamp": "2024-01-01T12:00:00",
        "issues_found": [
            {"title": "Missing unit tests", "type": "unit_test"},
            {"title": "API endpoint returns 500", "type": "bug"},
        ],
    }


@pytest.fixture
def python_project(tmp_path):
    """Create a temporary Python project directory."""
    project = tmp_path / "python_project"
    project.mkdir()
    (project / "requirements.txt").write_text("flask\nrequests\n")
    (project / "app.py").write_text("from flask import Flask\napp = Flask(__name__)\n")
    (project / "setup.py").write_text("from setuptools import setup\nsetup(name='test')\n")
    return project


@pytest.fixture
def node_project(tmp_path):
    """Create a temporary Node.js project directory."""
    import json
    project = tmp_path / "node_project"
    project.mkdir()
    pkg = {
        "name": "test-project",
        "version": "1.0.0",
        "scripts": {"start": "node index.js", "test": "jest"},
        "dependencies": {"express": "^4.18.0"},
    }
    (project / "package.json").write_text(json.dumps(pkg))
    (project / "package-lock.json").write_text("{}")
    (project / "index.js").write_text("const express = require('express');\n")
    return project


@pytest.fixture
def docker_project(tmp_path):
    """Create a temporary Docker project directory."""
    project = tmp_path / "docker_project"
    project.mkdir()
    (project / "Dockerfile").write_text("FROM python:3.11\nWORKDIR /app\n")
    (project / "docker-compose.yml").write_text(
        "version: '3'\nservices:\n  app:\n    build: .\n"
    )
    (project / "requirements.txt").write_text("flask\n")
    return project


@pytest.fixture
def stage_files(tmp_path, temp_git_repo):
    """Return a function that stages files into the temp_git_repo.

    Usage::

        def test_something(stage_files):
            stage_files({"normal.py": "x = 42\\n"})
    """

    def _stage(files: dict):
        import subprocess
        for name, content in files.items():
            file_path = temp_git_repo / name
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)
        subprocess.run(["git", "add", "."], cwd=temp_git_repo, capture_output=True, check=True)

    return _stage


# ---------------------------------------------------------------------------
# Implementation plan fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_implementation_plan():
    """Create a sample implementation plan dict for testing.

    Returns a plan with:
    - feature: "User Avatar Upload"
    - workflow_type: "feature"
    - 3 phases (backend, frontend, testing)
    - 4 subtasks total (2+1+1)
    - 3 services_involved
    """
    return {
        "feature": "User Avatar Upload",
        "workflow_type": "feature",
        "services_involved": ["backend", "frontend", "storage"],
        "phases": [
            {
                "phase": 1,
                "name": "Backend API",
                "phase_type": "backend",
                "depends_on": [],
                "subtasks": [
                    {
                        "id": "c1",
                        "description": "Create upload endpoint",
                        "status": "pending",
                        "service": "backend",
                        "files_to_modify": ["app/routes/upload.py"],
                        "files_to_create": [],
                    },
                    {
                        "id": "c2",
                        "description": "Add storage service",
                        "status": "pending",
                        "service": "backend",
                        "files_to_modify": [],
                        "files_to_create": ["app/services/storage.py"],
                    },
                ],
            },
            {
                "phase": 2,
                "name": "Frontend UI",
                "phase_type": "frontend",
                "depends_on": [1],
                "subtasks": [
                    {
                        "id": "c3",
                        "description": "Build avatar upload component",
                        "status": "pending",
                        "service": "frontend",
                        "files_to_modify": [],
                        "files_to_create": ["src/components/AvatarUpload.tsx"],
                    },
                ],
            },
            {
                "phase": 3,
                "name": "Testing",
                "phase_type": "testing",
                "depends_on": [1],
                "subtasks": [
                    {
                        "id": "c4",
                        "description": "Write unit tests for upload endpoint",
                        "status": "pending",
                        "service": "backend",
                        "files_to_modify": [],
                        "files_to_create": ["tests/test_upload.py"],
                    },
                ],
            },
        ],
    }


# ---------------------------------------------------------------------------
# GitLab/GitHub worktree fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_project_dir(tmp_path):
    """Create a temporary project directory for worktree tests."""
    import subprocess

    project = tmp_path / "project"
    project.mkdir()

    env = {
        "GIT_CONFIG_NOSYSTEM": "1",
        "HOME": str(tmp_path),
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": TEST_EMAIL,
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": TEST_EMAIL,
    }
    merged_env = {**subprocess.os.environ, **env}

    subprocess.run(
        ["git", "init", INITIAL_BRANCH_MAIN],
        cwd=project,
        env=merged_env,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_EMAIL, TEST_EMAIL],
        cwd=project,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", GIT_CONFIG_USER_NAME, "Test"],
        cwd=project,
        capture_output=True,
        check=True,
    )

    # Create initial commit
    readme = project / "README.md"
    readme.write_text("# Test Project\n")
    subprocess.run(["git", "add", "."], cwd=project, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", INITIAL_COMMIT_MESSAGE],
        cwd=project,
        env=merged_env,
        capture_output=True,
        check=True,
    )

    # Create the worktrees directory structure
    worktrees_dir = project / ".workpilot" / "worktrees" / "tasks"
    worktrees_dir.mkdir(parents=True, exist_ok=True)

    return project


@pytest.fixture
def worktree_manager(temp_project_dir):
    """Create a WorktreeManager instance for testing."""
    import sys
    from pathlib import Path as _Path
    sys.path.insert(0, str(_Path(__file__).parent.parent / "apps" / "backend"))
    from core.worktree import WorktreeManager
    return WorktreeManager(temp_project_dir, base_branch="main")
