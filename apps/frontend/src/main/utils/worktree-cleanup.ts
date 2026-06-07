/**
 * Worktree Cleanup Utility
 *
 * Provides a robust, cross-platform worktree cleanup implementation that handles
 * Windows-specific issues with git worktree deletion when untracked files exist.
 *
 * The standard `git worktree remove --force` fails on Windows when the worktree
 * contains untracked files (node_modules, build artifacts, etc.). This utility:
 *
 * 1. Auto-commits any uncommitted work (preserves in git history for ~90 days via reflog)
 * 2. Manually deletes the worktree directory with retry logic for Windows file locks
 * 3. Prunes git's internal worktree references
 * 4. Optionally deletes the associated branch
 *
 * Related issue: https://github.com/AndyMik90/Auto-Claude/issues/1539
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { getToolPath } from "../cli-tool-manager";
import { getTaskWorktreeDir, isPathWithinBase } from "../worktree-paths";
import { getIsolatedGitEnv } from "./git-isolation";

/**
 * Options for worktree cleanup operation
 */
export interface WorktreeCleanupOptions {
	/** Absolute path to the worktree directory to delete */
	worktreePath: string;
	/** Absolute path to the main project directory (for git operations) */
	projectPath: string;
	/** Spec ID for generating branch name (e.g., "001-my-feature") */
	specId: string;
	/** Custom commit message for auto-commit (default: "Auto-save before deletion") */
	commitMessage?: string;
	/** Log prefix for console messages (e.g., "[TASK_DELETE]") */
	logPrefix?: string;
	/** Whether to delete the associated branch (default: true) */
	deleteBranch?: boolean;
	/**
	 * URL de la PR associée à fermer en même temps que le worktree.
	 * Si renseigné, `gh pr close <n> --delete-branch` est exécuté pour
	 * éviter de laisser une PR orpheline pointant vers une branche supprimée.
	 * Les erreurs ne bloquent pas la suppression du worktree.
	 */
	prUrl?: string;
	/** Timeout in milliseconds for git operations (default: 30000) */
	timeout?: number;
	/** Maximum retries for directory deletion on Windows (default: 3) */
	maxRetries?: number;
	/** Delay between retries in milliseconds (default: 500) */
	retryDelay?: number;
}

/**
 * Result of the cleanup operation
 */
export interface WorktreeCleanupResult {
	/** Whether the cleanup was successful */
	success: boolean;
	/** The branch that was deleted (if deleteBranch was true) */
	branch?: string;
	/** Whether uncommitted changes were auto-committed */
	autoCommitted?: boolean;
	/** True si la PR associée a été fermée avec succès via gh CLI. */
	prClosed?: boolean;
	/** Numéro de la PR fermée (si applicable). */
	closedPrNumber?: number;
	/** Warnings that occurred during cleanup (non-fatal issues) */
	warnings: string[];
}

/**
 * Extrait le numéro de PR d'une URL GitHub.
 * Accepte les formats `https://github.com/owner/repo/pull/123`
 * ou variantes avec query/fragment.
 * Retourne `null` si l'URL ne correspond pas.
 */
export function extractPrNumber(prUrl: string): number | null {
	const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
	if (!match) {
		return null;
	}
	const n = Number.parseInt(match[1], 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Gets the worktree branch name based on spec ID
 */
function getWorktreeBranch(
	worktreePath: string,
	specId: string,
	timeout: number,
): string | null {
	// First try to get branch from the worktree's HEAD
	if (existsSync(worktreePath)) {
		try {
			const branch = execFileSync(
				getToolPath("git"),
				["rev-parse", "--abbrev-ref", "HEAD"],
				{
					cwd: worktreePath,
					encoding: "utf-8",
					env: getIsolatedGitEnv(),
					timeout,
				},
			).trim();

			if (branch && branch !== "HEAD") {
				return branch;
			}
		} catch {
			// Worktree might be corrupted, fall back to naming convention
		}
	}

	// Fall back to the naming convention: auto-claude/{spec-id}
	return `auto-claude/${specId}`;
}

/**
 * Delays execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deletes a directory with retry logic for Windows file locking issues
 *
 * On Windows, files can be locked by other processes (IDE, build tools, etc.)
 * which causes immediate deletion to fail. This function retries with linear
 * backoff to handle transient file locks.
 */
async function deleteDirectoryWithRetry(
	dirPath: string,
	maxRetries: number,
	retryDelay: number,
	logPrefix: string,
): Promise<void> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await rm(dirPath, { recursive: true, force: true });
			return; // Success
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				const waitTime = retryDelay * attempt; // Linear backoff
				console.warn(
					`${logPrefix} Directory deletion attempt ${attempt}/${maxRetries} failed, ` +
						`retrying in ${waitTime}ms: ${lastError.message}`,
				);
				await delay(waitTime);
			}
		}
	}

	// All retries exhausted
	throw lastError || new Error("Failed to delete directory after retries");
}

