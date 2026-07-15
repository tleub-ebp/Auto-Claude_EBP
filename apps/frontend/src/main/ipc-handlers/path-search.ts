import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { FileSearchResult } from "../../shared/types";

/**
 * Directories skipped everywhere we walk a project tree (listing + search).
 * Build output, dependency, and VCS folders never hold source the user wants
 * to target.
 */
export const IGNORED_DIRS = new Set([
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

// Bounds for the recursive autocomplete search — keep it snappy and never let
// a pathological tree (deep nesting, huge repos) block the main process.
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_ENTRIES = 20000;
export const MAX_SEARCH_DEPTH = 12;

/**
 * Recursively walk `rootPath` collecting files or directories whose
 * project-relative POSIX path matches every whitespace-separated token in
 * `query` (case-insensitive substring). Powers the file-path autocomplete in
 * the agent inputs. Async (uses fs/promises) so it never blocks the main
 * process, and bounded on depth, visited entries, and results. Closest matches
 * (shortest relative path) are returned first.
 */
export async function searchProjectPaths(
	rootPath: string,
	query: string,
	mode: "file" | "directory",
): Promise<FileSearchResult[]> {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	const results: FileSearchResult[] = [];
	let visited = 0;

	async function walk(
		absDir: string,
		relDir: string,
		depth: number,
	): Promise<void> {
		if (results.length >= MAX_SEARCH_RESULTS || depth > MAX_SEARCH_DEPTH) {
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return; // unreadable dir — skip silently
		}

		for (const entry of entries) {
			if (results.length >= MAX_SEARCH_RESULTS) return;
			if (visited++ > MAX_SEARCH_ENTRIES) return;

			const isDirectory = entry.isDirectory();
			// Skip noisy build/vendor dirs and hidden entries entirely.
			if (
				isDirectory &&
				(IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))
			) {
				continue;
			}
			if (!isDirectory && entry.name.startsWith(".")) continue;

			const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
			const typeMatches = mode === "directory" ? isDirectory : !isDirectory;
			if (typeMatches) {
				const haystack = relPath.toLowerCase();
				if (tokens.every((tok) => haystack.includes(tok))) {
					results.push({ relativePath: relPath, name: entry.name, isDirectory });
				}
			}

			if (isDirectory) {
				await walk(path.join(absDir, entry.name), relPath, depth + 1);
			}
		}
	}

	await walk(rootPath, "", 0);

	// Rank shorter (closer-to-root, tighter) matches first, then alphabetically.
	results.sort(
		(a, b) =>
			a.relativePath.length - b.relativePath.length ||
			a.relativePath.localeCompare(b.relativePath, undefined, {
				sensitivity: "base",
			}),
	);
	return results.slice(0, MAX_SEARCH_RESULTS);
}
