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
const VIEWS_KEY_PREFIX = "kanban-views";

function getStorageKey(projectId: string): string {
	return `${FILTER_KEY_PREFIX}-${projectId}`;
}

function getViewsStorageKey(projectId: string): string {
	return `${VIEWS_KEY_PREFIX}-${projectId}`;
}

/**
 * A named snapshot of the filter + sort state the user can re-apply in one
 * click (e.g. "My bugs", "Sprint 12", "Awaiting me"). Persisted per project.
 */
export interface SavedView {
	id: string;
	name: string;
	filters: KanbanFilters;
	sort: KanbanSort;
}

interface PersistedState {
	filters: KanbanFilters;
	sort: KanbanSort;
}

function isValidSavedView(v: unknown): v is SavedView {
	const candidate = v as Partial<SavedView> | null;
	return (
		!!candidate &&
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		!!candidate.filters &&
		!!candidate.sort
	);
}

function loadViewsFromStorage(projectId: string): SavedView[] {
	try {
		const raw = localStorage.getItem(getViewsStorageKey(projectId));
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter(isValidSavedView);
			}
		}
	} catch {
		// Corrupt/missing cache — start with no saved views.
	}
	return [];
}

function saveViewsToStorage(
	projectId: string | null,
	views: SavedView[],
): void {
	if (!projectId) return;
	try {
		localStorage.setItem(getViewsStorageKey(projectId), JSON.stringify(views));
	} catch {
		// localStorage write failed — non-critical.
	}
}

/**
 * Mirror a partial board-state write to the main process, so filters/sort and
 * saved views survive across machines in server mode (localStorage is per-device).
 * Best-effort and guarded so it's a no-op when electronAPI is absent (tests).
 */
function saveBoardStateToMain(
	projectId: string | null,
	partial: { filters?: KanbanFilters; sort?: KanbanSort; savedViews?: SavedView[] },
): void {
	if (!projectId) return;
	try {
		globalThis.electronAPI?.saveKanbanBoardState(projectId, partial)?.catch(
			() => {
				// non-critical — localStorage cache still holds the state
			},
		);
	} catch {
		// electronAPI unavailable (e.g. tests) — ignore
	}
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
	/** Named filter+sort presets for the active project. */
	savedViews: SavedView[];

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
	/** Snapshot the current filters+sort as a named, re-applicable view. */
	saveCurrentView: (name: string) => void;
	/** Re-apply a saved view's filters+sort. */
	applyView: (id: string) => void;
	/** Delete a saved view. */
	deleteView: (id: string) => void;
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
		saveBoardStateToMain(projectId, { filters, sort });
	};

	return {
		projectId: null,
		filters: { ...EMPTY_FILTERS },
		sort: { ...DEFAULT_SORT },
		savedViews: [],

		loadForProject: (projectId) => {
			if (get().projectId === projectId) return;
			const { filters, sort } = loadFromStorage(projectId);
			set({
				projectId,
				filters,
				sort,
				savedViews: loadViewsFromStorage(projectId),
			});

			// Async: pull the main-process copy (source of truth, shared across
			// machines in server mode) and override the local cache if present.
			(async () => {
				try {
					const result =
						await globalThis.electronAPI?.getKanbanBoardState(projectId);
					// Discard if the user switched projects while the IPC was in flight.
					if (get().projectId !== projectId || !result?.success || !result.data)
						return;
					const data = result.data;
					const patch: Partial<
						Pick<KanbanFilterState, "filters" | "sort" | "savedViews">
					> = {};
					if (data.filters && typeof data.filters === "object") {
						patch.filters = {
							...EMPTY_FILTERS,
							...(data.filters as Partial<KanbanFilters>),
						};
					}
					if (data.sort && typeof data.sort === "object") {
						patch.sort = {
							...DEFAULT_SORT,
							...(data.sort as Partial<KanbanSort>),
						};
					}
					if (Array.isArray(data.savedViews)) {
						patch.savedViews = data.savedViews.filter(isValidSavedView);
					}
					if (Object.keys(patch).length === 0) return;
					set(patch);
					// Refresh the localStorage caches with the source of truth.
					if (patch.filters || patch.sort) {
						const next = get();
						saveToStorage(projectId, next.filters, next.sort);
					}
					if (patch.savedViews) {
						saveViewsToStorage(projectId, patch.savedViews);
					}
				} catch {
					// IPC unavailable/failed — keep localStorage/defaults
				}
			})();
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

		saveCurrentView: (name) => {
			const trimmed = name.trim();
			if (!trimmed) return;
			const { filters, sort, savedViews, projectId } = get();
			const view: SavedView = {
				id:
					globalThis.crypto?.randomUUID?.() ??
					`view-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				name: trimmed,
				// Deep-copy so later edits to the live filters don't mutate the view.
				filters: {
					...filters,
					sources: [...filters.sources],
					categories: [...filters.categories],
					priorities: [...filters.priorities],
				},
				sort: { ...sort },
			};
			const nextViews = [...savedViews, view];
			set({ savedViews: nextViews });
			saveViewsToStorage(projectId, nextViews);
			saveBoardStateToMain(projectId, { savedViews: nextViews });
		},

		applyView: (id) => {
			const view = get().savedViews.find((v) => v.id === id);
			if (!view) return;
			set({
				filters: {
					...view.filters,
					sources: [...view.filters.sources],
					categories: [...view.filters.categories],
					priorities: [...view.filters.priorities],
				},
				sort: { ...view.sort },
			});
			persist();
		},

		deleteView: (id) => {
			const { savedViews, projectId } = get();
			const nextViews = savedViews.filter((v) => v.id !== id);
			set({ savedViews: nextViews });
			saveViewsToStorage(projectId, nextViews);
			saveBoardStateToMain(projectId, { savedViews: nextViews });
		},
	};
});
