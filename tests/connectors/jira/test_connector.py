"""Unit tests for JiraConnector high-level operations (Feature 4.1).

Tests the Jira connector including:
- Listing projects
- Searching and getting issues
- Creating issues
- Status transitions and bidirectional sync
- QA bug creation
- Kanban import
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# Helper function to import modules directly
def import_module_direct(module_name, file_path):
    """Import a module directly from file path, bypassing package __init__.py"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

# Import modules directly to avoid circular import issues in __init__.py
# First import exceptions and models, then connector (which depends on them)
project_root = Path(__file__).parent.parent.parent.parent

# Import exceptions first
exceptions_module = import_module_direct("jira_exceptions", project_root / "src" / "connectors" / "jira" / "exceptions.py")
models_module = import_module_direct("jira_models", project_root / "src" / "connectors" / "jira" / "models.py")
client_module = import_module_direct("jira_client", project_root / "src" / "connectors" / "jira" / "client.py")

# Make modules available in sys.modules so connector can import them
# Create a proper package structure
jira_package = type('Package', (), {
    'exceptions': exceptions_module,
    'models': models_module,
    'client': client_module
})()
sys.modules["src.connectors.jira.exceptions"] = exceptions_module
sys.modules["src.connectors.jira.models"] = models_module
sys.modules["src.connectors.jira.client"] = client_module
sys.modules["src.connectors.jira"] = jira_package
sys.modules["src.connectors"] = type('Package', (), {'jira': jira_package})()

# Now import connector
connector_module = import_module_direct("jira_connector", project_root / "src" / "connectors" / "jira" / "connector.py")

JiraConnector = connector_module.JiraConnector
JiraComment = models_module.JiraComment
JiraIssue = models_module.JiraIssue
JiraProject = models_module.JiraProject
JiraStatus = models_module.JiraStatus
JiraTransition = models_module.JiraTransition
JiraUser = models_module.JiraUser


# ── Fixtures ─────────────────────────────────────────────────────


@pytest.fixture
def mock_jira_client():
    """Create a mock JiraClient."""
    client = MagicMock()
    client.is_connected = True
    return client


@pytest.fixture
def connector(mock_jira_client):
    """Create a JiraConnector with a mocked client."""
    return JiraConnector(mock_jira_client)


# ── list_projects tests ─────────────────────────────────────────


class TestListProjects:
    """Tests for JiraConnector.list_projects()."""

    def test_returns_projects(self, connector, mock_jira_client):
        """list_projects() returns a list of JiraProject objects."""
        mock_jira_client.get.return_value = [
            {"key": "PROJ", "name": "My Project", "projectTypeKey": "software"},
            {"key": "TEST", "name": "Test Project", "projectTypeKey": "business"},
        ]

        result = connector.list_projects()

        assert len(result) == 2
        assert all(isinstance(p, JiraProject) for p in result)
        assert result[0].key == "PROJ"
        assert result[1].name == "Test Project"

    def test_returns_empty_list(self, connector, mock_jira_client):
        """list_projects() returns empty list when no projects exist."""
        mock_jira_client.get.return_value = []

        result = connector.list_projects()

        assert result == []

    def test_handles_non_list_response(self, connector, mock_jira_client):
        """list_projects() handles unexpected non-list response."""
        mock_jira_client.get.return_value = {}

        result = connector.list_projects()

        assert result == []


# ── get_project tests ───────────────────────────────────────────


class TestGetProject:
    """Tests for JiraConnector.get_project()."""

    def test_returns_project(self, connector, mock_jira_client):
        """get_project() returns a JiraProject for a valid key."""
        mock_jira_client.get.return_value = {
            "key": "PROJ",
            "name": "My Project",
            "id": "10001",
            "projectTypeKey": "software",
            "style": "next-gen",
        }

        result = connector.get_project("PROJ")

        assert isinstance(result, JiraProject)
        assert result.key == "PROJ"
        assert result.project_type == "software"
        assert result.style == "next-gen"
        mock_jira_client.get.assert_called_once_with("/rest/api/3/project/PROJ")


