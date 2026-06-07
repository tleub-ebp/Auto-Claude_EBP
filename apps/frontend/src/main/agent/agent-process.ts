import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import type { EventEmitter } from "node:events";
import type { CompletablePhase } from "../../shared/constants/phase-protocol";
import type { AppSettings } from "../../shared/types/settings";
import { appLog } from "../app-logger";
import { clearKeychainCache } from "../claude-profile/credential-utils";
import { getProfileSelectionLock } from "../claude-profile/profile-selection-lock";
import {
	ensureValidToken,
	markAgentRunning,
	markAgentStopped,
} from "../claude-profile/token-refresh";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { getToolInfo } from "../cli-tool-manager";
import { getAugmentedEnv } from "../env-utils";
import { buildMemoryEnvVars } from "../memory-env-builder";
import { isWindows, killProcessGracefully } from "../platform";
import { projectStore } from "../project-store";
import { parsePythonCommand, validatePythonPath } from "../python-detector";
import {
	getConfiguredPythonPath,
	pythonEnvManager,
} from "../python-env-manager";
import {
	createSDKRateLimitInfo,
	detectAuthFailure,
	detectRateLimit,
	getBestAvailableProfileEnv,
} from "../rate-limit-detector";
import { credentialManager } from "../services/credential-manager";
import { getAPIProfileEnv } from "../services/profile";
import { readSettingsFile } from "../settings-utils";
import type { AgentEvents } from "./agent-events";
import type { AgentState } from "./agent-state";
import { getOAuthModeClearVars } from "./env-utils";
import { parseTaskEvent } from "./task-event-parser";
import type { ExecutionProgressData, ProcessType } from "./types";

/**
 * Type for supported CLI tools
 */
type CliTool = "claude" | "gh" | "glab";

/**
 * Mapping of CLI tools to their environment variable names
 * This ensures type safety - tools cannot be mismatched with env vars.
 */
const CLI_TOOL_ENV_MAP: Readonly<Record<CliTool, string>> = {
	claude: "CLAUDE_CLI_PATH",
	gh: "GITHUB_CLI_PATH",
	glab: "GITLAB_CLI_PATH",
} as const;

function deriveGitBashPath(gitExePath: string): string | null {
	if (!isWindows()) {
		return null;
	}

	try {
		const gitDir = path.dirname(gitExePath); // e.g., D:\...\Git\mingw64\bin
		const gitDirName = path.basename(gitDir).toLowerCase();

		// Find Git installation root
		let gitRoot: string;

		if (gitDirName === "cmd") {
			// .../Git/cmd/git.exe -> .../Git
			gitRoot = path.dirname(gitDir);
		} else if (gitDirName === "bin") {
			// Could be .../Git/bin/git.exe OR .../Git/mingw64/bin/git.exe
			const parent = path.dirname(gitDir);
			const parentName = path.basename(parent).toLowerCase();
			if (parentName === "mingw64" || parentName === "mingw32") {
				// .../Git/mingw64/bin/git.exe -> .../Git
				gitRoot = path.dirname(parent);
			} else {
				// .../Git/bin/git.exe -> .../Git
				gitRoot = parent;
			}
		} else {
			// Unknown structure - try to find 'bin' sibling
			gitRoot = path.dirname(gitDir);
		}

		// Bash.exe is in Git/bin/bash.exe
		const bashPath = path.join(gitRoot, "bin", "bash.exe");

		if (existsSync(bashPath)) {
			appLog.info("[AgentProcess] Derived git-bash path:", bashPath);
			return bashPath;
		}

		// Fallback: check one level up if gitRoot didn't work
		const altBashPath = path.join(path.dirname(gitRoot), "bin", "bash.exe");
		if (existsSync(altBashPath)) {
			appLog.info(
				"[AgentProcess] Found git-bash at alternate path:",
				altBashPath,
			);
			return altBashPath;
		}

		appLog.warn(
			"[AgentProcess] Could not find bash.exe from git path:",
			gitExePath,
		);
		return null;
	} catch (error) {
		appLog.error("[AgentProcess] Error deriving git-bash path:", error);
		return null;
	}
}

/**
 * Process spawning and lifecycle management
 */
export class AgentProcessManager {
	private readonly state: AgentState;
	private readonly events: AgentEvents;
	private readonly emitter: EventEmitter;
	// Python path will be configured by pythonEnvManager after venv is ready
	// Use null to indicate not yet configured - getPythonPath() will use fallback
	private _pythonPath: string | null = null;
	private autoBuildSourcePath: string = "";

