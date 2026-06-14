/**
 * Plan File Utilities
 *
 * Provides thread-safe operations for reading and writing implementation_plan.json files.
 * Uses an in-memory lock to serialize updates and prevent race conditions when multiple
 * IPC handlers try to update the same plan file concurrently.
 *
 * IMPORTANT LIMITATION:
 * The synchronous function `persistPlanStatusSync` does NOT participate in the locking
 * mechanism. It bypasses the async lock entirely, which means:
 * - It can race with concurrent async operations (persistPlanStatus, updatePlanFile, etc.)
 * - It should ONLY be used when you are certain no async operations are pending on the same file
 * - Prefer using the async `persistPlanStatus` whenever possible
 *
 * If you need synchronous behavior, ensure that:
 * 1. No async plan operations are in flight for the same file path
 * 2. The calling context truly cannot use async/await (e.g., synchronous event handlers)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import type { Project, Task, TaskStatus } from "../../../shared/types";
import type { TaskEventPayload } from "../../agent/task-event-schema";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { projectStore } from "../../project-store";
import type { VisualProofRun } from "../../../shared/types";

// In-memory locks for plan file operations
// Key: plan file path, Value: Promise chain for serializing operations
const planLocks = new Map<string, Promise<void>>();

/**
 * Serialize operations on a specific plan file to prevent race conditions.
 * Each operation waits for the previous one to complete before starting.
 */
async function withPlanLock<T>(
	planPath: string,
	operation: () => Promise<T>,
): Promise<T> {
	// Get or create the lock chain for this file
	const currentLock = planLocks.get(planPath) || Promise.resolve();

	// Create a new promise that will resolve after our operation completes
	let resolve: () => void = () => {
		/* placeholder, will be overwritten by Promise constructor */
	};
	const newLock = new Promise<void>((r) => {
		resolve = r;
	});
	planLocks.set(planPath, newLock);

	try {
		// Wait for any previous operation to complete
		await currentLock;
		// Execute our operation
		return await operation();
	} finally {
		// Release the lock
		resolve?.();
		// Clean up if this was the last operation
		if (planLocks.get(planPath) === newLock) {
			planLocks.delete(planPath);
		}
	}
}

/**
 * Check if an error is a "file not found" error
 */
