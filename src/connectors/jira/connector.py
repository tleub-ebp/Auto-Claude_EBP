"""Jira connector — High-level interface for issue tracking integration.

Provides methods for listing projects, importing/creating issues,
synchronizing statuses bidirectionally, and managing transitions
with Jira Cloud.

Example:
    >>> from src.connectors.jira import JiraConnector
    >>> connector = JiraConnector.from_env()
    >>> projects = connector.list_projects()
    >>> issues = connector.search_issues("PROJ", "status = 'To Do'")
"""

import logging
from typing import Any

from src.connectors.jira.client import JiraClient
from src.connectors.jira.models import (
    JiraComment,
    JiraIssue,
    JiraProject,
    JiraTransition,
)

logger = logging.getLogger(__name__)

# Default fields to retrieve for issues
DEFAULT_FIELDS = [
    "summary",
    "description",
    "status",
    "priority",
    "assignee",
    "reporter",
    "issuetype",
    "labels",
    "created",
    "updated",
    "project",
]

# Mapping from WorkPilot statuses to Jira status categories
STATUS_MAPPING_TO_JIRA = {
    "todo": "To Do",
    "in_progress": "In Progress",
    "review": "In Review",
    "done": "Done",
}

STATUS_MAPPING_FROM_JIRA = {
    "new": "todo",
    "indeterminate": "in_progress",
    "done": "done",
}


