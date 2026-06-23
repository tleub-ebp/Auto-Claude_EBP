import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IdeationConfig } from "../../shared/types";
import { getOperationRegistry } from "../claude-profile/operation-registry";
import type { ClaudeProfileManager } from "../claude-profile-manager";
import {
	getClaudeProfileManager,
	initializeClaudeProfileManager,
} from "../claude-profile-manager";
import {
	applyModelContext,
	ensureOllamaReady,
} from "../services/ollama-portable";
import { readSettingsFile } from "../settings-utils";
import { AgentEvents } from "./agent-events";
import { AgentProcessManager } from "./agent-process";
import { AgentQueueManager } from "./agent-queue";
import { AgentState } from "./agent-state";
import { applyTddOverride } from "./env-utils";
import type {
	RoadmapConfig,
	SpecCreationMetadata,
	TaskExecutionOptions,
} from "./types";

/**
 * Main AgentManager - orchestrates agent process lifecycle
 * This is a slim facade that delegates to focused modules
 */
export class AgentManager extends EventEmitter {
	private state: AgentState;
	private events: AgentEvents;
	private processManager: AgentProcessManager;
	private queueManager: AgentQueueManager;
	private taskExecutionContext: Map<
		string,
		{
			projectPath: string;
			specId: string;
			options: TaskExecutionOptions;
			isSpecCreation?: boolean;
			taskDescription?: string;
			specDir?: string;
			metadata?: SpecCreationMetadata;
			baseBranch?: string;
			swapCount: number;
			projectId?: string;
			/** Generation counter to prevent stale cleanup after restart */
			generation: number;
		}
	> = new Map();

	/**
	 * Returns true if Claude OAuth auth is required for the current active provider.
	 * Non-Claude providers (Windsurf, OpenAI, Copilot, etc.) manage their own auth.
	 */
	private requiresClaudeAuth(): boolean {
		const settings = readSettingsFile();
		const provider = (
			settings?.selectedProvider as string | undefined
		)?.toLowerCase();
		return !provider || provider === "claude" || provider === "anthropic";
	}

	/**
	 * When the active provider is Ollama, make sure the local server is up before
	 * spawning the agent — installing the portable binary and starting `ollama
	 * serve` if needed. Best-effort: a failure here is logged but never blocks the
	 * task (the agent will then surface the friendly "Ollama ne répond pas" hint).
	 * Does NOT pull models (that stays an explicit user action in the provider UI).
	 */
	private async ensureLocalServerIfNeeded(metadata?: {
		provider?: string;
	}): Promise<void> {
		try {
			const settings = readSettingsFile();
			const provider = (
				metadata?.provider || (settings?.selectedProvider as string | undefined)
			)?.toLowerCase();
			if (provider !== "ollama") return;
			const baseUrl =
				((settings?.globalOllamaApiUrl as string) || "").trim() ||
				"http://localhost:11434";
			const res = await ensureOllamaReady(baseUrl, () => {
				/* no progress stream needed at task launch */
			});
			if (!res.success) {
				console.warn(
					"[AgentManager] Ollama auto-start before task failed:",
					res.error,
				);
				return;
			}
			// Ensure the configured model serves with a usable context window
			// (bakes num_ctx into the model — fixes models pulled before this was
			// added). Idempotent and manifest-only, so cheap to repeat.
			const model = (settings?.globalOllamaModel as string | undefined)?.trim();
			if (model) {
				const ctxRes = await applyModelContext(baseUrl, model);
				if (!ctxRes.success) {
					console.warn(
						"[AgentManager] applyModelContext before task failed:",
						ctxRes.error,
					);
				}
			}
		} catch (err) {
			console.warn("[AgentManager] ensureLocalServerIfNeeded error:", err);
		}
	}

