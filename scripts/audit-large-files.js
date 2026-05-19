#!/usr/bin/env node
/**
 * Audit des fichiers volumineux du repo.
 *
 * Liste tous les fichiers source > 500 lignes (configurable) pour cibler
 * les candidats à décomposition (réduction tokens Copilot).
 *
 * Usage :
 *   node scripts/audit-large-files.js
 *   node scripts/audit-large-files.js --threshold 1000
 *   node scripts/audit-large-files.js --json > _bmad-output/large-files.json
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD =
	thresholdIdx >= 0 ? Number.parseInt(args[thresholdIdx + 1], 10) : 500;
const JSON_OUT = args.includes("--json");

const REPO_ROOT = path.resolve(__dirname, "..");

const INCLUDE_EXT = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".css",
]);

const EXCLUDE_DIRS = new Set([
	"node_modules",
	".git",
	".pnpm-store",
	"dist",
	"build",
	"out",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".ruff_cache",
	"coverage",
	".turbo",
	".next",
	".cache",
	".security-reports",
]);

/** @type {Array<{ file: string, lines: number, bytes: number }>} */
const results = [];

function walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
				continue;
			}
			walk(full);
		} else if (entry.isFile()) {
			if (!INCLUDE_EXT.has(path.extname(entry.name))) continue;
			let content;
			try {
				content = fs.readFileSync(full, "utf8");
			} catch {
				continue;
			}
			const lines = content.split("\n").length;
			if (lines >= THRESHOLD) {
				const stat = fs.statSync(full);
				results.push({
					file: path.relative(REPO_ROOT, full).replaceAll("\\", "/"),
					lines,
					bytes: stat.size,
				});
			}
		}
	}
}

walk(REPO_ROOT);
results.sort((a, b) => b.lines - a.lines);

if (JSON_OUT) {
	process.stdout.write(JSON.stringify({ threshold: THRESHOLD, results }, null, 2));
	process.stdout.write("\n");
} else {
	console.log(
		`\nFichiers ≥ ${THRESHOLD} lignes (${results.length} trouvés) :\n`,
	);
	const pad = (s, n) => String(s).padStart(n);
	for (const r of results) {
		console.log(`  ${pad(r.lines, 6)}  ${r.file}`);
	}
	console.log("");
	console.log(
		`Astuce : créer un AGENTS.md local pour les fichiers en tête de liste`,
	);
	console.log(
		`         et/ou une instruction path-scoped dans .github/instructions/.`,
	);
}