	constructor(state: AgentState, events: AgentEvents, emitter: EventEmitter) {
		this.state = state;
		this.events = events;
		this.emitter = emitter;
	}

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) {
			const validation = validatePythonPath(pythonPath);
			if (validation.valid) {
				this._pythonPath = validation.sanitizedPath || pythonPath;
			} else {
				appLog.error(
					`[AgentProcess] Invalid Python path rejected: ${validation.reason}`,
				);
				appLog.error(
					`[AgentProcess] Falling back to getConfiguredPythonPath()`,
				);
				// Don't set _pythonPath - let getPythonPath() use getConfiguredPythonPath() fallback
			}
		}
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Detects and sets CLI tool path in environment variables.
	 * Common issue: CLI tools installed via Homebrew or other non-standard locations
	 * are not in subprocess PATH when app launches from Finder/Dock.
	 *
	 * For 'claude' tool, uses getToolPath() to get the detected path.
	 * The path is prioritized to use ~/.local/bin/claude.exe (native install with latest version).
	 *
	 * @param toolName - Name of the CLI tool (e.g., 'claude', 'gh')
	 * @returns Record with env var set if tool was detected
	 */
	private detectAndSetCliPath(toolName: CliTool): Record<string, string> {
		const env: Record<string, string> = {};
		const envVarName = CLI_TOOL_ENV_MAP[toolName];
		if (!process.env[envVarName]) {
			try {
				// Use standard detection for all tools including claude
				const toolInfo = getToolInfo(toolName);
				if (toolInfo.found && toolInfo.path) {
					env[envVarName] = toolInfo.path;
					appLog.info(
						`[AgentProcess] Setting ${envVarName}:`,
						toolInfo.path,
						`(source: ${toolInfo.source})`,
					);
				}
			} catch (error) {
				appLog.warn(
					`[AgentProcess] Failed to detect ${toolName} CLI path:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		return env;
	}

	private setupProcessEnvironment(
		extraEnv: Record<string, string>,
	): NodeJS.ProcessEnv {
		// Get best available Claude profile environment (automatically handles rate limits)
		const profileResult = getBestAvailableProfileEnv();
		const profileEnv = profileResult.env;
		// Use getAugmentedEnv() to ensure common tool paths (dotnet, homebrew, etc.)
		// are available even when app is launched from Finder/Dock
		const augmentedEnv = getAugmentedEnv();

		// On Windows, detect and pass git-bash path for Claude Code CLI
		// Electron can detect git via where.exe, but Python subprocess may not have the same PATH
		const gitBashEnv: Record<string, string> = {};
		if (isWindows() && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
			try {
				const gitInfo = getToolInfo("git");
				if (gitInfo.found && gitInfo.path) {
					const bashPath = deriveGitBashPath(gitInfo.path);
					if (bashPath) {
						gitBashEnv.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
						appLog.info(
							"[AgentProcess] Setting CLAUDE_CODE_GIT_BASH_PATH:",
							bashPath,
						);
					}
				}
			} catch (error) {
				appLog.warn("[AgentProcess] Failed to detect git-bash path:", error);
			}
		}

		// Detect and pass CLI tool paths to Python backend
		const claudeCliEnv = this.detectAndSetCliPath("claude");
		const ghCliEnv = this.detectAndSetCliPath("gh");
		const glabCliEnv = this.detectAndSetCliPath("glab");

		// Get active provider credentials (e.g., WINDSURF_API_KEY, SELECTED_LLM_PROVIDER)
		// This ensures non-Claude providers get their credentials injected into the subprocess
		const providerEnv = credentialManager.getEnvironmentVariables();
		appLog.info("[AgentProcess] Provider env vars from CredentialManager:", {
			SELECTED_LLM_PROVIDER: providerEnv.SELECTED_LLM_PROVIDER || "(not set)",
			hasWindsurfApiKey: !!providerEnv.WINDSURF_API_KEY,
			hasWindsurfBaseUrl: !!providerEnv.WINDSURF_BASE_URL,
			activeCredential:
				credentialManager.getActiveCredential()?.provider || "(none)",
			keys: Object.keys(providerEnv),
		});

		// When using a non-Claude provider (e.g., OpenAI, Mistral), clear Claude/Anthropic
		// auth env vars so Claude Code CLI doesn't authenticate to Anthropic and then reject
		// provider-specific model names (e.g., gpt-4o is unknown to Anthropic).
		const nonClaudeProvider =
			providerEnv.SELECTED_LLM_PROVIDER &&
			!["claude", "anthropic"].includes(providerEnv.SELECTED_LLM_PROVIDER) &&
			providerEnv.SELECTED_LLM_PROVIDER !== "copilot"; // copilot uses its own gh CLI auth
		const claudeAuthClearVars: Record<string, undefined> = nonClaudeProvider
			? {
					CLAUDE_CODE_OAUTH_TOKEN: undefined,
					CLAUDE_CONFIG_DIR: undefined,
					ANTHROPIC_API_KEY: undefined,
					ANTHROPIC_AUTH_TOKEN: undefined,
				}
			: {};

		return {
			...augmentedEnv,
			...gitBashEnv,
			...claudeCliEnv,
			...ghCliEnv,
			...glabCliEnv,
			...extraEnv,
			...profileEnv,
			...claudeAuthClearVars,
			...providerEnv,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONUTF8: "1",
		} as NodeJS.ProcessEnv;
	}

	private handleProcessFailure(
		taskId: string,
		allOutput: string,
		processType: ProcessType,
	): boolean {
		appLog.info(
			"[AgentProcess] Checking for rate limit in output (last 500 chars):",
			allOutput.slice(-500),
		);

		const rateLimitDetection = detectRateLimit(allOutput);
		appLog.info("[AgentProcess] Rate limit detection result:", {
			isRateLimited: rateLimitDetection.isRateLimited,
			resetTime: rateLimitDetection.resetTime,
			limitType: rateLimitDetection.limitType,
			profileId: rateLimitDetection.profileId,
			suggestedProfile: rateLimitDetection.suggestedProfile,
		});

		if (rateLimitDetection.isRateLimited) {
			const wasHandled = this.handleRateLimitWithAutoSwap(
				taskId,
				rateLimitDetection,
				processType,
			);
			if (wasHandled) return true;

			const source = processType === "spec-creation" ? "roadmap" : "task";
			const rateLimitInfo = createSDKRateLimitInfo(source, rateLimitDetection, {
				taskId,
			});
			appLog.info(
				"[AgentProcess] Emitting sdk-rate-limit event (manual):",
				rateLimitInfo,
			);
			this.emitter.emit("sdk-rate-limit", rateLimitInfo);
			return true;
		}

		return this.handleAuthFailure(taskId, allOutput);
	}

	private handleRateLimitWithAutoSwap(
		taskId: string,
		rateLimitDetection: ReturnType<typeof detectRateLimit>,
		processType: ProcessType,
	): boolean {
		const profileManager = getClaudeProfileManager();
		const autoSwitchSettings = profileManager.getAutoSwitchSettings();

		appLog.info("[AgentProcess] Auto-switch settings:", {
			enabled: autoSwitchSettings.enabled,
			autoSwitchOnRateLimit: autoSwitchSettings.autoSwitchOnRateLimit,
			proactiveSwapEnabled: autoSwitchSettings.proactiveSwapEnabled,
		});

		if (
			!autoSwitchSettings.enabled ||
			!autoSwitchSettings.autoSwitchOnRateLimit
		) {
			appLog.info("[AgentProcess] Auto-switch disabled - showing manual modal");
			return false;
		}

		const currentProfileId = rateLimitDetection.profileId;
		let bestProfile = profileManager.getBestAvailableProfile(currentProfileId);

		appLog.info(
			"[AgentProcess] Best available profile:",
			bestProfile
				? {
						id: bestProfile.id,
						name: bestProfile.name,
					}
				: "NONE",
		);

		if (!bestProfile) {
			// Single account case: let backend handle with intelligent pause
			// Don't show manual modal - backend will pause intelligently and resume when ready
			appLog.info(
				"[AgentProcess] No alternative profile - backend will handle with intelligent pause",
			);
			// Return false to let handleProcessFailure emit sdk-rate-limit event
			// The frontend can then show appropriate UI (e.g., "Paused until X time")
			return false;
		}

		// Try to acquire selection lock to prevent multiple agents switching to the same profile
		const lock = getProfileSelectionLock();
		if (!lock.tryAcquire(bestProfile.id, taskId)) {
			appLog.info(
				"[AgentProcess] Profile locked by another swap, trying next-best:",
				bestProfile.id,
			);
			// The best profile is being selected by another concurrent operation
			// Try to find next-best, excluding both current and locked profiles
			bestProfile = profileManager.getBestAvailableProfile(currentProfileId);
			if (!bestProfile || lock.isLocked(bestProfile.id)) {
				appLog.info("[AgentProcess] No unlocked alternative profile available");
				return false;
			}
			if (!lock.tryAcquire(bestProfile.id, taskId)) {
				appLog.info("[AgentProcess] Second-best also locked, giving up");
				return false;
			}
		}

		appLog.info(
			"[AgentProcess] AUTO-SWAP: Switching from",
			currentProfileId,
			"to",
			bestProfile.id,
		);
		profileManager.setActiveProfile(bestProfile.id);
		lock.release(bestProfile.id);

		const source = processType === "spec-creation" ? "roadmap" : "task";
		const rateLimitInfo = createSDKRateLimitInfo(source, rateLimitDetection, {
			taskId,
		});
		rateLimitInfo.wasAutoSwapped = true;
		rateLimitInfo.swappedToProfile = {
			id: bestProfile.id,
			name: bestProfile.name,
		};
		rateLimitInfo.swapReason = "reactive";

		appLog.info(
			"[AgentProcess] Emitting sdk-rate-limit event (auto-swapped):",
			rateLimitInfo,
		);
		this.emitter.emit("sdk-rate-limit", rateLimitInfo);

		appLog.info(
			"[AgentProcess] Emitting auto-swap-restart-task event for task:",
			taskId,
		);
		this.emitter.emit("auto-swap-restart-task", taskId, bestProfile.id);
		return true;
	}

	private handleAuthFailure(taskId: string, allOutput: string): boolean {
		appLog.info(
			"[AgentProcess] No rate limit detected - checking for auth failure",
		);

		// FALSE POSITIVE GUARD: If the process output contains multiple phase completion
		// markers, it means the auth was working fine for earlier phases. The failure is
		// likely from something else (rate limit, model issue, validation error, etc.)
		// not an authentication problem. The auth patterns can match AI-generated content
		// that DISCUSSES authentication topics (e.g., in specs about auth features).
		const phaseMarkerCount = (allOutput.match(/__EXEC_PHASE__/g) || []).length;
		if (phaseMarkerCount >= 3) {
			appLog.info(
				"[AgentProcess] Skipping auth failure check: output contains",
				phaseMarkerCount,
				"phase markers — auth was working for earlier phases. Process failure is likely from another cause.",
			);
			return false;
		}

		const authFailureDetection = detectAuthFailure(allOutput);

		if (!authFailureDetection.isAuthFailure) {
			appLog.info(
				"[AgentProcess] Process failed but no rate limit or auth failure detected",
			);
			return false;
		}

		appLog.info("[AgentProcess] Auth failure detected:", authFailureDetection);

		// Try auto-swap if enabled
		const wasHandled = this.handleAuthFailureWithAutoSwap(
			taskId,
			authFailureDetection,
		);

		if (!wasHandled) {
			// Fall back to UI notification
			this.emitter.emit("auth-failure", taskId, {
				profileId: authFailureDetection.profileId,
				failureType: authFailureDetection.failureType,
				message: authFailureDetection.message,
				originalError: authFailureDetection.originalError,
			});
		}

		return true;
	}

	/**
	 * Attempt to auto-swap to another profile on authentication failure.
	 * Only works when autoSwitchOnAuthFailure is enabled and an alternative
	 * authenticated profile is available.
	 */
	private handleAuthFailureWithAutoSwap(
		taskId: string,
		authFailureDetection: ReturnType<typeof detectAuthFailure>,
	): boolean {
		const profileManager = getClaudeProfileManager();
		const autoSwitchSettings = profileManager.getAutoSwitchSettings();

		appLog.info("[AgentProcess] Auth failure auto-switch settings:", {
			enabled: autoSwitchSettings.enabled,
			autoSwitchOnAuthFailure: autoSwitchSettings.autoSwitchOnAuthFailure,
		});

		// Check if auto-switch on auth failure is enabled
		if (
			!autoSwitchSettings.enabled ||
			!autoSwitchSettings.autoSwitchOnAuthFailure
		) {
			appLog.info(
				"[AgentProcess] Auth failure auto-switch disabled - falling back to UI",
			);
			return false;
		}

		const currentProfileId = authFailureDetection.profileId;
		const bestProfile =
			profileManager.getBestAvailableProfile(currentProfileId);

		appLog.info(
			"[AgentProcess] Best available profile for auth failure swap:",
			bestProfile
				? {
						id: bestProfile.id,
						name: bestProfile.name,
						isAuthenticated: bestProfile.isAuthenticated,
					}
				: "NONE",
		);

		// Verify the best profile is actually authenticated
		if (!bestProfile?.isAuthenticated) {
			appLog.info(
				"[AgentProcess] No authenticated alternative profile - falling back to UI",
			);
			return false;
		}

		appLog.info(
			"[AgentProcess] AUTH-FAILURE AUTO-SWAP:",
			currentProfileId,
			"->",
			bestProfile.id,
		);
		profileManager.setActiveProfile(bestProfile.id);

		// Emit auth-failure event with swap metadata for UI notification
		this.emitter.emit("auth-failure", taskId, {
			profileId: authFailureDetection.profileId,
			failureType: authFailureDetection.failureType,
			message: authFailureDetection.message,
			originalError: authFailureDetection.originalError,
			wasAutoSwapped: true,
			swappedToProfile: { id: bestProfile.id, name: bestProfile.name },
		});

		// Reuse existing restart event
		appLog.info(
			"[AgentProcess] Emitting auto-swap-restart-task event for auth failure:",
			taskId,
		);
		this.emitter.emit("auto-swap-restart-task", taskId, bestProfile.id);
		return true;
	}

	/**
	 * Get the configured Python path.
	 * Returns explicitly configured path, or falls back to getConfiguredPythonPath()
	 * which uses the venv Python if ready.
	 */
	getPythonPath(): string {
		// If explicitly configured (by pythonEnvManager), use that
		if (this._pythonPath) {
			return this._pythonPath;
		}
		// Otherwise use the global configured path (venv if ready, else bundled/system)
		return getConfiguredPythonPath();
	}

	/**
	 * Get the auto-claude source path (detects automatically if not configured)
	 */
	getAutoBuildSourcePath(): string | null {
		// Use runners/spec_runner.py as the validation marker - this is the file actually needed
		const validatePath = (p: string): boolean => {
			return (
				existsSync(p) && existsSync(path.join(p, "runners", "spec_runner.py"))
			);
		};

		// If manually configured AND valid, use that
		if (this.autoBuildSourcePath && validatePath(this.autoBuildSourcePath)) {
			return this.autoBuildSourcePath;
		}

		// Auto-detect from app location (configured path was invalid or not set)
		const possiblePaths = [
			// Packaged app: backend is in extraResources (process.resourcesPath/backend)
			...(app.isPackaged ? [path.join(process.resourcesPath, "backend")] : []),
			// Dev mode: from dist/main -> ../../backend (apps/frontend/out/main -> apps/backend)
			path.resolve(__dirname, "..", "..", "..", "backend"),
			// Alternative: from app root -> apps/backend
			path.resolve(app.getAppPath(), "..", "backend"),
			// If running from repo root with apps structure
			path.resolve(process.cwd(), "apps", "backend"),
		];

		for (const p of possiblePaths) {
			if (validatePath(p)) {
				return p;
			}
		}
		return null;
	}

	/**
	 * Ensure Python environment is ready before spawning processes.
	 * This is a shared method used by AgentManager and AgentQueueManager
	 * to prevent race conditions where tasks start before venv initialization completes.
	 *
	 * @param context - Context identifier for logging (e.g., 'AgentManager', 'AgentQueue')
	 * @returns Object with ready status and optional error message
	 */
	async ensurePythonEnvReady(
		context: string,
	): Promise<{ ready: boolean; error?: string }> {
		if (pythonEnvManager.isEnvReady()) {
			return { ready: true };
		}

		appLog.info(
			`[${context}] Python environment not ready, waiting for initialization...`,
		);

		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			const error = "auto-build source not found";
			appLog.error(`[${context}] Cannot initialize Python - ${error}`);
			return { ready: false, error };
		}

		const status = await pythonEnvManager.initialize(autoBuildSource);
		if (!status.ready) {
			appLog.error(
				`[${context}] Python environment initialization failed:`,
				status.error,
			);
			return { ready: false, error: status.error || "initialization failed" };
		}

		appLog.info(`[${context}] Python environment now ready`);
		return { ready: true };
	}

	/**
	 * Get project-specific environment variables based on project settings
	 */
	private getProjectEnvVars(projectPath: string): Record<string, string> {
		const env: Record<string, string> = {};

		// Find project by path
		const projects = projectStore.getProjects();
		const project = projects.find((p) => p.path === projectPath);

		if (project?.settings) {
			// Graphiti MCP integration
			if (project.settings.graphitiMcpEnabled) {
				const graphitiUrl =
					project.settings.graphitiMcpUrl || "http://localhost:8000/mcp/";
				env.GRAPHITI_MCP_URL = graphitiUrl;
			}

			// CLAUDE.md integration (enabled by default)
			if (project.settings.useClaudeMd !== false) {
				env.USE_CLAUDE_MD = "true";
			}

			// Strict TDD (Red-Green-Refactor) mode (opt-in)
			if (project.settings.tddMode) {
				env.TDD_MODE = "true";
			}
		}

		return env;
	}

	/**
	 * Parse environment variables from a .env file content.
	 * Filters out empty values to prevent overriding valid tokens from profiles.
	 */
	private parseEnvFile(envPath: string): Record<string, string> {
		if (!existsSync(envPath)) {
			return {};
		}

		try {
			const envContent = readFileSync(envPath, "utf-8");
			const envVars: Record<string, string> = {};

			// Handle both Unix (\n) and Windows (\r\n) line endings
			for (const line of envContent.split(/\r?\n/)) {
				const trimmed = line.trim();
				// Skip comments and empty lines
				if (!trimmed || trimmed.startsWith("#")) {
					continue;
				}

				const eqIndex = trimmed.indexOf("=");
				if (eqIndex > 0) {
					const key = trimmed.substring(0, eqIndex).trim();
					let value = trimmed.substring(eqIndex + 1).trim();

					// Remove quotes if present
					if (
						(value.startsWith('"') && value.endsWith('"')) ||
						(value.startsWith("'") && value.endsWith("'"))
					) {
						value = value.slice(1, -1);
					}

					// Skip empty values to prevent overriding valid values from other sources
					if (value) {
						envVars[key] = value;
					}
				}
			}

			return envVars;
		} catch {
			return {};
		}
	}

	/**
	 * Load environment variables from project's .workpilot/.env file
	 * This contains frontend-configured settings like memory/Graphiti configuration
	 */
	private loadProjectEnv(projectPath: string): Record<string, string> {
		// Find project by path to get autoBuildPath
		const projects = projectStore.getProjects();
		const project = projects.find((p) => p.path === projectPath);

		if (!project?.autoBuildPath) {
			return {};
		}

		const envPath = path.join(projectPath, project.autoBuildPath, ".env");
		return this.parseEnvFile(envPath);
	}

	/**
	 * Load environment variables from auto-claude .env file
	 */
	loadAutoBuildEnv(): Record<string, string> {
		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			return {};
		}

		const envPath = path.join(autoBuildSource, ".env");
		return this.parseEnvFile(envPath);
	}

	/**
	 * Spawn a Python process for task execution
	 */
	async spawnProcess(
		taskId: string,
		cwd: string,
		args: string[],
		extraEnv: Record<string, string> = {},
		processType: ProcessType = "task-execution",
		projectId?: string,
	): Promise<void> {
		const isSpecRunner = processType === "spec-creation";
		this.killProcess(taskId);

		const spawnId = this.state.generateSpawnId();

		// IMPORTANT: Add to tracking IMMEDIATELY, before async operations.
		// This ensures getRunningTasks() returns the task right away, preventing
		// flaky tests on slower Windows CI where async setup may take longer than
		// vi.waitFor timeout (ACS-392).
		this.state.addProcess(taskId, {
			taskId,
			process: null, // Will be set after spawn() call completes below
			startedAt: new Date(),
			spawnId,
		});

		// Skip Claude OAuth token refresh when a non-Claude provider is active.
		// For providers like Windsurf, the backend handles its own authentication
		// (SSO token from state.vscdb or API key) and doesn't need Claude OAuth tokens.
		// Use getEnvironmentVariables() as the source of truth since it handles all
		// fallback paths (activeCredential, globalWindsurfApiKey in settings, etc.)
		const providerCheckRaw = credentialManager.getEnvironmentVariables();
		// If Claude Code OAuth is active (agentConfigDir set) and windsurf is being injected
		// only via the globalWindsurfApiKey fallback (no explicit windsurf activeCredential),
		// treat it as a Claude provider so OAuth token refresh still happens.
		const isWindsurfViaFallback =
			providerCheckRaw.SELECTED_LLM_PROVIDER === "windsurf" &&
			credentialManager.getActiveCredential()?.provider !== "windsurf";
		const providerCheck = isWindsurfViaFallback ? {} : providerCheckRaw;
		const selectedLlmProvider =
			providerCheck.SELECTED_LLM_PROVIDER?.toLowerCase();
		const isNonClaudeProvider =
			selectedLlmProvider &&
			!["anthropic", "claude"].includes(selectedLlmProvider);

		if (isNonClaudeProvider) {
			appLog.info(
				"[AgentProcess] Skipping Claude OAuth token refresh — active provider is:",
				selectedLlmProvider,
			);
		} else {
			// CRITICAL: Force-refresh OAuth token BEFORE reading credentials for env setup.
			//
			// Why forceRefresh: true?
			// A token can be revoked on Anthropic's side while its local expiresAt timestamp
			// still says it's valid. This happens when:
			// - The UsageMonitor previously refreshed the token mid-run (Bug #8, now fixed)
			// - The user authenticated from another device/session
			// - Any other process called the refresh endpoint
			//
			// By force-refreshing, we exchange the refresh_token for a guaranteed-fresh access_token
			// BEFORE the agent process starts. This eliminates the "revoked but not expired" gap.
			//
			// If the refresh_token is also revoked (invalid_grant), the error code is propagated
			// and the UI should prompt re-authentication.
			try {
				const profileManager = getClaudeProfileManager();
				const activeProfile = profileManager.getActiveProfile();
				if (activeProfile?.configDir) {
					const tokenResult = await ensureValidToken(
						activeProfile.configDir,
						undefined,
						{ forceRefresh: true },
					);
					if (tokenResult.wasRefreshed) {
						// Clear credential cache so getProfileEnv() reads the fresh token, not a stale cached one
						clearKeychainCache(activeProfile.configDir);
						appLog.warn(
							"[AgentProcess] Force-refreshed OAuth token before agent spawn for profile:",
							activeProfile.name,
							"| new fingerprint:",
							tokenResult.token
								? `${tokenResult.token.slice(0, 8)}...${tokenResult.token.slice(-4)}`
								: "(none)",
						);
					} else if (
						tokenResult.errorCode === "invalid_grant" ||
						tokenResult.errorCode === "invalid_client"
					) {
						// Permanent error — the refresh_token is also revoked. User must re-authenticate.
						appLog.error(
							"[AgentProcess] PERMANENT TOKEN ERROR:",
							tokenResult.error,
							"- the refresh token is revoked. User must re-authenticate from the Accounts page.",
						);
						// Still proceed — will fail with 401, but the error handling will surface the re-auth prompt
					} else if (tokenResult.error) {
						appLog.warn(
							"[AgentProcess] Token refresh warning:",
							tokenResult.error,
							"- proceeding with existing credentials",
						);
					}
				}
			} catch (error) {
				// Non-fatal: if refresh fails, we still try with the existing token.
				// The backend may succeed if it has its own refresh mechanism, or the error
				// will be caught and reported as a 401 by the normal error handling flow.
				appLog.warn(
					"[AgentProcess] Pre-spawn token refresh failed (non-fatal):",
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		const env = this.setupProcessEnvironment(extraEnv);

		// CRITICAL: Mark this profile's token as "in use" by an agent process.
		// While marked, the UsageMonitor's ensureValidToken() will SKIP refresh for this
		// configDir, preventing token revocation that would cause 401 in the subprocess.
		const profileManager = getClaudeProfileManager();
		const agentConfigDir = profileManager.getActiveProfile()?.configDir;
		if (agentConfigDir) {
			markAgentRunning(agentConfigDir);
			appLog.info(
				"[AgentProcess] Marked profile token as in-use for agent:",
				agentConfigDir,
			);
		}

		// Get Python environment (PYTHONPATH for bundled packages, etc.)
		const pythonEnv = pythonEnvManager.getPythonEnv();

		// Get active API profile environment variables
		// BUG FIX #11: Only load API profile env when NOT using OAuth authentication.
		// When the active Claude profile has OAuth credentials (agentConfigDir is set),
		// any active API profile in profiles.json would inject ANTHROPIC_BASE_URL
		// (e.g., https://api.anthropic.com) which forces the CLI to use an endpoint
		// that doesn't support OAuth bearer tokens, causing 401 errors.
		let apiProfileEnv: Record<string, string> = {};
		if (!agentConfigDir) {
			try {
				apiProfileEnv = await getAPIProfileEnv();
			} catch (error) {
				appLog.error("[Agent Process] Failed to get API profile env:", error);
				// Continue with empty profile env (falls back to OAuth mode)
			}
		}

		// Get OAuth mode clearing vars (clears stale ANTHROPIC_* vars when in OAuth mode)
		const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);

		// Get provider-specific env vars (WINDSURF_API_KEY, SELECTED_LLM_PROVIDER, etc.)
		// Skip windsurf fallback env when Claude Code OAuth is active without an explicit windsurf credential.
		const providerSpecificEnv = isWindsurfViaFallback ? {} : providerCheckRaw;

		// Parse Python commandto handle space-separated commands like "py -3"
		const [pythonCommand, pythonBaseArgs] = parsePythonCommand(
			this.getPythonPath(),
		);
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from assignment
		let childProcess;
		try {
			childProcess = spawn(pythonCommand, [...pythonBaseArgs, ...args], {
				cwd,
				env: {
					...env, // Already includes process.env, extraEnv, profileEnv, PYTHONUNBUFFERED, PYTHONUTF8
					...pythonEnv, // Include Python environment (PYTHONPATH for bundled packages)
					...oauthModeClearVars, // Clear stale ANTHROPIC_* vars when in OAuth mode
					...apiProfileEnv, // Include active API profile config (highest priority for ANTHROPIC_* vars)
					...providerSpecificEnv, // Include provider credentials (WINDSURF_API_KEY, SELECTED_LLM_PROVIDER)
				},
			});
		} catch (err) {
			// spawn() failed synchronously (e.g., command not found, permission denied)
			// Clean up tracking entry and propagate error
			this.state.deleteProcess(taskId);
			this.emitter.emit(
				"error",
				taskId,
				err instanceof Error ? err.message : String(err),
				projectId,
			);
			throw err;
		}

		// Update the tracked process with the actual spawned ChildProcess
		this.state.updateProcess(taskId, { process: childProcess });

		// Check if this spawn was killed during async setup (before spawn() completed).
		// If so, terminate the newly created process immediately to prevent orphaned processes.
		// Note: wasSpawnKilled() is checked AFTER updateProcess() because killProcess()
		// marks the spawn as killed before deleting the tracking entry.
		//
		// CRITICAL: The `?? spawnId` fallback is essential here because if killProcess()
		// was called during the async setup window, the taskId entry may have been deleted
		// from the process map. In that case, getProcess(taskId) returns undefined, so we
		// fall back to the local spawnId variable to check if this specific spawn was killed.
		const currentSpawnId = this.state.getProcess(taskId)?.spawnId ?? spawnId;
		if (this.state.wasSpawnKilled(currentSpawnId)) {
			appLog.info(
				`[AgentProcess] Task ${taskId} was killed during spawn setup. Terminating newly created process.`,
			);
			killProcessGracefully(childProcess, {
				debugPrefix: "[AgentProcess]",
				debug:
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development",
			});
			this.state.deleteProcess(taskId);
			this.state.clearKilledSpawn(currentSpawnId);
			return; // Do not proceed with this spawn
		}

		let currentPhase: ExecutionProgressData["phase"] = "planning";
		let phaseProgress = 0;
		let currentSubtask: string | undefined;
		let lastMessage: string | undefined;
		let allOutput = "";
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let sequenceNumber = 0;
		// Suppress repetitive "Error in hook callback hook_0: Stream closed" noise.
		// These come from Claude Code CLI's internal skill-improvement hook firing on an
		// already-closed IPC stream. They are harmless but pollute agent logs every ~5s.
		let hookErrorSuppressionLines = 0;
		// FIX (ACS-203): Track completed phases to prevent phase overlaps
		// When a phase completes, it's added to this array before transitioning to the next phase
		const completedPhases: CompletablePhase[] = [];

		this.emitter.emit(
			"execution-progress",
			taskId,
			{
				phase: currentPhase,
				phaseProgress: 0,
				overallProgress: this.events.calculateOverallProgress(currentPhase, 0),
				message: isSpecRunner
					? "Starting spec creation..."
					: "Starting build process...",
				sequenceNumber: ++sequenceNumber,
				completedPhases: [...completedPhases],
			},
			projectId,
		);

		const isDebug = ["true", "1", "yes", "on"].includes(
			process.env.DEBUG?.toLowerCase() ?? "",
		);

		const processLog = (line: string) => {
			allOutput = (allOutput + line).slice(-10000);

			const hasMarker = line.includes("__EXEC_PHASE__");
			if (isDebug && hasMarker) {
				appLog.debug(
					`[PhaseDebug:${taskId}] Found marker in line: "${line.substring(0, 200)}"`,
				);
			}

			// Log all task event markers for debugging
			if (line.includes("__TASK_EVENT__")) {
				appLog.debug(
					`[AgentProcess:${taskId}] Found __TASK_EVENT__ marker in line:`,
					line.substring(0, 300),
				);
			}

			const taskEvent = parseTaskEvent(line);
			if (taskEvent) {
				appLog.debug(
					`[AgentProcess:${taskId}] Parsed task event:`,
					taskEvent.type,
					taskEvent,
				);
				this.emitter.emit("task-event", taskId, taskEvent, projectId);
			}

			const phaseUpdate = this.events.parseExecutionPhase(
				line,
				currentPhase,
				isSpecRunner,
			);

			if (isDebug && hasMarker) {
				appLog.debug(`[PhaseDebug:${taskId}] Parse result:`, phaseUpdate);
			}

			if (phaseUpdate) {
				const phaseChanged = phaseUpdate.phase !== currentPhase;

				if (isDebug) {
					appLog.debug(
						`[PhaseDebug:${taskId}] Phase update: ${currentPhase} -> ${phaseUpdate.phase} (changed: ${phaseChanged})`,
					);
				}

				// FIX (ACS-203): Manage completedPhases when phases transition
				// When leaving a non-terminal phase (not complete/failed), add it to completedPhases
				if (
					phaseChanged &&
					currentPhase !== "idle" &&
					currentPhase !== phaseUpdate.phase
				) {
					// Type guard to narrow currentPhase to CompletablePhase
					const isCompletablePhase = (
						phase: ExecutionProgressData["phase"],
					): phase is CompletablePhase => {
						return ["planning", "coding", "qa_review", "qa_fixing"].includes(
							phase,
						);
					};
					if (
						isCompletablePhase(currentPhase) &&
						!completedPhases.includes(currentPhase)
					) {
						completedPhases.push(currentPhase);
						if (isDebug) {
							appLog.debug(
								`[PhaseDebug:${taskId}] Marked phase as completed:`,
								{ phase: currentPhase, completedPhases },
							);
						}
					}
				}

				currentPhase = phaseUpdate.phase;

				if (phaseUpdate.currentSubtask) {
					currentSubtask = phaseUpdate.currentSubtask;
				}
				if (phaseUpdate.message) {
					lastMessage = phaseUpdate.message;
				}

				if (phaseChanged) {
					phaseProgress = 10;
				} else {
					phaseProgress = Math.min(90, phaseProgress + 5);
				}

				const overallProgress = this.events.calculateOverallProgress(
					currentPhase,
					phaseProgress,
				);

				if (isDebug) {
					appLog.debug(`[PhaseDebug:${taskId}] Emitting execution-progress:`, {
						phase: currentPhase,
						phaseProgress,
						overallProgress,
						completedPhases,
					});
				}

				this.emitter.emit(
					"execution-progress",
					taskId,
					{
						phase: currentPhase,
						phaseProgress,
						overallProgress,
						currentSubtask,
						message: lastMessage,
						sequenceNumber: ++sequenceNumber,
						completedPhases: [...completedPhases],
					},
					projectId,
				);
			}
		};

		const processLine = (line: string): void => {
			// Detect the start of a hook_0 Stream-closed error block and suppress it.
			// Pattern: "Error in hook callback hook_0:" kicks off a multi-line Bun
			// error dump (source snippet + "error: Stream closed" + stack frames).
			if (line.includes("Error in hook callback hook_0:")) {
				hookErrorSuppressionLines = 8; // suppress this line + up to 7 follow-up Bun error lines
			}
			if (hookErrorSuppressionLines > 0) {
				hookErrorSuppressionLines--;
				return;
			}
			this.emitter.emit("log", taskId, `${line}\n`, projectId);
			processLog(line);
			if (isDebug) {
				appLog.debug(`[Agent:${taskId}] ${line}`);
			}
		};

		const processBufferedOutput = (buffer: string, newData: string): string => {
			if (isDebug && newData.includes("__EXEC_PHASE__")) {
				appLog.debug(
					`[PhaseDebug:${taskId}] Raw chunk with marker (${newData.length} bytes): "${newData.substring(0, 300)}"`,
				);
				appLog.debug(
					`[PhaseDebug:${taskId}] Current buffer before append (${buffer.length} bytes): "${buffer.substring(0, 100)}"`,
				);
			}

			buffer += newData;
			const lines = buffer.split("\n");
			const remaining = lines.pop() || "";

			if (isDebug && newData.includes("__EXEC_PHASE__")) {
				appLog.debug(
					`[PhaseDebug:${taskId}] Split into ${lines.length} complete lines, remaining buffer: "${remaining.substring(0, 100)}"`,
				);
			}

			for (const line of lines) {
				if (line.trim()) {
					processLine(line);
				}
			}

			return remaining;
		};

		childProcess.stdout?.on("data", (data: Buffer) => {
			stdoutBuffer = processBufferedOutput(
				stdoutBuffer,
				data.toString("utf-8"),
			);
		});

		childProcess.stderr?.on("data", (data: Buffer) => {
			stderrBuffer = processBufferedOutput(
				stderrBuffer,
				data.toString("utf-8"),
			);
		});

		childProcess.on("exit", (code: number | null) => {
			// CRITICAL: Unmark this profile's token as "in use" so the UsageMonitor
			// can resume normal token refresh operations for this profile.
			if (agentConfigDir) {
				markAgentStopped(agentConfigDir);
				appLog.info(
					"[AgentProcess] Unmarked profile token after agent exit:",
					agentConfigDir,
				);
			}

			if (stdoutBuffer.trim()) {
				this.emitter.emit("log", taskId, `${stdoutBuffer}\n`, projectId);
				processLog(stdoutBuffer);
			}
			if (stderrBuffer.trim()) {
				this.emitter.emit("log", taskId, `${stderrBuffer}\n`, projectId);
				processLog(stderrBuffer);
			}

			this.state.deleteProcess(taskId);

			if (this.state.wasSpawnKilled(spawnId)) {
				this.state.clearKilledSpawn(spawnId);
				return;
			}

			if (code !== 0) {
				appLog.info(
					"[AgentProcess] Process failed with code:",
					code,
					"for task:",
					taskId,
				);
				const wasHandled = this.handleProcessFailure(
					taskId,
					allOutput,
					processType,
				);
				if (wasHandled) {
					this.emitter.emit("exit", taskId, code, processType, projectId);
					return;
				}
			}

			if (
				code !== 0 &&
				currentPhase !== "complete" &&
				currentPhase !== "failed"
			) {
				this.emitter.emit(
					"execution-progress",
					taskId,
					{
						phase: "failed",
						phaseProgress: 0,
						overallProgress: this.events.calculateOverallProgress(
							currentPhase,
							phaseProgress,
						),
						message: `Process exited with code ${code}`,
						sequenceNumber: ++sequenceNumber,
						completedPhases: [...completedPhases],
					},
					projectId,
				);
			}

			this.emitter.emit("exit", taskId, code, processType, projectId);
		});

		// Handle process error
		childProcess.on("error", (err: Error) => {
			appLog.error("[AgentProcess] Process error:", err.message);
			this.state.deleteProcess(taskId);

			this.emitter.emit(
				"execution-progress",
				taskId,
				{
					phase: "failed",
					phaseProgress: 0,
					overallProgress: 0,
					message: `Error: ${err.message}`,
					sequenceNumber: ++sequenceNumber,
					completedPhases: [...completedPhases],
				},
				projectId,
			);

			this.emitter.emit("error", taskId, err.message, projectId);
		});
	}

	/**
	 * Kill a specific task's process
	 */
	killProcess(taskId: string): boolean {
		const agentProcess = this.state.getProcess(taskId);
		if (!agentProcess) return false;

		// Mark this specific spawn as killed so its exit handler knows to ignore
		this.state.markSpawnAsKilled(agentProcess.spawnId);

		// If process hasn't been spawned yet (still in async setup phase, before spawn() returns),
		// just remove from tracking. The spawn() call will still complete, but the spawned process
		// will be terminated by the post-spawn wasSpawnKilled() check (see spawnProcess() after updateProcess).
		if (!agentProcess.process) {
			this.state.deleteProcess(taskId);
			return true;
		}

		// Use shared platform-aware kill utility
		killProcessGracefully(agentProcess.process, {
			debugPrefix: "[AgentProcess]",
			debug:
				process.env.DEBUG === "true" || process.env.NODE_ENV === "development",
		});

		this.state.deleteProcess(taskId);
		return true;
	}

	/**
	 * Kill all running processes and wait for them to exit
	 */
	async killAllProcesses(): Promise<void> {
		const KILL_TIMEOUT_MS = 10000; // 10 seconds max wait

		const killPromises = this.state.getRunningTaskIds().map((taskId) => {
			return new Promise<void>((resolve) => {
				const agentProcess = this.state.getProcess(taskId);

				if (!agentProcess) {
					resolve();
					return;
				}

				// If process hasn't been spawned yet (still in async setup phase before spawn() returns),
				// just resolve immediately. The spawn() call will still complete, but the spawned process
				// will be terminated by the post-spawn wasSpawnKilled() check (see spawnProcess() after updateProcess).
				if (!agentProcess.process) {
					this.killProcess(taskId);
					resolve();
					return;
				}

				// Set up timeout to not block forever
				const timeoutId = setTimeout(() => {
					resolve();
				}, KILL_TIMEOUT_MS);

				// Listen for exit event if the process supports it
				// (process.once is available on real ChildProcess objects, but may not be in test mocks)
				if (typeof agentProcess.process.once === "function") {
					agentProcess.process.once("exit", () => {
						clearTimeout(timeoutId);
						resolve();
					});
				}

				// Kill the process
				this.killProcess(taskId);
			});
		});

		await Promise.all(killPromises);
	}

	/**
	 * Get combined environment variables for a project
	 *
	 * Priority (later sources override earlier):
	 * 1. App-wide memory settings from settings.json (NEW - enables memory from onboarding)
	 * 2. Backend source .env (apps/backend/.env) - CLI defaults
	 * 3. Project's .workpilot/.env - Frontend-configured settings (memory, integrations)
	 * 4. Project settings (graphitiMcpUrl, useClaudeMd) - Runtime overrides
	 */
	getCombinedEnv(projectPath: string): Record<string, string> {
		// Load app-wide memory settings from settings.json
		// This bridges onboarding config to backend agents
		const appSettings = (readSettingsFile() || {}) as Partial<AppSettings>;
		const memoryEnv = buildMemoryEnvVars(appSettings as AppSettings);

		// Existing env sources
		const autoBuildEnv = this.loadAutoBuildEnv();
		const projectFileEnv = this.loadProjectEnv(projectPath);
		const projectSettingsEnv = this.getProjectEnvVars(projectPath);

		// Priority: app-wide memory -> backend .env -> project .env -> project settings
		// Later sources override earlier ones
		return {
			...memoryEnv,
			...autoBuildEnv,
			...projectFileEnv,
			...projectSettingsEnv,
		};
	}
}
