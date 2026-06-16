/**
 * Application Logger Service
 *
 * Provides persistent, always-on logging for the main process using electron-log.
 * Logs are stored in the standard OS log directory:
 * - macOS: ~/Library/Logs/WorkPilot AI/
 * - Windows: %USERPROFILE%\AppData\Roaming\WorkPilot AI\logs\
 * - Linux: ~/.config/WorkPilot AI/logs/
 *
 * Features:
 * - Automatic file rotation (7 days, max 10MB per file)
 * - Always-on logging (not dependent on DEBUG flag)
 * - Debug info collection for support/bug reports
 * - Beta version detection for enhanced logging
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { app } from "electron";
import log from "electron-log/main.js";
import { PROVIDER_MODELS_MAP } from "../shared/constants/models";
// Import the colored logs utility
import { frontendLog } from "./colored-logs";
// Import settings utilities for model info
import { readSettingsFile } from "./settings-utils";

// Configure electron-log (wrapped in try-catch for re-import scenarios in tests)
try {
	log.initialize();
} catch {
	// Already initialized, ignore
}

// File transport configuration
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB max file size
log.transports.file.fileName = "main.log";

// Console transport désactivé : la sortie console colorée est entièrement gérée
// par `frontendLog` (voir `appLog` plus bas). Laisser le transport console
// d'electron-log actif provoquait une DOUBLE écriture de chaque message dans la
// console (une ligne `[FRONTEND] [DEBUG] ...` via frontendLog + une ligne
// `[hh:mm:ss] [debug] ...` via electron-log). On conserve uniquement le
// transport fichier pour la persistance des logs.
log.transports.console.level = false;

/**
 * Get current LLM model and provider information for logging
 */
function getCurrentModelInfo(): {
	model: string;
	provider: string;
	modelLabel: string;
} {
	try {
		// Try to get settings first
		const settings = readSettingsFile();

		if (settings?.selectedProvider && settings.defaultModel) {
			const provider = settings.selectedProvider as string;
			const modelId = settings.defaultModel as string;

			// Try to get model label from PROVIDER_MODELS_MAP
			const providerModels = PROVIDER_MODELS_MAP[provider];
			let modelLabel = modelId;

			if (providerModels) {
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const modelInfo = providerModels.find((m: any) => m.value === modelId);
				if (modelInfo) {
					modelLabel = modelInfo.label;
				}
			}

			return {
				model: modelId,
				provider,
				modelLabel,
			};
		}

		// Ultimate fallback - simplified without profile manager
		return {
			model: "unknown",
			provider: "unknown",
			modelLabel: "unknown",
		};
	} catch (_error) {
		return {
			model: "error",
			provider: "error",
			modelLabel: "error",
		};
	}
}

/**
 * Get model/provider info as a formatted string for logging
 * Export this function so other modules can use it
 */
export function getModelInfoString(): string {
	const modelInfo = getCurrentModelInfo();
	return `[${modelInfo.provider}:${modelInfo.modelLabel}]`;
}

/**
 * Enhanced logging function that includes model/provider info
 * Export this for other modules to use
 */
export function logWithModelInfo(
	level: "debug" | "info" | "warn" | "error",
	...args: unknown[]
): void {
	const modelInfoString = getModelInfoString();
	const modifiedArgs = [modelInfoString, ...args];

	switch (level) {
		case "debug":
			log.debug(...modifiedArgs);
			break;
		case "info":
			log.info(...modifiedArgs);
			break;
		case "warn":
			log.warn(...modifiedArgs);
			break;
		case "error":
			log.error(...modifiedArgs);
			break;
	}
}

// Determine if this is a beta version
function isBetaVersion(): boolean {
	try {
		const version = app.getVersion();
		return (
			version.includes("-beta") ||
			version.includes("-alpha") ||
			version.includes("-rc")
		);
	} catch (error) {
		log.warn("Failed to detect beta version:", error);
		return false;
	}
}

// Enhanced logging for beta versions
if (isBetaVersion()) {
	log.transports.file.level = "debug";
	log.info("Beta version detected - enhanced logging enabled");
} else {
	log.transports.file.level = "info";
}

/**
 * Get system information for debug reports
 */
export function getSystemInfo(): Record<string, string> {
	return {
		appVersion: app.getVersion(),
		electronVersion: process.versions.electron,
		nodeVersion: process.versions.node,
		chromeVersion: process.versions.chrome,
		platform: process.platform,
		arch: process.arch,
		osVersion: os.release(),
		osType: os.type(),
		totalMemory: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
		freeMemory: `${Math.round(os.freemem() / (1024 * 1024 * 1024))}GB`,
		cpuCores: os.cpus().length.toString(),
		locale: app.getLocale(),
		isPackaged: app.isPackaged.toString(),
		userData: app.getPath("userData"),
	};
}

