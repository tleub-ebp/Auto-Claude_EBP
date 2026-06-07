/**
 * IPC Handlers for Credential Manager
 *
 * Fournit une interface IPC entre le frontend et le CredentialManager
 */

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { app, ipcMain } from "electron";
import path from "node:path";

const execFileAsync = promisify(execFile);

import type {
	CredentialConfig,
	UsageData,
} from "../services/credential-manager";
import {
	credentialManager,
	detectWindsurfLocalToken,
	readWindsurfCachedPlanInfo,
} from "../services/credential-manager";

/**
 * Extract version from command output using regex
 */
function extractVersionFromOutput(output: string): string | undefined {
	const versionRegex = /(\d+\.\d+\.\d+)/;
	const match = versionRegex.exec(output.trim());
	return match ? match[1] : undefined;
}

/**
 * Try to get codex version using direct execution
 */
async function tryDirectCodexVersion(): Promise<string | undefined> {
	try {
		const result = await execFileAsync("codex", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		return extractVersionFromOutput(result.stdout);
	} catch {
		return undefined;
	}
}

/**
 * Try to get codex version using shell execution
 */
async function tryShellCodexVersion(): Promise<string | undefined> {
	try {
		const result = await execFileAsync("codex", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
			shell: true,
		});
		return extractVersionFromOutput(result.stdout);
	} catch {
		return undefined;
	}
}

/**
 * Try to get codex version from a specific .cmd file on Windows.
 */
async function tryWindowsCmdCodexVersion(
	codexCmd: string,
): Promise<string | undefined> {
	try {
		const { existsSync } = await import("node:fs");
		if (!existsSync(codexCmd)) return undefined;

		const cmdExe =
			process.env.ComSpec || String.raw`C:\Windows\System32\cmd.exe`;
		const result = await execFileAsync(
			cmdExe,
			["/d", "/s", "/c", `""${codexCmd}" --version"`],
			{
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			},
		);
		return extractVersionFromOutput(result.stdout);
	} catch {
		return undefined;
	}
}

/**
 * Get codex CLI version using multiple fallback strategies.
 * Checks both npm and pnpm global paths on Windows and picks the highest
 * version found, so we always show the most up-to-date installation.
 */
async function getCodexVersion(): Promise<string | undefined> {
	const os = await import("node:os");
	const home = os.homedir();

	// Windows: check known global install paths (npm + pnpm)
	if (process.platform === "win32") {
		const candidates = [
			path.join(home, "AppData", "Roaming", "npm", "codex.cmd"),
			path.join(home, "AppData", "Local", "pnpm", "codex.CMD"),
		];

		const versions = await Promise.all(
			candidates.map((p) => tryWindowsCmdCodexVersion(p)),
		);

		// Pick the highest version found
		let best: string | undefined;
		for (const v of versions) {
			if (v && (!best || isCodexOutdated(best, v))) {
				best = v;
			}
		}
		if (best) return best;
	}

	// Fallback: shell execution (resolves via PATH + shell)
	const version = await tryShellCodexVersion();
	if (version) return version;

	// Fallback: direct exec
	return await tryDirectCodexVersion();
}

/**
 * Cache for the latest @openai/codex version from the npm registry (1 hour TTL).
 */
let cachedCodexLatest: { version: string; timestamp: number } | null = null;
const CODEX_LATEST_CACHE_MS = 60 * 60 * 1000;