	constructor() {
		super();

		// Initialize modular components
		this.state = new AgentState();
		this.events = new AgentEvents();
		this.processManager = new AgentProcessManager(
			this.state,
			this.events,
			this,
		);
		this.queueManager = new AgentQueueManager(
			this.state,
			this.events,
			this.processManager,
			this,
		);

		// Listen for auto-swap restart events
		this.on(
			"auto-swap-restart-task",
			(taskId: string, newProfileId: string) => {
				const _success = this.restartTask(taskId, newProfileId);
			},
		);

		// Listen for task completion to clean up context (prevent memory leak)
		this.on(
			"exit",
			(
				taskId: string,
				code: number | null,
				_processType?: string,
				_projectId?: string,
			) => {
				// Clean up context when:
				// 1. Task completed successfully (code === 0), or
				// 2. Task failed and won't be restarted (handled by auto-swap logic)

				// Capture generation at exit time to prevent race conditions with restarts
				const contextAtExit = this.taskExecutionContext.get(taskId);
				const generationAtExit = contextAtExit?.generation;

				// Note: Auto-swap restart happens BEFORE this exit event is processed,
				// so we need a small delay to allow restart to preserve context
				setTimeout(() => {
					const context = this.taskExecutionContext.get(taskId);
					if (!context) return; // Already cleaned up or restarted

					// Check if the context's generation matches - if not, a restart incremented it
					// and this cleanup is for a stale exit event that shouldn't affect the new task
					if (
						generationAtExit !== undefined &&
						context.generation !== generationAtExit
					) {
						return; // Stale exit event - task was restarted, don't clean up new context
					}

					// If task completed successfully, always clean up
					if (code === 0) {
						this.taskExecutionContext.delete(taskId);
						// Unregister from OperationRegistry
						getOperationRegistry().unregisterOperation(taskId);
						return;
					}

					// If task failed and hit max retries, clean up
					if (context.swapCount >= 2) {
						this.taskExecutionContext.delete(taskId);
						// Unregister from OperationRegistry
						getOperationRegistry().unregisterOperation(taskId);
					}
					// Otherwise keep context for potential restart
				}, 1000); // Delay to allow restart logic to run first
			},
		);
	}

