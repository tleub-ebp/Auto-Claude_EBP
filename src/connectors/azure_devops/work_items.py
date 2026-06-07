"""Work item operations for the Azure DevOps connector.

Provides methods for querying work items using WIQL, retrieving work item
details, and listing backlog items from Azure DevOps Boards via the
Azure DevOps SDK.

Work item retrieval follows a two-step process: WIQL queries return only
work item IDs, then a second call fetches the full work item details.

Example:
    >>> from src.connectors.azure_devops.client import AzureDevOpsClient
    >>> from src.connectors.azure_devops.work_items import AzureWorkItemsClient
    >>> client = AzureDevOpsClient.from_env()
    >>> work_items = AzureWorkItemsClient(client)
    >>> items = work_items.list_backlog_items("MyProject")
"""

import logging
from typing import Any

from azure.devops.v7_0.work_item_tracking.models import TeamContext, Wiql

from src.connectors.azure_devops.client import AzureDevOpsClient
from src.connectors.azure_devops.exceptions import (
    APIError,
    AzureDevOpsError,
    WorkItemNotFoundError,
)
from src.connectors.azure_devops.models import WorkItem

logger = logging.getLogger(__name__)

# Common backlog work item types for Azure DevOps. Kept as a convenience for
# callers that want to narrow ``list_backlog_items`` to these types; the
# default behaviour now returns every work item type so that custom,
# process-specific types (e.g. EBP's "RSD") stay findable in the import panel.
DEFAULT_BACKLOG_TYPES = ["Bug", "User Story", "Task"]


