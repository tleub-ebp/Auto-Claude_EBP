/**
 * Kanban board column preference types
 * Shared across IPC boundary (main process, preload, renderer)
 */

/**
 * Column preferences for a single kanban column
 */
export interface KanbanColumnPreference {
	/** Column width in pixels (180-600px range) */
	width: number;
	/** Whether the column is collapsed (narrow vertical strip) */
	isCollapsed: boolean;
	/** Whether the column width is locked (prevents resize) */
	isLocked: boolean;
	/**
	 * Soft Work-In-Progress limit for this column. When set and the task count
	 * exceeds it, the column count badge turns amber to flag the overflow.
	 * `undefined` means no limit. Persisted alongside the other column prefs.
	 */
	wipLimit?: number;
}

/**
 * All column preferences keyed by column status (e.g., 'backlog', 'in_progress', 'done')
 */
export type KanbanPreferences = Record<string, KanbanColumnPreference>;

/**
 * Per-project board view-state persisted in the main process (alongside the
 * column preferences) so filters, column order and saved views survive across
 * machines in server mode — not just in the local browser cache.
 *
 * The renderer owns the precise filter/sort/saved-view shapes and validates
 * them on read, so they stay intentionally opaque (`unknown`) here to avoid a
 * shared→renderer type dependency. Persisted as a merge of partial writes from
 * the settings store (`columnOrder`) and the filter store (the rest).
 */
export interface KanbanBoardState {
	/** Column display order — status column ids. */
	columnOrder?: string[];
	/** Active filters (renderer-validated KanbanFilters). */
	filters?: unknown;
	/** Active sort (renderer-validated KanbanSort). */
	sort?: unknown;
	/** Named filter+sort presets (renderer-validated SavedView[]). */
	savedViews?: unknown;
}
