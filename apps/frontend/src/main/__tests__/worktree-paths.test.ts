import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findTaskWorktree,
	sanitizeSpecNameToAscii,
	TASK_WORKTREE_DIR,
} from "../worktree-paths";

describe("sanitizeSpecNameToAscii", () => {
	it("strips diacritics via NFKD (é -> e)", () => {
		expect(
			sanitizeSpecNameToAscii("002-limitation-du-numéro-de-tva-"),
		).toBe("002-limitation-du-numero-de-tva-");
	});

	it("leaves already-ASCII ids unchanged", () => {
		expect(sanitizeSpecNameToAscii("003-plain-ascii-spec")).toBe(
			"003-plain-ascii-spec",
		);
	});

	it("drops remaining non-ASCII codepoints", () => {
		expect(sanitizeSpecNameToAscii("spec-✨-emoji")).toBe("spec--emoji");
	});
});

describe("findTaskWorktree", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(path.join(tmpdir(), "wp-worktree-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("finds a worktree whose folder matches the specId exactly", () => {
		const specId = "003-plain-ascii-spec";
		const worktree = path.join(projectDir, TASK_WORKTREE_DIR, specId);
		mkdirSync(worktree, { recursive: true });

		expect(findTaskWorktree(projectDir, specId)).toBe(
			path.resolve(worktree),
		);
	});

	it("finds an ASCII-sanitized worktree folder for an accented specId", () => {
		// Le backend nomme le dossier du worktree en ASCII (numero), alors que le
		// specId conserve l'accent (numéro). Le lookup doit malgré tout réussir.
		const accentedSpecId = "002-limitation-du-numéro-de-tva-";
		const asciiFolder = "002-limitation-du-numero-de-tva-";
		const worktree = path.join(projectDir, TASK_WORKTREE_DIR, asciiFolder);
		mkdirSync(worktree, { recursive: true });

		expect(findTaskWorktree(projectDir, accentedSpecId)).toBe(
			path.resolve(worktree),
		);
	});

	it("returns null when no matching worktree exists", () => {
		expect(findTaskWorktree(projectDir, "999-missing-spec")).toBeNull();
	});

	it("does not escape the project root via path traversal", () => {
		expect(findTaskWorktree(projectDir, "../../etc")).toBeNull();
	});
});