# ── search_issues tests ─────────────────────────────────────────


class TestSearchIssues:
    """Tests for JiraConnector.search_issues()."""

    def test_returns_issues(self, connector, mock_jira_client):
        """search_issues() returns a list of JiraIssue objects."""
        mock_jira_client.get.return_value = {
            "issues": [
                {
                    "key": "PROJ-1",
                    "id": "10001",
                    "fields": {
                        "summary": "Fix login bug",
                        "status": {"name": "To Do", "statusCategory": {"key": "new"}},
                        "priority": {"name": "High"},
                        "issuetype": {"name": "Bug"},
                        "labels": ["frontend"],
                        "project": {"key": "PROJ"},
                    },
                },
            ],
            "total": 1,
        }

        result = connector.search_issues("PROJ")

        assert len(result) == 1
        assert isinstance(result[0], JiraIssue)
        assert result[0].key == "PROJ-1"
        assert result[0].summary == "Fix login bug"
        assert result[0].issue_type == "Bug"

    def test_passes_jql_filter(self, connector, mock_jira_client):
        """search_issues() builds correct JQL with filter."""
        mock_jira_client.get.return_value = {"issues": [], "total": 0}

        connector.search_issues("PROJ", jql_filter="status = 'To Do'")

        call_args = mock_jira_client.get.call_args
        params = call_args.kwargs["params"]
        jql = params["jql"]
        assert "project = PROJ" in jql
        assert "status = 'To Do'" in jql

    def test_passes_pagination_params(self, connector, mock_jira_client):
        """search_issues() passes maxResults and startAt."""
        mock_jira_client.get.return_value = {"issues": [], "total": 0}

        connector.search_issues("PROJ", max_results=10, start_at=20)

        call_args = mock_jira_client.get.call_args
        params = call_args.kwargs["params"]
        assert params["maxResults"] == 10
        assert params["startAt"] == 20

    def test_returns_empty_list(self, connector, mock_jira_client):
        """search_issues() returns empty list when no issues match."""
        mock_jira_client.get.return_value = {"issues": [], "total": 0}

        result = connector.search_issues("PROJ")

        assert result == []


# ── get_issue tests ──────────────────────────────────────────────


class TestGetIssue:
    """Tests for JiraConnector.get_issue()."""

    def test_returns_issue(self, connector, mock_jira_client):
        """get_issue() returns a JiraIssue for a valid key."""
        mock_jira_client.get.return_value = {
            "key": "PROJ-42",
            "id": "10042",
            "fields": {
                "summary": "Implement feature X",
                "description": "Some description",
                "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                "priority": {"name": "Medium"},
                "issuetype": {"name": "Story"},
                "labels": [],
                "project": {"key": "PROJ"},
                "assignee": {
                    "accountId": "abc123",
                    "displayName": "John Doe",
                },
            },
        }

        result = connector.get_issue("PROJ-42")

        assert isinstance(result, JiraIssue)
        assert result.key == "PROJ-42"
        assert result.assignee is not None
        assert result.assignee.display_name == "John Doe"


# ── create_issue tests ──────────────────────────────────────────


