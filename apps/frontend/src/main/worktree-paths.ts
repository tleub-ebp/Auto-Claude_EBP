/**
 * Shared worktree path utilities
 *
 * Centralizes all worktree path constants and helper functions to avoid duplication
 * and ensure consistent path handling across the application.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

// Path constants for worktree directories
export const TASK_WORKTREE_DIR = ".workpilot/worktrees/tasks";
export const TERMINAL_WORKTREE_DIR = ".workpilot/worktrees/terminal";

// Metadata directories (separate from git worktrees to avoid uncommitted files)
export const TERMINAL_WORKTREE_METADATA_DIR = ".workpilot/terminal/metadata";

// Legacy path for backwards compatibility
export const LEGACY_WORKTREE_DIR = ".worktrees";

/**
 * Get the task worktrees directory path
 */
export function getTaskWorktreeDir(projectPath: string): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTaskWorktreeDir: projectPath is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TASK_WORKTREE_DIR);
}

/**
 * Get the full path for a specific task worktree
 */
export function getTaskWorktreePath(
	projectPath: string,
	specId: string,
): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTaskWorktreePath: projectPath is undefined or not a string",
		);
		return "";
	}
	if (!specId || typeof specId !== "string") {
		console.error(
			"[worktree-paths] getTaskWorktreePath: specId is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TASK_WORKTREE_DIR, specId);
}

/**
 * Validate that a resolved path is within the expected base directory
 * Protects against path traversal attacks (e.g., specId containing "..")
 */
export function isPathWithinBase(
	resolvedPath: string,
	basePath: string,
): boolean {
	const normalizedPath = path.resolve(resolvedPath);
	const normalizedBase = path.resolve(basePath);
	return (
		normalizedPath.startsWith(normalizedBase + path.sep) ||
		normalizedPath === normalizedBase
	);
}

/**
 * Transliterate an accented/Unicode spec id to its ASCII-only equivalent.
 *
 * Pourquoi : le backend assainit le nom du worktree en ASCII (décomposition
 * NFKD, suppression des diacritiques — « é » -> « e ») pour respecter la
 * whitelist stricte des refs git. Le dossier du worktree sur disque est donc
 * ASCII (ex. « 002-…-numero-… ») alors que le specId peut conserver ses accents
 * (« 002-…-numéro-… »). Sans cette équivalence, `findTaskWorktree` ne retrouve
 * pas le worktree et le panneau de logs reste vide pendant un build isolé.
 *
 * Reproduit la logique de `WorktreeManager._sanitize_spec_name` côté Python :
 * NFKD, on retire les marques combinantes puis tout codepoint non-ASCII.
 */
export function sanitizeSpecNameToAscii(specId: string): string {
	return specId
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: on conserve l'ASCII imprimable et de contrôle, on retire le reste
		.replace(/[^\x00-\x7f]/g, "");
}

/**
 * Find a task worktree path, checking new location first then legacy
 * Returns the path if found, null otherwise
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTaskWorktree(
	projectPath: string,
	specId: string,
): string | null {
	// Defensive check for undefined inputs
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] findTaskWorktree: projectPath is undefined or not a string",
		);
		return null;
	}
	if (!specId || typeof specId !== "string") {
		console.error(
			"[worktree-paths] findTaskWorktree: specId is undefined or not a string",
		);
		return null;
	}

	const normalizedProject = path.resolve(projectPath);

	// Try the specId as-is first, then its ASCII-sanitized form. The backend
	// names the worktree folder using the ASCII transliteration, so an accented
	// specId only matches via the sanitized candidate.
	const candidates = [specId];
	const asciiSpecId = sanitizeSpecNameToAscii(specId);
	if (asciiSpecId && asciiSpecId !== specId) {
		candidates.push(asciiSpecId);
	}

	for (const candidate of candidates) {
		// Check new path first
		const resolvedNewPath = path.resolve(
			path.join(projectPath, TASK_WORKTREE_DIR, candidate),
		);
		if (!isPathWithinBase(resolvedNewPath, normalizedProject)) {
			console.error(
				`[worktree-paths] Path traversal detected: specId "${candidate}" resolves outside project`,
			);
			return null;
		}
		if (existsSync(resolvedNewPath)) return resolvedNewPath;

		// Legacy fallback
		const resolvedLegacyPath = path.resolve(
			path.join(projectPath, LEGACY_WORKTREE_DIR, candidate),
		);
		if (!isPathWithinBase(resolvedLegacyPath, normalizedProject)) {
			console.error(
				`[worktree-paths] Path traversal detected: specId "${candidate}" resolves outside project (legacy)`,
			);
			return null;
		}
		if (existsSync(resolvedLegacyPath)) return resolvedLegacyPath;
	}

	return null;
}

/**
 * Get the terminal worktrees directory path
 */
export function getTerminalWorktreeDir(projectPath: string): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreeDir: projectPath is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TERMINAL_WORKTREE_DIR);
}

/**
 * Get the full path for a specific terminal worktree
 */
export function getTerminalWorktreePath(
	projectPath: string,
	name: string,
): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreePath: projectPath is undefined or not a string",
		);
		return "";
	}
	if (!name || typeof name !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreePath: name is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TERMINAL_WORKTREE_DIR, name);
}

/**
 * Find a terminal worktree path, checking new location first then legacy
 * Returns the path if found, null otherwise
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTerminalWorktree(
	projectPath: string,
	name: string,
): string | null {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] findTerminalWorktree: projectPath is undefined or not a string",
		);
		return null;
	}
	if (!name || typeof name !== "string") {
		console.error(
			"[worktree-paths] findTerminalWorktree: name is undefined or not a string",
		);
		return null;
	}

	const normalizedProject = path.resolve(projectPath);

	// Check new path first
	const newPath = path.join(projectPath, TERMINAL_WORKTREE_DIR, name);
	const resolvedNewPath = path.resolve(newPath);

	// Validate path stays within project (defense against path traversal)
	if (!isPathWithinBase(resolvedNewPath, normalizedProject)) {
		console.error(
			`[worktree-paths] Path traversal detected: name "${name}" resolves outside project`,
		);
		return null;
	}

	if (existsSync(resolvedNewPath)) return resolvedNewPath;

	// Legacy fallback (terminal worktrees used terminal-{name} prefix)
	const legacyPath = path.join(
		projectPath,
		LEGACY_WORKTREE_DIR,
		`terminal-${name}`,
	);
	const resolvedLegacyPath = path.resolve(legacyPath);

	// Validate legacy path as well
	if (!isPathWithinBase(resolvedLegacyPath, normalizedProject)) {
		console.error(
			`[worktree-paths] Path traversal detected: name "${name}" resolves outside project (legacy)`,
		);
		return null;
	}

	if (existsSync(resolvedLegacyPath)) return resolvedLegacyPath;

	return null;
}

/**
 * Get the terminal worktree metadata directory path
 * This is separate from the git worktree to avoid uncommitted files
 */
export function getTerminalWorktreeMetadataDir(projectPath: string): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreeMetadataDir: projectPath is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TERMINAL_WORKTREE_METADATA_DIR);
}

/**
 * Get the metadata file path for a specific terminal worktree
 */
export function getTerminalWorktreeMetadataPath(
	projectPath: string,
	name: string,
): string {
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreeMetadataPath: projectPath is undefined or not a string",
		);
		return "";
	}
	if (!name || typeof name !== "string") {
		console.error(
			"[worktree-paths] getTerminalWorktreeMetadataPath: name is undefined or not a string",
		);
		return "";
	}
	return path.join(projectPath, TERMINAL_WORKTREE_METADATA_DIR, `${name}.json`);
}
