#!/usr/bin/env node
/**
 * Pre-push gate: replicates the essential CI checks locally before pushing.
 *
 * MODE RAPIDE PAR DÉFAUT (objectif : < 30 s).
 *   Joue seulement le lint : ruff check, ruff format --check, biome.
 *   pytest / tsc / vitest sont délégués à la CI, qui les rejoue de toute façon
 *   en parallèle sans bloquer personne. Les jouer ici aussi, c'est payer deux
 *   fois la même garantie et rendre chaque push pénible.
 *
 * MODE COMPLET (opt-in) : PRE_PUSH_FULL=1 git push
 *   Ajoute pytest (ciblé sur le diff), tsc et vitest — utile avant une release
 *   ou quand on veut la certitude avant d'attendre la CI.
 *
 * Skip rules:
 *   - PRE_PUSH_SKIP=1 or `git push --no-verify` bypass entirely.
 *   - If only docs/CI-config files changed vs the upstream branch, skip tests.
 *
 * Anti-blocage (ces règles existent parce qu'un push qui « pend » sans aucune
 * sortie est pire qu'un push refusé) :
 *   - Chaque job a un TIMEOUT (PRE_PUSH_TIMEOUT_MS, 5 min par défaut). Passé ce
 *     délai le process est tué au lieu de bloquer le push indéfiniment.
 *   - Un battement de cœur affiche les jobs encore en cours toutes les 20 s.
 *   - Un job en timeout AVERTIT sans bloquer (la CI reste le garde-fou).
 *     PRE_PUSH_STRICT=1 rend les timeouts bloquants.
 *
 * Run manually: `node scripts/pre-push.js`
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");

const {
	IS_WINDOWS,
	findVenvBin,
	selectPytestTargets,
} = require("./lib/test-selection");

const ROOT = path.join(__dirname, "..");

if (process.env.PRE_PUSH_SKIP === "1") {
	console.log("⏭  PRE_PUSH_SKIP=1 set — skipping pre-push checks.");
	process.exit(0);
}

// Un job qui dépasse ce délai est tué : sans ça, un `tsc --noEmit` lent (cas
// classique sous Windows quand l'antivirus scanne node_modules) fait pendre le
// push indéfiniment, sans la moindre sortie à l'écran.
const JOB_TIMEOUT_MS = Number(process.env.PRE_PUSH_TIMEOUT_MS || 300000);
// Par défaut un timeout n'est PAS bloquant : on n'a pas pu vérifier, la CI le
// fera. PRE_PUSH_STRICT=1 pour refuser le push dans ce cas.
const STRICT_TIMEOUTS = process.env.PRE_PUSH_STRICT === "1";

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

// Pytest target selection lives in scripts/lib/test-selection.js (shared with
// the commit-time gate scripts/staged-tests.js). Pre-push keeps the
// conservative behavior: unmapped backend changes → run the whole suite.

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
// Jobs actuellement en cours — sert au battement de cœur, pour qu'un check long
// ressemble à « ça travaille » et non à « c'est planté ».
const running = new Map(); // name -> startedAt

/** Tue un process et toute sa descendance (indispensable sous Windows). */
function killTree(child) {
	if (IS_WINDOWS) {
		try {
			execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
			return;
		} catch {
			/* le process s'est peut-être déjà terminé — on retombe sur kill() */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* ignore */
	}
}

function runJob(name, cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const start = Date.now();
		running.set(name, start);
		// opts.env (if provided) is merged on top of process.env + FORCE_COLOR
		// so callers can add per-job env vars (e.g. VITEST_SINGLE_FORK).
		const child = spawn(cmd, args, {
			cwd: opts.cwd || ROOT,
			shell: IS_WINDOWS,
			env: { ...process.env, FORCE_COLOR: "1", ...(opts.env || {}) },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timeoutMs = opts.timeoutMs || JOB_TIMEOUT_MS;
		const timer = setTimeout(() => {
			timedOut = true;
			console.log(
				`⏱  ${name} dépasse ${Math.round(timeoutMs / 1000)}s — process tué.`,
			);
			killTree(child);
		}, timeoutMs);

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			running.delete(name);
			resolve(result);
		};

		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			finish({
				name,
				code: timedOut ? 1 : code,
				timedOut,
				durationMs: Date.now() - start,
				stdout,
				stderr,
			});
		});
		child.on("error", (err) => {
			finish({
				name,
				code: 1,
				timedOut,
				durationMs: Date.now() - start,
				stdout: "",
				stderr: `Failed to spawn: ${err.message}`,
			});
		});
	});
}

/** Affiche périodiquement ce qui tourne encore, pour ne jamais paraître figé. */
function startHeartbeat() {
	const interval = setInterval(() => {
		if (running.size === 0) return;
		const now = Date.now();
		const list = [...running.entries()]
			.map(([n, t]) => `${n} (${Math.round((now - t) / 1000)}s)`)
			.join(", ");
		console.log(`   … en cours : ${list}`);
	}, 20000);
	interval.unref?.();
	return () => clearInterval(interval);
}

// ---------------------------------------------------------------------------
// Resolve binaries — prefer venv pytest, frontend node_modules biome/vitest.
// findVenvBin checks apps/backend/.venv, ./.venv and .cache/.venv (the
// install-backend.js default) — see scripts/lib/test-selection.js.
// ---------------------------------------------------------------------------
const frontendDir = path.join(ROOT, "apps", "frontend");