class TestCreateIssue:
    """Tests for JiraConnector.create_issue()."""

    def test_creates_issue(self, connector, mock_jira_client):
        """create_issue() posts to API and returns the created issue."""
        # First call: POST to create
        mock_jira_client.post.return_value = {"key": "PROJ-99", "id": "10099"}
        # Second call: GET to retrieve
        mock_jira_client.get.return_value = {
            "key": "PROJ-99",
            "id": "10099",
            "fields": {
                "summary": "New task",
                "status": {"name": "To Do", "statusCategory": {"key": "new"}},
                "priority": {"name": "Medium"},
                "issuetype": {"name": "Task"},
                "labels": ["auto"],
                "project": {"key": "PROJ"},
            },
        }

        result = connector.create_issue(
            project_key="PROJ",
            summary="New task",
            issue_type="Task",
            description="Task description",
            labels=["auto"],
        )

        assert result.key == "PROJ-99"
        assert result.summary == "New task"

    def test_creates_issue_with_priority(self, connector, mock_jira_client):
        """create_issue() includes priority in the request."""
        mock_jira_client.post.return_value = {"key": "PROJ-100", "id": "10100"}
        mock_jira_client.get.return_value = {
            "key": "PROJ-100",
            "id": "10100",
            "fields": {
                "summary": "Urgent bug",
                "status": {"name": "To Do"},
                "priority": {"name": "Highest"},
                "issuetype": {"name": "Bug"},
                "labels": [],
                "project": {"key": "PROJ"},
            },
        }

        connector.create_issue(
            project_key="PROJ",
            summary="Urgent bug",
            issue_type="Bug",
            priority="Highest",
        )

        call_args = mock_jira_client.post.call_args
        fields = call_args.kwargs["json_data"]["fields"]
        assert fields["priority"] == {"name": "Highest"}


# ── Transition tests ─────────────────────────────────────────────


class TestTransitions:
    """Tests for transition and status sync operations."""

    def test_get_transitions(self, connector, mock_jira_client):
        """get_transitions() returns available transitions."""
        mock_jira_client.get.return_value = {
            "transitions": [
                {
                    "id": "11",
                    "name": "Start Progress",
                    "to": {"name": "In Progress", "id": "3", "statusCategory": {"key": "indeterminate"}},
                },
                {
                    "id": "21",
                    "name": "Done",
                    "to": {"name": "Done", "id": "5", "statusCategory": {"key": "done"}},
                },
            ]
        }

        result = connector.get_transitions("PROJ-1")

        assert len(result) == 2
        assert all(isinstance(t, JiraTransition) for t in result)
        assert result[0].name == "Start Progress"
        assert result[0].to_status.name == "In Progress"

    def test_transition_issue(self, connector, mock_jira_client):
        """transition_issue() posts the transition."""
        mock_jira_client.post.return_value = {}

        connector.transition_issue("PROJ-1", "11")

        mock_jira_client.post.assert_called_once()
        call_args = mock_jira_client.post.call_args
        assert "/transitions" in call_args.args[0]

    def test_transition_issue_with_comment(self, connector, mock_jira_client):
        """transition_issue() includes comment when provided."""
        mock_jira_client.post.return_value = {}

        connector.transition_issue("PROJ-1", "11", comment="Auto transition")

        call_args = mock_jira_client.post.call_args
        payload = call_args.kwargs["json_data"]
        assert "update" in payload
        assert "comment" in payload["update"]

    def test_sync_status_to_jira_success(self, connector, mock_jira_client):
        """sync_status_to_jira() finds and executes matching transition."""
        # get_transitions response
        mock_jira_client.get.return_value = {
            "transitions": [
                {
                    "id": "21",
                    "name": "Done",
                    "to": {"name": "Done", "id": "5", "statusCategory": {"key": "done"}},
                },
            ]
        }
        # transition_issue response
        mock_jira_client.post.return_value = {}

        result = connector.sync_status_to_jira("PROJ-1", "done")

        assert result is True

    def test_sync_status_to_jira_no_match(self, connector, mock_jira_client):
        """sync_status_to_jira() returns False when no matching transition."""
        mock_jira_client.get.return_value = {
            "transitions": [
                {
                    "id": "11",
                    "name": "Start",
                    "to": {"name": "In Progress", "id": "3", "statusCategory": {"key": "indeterminate"}},
                },
            ]
        }

        result = connector.sync_status_to_jira("PROJ-1", "done")

        assert result is False

    def test_sync_status_unknown_status(self, connector, mock_jira_client):
        """sync_status_to_jira() returns False for unknown WorkPilot status."""
        result = connector.sync_status_to_jira("PROJ-1", "unknown_status")

        assert result is False

    def test_map_jira_status_to_workpilot(self, connector):
        """map_jira_status_to_workpilot() maps categories correctly."""
        assert connector.map_jira_status_to_workpilot("new") == "todo"
        assert connector.map_jira_status_to_workpilot("indeterminate") == "in_progress"
        assert connector.map_jira_status_to_workpilot("done") == "done"
        assert connector.map_jira_status_to_workpilot("unknown") == "todo"


