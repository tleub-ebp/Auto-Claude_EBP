import { execFile, execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getToolPath, getToolPathAsync } from "./cli-tool-manager";

const execFileAsync = promisify(execFile);

// Bounded so a hung git subprocess (antivirus scanning git.exe on first launch,
// an index lock, a slow fsmonitor, …) can never block indefinitely.
const GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG =
	process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

function debug(message: string, data?: Record<string, unknown>): void {
	if (DEBUG) {
		if (data) {
			console.warn(
				`[ProjectInitializer] ${message}`,
				JSON.stringify(data, null, 2),
			);
		} else {
			console.warn(`[ProjectInitializer] ${message}`);
		}
	}
}

/**
 * Git status information for a project
 */
export interface GitStatus {
	isGitRepo: boolean;
	hasCommits: boolean;
	currentBranch: string | null;
	error?: string;
}

/**
 * Check if a directory is a git repository and has at least one commit
 */
export function checkGitStatus(projectPath: string): GitStatus {
	const git = getToolPath("git");

	try {
		// Check if it's a git repository
		execFileSync(git, ["rev-parse", "--git-dir"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return {
			isGitRepo: false,
			hasCommits: false,
			currentBranch: null,
			error: 'Not a git repository. Please run "git init" to initialize git.',
		};
	}

	// Check if there are any commits
	let hasCommits = false;
	try {
		execFileSync(git, ["rev-parse", "HEAD"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		hasCommits = true;
	} catch {
		// No commits yet
		hasCommits = false;
	}

	// Get current branch
	let currentBranch: string | null = null;
	try {
		currentBranch = execFileSync(git, ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		// Branch detection failed
	}

	if (!hasCommits) {
		return {
			isGitRepo: true,
			hasCommits: false,
			currentBranch,
			error:
				"Git repository has no commits. Please make an initial commit first.",
		};
	}

	return {
		isGitRepo: true,
		hasCommits: true,
		currentBranch,
	};
}

/**
 * Async, non-blocking equivalent of {@link checkGitStatus}.
 *
 * Use this from the Electron main process (e.g. IPC handlers). The synchronous
 * version spawns `git.exe` several times via execFileSync; on Windows the first
 * cold spawn after boot gets scanned by antivirus and blocks the main-process
 * event loop for seconds, intermittently freezing launch ("Ne répond pas") since
 * the project auto-detection calls this right after the board loads.
 */
export async function checkGitStatusAsync(
	projectPath: string,
): Promise<GitStatus> {
	// Async detection so even resolving the git path never spawns a subprocess
	// (git --version) on the main-process event loop.
	const git = await getToolPathAsync("git");
	const opts = {
		cwd: projectPath,
		encoding: "utf-8" as const,
		timeout: GIT_STATUS_TIMEOUT_MS,
	};

	try {
		// Check if it's a git repository
		await execFileAsync(git, ["rev-parse", "--git-dir"], opts);
	} catch {
		return {
			isGitRepo: false,
			hasCommits: false,
			currentBranch: null,
			error: 'Not a git repository. Please run "git init" to initialize git.',
		};
	}

	// Check if there are any commits
	let hasCommits = false;
	try {
		await execFileAsync(git, ["rev-parse", "HEAD"], opts);
		hasCommits = true;
	} catch {
		// No commits yet
		hasCommits = false;
	}

	// Get current branch
	let currentBranch: string | null = null;
	try {
		const { stdout } = await execFileAsync(
			git,
			["rev-parse", "--abbrev-ref", "HEAD"],
			opts,
		);
		currentBranch = stdout.trim();
	} catch {
		// Branch detection failed
	}

	if (!hasCommits) {
		return {
			isGitRepo: true,
			hasCommits: false,
			currentBranch,
			error:
				"Git repository has no commits. Please make an initial commit first.",
		};
	}

	return {
		isGitRepo: true,
		hasCommits: true,
		currentBranch,
	};
}

/**
 * Initialize git in a project directory and create an initial commit.
 * This is a user-friendly way to set up git for non-technical users.
 */
export function initializeGit(
	projectPath: string,
	remoteConfig?: { url?: string; name?: string },
): InitializationResult {
	debug("initializeGit called", { projectPath, remoteConfig });

	// Check current git status
	const status = checkGitStatus(projectPath);
	const git = getToolPath("git");

	try {
		// Step 1: Initialize git if needed
		if (!status.isGitRepo) {
			debug("Initializing git repository");
			execFileSync(git, ["init"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		}

		// Step 2: Check if there are files to commit
		const statusOutput = execFileSync(git, ["status", "--porcelain"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// Step 3: If there are untracked/modified files, add and commit them
		if (statusOutput || !status.hasCommits) {
			debug("Adding files and creating initial commit");

			// Add all files
			execFileSync(git, ["add", "-A"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Create initial commit
			execFileSync(git, ["commit", "-m", "Initial commit", "--allow-empty"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		}

		debug("Git initialization complete");
		if (remoteConfig?.url) {
			try {
				const remoteName = remoteConfig.name || "origin";

				// Check if remote already exists
				try {
					const existingRemote = execFileSync(
						git,
						["remote", "get-url", remoteName],
						{
							cwd: projectPath,
							encoding: "utf-8",
							stdio: "pipe",
						},
					).trim();

					// Update if different
					if (existingRemote !== remoteConfig.url) {
						execFileSync(
							git,
							["remote", "set-url", remoteName, remoteConfig.url],
							{
								cwd: projectPath,
								encoding: "utf-8",
								stdio: "pipe",
							},
						);
					} else {
						// noop
					}
				} catch (_error) {
					execFileSync(git, ["remote", "add", remoteName, remoteConfig.url], {
						cwd: projectPath,
						encoding: "utf-8",
						stdio: "pipe",
					});
				}

				// Configure default branch tracking
				try {
					const _currentBranch = execFileSync(
						git,
						["branch", "--show-current"],
						{
							cwd: projectPath,
							encoding: "utf-8",
							stdio: "pipe",
						},
					).trim();

					// Try to set up tracking for main/master branches
					const mainBranches = ["main", "master"];
					for (const branch of mainBranches) {
						try {
							execFileSync(
								git,
								["branch", `--set-upstream-to=${remoteName}/${branch}`, branch],
								{
									cwd: projectPath,
									encoding: "utf-8",
									stdio: "pipe",
								},
							);
							break;
						} catch {
							// noop
						}
					}
				} catch (_error) {
					// Don't fail the operation, just log it
				}
			} catch (_remoteError) {
				// Don't fail the git initialization, but log the issue
			}
		} else {
			// noop
		}

		return { success: true };
	} catch (error) {
		debug("Git initialization failed:", { error: (error as Error).message });
		return {
			success: false,
			error: (error as Error).message,
		};
	}
}

/**
 * Entries to add to .gitignore when initializing a project
 */
const GITIGNORE_ENTRIES = [
	".workpilot/",
	".claude_settings.json",
	".workpilot-security.json",
	".workpilot-status",
	"build_output.txt",
];

/**
 * Ensure entries exist in the project's .gitignore file.
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignoreEntries(projectPath: string, entries: string[]): void {
	const gitignorePath = path.join(projectPath, ".gitignore");

	// Read existing content atomically (no TOCTOU)
	let content = "";
	let fileExists = false;
	try {
		content = readFileSync(gitignorePath, "utf-8");
		fileExists = true;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		// File doesn't exist - content stays empty
	}

	const existingLines = content
		? content.split("\n").map((line) => line.trim())
		: [];

	// Find entries that need to be added
	const entriesToAdd: string[] = [];
	for (const entry of entries) {
		const entryNormalized = entry.replace(/\/$/, ""); // Remove trailing slash for comparison
		const alreadyExists = existingLines.some((line) => {
			const lineNormalized = line.replace(/\/$/, "");
			return lineNormalized === entry || lineNormalized === entryNormalized;
		});

		if (!alreadyExists) {
			entriesToAdd.push(entry);
		}
	}

	if (entriesToAdd.length === 0) {
		debug("All gitignore entries already exist");
		return;
	}

	if (fileExists) {
		// Build the content to append
		let appendContent = "";

		// Ensure file ends with newline before adding our entries
		if (content && !content.endsWith("\n")) {
			appendContent += "\n";
		}

		appendContent += "\n# WorkPilot AI local files\n";
		for (const entry of entriesToAdd) {
			appendContent += `${entry}\n`;
		}

		appendFileSync(gitignorePath, appendContent);
	} else {
		writeFileSync(
			gitignorePath,
			`# WorkPilot AI local files\n${entriesToAdd.join("\n")}\n`,
			"utf-8",
		);
	}

	debug("Added entries to .gitignore", { entries: entriesToAdd });
}

/**
 * Data directories created in .workpilot for each project
 */
const DATA_DIRECTORIES = ["specs", "ideation", "insights", "roadmap"];

/**
 * Result of initialization operation
 */
export interface InitializationResult {
	success: boolean;
	error?: string;
}

/**
 * Check if the project has a local backend source directory
 * This indicates it's the development project itself
 */
export function hasLocalSource(projectPath: string): boolean {
	const localSourcePath = path.join(projectPath, "apps", "backend");
	// Use runners/spec_runner.py as marker - ensures valid backend
	const markerFile = path.join(localSourcePath, "runners", "spec_runner.py");
	return existsSync(localSourcePath) && existsSync(markerFile);
}

/**
 * Get the local source path for a project (if it exists)
 */
export function getLocalSourcePath(projectPath: string): string | null {
	const localSourcePath = path.join(projectPath, "apps", "backend");
	if (hasLocalSource(projectPath)) {
		return localSourcePath;
	}
	return null;
}

/**
 * Check if project is initialized (has .workpilot directory)
 */
export function isInitialized(projectPath: string): boolean {
	const dotAutoBuildPath = path.join(projectPath, ".workpilot");
	return existsSync(dotAutoBuildPath);
}

/**
 * Initialize auto-claude data directory in a project.
 *
 * Creates .workpilot/ with data directories (specs, ideation, insights, roadmap).
 * The framework code runs from the source repo - only data is stored here.
 *
 * Requires:
 * - Project directory must exist
 * - Project must be a git repository with at least one commit
 */
export function initializeProject(projectPath: string): InitializationResult {
	debug("initializeProject called", { projectPath });

	// Validate project path exists
	if (!existsSync(projectPath)) {
		debug("Project path does not exist", { projectPath });
		return {
			success: false,
			error: `Project directory not found: ${projectPath}`,
		};
	}

	// Check git status - WorkPilot AI requires git for worktree-based builds
	const gitStatus = checkGitStatus(projectPath);
	if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
		debug("Git check failed", { gitStatus });
		return {
			success: false,
			error:
				gitStatus.error ||
				"Git repository required. WorkPilot AI uses git worktrees for isolated builds.",
		};
	}

	// Check if already initialized
	const dotAutoBuildPath = path.join(projectPath, ".workpilot");

	if (existsSync(dotAutoBuildPath)) {
		debug("Already initialized - .workpilot exists");
		return {
			success: false,
			error: "Project already has auto-claude initialized (.workpilot exists)",
		};
	}

	try {
		debug("Creating .workpilot data directory", { dotAutoBuildPath });

		// Create the .workpilot directory
		mkdirSync(dotAutoBuildPath, { recursive: true });

		// Create data directories
		for (const dataDir of DATA_DIRECTORIES) {
			const dirPath = path.join(dotAutoBuildPath, dataDir);
			debug("Creating data directory", { dataDir, dirPath });
			mkdirSync(dirPath, { recursive: true });
			writeFileSync(path.join(dirPath, ".gitkeep"), "", "utf-8");
		}

		// Update .gitignore to exclude .workpilot/
		ensureGitignoreEntries(projectPath, GITIGNORE_ENTRIES);

		debug("Initialization complete");
		return { success: true };
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: "Unknown error during initialization";
		debug("Initialization failed", { error: errorMessage });
		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Ensure all data directories exist in .workpilot.
 * Useful if new directories are added in future versions.
 */
export function ensureDataDirectories(
	projectPath: string,
): InitializationResult {
	const dotAutoBuildPath = path.join(projectPath, ".workpilot");

	if (!existsSync(dotAutoBuildPath)) {
		return {
			success: false,
			error: "Project not initialized. Run initialize first.",
		};
	}

	try {
		for (const dataDir of DATA_DIRECTORIES) {
			const dirPath = path.join(dotAutoBuildPath, dataDir);
			if (!existsSync(dirPath)) {
				debug("Creating missing data directory", { dataDir, dirPath });
				mkdirSync(dirPath, { recursive: true });
				writeFileSync(path.join(dirPath, ".gitkeep"), "", "utf-8");
			}
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Get the auto-claude folder path for a project.
 *
 * IMPORTANT: Only .workpilot/ is considered a valid "installed" auto-claude.
 * The auto-claude/ folder (if it exists) is the SOURCE CODE being developed,
 * not an installation. This allows WorkPilot AI to be used to develop itself.
 */
export function getAutoBuildPath(projectPath: string): string | null {
	const dotAutoBuildPath = path.join(projectPath, ".workpilot");

	debug("getAutoBuildPath called", { projectPath, dotAutoBuildPath });

	if (existsSync(dotAutoBuildPath)) {
		debug("Returning .workpilot (installed version)");
		return ".workpilot";
	}

	debug("No .workpilot folder found - project not initialized");
	return null;
}
