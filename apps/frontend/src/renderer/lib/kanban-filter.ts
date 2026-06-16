/**
 * Kanban filtering & sorting helpers.
 *
 * Shared between the filter store, the KanbanToolbar UI and the KanbanBoard
 * so the logic (which source a task belongs to, whether it matches the active
 * filters, how to order columns) lives in a single place.
 */

import { TASK_PRIORITY_LABELS } from "../../shared/constants";
import type {
	Task,
	TaskCategory,
	TaskPriority,
} from "../../shared/types";
import { extractTextFromHtml } from "./utils";

/**
 * Logical origin of a task, used as a filter dimension. Mirrors
 * TaskMetadata.sourceType but collapses the tracker-specific identifiers
 * (Azure DevOps / Jira / Linear) into stable buckets.
 */
export type TaskSource =
	| "azure-devops"
	| "jira"
	| "linear"
	| "github"
	| "gitlab"
	| "ideation"
	| "roadmap"
	| "insights"
	| "manual";

/** Field a column can be sorted by. "manual" preserves the drag-and-drop order. */
export type TaskSortField =
	| "manual"
	| "created"
	| "updated"
	| "priority"
	| "title";

export type TaskSortDirection = "asc" | "desc";

/** Active filter selection. Empty arrays mean "no constraint on this dimension". */
export interface KanbanFilters {
	/** Free-text query matched against title + description (case-insensitive). */
	search: string;
	sources: TaskSource[];
	categories: TaskCategory[];
	priorities: TaskPriority[];
}

export interface KanbanSort {
	field: TaskSortField;
	direction: TaskSortDirection;
}

export const EMPTY_FILTERS: KanbanFilters = {
	search: "",
	sources: [],
	categories: [],
	priorities: [],
};

export const DEFAULT_SORT: KanbanSort = {
	field: "manual",
	direction: "desc",
};

/** All selectable source buckets (drives the filter UI). */
export const TASK_SOURCES: TaskSource[] = [
	"azure-devops",
	"jira",
	"linear",
	"github",
	"gitlab",
	"ideation",
	"roadmap",
	"insights",
	"manual",
];

/** Numeric weight for priority sorting (higher = more urgent). */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
	urgent: 4,
	high: 3,
	medium: 2,
	low: 1,
};

/**
 * Determine which logical source a task originates from. Tracker identifiers
 * take precedence over the coarser `sourceType`, so an imported Azure DevOps
 * work item (sourceType === "imported") still resolves to "azure-devops".
 */
export function getTaskSource(task: Task): TaskSource {
	const m = task.metadata;
	if (!m) return "manual";
	if (m.azureDevOpsIdentifier || m.importSource === "azure-devops") {
		return "azure-devops";
	}
	if (m.jiraIdentifier || m.importSource === "jira") return "jira";
	if (m.linearIdentifier || m.sourceType === "linear") return "linear";
	if (m.sourceType === "github") return "github";
	if (m.sourceType === "gitlab") return "gitlab";
	if (m.sourceType === "ideation") return "ideation";
	if (m.sourceType === "roadmap") return "roadmap";
	if (m.sourceType === "insights") return "insights";
	return "manual";
}

/** True when at least one filter dimension is constraining the result set. */
export function hasActiveFilters(filters: KanbanFilters): boolean {
	return (
		filters.search.trim().length > 0 ||
		filters.sources.length > 0 ||
		filters.categories.length > 0 ||
		filters.priorities.length > 0
	);
}

/** Count of active filter dimensions, shown as a badge on the filter button. */
export function activeFilterCount(filters: KanbanFilters): number {
	let count = 0;
	if (filters.search.trim().length > 0) count++;
	count += filters.sources.length;
	count += filters.categories.length;
	count += filters.priorities.length;
	return count;
}

/** Test whether a task satisfies every active filter dimension. */
export function taskMatchesFilters(
	task: Task,
	filters: KanbanFilters,
): boolean {
	if (filters.sources.length > 0) {
		if (!filters.sources.includes(getTaskSource(task))) return false;
	}

	if (filters.categories.length > 0) {
		const category = task.metadata?.category;
		if (!category || !filters.categories.includes(category)) return false;
	}

	if (filters.priorities.length > 0) {
		const priority = task.metadata?.priority;
		if (!priority || !filters.priorities.includes(priority)) return false;
	}

	const query = filters.search.trim().toLowerCase();
	if (query.length > 0) {
		const title = (task.title || "").toLowerCase();
		const description = extractTextFromHtml(task.description || "").toLowerCase();
		// Tracker identifiers are searchable too (e.g. typing "PROJ-12" or "12345").
		const identifier = (
			task.metadata?.azureDevOpsIdentifier ||
			task.metadata?.jiraIdentifier ||
			task.metadata?.linearIdentifier ||
			""
		).toLowerCase();
		if (
			!title.includes(query) &&
			!description.includes(query) &&
			!identifier.includes(query)
		) {
			return false;
		}
	}

	return true;
}

/**
 * Comparator for the non-manual sort fields. Returns a stable ordering; the
 * caller applies the chosen direction. "manual" is handled by the board's own
 * custom-order logic and never reaches this function.
 */
export function compareTasksBySort(a: Task, b: Task, sort: KanbanSort): number {
	let result = 0;
	switch (sort.field) {
		case "created":
			result =
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
			break;
		case "updated":
			result =
				new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
			break;
		case "priority": {
			const pa = a.metadata?.priority
				? PRIORITY_WEIGHT[a.metadata.priority]
				: 0;
			const pb = b.metadata?.priority
				? PRIORITY_WEIGHT[b.metadata.priority]
				: 0;
			result = pa - pb;
			break;
		}
		case "title":
			result = (a.title || "").localeCompare(b.title || "");
			break;
		default:
			result = 0;
			break;
	}
	// Tie-breaker keeps the order deterministic when the field is equal.
	if (result === 0) {
		result = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
	}
	return sort.direction === "asc" ? result : -result;
}

/** i18n-independent priority label fallback (used only when a key is missing). */
export function priorityLabelFallback(priority: TaskPriority): string {
	return TASK_PRIORITY_LABELS[priority] ?? priority;
}
