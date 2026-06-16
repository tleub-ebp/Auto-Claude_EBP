import { create } from "zustand";
import type { TaskCategory, TaskPriority } from "../../shared/types";
import {
	DEFAULT_SORT,
	EMPTY_FILTERS,
	type KanbanFilters,
	type KanbanSort,
	type TaskSortDirection,
	type TaskSortField,
	type TaskSource,
} from "../lib/kanban-filter";

// ============================================
// Persistence (per-project localStorage)
// ============================================

const FILTER_KEY_PREFIX = "kanban-filters";

function getStorageKey(projectId: string): string {
	return `${FILTER_KEY_PREFIX}-${projectId}`;
}

interface PersistedState {
	filters: KanbanFilters;
	sort: KanbanSort;
}

function loadFromStorage(projectId: string): PersistedState {
	try {
		const raw = localStorage.getItem(getStorageKey(projectId));
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<PersistedState>;
			return {
				filters: { ...EMPTY_FILTERS, ...parsed.filters },
				sort: { ...DEFAULT_SORT, ...parsed.sort },
			};
		}
	} catch {
		// Corrupt/missing cache — fall back to defaults.
	}
	return { filters: { ...EMPTY_FILTERS }, sort: { ...DEFAULT_SORT } };
}

function saveToStorage(
	projectId: string | null,
	filters: KanbanFilters,
	sort: KanbanSort,
): void {
	if (!projectId) return;
	try {
		localStorage.setItem(
			getStorageKey(projectId),
			JSON.stringify({ filters, sort }),
		);
	} catch {
		// localStorage write failed — non-critical, state still lives in memory.
	}
}

// ============================================
// Store
// ============================================

interface KanbanFilterState {
	/** Project the in-memory state currently belongs to. */
	projectId: string | null;
	filters: KanbanFilters;
	sort: KanbanSort;

	/** Load (or reset to) the persisted state for a project. */
	loadForProject: (projectId: string) => void;
	setSearch: (search: string) => void;
	toggleSource: (source: TaskSource) => void;
	toggleCategory: (category: TaskCategory) => void;
	togglePriority: (priority: TaskPriority) => void;
	setSortField: (field: TaskSortField) => void;
	setSortDirection: (direction: TaskSortDirection) => void;
	toggleSortDirection: () => void;
	/** Clear filters only (keeps the chosen sort). */
	clearFilters: () => void;
}

/** Toggle a value's presence in an array (immutably). */
function toggleInArray<T>(arr: T[], value: T): T[] {
	return arr.includes(value)
		? arr.filter((v) => v !== value)
		: [...arr, value];
}

export const useKanbanFilterStore = create<KanbanFilterState>((set, get) => {
	/** Persist whatever is currently in the store for the active project. */
	const persist = () => {
		const { projectId, filters, sort } = get();
		saveToStorage(projectId, filters, sort);
	};

	return {
		projectId: null,
		filters: { ...EMPTY_FILTERS },
		sort: { ...DEFAULT_SORT },

		loadForProject: (projectId) => {
			if (get().projectId === projectId) return;
			const { filters, sort } = loadFromStorage(projectId);
			set({ projectId, filters, sort });
		},

		setSearch: (search) => {
			set((state) => ({ filters: { ...state.filters, search } }));
			persist();
		},

		toggleSource: (source) => {
			set((state) => ({
				filters: {
					...state.filters,
					sources: toggleInArray(state.filters.sources, source),
				},
			}));
			persist();
		},

		toggleCategory: (category) => {
			set((state) => ({
				filters: {
					...state.filters,
					categories: toggleInArray(state.filters.categories, category),
				},
			}));
			persist();
		},

		togglePriority: (priority) => {
			set((state) => ({
				filters: {
					...state.filters,
					priorities: toggleInArray(state.filters.priorities, priority),
				},
			}));
			persist();
		},

		setSortField: (field) => {
			set((state) => ({ sort: { ...state.sort, field } }));
			persist();
		},

		setSortDirection: (direction) => {
			set((state) => ({ sort: { ...state.sort, direction } }));
			persist();
		},

		toggleSortDirection: () => {
			set((state) => ({
				sort: {
					...state.sort,
					direction: state.sort.direction === "asc" ? "desc" : "asc",
				},
			}));
			persist();
		},

		clearFilters: () => {
			set({ filters: { ...EMPTY_FILTERS } });
			persist();
		},
	};
});
