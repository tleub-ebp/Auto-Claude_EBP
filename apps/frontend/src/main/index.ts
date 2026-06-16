// Polyfill CommonJS require for ESM compatibility
// This MUST be at the very top, before any imports that might trigger Sentry's
// require-in-the-middle hooks. Sentry's hooks expect require.cache to exist,
// which is only available in CommonJS. Without this, node-pty native module
// loading fails with "ReferenceError: require is not defined".
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Make require globally available for Sentry's require-in-the-middle hooks
globalThis.require = require;

import {
	accessSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Load .env file FIRST before any other imports that might use process.env
import { config } from "dotenv";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from centralized .env-files directory at project root
// In development: __dirname is out/main (compiled), so go up 4 levels to reach project root
// In production: app resources directory
const possibleEnvPaths = [
	resolve(__dirname, "../../../../.env-files/.env"), // Development: out/main -> root/.env-files/.env
	resolve(__dirname, "../../../.env-files/.env"), // Alternative depth
	resolve(process.cwd(), ".env-files/.env"), // Fallback: from workspace root
];

for (const envPath of possibleEnvPaths) {
	if (existsSync(envPath)) {
		config({ path: envPath, quiet: true });
		break;
	}
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import http from "node:http";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import {
	app,
	BrowserWindow,
	Menu,
	MenuItem,
	nativeImage,
	screen,
	session,
	shell,
} from "electron";
import {
	ADD_TO_DICTIONARY_LABELS,
	DEFAULT_APP_SETTINGS,
	DEFAULT_SPELL_CHECK_LANGUAGE,
	IPC_CHANNELS,
	SPELL_CHECK_LANGUAGE_MAP,
} from "../shared/constants";
import type { AppSettings, AuthFailureInfo } from "../shared/types";
import { AgentManager } from "./agent";
import { getAppLanguage, initAppLanguage } from "./app-language";
import { setupErrorLogging } from "./app-logger";
import { initializeAppUpdater, stopPeriodicUpdates } from "./app-updater";
import { isProfileAuthenticated } from "./claude-profile/profile-utils";
import { getUsageMonitor } from "./claude-profile/usage-monitor";
import {
	getClaudeProfileManager,
	initializeClaudeProfileManager,
} from "./claude-profile-manager";
import { preWarmToolCache } from "./cli-tool-manager";
import { initializeUsageMonitorForwarding } from "./ipc-handlers/terminal-handlers";
import { setupIpcHandlers } from "./ipc-setup";
import {
	isServerMode,
	loadPersistedState,
	restoreSession,
} from "./server-connection";
import { initializeCredentialIntegration } from "./services/credential-integration";
import { ensureOAuthServerRunning } from "./oauth-server";
import { isMacOS, isWindows } from "./platform";
import { pythonEnvManager } from "./python-env-manager";
import { initSentryMain } from "./sentry";
import { readSettingsFile } from "./settings-utils";
import { ptyDaemonClient } from "./terminal/pty-daemon-client";
import { TerminalManager } from "./terminal-manager";

// ─────────────────────────────────────────────────────────────────────────────
// Window sizing constants
// ─────────────────────────────────────────────────────────────────────────────
/** Preferred window width on startup */
const WINDOW_PREFERRED_WIDTH: number = 1400;
/** Preferred window height on startup */
const WINDOW_PREFERRED_HEIGHT: number = 900;
/** Absolute minimum window width (supports high DPI displays with scaling) */
const WINDOW_MIN_WIDTH: number = 800;
/** Absolute minimum window height (supports high DPI displays with scaling) */
const WINDOW_MIN_HEIGHT: number = 500;
/** Margin from screen edges to avoid edge-to-edge windows */
const WINDOW_SCREEN_MARGIN: number = 20;
/** Default screen dimensions used as fallback when screen.getPrimaryDisplay() fails */
const DEFAULT_SCREEN_WIDTH: number = 1920;
const DEFAULT_SCREEN_HEIGHT: number = 1080;

// Setup error logging early (captures uncaught exceptions)
setupErrorLogging();

// Initialize Sentry for error tracking (respects user's sentryEnabled setting)
initSentryMain();

/**
 * Load app settings synchronously (for use during startup).
 * This is a simple merge with defaults - no migrations or auto-detection.
 */
function loadSettingsSync(): AppSettings {
	const savedSettings = readSettingsFile();
	return { ...DEFAULT_APP_SETTINGS, ...savedSettings } as AppSettings;
}

/**
 * Clean up stale update metadata files from the redundant source updater system.
 *
 * The old "source updater" wrote .update-metadata.json files that could persist
 * across app updates and cause version display desync. This cleanup ensures
 * we use the actual bundled version from app.getVersion().
 */
function cleanupStaleUpdateMetadata(): void {
	const userData = app.getPath("userData");
	const stalePaths = [
		join(userData, "auto-claude-source"),
		join(userData, "backend-source"),
	];

	for (const stalePath of stalePaths) {
		if (existsSync(stalePath)) {
			try {
				rmSync(stalePath, { recursive: true, force: true });
				console.warn(`[main] Cleaned up stale update metadata: ${stalePath}`);
			} catch (e) {
				console.warn(
					`[main] Failed to clean up stale metadata at ${stalePath}:`,
					e,
				);
			}
		}
	}
}

// Get icon path based on platform
function getIconPath(): string {
	// In dev mode, __dirname is out/main, so we go up to project root then into resources
	// In production, resources are in the app's resources folder
	const resourcesPath = is.dev
		? join(__dirname, "../../resources")
		: join(process.resourcesPath);

	let iconName: string;
	if (isMacOS()) {
		// Use PNG in dev mode (works better), ICNS in production
		iconName = is.dev ? "icon-256.png" : "icon.icns";
	} else if (isWindows()) {
		iconName = "icon.ico";
	} else {
		iconName = "icon.png";
	}

	const iconPath = join(resourcesPath, iconName);
	return iconPath;
}

// Keep a global reference of the window object to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;
let terminalManager: TerminalManager | null = null;
let backendProcess: ChildProcessWithoutNullStreams | null = null;
let streamingServerProcess: ChildProcessWithoutNullStreams | null = null;

// Re-entrancy guard for before-quit handler.
// The first before-quit call pauses quit for async cleanup, then calls app.quit() again.
// The second call sees isQuitting=true and allows quit to proceed immediately.
// Fixes: pty.node SIGABRT crash caused by environment teardown before PTY cleanup (GitHub #1469)
let isQuitting = false;

function getWorkAreaSize(): { width: number; height: number } {
	try {
		const display = screen.getPrimaryDisplay();
		// Validate the returned object has expected structure with valid dimensions
		if (
			display?.workAreaSize &&
			typeof display.workAreaSize.width === "number" &&
			typeof display.workAreaSize.height === "number" &&
			display.workAreaSize.width > 0 &&
			display.workAreaSize.height > 0
		) {
			return display.workAreaSize;
		} else {
			console.error(
				"[main] screen.getPrimaryDisplay() returned unexpected structure:",
				JSON.stringify(display),
			);
			return { width: DEFAULT_SCREEN_WIDTH, height: DEFAULT_SCREEN_HEIGHT };
		}
	} catch (error: unknown) {
		console.error(
			"[main] Failed to get primary display, using fallback dimensions:",
			error,
		);
		return { width: DEFAULT_SCREEN_WIDTH, height: DEFAULT_SCREEN_HEIGHT };
	}
}

function calculateWindowDimensions(workAreaSize: {
	width: number;
	height: number;
}) {
	// Calculate available space with a small margin to avoid edge-to-edge windows
	const availableWidth: number = workAreaSize.width - WINDOW_SCREEN_MARGIN;
	const availableHeight: number = workAreaSize.height - WINDOW_SCREEN_MARGIN;

	// Calculate actual dimensions (preferred, but capped to margin-adjusted available space)
	const width: number = Math.min(WINDOW_PREFERRED_WIDTH, availableWidth);
	const height: number = Math.min(WINDOW_PREFERRED_HEIGHT, availableHeight);

	// Ensure minimum dimensions don't exceed the actual initial window size
	const minWidth: number = Math.min(WINDOW_MIN_WIDTH, width);
	const minHeight: number = Math.min(WINDOW_MIN_HEIGHT, height);

	return { width, height, minWidth, minHeight };
}

function initializeSpellCheckLanguages(): void {
	// Initialize spell check languages
	const defaultSpellCheckLanguages = Object.keys(SPELL_CHECK_LANGUAGE_MAP);
	const availableSpellCheckLanguages =
		session.defaultSession.availableSpellCheckerLanguages;

	const validSpellCheckLanguages = defaultSpellCheckLanguages.filter((lang) =>
		availableSpellCheckLanguages.includes(lang),
	);

	let initialSpellCheckLanguages: string[];
	if (validSpellCheckLanguages.length > 0) {
		initialSpellCheckLanguages = validSpellCheckLanguages;
	} else {
		initialSpellCheckLanguages = availableSpellCheckLanguages.includes(
			DEFAULT_SPELL_CHECK_LANGUAGE,
		)
			? [DEFAULT_SPELL_CHECK_LANGUAGE]
			: [];
	}

	if (initialSpellCheckLanguages.length > 0) {
		session.defaultSession.setSpellCheckerLanguages(initialSpellCheckLanguages);
	} else {
		console.warn(
			"[SPELLCHECK] No spell check languages available on this system",
		);
	}
}

function setupContextMenu(mainWindow: BrowserWindow): void {
	// Handle context menu with spell check and standard editing options
	mainWindow?.webContents.on(
		"context-menu",
		(_event: Electron.Event, params: Electron.ContextMenuParams) => {
			const menu = new Menu();

			// Add spelling suggestions if there's a misspelled word
			if (params.misspelledWord) {
				for (const suggestion of params.dictionarySuggestions) {
					menu.append(
						new MenuItem({
							label: suggestion,
							click: () =>
								mainWindow?.webContents.replaceMisspelling(suggestion),
						}),
					);
				}

				if (params.dictionarySuggestions.length > 0) {
					menu.append(new MenuItem({ type: "separator" }));
				}

				// Use localized label for "Add to Dictionary" based on app language (not OS locale)
				// getAppLanguage() tracks the user's in-app language setting, updated via SPELLCHECK_SET_LANGUAGES IPC
				const addToDictionaryLabel =
					ADD_TO_DICTIONARY_LABELS[getAppLanguage()] ||
					ADD_TO_DICTIONARY_LABELS.en;
				menu.append(
					new MenuItem({
						label: addToDictionaryLabel,
						click: () =>
							mainWindow?.webContents.session.addWordToSpellCheckerDictionary(
								params.misspelledWord,
							),
					}),
				);

				menu.append(new MenuItem({ type: "separator" }));
			}

			// Standard editing options for editable fields
			// Using role without explicit label allows Electron to provide localized labels
			if (params.isEditable) {
				menu.append(
					new MenuItem({
						role: "cut",
						enabled: params.editFlags.canCut,
					}),
				);
				menu.append(
					new MenuItem({
						role: "copy",
						enabled: params.editFlags.canCopy,
					}),
				);
				menu.append(
					new MenuItem({
						role: "paste",
						enabled: params.editFlags.canPaste,
					}),
				);
				menu.append(
					new MenuItem({
						role: "selectAll",
						enabled: params.editFlags.canSelectAll,
					}),
				);
			} else if (params.selectionText?.trim()) {
				// Non-editable text selection (e.g., labels, paragraphs)
				// Use .trim() to avoid showing menu for whitespace-only selections
				menu.append(
					new MenuItem({
						role: "copy",
						enabled: params.editFlags.canCopy,
					}),
				);
			}

			// Only show menu if there are items
			if (menu.items.length > 0) {
				menu.popup();
			}
		},
	);
}

function setupExternalLinkHandler(mainWindow: BrowserWindow): void {
	// Handle external links with URL scheme allowlist for security
	// Note: Terminal links now use IPC via WebLinksAddon callback, but this handler
	// catches any other window.open() calls (e.g., from third-party libraries)
	const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
	mainWindow?.webContents.setWindowOpenHandler(
		(details: Electron.HandlerDetails) => {
			try {
				const url = new URL(details.url);
				if (!ALLOWED_URL_SCHEMES.has(url.protocol)) {
					console.warn(
						"[main] Blocked URL with disallowed scheme:",
						details.url,
					);
					return { action: "deny" };
				}

				// Open the URL externally and allow the action
				shell.openExternal(details.url).catch((error) => {
					console.warn(
						"[main] Failed to open external URL:",
						details.url,
						error,
					);
				});
				return { action: "allow" };
			} catch {
				console.warn("[main] Blocked invalid URL:", details.url);
				return { action: "deny" };
			}
		},
	);
}

function createWindow(): void {
	// Get the primary display's work area (accounts for taskbar, dock, etc.)
	// Wrapped in try/catch to handle potential failures with fallback to safe defaults
	const workAreaSize = getWorkAreaSize();
	const { width, height, minWidth, minHeight } =
		calculateWindowDimensions(workAreaSize);

	// Create the browser window
	mainWindow = new BrowserWindow({
		width,
		height,
		minWidth,
		minHeight,
		show: false,
		autoHideMenuBar: true,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 15, y: 10 },
		icon: getIconPath(),
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false, // Prevent terminal lag when window loses focus
			spellcheck: true, // Enable spell check for text inputs
			webviewTag: true, // Required for App Emulator preview (bypasses X-Frame-Options)
		},
	});

	// Show window when ready to avoid visual flash
	mainWindow.on("ready-to-show", () => {
		mainWindow?.show();
	});

	// Initialize spell check languages
	initializeSpellCheckLanguages();

	// Setup context menu and external link handlers
	setupContextMenu(mainWindow);
	setupExternalLinkHandler(mainWindow);

	// Load the renderer
	if (mainWindow) {
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
		} else {
			mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
		}
	}

	// Open DevTools in development
	if (is.dev && mainWindow) {
		mainWindow.webContents.openDevTools({ mode: "right" });
	}

	// Clean up on close
	mainWindow.on("closed", () => {
		mainWindow = null;
		globalThis.mainWindow = null;
	});
}

