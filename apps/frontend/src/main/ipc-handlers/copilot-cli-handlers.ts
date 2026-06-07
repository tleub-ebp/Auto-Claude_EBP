/**
 * Copilot CLI Handlers
 *
 * IPC handlers for GitHub Copilot CLI (gh copilot) version checking, installation, and auth.
 * Mirrors the Claude Code CLI handler pattern but adapted for the gh extension model.
 *
 * Key differences from Claude Code:
 * - Copilot CLI is a GitHub CLI extension (`gh copilot`), not a standalone binary
 * - Installation: `gh copilot install`
 * - Update: `gh copilot update`
 * - Auth: `gh auth login` (OAuth via GitHub CLI)
 * - Version registry: GitHub releases (github/copilot-cli), not npm
 */

import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { DEFAULT_APP_SETTINGS, IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type {
	CopilotCliVersionInfo,
	CopilotInstallationInfo,
	CopilotInstallationList,
} from "../../shared/types/cli";
import {
	clearToolCache,
	configureTools,
	getToolInfo,
	getToolPath,
} from "../cli-tool-manager";
import { getAugmentedEnv } from "../env-utils";
import { isWindows } from "../platform";
import { readSettingsFile, writeSettingsFile } from "../settings-utils";
import { isSecurePath } from "../utils/windows-paths";

const execFileAsync = promisify(execFile);

// Cache for latest copilot version
let cachedLatestCopilotVersion: { version: string; timestamp: number } | null =
	null;
const COPILOT_CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * GitHub API release object structure
 */
interface GitHubRelease {
	tag_name: string;
	prerelease: boolean;
	name?: string;
	html_url?: string;
	published_at?: string;
}

/**
 * Validate a Copilot CLI (gh) path and get copilot extension version
 * @param ghPath - Path to the gh CLI executable
 * @returns Tuple of [isValid, copilotVersion or null, ghVersion or null]
 */
async function validateCopilotCliAsync(
	ghPath: string,
): Promise<[boolean, string | null, string | null]> {
	try {
		if (isWindows() && !isSecurePath(ghPath)) {
			throw new Error(`gh CLI path failed security validation: ${ghPath}`);
		}

		const env = getAugmentedEnv();

		// Get gh version
		let ghVersion: string | null = null;
		try {
			const ghResult = await execFileAsync(ghPath, ["--version"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
				env,
			});
			const ghVersionRegex = /gh version (\d+\.\d+\.\d+)/;
			const ghMatch = ghVersionRegex.exec(ghResult.stdout);
			ghVersion = ghMatch ? ghMatch[1] : null;
		} catch {
			// gh version check failed
		}

		// Get copilot extension version
		const copilotResult = await execFileAsync(
			ghPath,
			["copilot", "--version"],
			{
				encoding: "utf-8",
				timeout: 10000,
				windowsHide: true,
				env,
			},
		);

		const output = copilotResult.stdout.trim();
		const versionRegex = /(\d+\.\d+\.\d+)/;
		const match = versionRegex.exec(output);
		const copilotVersion = match ? match[1] : null;

		return [!!copilotVersion, copilotVersion, ghVersion];
	} catch (error) {
		console.warn(
			"[Copilot CLI] Validation failed:",
			error instanceof Error ? error.message : error,
		);
		return [false, null, null];
	}
}

/**
 * Scan for all gh CLI installations that have the copilot extension
 */
async function scanCopilotInstallations(
	activePath: string | null,
): Promise<CopilotInstallationInfo[]> {
	const installations: CopilotInstallationInfo[] = [];
	const seenPaths = new Set<string>();

	const tryAddInstallation = async (
		ghPath: string,
		source: CopilotInstallationInfo["source"],
	): Promise<void> => {
		const normalizedPath = path.resolve(ghPath);
		if (seenPaths.has(normalizedPath.toLowerCase())) return;
		seenPaths.add(normalizedPath.toLowerCase());

		if (!existsSync(normalizedPath)) return;

		const [isValid, copilotVersion, ghVersion] =
			await validateCopilotCliAsync(normalizedPath);
		// Only add if copilot extension is installed (isValid)
		if (isValid) {
			installations.push({
				path: normalizedPath,
				version: copilotVersion,
				ghVersion,
				source,
				isActive: activePath
					? normalizedPath === path.resolve(activePath)
					: false,
			});
		}
	};

	// 1. User-configured path
	const settings = readSettingsFile();
	if (settings?.copilotPath) {
		await tryAddInstallation(settings.copilotPath as string, "user-config");
	}

	// 2. Currently detected gh path
	try {
		const ghInfo = getToolInfo("gh");
		if (ghInfo.found && ghInfo.path) {
			await tryAddInstallation(ghInfo.path, ghInfo.source);
		}
	} catch {
		// Detection failed
	}

	// 3. Common system paths
	const env = getAugmentedEnv();
	try {
		const whichCmd = isWindows() ? "where" : "which";
		const whichArgs = isWindows() ? ["gh"] : ["-a", "gh"];
		const { stdout } = await execFileAsync(whichCmd, whichArgs, {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
			env,
		});
		const paths = stdout
			.trim()
			.split("\n")
			.map((p) => p.trim())
			.filter(Boolean);
		for (const p of paths) {
			await tryAddInstallation(p, "system-path");
		}
	} catch {
		// which/where failed
	}

	// Mark first as active if none is active
	if (installations.length > 0 && !installations.some((i) => i.isActive)) {
		installations[0].isActive = true;
	}

	return installations;
}

/**
 * Fetch the latest copilot extension version from GitHub API (stable releases only)
 */
async function fetchLatestCopilotVersion(): Promise<string> {
	// Check cache
	if (
		cachedLatestCopilotVersion &&
		Date.now() - cachedLatestCopilotVersion.timestamp <
			COPILOT_CACHE_DURATION_MS
	) {
		return cachedLatestCopilotVersion.version;
	}

	try {
		// Try using gh api if available - get all releases and filter for stable ones
		const ghPath = getToolPath("gh");
		const env = getAugmentedEnv();

		const { stdout } = await execFileAsync(
			ghPath,
			[
				"api",
				"repos/github/copilot-cli/releases",
				"--jq",
				"[.[] | select(.prerelease == false) | .tag_name] | .[0]",
			],
			{
				encoding: "utf-8",
				timeout: 15000,
				windowsHide: true,
				env,
			},
		);

		const version = stdout
			.trim()
			.replace(/^v/, "")
			.replace(/^"/, "")
			.replace(/"$/, "");
		if (version && version !== "null") {
			cachedLatestCopilotVersion = { version, timestamp: Date.now() };
			return version;
		}
	} catch (error) {
		console.warn(
			"[Copilot CLI] Failed to fetch latest stable version via gh api:",
			error instanceof Error ? error.message : error,
		);
	}

	// Fallback: fetch from GitHub API directly - get all releases and filter for stable ones
	try {
		const https = await import("node:https");
		const data = await new Promise<string>((resolve, reject) => {
			const req = https.get(
				"https://api.github.com/repos/github/copilot-cli/releases",
				{
					headers: {
						"User-Agent": "WorkPilot-AI",
						Accept: "application/vnd.github.v3+json",
					},
					timeout: 10000,
				},
				(res) => {
					let body = "";
					res.on("data", (chunk: Buffer | string) => (body += chunk));
					res.on("end", () => resolve(body));
				},
			);
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new Error("Request timed out"));
			});
		});

		const releases = JSON.parse(data);
		// Find the first non-prerelease release
		const stableRelease = releases.find(
			(release: GitHubRelease) => !release.prerelease,
		);
		const version = stableRelease
			? (stableRelease.tag_name || "").replace(/^v/, "")
			: "";

		if (version) {
			cachedLatestCopilotVersion = { version, timestamp: Date.now() };
			return version;
		}
	} catch (error) {
		console.warn(
			"[Copilot CLI] Failed to fetch latest stable version via HTTPS:",
			error instanceof Error ? error.message : error,
		);
	}

	return "unknown";
}

