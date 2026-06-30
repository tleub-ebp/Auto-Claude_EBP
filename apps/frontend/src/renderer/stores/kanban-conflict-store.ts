import { create } from "zustand";

/**
 * Board-level plan-conflict surfacing.
 *
 * The plan conflict check (file-overlap between two task plans) already exists
 * for the plan-review modal. This store lets the kanban board run it for the
 * few actively-parallel tasks (in_progress / ai_review) and lets each card read
 * *its own* conflict entry by id — so a card re-renders only when its own
 * conflict status changes, without prop-drilling through the memoized columns.
 */

export interface BoardConflictInfo {
	/** Titles of other active tasks whose plans overlap this one. */
	titles: string[];
	/** Total distinct overlapping files across those tasks. */
	files: number;
}

interface KanbanConflictState {
	/** Conflict info keyed by task id (absent = no known conflict). */
	conflicts: Record<string, BoardConflictInfo>;
	/** Replace the whole conflict map (board recomputes it as a batch). */
	setConflicts: (next: Record<string, BoardConflictInfo>) => void;
	/** Drop all conflict info (e.g. when leaving a project). */
	clear: () => void;
}

export const useKanbanConflictStore = create<KanbanConflictState>((set) => ({
	conflicts: {},
	setConflicts: (next) => set({ conflicts: next }),
	clear: () => set({ conflicts: {} }),
}));