// Set app name before ready (for dock tooltip on macOS in dev mode)
app.setName("WorkPilot AI");
if (isMacOS()) {
	// Force the name to appear in dock on macOS
	app.name = "WorkPilot AI";
}

// Fix Windows GPU cache permission errors (0x5 Access Denied)
if (isWindows()) {
	app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
	app.commandLine.appendSwitch("disable-gpu-program-cache");
}

// Fonction pour attendre que le backend soit prêt
async function waitForBackendReady(url: string, timeoutMs = 10000) {
	const start = Date.now();
	return new Promise<void>((resolve, reject) => {
		function check() {
			http
				.get(url, (res) => {
					if (res.statusCode && res.statusCode < 500) {
						resolve();
					} else {
						retry();
					}
				})
				.on("error", retry);
		}
		function retry() {
			if (Date.now() - start > timeoutMs) {
				reject(new Error("Backend API non disponible après attente."));
			} else {
				setTimeout(check, 400);
			}
		}
		check();
	});
}

// Fonction pour lancer le backend si nécessaire
async function launchBackendIfNeeded() {
	// Mode serveur multi-utilisateurs : le backend tourne sur un serveur
	// distant, on ne spawne rien en local.
	if (isServerMode()) {
		return;
	}
	// Vérifie si le backend répond déjà
	try {
		await waitForBackendReady("http://127.0.0.1:9000/providers", 1500);
		return;
	} catch {
		/* noop */
	}
	// Détermine le chemin Python dynamique via pythonEnvManager
	const backendDir = resolve(__dirname, "../../../backend");
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath || !existsSync(pythonPath)) {
		throw new Error(
			`[main] Python introuvable pour le backend : ${pythonPath || "inconnu"}\nVérifiez que le venv est bien créé et initialisé.`,
		);
	}
	const providerApiModule = "provider_api:app";
	backendProcess = spawn(
		pythonPath,
		[
			"-m",
			"uvicorn",
			providerApiModule,
			"--host",
			"127.0.0.1",
			"--port",
			"9000",
			"--reload",
			// Watch only backend source; the shared virtualenv lives at the repo
			// root, so scoping the watcher to backendDir keeps pip installs (from
			// the PythonEnvManager) from triggering an endless reload storm.
			// NOTE: do not add glob --reload-exclude patterns (e.g. ".venv/*"):
			// the bundled Windows python.exe expands wildcard argv, turning the
			// pattern into extra positional args and making uvicorn exit code 2.
			"--reload-dir",
			backendDir,
			// PythonEnvManager installs into backendDir/.venv, which is INSIDE
			// the watched dir — exclude it or every pip install reload-storms
			// the server. No wildcard => safe from the argv expansion issue
			// above. Must be ABSOLUTE: uvicorn's FileFilter matches exclude
			// dirs against the changed file's (absolute) parents.
			"--reload-exclude",
			resolve(backendDir, ".venv"),
		],
		{
			cwd: backendDir,
			stdio: "pipe",
			detached: false,
			env: { ...process.env, UVICORN_CMD: "1" },
		},
	);
	// Attend qu'il soit prêt
	await waitForBackendReady("http://127.0.0.1:9000/providers", 10000);
}

