#!/usr/bin/env node
/**
 * Pre-push gate: replicates the essential CI checks locally before pushing.
 *
 * Runs backend (ruff + pytest) and frontend (biome + tsc + vitest) jobs in
 * parallel and aggregates results. Mirrors .github/workflows/ci.yml and
 * lint.yml so failures surface here instead of in CI.
 *
 * Skip rules:
 *   - PRE_PUSH_SKIP=1 or `git push --no-verify` bypass entirely.
 *   - If only docs/CI-config files changed vs the upstream branch, skip tests.
 *
 * Run manually: `node scripts/pre-push.js`
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const IS_WINDOWS = os.platform() === "win32";

if (process.env.PRE_PUSH_SKIP === "1") {
	console.log("⏭  PRE_PUSH_SKIP=1 set — skipping pre-push checks.");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Diff-based skip: if only docs/yaml outside CI paths changed, no need to run.
// Mirrors the `paths:` filter in .github/workflows/ci.yml.
// ---------------------------------------------------------------------------
const RELEVANT_PATTERNS = [
	/^apps\//,
	/^tests\//,
	/^package.*\.json$/,
	/^pnpm-lock\.yaml$/,
	/^requirements.*\.txt$/,
	/^pyproject\.toml$/,
	/^tsconfig.*\.json$/,
	/^biome\.jsonc$/,
	/^scripts\//,
];

function getChangedFiles() {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: ROOT,
			encoding: "utf8",
		}).trim();
		// Compare against upstream if it exists, otherwise fall back to develop.
		let base;
		try {
			base = execSync(`git rev-parse --abbrev-ref ${branch}@{upstream}`, {
				cwd: ROOT,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();
		} catch {
			base = "origin/develop";
		}
		const diff = execSync(`git diff --name-only ${base}...HEAD`, {
			cwd: ROOT,
			encoding: "utf8",
		});
		return diff.split("\n").filter(Boolean);
	} catch {
		// If git plumbing fails (detached HEAD, no upstream, etc.), run everything.
		return null;
	}
}

/**
 * Pick a pytest target list based on changed files.
 *
 * - Backend test file changed → run that file directly.
 * - Backend source file changed → run tests/ matching the module name.
 * - tests/ changed but no specific source → run tests/.
 * - Conservative fallback: if any backend source file changed but we can't
 *   map it, run the whole suite (correctness > speed).
 */
function selectPytestTargets(changedFiles) {
	if (!changedFiles) return ["tests/"];
	const backendSrc = changedFiles.filter(
		(f) => f.startsWith("apps/backend/") && f.endsWith(".py"),
	);
	const testChanges = changedFiles.filter(
		(f) => f.startsWith("tests/") && f.endsWith(".py"),
	);
	if (backendSrc.length === 0 && testChanges.length === 0) return [];

	const targets = new Set();
	for (const t of testChanges) targets.add(t);

	const allTests = [];
	function walk(dir) {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && e.name.startsWith("test_") && e.name.endsWith(".py")) {
				allTests.push(full);
			}
		}
	}
	try {
		walk(path.join(ROOT, "tests"));
	} catch {
		return ["tests/"];
	}

	let unmapped = false;
	for (const src of backendSrc) {
		const base = path.basename(src, ".py"); // e.g. "ci_discovery"
		const matches = allTests.filter((t) => path.basename(t).includes(base));
		if (matches.length === 0) {
			unmapped = true;
		} else {
			for (const m of matches) {
				targets.add(path.relative(ROOT, m).replaceAll("\\", "/"));
			}
		}
	}

	if (unmapped) return ["tests/"]; // Safe fallback when mapping is uncertain
	return [...targets];
}

const changed = getChangedFiles();
if (changed !== null && changed.length > 0) {
	const relevant = changed.filter((f) =>
		RELEVANT_PATTERNS.some((re) => re.test(f)),
	);
	if (relevant.length === 0) {
		console.log(
			`⏭  No code/test files changed (${changed.length} non-code files) — skipping pre-push checks.`,
		);
		process.exit(0);
	}
}