class AzureWorkItemsClient:
    """Client for Azure DevOps work item tracking operations.

    Wraps the Azure DevOps Work Item Tracking API client to provide
    high-level methods for querying work items, retrieving details,
    and listing backlog items. All API responses are mapped to clean
    WorkItem data models.

    Attributes:
        _client: The underlying AzureDevOpsClient providing authenticated
            access to the Work Item Tracking API.

    Example:
        >>> client = AzureDevOpsClient.from_env()
        >>> wit_client = AzureWorkItemsClient(client)
        >>> for item in wit_client.list_backlog_items("MyProject"):
        ...     print(f"{item.work_item_type}: {item.title}")
    """

    def __init__(self, client: AzureDevOpsClient) -> None:
        """Initialize the work item operations client.

        Args:
            client: An authenticated AzureDevOpsClient instance.
                Must have an active connection (connect() must have
                been called).
        """
        self._client = client

    def _get_wit_client(self) -> Any:
        """Get the Work Item Tracking API client from the underlying connection.

        Returns:
            An Azure DevOps WorkItemTrackingClient instance for making
            API calls.

        Raises:
            ConfigurationError: If the client is not connected.
            AuthenticationError: If credentials are invalid.
        """
        return self._client.get_wit_client()

    def query_work_items(
        self,
        project: str,
        query: str,
        max_items: int = 100,
    ) -> list[WorkItem]:
        """Query work items using WIQL (Work Item Query Language).

        Executes a WIQL query to find matching work items. This follows
        a two-step process: the WIQL query returns only work item IDs,
        then a second call fetches the full work item details.

        Uses ``error_policy='omit'`` when fetching work items to
        gracefully skip any deleted or inaccessible items.

        Args:
            project: The project name or identifier.
            query: A WIQL query string (e.g.,
                ``"SELECT [System.Id] FROM WorkItems WHERE ..."``).
            max_items: Maximum number of work items to return.
                Defaults to 100.

        Returns:
            A list of WorkItem objects matching the query. Returns an
            empty list if no items match.

        Raises:
            APIError: If the WIQL query is malformed or the API call
                fails unexpectedly.
        """
        logger.info(
            "Querying work items in project '%s' (max_items=%d).",
            project,
            max_items,
        )

        # Step 1: Execute WIQL query to get work item IDs
        try:
            wit_client = self._get_wit_client()
            wiql = Wiql(query=query)
            team_context = TeamContext(project=project)
            results = wit_client.query_by_wiql(
                wiql=wiql,
                team_context=team_context,
                top=max_items,
            )
        except AzureDevOpsError:
            raise
        except Exception as exc:
            error_msg = str(exc)
            # Check if the error is about a non-existent project
            if "does not exist" in error_msg.lower() and "project" in error_msg.lower():
                raise APIError(
                    f"Failed to execute WIQL query in project '{project}': {exc}\n"
                    f"Note: Ensure you are passing the Azure DevOps PROJECT name, "
                    f"not the repository name. Projects contain repositories."
                ) from exc
            raise APIError(
                f"Failed to execute WIQL query in project '{project}': {exc}"
            ) from exc

        if not results.work_items:
            logger.info(
                "No work items matched the query in project '%s'.",
                project,
            )
            return []

        ids = [item.id for item in results.work_items]
        logger.info(
            "WIQL query returned %d work item IDs in project '%s'.",
            len(ids),
            project,
        )

        # Step 2: Fetch full work item details by IDs
        # CRITICAL: error_policy='omit' to skip inaccessible items
        api_work_items: list[Any] = []
        batch_size = 200
        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            try:
                api_work_items.extend(
                    wit_client.get_work_items(
                        ids=batch,
                        project=project,
                        expand="fields",
                        error_policy="omit",
                    )
                )
            except AzureDevOpsError:
                raise
            except Exception as exc:
                raise APIError(
                    f"Failed to fetch work item details for "
                    f"{len(ids)} items in project '{project}': {exc}"
                ) from exc

        # Filter out None entries (omitted due to error_policy)
        work_items = [
            WorkItem.from_api_response(item)
            for item in api_work_items
            if item is not None
        ]

        logger.info(
            "Retrieved %d work items from project '%s'.",
            len(work_items),
            project,
        )
        return work_items

    def get_work_item(
        self,
        project: str,
        work_item_id: int,
    ) -> WorkItem:
        """Get a single work item by its ID.

        Retrieves the full details of a specific work item, including
        all standard fields (title, state, type, assigned_to, etc.).

        Args:
            project: The project name or identifier.
            work_item_id: The unique integer ID of the work item.

        Returns:
            A WorkItem object with all fields populated.

        Raises:
            WorkItemNotFoundError: If the work item does not exist
                or is inaccessible.
            APIError: If the API call fails unexpectedly.
        """
        logger.info(
            "Getting work item %d in project '%s'.",
            work_item_id,
            project,
        )

        try:
            wit_client = self._get_wit_client()
            api_work_item = wit_client.get_work_item(
                id=work_item_id,
                expand="fields",
            )
        except AzureDevOpsError:
            raise
        except Exception as exc:
            error_msg = str(exc).lower()
            if "404" in error_msg or "not found" in error_msg:
                raise WorkItemNotFoundError(
                    work_item_id=work_item_id, project=project
                ) from exc
            raise APIError(
                f"Failed to get work item {work_item_id} in project '{project}': {exc}"
            ) from exc

        if api_work_item is None:
            raise WorkItemNotFoundError(work_item_id=work_item_id, project=project)

        work_item = WorkItem.from_api_response(api_work_item)

        logger.info(
            "Retrieved work item %d: '%s' (%s).",
            work_item.id,
            work_item.title,
            work_item.work_item_type,
        )
        return work_item

    def list_backlog_items(
        self,
        project: str,
        item_types: list[str] | None = None,
        max_items: int = 100,
    ) -> list[WorkItem]:
        """List work items from the project backlog.

        Retrieves backlog items that are not in a closed, done, or removed
        state. By default **all** work item types are returned so that
        process-specific/custom types (such as EBP's "RSD") remain findable
        in the import panel. Pass ``item_types`` to narrow the result set.

        Args:
            project: The project name or identifier.
            item_types: Filter by work item types (e.g., ``['Bug',
                'User Story', 'Task']``). If None, no type restriction is
                applied and items of every type are returned.
            max_items: Maximum number of items to return. Defaults to 100.

        Returns:
            A list of WorkItem objects from the backlog, ordered by
            priority. Returns an empty list if the backlog is empty.

        Raises:
            APIError: If the API call fails unexpectedly.
        """
        logger.info(
            "Listing backlog items in project '%s' (types=%s, max_items=%d).",
            project,
            item_types or "all",
            max_items,
        )

        # Build the WIQL WHERE clause. When no explicit work item types are
        # requested we intentionally do NOT restrict by [System.WorkItemType]
        # so that process-specific/custom types (e.g. EBP's "RSD") are
        # returned and stay findable. Callers can still pass ``item_types``
        # to narrow the result set.
        where_clauses = [f"[System.TeamProject] = '{project}'"]
        if item_types:
            type_conditions = " OR ".join(
                f"[System.WorkItemType] = '{wt}'" for wt in item_types
            )
            where_clauses.append(f"({type_conditions})")
        where_clauses += [
            "[System.State] <> 'Closed'",
            "[System.State] <> 'Done'",
            "[System.State] <> 'Removed'",
        ]

        wiql_query = (
            "SELECT [System.Id] FROM WorkItems "
            f"WHERE {' AND '.join(where_clauses)} "
            "ORDER BY [Microsoft.VSTS.Common.Priority] ASC, "
            "[System.CreatedDate] DESC"
        )

        return self.query_work_items(
            project=project,
            query=wiql_query,
            max_items=max_items,
        )

    # ── Write operations (Feature 4.2 — enriched Boards) ────────────

    def create_work_item(
        self,
        project: str,
        work_item_type: str,
        title: str,
        description: str | None = None,
        assigned_to: str | None = None,
        state: str | None = None,
        priority: int | None = None,
        tags: list[str] | None = None,
        area_path: str | None = None,
        iteration_path: str | None = None,
        additional_fields: dict[str, str] | None = None,
    ) -> WorkItem:
        """Create a new work item in an Azure DevOps project.

        Builds a JSON Patch document from the provided fields and sends
        it to the Work Item Tracking API to create a new work item.

        Args:
            project: The project name or identifier.
            work_item_type: The type of work item to create (e.g.,
                ``'Bug'``, ``'Task'``, ``'User Story'``).
            title: The title of the new work item.
            description: Optional HTML description.
            assigned_to: Optional display name or email of the assignee.
            state: Optional initial state (e.g., ``'New'``, ``'Active'``).
            priority: Optional priority level (integer, typically 1-4).
            tags: Optional list of tags to apply.
            area_path: Optional area path.
            iteration_path: Optional iteration/sprint path.
            additional_fields: Optional dict of extra field reference
                names to values (e.g., ``{'Custom.Field': 'value'}``).

        Returns:
            A WorkItem object representing the newly created work item.

        Raises:
            APIError: If the API call fails.
        """
        logger.info(
            "Creating %s '%s' in project '%s'.",
            work_item_type,
            title,
            project,
        )

        from azure.devops.v7_0.work_item_tracking.models import JsonPatchOperation

        patch_document = [
            JsonPatchOperation(
                op="add",
                path="/fields/System.Title",
                value=title,
            )
        ]

        _optional_fields: list[tuple[str, Any]] = [
            ("/fields/System.Description", description),
            ("/fields/System.AssignedTo", assigned_to),
            ("/fields/System.State", state),
            ("/fields/Microsoft.VSTS.Common.Priority", priority),
            ("/fields/System.Tags", "; ".join(tags) if tags else None),
            ("/fields/System.AreaPath", area_path),
            ("/fields/System.IterationPath", iteration_path),
        ]

        for field_path, value in _optional_fields:
            if value is not None:
                patch_document.append(
                    JsonPatchOperation(op="add", path=field_path, value=value)
                )

        if additional_fields:
            for field_name, field_value in additional_fields.items():
                patch_document.append(
                    JsonPatchOperation(
                        op="add",
                        path=f"/fields/{field_name}",
                        value=field_value,
                    )
                )

        try:
            wit_client = self._get_wit_client()
            api_work_item = wit_client.create_work_item(
                document=patch_document,
                project=project,
                type=work_item_type,
            )
        except AzureDevOpsError:
            raise
        except Exception as exc:
            raise APIError(
                f"Failed to create {work_item_type} '{title}' "
                f"in project '{project}': {exc}"
            ) from exc

        work_item = WorkItem.from_api_response(api_work_item)
        logger.info(
            "Created work item %d: '%s' (%s).",
            work_item.id,
            work_item.title,
            work_item.work_item_type,
        )
        return work_item

    def update_work_item(
        self,
        project: str,
        work_item_id: int,
        fields: dict[str, Any],
    ) -> WorkItem:
        """Update an existing work item's fields.

        Supports bidirectional synchronisation by allowing any field to
        be updated, including state transitions.

        Args:
            project: The project name or identifier.
            work_item_id: The ID of the work item to update.
            fields: A dictionary mapping field reference names to their
                new values. Common fields include:
                - ``'System.State'`` — e.g. ``'Active'``, ``'Closed'``
                - ``'System.Title'`` — new title
                - ``'System.AssignedTo'`` — assignee name or email
                - ``'Microsoft.VSTS.Common.Priority'`` — priority int

        Returns:
            The updated WorkItem object.

        Raises:
            WorkItemNotFoundError: If the work item does not exist.
            APIError: If the API call fails.
        """
        logger.info(
            "Updating work item %d in project '%s' (fields: %s).",
            work_item_id,
            project,
            list(fields.keys()),
        )

        from azure.devops.v7_0.work_item_tracking.models import JsonPatchOperation

        patch_document = [
            JsonPatchOperation(
                op="replace",
                path=f"/fields/{field_name}",
                value=value,
            )
            for field_name, value in fields.items()
        ]

        try:
            wit_client = self._get_wit_client()
            api_work_item = wit_client.update_work_item(
                document=patch_document,
                id=work_item_id,
                project=project,
            )
        except AzureDevOpsError:
            raise
        except Exception as exc:
            error_msg = str(exc).lower()
            if "404" in error_msg or "not found" in error_msg:
                raise WorkItemNotFoundError(
                    work_item_id=work_item_id, project=project
                ) from exc
            raise APIError(
                f"Failed to update work item {work_item_id} "
                f"in project '{project}': {exc}"
            ) from exc

        work_item = WorkItem.from_api_response(api_work_item)
        logger.info(
            "Updated work item %d: state='%s'.",
            work_item.id,
            work_item.state,
        )
        return work_item

    def link_work_items(
        self,
        project: str,
        source_id: int,
        target_id: int,
        link_type: str = "System.LinkTypes.Related",
        comment: str | None = None,
    ) -> WorkItem:
        """Create a link between two work items.

        Adds a relation (link) from the source work item to the target
        work item. Common link types include:
        - ``System.LinkTypes.Related`` — general relation
        - ``System.LinkTypes.Hierarchy-Forward`` — parent → child
        - ``System.LinkTypes.Hierarchy-Reverse`` — child → parent
        - ``System.LinkTypes.Dependency-Forward`` — successor
        - ``System.LinkTypes.Dependency-Reverse`` — predecessor

        Args:
            project: The project name or identifier.
            source_id: The ID of the work item to add the link to.
            target_id: The ID of the work item to link to.
            link_type: The relation type reference name. Defaults to
                ``'System.LinkTypes.Related'``.
            comment: Optional comment describing the link.

        Returns:
            The updated source WorkItem with the new relation.

        Raises:
            WorkItemNotFoundError: If either work item does not exist.
            APIError: If the API call fails.
        """
        logger.info(
            "Linking work item %d → %d (type='%s') in project '%s'.",
            source_id,
            target_id,
            link_type,
            project,
        )

        from azure.devops.v7_0.work_item_tracking.models import JsonPatchOperation

        org_url = self._client.settings.organization_url
        target_url = (
            f"{org_url}/{project}/_apis/wit/workItems/{target_id}"
        )

        relation_value: dict[str, Any] = {
            "rel": link_type,
            "url": target_url,
        }
        if comment:
            relation_value["attributes"] = {"comment": comment}

        patch_document = [
            JsonPatchOperation(
                op="add",
                path="/relations/-",
                value=relation_value,
            )
        ]

        try:
            wit_client = self._get_wit_client()
            api_work_item = wit_client.update_work_item(
                document=patch_document,
                id=source_id,
                project=project,
            )
        except AzureDevOpsError:
            raise
        except Exception as exc:
            error_msg = str(exc).lower()
            if "404" in error_msg or "not found" in error_msg:
                raise WorkItemNotFoundError(
                    work_item_id=source_id, project=project
                ) from exc
            raise APIError(
                f"Failed to link work items {source_id} → {target_id} "
                f"in project '{project}': {exc}"
            ) from exc

        work_item = WorkItem.from_api_response(api_work_item)
        logger.info(
            "Linked work item %d → %d.",
            source_id,
            target_id,
        )
        return work_item
