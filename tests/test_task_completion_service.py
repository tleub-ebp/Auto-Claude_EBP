"""
Tests pour le service de complétion de tâches
"""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from services.task_completion_service import (
    TaskCompletionService,
    create_task_completion_service,
)


@pytest.fixture
def temp_project_dir():
    """Crée un répertoire de projet temporaire"""
    with tempfile.TemporaryDirectory() as tmpdir:
        project_path = Path(tmpdir)
        # Initialiser un repo git de base
        (project_path / ".git").mkdir()
        yield project_path


@pytest.fixture
def mock_worktree_manager():
    """Mock du WorktreeManager"""
    with patch("services.task_completion_service.WorktreeManager") as mock:
        yield mock


def test_create_task_completion_service(temp_project_dir):
    """Test de la factory de création du service"""
    service = create_task_completion_service(
        temp_project_dir, base_branch="main"
    )
    
    assert service is not None
    assert isinstance(service, TaskCompletionService)
    assert service.project_path == temp_project_dir
    assert service.base_branch == "main"


def test_complete_task_success(temp_project_dir, mock_worktree_manager):
    """Test de complétion réussie d'une tâche"""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance

    # No pre-existing PR -> go through the push + create path
    mock_instance.find_existing_pr_url.return_value = None
    mock_instance.push_and_create_pr.return_value = {
        "success": True,
        "pr_url": "https://github.com/owner/repo/pull/123",
        "already_exists": False,
        "branch": "auto-claude/test-spec",
    }

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
        task_description="Test description",
    )

    # Assertions
    assert result["success"] is True
    assert result["pr_url"] == "https://github.com/owner/repo/pull/123"
    assert result["pr_already_exists"] is False
    assert result["error"] is None

    # Vérifier les appels
    mock_instance.find_existing_pr_url.assert_called_once()
    mock_instance.push_and_create_pr.assert_called_once()


def test_complete_task_push_failure(temp_project_dir, mock_worktree_manager):
    """Test de complétion avec échec du push/création (erreur propagée)"""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance

    # No pre-existing PR; the push/create dispatcher fails
    mock_instance.find_existing_pr_url.return_value = None
    mock_instance.push_and_create_pr.return_value = {
        "success": False,
        "error": "Network error",
    }

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
    )

    # Assertions — the dispatcher's error is surfaced verbatim
    assert result["success"] is False
    assert result["pr_url"] is None
    assert "Network error" in result["error"]


def test_complete_task_pr_creation_failure(
    temp_project_dir, mock_worktree_manager
):
    """Test de complétion avec échec de création de PR"""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance
    
    # No pre-existing PR; PR creation fails inside the dispatcher
    mock_instance.find_existing_pr_url.return_value = None
    mock_instance.push_and_create_pr.return_value = {
        "success": False,
        "error": "Authentication failed",
    }

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
    )

    # Assertions
    assert result["success"] is False
    assert result["pr_url"] is None
    assert "Authentication failed" in result["error"]


def test_complete_task_with_custom_target_branch(
    temp_project_dir, mock_worktree_manager
):
    """Test de complétion avec branche cible personnalisée"""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance
    
    # No pre-existing PR; success via dispatcher
    mock_instance.find_existing_pr_url.return_value = None
    mock_instance.push_and_create_pr.return_value = {
        "success": True,
        "pr_url": "https://github.com/owner/repo/pull/123",
        "already_exists": False,
        "branch": "test",
    }

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task with custom target
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
        target_branch="main",
    )

    # Assertions
    assert result["success"] is True

    # Vérifier que la branche cible est bien passée au dispatcher
    call_args = mock_instance.push_and_create_pr.call_args
    assert call_args[1]["target_branch"] == "main"


def test_complete_task_pr_already_exists(
    temp_project_dir, mock_worktree_manager
):
    """PR détectée par le dispatcher pendant la création (already_exists)."""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance

    # No PR found by the pre-push lookup, but the dispatcher reports it exists
    mock_instance.find_existing_pr_url.return_value = None
    mock_instance.push_and_create_pr.return_value = {
        "success": True,
        "pr_url": "https://github.com/owner/repo/pull/123",
        "already_exists": True,
        "branch": "test",
    }

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
    )

    # Assertions
    assert result["success"] is True
    assert result["pr_already_exists"] is True
    assert result["pr_url"] == "https://github.com/owner/repo/pull/123"


def test_complete_task_skips_push_when_pr_exists(
    temp_project_dir, mock_worktree_manager
):
    """Une PR déjà ouverte est détectée AVANT le push : pas de push/création."""
    # Setup mock
    mock_instance = MagicMock()
    mock_worktree_manager.return_value = mock_instance

    # Pre-push lookup finds an existing PR (e.g. branch pushed earlier; the
    # remote push would now fail with a disabled/read-only credential).
    mock_instance.find_existing_pr_url.return_value = (
        "https://dev.azure.com/org/proj/_git/repo/pullrequest/42"
    )

    # Create service
    service = TaskCompletionService(
        project_path=temp_project_dir, base_branch="develop"
    )
    service.worktree_manager = mock_instance

    # Complete task
    result = service.complete_task(
        spec_id="test-spec",
        task_title="Test Task",
    )

    # Assertions — finalized from the existing PR, no push attempted
    assert result["success"] is True
    assert result["pr_already_exists"] is True
    assert result["pr_url"] == (
        "https://dev.azure.com/org/proj/_git/repo/pullrequest/42"
    )
    mock_instance.push_and_create_pr.assert_not_called()


def test_build_pr_body_en(monkeypatch):
    """Test PR body generation in English."""
    monkeypatch.setenv("APP_LANGUAGE", "en")
    service = TaskCompletionService(
        project_path=Path("/tmp/test"), base_branch="develop"
    )

    # With description
    body = service._build_pr_body("My Task", "This is a test task")
    assert "My Task" in body
    assert "This is a test task" in body
    assert "Review checklist" in body
    assert "human validation" in body
    assert "WorkPilot AI" in body

    # Without description → fallback text
    body_no_desc = service._build_pr_body("My Task", None)
    assert "My Task" in body_no_desc
    assert "No description provided." in body_no_desc
    assert "Review checklist" in body_no_desc


def test_build_pr_body_fr(monkeypatch):
    """Test PR body generation in French."""
    monkeypatch.setenv("APP_LANGUAGE", "fr")
    service = TaskCompletionService(
        project_path=Path("/tmp/test"), base_branch="develop"
    )

    body = service._build_pr_body("Ma Tâche", "Ceci est un test")
    assert "Ma Tâche" in body
    assert "Ceci est un test" in body
    assert "Checklist de vérification" in body
    assert "validation humaine" in body

    body_no_desc = service._build_pr_body("Ma Tâche", None)
    assert "Aucune description fournie." in body_no_desc


def test_build_pr_title(monkeypatch):
    """Test conventional-commit PR title generation."""
    monkeypatch.setenv("APP_LANGUAGE", "en")
    service = TaskCompletionService(
        project_path=Path("/tmp/test"), base_branch="develop"
    )

    # Normal title
    assert service._build_pr_title("Add login page") == "feat: add login page"
    # Title with trailing period
    assert service._build_pr_title("Fix bug.") == "feat: fix bug"
    # Already lowercase
    assert service._build_pr_title("update readme") == "feat: update readme"
    # With extra spaces
    assert service._build_pr_title("  Fix tests  ") == "feat: fix tests"

