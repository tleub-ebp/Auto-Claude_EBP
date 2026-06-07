"""Data models for the Jira connector.

Defines dataclass representations for Jira entities including
projects, issues, transitions, and comments. Each model includes
factory methods for converting raw Jira API responses into clean,
typed data structures.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class JiraUser:
    """Jira user representation.

    Attributes:
        account_id: The unique Jira account ID.
        display_name: The user's display name.
        email: The user's email address, or None.
        active: Whether the user account is active.
    """

    account_id: str
    display_name: str
    email: str | None = None
    active: bool = True

    @classmethod
    def from_api_response(cls, data: dict[str, Any] | None) -> "JiraUser | None":
        """Create a JiraUser from a Jira API response dict.

        Args:
            data: A user dictionary from the Jira API, or None.

        Returns:
            A JiraUser instance or None if data is None.
        """
        if not data:
            return None
        return cls(
            account_id=data.get("accountId", ""),
            display_name=data.get("displayName", ""),
            email=data.get("emailAddress"),
            active=data.get("active", True),
        )


@dataclass
class JiraProject:
    """Jira project representation.

    Attributes:
        key: The unique project key (e.g., ``'PROJ'``).
        name: The display name of the project.
        project_id: The project's numeric ID as string.
        project_type: The project type (e.g., ``'software'``).
        style: The project style (``'classic'`` or ``'next-gen'``).
        description: The project description, or empty string.
    """

    key: str
    name: str
    project_id: str = ""
    project_type: str = "software"
    style: str = "classic"
    description: str = ""

    @classmethod
    def from_api_response(cls, data: dict[str, Any]) -> "JiraProject":
        """Create a JiraProject from a Jira API response dict.

        Args:
            data: A project dictionary from the Jira API
                ``/rest/api/3/project`` endpoint.

        Returns:
            A JiraProject instance populated from the API response.
        """
        return cls(
            key=data.get("key", ""),
            name=data.get("name", ""),
            project_id=str(data.get("id", "")),
            project_type=data.get("projectTypeKey", "software"),
            style=data.get("style", "classic"),
            description=data.get("description", ""),
        )


@dataclass
class JiraStatus:
    """Jira issue status.

    Attributes:
        name: The status name (e.g., ``'To Do'``, ``'In Progress'``, ``'Done'``).
        status_id: The unique status ID.
        category: The status category (``'new'``, ``'indeterminate'``, ``'done'``).
    """

    name: str
    status_id: str = ""
    category: str = ""

    @classmethod
    def from_api_response(cls, data: dict[str, Any] | None) -> "JiraStatus":
        """Create a JiraStatus from a Jira API response dict."""
        if not data:
            return cls(name="Unknown")
        category_data = data.get("statusCategory", {})
        return cls(
            name=data.get("name", ""),
            status_id=str(data.get("id", "")),
            category=category_data.get("key", ""),
        )


@dataclass
class JiraIssue:
    """Jira issue representation.

    Attributes:
        key: The issue key (e.g., ``'PROJ-123'``).
        issue_id: The numeric issue ID.
        summary: The issue summary/title.
        description: The issue description.
        issue_type: The issue type (``'Bug'``, ``'Story'``, ``'Task'``, etc.).
        status: The issue status.
        priority: The issue priority (``'Highest'``, ``'High'``, ``'Medium'``, etc.).
        assignee: The assigned user, or None.
        reporter: The reporting user, or None.
        labels: Tags/labels on the issue.
        created: Creation datetime, or None.
        updated: Last update datetime, or None.
        project_key: The parent project key.
        custom_fields: Additional custom fields as key-value pairs.
        acceptance_criteria: Plain-text acceptance criteria extracted from
            the matching custom field (autodetected by name), or empty
            string if no such field is set on the issue.
    """

    key: str
    issue_id: str
    summary: str
    description: str = ""
    issue_type: str = ""
    status: JiraStatus = field(default_factory=lambda: JiraStatus(name="Unknown"))
    priority: str = "Medium"
    assignee: JiraUser | None = None
    reporter: JiraUser | None = None
    labels: list[str] = field(default_factory=list)
    created: datetime | None = None
    updated: datetime | None = None
    project_key: str = ""
    custom_fields: dict[str, Any] = field(default_factory=dict)
    acceptance_criteria: str = ""

    @classmethod
    def from_api_response(cls, data: dict[str, Any]) -> "JiraIssue":
        """Create a JiraIssue from a Jira API response dict.

        Args:
            data: An issue dictionary from the Jira API
                ``/rest/api/3/search`` or ``/rest/api/3/issue`` endpoints.

        Returns:
            A JiraIssue instance.
        """
        fields = data.get("fields", {})

        created = fields.get("created")
        parsed_created = None
        if created:
            try:
                parsed_created = datetime.fromisoformat(
                    created.replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                parsed_created = None

        updated = fields.get("updated")
        parsed_updated = None
        if updated:
            try:
                parsed_updated = datetime.fromisoformat(
                    updated.replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                parsed_updated = None

        issue_type_data = fields.get("issuetype", {})
        priority_data = fields.get("priority", {})
        project_data = fields.get("project", {})

        # Extract description text from Atlassian Document Format
        description = ""
        desc_data = fields.get("description")
        if isinstance(desc_data, str):
            description = desc_data
        elif isinstance(desc_data, dict):
            # ADF format — extract text from content nodes
            description = _extract_adf_text(desc_data)

        # Collect custom fields (customfield_XXXXX)
        custom_fields = {
            k: v for k, v in fields.items()
            if k.startswith("customfield_") and v is not None
        }

        return cls(
            key=data.get("key", ""),
            issue_id=str(data.get("id", "")),
            summary=fields.get("summary", ""),
            description=description,
            issue_type=issue_type_data.get("name", ""),
            status=JiraStatus.from_api_response(fields.get("status")),
            priority=priority_data.get("name", "Medium"),
            assignee=JiraUser.from_api_response(fields.get("assignee")),
            reporter=JiraUser.from_api_response(fields.get("reporter")),
            labels=fields.get("labels", []),
            created=parsed_created,
            updated=parsed_updated,
            project_key=project_data.get("key", ""),
            custom_fields=custom_fields,
        )


@dataclass
class JiraTransition:
    """A possible status transition for a Jira issue.

    Attributes:
        transition_id: The unique transition ID.
        name: The transition name (e.g., ``'Start Progress'``).
        to_status: The target status after transition.
    """

    transition_id: str
    name: str
    to_status: JiraStatus = field(default_factory=lambda: JiraStatus(name="Unknown"))

    @classmethod
    def from_api_response(cls, data: dict[str, Any]) -> "JiraTransition":
        """Create a JiraTransition from a Jira API response dict."""
        return cls(
            transition_id=str(data.get("id", "")),
            name=data.get("name", ""),
            to_status=JiraStatus.from_api_response(data.get("to")),
        )


@dataclass
class JiraComment:
    """A comment on a Jira issue.

    Attributes:
        comment_id: The unique comment ID.
        body: The comment text.
        author: The comment author.
        created: Creation datetime, or None.
    """

    comment_id: str
    body: str
    author: JiraUser | None = None
    created: datetime | None = None

    @classmethod
    def from_api_response(cls, data: dict[str, Any]) -> "JiraComment":
        """Create a JiraComment from a Jira API response dict."""
        created = data.get("created")
        parsed_created = None
        if created:
            try:
                parsed_created = datetime.fromisoformat(
                    created.replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                parsed_created = None

        body = data.get("body", "")
        if isinstance(body, dict):
            body = _extract_adf_text(body)

        return cls(
            comment_id=str(data.get("id", "")),
            body=body,
            author=JiraUser.from_api_response(data.get("author")),
            created=parsed_created,
        )


_ADF_BLOCK_CONTAINERS = frozenset({
    "doc",
    "bulletList",
    "orderedList",
    "blockquote",
    "table",
    "tableBody",
    "tableHead",
    "tableFoot",
})


def _extract_adf_text(adf: dict[str, Any]) -> str:
    """Extract plain text from Atlassian Document Format (ADF).

    Recursively traverses ADF nodes and concatenates text content.
    Block-level container nodes (lists, tables, doc root, blockquotes)
    join their children with newlines so that list items and paragraphs
    remain on separate lines — which is essential for correctly splitting
    acceptance criteria into individual criteria later.

    Args:
        adf: An ADF document dictionary.

    Returns:
        Extracted plain text with newlines between block-level items.
    """
    if not isinstance(adf, dict):
        return ""

    node_type = adf.get("type", "")

    if node_type == "text":
        return adf.get("text", "")

    if node_type == "hardBreak":
        return "\n"

    child_texts = [_extract_adf_text(child) for child in adf.get("content", [])]
    child_texts = [t for t in child_texts if t]

    separator = "\n" if node_type in _ADF_BLOCK_CONTAINERS else " "
    return separator.join(child_texts).strip()
