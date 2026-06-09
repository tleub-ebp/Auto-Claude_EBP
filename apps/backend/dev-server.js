// Cross-platform backend dev server launcher for pnpm
// Ensures Python venv is activated and dependencies are installed before running Uvicorn

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const venvDir = resolve(__dirname, "../../.venv");
const requirements = resolve(__dirname, "requirements.txt");

function venvPython() {
	if (isWin) {
		return join(venvDir, "Scripts", "python.exe");
	} else {
		return join(venvDir, "bin", "python");
	}
}

function ensureVenv(cb) {
	if (!existsSync(venvPython())) {
		console.log("[INFO] Creating Python venv...");
		const py = isWin ? "python" : "python3";
		const proc = spawn(py, ["-m", "venv", venvDir], { stdio: "inherit" });
		proc.on("exit", (code) => {
			if (code === 0) cb();
			else process.exit(code);
		});
	} else {
		cb();
	}
}

function ensureDeps(cb) {
	const pip = venvPython();
	const proc = spawn(pip, ["-m", "pip", "install", "-r", requirements], {
		stdio: "inherit",
	});
	proc.on("exit", (code) => {
		if (code === 0) cb();
		else process.exit(code);
	});
}

function runUvicorn() {
	const uvicornArgs = [
		"-m",
		"uvicorn",
		"provider_api:app",
		"--host",
		"127.0.0.1",
		"--port",
		"9000",
		"--reload",
		// Watch only the backend source directory. The shared virtualenv lives at
		// the repo root (../../.venv), so scoping the watcher to apps/backend keeps
		// pip installs (PythonEnvManager) from triggering an endless reload storm.
		// NOTE: do not use glob --reload-exclude patterns like ".venv/*" here: the
		// bundled Windows python.exe expands wildcard argv, turning the pattern into
		// extra positional args and making uvicorn exit with code 2.
		"--reload-dir",
		__dirname,
	];
	const proc = spawn(venvPython(), uvicornArgs, {
		stdio: "inherit",
		cwd: __dirname,
	});
	proc.on("exit", (code) => process.exit(code));
}

ensureVenv(() => ensureDeps(runUvicorn));
