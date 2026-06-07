"""Unit tests for AzureWorkItemsClient work item operations.

Tests the work item client lifecycle including:
- Querying work items via WIQL (success, empty results, API errors)
- Getting a single work item (success, not found, API errors)
- Listing backlog items (default types, custom types, delegation)
- AzureDevOpsError passthrough for all operations
- Filtering of None entries from error_policy='omit' responses
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

from src.connectors.azure_devops.exceptions import (
    APIError,
    AuthenticationError,
    WorkItemNotFoundError,
)
from src.connectors.azure_devops.models import WorkItem

TEST_PROJECT = "TestProject"


# ── query_work_items tests ────────────────────────────────────────


class TestQueryWorkItems:
    """Tests for AzureWorkItemsClient.query_work_items()."""

    def test_returns_work_items(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
        sample_api_work_item,
        sample_api_work_item_minimal,
        sample_api_work_item_string_assigned,
    ):
        """query_work_items() maps API responses to WorkItem models."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.return_value = [
            sample_api_work_item,
            sample_api_work_item_minimal,
            sample_api_work_item_string_assigned,
        ]

        query = "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"
        result = work_items_client.query_work_items(TEST_PROJECT, query)

        assert len(result) == 3
        assert all(isinstance(item, WorkItem) for item in result)

    def test_returns_correct_work_item_data(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
        sample_api_work_item,
    ):
        """query_work_items() correctly maps work item fields."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.return_value = [
            sample_api_work_item,
        ]

        query = "SELECT [System.Id] FROM WorkItems"
        result = work_items_client.query_work_items(TEST_PROJECT, query)

        item = result[0]
        assert item.id == 42
        assert item.title == "Fix login page timeout"
        assert item.state == "Active"
        assert item.work_item_type == "Bug"
        assert item.assigned_to == "John Doe"
        assert item.priority == 1

    def test_returns_empty_list_when_no_results(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """query_work_items() returns an empty list when WIQL returns no IDs."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        query = "SELECT [System.Id] FROM WorkItems WHERE 1=0"
        result = work_items_client.query_work_items(TEST_PROJECT, query)

        assert result == []
        mock_wit_client.get_work_items.assert_not_called()

    def test_returns_empty_list_when_work_items_is_none(
        self,
        work_items_client,
        mock_wit_client,
    ):
        """query_work_items() returns empty list when work_items attr is None."""
        mock_wit_client.query_by_wiql.return_value = MagicMock(work_items=None)

        query = "SELECT [System.Id] FROM WorkItems"
        result = work_items_client.query_work_items(TEST_PROJECT, query)

        assert result == []
        mock_wit_client.get_work_items.assert_not_called()

    def test_passes_correct_parameters_to_wiql(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """query_work_items() passes correct team_context and top to query_by_wiql."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        query = "SELECT [System.Id] FROM WorkItems"
        work_items_client.query_work_items(TEST_PROJECT, query, max_items=50)

        call_kwargs = mock_wit_client.query_by_wiql.call_args.kwargs
        assert call_kwargs["team_context"].project == TEST_PROJECT
        assert call_kwargs["top"] == 50

    def test_passes_work_item_ids_to_get_work_items(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
        sample_api_work_item,
    ):
        """query_work_items() fetches details for the IDs returned by WIQL."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.return_value = [
            sample_api_work_item,
        ]

        query = "SELECT [System.Id] FROM WorkItems"
        work_items_client.query_work_items(TEST_PROJECT, query)

        call_kwargs = mock_wit_client.get_work_items.call_args.kwargs
        assert call_kwargs["ids"] == [42, 55, 99]
        assert call_kwargs["project"] == TEST_PROJECT
        assert call_kwargs["error_policy"] == "omit"

    def test_filters_none_entries_from_results(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
        sample_api_work_item,
    ):
        """query_work_items() filters out None entries from error_policy='omit'."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.return_value = [
            sample_api_work_item,
            None,
            None,
        ]

        query = "SELECT [System.Id] FROM WorkItems"
        result = work_items_client.query_work_items(TEST_PROJECT, query)

        assert len(result) == 1
        assert result[0].id == 42

    def test_wiql_failure_raises_api_error(self, work_items_client, mock_wit_client):
        """query_work_items() wraps WIQL query errors as APIError."""
        mock_wit_client.query_by_wiql.side_effect = RuntimeError("Invalid WIQL syntax")

        with pytest.raises(APIError, match="Failed to execute WIQL query"):
            work_items_client.query_work_items(TEST_PROJECT, "INVALID WIQL")

    def test_fetch_details_failure_raises_api_error(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
    ):
        """query_work_items() wraps get_work_items errors as APIError."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.side_effect = RuntimeError("Timeout exceeded")

        with pytest.raises(APIError, match="Failed to fetch work item details"):
            work_items_client.query_work_items(
                TEST_PROJECT, "SELECT [System.Id] FROM WorkItems"
            )

    def test_azure_devops_error_passthrough_on_query(
        self, work_items_client, mock_wit_client
    ):
        """query_work_items() re-raises AzureDevOpsError on WIQL query."""
        mock_wit_client.query_by_wiql.side_effect = AuthenticationError("Token expired")

        with pytest.raises(AuthenticationError, match="Token expired"):
            work_items_client.query_work_items(
                TEST_PROJECT, "SELECT [System.Id] FROM WorkItems"
            )

    def test_azure_devops_error_passthrough_on_fetch(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
    ):
        """query_work_items() re-raises AzureDevOpsError on detail fetch."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.side_effect = AuthenticationError(
            "Session expired"
        )

        with pytest.raises(AuthenticationError, match="Session expired"):
            work_items_client.query_work_items(
                TEST_PROJECT, "SELECT [System.Id] FROM WorkItems"
            )

    def test_respects_default_max_items(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """query_work_items() defaults max_items to 100."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.query_work_items(
            TEST_PROJECT, "SELECT [System.Id] FROM WorkItems"
        )

        call_kwargs = mock_wit_client.query_by_wiql.call_args.kwargs
        assert call_kwargs["top"] == 100