const pytestPath = findVenvBin(ROOT, "pytest");
const ruffPath = findVenvBin(ROOT, "ruff");

const jobs = [];

if (ruffPath) {
	jobs.push(runJob("backend:ruff", ruffPath, ["check", "apps/backend/"]));
	// Mirrors the CI "ruff format check" step — a check-only `ruff check`
	// does NOT catch formatting drift, which is exactly what broke CI.
	jobs.push(
		runJob("backend:ruff-format", ruffPath, [
			"format",
			"apps/backend/",
			"--check",
		]),
	);
	// The two scripts that write the generated skill output. CI lints them for
	// the same reason: they produce files the `skills` job then verifies.
	jobs.push(
		runJob("skills:ruff", ruffPath, [
			"check",
			"scripts/skills_cli.py",
			"scripts/skills_sync.py",
		]),
	);
} else {
	console.warn(
		"⚠  ruff not found in venv — skipping backend lint. Install with `pip install ruff`.",
	);
}

// `.agents/skills/`, `.agents/agents/` and the harness mirrors are build
// output. Cheap, deterministic and offline, so it belongs in the default pass
// rather than being discovered on CI after the push. Python is required
// anyway for the ruff jobs above.
const pythonPath = findVenvBin(ROOT, "python") || "python3";
jobs.push(
	runJob("skills:check", pythonPath, ["scripts/skills_cli.py", "build", "--check"]),
);

// --- Checks lourds : opt-in seulement -------------------------------------
// pytest / tsc / vitest coûtent plusieurs minutes et sont DÉJÀ rejoués par la
// CI, en parallèle, sans bloquer personne. Les rejouer à chaque push, c'est
// payer deux fois pour la même garantie — et c'est ce qui rendait le push
// insupportable. Ils restent disponibles à la demande :
//     PRE_PUSH_FULL=1 git push
const FULL = process.env.PRE_PUSH_FULL === "1";

if (FULL) {
	if (pytestPath) {
		const pytestTargets = selectPytestTargets(ROOT, changed);
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
}

// Frontend: biome lint toujours (quelques secondes). Le typecheck rejoint les
// checks lourds — il est incrémental (voir tsconfig.json), donc rapide en
// local, mais la première passe après un `pnpm install` reste longue.
const pnpmCmd = IS_WINDOWS ? "pnpm.cmd" : "pnpm";
jobs.push(runJob("frontend:lint", pnpmCmd, ["run", "lint"], { cwd: frontendDir }));
if (FULL) {
	jobs.push(
		runJob("frontend:typecheck", pnpmCmd, ["run", "typecheck"], {
			cwd: frontendDir,
		}),
	);
}

console.log(
	FULL
		? `🚦 Running ${jobs.length} pre-push checks (mode COMPLET, vitest deferred)...`
		: `🚦 Running ${jobs.length} pre-push checks (mode rapide)...`,
);
console.log(
	`   timeout par job : ${Math.round(JOB_TIMEOUT_MS / 1000)}s · bypass : git push --no-verify`,
);
if (!FULL) {
	console.log(
		"   tests + typecheck : délégués à la CI · en local : PRE_PUSH_FULL=1 git push",
	);
}
console.log("");
const startedAt = Date.now();
const stopHeartbeat = startHeartbeat();

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

	// Mode rapide : pas de vitest ici, la CI s'en charge.
	let vitestResult = null;
	if (FULL) {
		vitestResult = await runJob("frontend:test", pnpmCmd, ["run", "test"], {
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
	}

	const results = vitestResult
		? [...parallelResults, vitestResult]
		: [...parallelResults];
	stopHeartbeat();

	const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
	// Un timeout n'est pas un échec de test : on n'a pas pu vérifier. Bloquant
	// seulement en mode strict.
	const timedOut = results.filter((r) => r.timedOut);
	const failed = results.filter((r) => r.code !== 0 && !r.timedOut);

	for (const r of results) {
		const sec = (r.durationMs / 1000).toFixed(1);
		const status = r.timedOut ? "⏱ " : r.code === 0 ? "✅" : "❌";
		console.log(`${status} ${r.name} (${sec}s)${r.timedOut ? " — timeout" : ""}`);
	}
	console.log(`\n⏱  Total: ${totalSec}s\n`);

	if (timedOut.length > 0) {
		console.log(
			`⚠  ${timedOut.length} check(s) en timeout : ${timedOut
				.map((r) => r.name)
				.join(", ")}\n` +
				"   Non vérifié localement — la CI le fera. Pour laisser plus de temps :\n" +
				"   PRE_PUSH_TIMEOUT_MS=900000 git push   (15 min)\n" +
				"   Pour refuser le push dans ce cas : PRE_PUSH_STRICT=1 git push\n",
		);
		if (STRICT_TIMEOUTS) {
			console.log("❌ PRE_PUSH_STRICT=1 — push refusé à cause du timeout.");
			process.exit(1);
		}
	}

	if (failed.length === 0) {
		console.log(
			timedOut.length > 0
				? "✅ Aucun échec réel — push autorisé."
				: "✅ All pre-push checks passed.",
		);
		if (!FULL) {
			console.log(
				"   (mode rapide : pytest/tsc/vitest tournent en CI — PRE_PUSH_FULL=1 pour les jouer ici)",
			);
		}
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