async function ensureBackendLaunched() {
	if (pythonEnvManager.isEnvReady()) {
		try {
			await launchBackendIfNeeded();
		} catch (err: unknown) {
			const { dialog } = require("electron");
			const errorMessage = err instanceof Error ? err.message : String(err);
			dialog.showErrorBox(
				"Erreur lancement backend LLM",
				"Impossible de démarrer le backend LLM (FastAPI) automatiquement.\n" +
					errorMessage,
			);
		}
	} else {
		pythonEnvManager.once("ready", async () => {
			try {
				await launchBackendIfNeeded();
			} catch (err: unknown) {
				const { dialog } = require("electron");
				const errorMessage = err instanceof Error ? err.message : String(err);
				dialog.showErrorBox(
					"Erreur lancement backend LLM",
					"Impossible de démarrer le backend LLM (FastAPI) automatiquement.\n" +
						errorMessage,
				);
			}
		});
	}
}

// Launch streaming WebSocket server as a background process
async function launchStreamingServer() {
	const backendDir = resolve(__dirname, "../../../backend");
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath || !existsSync(pythonPath)) {
		console.warn("[main] Cannot start streaming server: Python not found");
		return;
	}

	// Check if port 8765 is already in use (server might already be running)
	try {
		const net = await import("node:net");
		const isPortFree = await new Promise<boolean>((resolvePort) => {
			const tester = net
				.createServer()
				.once("error", () => resolvePort(false))
				.once("listening", () => {
					tester.close();
					resolvePort(true);
				})
				.listen(8765, "127.0.0.1");
		});
		if (!isPortFree) {
			return;
		}
	} catch {
		// If port check fails, try to start anyway
	}

	streamingServerProcess = spawn(
		pythonPath,
		["-m", "cli.main", "--streaming-server"],
		{
			cwd: backendDir,
			stdio: "pipe",
			detached: false,
			env: { ...process.env },
		},
	);

	streamingServerProcess.stdout?.on("data", (_data: Buffer) => {
		/* intentionally empty */
	});
	streamingServerProcess.stderr?.on("data", (data: Buffer) => {
		console.warn("[streaming-server]", data.toString().trim());
	});
	streamingServerProcess.on("exit", (code) => {
		console.warn(`[streaming-server] Process exited with code ${code}`);
		streamingServerProcess = null;
	});
}