# ── get_work_item tests ───────────────────────────────────────────


class TestGetWorkItem:
    """Tests for AzureWorkItemsClient.get_work_item()."""

    def test_returns_work_item(
        self,
        work_items_client,
        mock_wit_client,
        sample_api_work_item,
    ):
        """get_work_item() returns a WorkItem model for a valid ID."""
        mock_wit_client.get_work_item.return_value = sample_api_work_item

        result = work_items_client.get_work_item(TEST_PROJECT, 42)

        assert isinstance(result, WorkItem)
        assert result.id == 42

    def test_returns_correct_work_item_data(
        self,
        work_items_client,
        mock_wit_client,
        sample_api_work_item,
    ):
        """get_work_item() correctly maps all work item fields."""
        mock_wit_client.get_work_item.return_value = sample_api_work_item

        result = work_items_client.get_work_item(TEST_PROJECT, 42)

        assert result.title == "Fix login page timeout"
        assert result.state == "Active"
        assert result.work_item_type == "Bug"
        assert result.assigned_to == "John Doe"
        assert result.description == "<p>Login page times out after 30s.</p>"
        assert result.tags == ["frontend", "urgent"]
        assert result.priority == 1
        assert result.area_path == f"{TEST_PROJECT}\\Web"
        assert result.iteration_path == f"{TEST_PROJECT}\\Sprint 5"

    def test_calls_api_with_correct_params(
        self,
        work_items_client,
        mock_wit_client,
        sample_api_work_item,
    ):
        """get_work_item() passes the correct ID to the API."""
        mock_wit_client.get_work_item.return_value = sample_api_work_item

        work_items_client.get_work_item(TEST_PROJECT, 42)

        mock_wit_client.get_work_item.assert_called_once_with(
            id=42,
            expand="fields",
        )

    def test_404_raises_work_item_not_found(self, work_items_client, mock_wit_client):
        """get_work_item() maps 404 errors to WorkItemNotFoundError."""
        mock_wit_client.get_work_item.side_effect = Exception("HTTP 404 Not Found")

        with pytest.raises(WorkItemNotFoundError) as exc_info:
            work_items_client.get_work_item(TEST_PROJECT, 999)

        assert exc_info.value.work_item_id == 999
        assert exc_info.value.project == TEST_PROJECT

    def test_not_found_text_raises_work_item_not_found(
        self, work_items_client, mock_wit_client
    ):
        """get_work_item() maps 'not found' text to WorkItemNotFoundError."""
        mock_wit_client.get_work_item.side_effect = Exception(
            "Resource not found on server"
        )

        with pytest.raises(WorkItemNotFoundError) as exc_info:
            work_items_client.get_work_item(TEST_PROJECT, 888)

        assert exc_info.value.work_item_id == 888

    def test_none_response_raises_work_item_not_found(
        self, work_items_client, mock_wit_client
    ):
        """get_work_item() raises WorkItemNotFoundError when API returns None."""
        mock_wit_client.get_work_item.return_value = None

        with pytest.raises(WorkItemNotFoundError) as exc_info:
            work_items_client.get_work_item(TEST_PROJECT, 777)

        assert exc_info.value.work_item_id == 777
        assert exc_info.value.project == TEST_PROJECT

    def test_api_failure_raises_api_error(self, work_items_client, mock_wit_client):
        """get_work_item() wraps unexpected errors as APIError."""
        mock_wit_client.get_work_item.side_effect = RuntimeError("Connection refused")

        with pytest.raises(APIError, match="Failed to get work item 42"):
            work_items_client.get_work_item(TEST_PROJECT, 42)

    def test_azure_devops_error_passthrough(self, work_items_client, mock_wit_client):
        """get_work_item() re-raises AzureDevOpsError subclasses directly."""
        mock_wit_client.get_work_item.side_effect = AuthenticationError("Access denied")

        with pytest.raises(AuthenticationError, match="Access denied"):
            work_items_client.get_work_item(TEST_PROJECT, 42)

    def test_handles_minimal_work_item(
        self,
        work_items_client,
        mock_wit_client,
        sample_api_work_item_minimal,
    ):
        """get_work_item() handles work items with minimal fields."""
        mock_wit_client.get_work_item.return_value = sample_api_work_item_minimal

        result = work_items_client.get_work_item(TEST_PROJECT, 99)

        assert result.id == 99
        assert result.title == "Minimal work item"
        assert result.assigned_to is None
        assert result.tags == []
        assert result.priority is None

    def test_handles_string_assigned_to(
        self,
        work_items_client,
        mock_wit_client,
        sample_api_work_item_string_assigned,
    ):
        """get_work_item() handles AssignedTo as a plain string."""
        mock_wit_client.get_work_item.return_value = (
            sample_api_work_item_string_assigned
        )

        result = work_items_client.get_work_item(TEST_PROJECT, 55)

        assert result.assigned_to == "Jane Smith"


