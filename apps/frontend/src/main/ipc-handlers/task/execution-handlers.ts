import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserWindow, ipcMain } from "electron";

// ESM doesn't expose __dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import { isAnthropicNativeVersionedModelId } from "../../../shared/constants/models";
import type { TaskEvent } from "../../../shared/state-machines/task-machine";
import type {
	ImageAttachment,
	IPCResult,
	Project,
	Task,
	TaskStartOptions,
	TaskStatus,
} from "../../../shared/types";
import type {
	PhaseModelConfig,
	PhaseThinkingConfig,
} from "../../../shared/types/settings";
import type { AgentManager } from "../../agent";
import { getAppLanguage } from "../../app-language";
import { appLog } from "../../app-logger";
import {
	type ClaudeProfileManager,
	initializeClaudeProfileManager,
} from "../../claude-profile-manager";
import { getToolPath } from "../../cli-tool-manager";
import { fileWatcher } from "../../file-watcher";
import { checkGitStatus } from "../../project-initializer";
import { projectStore } from "../../project-store";
import { pythonEnvManager } from "../../python-env-manager";
import { readSettingsFile } from "../../settings-utils";
import { taskStateManager } from "../../task-state-manager";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { findTaskWorktree } from "../../worktree-paths";
import { cleanupWorktree } from "../../utils/worktree-cleanup";
import {
	createPlanIfNotExists,
	getPlanPath,
	persistPlanStatus,
	updatePlanSubtasks,
	getModifiedFilesFromWorktree,
	generateSubtasksFromModifiedFiles,
} from "./plan-file-utils";
import { findTaskAndProject } from "./shared";

/**
 * Returns true if the currently active provider requires Claude OAuth authentication.
 * Non-Claude providers (Windsurf, OpenAI, Google, etc.) handle their own auth
 * and should not be blocked by the Claude profile auth check.
 */
function requiresClaudeAuth(): boolean {
	const settings = readSettingsFile();
	const selectedProvider = (
		settings?.selectedProvider as string | undefined
	)?.toLowerCase();
	return (
		!selectedProvider ||
		selectedProvider === "claude" ||
		selectedProvider === "anthropic"
	);
}

/**
 * Convert TaskMetadata to SpecCreationMetadata for spec creation
 * This handles the type incompatibility between the two metadata types
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
function convertTaskMetadataToSpecCreation(metadata?: any): any {
	if (!metadata) return undefined;

	return {
		requireReviewBeforeCoding: metadata.requireReviewBeforeCoding,
		provider: metadata.provider,
		isAutoProfile: metadata.isAutoProfile,
		phaseModels: convertPhaseModelConfig(metadata.phaseModels),
		phaseThinking: convertPhaseThinkingConfig(metadata.phaseThinking),
		model: metadata.model,
		thinkingLevel: metadata.thinkingLevel,
		useWorktree: metadata.useWorktree,
		useLocalBranch: metadata.useLocalBranch,
		tddMode: metadata.tddMode,
	};
}

/**
 * Convert PhaseModelConfig (string-based) to SpecCreationMetadata format (literal union)
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
function convertPhaseModelConfig(phaseModels?: any): any {
	if (!phaseModels) return undefined;

	return {
		spec: phaseModels.spec || "sonnet",
		planning: phaseModels.planning || "sonnet",
		coding: phaseModels.coding || "sonnet",
		qa: phaseModels.qa || "sonnet",
	};
}

/**
 * Convert PhaseThinkingConfig to SpecCreationMetadata format
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
function convertPhaseThinkingConfig(phaseThinking?: any): any {
	if (!phaseThinking) return undefined;

	return {
		spec: phaseThinking.spec || "medium",
		planning: phaseThinking.planning || "medium",
		coding: phaseThinking.coding || "medium",
		qa: phaseThinking.qa || "medium",
	};
}

/**
 * Synchronise le provider de la tâche avec le provider actuel du projet.
 * Appelé à chaque démarrage/redémarrage pour permettre le changement de provider à la volée.
 *
 * @returns L'ancien provider si un changement a eu lieu, null sinon.
 */
function syncTaskProvider(
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	task: any,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	project: any,
	specDir: string,
): string | null {
	if (!task.metadata) return null;

	// Use project-level provider if set, otherwise fall back to the global
	// selectedProvider from settings.json (set by the UI provider selector).
	// Without this fallback, selecting a provider globally in the UI has no effect
	// on task execution — the task silently falls back to Anthropic.
	const projectProvider =
		project.settings?.provider ??
		(readSettingsFile()?.selectedProvider as string | undefined);
	const taskProvider = task.metadata.provider;

	// No change needed
	if (!projectProvider || projectProvider === taskProvider) {
		handleInitialProviderInjection(task, projectProvider, specDir);
		return null;
	}

	// Provider changed - update task and persist changes
	return handleProviderChange(task, projectProvider, specDir);
}

/**
 * Handle initial provider injection when task has no provider set
 */
function handleInitialProviderInjection(
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	task: any,
	projectProvider: string | undefined,
	specDir: string,
): void {
	if (!task.metadata.provider && projectProvider) {
		task.metadata.provider = projectProvider;
		persistProviderToMetadata(
			specDir,
			projectProvider,
			{},
			{},
			"initial provider injection",
		);
	}
}

/**
 * Handle provider change and update task metadata
 */
function handleProviderChange(
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	task: any,
	projectProvider: string,
	specDir: string,
): string | null {
	const previousProvider = task.metadata.provider;

	// Get provider-specific configurations
	const { providerPhaseModels, providerPhaseThinking } =
		getProviderConfigurations(projectProvider);

	// Update task metadata
	updateTaskProviderMetadata(
		task,
		projectProvider,
		providerPhaseModels,
		providerPhaseThinking,
	);

	// Log the change
	console.warn(
		`[Provider Switch] ${previousProvider} -> ${projectProvider} for task ${task.id}`,
	);

	// Persist changes to disk
	persistProviderToMetadata(
		specDir,
		projectProvider,
		providerPhaseModels,
		providerPhaseThinking,
		"provider switch",
	);

	return previousProvider;
}

/**
 * Get provider-specific configurations from global settings
 */
function getProviderConfigurations(projectProvider: string): {
	providerPhaseModels: unknown;
	providerPhaseThinking: unknown;
} {
	const globalSettings = readSettingsFile() ?? {};
	const providerPhaseModels = (
		globalSettings.providerPhaseModels as Record<string, unknown> | undefined
	)?.[projectProvider];
	const providerPhaseThinking = (
		globalSettings.providerPhaseThinking as Record<string, unknown> | undefined
	)?.[projectProvider];

	return { providerPhaseModels, providerPhaseThinking };
}

/**
 * Update task metadata with new provider information
 */
function updateTaskProviderMetadata(
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	task: any,
	projectProvider: string,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	providerPhaseModels: any,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	providerPhaseThinking: any,
): void {
	task.metadata.provider = projectProvider;
	if (providerPhaseModels) task.metadata.phaseModels = providerPhaseModels;
	if (providerPhaseThinking)
		task.metadata.phaseThinking = providerPhaseThinking;
}

/**
 * Persist provider changes to metadata file
 */
function persistProviderToMetadata(
	specDir: string,
	projectProvider: string,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	providerPhaseModels: any,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	providerPhaseThinking: any,
	context: string,
): void {
	try {
		const metadataPath = path.join(specDir, "task_metadata.json");
		if (!existsSync(metadataPath)) return;

		const content = safeReadFileSync(metadataPath);
		if (!content) return;

		const meta = JSON.parse(content);
		meta.provider = projectProvider;
		if (providerPhaseModels) meta.phaseModels = providerPhaseModels;
		if (providerPhaseThinking) meta.phaseThinking = providerPhaseThinking;

		// When switching to a non-Anthropic provider, clear any Anthropic-specific
		// versioned model ID (e.g. "claude-sonnet-4-5-20250929") from the single
		// model field so the backend falls back to PROVIDER_DEFAULT_MODELS for the
		// new provider instead of sending an invalid model ID to the API.
		//
		// IMPORTANT: Copilot exposes Claude models in dot notation (e.g.
		// "claude-opus-4.8", "claude-sonnet-4.6") which ARE valid and must be
		// preserved. Only dash-versioned Anthropic-native IDs are cleared — see
		// isAnthropicNativeVersionedModelId.
		const isNonAnthropicProvider =
			projectProvider &&
			projectProvider !== "anthropic" &&
			projectProvider !== "claude";
		const hasAnthropicVersionedModel =
			typeof meta.model === "string" &&
			isAnthropicNativeVersionedModelId(meta.model);
		if (isNonAnthropicProvider && hasAnthropicVersionedModel) {
			delete meta.model;
		}

		atomicWriteFileSync(metadataPath, JSON.stringify(meta, null, 2));
		console.warn(`[Provider Sync] Persisted ${context} to task_metadata.json`);
	} catch (err) {
		console.warn(`[Provider Sync] Failed to persist ${context}:`, err);
	}
}

/**
 * Atomic file write to prevent TOCTOU race conditions.
 * Writes to a temporary file first, then atomically renames to target.
 * This ensures the target file is never in an inconsistent state.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
	const tempPath = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, content, "utf-8");
		renameSync(tempPath, filePath);
	} catch (error) {
		// Clean up the temp file if rename failed
		try {
			unlinkSync(tempPath);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if a file doesn't exist or can't be read.
 */