/**
 * Get the logs directory path
 */
export function getLogsPath(): string {
	try {
		const filePath = log.transports.file.getFile().path;
		if (!filePath) {
			log.warn("Log file path is not available");
			return "";
		}
		return dirname(filePath);
	} catch (error) {
		log.error("Failed to get logs path:", error);
		return "";
	}
}

/**
 * Get recent log entries from the current log file
 */
export function getRecentLogs(maxLines: number = 200): string[] {
	try {
		const logPath = log.transports.file.getFile().path;
		if (!existsSync(logPath)) {
			return [];
		}

		const content = readFileSync(logPath, "utf-8");
		const lines = content.split("\n").filter((line) => line.trim());
		return lines.slice(-maxLines);
	} catch (error) {
		log.error("Failed to read recent logs:", error);
		return [];
	}
}

/**
 * Get recent errors from logs
 */
export function getRecentErrors(maxCount: number = 20): string[] {
	const logs = getRecentLogs(1000);
	// Use case-insensitive matching for log levels and error types
	const errors = logs.filter(
		(line) =>
			/\[(error|warn)\]/i.test(line) ||
			/Error:|TypeError:|ReferenceError:|RangeError:|SyntaxError:/i.test(line),
	);
	return errors.slice(-maxCount);
}

/**
 * Generate a debug info report for bug reports
 */
export function generateDebugReport(): string {
	const systemInfo = getSystemInfo();
	const recentErrors = getRecentErrors(10);

	const lines = [
		"=== WorkPilot AI Debug Report ===",
		`Generated: ${new Date().toISOString()}`,
		"",
		"--- System Information ---",
		...Object.entries(systemInfo).map(([key, value]) => `${key}: ${value}`),
		"",
		"--- Recent Errors ---",
		recentErrors.length > 0 ? recentErrors.join("\n") : "No recent errors",
		"",
		"=== End Debug Report ===",
	];

	return lines.join("\n");
}

/**
 * List all log files with their metadata
 */
export function listLogFiles(): Array<{
	name: string;
	path: string;
	size: number;
	modified: Date;
}> {
	try {
		const logsDir = getLogsPath();
		if (!logsDir || !existsSync(logsDir)) {
			log.debug("Logs directory not available or does not exist");
			return [];
		}

		const files = readdirSync(logsDir)
			.filter((f) => f.endsWith(".log"))
			.map((name) => {
				const filePath = join(logsDir, name);
				try {
					// Wrap statSync in try-catch to handle TOCTOU race condition
					// (file could be deleted between readdirSync and statSync)
					const stats = statSync(filePath);
					return {
						name,
						path: filePath,
						size: stats.size,
						modified: stats.mtime,
					};
				} catch (statError) {
					log.warn(`Could not stat log file ${filePath}:`, statError);
					return null;
				}
			})
			.filter(
				(
					entry,
				): entry is {
					name: string;
					path: string;
					size: number;
					modified: Date;
				} => entry !== null,
			)
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());

		return files;
	} catch (error) {
		log.error("Failed to list log files:", error);
		return [];
	}
}

// Re-export the logger for use in other modules
export const logger = log;

// Export convenience methods that match console API with frontend coloration and model/provider info
export const appLog = {
	debug: (message: string, ...args: unknown[]) => {
		// Use frontendLog for colored output (now includes model info automatically)
		frontendLog.debug(message, ...args);
		// Also log to file with model info
		const modelInfoString = getModelInfoString();
		const modifiedArgs = [modelInfoString, message, ...args];
		log.debug(...modifiedArgs);
	},
	info: (message: string, ...args: unknown[]) => {
		frontendLog.info(message, ...args);
		const modelInfoString = getModelInfoString();
		const modifiedArgs = [modelInfoString, message, ...args];
		log.info(...modifiedArgs);
	},
	warn: (message: string, ...args: unknown[]) => {
		frontendLog.warn(message, ...args);
		const modelInfoString = getModelInfoString();
		const modifiedArgs = [modelInfoString, message, ...args];
		log.warn(...modifiedArgs);
	},
	error: (message: string, ...args: unknown[]) => {
		frontendLog.error(message, ...args);
		const modelInfoString = getModelInfoString();
		const modifiedArgs = [modelInfoString, message, ...args];
		log.error(...modifiedArgs);
	},
	log: (message: string, ...args: unknown[]) => {
		frontendLog.info(message, ...args);
		const modelInfoString = getModelInfoString();
		const modifiedArgs = [modelInfoString, message, ...args];
		log.info(...modifiedArgs);
	},
};

// Log unhandled errors
export function setupErrorLogging(): void {
	process.on("uncaughtException", (error) => {
		log.error("Uncaught exception:", error);
	});

	process.on("unhandledRejection", (reason) => {
		log.error("Unhandled rejection:", reason);
	});

	log.info("Error logging initialized");
}