class JiraConnector:
    """Unified connector for Jira Cloud issue tracking integration.

    Provides high-level methods for interacting with Jira including
    project listing, issue import/creation, bidirectional status sync,
    and transition management.

    Attributes:
        _client: The underlying Jira HTTP client.

    Example:
        >>> connector = JiraConnector.from_env()
        >>> projects = connector.list_projects()
        >>> for p in projects:
        ...     print(f"{p.key}: {p.name}")
    """

    # Names that we accept as "Acceptance Criteria" custom field labels.
    # Jira tenants name this field differently; matching by lowercased
    # field name lets us autodetect it without configuration.
    _ACCEPTANCE_CRITERIA_FIELD_NAMES = (
        "acceptance criteria",
        "critères d'acceptation",
        "criteres d'acceptation",
        "critères d'acceptance",
    )

    def __init__(self, client: JiraClient) -> None:
        """Initialize the Jira connector.

        Args:
            client: A JiraClient instance. Does not need to be
                connected yet — call ``connect()`` to authenticate.
        """
        self._client = client
        self._acceptance_criteria_field_id: str | None = None
        self._acceptance_criteria_lookup_done: bool = False

    @classmethod
    def from_env(cls) -> "JiraConnector":
        """Create a connector from environment variables and connect.

        Reads ``JIRA_URL``, ``JIRA_EMAIL``, and ``JIRA_API_TOKEN``
        from the environment, creates and connects the client.

        Returns:
            A connected JiraConnector instance.

        Raises:
            JiraConfigurationError: If required env vars are missing.
            JiraAuthenticationError: If authentication fails.
        """
        client = JiraClient.from_env()
        return cls(client)

    def connect(self) -> None:
        """Establish an authenticated connection to Jira.

        Raises:
            JiraAuthenticationError: If the credentials are invalid.
            JiraAPIError: If the server is unreachable.
        """
        self._client.connect()

    def disconnect(self) -> None:
        """Close the connection to Jira."""
        self._client.disconnect()

    @property
    def is_connected(self) -> bool:
        """Check whether the connector has an active connection."""
        return self._client.is_connected

    def get_connection_info(self) -> dict[str, str]:
        """Get information about the current connection."""
        return self._client.get_connection_info()

    # ── Project operations ───────────────────────────────────────────

    def list_projects(self) -> list[JiraProject]:
        """List all projects visible to the authenticated user.

        Returns:
            A list of JiraProject objects.

        Raises:
            JiraAPIError: If the API call fails.
        """
        logger.info("Listing Jira projects.")

        data = self._client.get("/rest/api/3/project")

        # Jira returns a list directly for this endpoint
        if isinstance(data, list):
            projects = [JiraProject.from_api_response(p) for p in data]
        else:
            projects = []

        logger.info("Found %d projects.", len(projects))
        return projects

    def get_project(self, project_key: str) -> JiraProject:
        """Get details of a single project.

        Args:
            project_key: The unique project key (e.g., ``'PROJ'``).

        Returns:
            A JiraProject object.

        Raises:
            JiraProjectNotFoundError: If the project does not exist.
            JiraAPIError: If the API call fails.
        """
        logger.info("Getting project '%s'.", project_key)

        data = self._client.get(f"/rest/api/3/project/{project_key}")
        return JiraProject.from_api_response(data)

    # ── Acceptance criteria autodetection ────────────────────────────

    def _get_acceptance_criteria_field_id(self) -> str | None:
        """Return the custom-field id matching "Acceptance Criteria".

        Calls ``/rest/api/3/field`` once per connector instance and caches
        the result. Returns ``None`` if no matching field exists on this
        Jira tenant (e.g. teams that put acceptance criteria in the
        description), in which case acceptance criteria stay empty.
        """
        if self._acceptance_criteria_lookup_done:
            return self._acceptance_criteria_field_id

        self._acceptance_criteria_lookup_done = True
        try:
            fields = self._client.get("/rest/api/3/field")
        except Exception as exc:  # noqa: BLE001 — autodetection is best-effort
            logger.warning("Failed to list Jira fields for AC autodetect: %s", exc)
            return None

        if not isinstance(fields, list):
            return None

        for fld in fields:
            name = (fld.get("name") or "").strip().lower()
            if name in self._ACCEPTANCE_CRITERIA_FIELD_NAMES:
                field_id = fld.get("id") or fld.get("key")
                if field_id:
                    self._acceptance_criteria_field_id = field_id
                    logger.info(
                        "Detected Jira Acceptance Criteria field: '%s' (id=%s)",
                        fld.get("name"),
                        field_id,
                    )
                    return field_id

        logger.info("No Jira custom field named 'Acceptance Criteria' found.")
        return None

    def _populate_acceptance_criteria(self, issue: JiraIssue) -> None:
        """Fill ``issue.acceptance_criteria`` from the autodetected field.

        Reads the raw value from ``issue.custom_fields`` using the cached
        field id, then flattens it to plain text (handles ADF and string
        values). No-op if no AC field exists on this tenant or the issue
        does not set it.
        """
        from src.connectors.jira.models import _extract_adf_text

        field_id = self._get_acceptance_criteria_field_id()
        if not field_id:
            return

        raw = issue.custom_fields.get(field_id)
        if raw is None:
            return

        if isinstance(raw, str):
            issue.acceptance_criteria = raw.strip()
        elif isinstance(raw, dict):
            issue.acceptance_criteria = _extract_adf_text(raw)

    # ── Issue operations ─────────────────────────────────────────────

    def search_issues(
        self,
        project_key: str,
        jql_filter: str | None = None,
        max_results: int = 50,
        start_at: int = 0,
        fields: list[str] | None = None,
    ) -> list[JiraIssue]:
        """Search for issues using JQL (Jira Query Language).

        Args:
            project_key: The project key to filter by.
            jql_filter: Additional JQL filter conditions. If None,
                returns all issues in the project.
            max_results: Maximum number of issues to return.
            start_at: Index of the first result to return (pagination).
            fields: List of fields to include. Defaults to
                ``DEFAULT_FIELDS``.

        Returns:
            A list of JiraIssue objects matching the query.

        Raises:
            JiraAPIError: If the API call fails.
        """
        jql = f"project = {project_key}"
        if jql_filter:
            jql = f"{jql} AND {jql_filter}"
        # No issuetype restriction is applied so every issue type — including
        # sub-tasks and custom types — stays findable. Order by newest first
        # so recently created issues (e.g. a bug just added to a story) fall
        # within the result window. Skip if the caller already ordered.
        if "order by" not in jql.lower():
            jql = f"{jql} ORDER BY created DESC"

        logger.info("Searching Jira issues: %s (max=%d).", jql, max_results)

        # Resolve the requested field list, then make sure the autodetected
        # Acceptance Criteria custom field is included so Jira returns it.
        requested_fields = list(fields or DEFAULT_FIELDS)
        ac_field_id = self._get_acceptance_criteria_field_id()
        if ac_field_id and ac_field_id not in requested_fields:
            requested_fields.append(ac_field_id)

        params = {
            "jql": jql,
            "maxResults": max_results,
            "startAt": start_at,
            "fields": ",".join(requested_fields),
        }

        data = self._client.get(
            "/rest/api/3/search/jql",
            params=params,
        )

        issues_data = data.get("issues", [])
        issues = [JiraIssue.from_api_response(i) for i in issues_data]
        for issue in issues:
            self._populate_acceptance_criteria(issue)

        total = data.get("total", len(issues))
        logger.info(
            "Found %d issues (total: %d) for project '%s'.",
            len(issues),
            total,
            project_key,
        )
        return issues

    def get_issue(self, issue_key: str) -> JiraIssue:
        """Get a single issue by its key.

        Args:
            issue_key: The issue key (e.g., ``'PROJ-123'``).

        Returns:
            A JiraIssue object.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the API call fails.
        """
        logger.info("Getting issue '%s'.", issue_key)

        data = self._client.get(f"/rest/api/3/issue/{issue_key}")
        issue = JiraIssue.from_api_response(data)
        self._populate_acceptance_criteria(issue)
        return issue

    def create_issue(
        self,
        project_key: str,
        summary: str,
        issue_type: str = "Task",
        description: str = "",
        priority: str | None = None,
        labels: list[str] | None = None,
        assignee_account_id: str | None = None,
        custom_fields: dict[str, Any] | None = None,
    ) -> JiraIssue:
        """Create a new issue in Jira.

        Args:
            project_key: The project key.
            summary: The issue title/summary.
            issue_type: The issue type (``'Bug'``, ``'Task'``, ``'Story'``, etc.).
            description: The issue description (plain text).
            priority: The priority name (``'Highest'``, ``'High'``, etc.).
            labels: List of labels/tags.
            assignee_account_id: Jira account ID for assignee.
            custom_fields: Custom fields as ``{'customfield_XXXXX': value}``.

        Returns:
            The created JiraIssue object.

        Raises:
            JiraAPIError: If the API call fails.
        """
        logger.info(
            "Creating %s in project '%s': %s",
            issue_type,
            project_key,
            summary,
        )

        fields: dict[str, Any] = {
            "project": {"key": project_key},
            "summary": summary,
            "issuetype": {"name": issue_type},
        }

        if description:
            fields["description"] = {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": description}],
                    }
                ],
            }

        if priority:
            fields["priority"] = {"name": priority}
        if labels:
            fields["labels"] = labels
        if assignee_account_id:
            fields["assignee"] = {"accountId": assignee_account_id}
        if custom_fields:
            fields.update(custom_fields)

        data = self._client.post(
            "/rest/api/3/issue",
            json_data={"fields": fields},
        )

        issue_key = data.get("key", "")
        logger.info("Created issue '%s'.", issue_key)

        return self.get_issue(issue_key)

    def update_issue(
        self,
        issue_key: str,
        fields: dict[str, Any],
    ) -> None:
        """Update an issue's fields.

        Args:
            issue_key: The issue key (e.g., ``'PROJ-123'``).
            fields: Dictionary of field names to new values.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the API call fails.
        """
        logger.info("Updating issue '%s'.", issue_key)

        self._client.put(
            f"/rest/api/3/issue/{issue_key}",
            json_data={"fields": fields},
        )

        logger.info("Updated issue '%s'.", issue_key)

    # ── Transition / Status sync operations ──────────────────────────

    def get_transitions(self, issue_key: str) -> list[JiraTransition]:
        """Get available transitions for an issue.

        Args:
            issue_key: The issue key.

        Returns:
            A list of JiraTransition objects.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the API call fails.
        """
        logger.info("Getting transitions for '%s'.", issue_key)

        data = self._client.get(f"/rest/api/3/issue/{issue_key}/transitions")
        transitions = [
            JiraTransition.from_api_response(t)
            for t in data.get("transitions", [])
        ]

        logger.info("Found %d transitions for '%s'.", len(transitions), issue_key)
        return transitions

    def transition_issue(
        self,
        issue_key: str,
        transition_id: str,
        comment: str | None = None,
    ) -> None:
        """Execute a transition on an issue (change status).

        Args:
            issue_key: The issue key.
            transition_id: The transition ID to execute.
            comment: Optional comment to add with the transition.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the transition fails.
        """
        logger.info(
            "Transitioning issue '%s' via transition '%s'.",
            issue_key,
            transition_id,
        )

        payload: dict[str, Any] = {
            "transition": {"id": transition_id},
        }

        if comment:
            payload["update"] = {
                "comment": [
                    {
                        "add": {
                            "body": {
                                "type": "doc",
                                "version": 1,
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [
                                            {"type": "text", "text": comment}
                                        ],
                                    }
                                ],
                            }
                        }
                    }
                ]
            }

        self._client.post(
            f"/rest/api/3/issue/{issue_key}/transitions",
            json_data=payload,
        )

        logger.info("Transitioned issue '%s'.", issue_key)

    def sync_status_to_jira(
        self,
        issue_key: str,
        workpilot_status: str,
    ) -> bool:
        """Synchronize a WorkPilot status to the corresponding Jira status.

        Finds the appropriate transition to move the Jira issue to the
        target status based on the WorkPilot status mapping.

        Args:
            issue_key: The Jira issue key.
            workpilot_status: The WorkPilot status (``'todo'``,
                ``'in_progress'``, ``'review'``, ``'done'``).

        Returns:
            True if the transition was executed, False if no matching
            transition was found.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the API call fails.
        """
        target_status = STATUS_MAPPING_TO_JIRA.get(workpilot_status)
        if not target_status:
            logger.warning(
                "No Jira status mapping for WorkPilot status '%s'.",
                workpilot_status,
            )
            return False

        transitions = self.get_transitions(issue_key)
        for transition in transitions:
            if transition.to_status.name.lower() == target_status.lower():
                self.transition_issue(
                    issue_key,
                    transition.transition_id,
                    comment=f"Status synced from WorkPilot AI: {workpilot_status}",
                )
                return True

        logger.warning(
            "No transition found to move '%s' to '%s'.",
            issue_key,
            target_status,
        )
        return False

    def map_jira_status_to_workpilot(self, jira_status: str) -> str:
        """Map a Jira status category to a WorkPilot status.

        Args:
            jira_status: The Jira status category key
                (``'new'``, ``'indeterminate'``, ``'done'``).

        Returns:
            The corresponding WorkPilot status string.
        """
        return STATUS_MAPPING_FROM_JIRA.get(jira_status, "todo")

    # ── Comment operations ───────────────────────────────────────────

    def add_comment(
        self,
        issue_key: str,
        body: str,
    ) -> JiraComment:
        """Add a comment to an issue.

        Args:
            issue_key: The issue key.
            body: The comment text.

        Returns:
            The created JiraComment object.

        Raises:
            JiraIssueNotFoundError: If the issue does not exist.
            JiraAPIError: If the API call fails.
        """
        logger.info("Adding comment to '%s'.", issue_key)

        data = self._client.post(
            f"/rest/api/3/issue/{issue_key}/comment",
            json_data={
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                }
            },
        )

        return JiraComment.from_api_response(data)

    # ── QA integration ───────────────────────────────────────────────

    def create_bug_from_qa(
        self,
        project_key: str,
        qa_result: dict[str, Any],
    ) -> JiraIssue:
        """Create a Jira Bug from QA agent results.

        Automatically formats the QA failure details into a Jira Bug
        with appropriate fields.

        Args:
            project_key: The project key.
            qa_result: Dictionary with QA results containing keys:
                ``'title'``, ``'description'``, ``'severity'``, ``'steps'``.

        Returns:
            The created JiraIssue (Bug).

        Raises:
            JiraAPIError: If the API call fails.
        """
        title = qa_result.get("title", "QA Failure")
        description_parts = [
            "**QA Failure Report**",
            "",
            qa_result.get("description", ""),
        ]

        steps = qa_result.get("steps", [])
        if steps:
            description_parts.append("\n**Steps to Reproduce:**")
            for i, step in enumerate(steps, 1):
                description_parts.append(f"{i}. {step}")

        severity = qa_result.get("severity", "Medium")
        priority_map = {
            "critical": "Highest",
            "high": "High",
            "medium": "Medium",
            "low": "Low",
        }
        priority = priority_map.get(severity.lower(), "Medium")

        return self.create_issue(
            project_key=project_key,
            summary=f"[QA] {title}",
            issue_type="Bug",
            description="\n".join(description_parts),
            priority=priority,
            labels=["workpilot-qa", "auto-generated"],
        )

    # ── Import / Kanban integration ──────────────────────────────────

    def import_issues_for_kanban(
        self,
        project_key: str,
        jql_filter: str | None = None,
        max_results: int = 50,
    ) -> list[dict[str, Any]]:
        """Import Jira issues formatted for the WorkPilot Kanban board.

        Converts Jira issues into a format compatible with the WorkPilot
        Kanban store.

        Args:
            project_key: The project key.
            jql_filter: Optional JQL filter.
            max_results: Maximum number of issues.

        Returns:
            A list of dictionaries formatted for the Kanban board.

        Raises:
            JiraAPIError: If the API call fails.
        """
        logger.info("Importing issues from '%s' for Kanban.", project_key)

        issues = self.search_issues(project_key, jql_filter, max_results)

        kanban_items = []
        for issue in issues:
            status_category = issue.status.category
            workpilot_status = self.map_jira_status_to_workpilot(status_category)

            kanban_items.append({
                "id": issue.key,
                "title": issue.summary,
                "description": issue.description,
                "status": workpilot_status,
                "priority": issue.priority.lower(),
                "labels": issue.labels,
                "source": "jira",
                "source_key": issue.key,
                "assignee": (
                    issue.assignee.display_name if issue.assignee else None
                ),
            })

        logger.info("Imported %d issues for Kanban.", len(kanban_items))
        return kanban_items
