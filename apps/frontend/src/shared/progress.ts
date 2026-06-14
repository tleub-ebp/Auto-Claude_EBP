/**
 * Shared progress calculation utilities
 * Used by both main and renderer processes
 */
import type { Subtask, SubtaskStatus } from "./types";

/**
 * Subtask statuses that count as "done" for progress purposes.
 *
 * Mirrors the backend `core/progress.py::count_subtasks`, which treats both
 * "completed" and "blocked" as done: a blocked subtask (e.g. an e2e test that
 * must be run manually) can't be processed by the agent, so it must not hold the
 * build back nor make a finished build look incomplete (e.g. 2/3 at 67%).
 */
export const DONE_SUBTASK_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"blocked",
]);

/** True when a subtask is "done" (completed or blocked). */
export function isSubtaskDone(status: string): boolean {
	return DONE_SUBTASK_STATUSES.has(status);
}

/**
 * Calculate progress percentage from subtasks
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
	if (subtasks.length === 0) return 0;
	const done = subtasks.filter((c) => isSubtaskDone(c.status)).length;
	return Math.round((done / subtasks.length) * 100);
}

/**
 * Count subtasks by status
 * @param subtasks Array of subtasks
 * @returns Object with counts per status
 */
export function countSubtasksByStatus(
	subtasks: Subtask[],
): Record<SubtaskStatus, number> {
	return {
		pending: subtasks.filter((c) => c.status === "pending").length,
		in_progress: subtasks.filter((c) => c.status === "in_progress").length,
		completed: subtasks.filter((c) => c.status === "completed").length,
		blocked: subtasks.filter((c) => c.status === "blocked").length,
		failed: subtasks.filter((c) => c.status === "failed").length,
	};
}

/**
 * Determine overall status from subtask statuses
 * @param subtasks Array of subtasks
 * @returns Overall status string
 */
export function determineOverallStatus(
	subtasks: { status: string }[],
): "not_started" | "in_progress" | "completed" | "failed" {
	if (subtasks.length === 0) return "not_started";

	const hasDone = subtasks.some((c) => isSubtaskDone(c.status));
	const hasFailed = subtasks.some((c) => c.status === "failed");
	const hasInProgress = subtasks.some((c) => c.status === "in_progress");
	const allDone = subtasks.every((c) => isSubtaskDone(c.status));
	const allPending = subtasks.every((c) => c.status === "pending");

	if (allDone) return "completed";
	if (hasFailed) return "failed";
	if (hasInProgress || hasDone) return "in_progress";
	if (allPending) return "not_started";

	return "in_progress";
}

/**
 * Format progress as display string
 * @param completed Number of completed subtasks
 * @param total Total number of subtasks
 * @returns Formatted string like "3/5 subtasks"
 */
export function formatProgressString(completed: number, total: number): string {
	if (total === 0) return "No subtasks";
	return `${completed}/${total} subtasks`;
}

/**
 * Calculate estimated remaining time based on progress
 * @param startTime Start time of the task
 * @param progress Current progress percentage (0-100)
 * @returns Estimated remaining time in milliseconds, or null if cannot estimate
 */
export function estimateRemainingTime(
	startTime: Date,
	progress: number,
): number | null {
	if (progress <= 0 || progress >= 100) return null;

	const elapsed = Date.now() - startTime.getTime();
	const estimatedTotal = (elapsed / progress) * 100;
	const remaining = estimatedTotal - elapsed;

	return Math.max(0, Math.round(remaining));
}
