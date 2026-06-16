#!/usr/bin/env node
/**
 * Commit-time test gate: runs ONLY the tests related to STAGED files.
 *
 * Called from .husky/pre-commit after lint/format. The goal is fast feedback
 * (seconds, not the ~11-minute full suite):
 *   - Backend: pytest on tests/ files whose name matches a staged module
 *     (same mapping as scripts/pre-push.js, via scripts/lib/test-selection.js).
 *     Staged files that map to no test are SKIPPED here — the pre-push gate
 *     and CI run the full suite as the safety net.
 *   - Frontend: `vitest related --run` on staged src files (runs only the
 *     test files that import them).
 *
 * Skip: PRE_COMMIT_SKIP_TESTS=1 git commit ...   (or git commit --no-verify)
 */

const { execSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const {
	IS_WINDOWS,
	findVenvBin,
	selectPytestTargets,
} = require("./lib/test-selection");

const ROOT = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "apps", "frontend");

if (process.env.PRE_COMMIT_SKIP_TESTS === "1") {
	console.log("[staged-tests] PRE_COMMIT_SKIP_TESTS=1 — skipping.");
	process.exit(0);
}

let staged;
try {
	staged = execSync("git diff --cached --name-only --diff-filter=ACMR", {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\n")
		.map((f) => f.trim())
		.filter(Boolean);
} catch (err) {
	console.warn(`[staged-tests] Could not list staged files: ${err.message}`);
	process.exit(0); // never block the commit on git plumbing issues
}

if (staged.length === 0) {
	process.exit(0);
}

function run(name, cmd, args, cwd, env) {
	console.log(`[staged-tests] ${name}: ${cmd} ${args.join(" ")}`);
	const res = spawnSync(cmd, args, {
		cwd,
		stdio: "inherit",
		shell: IS_WINDOWS,
		env: { ...process.env, ...(env || {}) },
	});
	return res.status === 0;
}

let failed = false;

// ---------------------------------------------------------------------------
// Backend: pytest on tests mapped from staged backend files
// ---------------------------------------------------------------------------
const pytestTargets = selectPytestTargets(ROOT, staged, {
	fallbackToFullSuite: false,
});
if (pytestTargets.length > 0) {
	const pytest = findVenvBin(ROOT, "pytest");
	if (pytest) {
		// pytest runs from apps/backend (same cwd as CI) with repo-root-relative
		// targets rewritten to ../../
		const backendCwd = path.join(ROOT, "apps", "backend");
		const args = [
			...pytestTargets.map((t) => path.join("..", "..", t)),
			"-q",
			"--tb=short",
			"-x",
		];
		if (!run("backend pytest (staged)", pytest, args, backendCwd)) {
			failed = true;
		}
	} else {
		console.warn(
			"[staged-tests] pytest not found in venv — skipping backend tests.",
		);
	}
} else {
	const touchedBackend = staged.some(
		(f) => f.startsWith("apps/backend/") && f.endsWith(".py"),
	);
	if (touchedBackend) {
		console.log(
			"[staged-tests] No test file maps to the staged backend modules — " +
				"skipping (pre-push/CI run the full suite).",
		);
	}
}

// ---------------------------------------------------------------------------
// Frontend: vitest related on staged src files
// ---------------------------------------------------------------------------
const frontendStaged = staged.filter(
	(f) =>
		f.startsWith("apps/frontend/src/") && /\.(ts|tsx|js|jsx)$/.test(f),
);
if (frontendStaged.length > 0) {
	const relToFrontend = frontendStaged.map((f) =>
		path.relative("apps/frontend", f).replaceAll("\\", "/"),
	);
	const pnpmCmd = IS_WINDOWS ? "pnpm.cmd" : "pnpm";
	const ok = run(
		"frontend vitest related (staged)",
		pnpmCmd,
		["exec", "vitest", "related", "--run", ...relToFrontend],
		FRONTEND_DIR,
		{ VITEST_LIMIT_WORKERS: "1" },
	);
	if (!ok) failed = true;
}

if (failed) {
	console.error(
		"\n[staged-tests] ❌ Tests related to your staged changes failed — " +
			"commit aborted.\n" +
			"Bypass (emergency only): PRE_COMMIT_SKIP_TESTS=1 git commit ... " +
			"or git commit --no-verify",
	);
	process.exit(1);
}
process.exit(0);
