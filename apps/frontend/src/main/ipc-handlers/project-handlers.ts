import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	AutoBuildVersionInfo,
	GitBranchDetail,
	GitStatus,
	InitializationResult,
	IPCResult,
	Project,
	ProjectSettings,
	RepoProviderDetectionResult,
} from "../../shared/types";
import type { AgentManager } from "../agent";
import { appEmulatorService } from "../app-emulator-service";
import { changelogService } from "../changelog-service";
import { getToolPath } from "../cli-tool-manager";
import { insightsService } from "../insights-service";
import {
	checkGitStatus,
	hasLocalSource,
	initializeGit,
	initializeProject,
	isInitialized,
} from "../project-initializer";
import { projectStore } from "../project-store";
import type { PythonEnvManager, PythonEnvStatus } from "../python-env-manager";
import { titleGenerator } from "../title-generator";
import { getEffectiveSourcePath } from "../updater/path-resolver";

// ============================================
// Git Helper Functions
// ============================================

/**
 * Walk up from `start` looking for a directory containing `.git`.
 * Returns the absolute path of the Git root, or null if none found.
 */
function findGitRootAbove(start: string): string | null {
	let current = path.resolve(start);
	while (true) {
		if (existsSync(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * If the given path is a Git sub-folder (i.e. not itself the Git root,
 * but a Git root exists above it), return a warning message suggesting
 * the user reconfigure to the actual root. Returns null otherwise.
 *
 * This protects against a misconfiguration we've seen in practice: pointing
 * the project at e.g. `MeCa/meca/` when the actual repo root (containing
 * `Sources/`, `Build/`, etc.) is `MeCa/`. Plans then emit `../Sources/...`
 * paths that escape project_dir and fail validation.
 */
function checkProjectDirIsGitRoot(projectPath: string): string | null {
	const resolved = path.resolve(projectPath);
	const gitRoot = findGitRootAbove(resolved);
	if (!gitRoot) return null; // no Git anywhere — nothing to warn about
	if (gitRoot === resolved) return null; // already at the Git root — fine
	return (
		`This folder is a sub-folder of a Git repository at "${gitRoot}". ` +
		`If your source code lives outside "${resolved}" (e.g. in sibling folders), ` +
		`the planner may emit paths with "../" that are rejected by the coder. ` +
		`Consider reconfiguring the project to point at "${gitRoot}" instead.`
	);
}

/**
 * Get list of git branches for a directory (both local and remote)
 */
function getGitBranches(projectPath: string): string[] {
	try {
		// First fetch to ensure we have latest remote refs
		try {
			execFileSync(getToolPath("git"), ["fetch", "--prune"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 10000, // 10 second timeout for fetch
			});
		} catch {
			// Fetch may fail if offline or no remote, continue with local refs
		}

		// Get all branches (local + remote) using --all flag
		const result = execFileSync(
			getToolPath("git"),
			["branch", "--all", "--format=%(refname:short)"],
			{
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		const branches = result
			.trim()
			.split("\n")
			.filter((b) => b.trim())
			.map((b) => {
				// Remote branches come as "origin/branch-name", keep the full name
				// but remove the "origin/" prefix for display while keeping it usable
				return b.trim();
			})
			// Remove HEAD pointer entries like "origin/HEAD"
			.filter((b) => !b.endsWith("/HEAD"))
			// Remove duplicates (local branch may exist alongside remote)
			.filter((branch, index, self) => {
				// If it's a remote branch (origin/x) and local version exists, keep local
				if (branch.startsWith("origin/")) {
					const localName = branch.replace("origin/", "");
					return !self.includes(localName);
				}
				return self.indexOf(branch) === index;
			});

		// Sort: local branches first, then remote branches
		return branches.sort((a, b) => {
			const aIsRemote = a.startsWith("origin/");
			const bIsRemote = b.startsWith("origin/");
			if (aIsRemote && !bIsRemote) return 1;
			if (!aIsRemote && bIsRemote) return -1;
			return a.localeCompare(b);
		});
	} catch {
		return [];
	}
}

/**
 * Get structured branch information for a directory (both local and remote)
 * Returns GitBranchDetail[] with type indicators, keeping both local and remote versions
 * when a branch exists in both places (no deduplication)
 */
function getGitBranchesWithInfo(projectPath: string): GitBranchDetail[] {
	try {
		// First fetch to ensure we have latest remote refs
		try {
			execFileSync(getToolPath("git"), ["fetch", "--prune"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 10000, // 10 second timeout for fetch
			});
		} catch {
			// Fetch may fail if offline or no remote, continue with local refs
		}

		// Get current branch for isCurrent indicator
		let currentBranch: string | null = null;
		try {
			const currentResult = execFileSync(
				getToolPath("git"),
				["rev-parse", "--abbrev-ref", "HEAD"],
				{
					cwd: projectPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			currentBranch = currentResult.trim() || null;
		} catch {
			// Ignore - current branch detection may fail in some edge cases
		}

		// Get local branches
		const localResult = execFileSync(
			getToolPath("git"),
			["branch", "--format=%(refname:short)"],
			{
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		const localBranches: GitBranchDetail[] = localResult
			.trim()
			.split("\n")
			.filter((b) => b.trim())
			.map((b) => {
				const name = b.trim();
				return {
					name,
					type: "local" as const,
					displayName: name,
					isCurrent: name === currentBranch,
				};
			});

		// Get remote branches
		let remoteBranches: GitBranchDetail[] = [];
		try {
			const remoteResult = execFileSync(
				getToolPath("git"),
				["branch", "-r", "--format=%(refname:short)"],
				{
					cwd: projectPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				},
			);

			remoteBranches = remoteResult
				.trim()
				.split("\n")
				.filter((b) => b.trim())
				.map((b) => b.trim())
				// Remove HEAD pointer entries like "origin/HEAD"
				.filter((b) => !b.endsWith("/HEAD"))
				.map((name) => ({
					name,
					type: "remote" as const,
					displayName: name,
					isCurrent: false,
				}));
		} catch {
			// Remote branches may not exist, continue with local only
		}

		// Combine and sort: local branches first, then remote branches, alphabetically within each group
		const allBranches = [...localBranches, ...remoteBranches];

		return allBranches.sort((a, b) => {
			// Local branches come first
			if (a.type === "local" && b.type === "remote") return -1;
			if (a.type === "remote" && b.type === "local") return 1;
			// Within same type, sort alphabetically
			return a.name.localeCompare(b.name);
		});
	} catch {
		return [];
	}
}

/**
 * Get the current git branch for a directory
 */
function getCurrentGitBranch(projectPath: string): string | null {
	try {
		const result = execFileSync(
			getToolPath("git"),
			["rev-parse", "--abbrev-ref", "HEAD"],
			{
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		return result.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Detect the main branch for a git repository
 * Checks for common main branch names in order of preference
 */
// Helper function to parse git remote output
function parseGitRemotes(
	gitOutput: string,
): Map<string, { fetch?: string; push?: string }> {
	const remotes = new Map<string, { fetch?: string; push?: string }>();
	const remoteRegex = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/;

	for (const line of gitOutput.trim().split("\n")) {
		const match = remoteRegex.exec(line.trim());
		if (!match) continue;
		const name = match[1];
		const url = match[2];
		const type = match[3] as "fetch" | "push";
		const entry = remotes.get(name) || {};
		entry[type] = url;
		remotes.set(name, entry);
	}

	return remotes;
}

// Helper function to detect provider from URL
function detectProviderFromUrl(
	url: string,
): "github" | "azure_devops" | "unknown" {
	if (/github\.com[:/]/i.test(url)) return "github";
	if (/dev\.azure\.com|visualstudio\.com|ssh\.dev\.azure\.com/i.test(url))
		return "azure_devops";
	return "unknown";
}

// Helper function to get URL from remote entry
function getRemoteUrl(remote: {
	fetch?: string;
	push?: string;
}): string | undefined {
	return remote.fetch || remote.push;
}

// Helper function to create provider result
function createProviderResult(
	provider: string,
	remoteName: string,
	remoteUrl?: string,
): RepoProviderDetectionResult {
	return {
		provider: provider as "github" | "azure_devops" | "unknown",
		remoteName,
		remoteUrl,
	};
}

// Helper function to try get origin URL as fallback
function tryGetOriginFallback(
	projectPath: string,
): RepoProviderDetectionResult | null {
	try {
		const originUrl = execFileSync(
			getToolPath("git"),
			["config", "--get", "remote.origin.url"],
			{
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();

		if (originUrl) {
			return createProviderResult(
				detectProviderFromUrl(originUrl),
				"origin",
				originUrl,
			);
		}
	} catch {
		// Ignore and return null
	}
	return null;
}

// Helper function to find known provider in remotes
function findKnownProvider(
	remotes: Map<string, { fetch?: string; push?: string }>,
): RepoProviderDetectionResult | null {
	// Try origin first
	const origin = remotes.get("origin");
	if (origin) {
		const url = getRemoteUrl(origin);
		// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
		const provider = detectProviderFromUrl(url!);
		if (provider !== "unknown") {
			return createProviderResult(provider, "origin", url);
		}
	}

	// Try all other remotes
	for (const [name, urls] of remotes.entries()) {
		const url = getRemoteUrl(urls);
		// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
		const provider = detectProviderFromUrl(url!);
		if (provider !== "unknown") {
			return createProviderResult(provider, name, url);
		}
	}

	return null;
}

// Helper function to get fallback result
function getFallbackResult(
	remotes: Map<string, { fetch?: string; push?: string }>,
): RepoProviderDetectionResult {
	const origin = remotes.get("origin");
	if (origin) {
		const url = getRemoteUrl(origin);
		return createProviderResult("unknown", "origin", url);
	}

	const firstEntry = remotes.entries().next().value;
	if (!firstEntry) {
		return createProviderResult("unknown", "origin");
	}

	const [firstName, firstUrls] = firstEntry;
	return createProviderResult("unknown", firstName, getRemoteUrl(firstUrls));
}

function detectRepoProvider(projectPath: string): RepoProviderDetectionResult {
	try {
		const result = execFileSync(getToolPath("git"), ["remote", "-v"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const remotes = parseGitRemotes(result);

		if (remotes.size === 0) {
			const fallbackResult = tryGetOriginFallback(projectPath);
			return fallbackResult || createProviderResult("unknown", "origin");
		}

		const knownProviderResult = findKnownProvider(remotes);
		if (knownProviderResult) {
			return knownProviderResult;
		}

		return getFallbackResult(remotes);
	} catch {
		return createProviderResult("unknown", "origin");
	}
}

function detectMainBranch(projectPath: string): string | null {
	const branches = getGitBranches(projectPath);
	if (branches.length === 0) return null;

	// Check for common main branch names in order of preference
	const mainBranchCandidates = ["main", "master", "develop", "dev", "trunk"];
	for (const candidate of mainBranchCandidates) {
		if (branches.includes(candidate)) {
			return candidate;
		}
	}

	// If none of the common names found, check for origin/HEAD reference
	try {
		const result = execFileSync(
			getToolPath("git"),
			["symbolic-ref", "refs/remotes/origin/HEAD"],
			{
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const ref = result.trim();
		// Extract branch name from refs/remotes/origin/main
		const regex = /refs\/remotes\/origin\/(.+)/;
		const match = regex.exec(ref);
		if (match && branches.includes(match[1])) {
			return match[1];
		}
	} catch {
		// origin/HEAD not set, continue with fallback
	}

	// Fallback: return the first branch (usually the current one)
	return branches[0] || null;
}

/**
 * Configure all Python-dependent services with the managed Python path
 */
const configureServicesWithPython = (
	pythonPath: string,
	autoBuildPath: string,
	agentManager: AgentManager,
): void => {
	console.warn("[IPC] Configuring services with Python:", pythonPath);
	agentManager.configure(pythonPath, autoBuildPath);
	appEmulatorService.configure(pythonPath, autoBuildPath);
	changelogService.configure(pythonPath, autoBuildPath);
	insightsService.configure(pythonPath, autoBuildPath);
	titleGenerator.configure(pythonPath, autoBuildPath);
};

/**
 * Initialize the Python environment and configure services
 */
const initializePythonEnvironment = async (
	pythonEnvManager: PythonEnvManager,
	agentManager: AgentManager,
): Promise<PythonEnvStatus> => {
	const autoBuildSource = getEffectiveSourcePath();
	if (!autoBuildSource) {
		console.warn("[IPC] Auto-build source not found, skipping Python env init");
		return {
			ready: false,
			pythonPath: null,
			sitePackagesPath: null,
			venvExists: false,
			depsInstalled: false,
			usingBundledPackages: false,
			error: "Auto-build source not found",
		};
	}

	console.warn("[IPC] Initializing Python environment...");
	const status = await pythonEnvManager.initialize(autoBuildSource);

	if (status.ready && status.pythonPath) {
		configureServicesWithPython(
			status.pythonPath,
			autoBuildSource,
			agentManager,
		);
	}

	return status;
};

/**
 * Register all project-related IPC handlers
 */
export function registerProjectHandlers(
	pythonEnvManager: PythonEnvManager,
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	// ============================================
	// Project Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_ADD,
		async (_, projectPath: string): Promise<IPCResult<Project>> => {
			try {
				// Validate path exists
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}

				// Migrate legacy .auto-claude/ to .workpilot/ if needed
				const oldDir = path.join(projectPath, ".auto-claude");
				const newDir = path.join(projectPath, ".workpilot");
				if (existsSync(oldDir) && !existsSync(newDir)) {
					try {
						renameSync(oldDir, newDir);
					} catch (migrateErr) {
						console.warn(
							`[Project] Could not migrate .auto-claude to .workpilot: ${migrateErr}`,
						);
					}
				}

				const project = projectStore.addProject(projectPath);
				const warning = checkProjectDirIsGitRoot(projectPath);
				return warning
					? { success: true, data: project, warning }
					: { success: true, data: project };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_REMOVE,
		async (_, projectId: string): Promise<IPCResult> => {
			const success = projectStore.removeProject(projectId);
			return { success };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_LIST,
		async (): Promise<IPCResult<Project[]>> => {
			// Migrate legacy .auto-claude/ to .workpilot/ for all existing projects
			const allProjects = projectStore.getProjects();
			for (const proj of allProjects) {
				if (!proj.path) continue;
				const oldDir = path.join(proj.path, ".auto-claude");
				const newDir = path.join(proj.path, ".workpilot");
				if (existsSync(oldDir) && !existsSync(newDir)) {
					try {
						renameSync(oldDir, newDir);
					} catch (migrateErr) {
						console.warn(
							`[Project] Could not migrate .auto-claude to .workpilot: ${migrateErr}`,
						);
					}
				}
			}

			// Validate that .workpilot folders still exist for all projects
			// If a folder was deleted, reset autoBuildPath so UI prompts for reinitialization
			const resetIds = projectStore.validateProjects();
			if (resetIds.length > 0) {
				console.warn(
					"[IPC] PROJECT_LIST: Detected missing .workpilot folders for",
					resetIds.length,
					"project(s)",
				);
			}

			const projects = projectStore.getProjects();
			console.warn("[IPC] PROJECT_LIST returning", projects.length, "projects");
			return { success: true, data: projects };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
		async (
			_,
			projectId: string,
			settings: Partial<ProjectSettings>,
		): Promise<IPCResult> => {
			const project = projectStore.updateProjectSettings(projectId, settings);
			if (project) {
				return { success: true };
			}
			return { success: false, error: "Project not found" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_RENAME,
		async (_, projectId: string, name: string): Promise<IPCResult<Project>> => {
			const trimmed = (name ?? "").trim();
			if (!trimmed) {
				return { success: false, error: "Name cannot be empty" };
			}
			const project = projectStore.renameProject(projectId, trimmed);
			if (project) {
				return { success: true, data: project };
			}
			return { success: false, error: "Project not found" };
		},
	);

	// Batch existence check for every known project. Returned map keys are
	// project IDs and values are `true` when the on-disk path still exists
	// AND is a directory. Used by the tab bar to surface a "missing path"
	// indicator without doing N renderer-side fs probes.
	ipcMain.handle(
		IPC_CHANNELS.PROJECT_CHECK_PATHS,
		async (): Promise<IPCResult<Record<string, boolean>>> => {
			try {
				const projects = projectStore.getProjects();
				const result: Record<string, boolean> = {};
				for (const project of projects) {
					try {
						result[project.id] = existsSync(project.path);
					} catch {
						result[project.id] = false;
					}
				}
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Re-point a project at a new on-disk location. Used by the "missing
	// path" recovery flow in the tab bar when the user moved/renamed the
	// folder outside the app.
	ipcMain.handle(
		IPC_CHANNELS.PROJECT_REPATH,
		async (
			_,
			projectId: string,
			newPath: string,
		): Promise<IPCResult<Project>> => {
			const trimmed = (newPath ?? "").trim();
			if (!trimmed) {
				return { success: false, error: "Path cannot be empty" };
			}
			if (!existsSync(trimmed)) {
				return { success: false, error: "Path does not exist" };
			}
			const project = projectStore.repathProject(projectId, trimmed);
			if (project) {
				return { success: true, data: project };
			}
			return { success: false, error: "Project not found" };
		},
	);

	// ============================================
	// Tab State Operations (persisted in main process)
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.TAB_STATE_GET,
		async (): Promise<
			IPCResult<{
				openProjectIds: string[];
				activeProjectId: string | null;
				tabOrder: string[];
			}>
		> => {
			const tabState = projectStore.getTabState();
			return { success: true, data: tabState };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TAB_STATE_SAVE,
		async (
			_,
			tabState: {
				openProjectIds: string[];
				activeProjectId: string | null;
				tabOrder: string[];
			},
		): Promise<IPCResult> => {
			projectStore.saveTabState(tabState);
			return { success: true };
		},
	);

	// ============================================
	// Kanban Preferences Operations (persisted in main process)
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.KANBAN_PREFS_GET,
		async (
			_,
			projectId: string,
		): Promise<
			IPCResult<Record<
				string,
				{
					width: number;
					isCollapsed: boolean;
					isLocked: boolean;
					wipLimit?: number;
				}
			> | null>
		> => {
			try {
				const preferences = projectStore.getKanbanPreferences(projectId);
				return { success: true, data: preferences };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.KANBAN_PREFS_SAVE,
		async (
			_,
			projectId: string,
			preferences: Record<
				string,
				{
					width: number;
					isCollapsed: boolean;
					isLocked: boolean;
					wipLimit?: number;
				}
			>,
		): Promise<IPCResult> => {
			try {
				projectStore.saveKanbanPreferences(projectId, preferences);
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.KANBAN_STATE_GET,
		async (
			_,
			projectId: string,
		): Promise<
			IPCResult<{
				columnOrder?: string[];
				filters?: unknown;
				sort?: unknown;
				savedViews?: unknown;
			} | null>
		> => {
			try {
				const state = projectStore.getKanbanBoardState(projectId);
				return { success: true, data: state };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.KANBAN_STATE_SAVE,
		async (
			_,
			projectId: string,
			state: {
				columnOrder?: string[];
				filters?: unknown;
				sort?: unknown;
				savedViews?: unknown;
			},
		): Promise<IPCResult> => {
			try {
				projectStore.saveKanbanBoardState(projectId, state);
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// ============================================
	// Project Initialization Operations
	// ============================================

	// Set up Python environment status events
	pythonEnvManager.on("status", (message: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow) {
			mainWindow.webContents.send("python-env:status", message);
		}
	});

	pythonEnvManager.on("error", (error: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow) {
			mainWindow.webContents.send("python-env:error", error);
		}
	});

	pythonEnvManager.on("ready", (pythonPath: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow) {
			mainWindow.webContents.send("python-env:ready", pythonPath);
		}
	});

	// Initialize Python environment on startup (non-blocking)
	initializePythonEnvironment(pythonEnvManager, agentManager).then((status) => {
		console.warn("[IPC] Python environment initialized:", status);
	});

	// IPC handler to get Python environment status
	ipcMain.handle(
		"python-env:get-status",
		async (): Promise<IPCResult<PythonEnvStatus>> => {
			const status = await pythonEnvManager.getStatus();
			return { success: true, data: status };
		},
	);

	// IPC handler to reinitialize Python environment
	ipcMain.handle(
		"python-env:reinitialize",
		async (): Promise<IPCResult<PythonEnvStatus>> => {
			const status = await initializePythonEnvironment(
				pythonEnvManager,
				agentManager,
			);
			return { success: status.ready, data: status, error: status.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROJECT_INITIALIZE,
		async (_, projectId: string): Promise<IPCResult<InitializationResult>> => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const result = initializeProject(project.path);

				if (result.success) {
					// Update project's autoBuildPath
					projectStore.updateAutoBuildPath(projectId, ".workpilot");
				}

				return { success: result.success, data: result, error: result.error };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// PROJECT_CHECK_VERSION now just checks if project is initialized
	// Version tracking for .workpilot is removed since it only contains data
	ipcMain.handle(
		IPC_CHANNELS.PROJECT_CHECK_VERSION,
		async (_, projectId: string): Promise<IPCResult<AutoBuildVersionInfo>> => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				return {
					success: true,
					data: {
						isInitialized: isInitialized(project.path),
						updateAvailable: false, // No updates for .workpilot - it's just data
					},
				};
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Check if project has local auto-claude source (is dev project)
	ipcMain.handle(
		"project:has-local-source",
		async (_, projectId: string): Promise<IPCResult<boolean>> => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}
				return { success: true, data: hasLocalSource(project.path) };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// ============================================
	// Git Operations
	// ============================================

	// Get all branches for a project (legacy - returns string[])
	ipcMain.handle(
		IPC_CHANNELS.GIT_GET_BRANCHES,
		async (_, projectPath: string): Promise<IPCResult<string[]>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const branches = getGitBranches(projectPath);
				return { success: true, data: branches };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Get all branches with structured type information (local vs remote)
	ipcMain.handle(
		IPC_CHANNELS.GIT_GET_BRANCHES_WITH_INFO,
		async (_, projectPath: string): Promise<IPCResult<GitBranchDetail[]>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const branches = getGitBranchesWithInfo(projectPath);
				return { success: true, data: branches };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Get current branch for a project
	ipcMain.handle(
		IPC_CHANNELS.GIT_GET_CURRENT_BRANCH,
		async (_, projectPath: string): Promise<IPCResult<string | null>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const branch = getCurrentGitBranch(projectPath);
				return { success: true, data: branch };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Auto-detect main branch for a project
	ipcMain.handle(
		IPC_CHANNELS.GIT_DETECT_MAIN_BRANCH,
		async (_, projectPath: string): Promise<IPCResult<string | null>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const mainBranch = detectMainBranch(projectPath);
				return { success: true, data: mainBranch };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Check git status for a project (is it a repo? has commits?)
	ipcMain.handle(
		IPC_CHANNELS.GIT_CHECK_STATUS,
		async (_, projectPath: string): Promise<IPCResult<GitStatus>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const gitStatus = checkGitStatus(projectPath);
				return { success: true, data: gitStatus };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Detect repository provider from git remote
	ipcMain.handle(
		IPC_CHANNELS.GIT_DETECT_PROVIDER,
		async (
			_,
			projectPath: string,
		): Promise<IPCResult<RepoProviderDetectionResult>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const result = detectRepoProvider(projectPath);
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Initialize git in a project (run git init and create initial commit)
	ipcMain.handle(
		IPC_CHANNELS.GIT_INITIALIZE,
		async (
			_,
			projectPath: string,
			remoteConfig?: { url?: string; name?: string },
		): Promise<IPCResult<InitializationResult>> => {
			try {
				if (!existsSync(projectPath)) {
					return { success: false, error: "Directory does not exist" };
				}
				const result = initializeGit(projectPath, remoteConfig);
				return { success: result.success, data: result, error: result.error };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);
}