# ── list_backlog_items tests ──────────────────────────────────────


class TestListBacklogItems:
    """Tests for AzureWorkItemsClient.list_backlog_items()."""

    def test_returns_backlog_items(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result,
        sample_api_work_item,
    ):
        """list_backlog_items() returns WorkItem models from the backlog."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result
        mock_wit_client.get_work_items.return_value = [
            sample_api_work_item,
        ]

        result = work_items_client.list_backlog_items(TEST_PROJECT)

        assert len(result) == 1
        assert isinstance(result[0], WorkItem)

    def test_no_type_filter_when_none_specified(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() does not restrict by type when none specified.

        Every work item type — including custom/process-specific ones such as
        EBP's "RSD" — must stay findable, so the WIQL query omits any
        [System.WorkItemType] condition unless explicit types are passed.
        """
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.list_backlog_items(TEST_PROJECT)

        wiql_arg = mock_wit_client.query_by_wiql.call_args.kwargs["wiql"]
        query = wiql_arg.query
        assert "[System.WorkItemType]" not in query

    def test_accepts_custom_item_types(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() uses custom item types when provided."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        custom_types = ["Epic", "Feature"]
        work_items_client.list_backlog_items(TEST_PROJECT, item_types=custom_types)

        wiql_arg = mock_wit_client.query_by_wiql.call_args.kwargs["wiql"]
        query = wiql_arg.query
        assert "[System.WorkItemType] = 'Epic'" in query
        assert "[System.WorkItemType] = 'Feature'" in query
        # Default types should not appear
        assert "[System.WorkItemType] = 'Task'" not in query

    def test_excludes_closed_done_removed_states(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() excludes Closed, Done, and Removed states."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.list_backlog_items(TEST_PROJECT)

        wiql_arg = mock_wit_client.query_by_wiql.call_args.kwargs["wiql"]
        query = wiql_arg.query
        assert "[System.State] <> 'Closed'" in query
        assert "[System.State] <> 'Done'" in query
        assert "[System.State] <> 'Removed'" in query

    def test_orders_by_priority_then_created_date(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() orders results by Priority ASC, CreatedDate DESC."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.list_backlog_items(TEST_PROJECT)

        wiql_arg = mock_wit_client.query_by_wiql.call_args.kwargs["wiql"]
        query = wiql_arg.query
        assert "[Microsoft.VSTS.Common.Priority] ASC" in query
        assert "[System.CreatedDate] DESC" in query

    def test_filters_by_project(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() filters work items by the given project."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.list_backlog_items(TEST_PROJECT)

        wiql_arg = mock_wit_client.query_by_wiql.call_args.kwargs["wiql"]
        query = wiql_arg.query
        assert f"[System.TeamProject] = '{TEST_PROJECT}'" in query

    def test_passes_max_items_to_query(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() passes max_items to the WIQL query."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        work_items_client.list_backlog_items(TEST_PROJECT, max_items=25)

        call_kwargs = mock_wit_client.query_by_wiql.call_args.kwargs
        assert call_kwargs["top"] == 25

    def test_returns_empty_list_for_empty_backlog(
        self,
        work_items_client,
        mock_wit_client,
        sample_wiql_result_empty,
    ):
        """list_backlog_items() returns an empty list for an empty backlog."""
        mock_wit_client.query_by_wiql.return_value = sample_wiql_result_empty

        result = work_items_client.list_backlog_items(TEST_PROJECT)

        assert result == []

    def test_api_failure_raises_api_error(self, work_items_client, mock_wit_client):
        """list_backlog_items() propagates APIError from query_work_items."""
        mock_wit_client.query_by_wiql.side_effect = RuntimeError("Service unavailable")

        with pytest.raises(APIError, match="Failed to execute WIQL query"):
            work_items_client.list_backlog_items(TEST_PROJECT)