async function ensureStreamingServerLaunched() {
	if (pythonEnvManager.isEnvReady()) {
		try {
			await launchStreamingServer();
		} catch (err) {
			console.warn("[main] Failed to start streaming server:", err);
		}
	} else {
		pythonEnvManager.once("ready", async () => {
			try {
				await launchStreamingServer();
			} catch (err) {
				console.warn("[main] Failed to start streaming server:", err);
			}
		});
	}
}

// Initialisation explicite du PythonEnvManager avec le chemin du backend (corrigé)
const backendSourcePath = resolve(__dirname, "../../../backend");
try {
	const status = await pythonEnvManager.initialize(backendSourcePath);
	console.warn("[main] PythonEnvManager status:", status);
} catch (err) {
	console.error(
		"[main] Erreur lors de l'initialisation du PythonEnvManager:",
		err,
	);
}

// Clear cache on Windows to prevent permission errors from stale cache
async function clearWindowsCache() {
	if (!isWindows()) {
		return;
	}

	try {
		await session.defaultSession.clearCache();
	} catch (err) {
		console.warn("[main] Failed to clear cache:", err);
	}
}

// Set dock icon on macOS
async function setupMacOSDockIcon() {
	if (!isMacOS()) {
		return;
	}

	const iconPath = getIconPath();
	try {
		const icon = nativeImage.createFromPath(iconPath);
		if (!icon.isEmpty()) {
			app.dock?.setIcon(icon);
		}
	} catch (e) {
		console.warn("Could not set dock icon:", e);
	}
}