function isFileNotFoundError(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Get the plan file path for a task
 */
export function getPlanPath(project: Project, task: Task): string {
	const specsBaseDir = getSpecsDir(project.autoBuildPath);
	const specDir = path.join(project.path, specsBaseDir, task.specId);
	return path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
}

/**
 * Map UI TaskStatus to Python-compatible planStatus
 */
export function mapStatusToPlanStatus(status: TaskStatus): string {
	switch (status) {
		case "queue":
			return "queued";
		case "in_progress":
			return "in_progress";
		case "ai_review":
		case "human_review":
		case "build_failed":
			return "review";
		case "done":
			return "completed";
		default:
			return "pending";
	}
}

/**
 * Persist task status to implementation_plan.json file.
 * This is thread-safe and prevents race conditions when multiple handlers update the same file.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false if plan file doesn't exist
 */
export async function persistPlanStatus(
	planPath: string,
	status: TaskStatus,
	projectId?: string,
): Promise<boolean> {
	return withPlanLock(planPath, async () => {
		try {
			console.warn(
				`[plan-file-utils] Reading implementation_plan.json to update status to: ${status}`,
				{ planPath },
			);
			// Read file directly without existence check to avoid TOCTOU race condition
			const planContent = readFileSync(planPath, "utf-8");
			const plan = JSON.parse(planContent);

			plan.status = status;
			plan.planStatus = mapStatusToPlanStatus(status);
			plan.updated_at = new Date().toISOString();

			writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
			console.warn(
				`[plan-file-utils] Successfully persisted status: ${status} to implementation_plan.json`,
			);

			// Invalidate tasks cache since status changed
			if (projectId) {
				projectStore.invalidateTasksCache(projectId);
			}

			return true;
		} catch (err) {
			// File not found is expected - return false
			if (isFileNotFoundError(err)) {
				console.warn(
					`[plan-file-utils] implementation_plan.json not found at ${planPath} - status not persisted`,
				);
				return false;
			}
			console.warn(
				`[plan-file-utils] Could not persist status to ${planPath}:`,
				err,
			);
			return false;
		}
	});
}

/**
 * Persist task status synchronously (for use in event handlers where async isn't practical).
 *
 * WARNING: This function bypasses the async locking mechanism entirely!
 *
 * This means it can race with concurrent async operations (persistPlanStatus, updatePlanFile,
 * createPlanIfNotExists) that may be in flight for the same file. Using this function while
 * async operations are pending can result in:
 * - Lost updates (this write may overwrite changes from an async operation, or vice versa)
 * - Corrupted JSON (if writes interleave at the filesystem level)
 * - Inconsistent state between what was written and what the async operation expected to read
 *
 * ONLY use this function when ALL of the following conditions are met:
 * 1. You are in a synchronous context that cannot use async/await (e.g., certain event handlers)
 * 2. You are certain no async plan operations are pending or in-flight for this file path
 * 3. No other code will initiate async plan operations until this function returns
 *
 * When possible, prefer using the async `persistPlanStatus` function instead, which properly
 * participates in the locking mechanism and prevents race conditions.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false otherwise
 */
export function persistPlanStatusSync(
	planPath: string,
	status: TaskStatus,
	projectId?: string,
): boolean {
	try {
		// Read file directly without existence check to avoid TOCTOU race condition
		const planContent = readFileSync(planPath, "utf-8");
		const plan = JSON.parse(planContent);

		plan.status = status;
		plan.planStatus = mapStatusToPlanStatus(status);
		plan.updated_at = new Date().toISOString();

		writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");

		// Invalidate tasks cache since status changed
		if (projectId) {
			projectStore.invalidateTasksCache(projectId);
		}

		return true;
	} catch (err) {
		// File not found is expected - return false
		if (isFileNotFoundError(err)) {
			return false;
		}
		console.warn(
			`[plan-file-utils] Could not persist status to ${planPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Persist lastEvent metadata synchronously.
 *
 * WARNING: This bypasses async locking. Use only in sync event handlers where
 * async isn't practical. Prefer updatePlanFile when possible.
 */
export function persistPlanLastEventSync(
	planPath: string,
	event: TaskEventPayload,
): boolean {
	try {
		const planContent = readFileSync(planPath, "utf-8");
		const plan = JSON.parse(planContent);

		plan.lastEvent = {
			eventId: event.eventId,
			sequence: event.sequence,
			type: event.type,
			timestamp: event.timestamp,
		};
		plan.updated_at = new Date().toISOString();

		writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
		return true;
	} catch (err) {
		if (isFileNotFoundError(err)) {
			return false;
		}
		console.warn(
			`[plan-file-utils] Could not persist lastEvent to ${planPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Persist task status, reviewReason, XState state, and execution phase synchronously.
 * The xstateState and executionPhase are used to restore the exact machine state on reload,
 * distinguishing between e.g. 'planning' vs 'coding' when both have status 'in_progress'.
 *
 * If the plan file doesn't exist, creates a minimal plan with the status fields.
 * This ensures XState state is persisted even during early phases like spec creation.
 */
export function persistPlanStatusAndReasonSync(
	planPath: string,
	status: TaskStatus,
	reviewReason?: string,
	projectId?: string,
	xstateState?: string,
	executionPhase?: string,
): boolean {
	try {
		let plan: Record<string, unknown>;

		try {
			const planContent = readFileSync(planPath, "utf-8");
			plan = JSON.parse(planContent);
		} catch (readErr) {
			if (!isFileNotFoundError(readErr)) {
				throw readErr;
			}
			// File doesn't exist - create a minimal status-only plan.
			// The spec runner will populate the full plan (with phases/subtasks) later.
			// IMPORTANT: Do NOT include phases: [] here. An empty phases array causes
			// the backend planner validator to fail with "No phases defined" before
			// the planner agent gets a chance to create a real plan.
			const planDir = path.dirname(planPath);
			mkdirSync(planDir, { recursive: true });
			plan = {
				created_at: new Date().toISOString(),
			};
		}

		plan.status = status;
		plan.planStatus = mapStatusToPlanStatus(status);
		plan.reviewReason = reviewReason;
		if (xstateState) {
			plan.xstateState = xstateState;
		}
		if (executionPhase) {
			plan.executionPhase = executionPhase;
		}
		plan.updated_at = new Date().toISOString();

		writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");

		if (projectId) {
			projectStore.invalidateTasksCache(projectId);
		}

		return true;
	} catch (err) {
		console.warn(
			`[plan-file-utils] Could not persist status/reason to ${planPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Persist execution phase to the plan file synchronously.
 * This is called when execution progress updates to ensure the phase
 * is persisted for restoration on app refresh.
 */
export function persistPlanPhaseSync(
	planPath: string,
	phase: string,
	projectId?: string,
): boolean {
	try {
		let plan: Record<string, unknown>;

		try {
			const planContent = readFileSync(planPath, "utf-8");
			plan = JSON.parse(planContent);
		} catch (readErr) {
			if (!isFileNotFoundError(readErr)) {
				throw readErr;
			}
			// File doesn't exist - create minimal status-only plan.
			// Do NOT include phases: [] — the backend planner will populate phases.
			const planDir = path.dirname(planPath);
			mkdirSync(planDir, { recursive: true });
			plan = {
				created_at: new Date().toISOString(),
			};
		}

		// Store the execution phase for restoration
		plan.executionPhase = phase;

		// Also update status to match the phase so the card stays in the correct column on refresh
		// Map execution phase to TaskStatus for column placement
		const phaseToStatus: Record<string, TaskStatus> = {
			planning: "in_progress",
			coding: "in_progress",
			qa_review: "ai_review",
			qa_fixing: "ai_review",
			complete: "human_review",
			failed: "error",
		};
		const mappedStatus = phaseToStatus[phase];
		if (mappedStatus) {
			plan.status = mappedStatus;
			plan.planStatus = mapStatusToPlanStatus(mappedStatus);
		}

		plan.updated_at = new Date().toISOString();

		writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");

		if (projectId) {
			projectStore.invalidateTasksCache(projectId);
		}

		return true;
	} catch (err) {
		console.warn(
			`[plan-file-utils] Could not persist phase to ${planPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Read and update the plan file atomically.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param updater - Function that receives the current plan and returns the updated plan
 * @returns The updated plan, or null if the file doesn't exist
 */
export async function updatePlanFile<T extends Record<string, unknown>>(
	planPath: string,
	updater: (plan: T) => T,
): Promise<T | null> {
	return withPlanLock(planPath, async () => {
		try {
			console.warn(
				`[plan-file-utils] Reading implementation_plan.json for update`,
				{ planPath },
			);
			// Read file directly without existence check to avoid TOCTOU race condition
			const planContent = readFileSync(planPath, "utf-8");
			const plan = JSON.parse(planContent) as T;

			const updatedPlan = updater(plan);
			// Add updated_at timestamp - use type assertion since T extends Record<string, unknown>
			(updatedPlan as Record<string, unknown>).updated_at =
				new Date().toISOString();

			writeFileSync(planPath, JSON.stringify(updatedPlan, null, 2), "utf-8");
			console.warn(
				`[plan-file-utils] Successfully updated implementation_plan.json`,
			);
			return updatedPlan;
		} catch (err) {
			// File not found is expected - return null
			if (isFileNotFoundError(err)) {
				console.warn(
					`[plan-file-utils] implementation_plan.json not found at ${planPath} - update skipped`,
				);
				return null;
			}
			console.warn(
				`[plan-file-utils] Could not update plan at ${planPath}:`,
				err,
			);
			return null;
		}
	});
}

/**
 * Create a new plan file if it doesn't exist.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param task - The task to create the plan for
 * @param status - Initial status for the plan
 * @param xstateState - Optional XState machine state for restoration
 */
export async function createPlanIfNotExists(
	planPath: string,
	task: Task,
	status: TaskStatus,
	xstateState?: string,
): Promise<void> {
	return withPlanLock(planPath, async () => {
		// Try to read the file first - if it exists, do nothing
		try {
			readFileSync(planPath, "utf-8");
			return; // File exists, nothing to do
		} catch (err) {
			if (!isFileNotFoundError(err)) {
				throw err; // Re-throw unexpected errors
			}
			// File doesn't exist, continue to create it
		}

		const plan: Record<string, unknown> = {
			feature: task.title,
			description: task.description || "",
			created_at: task.createdAt.toISOString(),
			updated_at: new Date().toISOString(),
			status: status,
			planStatus: mapStatusToPlanStatus(status),
			phases: [],
		};

		// Include xstateState for accurate restoration on reload
		if (xstateState) {
			plan.xstateState = xstateState;
		}

		// Ensure directory exists - use try/catch pattern
		const planDir = path.dirname(planPath);
		try {
			mkdirSync(planDir, { recursive: true });
		} catch (err) {
			// Directory might already exist or be created concurrently - that's fine
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw err;
			}
		}

		writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
	});
}

/**
 * Update plan phases and subtasks.
 * This allows adding, modifying, or removing pending subtasks from the implementation plan.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param phases - The updated phases array with potentially modified subtasks
 * @param projectId - Optional project ID to invalidate cache
 * @returns The updated plan, or null if the file doesn't exist
 */
export async function updatePlanSubtasks(
	planPath: string,
	phases: Array<Record<string, unknown>>,
	projectId?: string,
): Promise<Record<string, unknown> | null> {
	return updatePlanFile(planPath, (plan) => {
		plan.phases = phases;
		return plan;
	}).then((updatedPlan) => {
		// Invalidate cache after successful update
		if (updatedPlan && projectId) {
			projectStore.invalidateTasksCache(projectId);
		}
		return updatedPlan;
	});
}

/**
 * Update task_metadata.json to add PR URL.
 * This is a simple JSON file update (no locking needed as it's rarely updated concurrently).
 *
 * @param metadataPath - Path to the task_metadata.json file
 * @param prUrl - The PR URL to add to metadata
 * @returns true if metadata was updated, false if file doesn't exist or failed
 */
export function updateTaskMetadataPrUrl(
	metadataPath: string,
	prUrl: string,
): boolean {
	try {
		let metadata: Record<string, unknown> = {};

		// Try to read existing metadata
		try {
			const content = readFileSync(metadataPath, "utf-8");
			metadata = JSON.parse(content);
		} catch (err) {
			if (!isFileNotFoundError(err)) {
				throw err;
			}
			// File doesn't exist, will create new one
		}

		// Update with prUrl
		metadata.prUrl = prUrl;

		// Ensure parent directory exists before writing
		mkdirSync(path.dirname(metadataPath), { recursive: true });

		// Write back
		writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
		return true;
	} catch (err) {
		console.warn(
			`[plan-file-utils] Could not update metadata at ${metadataPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Update task_metadata.json with the latest automated visual proof run.
 */
export function updateTaskMetadataVisualProof(
	metadataPath: string,
	visualProof: VisualProofRun,
): boolean {
	try {
		let metadata: Record<string, unknown> = {};

		try {
			const content = readFileSync(metadataPath, "utf-8");
			metadata = JSON.parse(content);
		} catch (err) {
			if (!isFileNotFoundError(err)) {
				throw err;
			}
		}

		metadata.visualProof = visualProof;
		mkdirSync(path.dirname(metadataPath), { recursive: true });
		writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
		return true;
	} catch (err) {
		console.warn(
			`[plan-file-utils] Could not update visual proof at ${metadataPath}:`,
			err,
		);
		return false;
	}
}

/**
 * Get modified files from a git worktree compared to the main branch.
 * Detects files changed, added, or deleted.
 *
 * @param worktreePath - Path to the git worktree
 * @param mainBranch - The main branch to compare against (default: "main")
 * @returns Array of modified file paths
 */
export function getModifiedFilesFromWorktree(
	worktreePath: string,
	mainBranch: string = "main",
): string[] {
	try {
		// Get diff between main branch and current branch
		// Shows files that are: modified (M), added (A), or deleted (D)
		const output = execSync(
			`git diff --name-status ${mainBranch}...HEAD`,
			{
				cwd: worktreePath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				env: getIsolatedGitEnv(),
			},
		);

		if (!output.trim()) {
			return [];
		}

		// Parse the diff output
		// Format: STATUS\tFILEPATH
		const files = output
			.trim()
			.split("\n")
			.map((line) => {
				const parts = line.split("\t");
				return parts[1] || "";
			})
			.filter((file) => file.length > 0);

		return files;
	} catch (error) {
		console.warn(
			`[plan-file-utils] Could not get modified files from ${worktreePath}:`,
			error,
		);
		return [];
	}
}

/**
 * Generate subtasks from modified files and feedback.
 * Groups related files together based on directory structure.
 *
 * @param modifiedFiles - Array of file paths that were modified
 * @param feedback - User feedback about what needs to be done
 * @returns Array of generated subtasks
 */
export function generateSubtasksFromModifiedFiles(
	modifiedFiles: string[],
	feedback: string,
): Array<{
	id: string;
	title: string;
	description: string;
	status: "pending";
	files: string[];
}> {
	if (modifiedFiles.length === 0) {
		return [];
	}

	// Group files by directory for better organization
	const filesByDir = new Map<string, string[]>();

	for (const file of modifiedFiles) {
		const dir = path.dirname(file);
		if (!filesByDir.has(dir)) {
			filesByDir.set(dir, []);
		}
		filesByDir.get(dir)?.push(file);
	}

	// Generate subtasks - one per directory group or one for all if only one dir
	const subtasks: Array<{
		id: string;
		title: string;
		description: string;
		status: "pending";
		files: string[];
	}> = [];

	let dirIndex = 0;
	for (const [dir, files] of filesByDir.entries()) {
		const dirName =
			dir === "." ? "root" : dir.split("/").pop() || "files";
		const fileCount = files.length;

		subtasks.push({
			id: `subtask-${Date.now()}-${dirIndex}`,
			title: `Fix ${dirName} - ${fileCount} file${fileCount !== 1 ? "s" : ""}`,
			description: `Address feedback in ${dirName}:\n\n${feedback}\n\nModified files in this directory:\n${files.map((f) => `- ${f}`).join("\n")}`,
			status: "pending",
			files,
		});

		dirIndex++;
	}

	return subtasks;
}