# ── QA integration tests ────────────────────────────────────────


class TestQAIntegration:
    """Tests for create_bug_from_qa()."""

    def test_creates_bug_from_qa_result(self, connector, mock_jira_client):
        """create_bug_from_qa() creates a Bug with QA details."""
        mock_jira_client.post.return_value = {"key": "PROJ-200", "id": "10200"}
        mock_jira_client.get.return_value = {
            "key": "PROJ-200",
            "id": "10200",
            "fields": {
                "summary": "[QA] Login fails with invalid token",
                "status": {"name": "To Do"},
                "priority": {"name": "High"},
                "issuetype": {"name": "Bug"},
                "labels": ["workpilot-qa", "auto-generated"],
                "project": {"key": "PROJ"},
            },
        }

        result = connector.create_bug_from_qa(
            project_key="PROJ",
            qa_result={
                "title": "Login fails with invalid token",
                "description": "User cannot login when token is expired.",
                "severity": "high",
                "steps": ["Open login page", "Enter expired token", "Click submit"],
            },
        )

        assert result.key == "PROJ-200"
        assert "workpilot-qa" in result.labels


# ── Kanban import tests ─────────────────────────────────────────


class TestKanbanImport:
    """Tests for import_issues_for_kanban()."""

    def test_imports_issues_for_kanban(self, connector, mock_jira_client):
        """import_issues_for_kanban() converts issues to Kanban format."""
        mock_jira_client.get.return_value = {
            "issues": [
                {
                    "key": "PROJ-1",
                    "id": "10001",
                    "fields": {
                        "summary": "Task A",
                        "description": "Do something",
                        "status": {"name": "To Do", "statusCategory": {"key": "new"}},
                        "priority": {"name": "High"},
                        "issuetype": {"name": "Task"},
                        "labels": ["backend"],
                        "project": {"key": "PROJ"},
                        "assignee": {"accountId": "abc", "displayName": "Alice"},
                    },
                },
                {
                    "key": "PROJ-2",
                    "id": "10002",
                    "fields": {
                        "summary": "Task B",
                        "status": {"name": "Done", "statusCategory": {"key": "done"}},
                        "priority": {"name": "Low"},
                        "issuetype": {"name": "Task"},
                        "labels": [],
                        "project": {"key": "PROJ"},
                    },
                },
            ],
            "total": 2,
        }

        result = connector.import_issues_for_kanban("PROJ")

        assert len(result) == 2
        assert result[0]["id"] == "PROJ-1"
        assert result[0]["status"] == "todo"
        assert result[0]["source"] == "jira"
        assert result[0]["assignee"] == "Alice"
        assert result[1]["status"] == "done"
        assert result[1]["assignee"] is None


# ── Model unit tests ─────────────────────────────────────────────