function safeReadFileSync(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		// ENOENT (file not found) is expected, other errors should be logged
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			appLog.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
		}
		return null;
	}
}

/**
 * Helper function to check subtask completion status
 */
function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
	allSubtasks: Array<{ status: string }>;
	completedCount: number;
	totalCount: number;
	allCompleted: boolean;
} {
	const allSubtasks =
		(
			plan?.phases as
				| Array<{ subtasks?: Array<{ status: string }> }>
				| undefined
		)?.flatMap((phase) => phase.subtasks || []) || [];
	const completedCount = allSubtasks.filter(
		(s) => s.status === "completed",
	).length;
	const totalCount = allSubtasks.length;
	const allCompleted = totalCount > 0 && completedCount === totalCount;

	return { allSubtasks, completedCount, totalCount, allCompleted };
}

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 *
 * @returns Success with profile manager, or failure with error message
 */
async function ensureProfileManagerInitialized(): Promise<
	| { success: true; profileManager: ClaudeProfileManager }
	| { success: false; error: string }
> {
	try {
		const profileManager = await initializeClaudeProfileManager();
		return { success: true, profileManager };
	} catch (error) {
		appLog.error(
			"[ensureProfileManagerInitialized] Failed to initialize:",
			error,
		);
		// Include actual error details for debugging while providing actionable guidance
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`,
		};
	}
}

/**
 * Determine the appropriate start event based on current state
 */
function determineStartEvent(
	taskId: string,
	task: Task,
): { type: TaskEvent["type"]; resetTask?: Task } {
	const currentXState = taskStateManager.getCurrentState(taskId);

	if (currentXState === "done") {
		taskStateManager.clearTask(taskId);
		const resetTask = {
			...task,
			status: "backlog" as TaskStatus,
			reviewReason: undefined,
			executionProgress: undefined,
		};
		return { type: "PLANNING_STARTED", resetTask };
	}

	if (currentXState === "plan_review") {
		return { type: "PLAN_APPROVED" };
	}

	if (currentXState === "human_review" || currentXState === "error") {
		// Une tache en echec pendant la planification n'a pas de plan/sous-taches :
		// il faut relancer la planification, pas sauter au codage. Sinon XState
		// reste sur un etat incoherent et le garde "settled-state" peut bloquer la
		// progression cote frontend.
		if (currentXState === "error" && (task.subtasks?.length ?? 0) === 0) {
			return { type: "PLANNING_STARTED" };
		}
		return { type: "USER_RESUMED" };
	}

	if (currentXState === "backlog") {
		return { type: "PLANNING_STARTED" };
	}

	if (currentXState) {
		taskStateManager.clearTask(taskId);
		const resetTask = {
			...task,
			status: "backlog" as TaskStatus,
			reviewReason: undefined,
			executionProgress: undefined,
		};
		return { type: "PLANNING_STARTED", resetTask };
	}

	// No XState actor - fallback to task data
	if (task.status === "human_review" && task.reviewReason === "plan_review") {
		return { type: "PLAN_APPROVED" };
	}

	if (task.status === "human_review" || task.status === "error") {
		if (task.status === "error" && (task.subtasks?.length ?? 0) === 0) {
			return { type: "PLANNING_STARTED" };
		}
		return { type: "USER_RESUMED" };
	}

	// Fresh start
	return { type: "PLANNING_STARTED" };
}

/**
 * Validate prerequisites for task execution
 */
async function validateTaskPrerequisites(
	taskId: string,
	_mainWindow: BrowserWindow,
): Promise<
	| {
			success: true;
			profileManager: ClaudeProfileManager;
			task: Task;
			project: Project;
	  }
	| { success: false; error: string }
> {
	// Ensure profile manager is initialized before checking auth
	const initResult = await ensureProfileManagerInitialized();
	if (!initResult.success) {
		return { success: false, error: initResult.error };
	}

	// Find task and project
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) {
		return { success: false, error: "Task or project not found" };
	}

	// Check git status
	const gitStatus = checkGitStatus(project.path);
	if (!gitStatus.isGitRepo) {
		return {
			success: false,
			error:
				'Git repository required. Please run "git init" in your project directory. WorkPilot AI uses git worktrees for isolated builds.',
		};
	}
	if (!gitStatus.hasCommits) {
		return {
			success: false,
			error:
				'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
		};
	}

	// Check authentication for Claude
	if (requiresClaudeAuth() && !initResult.profileManager.hasValidAuth()) {
		return {
			success: false,
			error:
				"Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.",
		};
	}

	return {
		success: true,
		profileManager: initResult.profileManager,
		task,
		project,
	};
}

/**
 * Setup task execution environment
 */
function setupTaskExecution(
	taskId: string,
	task: Task,
	project: Project,
): {
	specDir: string;
	hasSpec: boolean;
	needsSpecCreation: boolean;
	needsImplementation: boolean;
} {
	const specsBaseDir = getSpecsDir(project.autoBuildPath);
	const specDir = path.join(project.path, specsBaseDir, task.specId);

	// Start file watcher
	fileWatcher.watch(taskId, specDir);

	// Check if spec.md exists
	const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
	const hasSpec = existsSync(specFilePath);
	const needsSpecCreation = !hasSpec;
	const needsImplementation = hasSpec && task.subtasks.length === 0;

	return { specDir, hasSpec, needsSpecCreation, needsImplementation };
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Start the appropriate task execution based on needs
	 */
	function startTaskExecution(
		taskId: string,
		task: Task,
		project: Project,
		specDir: string,
		needsSpecCreation: boolean,
		needsImplementation: boolean,
		options?: TaskStartOptions,
	): void {
		const baseBranch =
			task.metadata?.baseBranch || project.settings?.mainBranch;
		const taskDescription = task.description || task.title;

		if (needsSpecCreation) {
			console.warn(
				"[TASK_START] Starting spec creation for:",
				task.specId,
				"in:",
				specDir,
				"baseBranch:",
				baseBranch,
			);
			agentManager.startSpecCreation(
				taskId,
				project.path,
				taskDescription,
				specDir,
				convertTaskMetadataToSpecCreation(task.metadata),
				baseBranch,
				project.id,
			);
			return;
		}

		const executionOptions = {
			parallel: false,
			workers: 1,
			baseBranch,
			useWorktree: task.metadata?.useWorktree,
			useLocalBranch: task.metadata?.useLocalBranch,
			tddMode: task.metadata?.tddMode,
			enableStreaming: options?.enableStreaming ?? true,
			streamingSessionId: options?.streamingSessionId ?? taskId,
		};

		if (needsImplementation) {
			console.warn(
				"[TASK_START] Starting task execution (no subtasks) for:",
				task.specId,
			);
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);
		} else {
			console.warn(
				"[TASK_START] Starting task execution (has subtasks) for:",
				task.specId,
			);
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);
		}
	}

	/**
	 * Start a task
	 */
	ipcMain.on(
		IPC_CHANNELS.TASK_START,
		async (_, taskId: string, options?: TaskStartOptions) => {
			console.warn(
				"[TASK_START] Received request for taskId:",
				taskId,
				"with options:",
				options,
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				console.warn("[TASK_START] No main window found");
				return;
			}

			// Validate prerequisites
			const validation = await validateTaskPrerequisites(taskId, mainWindow);
			if (!validation.success) {
				mainWindow.webContents.send(
					IPC_CHANNELS.TASK_ERROR,
					taskId,
					validation.error,
				);
				return;
			}

			const { task, project } = validation;
			console.warn(
				"[TASK_START] Found task:",
				task.specId,
				"status:",
				task.status,
				"reviewReason:",
				task.reviewReason,
				"subtasks:",
				task.subtasks.length,
			);

			// Determine and execute start event
			const startEvent = determineStartEvent(taskId, task);
			const taskToUse = startEvent.resetTask || task;

			// Create proper event object based on type
			let event: TaskEvent;
			if (startEvent.type === "PR_CREATED") {
				// This case shouldn't happen in start event, but handle for type safety
				event = { type: startEvent.type, prUrl: "" };
			} else {
				event = { type: startEvent.type } as TaskEvent;
			}

			taskStateManager.handleUiEvent(taskId, event, taskToUse, project);

			// Reset for new run
			taskStateManager.resetForNewRun(taskId);

			// Setup execution environment
			const { specDir, needsSpecCreation, needsImplementation } =
				setupTaskExecution(taskId, task, project);
			console.warn(
				"[TASK_START] hasSpec:",
				!needsSpecCreation,
				"needsSpecCreation:",
				needsSpecCreation,
				"needsImplementation:",
				needsImplementation,
			);

			// Sync provider
			const previousProvider = syncTaskProvider(task, project, specDir);
			if (previousProvider) {
				console.warn(
					`[TASK_START] Provider switched: ${previousProvider} -> ${task.metadata?.provider}`,
				);
			} else {
				console.warn(
					"[TASK_START] Provider:",
					task.metadata?.provider ?? "none",
				);
			}

			// Start execution
			startTaskExecution(
				taskId,
				task,
				project,
				specDir,
				needsSpecCreation,
				needsImplementation,
				options,
			);
		},
	);

	/**
	 * Resume a Claude SDK session for a task that hit max_turns or max_budget_usd.
	 *
	 * Reads the session_id persisted by the Python backend in
	 * `<specDir>/.session.json` and re-spawns the build subprocess with
	 * AUTO_CLAUDE_RESUME_SESSION_ID set. The backend's create_client()
	 * picks it up and passes it to ClaudeAgentOptions(resume=...), so the
	 * SDK rehydrates the prior transcript instead of replaying from scratch.
	 *
	 * Distinct from TASK_RESUME_PAUSED which handles rate-limit/auth pauses.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_SESSION,
		async (_, taskId: string): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);
			const sessionFile = path.join(specDir, ".session.json");

			if (!existsSync(sessionFile)) {
				return {
					success: false,
					error: "No persisted SDK session found for this task — run it once first.",
				};
			}

			let sessionId: string | undefined;
			try {
				const raw = readFileSync(sessionFile, "utf-8");
				const parsed = JSON.parse(raw) as { session_id?: string };
				sessionId = parsed.session_id;
			} catch (err) {
				return {
					success: false,
					error: `Could not read .session.json: ${(err as Error).message}`,
				};
			}

			if (!sessionId) {
				return {
					success: false,
					error: ".session.json is missing the session_id field.",
				};
			}

			// Spawn the build subprocess with the resume flag carried in env.
			// Reuse startTaskExecution so the same auth/path checks fire.
			const executionOptions = {
				parallel: false,
				workers: 1,
				baseBranch: task.metadata?.baseBranch || project.settings?.mainBranch,
				useWorktree: task.metadata?.useWorktree,
				useLocalBranch: task.metadata?.useLocalBranch,
				enableStreaming: true,
				streamingSessionId: taskId,
				resumeSessionId: sessionId,
			};
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);

			appLog.info(
				`[TASK_RESUME_SESSION] Resumed task ${task.specId} with session_id=${sessionId}`,
			);
			return { success: true };
		},
	);

	/**
	 * Stop a task
	 */
	ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
		agentManager.killTask(taskId);
		fileWatcher.unwatch(taskId);

		// Find task and project to emit USER_STOPPED with plan context
		const { task, project } = findTaskAndProject(taskId);

		if (!task || !project) return;

		let hasPlan = false;
		try {
			const planPath = getPlanPath(project, task);
			const planContent = safeReadFileSync(planPath);
			if (planContent) {
				const plan = JSON.parse(planContent);
				const { totalCount } = checkSubtasksCompletion(plan);
				hasPlan = totalCount > 0;
			}
		} catch {
			hasPlan = false;
		}

		taskStateManager.handleUiEvent(
			taskId,
			{ type: "USER_STOPPED", hasPlan },
			task,
			project,
		);
	});

	/**
	 * Review a task (approve or reject)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_REVIEW,
		async (
			_,
			taskId: string,
			approved: boolean,
			feedback?: string,
			images?: ImageAttachment[],
		): Promise<IPCResult> => {
			// Find task and project
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Check if dev mode is enabled for this project
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);

			// Check if worktree exists - QA needs to run in the worktree where the build happened
			const worktreePath = findTaskWorktree(project.path, task.specId);
			const worktreeSpecDir = worktreePath
				? path.join(worktreePath, specsBaseDir, task.specId)
				: null;
			const hasWorktree = worktreePath !== null;

			if (approved) {
				// Write approval to QA report
				const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
				try {
					writeFileSync(
						qaReportPath,
						`# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`,
						"utf-8",
					);
				} catch (error) {
					appLog.error("[TASK_REVIEW] Failed to write QA report:", error);
					return { success: false, error: "Failed to write QA report file" };
				}

				taskStateManager.handleUiEvent(
					taskId,
					{ type: "MARK_DONE" },
					task,
					project,
				);
			} else {
				// Reset and discard all changes from worktree merge in main
				// The worktree still has all changes, so nothing is lost
				if (hasWorktree) {
					// Step 1: Unstage all changes
					const resetResult = spawnSync(getToolPath("git"), ["reset", "HEAD"], {
						cwd: project.path,
						encoding: "utf-8",
						stdio: "pipe",
						env: getIsolatedGitEnv(),
					});
					if (resetResult.status === 0) {
						appLog.info("[TASK_REVIEW] Unstaged changes in main");
					}

					// Step 2: Discard all working tree changes (restore to pre-merge state)
					const checkoutResult = spawnSync(
						getToolPath("git"),
						["checkout", "--", "."],
						{
							cwd: project.path,
							encoding: "utf-8",
							stdio: "pipe",
							env: getIsolatedGitEnv(),
						},
					);
					if (checkoutResult.status === 0) {
						appLog.info("[TASK_REVIEW] Discarded working tree changes in main");
					}

					// Step 3: Clean untracked files that came from the merge
					// IMPORTANT: Exclude .workpilot directory to preserve specs and worktree data
					const cleanResult = spawnSync(
						getToolPath("git"),
						["clean", "-fd", "-e", ".workpilot"],
						{
							cwd: project.path,
							encoding: "utf-8",
							stdio: "pipe",
							env: getIsolatedGitEnv(),
						},
					);
					if (cleanResult.status === 0) {
						appLog.info(
							"[TASK_REVIEW] Cleaned untracked files in main (excluding .workpilot)",
						);
					}

					appLog.info("[TASK_REVIEW] Main branch restored to pre-merge state");
				}

				// Write feedback for QA fixer - write to WORKTREE spec dir if it exists
				// The QA process runs in the worktree where the build and implementation_plan.json are
				const targetSpecDir =
					hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
				const fixRequestPath = path.join(targetSpecDir, "QA_FIX_REQUEST.md");

				console.warn(
					"[TASK_REVIEW] Writing QA fix request to:",
					fixRequestPath,
				);
				console.warn(
					"[TASK_REVIEW] hasWorktree:",
					hasWorktree,
					"worktreePath:",
					worktreePath,
				);

				// Process images if provided
				let imageReferences = "";
				if (images && images.length > 0) {
					const imagesDir = path.join(targetSpecDir, "feedback_images");
					try {
						if (!existsSync(imagesDir)) {
							mkdirSync(imagesDir, { recursive: true });
						}
						const savedImages: string[] = [];
						for (const image of images) {
							try {
								if (!image.data) {
									console.warn(
										"[TASK_REVIEW] Skipping image with no data:",
										image.filename,
									);
									continue;
								}
								// Server-side MIME type validation (defense in depth - frontend also validates)
								// Reject missing mimeType to prevent bypass attacks
								const ALLOWED_MIME_TYPES = [
									"image/png",
									"image/jpeg",
									"image/jpg",
									"image/gif",
									"image/webp",
									"image/svg+xml",
								];
								if (
									!image.mimeType ||
									!ALLOWED_MIME_TYPES.includes(image.mimeType)
								) {
									console.warn(
										"[TASK_REVIEW] Skipping image with missing or disallowed MIME type:",
										image.mimeType,
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
										"[TASK_REVIEW] Skipping image with invalid filename:",
										image.filename,
									);
									continue;
								}
								// Remove data URL prefix if present (e.g., "data:image/png;base64," or "data:image/svg+xml;base64,")
								const base64Data = image.data.replace(
									/^data:image\/[^;]+;base64,/,
									"",
								);
								const imageBuffer = Buffer.from(base64Data, "base64");
								const imagePath = path.join(imagesDir, sanitizedFilename);
								// Verify the resolved path is within the images directory (defense in depth)
								const resolvedPath = path.resolve(imagePath);
								const resolvedImagesDir = path.resolve(imagesDir);
								if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
									console.warn(
										"[TASK_REVIEW] Skipping image with path outside target directory:",
										image.filename,
									);
									continue;
								}
								writeFileSync(imagePath, imageBuffer);
								savedImages.push(`feedback_images/${sanitizedFilename}`);
								appLog.info("[TASK_REVIEW] Saved image:", sanitizedFilename);
							} catch (imgError) {
								appLog.error(
									"[TASK_REVIEW] Failed to save image:",
									image.filename,
									imgError,
								);
							}
						}
						if (savedImages.length > 0) {
							imageReferences =
								"\n\n## Reference Images\n\n" +
								savedImages
									.map((imgPath) => `![Feedback Image](${imgPath})`)
									.join("\n\n");
						}
					} catch (dirError) {
						appLog.error(
							"[TASK_REVIEW] Failed to create images directory:",
							dirError,
						);
					}
				}

				try {
					writeFileSync(
						fixRequestPath,
						`# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || "No feedback provided"}${imageReferences}\n\nCreated at: ${new Date().toISOString()}\n`,
						"utf-8",
					);
				} catch (error) {
					appLog.error("[TASK_REVIEW] Failed to write QA fix request:", error);
					return {
						success: false,
						error: "Failed to write QA fix request file",
					};
				}

				// Generate subtasks from modified files and feedback
				// This creates new subtasks in the implementation plan with the modified files attached
				if (hasWorktree && worktreePath) {
					try {
						console.warn("[TASK_REVIEW] Generating subtasks from modified files...");

						// Get modified files from the worktree
						const modifiedFiles = getModifiedFilesFromWorktree(worktreePath);

						if (modifiedFiles.length > 0) {
							// Generate subtasks grouped by directory
							const newSubtasks = generateSubtasksFromModifiedFiles(
								modifiedFiles,
								feedback || "Needs fixes based on user feedback",
							);

							// Load the current implementation plan
							const planPath = path.join(
								worktreeSpecDir || specDir,
								AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
							);

							try {
								const planContent = readFileSync(planPath, "utf-8");
								const plan = JSON.parse(planContent);

								// Add new subtasks to the Implementation phase or create it
								if (!plan.phases) {
									plan.phases = [];
								}

								let implPhase = plan.phases.find(
									(p: Record<string, unknown>) => p.name === "Implementation",
								);
								if (!implPhase) {
									implPhase = { name: "Implementation", subtasks: [] };
									plan.phases.push(implPhase);
								}

								// Add the new subtasks
								if (!Array.isArray(implPhase.subtasks)) {
									implPhase.subtasks = [];
								}
								implPhase.subtasks.push(...newSubtasks);

								// Update the plan file
								writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");

								console.warn(
									`[TASK_REVIEW] Added ${newSubtasks.length} new subtasks to implementation plan`,
								);
								appLog.info(
									`[TASK_REVIEW] Generated ${newSubtasks.length} subtasks from ${modifiedFiles.length} modified files`,
								);
							} catch (planError) {
								console.warn(
									"[TASK_REVIEW] Could not update implementation plan with subtasks:",
									planError,
								);
								// Log but don't fail - the QA process will still run
								appLog.warn(
									`[TASK_REVIEW] Failed to generate subtasks from modified files: ${planError instanceof Error ? planError.message : String(planError)}`,
								);
							}
						} else {
							console.warn(
								"[TASK_REVIEW] No modified files detected in worktree",
							);
						}
					} catch (subtaskError) {
						console.warn(
							"[TASK_REVIEW] Error generating subtasks:",
							subtaskError,
						);
						// Don't fail the review - continue with QA process
						appLog.warn(
							`[TASK_REVIEW] Failed to generate subtasks: ${subtaskError instanceof Error ? subtaskError.message : String(subtaskError)}`,
						);
					}
				}

				// Reset existing subtasks to "pending" in the implementation plan
				// so the full pipeline (planning → coding → QA) will re-process them
				const resetPlanPath = path.join(
					hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir,
					AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				);
				try {
					const resetPlanContent = readFileSync(resetPlanPath, "utf-8");
					const resetPlan = JSON.parse(resetPlanContent);
					if (resetPlan.phases) {
						for (const phase of resetPlan.phases) {
							if (Array.isArray(phase.subtasks)) {
								for (const subtask of phase.subtasks) {
									// Only reset completed/failed subtasks back to pending
									if (subtask.status === "completed" || subtask.status === "failed") {
										subtask.status = "pending";
									}
								}
							}
						}
					}
					// Reset QA signoff so the full pipeline runs again
					if (resetPlan.qa_signoff) {
						resetPlan.qa_signoff.status = "pending";
					}
					resetPlan.status = "in_progress";
					resetPlan.planStatus = "in_progress";
					resetPlan.updated_at = new Date().toISOString();
					writeFileSync(resetPlanPath, JSON.stringify(resetPlan, null, 2), "utf-8");
					appLog.info("[TASK_REVIEW] Reset subtasks to pending for full pipeline re-execution");
				} catch (resetError) {
					appLog.warn(
						`[TASK_REVIEW] Could not reset subtasks in plan: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
					);
				}

				// Start full pipeline (planning → coding → QA) instead of QA-only
				// This ensures changes requested by the user go through the complete workflow
				const qaProjectPath = hasWorktree ? worktreePath : project.path;
				const baseBranch =
					task.metadata?.baseBranch || project.settings?.mainBranch;
				console.warn(
					"[TASK_REVIEW] Starting full pipeline with projectPath:",
					qaProjectPath,
				);
				agentManager.startTaskExecution(
					taskId,
					qaProjectPath,
					task.specId,
					{
						baseBranch,
						useWorktree: task.metadata?.useWorktree,
						useLocalBranch: task.metadata?.useLocalBranch,
						enableStreaming: true,
						streamingSessionId: taskId,
					},
					project.id,
				);

				taskStateManager.handleUiEvent(
					taskId,
					{ type: "USER_RESUMED" },
					task,
					project,
				);
			}

			return { success: true };
		},
	);

	/**
	 * Update task status manually
	 * Options:
	 * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_UPDATE_STATUS,
		async (
			_,
			taskId: string,
			status: TaskStatus,
			_options?: { forceCleanup?: boolean },
		): Promise<
			IPCResult & { worktreeExists?: boolean; worktreePath?: string }
		> => {
			// Find task and project first (needed for worktree check)
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Validate status transition - 'done' creates a PR for human review
			// A worktree must exist with uncommitted or unpushed changes
			if (status === "done") {
				// If a PR already exists for this task, skip PR creation
				// (e.g. task moved out of "done" column and back in)
				const existingPrUrl =
					task.prUrl || task.metadata?.prUrl;
				if (existingPrUrl) {
					console.warn(
						`[TASK_UPDATE_STATUS] PR already exists for task ${taskId}: ${existingPrUrl} — skipping creation`,
					);
					status = "pr_created";
				}

				// Check if worktree exists (task.specId matches worktree folder name)
				const worktreePath = findTaskWorktree(project.path, task.specId);
				const hasWorktree = worktreePath !== null;

				if (!existingPrUrl && hasWorktree) {
					// Worktree exists - create PR for human validation
					console.warn(
						`[TASK_UPDATE_STATUS] Creating PR for task ${taskId} (status: done)`,
					);

					try {
						// Call Python service to create PR
						const pythonExecutable = pythonEnvManager.getPythonPath();
						if (!pythonExecutable) {
							appLog.error(`[TASK_UPDATE_STATUS] Python not configured`);
							return {
								success: false,
								error: "Python environment not configured",
							};
						}

						const backendPath = path.join(
							__dirname,
							"..",
							"..",
							"..",
							"backend",
						);

						// Prepare the script to call the task completion service
						const scriptContent = `
import json
import sys
from pathlib import Path

from services.task_completion_service import create_task_completion_service

# Get project path and task info from command line
project_path = sys.argv[1]
spec_id = sys.argv[2]
task_title = sys.argv[3]
task_description = sys.argv[4] if len(sys.argv) > 4 else None
base_branch = sys.argv[5] if len(sys.argv) > 5 else "develop"

# Create service and complete task
service = create_task_completion_service(project_path, base_branch)
result = service.complete_task(spec_id, task_title, task_description)

# Output result as JSON
print(json.dumps(result))
`;

						// Write temporary script
						const tmpScriptPath = path.join(
							project.path,
							".workpilot",
							"tmp_create_pr.py",
						);
						const tmpDir = path.dirname(tmpScriptPath);
						if (!existsSync(tmpDir)) {
							mkdirSync(tmpDir, { recursive: true });
						}
						writeFileSync(tmpScriptPath, scriptContent, "utf-8");

						// Get base branch from task metadata or project settings
						const baseBranch =
							task.metadata?.baseBranch ||
							project.settings?.mainBranch ||
							"develop";

						// Execute Python script to create PR
						// Run from backendPath so Python resolves all
						// internal imports (core.*, debug, services.*) correctly.
						const result = execFileSync(
							pythonExecutable,
							[
								tmpScriptPath,
								project.path,
								task.specId,
								task.title,
								task.description || "",
								baseBranch,
							],
							{
								cwd: backendPath,
								encoding: "utf-8",
								timeout: 60000, // 60 seconds timeout for PR creation
								env: {
									...process.env,
									APP_LANGUAGE: getAppLanguage(),
									PYTHONPATH: backendPath,
								},
							},
						);

						// Clean up temporary script
						try {
							unlinkSync(tmpScriptPath);
						} catch {
							// Ignore cleanup errors
						}

						// Parse result
						const prResult = JSON.parse(result.trim());

						if (prResult.success) {
							console.warn(
								`[TASK_UPDATE_STATUS] PR created successfully: ${prResult.pr_url}`,
							);

							// Update task with PR URL
							const mainWindow = getMainWindow();
							if (mainWindow && prResult.pr_url) {
								mainWindow.webContents.send(
									IPC_CHANNELS.TASK_UPDATE,
									taskId,
									{ prUrl: prResult.pr_url },
									project.id,
								);
							}

							// Clean up worktree after successful PR creation
							const worktreePath = findTaskWorktree(project.path, task.specId);
							if (worktreePath && existsSync(worktreePath)) {
								try {
									console.warn(
										`[TASK_UPDATE_STATUS] Cleaning up worktree after PR creation: ${worktreePath}`,
									);
									const cleanupResult = await cleanupWorktree({
										worktreePath,
										projectPath: project.path,
										specId: task.specId,
										commitMessage: "Auto-save before cleanup after PR creation",
										logPrefix: "[TASK_UPDATE_STATUS]",
										deleteBranch: true,
									});

									if (cleanupResult.success) {
										console.warn(
											`[TASK_UPDATE_STATUS] Worktree cleaned up after PR creation`,
										);
									} else {
										console.warn(
											`[TASK_UPDATE_STATUS] Worktree cleanup had warnings:`,
											cleanupResult.warnings,
										);
									}
								} catch (cleanupError) {
									console.error(
										`[TASK_UPDATE_STATUS] Error during worktree cleanup:`,
										cleanupError,
									);
									// Non-fatal - PR was created successfully
								}
							}

							// Transition to pr_created status
							status = "pr_created";
						} else {
							appLog.error(
								`[TASK_UPDATE_STATUS] Failed to create PR: ${prResult.error}`,
							);
							return {
								success: false,
								error: `Failed to create PR: ${prResult.error}`,
							};
						}
					} catch (prError) {
						appLog.error(`[TASK_UPDATE_STATUS] Error creating PR:`, prError);
						return {
							success: false,
							error: `Error creating PR: ${prError instanceof Error ? prError.message : String(prError)}`,
						};
					}
				} else if (!existingPrUrl) {
					// No worktree and no existing PR - allow marking as done (limbo state recovery)
					console.warn(
						`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} (no worktree found - limbo state)`,
					);
				}
			}

			// Validate status transition - 'human_review' requires actual work to have been done
			// This prevents tasks from being incorrectly marked as ready for review when execution failed
			if (status === "human_review") {
				const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
				const specDirForValidation = path.join(
					project.path,
					specsBaseDirForValidation,
					task.specId,
				);
				const specFilePath = path.join(
					specDirForValidation,
					AUTO_BUILD_PATHS.SPEC_FILE,
				);

				// Check if spec.md exists and has meaningful content (at least 100 chars)
				const MIN_SPEC_CONTENT_LENGTH = 100;
				let specContent = "";
				try {
					if (existsSync(specFilePath)) {
						specContent = readFileSync(specFilePath, "utf-8");
					}
				} catch {
					// Ignore read errors - treat as empty spec
				}

				if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
					console.warn(
						`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`,
					);
					return {
						success: false,
						error:
							"Cannot move to human review - no spec has been created yet. The task must complete processing before review.",
					};
				}
			}

			// Get the spec directory and plan path using shared utility
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);
			const planPath = getPlanPath(project, task);

			try {
				const handledByMachine = taskStateManager.handleManualStatusChange(
					taskId,
					status,
					task,
					project,
				);
				if (!handledByMachine) {
					// Use shared utility for thread-safe plan file updates (legacy/manual override)
					const persisted = await persistPlanStatus(
						planPath,
						status,
						project.id,
					);

					if (!persisted) {
						// If no implementation plan exists yet, create a basic one
						await createPlanIfNotExists(planPath, task, status);
						// Invalidate cache after creating new plan
						projectStore.invalidateTasksCache(project.id);
					}
				}

				// Auto-stop task when status changes AWAY from 'in_progress' and process IS running
				// This handles the case where user drags a running task back to Planning/backlog
				if (status !== "in_progress" && agentManager.isRunning(taskId)) {
					console.warn(
						"[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:",
						taskId,
					);
					agentManager.killTask(taskId);
				}

				// Auto-start task when status changes to 'in_progress' and no process is running
				if (status === "in_progress" && !agentManager.isRunning(taskId)) {
					const mainWindow = getMainWindow();

					// Check git status before auto-starting
					const gitStatusCheck = checkGitStatus(project.path);
					if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
						console.warn(
							"[TASK_UPDATE_STATUS] Git check failed, cannot auto-start task",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								gitStatusCheck.error ||
									"Git repository with commits required to run tasks.",
							);
						}
						return {
							success: false,
							error: gitStatusCheck.error || "Git repository required",
						};
					}

					// Check authentication before auto-starting
					// Ensure profile manager is initialized to prevent race condition
					const initResult = await ensureProfileManagerInitialized();
					if (!initResult.success) {
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								initResult.error,
							);
						}
						return { success: false, error: initResult.error };
					}
					const profileManager = initResult.profileManager;
					if (requiresClaudeAuth() && !profileManager.hasValidAuth()) {
						console.warn(
							"[TASK_UPDATE_STATUS] No valid authentication for active profile",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								"Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.",
							);
						}
						return { success: false, error: "Claude authentication required" };
					}

					console.warn("[TASK_UPDATE_STATUS] Auto-starting task:", taskId);

					// Start file watcher for this task
					fileWatcher.watch(taskId, specDir);

					// Check if spec.md exists
					const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
					const hasSpec = existsSync(specFilePath);
					const needsSpecCreation = !hasSpec;
					const needsImplementation = hasSpec && task.subtasks.length === 0;

					console.warn(
						"[TASK_UPDATE_STATUS] hasSpec:",
						hasSpec,
						"needsSpecCreation:",
						needsSpecCreation,
						"needsImplementation:",
						needsImplementation,
					);

					// Synchronise le provider avec le projet (permet le switch de provider entre deux runs)
					const prevProviderForUpdate = syncTaskProvider(
						task,
						project,
						specDir,
					);
					if (prevProviderForUpdate) {
						console.warn(
							`[TASK_UPDATE_STATUS] Provider switched: ${prevProviderForUpdate} -> ${task.metadata?.provider}`,
						);
					}

					// Get base branch: task-level override takes precedence over project settings
					const baseBranchForUpdate =
						task.metadata?.baseBranch || project.settings?.mainBranch;

					if (needsSpecCreation) {
						// No spec file - need to run spec_runner.py to create the spec
						const taskDescription = task.description || task.title;
						console.warn(
							"[TASK_UPDATE_STATUS] Starting spec creation for:",
							task.specId,
						);
						agentManager.startSpecCreation(
							taskId,
							project.path,
							taskDescription,
							specDir,
							convertTaskMetadataToSpecCreation(task.metadata),
							baseBranchForUpdate,
							project.id,
						);
					} else if (needsImplementation) {
						// Spec exists but no subtasks - run run.py to create implementation plan and execute
						console.warn(
							"[TASK_UPDATE_STATUS] Starting task execution (no subtasks) for:",
							task.specId,
						);
						agentManager.startTaskExecution(
							taskId,
							project.path,
							task.specId,
							{
								parallel: false,
								workers: 1,
								baseBranch: baseBranchForUpdate,
								useWorktree: task.metadata?.useWorktree,
								useLocalBranch: task.metadata?.useLocalBranch,
							},
							project.id,
						);
					} else {
						// Task has subtasks, start normal execution
						// Note: Parallel execution is handled internally by the agent
						console.warn(
							"[TASK_UPDATE_STATUS] Starting task execution (has subtasks) for:",
							task.specId,
						);
						agentManager.startTaskExecution(
							taskId,
							project.path,
							task.specId,
							{
								parallel: false,
								workers: 1,
								baseBranch: baseBranchForUpdate,
								useWorktree: task.metadata?.useWorktree,
								useLocalBranch: task.metadata?.useLocalBranch,
							},
							project.id,
						);
					}

					// Notify renderer about status change
					if (mainWindow) {
						mainWindow.webContents.send(
							IPC_CHANNELS.TASK_STATUS_CHANGE,
							taskId,
							"in_progress",
							project.id,
						);
					}
				}

				return { success: true };
			} catch (error) {
				appLog.error("Failed to update task status:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to update task status",
				};
			}
		},
	);

	/**
	 * Check if a task is actually running (has active process)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CHECK_RUNNING,
		async (_, taskId: string): Promise<IPCResult<boolean>> => {
			const isRunning = agentManager.isRunning(taskId);
			return { success: true, data: isRunning };
		},
	);

	/**
	 * Resume a paused task (rate limited or auth failure paused).
	 *
	 * Two paths:
	 * 1. Provider UNCHANGED — write a RESUME file to signal the existing subprocess to continue.
	 * 2. Provider CHANGED   — update task_metadata.json with the new provider/models,
	 *                         kill the paused subprocess, spawn a fresh one that picks up
	 *                         from the last incomplete subtask (run.py reads the plan file).
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_PAUSED,
		async (_, taskId: string): Promise<IPCResult> => {
			// Find task and project
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Get the spec directory - use task.specsPath if available (handles worktree vs main)
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir =
				task.specsPath || path.join(project.path, specsBaseDir, task.specId);

			// Check if provider changed and handle accordingly
			const providerChanged = await handleProviderSwitch(
				task,
				project,
				specDir,
			);
			if (providerChanged.changed) {
				return await restartTaskWithNewProvider(
					task,
					project,
					specDir,
					providerChanged.currentProvider,
				);
			}

			// Same provider — write RESUME file to signal existing subprocess
			return await writeResumeFile(task, project, specDir, specsBaseDir);
		},
	);

	/**
	 * Resume a paused task under a different LLM provider (Niveau 3b).
	 *
	 * Writes a RESUME_WITH_PROVIDER marker file in the task's spec dir,
	 * then triggers the same restart flow as a provider-change resume. The
	 * Python backend reads the marker on the next session start via
	 * core.client._consume_resume_with_provider_marker() and switches the
	 * active provider for that one session (the marker is single-shot).
	 *
	 * The persisted conversation log (conversation.jsonl) is replayed into
	 * the new provider's client so context is preserved across the switch.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_WITH_PROVIDER,
		async (
			_,
			taskId: string,
			providerName: string,
			model?: string,
		): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			if (!providerName || typeof providerName !== "string") {
				return {
					success: false,
					error: "Missing or invalid providerName argument",
				};
			}

			const provider = providerName.trim();
			const chosenModel = model?.trim() || undefined;
			const specPaths = getSpecPaths(task, project);

			// Distinct spec dirs (worktree + main) that may hold a backend copy.
			const specDirs = [
				specPaths.specDir,
				specPaths.mainSpecDir,
				specPaths.worktreeSpecDir,
			].filter(
				(d, i, arr): d is string =>
					!!d && existsSync(d) && arr.indexOf(d) === i,
			);

			try {
				// 1. Clear the pause flag on every plan copy so the restarted
				//    backend doesn't immediately re-pause at the next iteration.
				const planPaths = getPlanPaths(specPaths, project);
				for (const planFile of planPaths.all) {
					if (!existsSync(planFile)) continue;
					try {
						const plan = JSON.parse(readFileSync(planFile, "utf-8"));
						plan.paused = {
							enabled: false,
							paused_at: null,
							paused_subtask_id: null,
							provider,
							...(chosenModel ? { model: chosenModel } : {}),
						};
						writeFileSync(planFile, JSON.stringify(plan, null, 2));
					} catch (err) {
						appLog.warn(
							`[TASK_RESUME_WITH_PROVIDER] Could not clear pause in ${planFile}:`,
							err,
						);
					}
				}

				// 2. Persist provider + model to task_metadata.json so the backend
				//    resolves the chosen model (phase_config._resolve_single_model
				//    reads metadata.model). isAutoProfile:false forces the single
				//    model to win over any leftover phase-model config.
				for (const dir of specDirs) {
					const metadataPath = path.join(dir, "task_metadata.json");
					try {
						const existing = existsSync(metadataPath)
							? JSON.parse(safeReadFileSync(metadataPath) || "{}")
							: {};
						existing.provider = provider;
						if (chosenModel) {
							existing.model = chosenModel;
							existing.isAutoProfile = false;
						}
						atomicWriteFileSync(
							metadataPath,
							JSON.stringify(existing, null, 2),
						);
					} catch (err) {
						appLog.warn(
							`[TASK_RESUME_WITH_PROVIDER] Could not update ${metadataPath}:`,
							err,
						);
					}
				}

				// 3. Write the single-shot provider marker the backend consumes on
				//    the next session start (core.client._consume_resume_with_provider_marker).
				const markerPayload = JSON.stringify({
					provider,
					...(chosenModel ? { model: chosenModel } : {}),
				});
				for (const dir of specDirs) {
					writeFileSync(
						path.join(dir, "RESUME_WITH_PROVIDER"),
						markerPayload,
						"utf-8",
					);
				}

				// Keep in-memory metadata + cache in sync for the UI.
				if (!task.metadata) task.metadata = {};
				task.metadata.provider = provider;
				if (chosenModel) task.metadata.model = chosenModel;
				if (task.metadata.paused) task.metadata.paused.enabled = false;
				projectStore.invalidateTasksCache(project.id);

				appLog.info(
					`[TASK_RESUME_WITH_PROVIDER] Resuming task ${taskId} with ` +
						`provider=${provider}${chosenModel ? `, model=${chosenModel}` : ""} ` +
						`(${specDirs.length} spec dir(s)). Conversation log will be replayed.`,
				);
			} catch (err) {
				appLog.error(
					`[TASK_RESUME_WITH_PROVIDER] Failed to prepare resume for task ${taskId}:`,
					err,
				);
				return {
					success: false,
					error:
						err instanceof Error
							? err.message
							: "Failed to write provider override marker",
				};
			}

			// Restart the subprocess so the next session boots with the new
			// provider/model (and replays the conversation log).
			return await restartTaskWithNewProvider(
				task,
				project,
				specPaths.specDir,
				provider,
			);
		},
	);

	/**
	 * Reset the persisted conversation log for a task.
	 *
	 * Use case: the LLM returned a "prompt too long" error (HTTP 400) and
	 * the task is parked in human_review with reviewReason="prompt_too_long".
	 * Retrying with the same conversation log will fail identically, so the
	 * user explicitly wipes the transcript and the halt marker, then restarts
	 * the task with a fresh context.
	 *
	 * Removed:
	 *   - {spec_dir}/conversation.jsonl  (the replay log)
	 *   - {spec_dir}/PROMPT_TOO_LONG_HALT (the backend halt marker)
	 *
	 * The user's plan, subtasks, code, etc. are left untouched.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESET_CONVERSATION,
		async (_, taskId: string): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir =
				task.specsPath || path.join(project.path, specsBaseDir, task.specId);

			try {
				const conversationLog = path.join(specDir, "conversation.jsonl");
				const haltMarker = path.join(specDir, "PROMPT_TOO_LONG_HALT");
				let removed = 0;
				for (const target of [conversationLog, haltMarker]) {
					if (existsSync(target)) {
						unlinkSync(target);
						removed++;
					}
				}
				appLog.info(
					`[TASK_RESET_CONVERSATION] task=${taskId} removed=${removed} files in ${specDir}`,
				);
				return { success: true };
			} catch (err) {
				appLog.error(
					`[TASK_RESET_CONVERSATION] failed for task ${taskId}:`,
					err,
				);
				return {
					success: false,
					error:
						err instanceof Error
							? err.message
							: "Failed to reset conversation log",
				};
			}
		},
	);

	/**
	 * Update task metadata with new provider configuration
	 */
	async function updateTaskMetadata(
		task: Task,
		specDir: string,
		currentProvider: string,
		globalSettings: Record<string, unknown>,
	): Promise<void> {
		appLog.info(
			`[TASK_RESUME_PAUSED] Provider changed. ` +
				`Restarting subprocess with new provider instead of writing RESUME file.`,
		);

		const metadataPath = path.join(specDir, "task_metadata.json");
		try {
			const providerPhaseModels = (
				globalSettings.providerPhaseModels as
					| Record<string, PhaseModelConfig>
					| undefined
			)?.[currentProvider];
			const providerPhaseThinking = (
				globalSettings.providerPhaseThinking as
					| Record<string, PhaseThinkingConfig>
					| undefined
			)?.[currentProvider];

			if (existsSync(metadataPath)) {
				const content = safeReadFileSync(metadataPath);
				if (content) {
					const meta = JSON.parse(content);
					meta.provider = currentProvider;
					if (providerPhaseModels) meta.phaseModels = providerPhaseModels;
					if (providerPhaseThinking) meta.phaseThinking = providerPhaseThinking;
					atomicWriteFileSync(metadataPath, JSON.stringify(meta, null, 2));
					appLog.info(
						`[TASK_RESUME_PAUSED] Updated task_metadata.json → provider: ${currentProvider}`,
						providerPhaseModels
							? `| phaseModels: ${JSON.stringify(providerPhaseModels)}`
							: "",
					);
				}
			}

			// Keep in-memory task metadata in sync
			if (task.metadata) {
				task.metadata.provider = currentProvider;
				if (providerPhaseModels)
					task.metadata.phaseModels = providerPhaseModels;
				if (providerPhaseThinking)
					task.metadata.phaseThinking = providerPhaseThinking;
			}
		} catch (err) {
			console.warn(
				"[TASK_RESUME_PAUSED] Failed to update task_metadata.json (non-fatal):",
				err,
			);
		}
	}

	/**
	 * Check if provider changed and update metadata if needed
	 */
	async function handleProviderSwitch(
		task: Task,
		_project: Project,
		specDir: string,
	): Promise<{ changed: boolean; currentProvider: string }> {
		// Normalize 'anthropic' -> 'claude' for comparison purposes.
		const normalizeProvider = (p: string) =>
			p === "anthropic" ? "claude" : p.toLowerCase();
		const globalSettings = readSettingsFile() ?? {};
		const currentProvider = normalizeProvider(
			(globalSettings.selectedProvider as string | undefined) || "claude",
		);
		const taskProvider = normalizeProvider(task.metadata?.provider || "claude");
		const providerChanged = currentProvider !== taskProvider;

		if (providerChanged) {
			await updateTaskMetadata(task, specDir, currentProvider, globalSettings);
		}

		return { changed: providerChanged, currentProvider };
	}

	/**
	 * Restart task with new provider
	 */
	async function restartTaskWithNewProvider(
		task: Task,
		project: Project,
		_specDir: string,
		_currentProvider: string,
	): Promise<IPCResult> {
		// Kill paused subprocess, then restart with new provider credentials.
		// agentManager.startTaskExecution() will call credentialManager.getEnvironmentVariables()
		// at spawn time, picking up the currently active provider credentials.
		agentManager.killTask(task.id);

		// Brief delay for process cleanup before respawning
		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		const baseBranch =
			task.metadata?.baseBranch || project.settings?.mainBranch;
		await agentManager.startTaskExecution(
			task.id,
			project.path,
			task.specId,
			{
				useWorktree: task.metadata?.useWorktree !== false,
				baseBranch,
			},
			project.id,
		);

		return { success: true };
	}

	/**
	 * Handle writing RESUME file to worktree if it exists
	 */
	async function handleWorktreeResumeFile(
		task: Task,
		project: Project,
		specsBaseDir: string,
		resumeContent: string,
	): Promise<void> {
		const worktreePath = findTaskWorktree(project.path, task.specId);
		if (worktreePath) {
			const worktreeResumeFilePath = path.join(
				worktreePath,
				specsBaseDir,
				task.specId,
				"RESUME",
			);
			try {
				atomicWriteFileSync(worktreeResumeFilePath, resumeContent);
				appLog.info(
					`[TASK_RESUME_PAUSED] Also wrote RESUME file to worktree: ${worktreeResumeFilePath}`,
				);
			} catch (worktreeError) {
				// Non-fatal - main spec dir RESUME is sufficient
				console.warn(
					`[TASK_RESUME_PAUSED] Could not write to worktree (non-fatal):`,
					worktreeError,
				);
			}
		} else if (
			task.executionProgress?.phase === "rate_limit_paused" ||
			task.executionProgress?.phase === "auth_failure_paused"
		) {
			// Warn if worktree not found for a paused task - the backend is likely
			// running inside the worktree and may not see the RESUME file in the main spec dir
			console.warn(
				`[TASK_RESUME_PAUSED] Worktree not found for paused task ${task.specId}. ` +
					`Backend may not detect the RESUME file if running inside a worktree.`,
			);
		}
	}

	/**
	 * Write RESUME file to signal existing subprocess to continue
	 */
	async function writeResumeFile(
		task: Task,
		project: Project,
		specDir: string,
		specsBaseDir: string,
	): Promise<IPCResult> {
		const resumeFilePath = path.join(specDir, "RESUME");

		try {
			const resumeContent = JSON.stringify({
				resumed_at: new Date().toISOString(),
				resumed_by: "user",
			});
			atomicWriteFileSync(resumeFilePath, resumeContent);
			appLog.info(
				`[TASK_RESUME_PAUSED] Wrote RESUME file to: ${resumeFilePath}`,
			);

			// Also write to worktree if it exists (backend may be running inside the worktree)
			await handleWorktreeResumeFile(
				task,
				project,
				specsBaseDir,
				resumeContent,
			);

			return { success: true };
		} catch (error) {
			appLog.error("[TASK_RESUME_PAUSED] Failed to write RESUME file:", error);
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Failed to signal resume",
			};
		}
	}

	/**
	 * Recover a stuck task (status says in_progress but no process running)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RECOVER_STUCK,
		async (
			_,
			taskId: string,
			options?: { targetStatus?: TaskStatus; autoRestart?: boolean },
		): Promise<
			IPCResult<{
				taskId: string;
				recovered: boolean;
				newStatus: TaskStatus;
				message: string;
				autoRestarted?: boolean;
			}>
		> => {
			const targetStatus = options?.targetStatus;
			const autoRestart = options?.autoRestart ?? false;

			// Check if task is actually running
			const isActuallyRunning = agentManager.isRunning(taskId);
			if (isActuallyRunning) {
				return createRunningTaskResponse(taskId);
			}

			// Find task and project
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Get spec directory paths
			const specPaths = getSpecPaths(task, project);
			const planPaths = getPlanPaths(specPaths, project);

			// Read and parse the plan
			const plan = await readAndParsePlan(planPaths.primary);
			if (!plan) {
				return {
					success: false,
					error: "Plan file contains invalid JSON. The file may be corrupted.",
				};
			}

			// Determine the new status
			const newStatus = determineRecoveryStatus(targetStatus, plan);

			// Update plan with new status
			updatePlanStatus(plan, newStatus);

			// Handle completed tasks differently
			if (isTaskCompleted(plan)) {
				return await handleCompletedTaskRecovery(
					taskId,
					plan,
					planPaths,
					project.id,
				);
			}

			// Reset stuck subtasks
			resetStuckSubtasks(plan);

			// Write updated plan to all locations
			const writeSuccess = await writePlanToAllLocations(plan, planPaths);
			if (!writeSuccess) {
				return {
					success: false,
					error: "Failed to write plan file during recovery",
				};
			}

			// Invalidate cache
			projectStore.invalidateTasksCache(project.id);

			// Stop file watcher
			fileWatcher.unwatch(taskId);

			// Auto-restart if requested
			const autoRestarted = await handleAutoRestart(
				autoRestart,
				task,
				project,
				taskId,
				newStatus,
				plan,
				planPaths,
			);

			// Notify renderer
			notifyRendererOfStatusChange(taskId, newStatus, project.id);

			return createSuccessResponse(taskId, newStatus, autoRestarted);
		},
	);

	/**
	 * Create response for running task
	 */
	function createRunningTaskResponse(taskId: string): IPCResult<{
		taskId: string;
		recovered: boolean;
		newStatus: TaskStatus;
		message: string;
	}> {
		return {
			success: false,
			error: "Task is still running. Stop it first before recovering.",
			data: {
				taskId,
				recovered: false,
				newStatus: "in_progress" as TaskStatus,
				message: "Task is still running",
			},
		};
	}

	/**
	 * Get spec directory paths
	 */
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	function getSpecPaths(task: any, project: any) {
		const specsBaseDir = getSpecsDir(project.autoBuildPath);
		const specDir =
			task.specsPath || path.join(project.path, specsBaseDir, task.specId);

		const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
		const worktreePath = findTaskWorktree(project.path, task.specId);
		const worktreeSpecDir = worktreePath
			? path.join(worktreePath, specsBaseDir, task.specId)
			: null;

		return { specDir, mainSpecDir, worktreeSpecDir, specsBaseDir };
	}

	/**
	 * Get all plan file paths that need updating
	 */
	function getPlanPaths(
		specPaths: ReturnType<typeof getSpecPaths>,
		_project: Project,
	): { primary: string; all: string[] } {
		const planPath = path.join(
			specPaths.specDir,
			AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
		);
		const planPathsToUpdate: string[] = [planPath];

		if (
			specPaths.mainSpecDir !== specPaths.specDir &&
			existsSync(
				path.join(specPaths.mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
			)
		) {
			planPathsToUpdate.push(
				path.join(specPaths.mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
			);
		}

		if (
			specPaths.worktreeSpecDir &&
			specPaths.worktreeSpecDir !== specPaths.specDir &&
			existsSync(
				path.join(
					specPaths.worktreeSpecDir,
					AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				),
			)
		) {
			planPathsToUpdate.push(
				path.join(
					specPaths.worktreeSpecDir,
					AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				),
			);
		}

		appLog.info(
			`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`,
			planPathsToUpdate,
		);

		return { primary: planPath, all: planPathsToUpdate };
	}

	/**
	 * Read and parse the plan file
	 */
	async function readAndParsePlan(
		planPath: string,
	): Promise<Record<string, unknown> | null> {
		const planContent = safeReadFileSync(planPath);
		if (!planContent) {
			return null;
		}

		try {
			return JSON.parse(planContent);
		} catch (parseError) {
			appLog.error("[Recovery] Failed to parse plan file as JSON:", parseError);
			return null;
		}
	}

	/**
	 * Determine the appropriate recovery status
	 */
	function determineRecoveryStatus(
		targetStatus: TaskStatus | undefined,
		plan: Record<string, unknown>,
	): TaskStatus {
		let newStatus: TaskStatus = targetStatus || "backlog";

		if (!targetStatus && plan.phases && Array.isArray(plan.phases)) {
			const { completedCount, totalCount, allCompleted } =
				checkSubtasksCompletion(plan);

			if (totalCount > 0) {
				if (allCompleted) {
					newStatus = "human_review";
				} else if (completedCount > 0) {
					newStatus = "in_progress";
				}
			}
		}

		return newStatus;
	}

	/**
	 * Update plan status fields
	 */
	function updatePlanStatus(
		plan: Record<string, unknown>,
		newStatus: TaskStatus,
	): void {
		plan.status = newStatus;

		// Map TaskStatus to planStatus
		let planStatus: string;
		if (newStatus === "done") {
			planStatus = "completed";
		} else if (newStatus === "in_progress") {
			planStatus = "in_progress";
		} else if (newStatus === "ai_review" || newStatus === "human_review") {
			planStatus = "review";
		} else {
			planStatus = "pending";
		}

		plan.planStatus = planStatus;
		plan.updated_at = new Date().toISOString();
		plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;
	}

	/**
	 * Check if task is completed
	 */
	function isTaskCompleted(plan: Record<string, unknown>): boolean {
		const { allCompleted } = checkSubtasksCompletion(plan);
		return allCompleted;
	}

	/**
	 * Handle recovery for completed tasks
	 */
	async function handleCompletedTaskRecovery(
		taskId: string,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
		projectId: string,
	): Promise<
		IPCResult<{
			taskId: string;
			recovered: boolean;
			newStatus: TaskStatus;
			message: string;
			autoRestarted?: boolean;
		}>
	> {
		appLog.info(
			"[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart",
		);

		plan.status = "human_review";
		plan.planStatus = "review";

		const planContent = JSON.stringify(plan, null, 2);
		const writeSuccess = await writePlanContentToAllLocations(
			planContent,
			planPaths.all,
		);

		if (!writeSuccess) {
			return {
				success: false,
				error:
					"Failed to write plan file during recovery (all locations failed)",
			};
		}

		projectStore.invalidateTasksCache(projectId);

		return {
			success: true,
			data: {
				taskId,
				recovered: true,
				newStatus: "human_review",
				message: "Task is complete and ready for review",
				autoRestarted: false,
			},
		};
	}

	/**
	 * Reset stuck subtasks to pending
	 */
	function resetStuckSubtasks(plan: Record<string, unknown>): void {
		if (plan.phases && Array.isArray(plan.phases)) {
			for (const phase of plan.phases as Array<{
				subtasks?: Array<{
					status: string;
					actual_output?: string;
					started_at?: string;
					completed_at?: string;
				}>;
			}>) {
				if (phase.subtasks && Array.isArray(phase.subtasks)) {
					for (const subtask of phase.subtasks) {
						// Reset in_progress subtasks to pending
						if (subtask.status === "in_progress") {
							resetSubtask(subtask, "in_progress");
						}
						// Reset failed subtasks to pending
						if (subtask.status === "failed") {
							resetSubtask(subtask, "failed");
						}
					}
				}
			}
		}
	}

	/**
	 * Reset a single subtask
	 */
	function resetSubtask(
		subtask: {
			status: string;
			actual_output?: string;
			started_at?: string;
			completed_at?: string;
		},
		originalStatus: string,
	): void {
		subtask.status = "pending";
		delete subtask.actual_output;
		delete subtask.started_at;
		delete subtask.completed_at;
		appLog.info(`[Recovery] Reset ${originalStatus} subtask to pending`);
	}

	/**
	 * Write plan to all locations
	 */
	async function writePlanToAllLocations(
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		const planContent = JSON.stringify(plan, null, 2);
		return await writePlanContentToAllLocations(planContent, planPaths.all);
	}

	/**
	 * Write plan content to all locations
	 */
	async function writePlanContentToAllLocations(
		planContent: string,
		planPaths: string[],
	): Promise<boolean> {
		let writeSucceeded = false;
		for (const pathToUpdate of planPaths) {
			try {
				atomicWriteFileSync(pathToUpdate, planContent);
				appLog.info(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
				writeSucceeded = true;
			} catch (writeError) {
				appLog.error(
					`[Recovery] Failed to write plan file at ${pathToUpdate}:`,
					writeError,
				);
			}
		}
		return writeSucceeded;
	}

	/**
	 * Handle auto-restart if requested
	 */
	async function handleAutoRestart(
		autoRestart: boolean,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		task: any,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		project: any,
		taskId: string,
		newStatus: TaskStatus,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		if (!autoRestart) {
			return false;
		}

		// Check git status
		const gitStatus = checkGitStatus(project.path);
		if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
			console.warn("[Recovery] Git check failed, cannot auto-restart task");
			return false;
		}

		// Check authentication
		const initResult = await ensureProfileManagerInitialized();
		if (!initResult.success) {
			console.warn(
				"[Recovery] Profile manager initialization failed, cannot auto-restart task",
			);
			return false;
		}

		const profileManager = initResult.profileManager;
		if (requiresClaudeAuth() && !profileManager.hasValidAuth()) {
			console.warn("[Recovery] Auth check failed, cannot auto-restart task");
			return false;
		}

		// Perform the restart
		return await performTaskRestart(
			task,
			project,
			taskId,
			newStatus,
			plan,
			planPaths,
		);
	}

	/**
	 * Perform the actual task restart
	 */
	async function performTaskRestart(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		task: any,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		project: any,
		taskId: string,
		_newStatus: TaskStatus,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		try {
			// Update plan status for restart
			plan.status = "in_progress";
			plan.planStatus = "in_progress";
			const restartPlanContent = JSON.stringify(plan, null, 2);

			for (const pathToUpdate of planPaths.all) {
				try {
					atomicWriteFileSync(pathToUpdate, restartPlanContent);
					appLog.info(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
				} catch (writeError) {
					appLog.error(
						`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`,
						writeError,
					);
				}
			}

			projectStore.invalidateTasksCache(project.id);

			// Start file watcher
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDirForWatcher = path.join(
				project.path,
				specsBaseDir,
				task.specId,
			);
			fileWatcher.watch(taskId, specDirForWatcher);

			// Check if spec exists
			const specFilePath = path.join(
				specDirForWatcher,
				AUTO_BUILD_PATHS.SPEC_FILE,
			);
			const hasSpec = existsSync(specFilePath);
			const needsSpecCreation = !hasSpec;

			// Sync provider
			const prevProvider = syncTaskProvider(task, project, specDirForWatcher);
			if (prevProvider) {
				console.warn(
					`[Recovery] Provider switched: ${prevProvider} -> ${task.metadata?.provider}`,
				);
			}

			const baseBranch =
				task.metadata?.baseBranch || project.settings?.mainBranch;

			// Start the task
			if (needsSpecCreation) {
				const taskDescription = task.description || task.title;
				console.warn(`[Recovery] Starting spec creation for: ${task.specId}`);
				agentManager.startSpecCreation(
					taskId,
					project.path,
					taskDescription,
					specDirForWatcher,
					convertTaskMetadataToSpecCreation(task.metadata),
					baseBranch,
					project.id,
				);
			} else {
				console.warn(`[Recovery] Starting task execution for: ${task.specId}`);
				agentManager.startTaskExecution(
					taskId,
					project.path,
					task.specId,
					{
						parallel: false,
						workers: 1,
						baseBranch,
						useWorktree: task.metadata?.useWorktree,
						useLocalBranch: task.metadata?.useLocalBranch,
					},
					project.id,
				);
			}

			console.warn(`[Recovery] Auto-restarted task ${taskId}`);
			return true;
		} catch (restartError) {
			appLog.error("Failed to auto-restart task after recovery:", restartError);
			return false;
		}
	}

	/**
	 * Notify renderer of status change
	 */
	function notifyRendererOfStatusChange(
		taskId: string,
		newStatus: TaskStatus,
		projectId: string,
	): void {
		const mainWindow = getMainWindow();
		if (mainWindow) {
			mainWindow.webContents.send(
				IPC_CHANNELS.TASK_STATUS_CHANGE,
				taskId,
				newStatus,
				projectId,
			);
		}
	}

	/**
	 * Create success response
	 */
	function createSuccessResponse(
		taskId: string,
		newStatus: TaskStatus,
		autoRestarted: boolean,
	): IPCResult<{
		taskId: string;
		recovered: boolean;
		newStatus: TaskStatus;
		message: string;
		autoRestarted?: boolean;
	}> {
		return {
			success: true,
			data: {
				taskId,
				recovered: true,
				newStatus,
				message: autoRestarted
					? "Task recovered and restarted successfully"
					: `Task recovered successfully and moved to ${newStatus}`,
				autoRestarted,
			},
		};
	}

	/**
	 * Update plan phases and subtasks
	 * Allows modifying pending subtasks or adding new ones
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_UPDATE_PLAN,
		async (
			_,
			taskId: string,
			phases: Array<Record<string, unknown>>,
		): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const planPath = getPlanPath(project, task);
			const updatedPlan = await updatePlanSubtasks(
				planPath,
				phases,
				project.id,
			);

			if (!updatedPlan) {
				return {
					success: false,
					error:
						"Failed to update plan - file may not exist or be corrupted",
				};
			}

			appLog.info(`[TASK_UPDATE_PLAN] Successfully updated plan for task ${taskId}`);
			return { success: true };
		},
	);

	/**
	 * Pause task execution
	 * Saves current state so execution can resume later
	 */
	ipcMain.handle(
		"TASK_PAUSE",
		async (
			_,
			taskId: string,
			subtaskId?: string,
		): Promise<IPCResult> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// The running backend reads the pause flag from its own plan copy.
				// For worktree tasks that's the worktree's implementation_plan.json,
				// NOT the main repo's — so we must write the flag to every existing
				// copy or the cooperative stop in the coder loop never fires.
				const specPaths = getSpecPaths(task, project);
				const planPaths = getPlanPaths(specPaths, project);

				const pausedState = {
					enabled: true,
					paused_at: new Date().toISOString(),
					paused_subtask_id: subtaskId || null,
					provider: task.metadata?.provider || "anthropic",
					model: task.metadata?.model || "claude-opus-4-7",
				};

				let written = 0;
				for (const planFile of planPaths.all) {
					if (!existsSync(planFile)) continue;
					try {
						const plan = JSON.parse(readFileSync(planFile, "utf-8"));
						plan.paused = pausedState;
						writeFileSync(planFile, JSON.stringify(plan, null, 2));
						written++;
					} catch (err) {
						appLog.warn(
							`[TASK_PAUSE] Could not update plan copy ${planFile}:`,
							err,
						);
					}
				}

				if (written === 0) {
					return {
						success: false,
						error: "Implementation plan not found",
					};
				}

				// Re-scan so the scanner surfaces plan.paused on task.metadata; the
				// UI uses that to switch the controls into the paused state.
				projectStore.invalidateTasksCache(project.id);

				appLog.info(
					`[TASK_PAUSE] Pause requested for task ${taskId} at subtask ` +
						`${subtaskId || "none"} (${written} plan cop[y/ies]). The backend ` +
						`finishes the current step, then stops.`,
				);

				return {
					success: true,
					data: {
						taskId,
						paused: true,
						pausedAt: pausedState.paused_at,
						planCopies: written,
					},
				};
			} catch (error) {
				appLog.error("[TASK_PAUSE] Error:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	/**
	 * Resume task execution
	 * Continues from the paused checkpoint
	 */
	ipcMain.handle(
		"TASK_RESUME",
		async (_, taskId: string): Promise<IPCResult> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const planPath = getPlanPath(project, task);
				if (!existsSync(planPath)) {
					return { success: false, error: "Implementation plan not found" };
				}

				const planContent = readFileSync(planPath, "utf-8");
				const plan = JSON.parse(planContent);

				// Clear pause state
				plan.paused = {
					enabled: false,
					paused_at: null,
					paused_subtask_id: null,
					provider: plan.paused?.provider || "anthropic",
					model: plan.paused?.model || "claude-opus-4-7",
				};

				writeFileSync(planPath, JSON.stringify(plan, null, 2));
				appLog.info(`[TASK_RESUME] Task ${taskId} resumed`);

				// Start execution from pause checkpoint
				const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

				agentManager.startTaskExecution(
					taskId,
					project.path,
					task.specId,
					{
						parallel: false,
						workers: 1,
						baseBranch,
						useWorktree: task.metadata?.useWorktree,
						useLocalBranch: task.metadata?.useLocalBranch,
					},
					project.id,
				);

				return {
					success: true,
					data: { taskId, resumed: true },
				};
			} catch (error) {
				appLog.error("[TASK_RESUME] Error:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	// Provider switching mid-task is handled by TASK_RESUME_WITH_PROVIDER
	// (marker + conversation replay). The former TASK_SWITCH_PROVIDER handler
	// only wrote a flag with a hardcoded model list and never restarted the
	// run, so it was removed in favour of the single source of truth.
}