// Load and validate settings for agent manager configuration
function loadAndValidateSettings() {
	const settingsPath = join(app.getPath("userData"), "settings.json");

	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		let validAutoBuildPath = settings.autoBuildPath;

		// Validate and migrate autoBuildPath if it exists
		if (validAutoBuildPath) {
			validAutoBuildPath = validateAndMigrateAutoBuildPath(
				validAutoBuildPath,
				settingsPath,
				settings,
			);
		}

		// Configure agent manager if we have valid settings
		if (settings.pythonPath || validAutoBuildPath) {
			console.warn("[main] Configuring AgentManager with settings:", {
				pythonPath: settings.pythonPath,
				autoBuildPath: validAutoBuildPath,
			});
			agentManager?.configure(settings.pythonPath, validAutoBuildPath);
		}
	} catch (error: unknown) {
		// ENOENT means no settings file yet - that's fine, use defaults
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			// No settings file, use defaults - this is expected on first run
		} else {
			console.warn(
				"[main] Failed to load settings for agent configuration:",
				error,
			);
		}
	}
}

// Validate and migrate autoBuildPath - must contain runners/spec_runner.py
function validateAndMigrateAutoBuildPath(
	autoBuildPath: string,
	settingsPath: string,
	settings: Record<string, unknown>,
): string | undefined {
	const specRunnerPath = join(autoBuildPath, "runners", "spec_runner.py");
	let specRunnerExists = false;

	try {
		accessSync(specRunnerPath);
		specRunnerExists = true;
	} catch {
		// File doesn't exist or isn't accessible
	}

	if (specRunnerExists) {
		return autoBuildPath;
	}

	// Migration: Try to fix stale paths from old project structure
	// Old structure: /path/to/project/auto-claude
	// New structure: /path/to/project/apps/backend
	if (
		autoBuildPath.endsWith("/auto-claude") ||
		autoBuildPath.endsWith(String.raw`\auto-claude`)
	) {
		const basePath = autoBuildPath.replace(/[/\\]auto-claude$/, "");
		const correctedPath = join(basePath, "apps", "backend");
		const correctedSpecRunnerPath = join(
			correctedPath,
			"runners",
			"spec_runner.py",
		);

		let correctedPathExists = false;
		try {
			accessSync(correctedSpecRunnerPath);
			correctedPathExists = true;
		} catch {
			// Corrected path doesn't exist
		}

		if (correctedPathExists) {
			settings.autoBuildPath = correctedPath;

			// Save the corrected setting - we're the only process modifying settings at startup
			try {
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
			} catch (writeError) {
				console.warn(
					"[main] Failed to save migrated autoBuildPath:",
					writeError,
				);
			}

			return correctedPath;
		}
	}

	console.warn(
		"[main] Configured autoBuildPath is invalid (missing runners/spec_runner.py), will use auto-detection:",
		autoBuildPath,
	);
	return undefined; // Let auto-detection find the correct path
}