class TestJiraModels:
    """Direct unit tests for Jira data models."""

    def test_jira_user_from_api(self):
        """JiraUser.from_api_response maps fields correctly."""
        user = JiraUser.from_api_response({
            "accountId": "abc123",
            "displayName": "John Doe",
            "emailAddress": "john@example.com",
            "active": True,
        })
        assert user.account_id == "abc123"
        assert user.display_name == "John Doe"
        assert user.email == "john@example.com"

    def test_jira_user_from_none(self):
        """JiraUser.from_api_response returns None for None input."""
        assert JiraUser.from_api_response(None) is None

    def test_jira_status_from_api(self):
        """JiraStatus.from_api_response maps fields correctly."""
        status = JiraStatus.from_api_response({
            "name": "In Progress",
            "id": "3",
            "statusCategory": {"key": "indeterminate"},
        })
        assert status.name == "In Progress"
        assert status.category == "indeterminate"

    def test_jira_issue_with_adf_description(self):
        """JiraIssue parses ADF description into plain text."""
        issue = JiraIssue.from_api_response({
            "key": "PROJ-1",
            "id": "10001",
            "fields": {
                "summary": "Test",
                "description": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [
                                {"type": "text", "text": "Hello world"},
                            ],
                        }
                    ],
                },
                "status": {"name": "To Do"},
                "priority": {"name": "Medium"},
                "issuetype": {"name": "Task"},
                "project": {"key": "PROJ"},
            },
        })
        assert "Hello world" in issue.description

    def test_jira_issue_with_string_description(self):
        """JiraIssue handles plain string description."""
        issue = JiraIssue.from_api_response({
            "key": "PROJ-2",
            "id": "10002",
            "fields": {
                "summary": "Test",
                "description": "Plain text description",
                "status": {"name": "To Do"},
                "issuetype": {"name": "Task"},
                "project": {"key": "PROJ"},
            },
        })
        assert issue.description == "Plain text description"

    def test_jira_issue_parses_dates(self):
        """JiraIssue parses created/updated dates."""
        issue = JiraIssue.from_api_response({
            "key": "PROJ-3",
            "id": "10003",
            "fields": {
                "summary": "Test",
                "created": "2026-01-15T10:30:00.000+0000",
                "updated": "2026-02-01T14:00:00.000+0000",
                "status": {"name": "Done"},
                "issuetype": {"name": "Task"},
                "project": {"key": "PROJ"},
            },
        })
        assert issue.created is not None
        assert issue.updated is not None

    def test_jira_transition_from_api(self):
        """JiraTransition.from_api_response maps fields correctly."""
        transition = JiraTransition.from_api_response({
            "id": "11",
            "name": "Start Progress",
            "to": {"name": "In Progress", "id": "3", "statusCategory": {"key": "indeterminate"}},
        })
        assert transition.transition_id == "11"
        assert transition.name == "Start Progress"
        assert transition.to_status.name == "In Progress"


# ── _extract_adf_text tests ─────────────────────────────────────


class TestExtractAdfText:
    """Tests for _extract_adf_text helper (ADF → plain text extraction)."""

    _extract_adf_text = staticmethod(models_module._extract_adf_text)

    def test_plain_text_node(self):
        """Returns the text value for a leaf text node."""
        adf = {"type": "text", "text": "Hello"}
        assert self._extract_adf_text(adf) == "Hello"

    def test_hard_break(self):
        """hardBreak node returns a newline character."""
        adf = {"type": "hardBreak"}
        assert self._extract_adf_text(adf) == "\n"

    def test_paragraph_joins_inline_with_spaces(self):
        """Inline children inside a paragraph are space-joined."""
        adf = {
            "type": "paragraph",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "world"},
            ],
        }
        assert self._extract_adf_text(adf) == "Hello world"

    def test_bullet_list_items_separated_by_newlines(self):
        """List items inside a bulletList are newline-separated."""
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Criterion A"}],
                                }
                            ],
                        },
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Criterion B"}],
                                }
                            ],
                        },
                    ],
                }
            ],
        }
        result = self._extract_adf_text(adf)
        assert result == "Criterion A\nCriterion B"

    def test_doc_with_multiple_paragraphs(self):
        """Multiple paragraphs in a doc root are newline-separated."""
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "First paragraph"}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Second paragraph"}],
                },
            ],
        }
        result = self._extract_adf_text(adf)
        assert result == "First paragraph\nSecond paragraph"

    def test_non_dict_input_returns_empty(self):
        """Non-dict input returns empty string gracefully."""
        assert self._extract_adf_text("not a dict") == ""  # type: ignore[arg-type]
        assert self._extract_adf_text(None) == ""  # type: ignore[arg-type]
        assert self._extract_adf_text([]) == ""  # type: ignore[arg-type]