/**
 * Get the install command for Copilot CLI extension
 */
function getCopilotInstallCommand(isUpdate: boolean): string {
	if (isUpdate) {
		return "gh copilot update";
	}
	return "gh copilot install";
}

/**
 * Open a terminal with the given command
 * Simplified version — delegates to the user's default terminal
 */
async function openTerminalWithCommand(command: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			if (isWindows()) {
				const cmdExe = process.env.ComSpec || "cmd.exe";
				spawn(cmdExe, ["/c", "start", "cmd", "/k", command], {
					detached: true,
					stdio: "ignore",
					windowsHide: false,
				}).unref();
			} else {
				// macOS / Linux — try common terminals
				const terminal = process.platform === "darwin" ? "open" : "xterm";
				if (process.platform === "darwin") {
					spawn("open", ["-a", "Terminal.app", "--args", "-e", command], {
						detached: true,
						stdio: "ignore",
					}).unref();
				} else {
					spawn(terminal, ["-e", command], {
						detached: true,
						stdio: "ignore",
					}).unref();
				}
			}
			resolve();
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * Parse username from GitHub CLI auth output
 */
function parseUsernameFromAuthOutput(output: string): string | undefined {
	const usernameRegex = /account\s+(\S+)/;
	const usernameMatch = usernameRegex.exec(output);
	return usernameMatch ? usernameMatch[1] : undefined;
}

/**
 * Check if GitHub CLI is authenticated based on output
 */
function isGitHubAuthenticated(output: string): boolean {
	return output.includes("Logged in") || output.includes("✓");
}

/**
 * Check if Copilot CLI is accessible and working
 */
async function checkCopilotAccessible(
	ghPath: string,
): Promise<boolean> {
	try {
		const env = getAugmentedEnv();
		const { stdout: copilotVersionOutput } = await execFileAsync(
			ghPath,
			["copilot", "--version"],
			{
				encoding: "utf-8",
				timeout: 15000,
				windowsHide: true,
				env,
			},
		);

		const copilotOutput = copilotVersionOutput.trim();
		return copilotOutput.includes("GitHub Copilot CLI");
	} catch (copilotError) {
		console.warn(
			"[Copilot CLI] Copilot command failed:",
			copilotError instanceof Error ? copilotError.message : copilotError,
		);
		return false;
	}
}

/**
 * Check if the gh CLI is authenticated with Copilot
 */
async function checkCopilotAuth(
	ghPath: string,
): Promise<{ authenticated: boolean; username?: string; scopes?: string[] }> {
	const env = getAugmentedEnv();

	// Try to get GitHub CLI auth status
	let fullOutput: string;
	try {
		const { stdout: authStatusOutput, stderr: authStatusStderr } =
			await execFileAsync(ghPath, ["auth", "status"], {
				encoding: "utf-8",
				timeout: 10000,
				windowsHide: true,
				env,
			});

		const authOutput = authStatusOutput.trim();
		const authError = authStatusStderr.trim();
		fullOutput = `${authOutput}\n${authError}`;
	} catch (error) {
		// gh auth status exits with non-zero if not authenticated
		// but stderr may still contain useful info
		const stderr = (error as { stderr?: string }).stderr || "";
		const stdout = (error as { stdout?: string }).stdout || "";
		fullOutput = `${stdout}\n${stderr}`;

		if (stderr.includes("not logged") || stderr.includes("no oauth token")) {
			return { authenticated: false };
		}
		console.warn(
			"[Copilot CLI] Auth check error:",
			error instanceof Error ? error.message : error,
		);
	}

	// Parse username and check GitHub CLI authentication
	const username = parseUsernameFromAuthOutput(fullOutput);
	const isGitHubAuthed = isGitHubAuthenticated(fullOutput);

	if (!isGitHubAuthed || !username) {
		return { authenticated: false };
	}

	// Check if Copilot CLI is accessible
	const isCopilotAccessible = await checkCopilotAccessible(ghPath);

	if (isCopilotAccessible) {
		return {
			authenticated: true,
			username,
		};
	}

	return { authenticated: false, username };
}

/**
 * Register Copilot CLI IPC handlers
 */
export function registerCopilotCliHandlers(): void {
	// Check Copilot CLI version
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_CHECK_VERSION,
		async (): Promise<IPCResult<CopilotCliVersionInfo>> => {
			try {
				console.warn("[Copilot CLI] Checking version...");

				// Get installed version via cli-tool-manager
				// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from assignment
				let detectionResult;
				try {
					detectionResult = getToolInfo("copilot");
					console.warn(
						"[Copilot CLI] Detection result:",
						JSON.stringify(detectionResult, null, 2),
					);
				} catch (detectionError) {
					console.error("[Copilot CLI] Detection error:", detectionError);
					throw new Error(
						`Detection failed: ${detectionError instanceof Error ? detectionError.message : "Unknown error"}`,
					);
				}

				const installed = detectionResult.found
					? detectionResult.version || null
					: null;

				// Get gh version separately
				let ghVersion: string | null = null;
				try {
					const ghInfo = getToolInfo("gh");
					ghVersion = ghInfo.found ? ghInfo.version || null : null;
				} catch {
					// gh detection failed
				}

				// Fetch latest version from GitHub
				let latest: string;
				try {
					latest = await fetchLatestCopilotVersion();
				} catch {
					latest = "unknown";
				}

				// Compare versions
				let isOutdated = false;
				if (installed && latest !== "unknown") {
					try {
						const semver = await import("semver");
						const cleanInstalled = installed.replace(/^v/, "");
						const cleanLatest = latest.replace(/^v/, "");
						isOutdated = semver.default.lt(cleanInstalled, cleanLatest);
					} catch {
						isOutdated = false;
					}
				}

				console.warn("[Copilot CLI] Check complete:", {
					installed,
					ghVersion,
					latest,
					isOutdated,
				});
				return {
					success: true,
					data: {
						installed,
						ghVersion,
						isOutdated,
						path: detectionResult.path,
						detectionResult,
					},
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Check failed:", errorMsg, error);
				return {
					success: false,
					error: `Failed to check Copilot CLI version: ${errorMsg}`,
				};
			}
		},
	);

	// Install Copilot CLI extension (open terminal with install command)
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_INSTALL,
		async (): Promise<IPCResult<{ command: string }>> => {
			try {
				// Check if copilot is already installed to determine install vs upgrade
				let isUpdate = false;
				try {
					const detectionResult = getToolInfo("copilot");
					isUpdate = detectionResult.found && !!detectionResult.version;
				} catch {
					isUpdate = false;
				}

				const command = getCopilotInstallCommand(isUpdate);
				console.warn("[Copilot CLI] Install command:", command);
				await openTerminalWithCommand(command);

				return {
					success: true,
					data: { command },
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Install failed:", errorMsg, error);
				return {
					success: false,
					error: `Failed to open terminal for installation: ${errorMsg}`,
				};
			}
		},
	);

	// Silent install/update of Copilot CLI extension — runs `gh copilot install`
	// or `gh copilot update` in the background without opening a terminal.
	// Requires the gh CLI to be installed and authenticated.
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_INSTALL_SILENT,
		async (): Promise<IPCResult<{ stdout: string; stderr: string }>> => {
			try {
				const ghInfo = getToolInfo("gh");
				if (!ghInfo.found || !ghInfo.path) {
					return {
						success: false,
						error:
							"gh_missing: GitHub CLI (gh) is required to install or update Copilot.",
					};
				}

				let isUpdate = false;
				try {
					const detectionResult = getToolInfo("copilot");
					isUpdate = detectionResult.found && !!detectionResult.version;
				} catch {
					isUpdate = false;
				}

				const subCommand = isUpdate ? "update" : "install";
				console.warn(
					`[Copilot CLI] Starting silent gh copilot ${subCommand}`,
				);

				const env = getAugmentedEnv();
				// Lock the narrowing of ghInfo.path inside the closure below.
				const ghPath = ghInfo.path;

				// Spawn `gh copilot <subCommand>` once and capture the result.
				// Pulled into a closure so we can retry the call without
				// duplicating the spawn / timeout boilerplate.
				type SpawnResult = {
					code: number | null;
					stdout: string;
					stderr: string;
				};
				const runOnce = (): Promise<SpawnResult> => {
					// Cast explicitly: the `{shell, windowsHide, env}` combo
					// matches several spawn() overloads and TS reduces the
					// intersection to `never`, hiding the .on / .stdout API
					// we use below. With shell:false the actual return type
					// is ChildProcessWithoutNullStreams.
					const child = spawn(ghPath, ["copilot", subCommand], {
						shell: false,
						windowsHide: true,
						env: { ...env, CI: "1" },
					}) as ChildProcessWithoutNullStreams;

					let stdout = "";
					let stderr = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						stdout += chunk.toString("utf-8");
					});
					child.stderr?.on("data", (chunk: Buffer) => {
						stderr += chunk.toString("utf-8");
					});

					return new Promise<SpawnResult>((resolve, reject) => {
						const timeout = setTimeout(
							() => {
								child.kill("SIGKILL");
								reject(
									new Error(
										`gh copilot ${subCommand} timed out after 5 minutes`,
									),
								);
							},
							5 * 60 * 1000,
						);
						child.on("error", (err: Error) => {
							clearTimeout(timeout);
							reject(err);
						});
						child.on("close", (code: number | null) => {
							clearTimeout(timeout);
							resolve({ code, stdout, stderr });
						});
					});
				};

				// Windows-specific: gh copilot's package extractor sometimes hits
				// EPERM on `rename` when another copilot.exe process (or AV
				// scanner) still holds a handle on a file under ~/.copilot/pkg/.
				// The lock is usually transient — give the OS a moment and
				// retry once. If it sticks, we surface a translatable sentinel
				// so the renderer can show actionable guidance.
				const MAX_RETRIES = 2;
				const RETRY_DELAY_MS = 1500;
				const isLockedPkgError = (msg: string): boolean => {
					const m = msg.toLowerCase();
					return (
						m.includes("eperm") &&
						m.includes("rename") &&
						m.includes(".copilot")
					);
				};

				let result: { code: number | null; stdout: string; stderr: string } = {
					code: null,
					stdout: "",
					stderr: "",
				};
				for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
					result = await runOnce();
					if (result.code === 0) break;

					const combined = `${result.stderr}\n${result.stdout}`;
					if (!isLockedPkgError(combined) || attempt === MAX_RETRIES) break;

					console.warn(
						`[Copilot CLI] EPERM/rename on ~/.copilot/pkg — likely a ` +
							`running copilot.exe holds a lock. Retrying in ${RETRY_DELAY_MS}ms ` +
							`(attempt ${attempt + 1}/${MAX_RETRIES})`,
					);
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				}

				cachedLatestCopilotVersion = null;
				// Invalidate the cli-tool-manager cache so the next getToolInfo
				// re-detects the freshly-installed copilot extension version.
				clearToolCache();

				if (result.code !== 0) {
					const combined = `${result.stderr}\n${result.stdout}`;
					if (isLockedPkgError(combined)) {
						// Sentinel prefix: the renderer matches `copilot_pkg_locked:`
						// and shows a translated, actionable toast instead of the
						// raw stack trace from gh.
						return {
							success: false,
							error:
								"copilot_pkg_locked: A running Copilot CLI process is " +
								"holding files in ~/.copilot/pkg/ open. Close any open " +
								"Copilot terminals / sessions and try again. If the " +
								"problem persists, restart WorkPilot to release the locks.",
						};
					}
					return {
						success: false,
						error: `gh copilot ${subCommand} exited with code ${result.code}: ${
							(result.stderr || result.stdout).trim().slice(0, 500) ||
							"unknown error"
						}`,
					};
				}

				return {
					success: true,
					data: { stdout: result.stdout, stderr: result.stderr },
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Silent install failed:", errorMsg, error);
				return { success: false, error: errorMsg };
			}
		},
	);

	// Get all Copilot CLI installations found on the system
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_GET_INSTALLATIONS,
		async (): Promise<IPCResult<CopilotInstallationList>> => {
			try {
				const settings = readSettingsFile();
				const activePath = settings?.copilotPath as string | undefined;

				const installations = await scanCopilotInstallations(
					activePath || null,
				);

				return {
					success: true,
					data: {
						installations,
						activePath:
							activePath ||
							(installations.length > 0 ? installations[0].path : null),
					},
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error(
					"[Copilot CLI] Failed to scan installations:",
					errorMsg,
					error,
				);
				return {
					success: false,
					error: `Failed to scan Copilot CLI installations: ${errorMsg}`,
				};
			}
		},
	);

	// Set the active Copilot CLI (gh) path
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_SET_ACTIVE_PATH,
		async (_event, cliPath: string): Promise<IPCResult<{ path: string }>> => {
			try {
				if (!isSecurePath(cliPath)) {
					throw new Error(
						"Invalid path: contains potentially unsafe characters",
					);
				}

				const normalizedPath = path.resolve(cliPath);

				if (!existsSync(normalizedPath)) {
					throw new Error("gh CLI not found at specified path");
				}

				const [isValid] = await validateCopilotCliAsync(normalizedPath);
				if (!isValid) {
					throw new Error(
						"gh CLI at specified path does not have copilot extension or is not valid",
					);
				}

				// Save to settings
				const currentSettings = readSettingsFile() || {};
				const mergedSettings = {
					...DEFAULT_APP_SETTINGS,
					...currentSettings,
					copilotPath: normalizedPath,
				} as Record<string, unknown>;
				writeSettingsFile(mergedSettings);

				// Update CLI tool manager cache
				configureTools({ copilotPath: normalizedPath });

				return {
					success: true,
					data: { path: normalizedPath },
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error(
					"[Copilot CLI] Failed to set active path:",
					errorMsg,
					error,
				);
				return {
					success: false,
					error: `Failed to set active Copilot CLI path: ${errorMsg}`,
				};
			}
		},
	);

	// Check Copilot CLI authentication status
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_CHECK_AUTH,
		async (): Promise<
			IPCResult<{ authenticated: boolean; username?: string }>
		> => {
			try {
				const ghPath = getToolPath("gh");
				const result = await checkCopilotAuth(ghPath);

				return {
					success: true,
					data: result,
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Auth check failed:", errorMsg, error);
				return {
					success: false,
					error: `Failed to check Copilot CLI auth: ${errorMsg}`,
				};
			}
		},
	);

	// Start Copilot CLI authentication (open terminal with gh auth login)
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_START_AUTH,
		async (): Promise<IPCResult<{ command: string }>> => {
			try {
				const command = "gh auth login";
				console.warn("[Copilot CLI] Starting auth:", command);
				await openTerminalWithCommand(command);

				return {
					success: true,
					data: { command },
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Start auth failed:", errorMsg, error);
				return {
					success: false,
					error: `Failed to start Copilot CLI authentication: ${errorMsg}`,
				};
			}
		},
	);

	// Get GitHub CLI status for AuthStatusIndicator
	ipcMain.handle(
		IPC_CHANNELS.COPILOT_CLI_GET_STATUS,
		async (): Promise<
			IPCResult<{ available: boolean; isAuth?: boolean; username?: string }>
		> => {
			try {
				const ghPath = getToolPath("gh");
				if (!ghPath) {
					return {
						success: true,
						data: { available: false },
					};
				}

				const result = await checkCopilotAuth(ghPath);

				return {
					success: true,
					data: {
						available: true,
						isAuth: result.authenticated,
						username: result.username,
					},
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[Copilot CLI] Status check failed:", errorMsg, error);
				return {
					success: true, // Return success with available: false instead of error
					data: { available: false },
				};
			}
		},
	);

	console.warn("[IPC] Copilot CLI handlers registered");
}
