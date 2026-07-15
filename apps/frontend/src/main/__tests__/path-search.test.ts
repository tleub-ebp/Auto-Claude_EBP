/**
 * Unit tests for the recursive project path search that powers the file-path
 * autocomplete inputs (Documentation Agent, etc.).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchProjectPaths } from "../ipc-handlers/path-search";

let ROOT: string;

beforeAll(() => {
	ROOT = mkdtempSync(path.join(tmpdir(), "path-search-"));
	// Build a small realistic tree.
	mkdirSync(path.join(ROOT, "src", "connectors", "jira"), { recursive: true });
	mkdirSync(path.join(ROOT, "src", "connectors", "github"), {
		recursive: true,
	});
	mkdirSync(path.join(ROOT, "node_modules", "left-pad"), { recursive: true });
	mkdirSync(path.join(ROOT, ".git"), { recursive: true });
	mkdirSync(path.join(ROOT, "docs"), { recursive: true });

	writeFileSync(path.join(ROOT, "src", "connectors", "jira", "connector.py"), "");
	writeFileSync(path.join(ROOT, "src", "connectors", "jira", "client.py"), "");
	writeFileSync(
		path.join(ROOT, "src", "connectors", "github", "connector.py"),
		"",
	);
	writeFileSync(path.join(ROOT, "src", "index.ts"), "");
	writeFileSync(path.join(ROOT, "README.md"), "");
	writeFileSync(path.join(ROOT, ".env"), ""); // hidden file — must be skipped
	writeFileSync(path.join(ROOT, "node_modules", "left-pad", "index.js"), "");
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("searchProjectPaths", () => {
	it("returns project-relative POSIX paths for files matching the query", async () => {
		const results = await searchProjectPaths(ROOT, "connector.py", "file");
		const paths = results.map((r) => r.relativePath);

		expect(paths).toContain("src/connectors/jira/connector.py");
		expect(paths).toContain("src/connectors/github/connector.py");
		// No backslashes even on Windows.
		expect(paths.every((p) => !p.includes("\\"))).toBe(true);
		expect(results.every((r) => !r.isDirectory)).toBe(true);
	});

	it("matches on any part of the relative path, case-insensitively", async () => {
		const results = await searchProjectPaths(ROOT, "JIRA/conn", "file");
		const paths = results.map((r) => r.relativePath);

		expect(paths).toContain("src/connectors/jira/connector.py");
		expect(paths).not.toContain("src/connectors/github/connector.py");
	});

	it("requires every whitespace-separated token to be present", async () => {
		const results = await searchProjectPaths(ROOT, "jira client", "file");
		const paths = results.map((r) => r.relativePath);

		expect(paths).toContain("src/connectors/jira/client.py");
		expect(paths).not.toContain("src/connectors/jira/connector.py");
	});

	it("returns only directories in directory mode", async () => {
		const results = await searchProjectPaths(ROOT, "connectors", "directory");
		const paths = results.map((r) => r.relativePath);

		expect(results.every((r) => r.isDirectory)).toBe(true);
		expect(paths).toContain("src/connectors");
		expect(paths).toContain("src/connectors/jira");
	});

	it("skips ignored directories (node_modules, .git) and hidden files", async () => {
		const files = await searchProjectPaths(ROOT, "", "file");
		const filePaths = files.map((r) => r.relativePath);
		expect(filePaths.some((p) => p.startsWith("node_modules/"))).toBe(false);
		expect(filePaths).not.toContain(".env");

		const dirs = await searchProjectPaths(ROOT, "", "directory");
		const dirPaths = dirs.map((r) => r.relativePath);
		expect(dirPaths).not.toContain("node_modules");
		expect(dirPaths).not.toContain(".git");
	});

	it("ranks closer (shorter-path) matches first", async () => {
		const results = await searchProjectPaths(ROOT, "connector", "file");
		const paths = results.map((r) => r.relativePath);
		// jira/connector.py (shorter) ranks before github/connector.py? Both equal
		// length here, so assert the sort is stable & shorter-first overall by
		// checking lengths are non-decreasing.
		const lengths = paths.map((p) => p.length);
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
		}
	});

	it("returns an empty array for an unreadable root", async () => {
		const results = await searchProjectPaths(
			path.join(ROOT, "does-not-exist"),
			"anything",
			"file",
		);
		expect(results).toEqual([]);
	});
});
