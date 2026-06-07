import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { FileNode, IPCResult } from "../../shared/types";

// Maximum file size to read (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Validates and normalizes a file path for safe reading.
 * Returns the normalized path if valid, or an error message.
 *
 * NOTE: the previous `segments.includes("..")` check was a no-op because
 * `path.resolve` normalizes `..` segments AWAY before the check ran. We
 * now reject the RAW input if it contains `..` and additionally reject
 * traversal into well-known sensitive directories. This is best-effort —
 * proper containment requires a workspace root, which is not threaded
 * through these handlers; the caller-side filepicker is the primary
 * gate.
 */
function validatePath(
	filePath: string,
): { valid: true; path: string } | { valid: false; error: string } {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return { valid: false, error: "Path must be a non-empty string" };
	}

	// Reject NUL bytes — they truncate paths in some C-level APIs.
	if (filePath.includes("\0")) {
		return { valid: false, error: "Path contains NUL byte" };
	}

	// Reject `..` segments in the RAW input. After path.resolve they're
	// gone, so checking the resolved path was useless.
	const rawSegments = filePath.split(/[\\/]+/);
	if (rawSegments.includes("..")) {
		return {
			valid: false,
			error: "Invalid path: contains parent directory references",
		};
	}

	// Resolve to absolute path
	const resolvedPath = path.resolve(filePath);

	if (!path.isAbsolute(resolvedPath)) {
		return { valid: false, error: "Path must be absolute" };
	}

	// Refuse paths into obviously sensitive locations. Not exhaustive —
	// real protection lives at the OS permission boundary — but blocks
	// the most embarrassing trivial reads via this handler.
	const homeDir = os.homedir();
	const blockedSubpaths = [
		path.join(homeDir, ".ssh"),
		path.join(homeDir, ".aws"),
		path.join(homeDir, ".gnupg"),
		path.join(homeDir, ".config", "gh"),
		path.join(homeDir, ".docker"),
	];
	const lowerResolved = resolvedPath.toLowerCase();
	for (const blocked of blockedSubpaths) {
		if (lowerResolved.startsWith(blocked.toLowerCase())) {
			return { valid: false, error: "Access to credential directory denied" };
		}
	}

	return { valid: true, path: resolvedPath };
}

/**
 * Sanitize a filename to a single path component (no directory traversal).
 * Rejects anything containing `/`, `\`, `..`, or NUL — these would let a
 * caller break out of the directory passed to FILE_EXPLORER_SAVE.
 */
function validateFileName(
	fileName: string,
): { valid: true; name: string } | { valid: false; error: string } {
	if (typeof fileName !== "string" || fileName.length === 0) {
		return { valid: false, error: "Filename must be a non-empty string" };
	}
	if (
		fileName.includes("/") ||
		fileName.includes("\\") ||
		fileName.includes("\0") ||
		fileName === "." ||
		fileName === ".." ||
		fileName.includes("..")
	) {
		return { valid: false, error: "Filename contains invalid characters" };
	}
	if (fileName.length > 255) {
		return { valid: false, error: "Filename too long" };
	}
	return { valid: true, name: fileName };
}

// Directories to ignore when listing
const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"__pycache__",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".cache",
	".venv",
	"venv",
	"out",
	".turbo",
	".worktrees",
	"vendor",
	"target",
	".gradle",
	".maven",
]);

/**
 * Register all file-related IPC handlers
 */
export function registerFileHandlers(): void {
	// ============================================
	// File Explorer Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.FILE_EXPLORER_LIST,
		async (_, dirPath: string): Promise<IPCResult<FileNode[]>> => {
			try {
				// Validate and normalize path to prevent directory traversal
				const validation = validatePath(dirPath);
				if (!validation.valid) {
					return { success: false, error: validation.error };
				}
				const entries = readdirSync(validation.path, { withFileTypes: true });

				// Filter and map entries
				const nodes: FileNode[] = [];
				for (const entry of entries) {
					// Skip hidden files (not directories) except useful ones like .env, .gitignore
					if (
						!entry.isDirectory() &&
						entry.name.startsWith(".") &&
						![".env", ".gitignore", ".env.example", ".env.local"].includes(
							entry.name,
						)
					) {
						continue;
					}
					// Skip ignored directories
					if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

					nodes.push({
						path: path.join(validation.path, entry.name),
						name: entry.name,
						isDirectory: entry.isDirectory(),
					});
				}

				// Sort: directories first, then alphabetically
				nodes.sort((a, b) => {
					if (a.isDirectory && !b.isDirectory) return -1;
					if (!a.isDirectory && b.isDirectory) return 1;
					return a.name.localeCompare(b.name, undefined, {
						sensitivity: "base",
					});
				});

				return { success: true, data: nodes };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to list directory",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.FILE_EXPLORER_READ,
		async (_, filePath: string): Promise<IPCResult<string>> => {
			try {
				// Validate and normalize path
				const validation = validatePath(filePath);
				if (!validation.valid) {
					return { success: false, error: validation.error };
				}
				const safePath = validation.path;

				// Check file size before reading
				const stats = statSync(safePath);
				if (stats.size > MAX_FILE_SIZE) {
					return { success: false, error: "File too large (max 1MB)" };
				}

				// Use async file read to avoid blocking
				const content = await readFile(safePath, "utf-8");
				return { success: true, data: content };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Failed to read file",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.FILE_EXPLORER_SAVE,
		async (
			_,
			dirPath: string,
			fileName: string,
			data: unknown,
		): Promise<IPCResult<boolean>> => {
			try {
				// Validate the directory.
				const dirValidation = validatePath(dirPath);
				if (!dirValidation.valid) {
					return { success: false, error: dirValidation.error };
				}
				// Validate the filename SEPARATELY — `path.join` does NOT block
				// traversal, so a fileName like `../../etc/cron.d/evil` would
				// have escaped the validated directory and written arbitrary
				// host files. validateFileName rejects any path separator.
				const nameValidation = validateFileName(fileName);
				if (!nameValidation.valid) {
					return { success: false, error: nameValidation.error };
				}
				const safeFile = path.join(dirValidation.path, nameValidation.name);
				// Write JSON file
				const fs = await import("node:fs/promises");
				await fs.writeFile(safeFile, JSON.stringify(data, null, 2), "utf-8");
				return { success: true, data: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Failed to save file",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.FILE_EXPLORER_GET_USER_HOME,
		async (): Promise<string> => os.homedir(),
	);
}
