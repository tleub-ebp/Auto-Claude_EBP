/**
 * Plan-time worktree conflict detection.
 *
 * Compares the files a task's plan intends to touch (subtask files — ground
 * truth `files_changed` once available, planner predictions otherwise) with
 * the files of every other active task in the same project. Two parallel
 * tasks touching the same file will produce a merge conflict at integration
 * time; surfacing the overlap during plan review lets the user re-scope or
 * sequence the tasks instead.
 */

import type {
	PlanConflictReport,
	PlanConflictTask,
	Task,
	TaskStatus,
} from "../../shared/types";

/**
 * Statuses whose plans represent work that is (or will be) carried by a live
 * worktree. Tasks in backlog have no plan yet; done/pr_created tasks are
 * already integrated (or about to be) so their overlap is expected.
 */
const CONFLICT_RELEVANT_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"queue",
	"in_progress",
	"ai_review",
	"human_review",
	"error",
]);

/** Normalize a plan path so the same file compares equal across plans. */
export function normalizePlanPath(file: string): string {
	let normalized = file.trim().replaceAll("\\", "/");
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	return normalized.replace(/^\/+/, "").toLowerCase();
}

/** Collect the normalized set of files a task's plan touches. */
function collectTaskFiles(task: Task): Map<string, string> {
	// Map normalized -> original (first seen) so the report shows readable paths.
	const files = new Map<string, string>();
	for (const subtask of task.subtasks ?? []) {
		for (const file of subtask.files ?? []) {
			if (typeof file !== "string" || file.trim() === "") continue;
			const normalized = normalizePlanPath(file);
			if (!files.has(normalized)) {
				files.set(normalized, file.trim().replaceAll("\\", "/"));
			}
		}
	}
	return files;
}

/**
 * Compute the overlap between `task`'s planned files and every other active
 * task of the same project.
 */
export function computePlanConflicts(
	task: Task,
	allProjectTasks: Task[],
): PlanConflictReport {
	const targetFiles = collectTaskFiles(task);
	const conflictingTasks: PlanConflictTask[] = [];
	const distinctFiles = new Set<string>();

	if (targetFiles.size > 0) {
		for (const other of allProjectTasks) {
			if (other.id === task.id || other.specId === task.specId) continue;
			if (!CONFLICT_RELEVANT_STATUSES.has(other.status)) continue;
			if (other.metadata?.archivedAt) continue;

			const otherFiles = collectTaskFiles(other);
			const shared: string[] = [];
			for (const [normalized, display] of targetFiles) {
				if (otherFiles.has(normalized)) {
					shared.push(display);
					distinctFiles.add(normalized);
				}
			}

			if (shared.length > 0) {
				conflictingTasks.push({
					taskId: other.id,
					taskTitle: other.title,
					taskStatus: other.status,
					files: shared.sort((a, b) => a.localeCompare(b)),
				});
			}
		}
	}

	// Most overlapping task first — that's the one to coordinate with.
	conflictingTasks.sort((a, b) => b.files.length - a.files.length);

	return {
		taskId: task.id,
		conflictingTasks,
		totalConflictingFiles: distinctFiles.size,
		checkedAt: new Date().toISOString(),
	};
}