async function fetchLatestCodexVersion(): Promise<string | undefined> {
	if (
		cachedCodexLatest &&
		Date.now() - cachedCodexLatest.timestamp < CODEX_LATEST_CACHE_MS
	) {
		return cachedCodexLatest.version;
	}

	try {
		const response = await fetch(
			"https://registry.npmjs.org/@openai/codex/latest",
			{
				headers: {
					Accept: "application/json",
					"User-Agent": "WorkPilot-AI/1.0",
				},
				signal: AbortSignal.timeout(15000),
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
		const data = (await response.json()) as { version?: unknown };
		if (typeof data.version !== "string") {
			throw new TypeError("Invalid version format from npm registry");
		}
		cachedCodexLatest = { version: data.version, timestamp: Date.now() };
		return data.version;
	} catch (error) {
		console.warn("[Codex CLI] Failed to fetch latest version from npm:", error);
		return cachedCodexLatest?.version;
	}
}

/**
 * Spawn a command, drain its streams, and resolve on exit. 5-minute timeout.
 */
function runShellCommand(
	cmd: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";
		const child = spawn(cmd, args, {
			shell: isWindows,
			windowsHide: true,
			env: { ...process.env, CI: "1" },
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		const timeout = setTimeout(
			() => {
				child.kill("SIGKILL");
				reject(new Error(`${cmd} timed out after 5 minutes`));
			},
			5 * 60 * 1000,
		);

		child.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolve({ code, stdout, stderr });
			} else {
				reject(
					new Error(
						`${cmd} exited with code ${code}: ${stderr || stdout}`,
					),
				);
			}
		});
	});
}

/**
 * Update @openai/codex via pnpm global install.
 * Using pnpm as the primary package manager for consistency.
 */
async function runCodexUpdate(): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	const results: string[] = [];

	// Always run pnpm install -g @latest to force latest version
	const pnpmResult = await runShellCommand("pnpm", [
		"install",
		"-g",
		"@openai/codex@latest",
	]);
	results.push(`[pnpm] ${pnpmResult.stdout.trim()}`);

	return { code: 0, stdout: results.join("\n"), stderr: "" };
}

/**
 * Compare two semver-like version strings. Returns true if `installed` < `latest`.
 */
