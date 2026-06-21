/**
 * Kanban card "aging" helpers.
 *
 * A card that sits untouched in an actionable column for too long is a flow
 * smell — a stuck agent, a forgotten review, a red build nobody picked up.
 * These pure helpers turn `task.updatedAt` into a coarse heat level the board
 * can render as a colored accent, so stale work surfaces itself.
 */

import type { Task, TaskStatus } from "../../shared/types";

export type AgingLevel = "none" | "aging" | "stuck";

/**
 * Per-column patience, in hours: how long a card may sit before it reads as
 * "aging" (amber) then "stuck" (red). Columns absent from this map never age
 * (e.g. `done` / `pr_created` — terminal states where idleness is expected).
 */
const AGING_THRESHOLDS_HOURS: Partial<
	Record<TaskStatus, { aging: number; stuck: number }>
> = {
	// Active work should move fast — a multi-hour idle in_progress card is suspect.
	in_progress: { aging: 4, stuck: 12 },
	ai_review: { aging: 6, stuck: 24 },
	build_failed: { aging: 6, stuck: 24 },
	error: { aging: 6, stuck: 24 },
	// Waiting on a human: more patience, but a 3-day-old review is forgotten.
	human_review: { aging: 24, stuck: 72 },
	queue: { aging: 48, stuck: 120 },
	// Backlog can legitimately rest for a while.
	backlog: { aging: 168, stuck: 336 }, // 7 days / 14 days
};

/** Hours elapsed since the task was last touched (clamped at 0). */
export function getTaskAgingHours(task: Task, now: number = Date.now()): number {
	const updated = new Date(task.updatedAt).getTime();
	if (!Number.isFinite(updated)) return 0;
	return Math.max(0, (now - updated) / 3_600_000);
}

/** Coarse heat level for a task based on how long it has idled in its column. */
export function getTaskAgingLevel(
	task: Task,
	now: number = Date.now(),
): AgingLevel {
	const thresholds = AGING_THRESHOLDS_HOURS[task.status];
	if (!thresholds) return "none";
	const hours = getTaskAgingHours(task, now);
	if (hours >= thresholds.stuck) return "stuck";
	if (hours >= thresholds.aging) return "aging";
	return "none";
}

/**
 * Compact, locale-independent idle-duration label ("3j", "5h", "12min").
 * French short units to match the rest of the kanban surface; kept here rather
 * than in i18n because it's a numeric format, not prose.
 */
export function formatAgingDuration(hours: number): string {
	if (hours >= 24) return `${Math.floor(hours / 24)}j`;
	if (hours >= 1) return `${Math.floor(hours)}h`;
	return `${Math.max(1, Math.floor(hours * 60))}min`;
}

/** Count tasks at each non-"none" aging level (board-wide flow signal). */
export function countAgingTasks(
	tasks: Task[],
	now: number = Date.now(),
): { aging: number; stuck: number } {
	let aging = 0;
	let stuck = 0;
	for (const task of tasks) {
		const level = getTaskAgingLevel(task, now);
		if (level === "stuck") stuck++;
		else if (level === "aging") aging++;
	}
	return { aging, stuck };
}

export interface AgingTaskEntry {
	task: Task;
	level: Exclude<AgingLevel, "none">;
	hours: number;
}

/**
 * The actual list of stale tasks, worst first (stuck before aging, then by
 * longest idle). Drives the board's "stale tasks" popover so the signal is a
 * concrete, clickable list rather than an opaque counter.
 */
export function listAgingTasks(
	tasks: Task[],
	now: number = Date.now(),
): AgingTaskEntry[] {
	const entries: AgingTaskEntry[] = [];
	for (const task of tasks) {
		const level = getTaskAgingLevel(task, now);
		if (level !== "none") {
			entries.push({ task, level, hours: getTaskAgingHours(task, now) });
		}
	}
	entries.sort((a, b) => {
		if (a.level !== b.level) return a.level === "stuck" ? -1 : 1;
		return b.hours - a.hours;
	});
	return entries;
}