	/**
	 * Configure paths for Python and auto-claude source
	 */
	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		this.processManager.configure(pythonPath, autoBuildSourcePath);
	}

	/**
	 * Register a task with the unified OperationRegistry for proactive swap support.
	 * Extracted helper to avoid code duplication between spec creation and task execution.
	 * @private
	 */
	private registerTaskWithOperationRegistry(
		taskId: string,
		operationType: "spec-creation" | "task-execution",
		metadata: Record<string, unknown>,
	): void {
		const profileManager = getClaudeProfileManager();
		const activeProfile = profileManager.getActiveProfile();
		if (!activeProfile) {
			return;
		}

		// Keep internal state tracking for backward compatibility
		this.assignProfileToTask(
			taskId,
			activeProfile.id,
			activeProfile.name,
			"proactive",
		);

		// Register with unified registry for proactive swap
		// Note: We don't provide a stopFn because restartTask() already handles stopping
		// the task internally via killTask() before restarting. Providing a separate
		// stopFn would cause a redundant double-kill during profile swaps.
		const operationRegistry = getOperationRegistry();
		operationRegistry.registerOperation(
			taskId,
			operationType,
			activeProfile.id,
			activeProfile.name,
			(newProfileId: string) => this.restartTask(taskId, newProfileId),
			{ metadata },
		);
	}

	/**
	 * Start spec creation process
	 */
	async startSpecCreation(
		taskId: string,
		projectPath: string,
		taskDescription: string,
		specDir?: string,
		metadata?: SpecCreationMetadata,
		baseBranch?: string,
		projectId?: string,
	): Promise<void> {
		// Pre-flight auth check: Verify active profile has valid authentication
		// Ensure profile manager is initialized to prevent race condition
		let profileManager: ClaudeProfileManager;
		try {
			profileManager = await initializeClaudeProfileManager();
		} catch (error) {
			console.error(
				"[AgentManager] Failed to initialize profile manager:",
				error,
			);
			this.emit(
				"error",
				taskId,
				"Failed to initialize profile manager. Please check file permissions and disk space.",
			);
			return;
		}
		if (this.requiresClaudeAuth() && !profileManager.hasValidAuth()) {
			this.emit(
				"error",
				taskId,
				"Claude authentication required. Please authenticate in Settings > Claude Profiles before starting tasks.",
			);
			return;
		}

		// Ensure Python environment is ready before spawning process (prevents exit code 127 race condition)
		const pythonStatus =
			await this.processManager.ensurePythonEnvReady("AgentManager");
		if (!pythonStatus.ready) {
			this.emit(
				"error",
				taskId,
				`Python environment not ready: ${pythonStatus.error || "initialization failed"}`,
			);
			return;
		}

		const autoBuildSource = this.processManager.getAutoBuildSourcePath();

		if (!autoBuildSource) {
			this.emit(
				"error",
				taskId,
				"Auto-build source path not found. Please configure it in App Settings.",
			);
			return;
		}

		const specRunnerPath = path.join(
			autoBuildSource,
			"runners",
			"spec_runner.py",
		);

		if (!existsSync(specRunnerPath)) {
			this.emit("error", taskId, `Spec runner not found at: ${specRunnerPath}`);
			return;
		}

		// Get combined environment variables
		const combinedEnv = applyTddOverride(
			this.processManager.getCombinedEnv(projectPath),
			metadata?.tddMode,
		);

		// spec_runner.py will auto-start run.py after spec creation completes
		const args = [
			specRunnerPath,
			"--task",
			taskDescription,
			"--project-dir",
			projectPath,
		];

		// Pass spec directory if provided (for UI-created tasks that already have a directory)
		if (specDir) {
			args.push("--spec-dir", specDir);
		}

		// Pass base branch if specified (ensures worktrees are created from the correct branch)
		if (baseBranch) {
			args.push("--base-branch", baseBranch);
		}

		// Check if user requires review before coding
		if (!metadata?.requireReviewBeforeCoding) {
			// Auto-approve: When user starts a task from the UI without requiring review
			args.push("--auto-approve");
		}

		// Pass LLM provider if specified (enables provider-aware model defaults in backend)
		if (metadata?.provider) {
			args.push("--provider", metadata.provider);
		}

		// Pass model and thinking level configuration
		// For auto profile, use phase-specific config; otherwise use single model/thinking
		if (
			metadata?.isAutoProfile &&
			metadata.phaseModels &&
			metadata.phaseThinking
		) {
			// Pass the spec phase model and thinking level to spec_runner
			args.push("--model", metadata.phaseModels.spec);
			args.push("--thinking-level", metadata.phaseThinking.spec);
		} else if (metadata?.model) {
			// Non-auto profile: use single model and thinking level
			args.push("--model", metadata.model);
			if (metadata.thinkingLevel) {
				args.push("--thinking-level", metadata.thinkingLevel);
			}
		}

		// Workspace mode: --direct skips worktree isolation (default is isolated for safety)
		if (metadata?.useWorktree === false) {
			args.push("--direct");
		}

		// Store context for potential restart
		this.storeTaskContext(
			taskId,
			projectPath,
			"",
			{},
			true,
			taskDescription,
			specDir,
			metadata,
			baseBranch,
			projectId,
		);

		// Register with unified OperationRegistry for proactive swap support
		this.registerTaskWithOperationRegistry(taskId, "spec-creation", {
			projectPath,
			taskDescription,
			specDir,
		});

		// Auto-start the local Ollama server if that's the active provider.
		await this.ensureLocalServerIfNeeded(metadata);

		// Note: This is spec-creation but it chains to task-execution via run.py
		await this.processManager.spawnProcess(
			taskId,
			autoBuildSource,
			args,
			combinedEnv,
			"task-execution",
			projectId,
		);
	}

	/**
	 * Start task execution (run.py)
	 */
	async startTaskExecution(
		taskId: string,
		projectPath: string,
		specId: string,
		options: TaskExecutionOptions = {},
		projectId?: string,
	): Promise<void> {
		// Pre-flight auth check: Verify active profile has valid authentication
		// Ensure profile manager is initialized to prevent race condition
		let profileManager: ClaudeProfileManager;
		try {
			profileManager = await initializeClaudeProfileManager();
		} catch (error) {
			console.error(
				"[AgentManager] Failed to initialize profile manager:",
				error,
			);
			this.emit(
				"error",
				taskId,
				"Failed to initialize profile manager. Please check file permissions and disk space.",
			);
			return;
		}
		if (this.requiresClaudeAuth() && !profileManager.hasValidAuth()) {
			this.emit(
				"error",
				taskId,
				"Claude authentication required. Please authenticate in Settings > Claude Profiles before starting tasks.",
			);
			return;
		}

		// Ensure Python environment is ready before spawning process (prevents exit code 127 race condition)
		const pythonStatus =
			await this.processManager.ensurePythonEnvReady("AgentManager");
		if (!pythonStatus.ready) {
			this.emit(
				"error",
				taskId,
				`Python environment not ready: ${pythonStatus.error || "initialization failed"}`,
			);
			return;
		}

		const autoBuildSource = this.processManager.getAutoBuildSourcePath();

		if (!autoBuildSource) {
			this.emit(
				"error",
				taskId,
				"Auto-build source path not found. Please configure it in App Settings.",
			);
			return;
		}

		const runPath = path.join(autoBuildSource, "run.py");

		if (!existsSync(runPath)) {
			this.emit("error", taskId, `Run script not found at: ${runPath}`);
			return;
		}

		// Get combined environment variables
		const combinedEnv = applyTddOverride(
			this.processManager.getCombinedEnv(projectPath),
			options.tddMode,
		);

		const args = [runPath, "--spec", specId, "--project-dir", projectPath];

		// Always use auto-continue when running from UI (non-interactive)
		args.push("--auto-continue");

		// Force: When user starts a task from the UI, that IS their approval
		args.push("--force");

		// Workspace mode: --direct skips worktree isolation (default is isolated for safety)
		if (options.useWorktree === false) {
			args.push("--direct");
		}

		// Pass base branch if specified (ensures worktrees are created from the correct branch)
		if (options.baseBranch) {
			args.push("--base-branch", options.baseBranch);
		}

		// Streaming options
		if (options.enableStreaming) {
			args.push("--enable-streaming");
		}
		if (options.streamingSessionId) {
			args.push("--streaming-session-id", options.streamingSessionId);
		}

		// Note: --parallel was removed from run.py CLI - parallel execution is handled internally by the agent
		// The options.parallel and options.workers are kept for future use or logging purposes
		// Note: Model configuration is read from task_metadata.json by the Python scripts,
		// which allows per-phase configuration for planner, coder, and QA phases

		// Store context for potential restart
		this.storeTaskContext(
			taskId,
			projectPath,
			specId,
			options,
			false,
			undefined,
			undefined,
			undefined,
			undefined,
			projectId,
		);

		// Register with unified OperationRegistry for proactive swap support
		this.registerTaskWithOperationRegistry(taskId, "task-execution", {
			projectPath,
			specId,
			options,
		});

		// Inject the Claude SDK resume session_id into the subprocess env.
		// The Python side reads AUTO_CLAUDE_RESUME_SESSION_ID inside create_client()
		// (apps/backend/core/client.py) and passes it to ClaudeAgentOptions(resume=...).
		const spawnEnv = options.resumeSessionId
			? { ...combinedEnv, AUTO_CLAUDE_RESUME_SESSION_ID: options.resumeSessionId }
			: combinedEnv;

		// Auto-start the local Ollama server if that's the active provider.
		await this.ensureLocalServerIfNeeded();

		await this.processManager.spawnProcess(
			taskId,
			autoBuildSource,
			args,
			spawnEnv,
			"task-execution",
			projectId,
		);
	}

	/**
	 * Start QA process
	 */
	async startQAProcess(
		taskId: string,
		projectPath: string,
		specId: string,
		projectId?: string,
	): Promise<void> {
		// Ensure Python environment is ready before spawning process (prevents exit code 127 race condition)
		const pythonStatus =
			await this.processManager.ensurePythonEnvReady("AgentManager");
		if (!pythonStatus.ready) {
			this.emit(
				"error",
				taskId,
				`Python environment not ready: ${pythonStatus.error || "initialization failed"}`,
			);
			return;
		}

		const autoBuildSource = this.processManager.getAutoBuildSourcePath();

		if (!autoBuildSource) {
			this.emit(
				"error",
				taskId,
				"Auto-build source path not found. Please configure it in App Settings.",
			);
			return;
		}

		const runPath = path.join(autoBuildSource, "run.py");

		if (!existsSync(runPath)) {
			this.emit("error", taskId, `Run script not found at: ${runPath}`);
			return;
		}

		// Get combined environment variables
		const combinedEnv = this.processManager.getCombinedEnv(projectPath);

		const args = [
			runPath,
			"--spec",
			specId,
			"--project-dir",
			projectPath,
			"--qa",
		];

		// Auto-start the local Ollama server if that's the active provider.
		await this.ensureLocalServerIfNeeded();

		await this.processManager.spawnProcess(
			taskId,
			autoBuildSource,
			args,
			combinedEnv,
			"qa-process",
			projectId,
		);
	}

	/**
	 * Start roadmap generation process
	 */
	startRoadmapGeneration(
		projectId: string,
		projectPath: string,
		refresh: boolean = false,
		enableCompetitorAnalysis: boolean = false,
		refreshCompetitorAnalysis: boolean = false,
		config?: RoadmapConfig,
	): void {
		this.queueManager.startRoadmapGeneration(
			projectId,
			projectPath,
			refresh,
			enableCompetitorAnalysis,
			refreshCompetitorAnalysis,
			config,
		);
	}

	/**
	 * Start ideation generation process
	 */
	startIdeationGeneration(
		projectId: string,
		projectPath: string,
		config: IdeationConfig,
		refresh: boolean = false,
	): void {
		this.queueManager.startIdeationGeneration(
			projectId,
			projectPath,
			config,
			refresh,
		);
	}

	/**
	 * Kill a specific task's process
	 */
	killTask(taskId: string): boolean {
		return this.processManager.killProcess(taskId);
	}

	/**
	 * Fully halt a task the USER explicitly paused or stopped.
	 *
	 * Unlike {@link killTask} (also used by {@link restartTask}, which MUST keep
	 * the task registered so it can respawn it), this ALSO unregisters the task
	 * from the OperationRegistry and drops its execution context. Without this,
	 * the proactive profile-swap / usage monitor would later restart the paused
	 * or stopped task when a token limit is hit on its profile — making Pause
	 * "stick" (the process respawns) and Stop look like it did nothing.
	 */
	haltTask(taskId: string): boolean {
		const killed = this.killTask(taskId);
		try {
			getOperationRegistry().unregisterOperation(taskId);
		} catch (err) {
			console.warn("[AgentManager] haltTask: unregisterOperation failed", err);
		}
		this.taskExecutionContext.delete(taskId);
		return killed;
	}

	/**
	 * Stop ideation generation for a project
	 */
	stopIdeation(projectId: string): boolean {
		return this.queueManager.stopIdeation(projectId);
	}

	/**
	 * Check if ideation is running for a project
	 */
	isIdeationRunning(projectId: string): boolean {
		return this.queueManager.isIdeationRunning(projectId);
	}

	/**
	 * Stop roadmap generation for a project
	 */
	stopRoadmap(projectId: string): boolean {
		return this.queueManager.stopRoadmap(projectId);
	}

	/**
	 * Check if roadmap is running for a project
	 */
	isRoadmapRunning(projectId: string): boolean {
		return this.queueManager.isRoadmapRunning(projectId);
	}

	/**
	 * Kill all running processes
	 */
	async killAll(): Promise<void> {
		await this.processManager.killAllProcesses();
	}

	/**
	 * Check if a task is running
	 */
	isRunning(taskId: string): boolean {
		return this.state.hasProcess(taskId);
	}

	/**
	 * Get all running task IDs
	 */
	getRunningTasks(): string[] {
		return this.state.getRunningTaskIds();
	}

	/**
	 * Store task execution context for potential restarts
	 */
	private storeTaskContext(
		taskId: string,
		projectPath: string,
		specId: string,
		options: TaskExecutionOptions,
		isSpecCreation?: boolean,
		taskDescription?: string,
		specDir?: string,
		metadata?: SpecCreationMetadata,
		baseBranch?: string,
		projectId?: string,
	): void {
		// Preserve swapCount if context already exists (for restarts)
		const existingContext = this.taskExecutionContext.get(taskId);
		const swapCount = existingContext?.swapCount ?? 0;
		// Increment generation on each store (restarts) to invalidate pending cleanup callbacks
		const generation = (existingContext?.generation ?? 0) + 1;

		this.taskExecutionContext.set(taskId, {
			projectPath,
			specId,
			options,
			isSpecCreation,
			taskDescription,
			specDir,
			metadata,
			baseBranch,
			swapCount, // Preserve existing count instead of resetting
			projectId,
			generation, // Incremented to prevent stale exit cleanup
		});
	}

	/**
	 * Restart task after profile swap
	 * @param taskId - The task to restart
	 * @param newProfileId - Optional new profile ID to apply (from auto-swap)
	 */
	restartTask(taskId: string, newProfileId?: string): boolean {
		const context = this.taskExecutionContext.get(taskId);
		if (!context) {
			console.error("[AgentManager] No context for task:", taskId);
			return false;
		}

		// Prevent infinite swap loops
		if (context.swapCount >= 2) {
			console.error(
				"[AgentManager] Max swap count reached for task:",
				taskId,
				"- stopping restart loop",
			);
			return false;
		}

		context.swapCount++;

		// If a new profile was specified, ensure it's set as active before restart
		if (newProfileId) {
			const profileManager = getClaudeProfileManager();
			const currentActiveId = profileManager.getActiveProfile()?.id;
			if (currentActiveId !== newProfileId) {
				profileManager.setActiveProfile(newProfileId);
			}
		}
		this.killTask(taskId);
		setTimeout(() => {
			if (context.isSpecCreation) {
				if (!context.taskDescription) {
					console.error(
						"[AgentManager] Cannot restart spec creation: taskDescription is missing",
					);
					return;
				}
				this.startSpecCreation(
					taskId,
					context.projectPath,
					context.taskDescription,
					context.specDir,
					context.metadata,
					context.baseBranch,
					context.projectId,
				);
			} else {
				this.startTaskExecution(
					taskId,
					context.projectPath,
					context.specId,
					context.options,
					context.projectId,
				);
			}
		}, 500);

		return true;
	}

	// ============================================
	// Queue Routing Methods (Rate Limit Recovery)
	// ============================================

	/**
	 * Get running tasks grouped by profile
	 * Used by queue routing to determine profile load
	 */
	getRunningTasksByProfile(): {
		byProfile: Record<string, string[]>;
		totalRunning: number;
	} {
		return this.state.getRunningTasksByProfile();
	}

	/**
	 * Assign a profile to a task
	 * Records which profile is being used for a task
	 */
	assignProfileToTask(
		taskId: string,
		profileId: string,
		profileName: string,
		reason: "proactive" | "reactive" | "manual",
	): void {
		this.state.assignProfileToTask(taskId, profileId, profileName, reason);
	}

	/**
	 * Get the profile assignment for a task
	 */
	getTaskProfileAssignment(
		taskId: string,
	): { profileId: string; profileName: string; reason: string } | undefined {
		return this.state.getTaskProfileAssignment(taskId);
	}

	/**
	 * Update the session ID for a task (for session resume)
	 */
	updateTaskSession(taskId: string, sessionId: string): void {
		this.state.updateTaskSession(taskId, sessionId);
	}

	/**
	 * Get the session ID for a task
	 */
	getTaskSessionId(taskId: string): string | undefined {
		return this.state.getTaskSessionId(taskId);
	}
}