function isCodexOutdated(installed: string, latest: string): boolean {
	const parse = (v: string): number[] =>
		v
			.replace(/^v/, "")
			.split(/[.-]/)
			.slice(0, 3)
			.map((n) => {
				const parsed = Number.parseInt(n, 10);
				return Number.isNaN(parsed) ? 0 : parsed;
			});

	try {
		const i = parse(installed);
		const l = parse(latest);
		for (let idx = 0; idx < 3; idx++) {
			const a = i[idx] ?? 0;
			const b = l[idx] ?? 0;
			if (a < b) return true;
			if (a > b) return false;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Enregistrer tous les handlers IPC pour les credentials
 */
export function registerCredentialHandlers(): void {
	/**
	 * Obtenir le credential actif
	 */
	ipcMain.handle("credential:getActive", (): CredentialConfig | null => {
		return credentialManager.getActiveCredential();
	});

	/**
	 * Définir le provider actif
	 */
	ipcMain.handle(
		"credential:setActive",
		async (
			_event,
			provider: string,
			type: "oauth" | "api_key",
			profileId?: string,
		): Promise<void> => {
			await credentialManager.setActiveProvider(provider, type, profileId);
		},
	);

	/**
	 * Obtenir les données d'usage pour un provider
	 * For windsurf: use API as primary source (contains real-time usage data)
	 * Local cache is only used as fallback if API is unavailable
	 */
	ipcMain.handle(
		"usage:getData",
		async (_event, provider: string): Promise<UsageData | null> => {
			const cached = credentialManager.getUsageData(provider);

			// For windsurf: prefer API (real-time usage data) over local cache (may contain stale/incorrect data)
			// The local cache contains data from the old monthly system which may not reflect actual usage
			if (provider === "windsurf") {
				// Try API first for real-time usage data
				try {
					const apiData = await credentialManager.fetchWindsurfUsage();
					if (apiData) {
						return apiData;
					}
				} catch (error) {
					console.warn("[credential-handlers] Windsurf API fetch failed, using cached data:", error);
				}
				// Fallback to cached data only if API fails
				return cached ?? null;
			}

			return cached ?? null;
		},
	);

	/**
	 * Obtenir toutes les données d'usage
	 */
	ipcMain.handle("usage:getAllData", (): Record<string, UsageData> => {
		const allData = credentialManager.getAllUsageData();
		// Convertir Map en objet pour la sérialisation JSON
		return Object.fromEntries(allData.entries());
	});

	/**
	 * Mettre à jour les données d'usage (appelé par les services d'usage)
	 */
	ipcMain.handle(
		"usage:updateData",
		(_event, provider: string, usageData: Partial<UsageData>): void => {
			credentialManager.updateUsageData(provider, usageData);
		},
	);

	/**
	 * Valider les credentials actifs
	 */
	ipcMain.handle("credential:validate", async (): Promise<boolean> => {
		return await credentialManager.validateActiveCredentials();
	});

	/**
	 * Tester un provider (incluant les cas spéciaux)
	 */
	ipcMain.handle(
		"credential:testProvider",
		async (
			_event,
			provider: string,
		): Promise<{ success: boolean; message: string; details?: unknown }> => {
			return await credentialManager.testProvider(provider);
		},
	);

	// NOTE: `credential:getEnv` IPC handler removed (was dead code).
	// Exposing plaintext API keys via IPC is dangerous because any renderer
	// context — including a contextBridge slip-up or a future devtools
	// extension — could read all configured provider keys. Main-process
	// code should call `credentialManager.getEnvironmentVariables()`
	// directly when building Python subprocess envs.

	/**
	 * S'abonner aux événements de credentials
	 */
	ipcMain.on("credential:subscribe", (event) => {
		const channel = "credential:updated";

		const onUpdate = (credential: CredentialConfig | null) => {
			event.sender.send(channel, credential);
		};

		credentialManager.on("credential:updated", onUpdate);

		// Nettoyage quand la fenêtre est fermée
		event.sender.on("destroyed", () => {
			credentialManager.off("credential:updated", onUpdate);
		});
	});

	/**
	 * S'abonner aux événements d'usage
	 */
	ipcMain.on("usage:subscribe", (event) => {
		const channel = "usage:changed";

		const onUpdate = (data: UsageData) => {
			event.sender.send(channel, data);
		};

		credentialManager.on("usage:changed", onUpdate);

		// Nettoyage quand la fenêtre est fermée
		event.sender.on("destroyed", () => {
			credentialManager.off("usage:changed", onUpdate);
		});
	});

	/**
	 * S'abonner aux événements de switch de provider
	 */
	ipcMain.on("provider:subscribe", (event) => {
		const channel = "provider:switched";

		const onSwitch = (data: {
			provider: string;
			type: "oauth" | "api_key";
		}) => {
			event.sender.send(channel, data);
		};

		credentialManager.on("provider:switched", onSwitch);

		// Nettoyage quand la fenêtre est fermée
		event.sender.on("destroyed", () => {
			credentialManager.off("provider:switched", onSwitch);
		});
	});

	/**
	 * Détecter le token Windsurf depuis l'installation IDE locale
	 * Lit le state.vscdb de Windsurf pour extraire la clé API sk-ws-...
	 * Enrichit la réponse avec les infos du plan (planName, usage) si disponibles.
	 */
	ipcMain.handle(
		"credential:detectWindsurfToken",
		async (): Promise<{
			success: boolean;
			apiKey?: string;
			userName?: string;
			planName?: string;
			usageInfo?: {
				usedMessages: number;
				totalMessages: number;
				usedFlowActions: number;
				totalFlowActions: number;
			};
			error?: string;
		}> => {
			const tokenResult = await detectWindsurfLocalToken();
			if (!tokenResult.success) return tokenResult;

			// Enrich with plan info (planName, usage) from cached plan data
			try {
				const planResult = await readWindsurfCachedPlanInfo();
				if (planResult.success && planResult.planInfo) {
					return {
						...tokenResult,
						userName: planResult.userName || tokenResult.userName,
						planName: planResult.planInfo.planName,
						usageInfo: {
							usedMessages: planResult.planInfo.usage.usedMessages,
							totalMessages: planResult.planInfo.usage.messages,
							usedFlowActions: planResult.planInfo.usage.usedFlowActions,
							totalFlowActions: planResult.planInfo.usage.flowActions,
						},
					};
				}
			} catch (e) {
				console.warn(
					"[CredentialHandlers] Failed to enrich Windsurf token with plan info:",
					e,
				);
			}

			return tokenResult;
		},
	);

	/**
	 * Vérifier le statut OAuth Claude (vérifie les fichiers config CLI sur le disque)
	 * Retourne si l'utilisateur est authentifié via OAuth Claude Code
	 */
	ipcMain.handle(
		"credential:checkClaudeOAuth",
		async (): Promise<{ isAuthenticated: boolean; profileName?: string }> => {
			return await credentialManager.checkClaudeOAuthStatusPublic();
		},
	);

	/**
	 * Vérifier le statut OAuth OpenAI Codex CLI (vérifie les fichiers config CLI sur le disque)
	 * Retourne si l'utilisateur est authentifié via OpenAI Codex CLI, avec la version CLI
	 */
	ipcMain.handle(
		"credential:checkOpenAICodexOAuth",
		async (): Promise<{
			isAuthenticated: boolean;
			profileName?: string;
			version?: string;
			latest?: string;
			isOutdated?: boolean;
		}> => {
			const authStatus =
				await credentialManager.checkOpenAICodexOAuthStatusPublic();

			const version = await getCodexVersion();
			const latest = version ? await fetchLatestCodexVersion() : undefined;
			const isOutdated =
				version && latest ? isCodexOutdated(version, latest) : false;

			return { ...authStatus, version, latest, isOutdated };
		},
	);

	/**
	 * Installer ou mettre à jour Codex CLI via pnpm global, en arrière-plan.
	 * Pas de terminal visible : on exécute directement `pnpm install -g @openai/codex@latest`.
	 */
	ipcMain.handle(
		"credential:updateCodexCli",
		async (): Promise<{
			success: boolean;
			version?: string;
			latest?: string;
			isOutdated?: boolean;
			error?: string;
		}> => {
			try {
				console.warn(
					"[Codex CLI] Starting pnpm install -g @openai/codex@latest",
				);
				console.warn("[Codex CLI] PATH:", process.env.PATH);
				const result = await runCodexUpdate();
				console.warn("[Codex CLI] pnpm install completed:", {
					code: result.code,
					stdout: result.stdout.slice(-500),
					stderr: result.stderr.slice(-500),
				});

				// Invalidate caches so the next check sees the fresh version.
				cachedCodexLatest = null;
				const version = await getCodexVersion();
				const latest = await fetchLatestCodexVersion();
				const isOutdated =
					version && latest ? isCodexOutdated(version, latest) : false;

				console.warn("[Codex CLI] Post-install version check:", {
					version,
					latest,
					isOutdated,
				});

				return { success: true, version, latest, isOutdated };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				console.error("[Codex CLI] Update failed:", message);
				return { success: false, error: message };
			}
		},
	);

	/**
	 * Charger les providers configurés depuis config/configured_providers.json
	 * Ce fichier est maintenant à la racine du projet dans le dossier config/
	 */
	ipcMain.handle(
		"providers:getConfiguredProviders",
		async (): Promise<{ providers?: unknown } | null> => {
			try {
				const appPath = app.getAppPath();
				const cwd = process.cwd();
				const candidates = [
					// Dev mode: process.cwd() is typically apps/frontend
					path.join(cwd, "..", "..", "config", "configured_providers.json"),
					path.join(cwd, "..", "config", "configured_providers.json"),
					path.join(cwd, "config", "configured_providers.json"),
					// app.getAppPath()-based (works in various electron-vite configurations)
					path.join(appPath, "..", "..", "..", "config", "configured_providers.json"),
					path.join(appPath, "..", "..", "config", "configured_providers.json"),
					path.join(appPath, "..", "config", "configured_providers.json"),
					path.join(appPath, "config", "configured_providers.json"),
					// Fallback: src dir
					path.join(appPath, "src", "config", "configured_providers.json"),
				];

				for (const p of candidates) {
					try {
						await fs.access(p);
						const raw = await fs.readFile(p, "utf-8");
						return JSON.parse(raw);
					} catch {
						// try next candidate
					}
				}
				return null;
			} catch (error) {
				console.error(
					"[CredentialHandlers] Failed to load configured_providers.json:",
					error,
				);
				return null;
			}
		},
	);
}