// ... (rest of the code remains the same)

// Initialize profile manager and handle migrated profiles
async function initializeProfileManager() {
	try {
		await initializeClaudeProfileManager();

		// Only start monitoring if window is still available (app not quitting)
		if (mainWindow) {
			// Setup event forwarding from usage monitor to renderer
			initializeUsageMonitorForwarding(mainWindow);

			// Start the usage monitor (uses unified OperationRegistry for proactive restart)
			const usageMonitor = getUsageMonitor();
			usageMonitor.start();
			console.warn(
				"[main] Usage monitor initialized and started (after profile load)",
			);

			// Handle migrated profiles
			handleMigratedProfiles();
		}
	} catch (error) {
		console.warn("[main] Failed to initialize profile manager:", error);
		// Fallback: try starting usage monitor anyway (might use defaults)
		if (mainWindow) {
			initializeUsageMonitorForwarding(mainWindow);
			const usageMonitor = getUsageMonitor();
			usageMonitor.start();
		}
	}
}

// Handle migrated profiles that need re-authentication
function handleMigratedProfiles() {
	const profileManager = getClaudeProfileManager();
	const migratedProfileIds = profileManager.getMigratedProfileIds();
	const activeProfile = profileManager.getActiveProfile();

	if (migratedProfileIds.length === 0) {
		return;
	}

	console.warn(
		"[main] Found migrated profiles that need re-authentication:",
		migratedProfileIds,
	);

	// Check ALL migrated profiles for valid credentials, not just the active one
	// This prevents stale migrated flags from triggering unnecessary re-auth prompts
	// when the user switches to a different profile later
	for (const profileId of migratedProfileIds) {
		const profile = profileManager.getProfile(profileId);
		if (profile && isProfileAuthenticated(profile)) {
			// Credentials are valid - clear the migrated flag
			console.warn(
				"[main] Migrated profile has valid credentials via file fallback, clearing migrated flag:",
				profile.name,
			);
			profileManager.clearMigratedProfile(profileId);
		}
	}

	// Re-check if the active profile still needs re-auth after clearing valid ones
	const remainingMigratedIds = profileManager.getMigratedProfileIds();
	if (mainWindow && remainingMigratedIds.includes(activeProfile.id)) {
		// Active profile still needs re-auth - show the modal
		mainWindow.webContents.once("did-finish-load", () => {
			// Small delay to ensure stores are initialized
			setTimeout(() => {
				const authFailureInfo: AuthFailureInfo = {
					profileId: activeProfile.id,
					profileName: activeProfile.name,
					failureType: "missing",
					message: `Profile "${activeProfile.name}" was migrated to an isolated directory and needs re-authentication.`,
					detectedAt: new Date(),
				};
				console.warn(
					"[main] Sending auth failure for migrated active profile:",
					activeProfile.name,
				);
				mainWindow?.webContents.send(
					IPC_CHANNELS.CLAUDE_AUTH_FAILURE,
					authFailureInfo,
				);
			}, 1000);
		});
	}
}

