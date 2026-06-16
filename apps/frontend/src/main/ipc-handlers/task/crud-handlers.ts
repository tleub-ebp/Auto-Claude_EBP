import {
	cpSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { ipcMain, nativeImage } from "electron";
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import type {
	IPCResult,
	PlanConflictReport,
	SpecInterviewQuestion,
	Task,
	TaskMetadata,
} from "../../../shared/types";
import { slugifySpecTitle } from "../../../shared/utils/spec-slug";
import type { AgentManager } from "../../agent";
import { getAppLanguage } from "../../app-language";
import { projectStore } from "../../project-store";
import { specInterviewService } from "../../spec-interview-service";
import { taskStateManager } from "../../task-state-manager";
import { titleGenerator } from "../../title-generator";
import { computePlanConflicts } from "../../utils/plan-conflicts";
import { findAllSpecPaths, isValidTaskId } from "../../utils/spec-path-helpers";
import { cleanupWorktree } from "../../utils/worktree-cleanup";
import { findTaskWorktree, isPathWithinBase } from "../../worktree-paths";
import { inlineAzureDevOpsImages } from "../shared/azure-attachments";
import { stripHtml } from "../shared/sanitize";
import { parseEnvFile } from "../utils";
import { findTaskAndProject } from "./shared";

/** Charge le PAT et l'URL d'organisation Azure DevOps depuis le `.env` projet. */
function loadAzureDevOpsConfig(
	projectPath: string,
	autoBuildPath: string,
): { pat: string | null; orgUrl: string | null } {
	try {
		const envPath = path.join(projectPath, autoBuildPath, ".env");
		if (!existsSync(envPath)) return { pat: null, orgUrl: null };
		const vars = parseEnvFile(readFileSync(envPath, "utf-8"));
		return {
			pat: vars.AZURE_DEVOPS_PAT || null,
			orgUrl: vars.AZURE_DEVOPS_ORG_URL || null,
		};
	} catch {
		return { pat: null, orgUrl: null };
	}
}

/**
 * Register task CRUD (Create, Read, Update, Delete) handlers
 */
export function registerTaskCRUDHandlers(agentManager: AgentManager): void {
	/**
	 * List all tasks for a project
	 * @param projectId - The project ID to fetch tasks for
	 * @param options - Optional parameters
	 * @param options.forceRefresh - If true, invalidates cache before fetching (for refresh button)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_LIST,
		async (
			_,
			projectId: string,
			options?: { forceRefresh?: boolean },
		): Promise<IPCResult<Task[]>> => {
			console.warn(
				"[IPC] TASK_LIST called with projectId:",
				projectId,
				"options:",
				options,
			);

			// If forceRefresh is requested, invalidate cache and clear XState actors
			// This ensures the refresh button always returns fresh data from disk
			// and actors are recreated with fresh task data
			if (options?.forceRefresh) {
				projectStore.invalidateTasksCache(projectId);
				taskStateManager.clearAllTasks();
				console.warn(
					"[IPC] TASK_LIST cache and task state cleared for forceRefresh",
				);
			}

			const tasks = projectStore.getTasks(projectId);
			console.warn("[IPC] TASK_LIST returning", tasks.length, "tasks");
			return { success: true, data: tasks };
		},
	);

	/**
	 * Create a new task
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CREATE,
		async (
			_,
			projectId: string,
			title: string,
			description: string,
			metadata?: TaskMetadata,
		): Promise<IPCResult<Task>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// Les descriptions importées depuis un tracker (Azure DevOps, Jira)
			// arrivent en HTML enrichi. On en dérive :
			//  - `aiDescription` : texte brut (titres/spec/prompt IA, pas de HTML) ;
			//  - `displayDescription` : HTML conservé pour l'affichage, avec les
			//    images en pièce jointe Azure DevOps inlinées en data URIs (sinon
			//    elles nécessitent un PAT et échouent dans le renderer).
			const descriptionIsHtml =
				typeof description === "string" &&
				description.trimStart().startsWith("<");
			let aiDescription = description;
			let displayDescription = description;
			if (descriptionIsHtml) {
				aiDescription = stripHtml(description) || description;
				displayDescription = description;
				if (metadata?.importSource === "azure-devops") {
					const az = loadAzureDevOpsConfig(
						project.path,
						project.autoBuildPath || "",
					);
					if (az.pat && az.orgUrl) {
						try {
							displayDescription = await inlineAzureDevOpsImages(
								description,
								az.orgUrl,
								az.pat,
							);
						} catch (err) {
							console.error("[TASK_CREATE] Image inlining failed:", err);
						}
					}
				}
			}

			// Auto-generate title if empty using Claude AI.
			// Le titre est toujours réduit en texte brut : un titre HTML enrichi
			// (US/RsD Azure DevOps) ne doit jamais être affiché tel quel.
			let finalTitle = title?.trim() ? stripHtml(title) || title : title;
			if (!title?.trim()) {
				console.warn(
					"[TASK_CREATE] Title is empty, generating with Claude AI...",
				);
				try {
					const generatedTitle =
						await titleGenerator.generateTitle(aiDescription);
					if (generatedTitle) {
						finalTitle = generatedTitle;
						console.warn("[TASK_CREATE] Generated title:", finalTitle);
					} else {
						// Fallback: create title from first line of description
						finalTitle = aiDescription.split("\n")[0].substring(0, 60);
						if (finalTitle.length === 60) finalTitle += "...";
						console.warn(
							"[TASK_CREATE] AI generation failed, using fallback:",
							finalTitle,
						);
					}
				} catch (err) {
					console.error("[TASK_CREATE] Title generation error:", err);
					// Fallback: create title from first line of description
					finalTitle = aiDescription.split("\n")[0].substring(0, 60);
					if (finalTitle.length === 60) finalTitle += "...";
				}
			}

			// Generate a unique spec ID based on existing specs
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specsDir = path.join(project.path, specsBaseDir);

			// Find next available spec number
			let specNumber = 1;
			if (existsSync(specsDir)) {
				const existingDirs = readdirSync(specsDir, { withFileTypes: true })
					.filter((d: Dirent | string) => {
						// Handle both Dirent objects and string fallbacks
						if (typeof d === "string") {
							// If it's a string, check if it's a directory by using statSync
							const fullPath = path.join(specsDir, d);
							try {
								return statSync(fullPath).isDirectory();
							} catch {
								return false;
							}
						}
						// If it's a Dirent object, use isDirectory method
						return typeof d.isDirectory === "function" && d.isDirectory();
					})
					.map((d: Dirent | string) => (typeof d === "string" ? d : d.name));

				// Extract numbers from spec directory names (e.g., "001-feature" -> 1)
				const existingNumbers = existingDirs
					.map((name: string) => {
						const match = name.match(/^(\d+)/);
						return match ? parseInt(match[1], 10) : 0;
					})
					.filter((n: number) => n > 0);

				if (existingNumbers.length > 0) {
					specNumber = Math.max(...existingNumbers) + 1;
				}
			}

			// Create spec ID with zero-padded number and slugified title
			const slugifiedTitle = slugifySpecTitle(finalTitle);
			const specId = `${String(specNumber).padStart(3, "0")}-${slugifiedTitle}`;

			// Create spec directory
			const specDir = path.join(specsDir, specId);
			mkdirSync(specDir, { recursive: true });

			// Build metadata with source type
			const taskMetadata: TaskMetadata = {
				sourceType: "manual",
				...metadata,
			};

			// Process and save attached images
			if (
				taskMetadata.attachedImages &&
				taskMetadata.attachedImages.length > 0
			) {
				const attachmentsDir = path.join(specDir, "attachments");
				mkdirSync(attachmentsDir, { recursive: true });
				const resolvedAttachmentsDir = path.resolve(attachmentsDir);

				// MIME type allowlist (defense in depth - frontend also validates)
				const ALLOWED_MIME_TYPES = [
					"image/png",
					"image/jpeg",
					"image/jpg",
					"image/gif",
					"image/webp",
					"image/svg+xml",
				];

				const savedImages: typeof taskMetadata.attachedImages = [];

				for (const image of taskMetadata.attachedImages) {
					if (image.data) {
						// Validate MIME type
						if (
							!image.mimeType ||
							!ALLOWED_MIME_TYPES.includes(image.mimeType)
						) {
							console.warn(
								`[TASK_CREATE] Skipping image with missing or disallowed MIME type: ${image.mimeType}`,
							);
							continue;
						}

						// Sanitize filename to prevent path traversal attacks
						const sanitizedFilename = path.basename(image.filename);
						if (
							!sanitizedFilename ||
							sanitizedFilename === "." ||
							sanitizedFilename === ".."
						) {
							console.warn(
								`[TASK_CREATE] Skipping image with invalid filename: ${image.filename}`,
							);
							continue;
						}

						// Validate resolved path stays within attachments directory
						const imagePath = path.join(attachmentsDir, sanitizedFilename);
						const resolvedPath = path.resolve(imagePath);
						if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)) {
							console.warn(
								`[TASK_CREATE] Skipping image with path traversal attempt: ${image.filename}`,
							);
							continue;
						}

						try {
							// Decode base64 and save to file
							const buffer = Buffer.from(image.data, "base64");
							writeFileSync(imagePath, buffer);

							// Store relative path instead of base64 data
							savedImages.push({
								id: image.id,
								filename: sanitizedFilename,
								mimeType: image.mimeType,
								size: image.size,
								path: `attachments/${sanitizedFilename}`,
								// Don't include data or thumbnail to save space
							});
						} catch (err) {
							console.error(`Failed to save image ${sanitizedFilename}:`, err);
						}
					}
				}

				// Update metadata with saved image paths (without base64 data)
				taskMetadata.attachedImages = savedImages;
			}

			// Create initial implementation_plan.json (task is created but not started)
			const now = new Date().toISOString();
			const implementationPlan = {
				feature: finalTitle,
				description: aiDescription,
				created_at: now,
				updated_at: now,
				status: "pending",
				phases: [],
			};

			const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
			writeFileSync(
				planPath,
				JSON.stringify(implementationPlan, null, 2),
				"utf-8",
			);

			// Save task metadata if provided
			if (taskMetadata) {
				const metadataPath = path.join(specDir, "task_metadata.json");
				writeFileSync(
					metadataPath,
					JSON.stringify(taskMetadata, null, 2),
					"utf-8",
				);
			}

			// Create requirements.json with attached images
			const requirements: Record<string, unknown> = {
				task_description: aiDescription,
				workflow_type: taskMetadata.category || "feature",
			};

			// Conserver le HTML enrichi (images inlinées comprises) pour l'UI sans
			// polluer `task_description` consommé par l'IA. project-store privilégie
			// ce champ pour l'affichage de la description.
			if (descriptionIsHtml && displayDescription !== aiDescription) {
				requirements.display_description = displayDescription;
			}

			// Propagate acceptance criteria so they reach every pipeline phase
			// (planner, spec_writer, qa_reviewer all read this from requirements.json).
			if (
				taskMetadata.acceptanceCriteria &&
				taskMetadata.acceptanceCriteria.length > 0
			) {
				requirements.acceptance_criteria = taskMetadata.acceptanceCriteria;
			}

			// Propagate free-form extra note as `additional_context` so it gets
			// surfaced to the orchestrator (see _load_requirements_context).
			if (taskMetadata.extraNote?.trim()) {
				requirements.additional_context = taskMetadata.extraNote.trim();
			}

			// Add attached images to requirements if present
			if (
				taskMetadata.attachedImages &&
				taskMetadata.attachedImages.length > 0
			) {
				requirements.attached_images = taskMetadata.attachedImages.map(
					(img) => ({
						filename: img.filename,
						path: img.path,
						description: "", // User can add descriptions later
					}),
				);
			}

			const requirementsPath = path.join(
				specDir,
				AUTO_BUILD_PATHS.REQUIREMENTS,
			);
			writeFileSync(
				requirementsPath,
				JSON.stringify(requirements, null, 2),
				"utf-8",
			);

			// Create the task object
			const task: Task = {
				id: specId,
				specId: specId,
				projectId,
				title: finalTitle,
				description: displayDescription,
				status: "backlog",
				subtasks: [],
				logs: [],
				metadata: taskMetadata,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			// Invalidate cache since a new task was created
			projectStore.invalidateTasksCache(projectId);

			return { success: true, data: task };
		},
	);

	/**
	 * Duplicate a task.
	 *
	 * Clones the *spec-defining* artifacts of an existing task into a brand-new
	 * task that starts fresh in the backlog:
	 *  - spec.md (H1 retitled), requirements.json (display_title retitled),
	 *    task_metadata.json (runtime/tracker fields stripped) and the
	 *    attachments/ directory are copied on disk — so attached images survive
	 *    (the renderer never carries their base64 data, only paths).
	 *  - a fresh implementation_plan.json (status "pending", no phases) is written.
	 *
	 * Runtime artifacts (plan phases, QA report, progress, conversation logs,
	 * worktree, halt markers) are intentionally NOT copied: the duplicate is a
	 * clean ticket the user can plan and run independently.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_DUPLICATE,
		async (
			_,
			taskId: string,
			newTitle?: string,
		): Promise<IPCResult<Task>> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task or project not found" };
			}

			// Locate the source spec directory (main project location).
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specsDir = path.join(project.path, specsBaseDir);
			const sourceSpecDir = path.join(specsDir, task.specId);
			if (!existsSync(sourceSpecDir)) {
				return { success: false, error: "Source spec directory not found" };
			}

			// Resolve the title for the clone (caller supplies a localized
			// "(copy)" suffix; fall back to a plain English suffix).
			const finalTitle =
				newTitle?.trim() ||
				`${(task.title || "Untitled").trim()} (copy)`;

			// Allocate the next free spec number, mirroring TASK_CREATE.
			let specNumber = 1;
			if (existsSync(specsDir)) {
				const existingNumbers = readdirSync(specsDir, { withFileTypes: true })
					.filter((d: Dirent | string) => {
						if (typeof d === "string") {
							try {
								return statSync(path.join(specsDir, d)).isDirectory();
							} catch {
								return false;
							}
						}
						return typeof d.isDirectory === "function" && d.isDirectory();
					})
					.map((d: Dirent | string) => (typeof d === "string" ? d : d.name))
					.map((name: string) => {
						const match = name.match(/^(\d+)/);
						return match ? parseInt(match[1], 10) : 0;
					})
					.filter((n: number) => n > 0);
				if (existingNumbers.length > 0) {
					specNumber = Math.max(...existingNumbers) + 1;
				}
			}

			const slugifiedTitle = slugifySpecTitle(finalTitle);
			const newSpecId = `${String(specNumber).padStart(3, "0")}-${slugifiedTitle}`;
			const newSpecDir = path.join(specsDir, newSpecId);
			mkdirSync(newSpecDir, { recursive: true });

			const now = new Date().toISOString();

			// 1. spec.md — copy and retitle the first H1 heading.
			let copiedDescription = task.description || "";
			const sourceSpecPath = path.join(sourceSpecDir, AUTO_BUILD_PATHS.SPEC_FILE);
			if (existsSync(sourceSpecPath)) {
				try {
					let specContent = readFileSync(sourceSpecPath, "utf-8");
					specContent = specContent.replace(/^#\s+.*$/m, `# ${finalTitle}`);
					writeFileSync(
						path.join(newSpecDir, AUTO_BUILD_PATHS.SPEC_FILE),
						specContent,
						"utf-8",
					);
				} catch (err) {
					console.error("[TASK_DUPLICATE] Failed to copy spec.md:", err);
				}
			}

			// 2. requirements.json — copy and retitle display_title.
			const sourceReqPath = path.join(
				sourceSpecDir,
				AUTO_BUILD_PATHS.REQUIREMENTS,
			);
			if (existsSync(sourceReqPath)) {
				try {
					const requirements = JSON.parse(readFileSync(sourceReqPath, "utf-8"));
					if (typeof requirements.display_title === "string") {
						requirements.display_title = finalTitle;
					}
					if (typeof requirements.task_description === "string") {
						copiedDescription = requirements.task_description;
					}
					writeFileSync(
						path.join(newSpecDir, AUTO_BUILD_PATHS.REQUIREMENTS),
						JSON.stringify(requirements, null, 2),
						"utf-8",
					);
				} catch (err) {
					console.error(
						"[TASK_DUPLICATE] Failed to copy requirements.json:",
						err,
					);
				}
			}

			// 3. task_metadata.json — copy classification/config but drop fields
			// that must not carry over to an independent clone (tracker links,
			// PR/worktree state, archive flags, pause state).
			const duplicatedMetadata: TaskMetadata = {
				...(task.metadata ?? {}),
				sourceType: "manual",
			};
			const NON_CLONED_METADATA_KEYS: (keyof TaskMetadata)[] = [
				"prUrl",
				"visualProof",
				"archivedAt",
				"archivedInVersion",
				"paused",
				"azureDevOpsIdentifier",
				"azureDevOpsUrl",
				"azureDevOpsState",
				"azureDevOpsType",
				"jiraIdentifier",
				"jiraUrl",
				"jiraState",
				"jiraType",
				"githubIssueNumber",
				"githubIssueNumbers",
				"githubUrl",
				"gitlabIssueIid",
				"gitlabUrl",
				"linearIssueId",
				"linearIdentifier",
				"linearUrl",
				"importSource",
			];
			for (const key of NON_CLONED_METADATA_KEYS) {
				delete duplicatedMetadata[key];
			}
			// Mark the clone's lineage so the UI can treat it like an import and
			// propose the Provider × LLM × Effort prerequisite before it runs.
			duplicatedMetadata.duplicatedFrom = task.specId;
			writeFileSync(
				path.join(newSpecDir, "task_metadata.json"),
				JSON.stringify(duplicatedMetadata, null, 2),
				"utf-8",
			);

			// 4. attachments/ — copy recursively so attached images are preserved.
			const sourceAttachments = path.join(sourceSpecDir, "attachments");
			if (existsSync(sourceAttachments)) {
				try {
					cpSync(sourceAttachments, path.join(newSpecDir, "attachments"), {
						recursive: true,
					});
				} catch (err) {
					console.error(
						"[TASK_DUPLICATE] Failed to copy attachments:",
						err,
					);
				}
			}

			// 5. Fresh implementation_plan.json (pending, no phases).
			const implementationPlan = {
				feature: finalTitle,
				description: copiedDescription,
				created_at: now,
				updated_at: now,
				status: "pending",
				phases: [],
			};
			writeFileSync(
				path.join(newSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
				JSON.stringify(implementationPlan, null, 2),
				"utf-8",
			);

			const duplicatedTask: Task = {
				id: newSpecId,
				specId: newSpecId,
				projectId: project.id,
				title: finalTitle,
				description: task.description || "",
				status: "backlog",
				subtasks: [],
				logs: [],
				metadata: duplicatedMetadata,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			projectStore.invalidateTasksCache(project.id);
			console.warn(
				`[TASK_DUPLICATE] Task ${taskId} duplicated to ${newSpecId}`,
			);
			return { success: true, data: duplicatedTask };
		},
	);

	/**
	 * Delete a task
	 *
	 * This handler:
	 * 1. Checks if task exists and is not running
	 * 2. Cleans up the worktree (auto-commits, deletes directory, prunes refs, deletes branch)
	 * 3. Deletes all spec directories (main project + any remaining worktree locations)
	 *
	 * Note: Worktree cleanup uses manual deletion instead of `git worktree remove --force`
	 * because the latter fails on Windows when the directory contains untracked files
	 * (node_modules, build artifacts, etc.). See: https://github.com/AndyMik90/Auto-Claude/issues/1539
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_DELETE,
		async (_, taskId: string): Promise<IPCResult> => {
			const { rm } = await import("node:fs/promises");

			// Find task and project
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task or project not found" };
			}

			// Check if task is currently running
			const isRunning = agentManager.isRunning(taskId);
			if (isRunning) {
				return {
					success: false,
					error: "Cannot delete a running task. Stop the task first.",
				};
			}

			let hasErrors = false;
			const errors: string[] = [];

			// Clean up the worktree first if it exists
			// This uses the robust cleanup that handles Windows file locking issues
			const worktreePath = findTaskWorktree(project.path, task.specId);
			if (worktreePath) {
				console.warn(`[TASK_DELETE] Found worktree at: ${worktreePath}`);
				const cleanupResult = await cleanupWorktree({
					worktreePath,
					projectPath: project.path,
					specId: task.specId,
					commitMessage: "Auto-save before task deletion",
					logPrefix: "[TASK_DELETE]",
					deleteBranch: true,
					// Ferme la PR distante associée pour éviter une PR
					// orpheline pointant vers une branche supprimée.
					prUrl: task.prUrl ?? task.metadata?.prUrl,
				});

				if (!cleanupResult.success) {
					console.error(
						`[TASK_DELETE] Worktree cleanup failed:`,
						cleanupResult.warnings,
					);
					hasErrors = true;
					errors.push(`Worktree cleanup: ${cleanupResult.warnings.join("; ")}`);
				} else {
					if (cleanupResult.autoCommitted) {
						console.warn(
							`[TASK_DELETE] Auto-committed uncommitted work before deletion`,
						);
					}
					if (cleanupResult.prClosed && cleanupResult.closedPrNumber) {
						console.warn(
							`[TASK_DELETE] PR #${cleanupResult.closedPrNumber} fermée automatiquement`,
						);
					}
					if (cleanupResult.warnings.length > 0) {
						console.warn(
							`[TASK_DELETE] Cleanup warnings:`,
							cleanupResult.warnings,
						);
					}
				}
			}

			// Find ALL locations where this task exists (main + any remaining worktree dirs)
			// Following the archiveTasks() pattern from project-store.ts
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specPaths = findAllSpecPaths(
				project.path,
				specsBaseDir,
				task.specId,
			);

			// If spec directory doesn't exist anywhere, return success (already removed)
			if (specPaths.length === 0 && !hasErrors) {
				console.warn(
					`[TASK_DELETE] No spec directories found for task ${taskId} - already removed`,
				);
				projectStore.invalidateTasksCache(project.id);
				return { success: true };
			}

			// Delete from ALL locations
			for (const specDir of specPaths) {
				try {
					console.warn(`[TASK_DELETE] Attempting to delete: ${specDir}`);
					await rm(specDir, { recursive: true, force: true });
					console.warn(`[TASK_DELETE] Deleted spec directory: ${specDir}`);
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : "Unknown error";
					console.error(
						`[TASK_DELETE] Error deleting spec directory ${specDir}:`,
						error,
					);
					hasErrors = true;
					errors.push(`${specDir}: ${errorMsg}`);
					// Continue with other locations even if one fails
				}
			}

			// Invalidate cache since a task was deleted
			projectStore.invalidateTasksCache(project.id);

			if (hasErrors) {
				return {
					success: false,
					error: `Failed to delete some task files: ${errors.join("; ")}`,
				};
			}

			return { success: true };
		},
	);

	/**
	 * Fully reset a task back to backlog.
	 *
	 * Used when the planned subtasks are not satisfying: the task keeps its
	 * spec (spec.md, task_metadata.json, attachments) but loses everything
	 * produced by the pipeline:
	 * 1. Worktree (auto-committed then deleted, branch removed, PR closed)
	 * 2. Plan + subtasks (implementation_plan.json), QA report, progress and
	 *    conversation/halt artifacts — in every spec location (main + worktrees)
	 * 3. XState actor state (so the next start is a fresh PLANNING_STARTED)
	 *
	 * Refuses to reset a running task: the caller must stop it first.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESET,
		async (_, taskId: string): Promise<IPCResult<Task>> => {
			const { rm } = await import("node:fs/promises");

			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task or project not found" };
			}

			if (agentManager.isRunning(taskId)) {
				return {
					success: false,
					error: "Cannot reset a running task. Stop the task first.",
				};
			}

			const warnings: string[] = [];

			// 1. Remove the worktree (same robust path as TASK_DELETE)
			const worktreePath = findTaskWorktree(project.path, task.specId);
			if (worktreePath) {
				const cleanupResult = await cleanupWorktree({
					worktreePath,
					projectPath: project.path,
					specId: task.specId,
					commitMessage: "Auto-save before task reset",
					logPrefix: "[TASK_RESET]",
					deleteBranch: true,
					prUrl: task.prUrl ?? task.metadata?.prUrl,
				});
				if (!cleanupResult.success) {
					// Without the worktree gone the reset would leave a stale build —
					// surface the failure instead of pretending the task is clean.
					return {
						success: false,
						error: `Worktree cleanup failed: ${cleanupResult.warnings.join("; ")}`,
					};
				}
				warnings.push(...cleanupResult.warnings);
			}

			// 2. Delete pipeline artifacts in every spec location, keeping the
			// spec itself (spec.md, task_metadata.json, images...)
			const runtimeArtifacts = [
				AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				AUTO_BUILD_PATHS.QA_REPORT,
				AUTO_BUILD_PATHS.BUILD_PROGRESS,
				"conversation.jsonl",
				"conversation_log.jsonl",
				"PROMPT_TOO_LONG_HALT",
				"RESUME_WITH_PROVIDER",
				"qa_fix_request.md",
				"memory",
			];
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specPaths = findAllSpecPaths(
				project.path,
				specsBaseDir,
				task.specId,
			);
			for (const specDir of specPaths) {
				for (const artifact of runtimeArtifacts) {
					const target = path.join(specDir, artifact);
					if (!existsSync(target)) continue;
					try {
						await rm(target, { recursive: true, force: true });
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : "Unknown error";
						warnings.push(`${target}: ${errorMsg}`);
					}
				}
			}

			// 3. Drop the XState actor so the next start is a clean planning run
			taskStateManager.clearTask(taskId);
			projectStore.invalidateTasksCache(project.id);

			if (warnings.length > 0) {
				console.warn(`[TASK_RESET] Warnings for ${taskId}:`, warnings);
			}

			const resetTask: Task = {
				...task,
				status: "backlog",
				reviewReason: undefined,
				subtasks: [],
				qaReport: undefined,
				executionProgress: undefined,
				updatedAt: new Date(),
			};
			console.warn(`[TASK_RESET] Task ${taskId} reset to backlog`);
			return { success: true, data: resetTask };
		},
	);

	/**
	 * Plan-time conflict detection: compare the files this task's plan touches
	 * with the plans/diffs of every other active task in the same project, so
	 * parallel worktrees on the same files raise an alert at plan review
	 * instead of a merge conflict at the end.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CHECK_PLAN_CONFLICTS,
		async (_, taskId: string): Promise<IPCResult<PlanConflictReport>> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			const allTasks = projectStore.getTasks(project.id);
			return { success: true, data: computePlanConflicts(task, allTasks) };
		},
	);

	/**
	 * Spec interview: generate 3-5 clarifying questions about the task
	 * description before planning starts. The renderer collects the answers
	 * and appends them to the description (TASK_UPDATE), so the planner works
	 * from a richer spec. Long call (one-shot LLM subprocess, up to ~90s).
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_SPEC_INTERVIEW,
		async (_, taskId: string): Promise<IPCResult<SpecInterviewQuestion[]>> => {
			const { task } = findTaskAndProject(taskId);
			if (!task) {
				return { success: false, error: "Task not found" };
			}

			const spec = [task.title, task.description].filter(Boolean).join("\n\n");
			if (!spec.trim()) {
				return { success: false, error: "Task has no description to analyze" };
			}

			const questions = await specInterviewService.generateQuestions(
				spec,
				getAppLanguage(),
			);
			if (!questions) {
				return {
					success: false,
					error:
						"Could not generate interview questions. Check your LLM credentials and try again.",
				};
			}
			return { success: true, data: questions };
		},
	);

	/**
	 * Update a task
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_UPDATE,
		async (
			_,
			taskId: string,
			updates: {
				title?: string;
				description?: string;
				metadata?: Partial<TaskMetadata>;
			},
		): Promise<IPCResult<Task>> => {
			try {
				// Find task and project
				const { task, project } = findTaskAndProject(taskId);

				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const autoBuildDir = project.autoBuildPath || ".workpilot";
				const specDir = path.join(
					project.path,
					autoBuildDir,
					"specs",
					task.specId,
				);

				if (!existsSync(specDir)) {
					return { success: false, error: "Spec directory not found" };
				}

				// Derive AI-facing plain text and display HTML from the (possibly
				// HTML) description, mirroring task creation:
				//  - AI-consumed fields (plan, spec.md, task_description) get plain
				//    text so the prompt is never polluted with markup or multi-MB
				//    inlined image data URIs;
				//  - the rich HTML — including inlined Azure DevOps images — is kept
				//    in `display_description` for the UI.
				const descriptionProvided = updates.description !== undefined;
				const descriptionIsHtml =
					descriptionProvided &&
					(updates.description as string).trimStart().startsWith("<");
				let aiDescription = updates.description;
				let displayDescription = updates.description;
				if (descriptionIsHtml) {
					const html = updates.description as string;
					aiDescription = stripHtml(html) || html;
					displayDescription = html;
					if (task.metadata?.importSource === "azure-devops") {
						const az = loadAzureDevOpsConfig(
							project.path,
							project.autoBuildPath || "",
						);
						if (az.pat && az.orgUrl) {
							try {
								displayDescription = await inlineAzureDevOpsImages(
									html,
									az.orgUrl,
									az.pat,
								);
							} catch (err) {
								console.error("[TASK_UPDATE] Image inlining failed:", err);
							}
						}
					}
				}

				// Auto-generate title if empty
				let finalTitle = updates.title;
				if (updates.title !== undefined && !updates.title.trim()) {
					// Get description to use for title generation (plain text)
					const descriptionToUse = aiDescription ?? task.description;
					console.warn(
						"[TASK_UPDATE] Title is empty, generating with Claude AI...",
					);
					try {
						const generatedTitle =
							await titleGenerator.generateTitle(descriptionToUse);
						if (generatedTitle) {
							finalTitle = generatedTitle;
							console.warn("[TASK_UPDATE] Generated title:", finalTitle);
						} else {
							// Fallback: create title from first line of description
							finalTitle = descriptionToUse.split("\n")[0].substring(0, 60);
							if (finalTitle.length === 60) finalTitle += "...";
							console.warn(
								"[TASK_UPDATE] AI generation failed, using fallback:",
								finalTitle,
							);
						}
					} catch (err) {
						console.error("[TASK_UPDATE] Title generation error:", err);
						// Fallback: create title from first line of description
						finalTitle = descriptionToUse.split("\n")[0].substring(0, 60);
						if (finalTitle.length === 60) finalTitle += "...";
					}
				}

				// Update implementation_plan.json
				const planPath = path.join(
					specDir,
					AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				);
				try {
					const planContent = readFileSync(planPath, "utf-8");
					const plan = JSON.parse(planContent);

					if (finalTitle !== undefined) {
						plan.feature = finalTitle;
					}
					if (descriptionProvided) {
						plan.description = aiDescription;
					}
					plan.updated_at = new Date().toISOString();

					writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
				} catch (planErr: unknown) {
					// File missing or invalid JSON - continue anyway
					if ((planErr as NodeJS.ErrnoException).code !== "ENOENT") {
						console.error(
							"[TASK_UPDATE] Error updating implementation plan:",
							planErr,
						);
					}
				}

				// Update spec.md if it exists
				const specPath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
				try {
					let specContent = readFileSync(specPath, "utf-8");

					// Update title (first # heading)
					if (finalTitle !== undefined) {
						specContent = specContent.replace(/^#\s+.*$/m, `# ${finalTitle}`);
					}

					// Update description (## Overview section content)
					if (descriptionProvided) {
						// Replace content between ## Overview and the next ## section
						specContent = specContent.replace(
							/(## Overview\n)([\s\S]*?)((?=\n## )|$)/,
							`$1${aiDescription}\n\n$3`,
						);
					}

					writeFileSync(specPath, specContent, "utf-8");
				} catch (specErr: unknown) {
					// File missing or update failed - continue anyway
					if ((specErr as NodeJS.ErrnoException).code !== "ENOENT") {
						console.error("[TASK_UPDATE] Error updating spec.md:", specErr);
					}
				}

				// Update metadata if provided
				let updatedMetadata = task.metadata;
				if (updates.metadata) {
					updatedMetadata = { ...task.metadata, ...updates.metadata };

					// Process and save attached images if provided
					if (
						updates.metadata.attachedImages &&
						updates.metadata.attachedImages.length > 0
					) {
						const attachmentsDir = path.join(specDir, "attachments");
						mkdirSync(attachmentsDir, { recursive: true });
						const resolvedAttachmentsDir = path.resolve(attachmentsDir);

						// MIME type allowlist (defense in depth - frontend also validates)
						const ALLOWED_MIME_TYPES = [
							"image/png",
							"image/jpeg",
							"image/jpg",
							"image/gif",
							"image/webp",
							"image/svg+xml",
						];

						const savedImages: typeof updates.metadata.attachedImages = [];

						for (const image of updates.metadata.attachedImages) {
							// If image has data (new image), save it
							if (image.data) {
								// Validate MIME type
								if (
									!image.mimeType ||
									!ALLOWED_MIME_TYPES.includes(image.mimeType)
								) {
									console.warn(
										`[TASK_UPDATE] Skipping image with missing or disallowed MIME type: ${image.mimeType}`,
									);
									continue;
								}

								// Sanitize filename to prevent path traversal attacks
								const sanitizedFilename = path.basename(image.filename);
								if (
									!sanitizedFilename ||
									sanitizedFilename === "." ||
									sanitizedFilename === ".."
								) {
									console.warn(
										`[TASK_UPDATE] Skipping image with invalid filename: ${image.filename}`,
									);
									continue;
								}

								// Validate resolved path stays within attachments directory
								const imagePath = path.join(attachmentsDir, sanitizedFilename);
								const resolvedPath = path.resolve(imagePath);
								if (
									!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)
								) {
									console.warn(
										`[TASK_UPDATE] Skipping image with path traversal attempt: ${image.filename}`,
									);
									continue;
								}

								try {
									const buffer = Buffer.from(image.data, "base64");
									writeFileSync(imagePath, buffer);

									savedImages.push({
										id: image.id,
										filename: sanitizedFilename,
										mimeType: image.mimeType,
										size: image.size,
										path: `attachments/${sanitizedFilename}`,
									});
								} catch (err) {
									console.error(
										`Failed to save image ${sanitizedFilename}:`,
										err,
									);
								}
							} else if (image.path) {
								// Existing image, keep it
								savedImages.push(image);
							}
						}

						updatedMetadata.attachedImages = savedImages;
					}

					// Update task_metadata.json
					const metadataPath = path.join(specDir, "task_metadata.json");
					try {
						writeFileSync(
							metadataPath,
							JSON.stringify(updatedMetadata, null, 2),
							"utf-8",
						);
					} catch (err) {
						console.error("Failed to update task_metadata.json:", err);
					}

					// Update requirements.json if it exists
					const requirementsPath = path.join(specDir, "requirements.json");
					try {
						const requirementsContent = readFileSync(requirementsPath, "utf-8");
						const requirements = JSON.parse(requirementsContent);

						if (descriptionProvided) {
							requirements.task_description = aiDescription;
							// Keep the rich HTML (with inlined images) for display only,
							// without polluting the AI-consumed task_description.
							if (descriptionIsHtml && displayDescription !== aiDescription) {
								requirements.display_description = displayDescription;
							} else {
								delete requirements.display_description;
							}
						}
						if (updates.metadata.category) {
							requirements.workflow_type = updates.metadata.category;
						}
						if (updates.metadata.acceptanceCriteria !== undefined) {
							requirements.acceptance_criteria =
								updates.metadata.acceptanceCriteria;
						}
						if (updates.metadata.extraNote !== undefined) {
							const trimmed = updates.metadata.extraNote.trim();
							if (trimmed) {
								requirements.additional_context = trimmed;
							} else {
								delete requirements.additional_context;
							}
						}

						writeFileSync(
							requirementsPath,
							JSON.stringify(requirements, null, 2),
							"utf-8",
						);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
							console.error("Failed to update requirements.json:", err);
						}
					}
				}

				// Build the updated task object. Surface the display HTML (with
				// inlined images) so the UI matches what is persisted as
				// display_description, consistent with task creation.
				const updatedTask: Task = {
					...task,
					title: finalTitle ?? task.title,
					description: displayDescription ?? task.description,
					metadata: updatedMetadata,
					updatedAt: new Date(),
				};

				// Invalidate cache since a task was updated
				projectStore.invalidateTasksCache(project.id);

				return { success: true, data: updatedTask };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	/**
	 * Load an image thumbnail from disk
	 * Used to load thumbnails for images that were saved without base64 data
	 * @param projectPath - The project root path
	 * @param specId - The spec ID
	 * @param imagePath - Relative path to the image (e.g., 'attachments/image.png')
	 * @returns Base64 data URL thumbnail
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_LOAD_IMAGE_THUMBNAIL,
		async (
			_,
			projectPath: string,
			specId: string,
			imagePath: string,
		): Promise<IPCResult<string>> => {
			try {
				// Validate specId to prevent path traversal attacks
				if (!isValidTaskId(specId)) {
					console.error(
						`[IPC] TASK_LOAD_IMAGE_THUMBNAIL: Invalid specId rejected: "${specId}"`,
					);
					return { success: false, error: "Invalid spec ID" };
				}

				// Get project to determine auto-build path - validate projectPath exists
				const projects = projectStore.getProjects();
				const project = projects.find((p) => p.path === projectPath);
				if (!project) {
					console.error(
						`[IPC] TASK_LOAD_IMAGE_THUMBNAIL: Unknown project: "${projectPath}"`,
					);
					return { success: false, error: "Unknown project" };
				}
				const autoBuildPath = project.autoBuildPath || ".workpilot";

				// Build full path to the image
				const specsDir = getSpecsDir(autoBuildPath);
				const fullImagePath = path.join(
					projectPath,
					specsDir,
					specId,
					imagePath,
				);

				// Validate path to prevent path traversal attacks
				const expectedBase = path.resolve(
					path.join(projectPath, specsDir, specId),
				);
				const resolvedPath = path.resolve(fullImagePath);
				if (!isPathWithinBase(resolvedPath, expectedBase)) {
					console.error(
						`[IPC] Path traversal detected: imagePath "${imagePath}" resolves outside spec directory`,
					);
					return { success: false, error: "Invalid image path" };
				}

				if (!existsSync(fullImagePath)) {
					return { success: false, error: `Image not found: ${imagePath}` };
				}

				// Load image using nativeImage
				const image = nativeImage.createFromPath(fullImagePath);
				if (image.isEmpty()) {
					return { success: false, error: "Failed to load image" };
				}

				// Get original size
				const size = image.getSize();
				const maxSize = 200;

				// Calculate thumbnail dimensions while maintaining aspect ratio
				let width = size.width;
				let height = size.height;
				if (width > height) {
					if (width > maxSize) {
						height = Math.round((height * maxSize) / width);
						width = maxSize;
					}
				} else {
					if (height > maxSize) {
						width = Math.round((width * maxSize) / height);
						height = maxSize;
					}
				}

				// Resize to thumbnail
				const thumbnail = image.resize({ width, height, quality: "good" });

				// Convert to base64 data URL
				// Use JPEG for thumbnails (smaller size, good for previews)
				const base64 = thumbnail.toJPEG(80).toString("base64");
				const dataUrl = `data:image/jpeg;base64,${base64}`;

				return { success: true, data: dataUrl };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Unknown error loading thumbnail",
				};
			}
		},
	);
}