/**
 * Cleans up a worktree directory in a robust, cross-platform manner
 *
 * This function handles the Windows-specific issue where `git worktree remove --force`
 * fails when the worktree contains untracked files. The approach is:
 *
 * 1. Auto-commit any uncommitted changes (preserves work in git history)
 * 2. Manually delete the directory with retry logic for file locks
 * 3. Run `git worktree prune` to clean up git's internal references
 * 4. Optionally delete the associated branch
 *
 * All errors except directory deletion are logged but don't fail the operation.
 *
 * @param options - Cleanup configuration options
 * @returns Result object with success status and any warnings
 *
 * @example
 * ```typescript
 * const result = await cleanupWorktree({
 *   worktreePath: 'C:/projects/my-app/.workpilot/worktrees/tasks/001-feature',
 *   projectPath: 'C:/projects/my-app',
 *   specId: '001-feature',
 *   logPrefix: '[TASK_DELETE]'
 * });
 *
 * if (result.success) {
 *   console.log('Cleanup successful');
 *   if (result.autoCommitted) {
 *     console.log('Note: Uncommitted work was auto-saved');
 *   }
 * }
 * ```
 */
export async function cleanupWorktree(
	options: WorktreeCleanupOptions,
): Promise<WorktreeCleanupResult> {
	const {
		worktreePath,
		projectPath,
		specId,
		commitMessage = "Auto-save before deletion",
		logPrefix = "[WORKTREE_CLEANUP]",
		deleteBranch = true,
		prUrl,
		timeout = 30000,
		maxRetries = 3,
		retryDelay = 500,
	} = options;

	const warnings: string[] = [];
	let autoCommitted = false;
	let prClosed = false;
	let closedPrNumber: number | undefined;

	// Security: Validate that worktreePath is within the expected worktree directory
	// This prevents path traversal attacks and accidental deletion of wrong directories
	const expectedBase = getTaskWorktreeDir(projectPath);
	if (!isPathWithinBase(worktreePath, expectedBase)) {
		console.error(
			`${logPrefix} Security: Path validation failed - worktree path is outside expected directory`,
		);
		return {
			success: false,
			warnings: ["Invalid worktree path"],
		};
	}

	// 1. Get the branch name before we delete the directory
	const branch = getWorktreeBranch(worktreePath, specId, timeout);
	console.warn(`${logPrefix} Starting cleanup for worktree: ${worktreePath}`);
	if (branch) {
		console.warn(`${logPrefix} Associated branch: ${branch}`);
	}

	// 2. Auto-commit any uncommitted changes to preserve work
	// This ensures the user can recover their work via `git reflog` for ~90 days
	if (existsSync(worktreePath)) {
		try {
			// Check if there are any changes to commit
			const status = execFileSync(
				getToolPath("git"),
				["status", "--porcelain"],
				{
					cwd: worktreePath,
					encoding: "utf-8",
					env: getIsolatedGitEnv(),
					timeout,
				},
			);

			if (status.trim()) {
				// There are uncommitted changes - commit them before deletion
				console.warn(
					`${logPrefix} Found uncommitted changes, auto-committing...`,
				);

				execFileSync(getToolPath("git"), ["add", "-A"], {
					cwd: worktreePath,
					encoding: "utf-8",
					env: getIsolatedGitEnv(),
					timeout,
				});

				execFileSync(getToolPath("git"), ["commit", "-m", commitMessage], {
					cwd: worktreePath,
					encoding: "utf-8",
					env: getIsolatedGitEnv(),
					timeout,
				});

				console.warn(`${logPrefix} Auto-committed changes before deletion`);
				autoCommitted = true;
			}
		} catch (commitError) {
			// Non-critical - log and continue with deletion
			const msg =
				commitError instanceof Error
					? commitError.message
					: String(commitError);
			console.warn(
				`${logPrefix} Failed to auto-commit changes (non-critical): ${msg}`,
			);
			warnings.push(`Auto-commit failed: ${msg}`);
		}
	}

	// 3. Delete the worktree directory manually
	// This is required because `git worktree remove --force` fails on Windows
	// when the directory contains untracked files (node_modules, build artifacts, etc.)
	if (existsSync(worktreePath)) {
		console.warn(`${logPrefix} Deleting worktree directory...`);
		try {
			await deleteDirectoryWithRetry(
				worktreePath,
				maxRetries,
				retryDelay,
				logPrefix,
			);
			console.warn(`${logPrefix} Worktree directory deleted successfully`);
		} catch (deleteError) {
			// This IS critical - if we can't delete the directory, the cleanup failed
			const msg =
				deleteError instanceof Error
					? deleteError.message
					: String(deleteError);
			console.error(`${logPrefix} Failed to delete worktree directory: ${msg}`);
			return {
				success: false,
				branch: branch || undefined,
				autoCommitted,
				warnings: [...warnings, `Directory deletion failed: ${msg}`],
			};
		}
	} else {
		console.warn(`${logPrefix} Worktree directory already deleted`);
	}

	// 4. Prune git's internal worktree references
	// After manual deletion, git still thinks the worktree exists in .git/worktrees/
	// Running prune cleans up these stale references
	try {
		execFileSync(getToolPath("git"), ["worktree", "prune"], {
			cwd: projectPath,
			encoding: "utf-8",
			env: getIsolatedGitEnv(),
			timeout,
		});
		console.warn(`${logPrefix} Git worktree references pruned`);
	} catch (pruneError) {
		// Non-critical - the worktree is already gone, prune is just cleanup
		const msg =
			pruneError instanceof Error ? pruneError.message : String(pruneError);
		console.warn(
			`${logPrefix} Failed to prune worktree references (non-critical): ${msg}`,
		);
		warnings.push(`Worktree prune failed: ${msg}`);
	}

	// 5. Delete the branch if requested
	if (deleteBranch && branch) {
		try {
			execFileSync(getToolPath("git"), ["branch", "-D", branch], {
				cwd: projectPath,
				encoding: "utf-8",
				env: getIsolatedGitEnv(),
				timeout,
			});
			console.warn(`${logPrefix} Branch deleted: ${branch}`);
		} catch (branchError) {
			// Non-critical - branch might not exist or already deleted
			const msg =
				branchError instanceof Error
					? branchError.message
					: String(branchError);
			console.warn(
				`${logPrefix} Failed to delete branch (non-critical): ${msg}`,
			);
			warnings.push(`Branch deletion failed: ${msg}`);
		}
	}

	// 6. Fermeture de la PR distante associée (si fournie) afin de ne
	// pas laisser de PR orpheline qui pointerait vers une branche supprimée.
	// `gh pr close --delete-branch` ferme la PR ET supprime la branche
	// distante côté remote en une seule opération.
	if (prUrl) {
		const prNumber = extractPrNumber(prUrl);
		if (prNumber === null) {
			console.warn(
				`${logPrefix} PR URL invalide, fermeture ignorée: ${prUrl}`,
			);
			warnings.push(`Invalid PR URL: ${prUrl}`);
		} else {
			try {
				execFileSync(
					getToolPath("gh"),
					[
						"pr",
						"close",
						String(prNumber),
						"--delete-branch",
						"--comment",
						"Tâche supprimée depuis WorkPilot — PR fermée automatiquement.",
					],
					{
						cwd: projectPath,
						encoding: "utf-8",
						env: getIsolatedGitEnv(),
						timeout,
						stdio: ["pipe", "pipe", "pipe"],
					},
				);
				prClosed = true;
				closedPrNumber = prNumber;
				console.warn(`${logPrefix} PR #${prNumber} fermée et branche distante supprimée`);
			} catch (prError) {
				// Non bloquant : la PR peut déjà être fermée/mergée, le repo non
				// trouvé, ou gh CLI non authentifié. On laisse la suppression
				// du worktree aboutir mais on remonte un warning explicite.
				const msg =
					prError instanceof Error ? prError.message : String(prError);
				console.warn(
					`${logPrefix} Échec fermeture PR #${prNumber} (non bloquant): ${msg}`,
				);
				warnings.push(`PR close failed (#${prNumber}): ${msg}`);
			}
		}
	}

	console.warn(`${logPrefix} Cleanup completed successfully`);
	return {
		success: true,
		branch: branch || undefined,
		autoCommitted,
		prClosed,
		closedPrNumber,
		warnings,
	};
}