// Initialize app updater based on environment
function initializeAppUpdaterIfNeeded() {
	if (!mainWindow) {
		return;
	}

	// Log debug mode status
	const isDebugMode = process.env.DEBUG === "true";
	if (isDebugMode) {
		console.warn("[main] ========================================");
		console.warn("[main] DEBUG MODE ENABLED (DEBUG=true)");
		console.warn("[main] ========================================");
	}

	// Initialize app auto-updater (only in production, or when DEBUG_UPDATER is set)
	const forceUpdater = process.env.DEBUG_UPDATER === "true";
	if (app.isPackaged || forceUpdater) {
		// Load settings to get beta updates preference
		const settings = loadSettingsSync();
		const betaUpdates = settings.betaUpdates ?? false;

		initializeAppUpdater(mainWindow, betaUpdates);
		console.warn("[main] App auto-updater initialized");

		const betaUpdatesStatus = betaUpdates ? "enabled" : "disabled";
		console.warn(`[main] Beta updates: ${betaUpdatesStatus}`);
		if (forceUpdater && !app.isPackaged) {
			console.warn("[main] Updater forced in dev mode via DEBUG_UPDATER=true");
			console.warn("[main] Note: Updates won't actually work in dev mode");
		}
	} else {
		console.warn("[main] ========================================");
		console.warn("[main] App auto-updater DISABLED (development mode)");
		console.warn("[main] To test updater logging, set DEBUG_UPDATER=true");
		console.warn("[main] Note: Actual updates only work in packaged builds");
		console.warn("[main] ========================================");
	}
}