// ---------------------------------------------------------------------------
// Job runner — captures output and reports at the end so parallel jobs don't
// interleave their logs.
// ---------------------------------------------------------------------------
function runJob(name, cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const start = Date.now();
		// opts.env (if provided) is merged on top of process.env + FORCE_COLOR
		// so callers can add per-job env vars (e.g. VITEST_SINGLE_FORK).
		const child = spawn(cmd, args, {
			cwd: opts.cwd || ROOT,
			shell: IS_WINDOWS,
			env: { ...process.env, FORCE_COLOR: "1", ...(opts.env || {}) },
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			resolve({
				name,
				code,
				durationMs: Date.now() - start,
				stdout,
				stderr,
			});
		});
		child.on("error", (err) => {
			resolve({
				name,
				code: 1,
				durationMs: Date.now() - start,
				stdout: "",
				stderr: `Failed to spawn: ${err.message}`,
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Resolve binaries — prefer venv pytest, frontend node_modules biome/vitest.
// ---------------------------------------------------------------------------
function venvBin(dir, name) {
	return IS_WINDOWS
		? path.join(dir, ".venv", "Scripts", `${name}.exe`)
		: path.join(dir, ".venv", "bin", name);
}

const backendVenv = path.join(ROOT, "apps", "backend");
const rootVenv = ROOT;
const frontendDir = path.join(ROOT, "apps", "frontend");

const pytestPath = [backendVenv, rootVenv]
	.map((d) => venvBin(d, "pytest"))
	.find((p) => fs.existsSync(p));
const ruffPath = [backendVenv, rootVenv]
	.map((d) => venvBin(d, "ruff"))
	.find((p) => fs.existsSync(p));

const jobs = [];

if (ruffPath) {
	jobs.push(runJob("backend:ruff", ruffPath, ["check", "apps/backend/"]));
} else {
	console.warn(
		"⚠  ruff not found in venv — skipping backend lint. Install with `pip install ruff`.",
	);
}

if (pytestPath) {
	// Default: only run tests related to changed backend paths. Set
	// PRE_PUSH_FULL=1 to run the full suite (matches CI exactly).
	const full = process.env.PRE_PUSH_FULL === "1";
	const pytestTargets = full ? ["tests/"] : selectPytestTargets(changed);
	if (pytestTargets.length === 0) {
		console.log("⏭  No backend code changed — skipping pytest.");
	} else {
		jobs.push(
			runJob("backend:pytest", pytestPath, [
				...pytestTargets,
				"--tb=short",
				"-x",
				"-q",
			]),
		);
	}
} else {
	console.warn(
		'⚠  pytest not found in venv — skipping backend tests. Run "pnpm run install:backend".',
	);
}

// Frontend: biome check + typecheck. (vitest is run sequentially AFTER the
// parallel batch — see below — to avoid CPU contention with backend:pytest
// that was starving vitest worker forks and producing spurious
// "Vitest failed to access its internal state" / worker-timeout errors.)
const pnpmCmd = IS_WINDOWS ? "pnpm.cmd" : "pnpm";
jobs.push(
	runJob("frontend:lint", pnpmCmd, ["run", "lint"], { cwd: frontendDir }),
	runJob("frontend:typecheck", pnpmCmd, ["run", "typecheck"], {
		cwd: frontendDir,
	}),
);

console.log(
	`🚦 Running ${jobs.length} pre-push checks in parallel (vitest deferred)...\n`,
);
const startedAt = Date.now();

Promise.all(jobs).then(async (parallelResults) => {
	// Run vitest only after the parallel batch settles, so it doesn't fight
	// pytest for CPU. VITEST_LIMIT_WORKERS=1 caps vitest at maxWorkers:2
	// (see vitest.config.ts) to dampen the Windows fork-pool flake.
	//
	// Retry-once policy: if vitest fails AND the failure looks like the
	// well-known worker-startup flake (not a real test assertion),
	// re-run it. The same suite passes deterministically on retry.
	const vitestEnv = { ...process.env, VITEST_LIMIT_WORKERS: "1" };
	const VITEST_FLAKE_SIGNATURE =
		/Vitest failed to access its internal state|\[vitest-pool-runner\]: Timeout waiting for worker|\[vitest-pool\]: Failed to start forks worker/;

	let vitestResult = await runJob("frontend:test", pnpmCmd, ["run", "test"], {
		cwd: frontendDir,
		env: vitestEnv,
	});

	if (
		vitestResult.code !== 0 &&
		VITEST_FLAKE_SIGNATURE.test(vitestResult.stdout + vitestResult.stderr)
	) {
		console.log(
			"\n⚠  frontend:test failed with vitest worker-flake signature — retrying once.\n",
		);
		vitestResult = await runJob("frontend:test", pnpmCmd, ["run", "test"], {
			cwd: frontendDir,
			env: vitestEnv,
		});
		vitestResult.name = "frontend:test (retry)";
	}

	const results = [...parallelResults, vitestResult];

	const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
	const failed = results.filter((r) => r.code !== 0);

	for (const r of results) {
		const sec = (r.durationMs / 1000).toFixed(1);
		const status = r.code === 0 ? "✅" : "❌";
		console.log(`${status} ${r.name} (${sec}s)`);
	}
	console.log(`\n⏱  Total: ${totalSec}s\n`);

	if (failed.length === 0) {
		console.log("✅ All pre-push checks passed.");
		process.exit(0);
	}

	console.log(`❌ ${failed.length} check(s) failed:\n`);
	for (const r of failed) {
		console.log(`\n${"=".repeat(70)}`);
		console.log(`FAILED: ${r.name} (exit ${r.code})`);
		console.log("=".repeat(70));
		if (r.stdout) console.log(r.stdout);
		if (r.stderr) console.log(r.stderr);
	}
	console.log(
		"\n💡 To bypass in an emergency: git push --no-verify (or PRE_PUSH_SKIP=1 git push)",
	);
	process.exit(1);
});