// Initialize the application
async function main() {
	await app.whenReady();
	// Set app user model id for Windows
	electronApp.setAppUserModelId("com.workpilotai.app");

	// Clear cache on Windows to prevent permission errors from stale cache
	await clearWindowsCache();

	// Initialize app language from OS locale for main process i18n (context menus)
	initAppLanguage();

	// Clean up stale update metadata from the old source updater system
	// This prevents version display desync after electron-updater installs a new version
	cleanupStaleUpdateMetadata();

	// Set dock icon on macOS
	await setupMacOSDockIcon();

	// Default open or close DevTools by F12 in development
	// and ignore CommandOrControl + R in production.
	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});

	// Multi-user server mode: restore persisted connection (mode, URL,
	// encrypted refresh token) before anything queries the backend.
	loadPersistedState();
	restoreSession().catch((err) =>
		console.warn("[main] Could not restore server session:", err),
	);

	// Initialize agent manager
	agentManager = new AgentManager();

	// Load and validate settings for agent manager configuration
	loadAndValidateSettings();

	// Initialize terminal manager
	terminalManager = new TerminalManager(() => mainWindow);

	// Setup IPC handlers (pass pythonEnvManager for Python path management)
	setupIpcHandlers(
		agentManager,
		terminalManager,
		() => mainWindow,
		pythonEnvManager,
	);

	// Initialize credential integration to load Windsurf usage data from local cache
	initializeCredentialIntegration().catch((error) => {
		console.warn("[main] Failed to initialize credential integration:", error);
	});

	// Create window
	createWindow();

	// Start OAuth server for Copilot authentication
	ensureOAuthServerRunning().catch((error) => {
		console.warn("[main] Failed to start OAuth server:", error);
	});

	// Pre-warm CLI tool cache in background (non-blocking)
	// This ensures CLI detection is done before user needs it
	// Include all commonly used tools to prevent sync blocking on first use
	setImmediate(() => {
		preWarmToolCache(["claude", "git", "gh", "python"]).catch((error) => {
			console.warn("[main] Failed to pre-warm CLI cache:", error);
		});
	});

	// Initialize profile manager and handle migrated profiles
	await initializeProfileManager();

	// Initialize app updater based on environment
	initializeAppUpdaterIfNeeded();

	// macOS: re-create window when dock icon is clicked
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	try {
		await ensureBackendLaunched();
	} catch (err: unknown) {
		const { dialog } = require("electron");
		const errorMessage = err instanceof Error ? err.message : String(err);
		dialog.showErrorBox(
			"Erreur lancement backend LLM",
			"Impossible de démarrer le backend LLM (FastAPI) automatiquement.\n" +
				errorMessage +
				"\nVérifiez que le venv Python et les dépendances sont bien installés.",
		);
		// On continue, mais le frontend affichera une erreur si l'API n'est pas disponible
	}

	// Start streaming WebSocket server for live coding feature
	ensureStreamingServerLaunched().catch((err) => {
		console.warn("[main] Streaming server launch failed (non-critical):", err);
	});
}

// Arrêt propre du backend et du streaming server à la fermeture de l'app
app.on("will-quit", () => {
	if (streamingServerProcess) {
		try {
			streamingServerProcess.kill();
		} catch {
			/* noop */
		}
		streamingServerProcess = null;
	}
	if (backendProcess) {
		try {
			backendProcess.kill();
		} catch {
			/* noop */
		}
		backendProcess = null;
	}
});

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
	if (!isMacOS()) {
		app.quit();
	}
});

// Cleanup before quit — uses event.preventDefault() to allow async PTY cleanup
// before the JS environment tears down. Without this, pty.node's native
// ThreadSafeFunction callbacks fire after teardown, causing SIGABRT (GitHub #1469).
app.on("before-quit", (event) => {
	// Re-entrancy guard: the second app.quit() call (after cleanup) must pass through
	if (isQuitting) {
		return;
	}
	isQuitting = true;

	// Pause quit to perform async cleanup
	event.preventDefault();

	// Stop synchronous services immediately
	stopPeriodicUpdates();

	const usageMonitor = getUsageMonitor();
	usageMonitor.stop();
	console.warn("[main] Usage monitor stopped");

	// Perform async cleanup, then allow quit to proceed
	(async () => {
		try {
			// Kill all running agent processes
			if (agentManager) {
				await agentManager.killAll();
			}

			// Kill all terminal processes — waits for PTY exit with bounded timeout
			if (terminalManager) {
				await terminalManager.killAll();
			}

			// Shut down PTY daemon client AFTER terminal cleanup completes,
			// ensuring all kill commands reach PTY processes before the daemon disconnects
			ptyDaemonClient.shutdown();
			console.warn("[main] PTY daemon client shutdown complete");
		} catch (error) {
			console.error("[main] Error during pre-quit cleanup:", error);
		} finally {
			// Always allow quit to proceed, even if cleanup fails
			app.quit();
		}
	})();
});

// Launch the application.
// Wrapped in a regular function (not top-level await) so that the app.on() event
// handlers above are already registered before main() starts. Using top-level await
// would block handler registration until main() resolves, causing Electron to quit
// if the window closes during startup (before-quit / window-all-closed not yet active).
function startApp(): void {
	main().catch((err) => {
		console.error("[main] Fatal error during app initialization:", err);
	});
}
startApp();

// Note: Uncaught exceptions and unhandled rejections are now
// logged by setupErrorLogging() in app-logger.ts
