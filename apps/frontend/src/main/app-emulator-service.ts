import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
	buildPowerShellKnownMsBuildArray,
	LEGACY_MSBUILD_UNAVAILABLE_MESSAGE,
	quotePowerShellSingle,
	WINDOWS_RUNTIME_UNAVAILABLE_MESSAGE,
} from "./dotnet-msbuild";
import {
	createLegacyPackageReferencesTarget,
	ensureLegacyWorktreeBuildAssets,
	LEGACY_RESOURCE_PROPERTY,
} from "./legacy-dotnet-build";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IIS_EXPRESS_ENV = "WORKPILOT_IIS_EXPRESS_PATH";
const IIS_EXPRESS_UNAVAILABLE_MESSAGE =
	"IIS Express/xsp was not found. Set WORKPILOT_IIS_EXPRESS_PATH, install IIS Express on Windows or Mono xsp on Linux/macOS, or configure a remote/VM runner.";

/** Nombre maximum de lignes de sortie conservées pour diagnostiquer une sortie en échec. */
export const SERVER_OUTPUT_BUFFER_LIMIT = 200;

/** Motifs identifiant une ligne de sortie porteuse d'un message d'erreur exploitable. */
const SERVER_ERROR_LINE_PATTERN =
	/\b(?:error|erreur|exception|fatal|MSB\d{3,}|CS\d{3,}|échec|failed|cannot|could not|n'a pas pu)\b/i;

/**
 * Construit un message d'erreur lisible à partir du code de sortie et des dernières
 * lignes de sortie du serveur. Privilégie les lignes contenant un message d'erreur
 * réel (ex. MSB3086) plutôt que de n'afficher que le code de sortie brut.
 */
export function formatServerExitError(
	code: number | null,
	recentOutput: readonly string[],
): string {
	const header = `Server exited with code ${code ?? "unknown"}`;
	const lines = recentOutput.map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return header;

	const errorLines = lines.filter((line) => SERVER_ERROR_LINE_PATTERN.test(line));
	const selected = (errorLines.length > 0 ? errorLines : lines.slice(-15)).slice(-15);
	const deduped = [...new Set(selected)];

	return `${header}\n\n${deduped.join("\n")}`;
}

function quoteWindowsShellArgument(value: string): string {
	return `"${value.replaceAll('"', '\\"')}"`;
}

/**
 * A single runnable service within a fullstack project (e.g. .NET backend, Angular frontend).
 */
export interface AppEmulatorServiceConfig {
	/** Human-readable label shown in the UI (e.g. "Backend (.NET)", "Frontend (Angular)") */
	label: string;
	framework: string;
	startCommand: string;
	port: number;
	/** Absolute working directory for this service */
	projectDir: string;
	/** true = this is the API service; its URL becomes the base URL in API Studio */
	isPrimary: boolean;
}

/**
 * Detected project configuration for the App Emulator.
 */
export interface AppEmulatorConfig {
	type: string; // 'web' | 'cli' | 'desktop'
	framework: string; // 'vite' | 'next' | 'django' | 'flask' | etc.
	startCommand: string; // 'npm run dev', 'python manage.py runserver', etc.
	port: number; // primary port — API/backend port used by API Studio
	isWeb: boolean; // Whether the app can be previewed in an iframe
	projectDir?: string; // Resolved project directory (primary service)
	/** For fullstack projects: all services to launch (backend + frontend). */
	services?: AppEmulatorServiceConfig[];
}

/**
 * Service for App Emulator — manages dev server lifecycle.
 *
 * Events emitted:
 * - 'status' (status: string) — Status update message
 * - 'ready' (url: string) — Server is ready at URL
 * - 'output' (line: string) — Server stdout/stderr line
 * - 'error' (error: string) — Error message
 * - 'stopped' () — Server was stopped
 * - 'config' (config: AppEmulatorConfig) — Project detection result
 */
export class AppEmulatorService extends EventEmitter {
	private activeServerProcess: ChildProcess | null = null;
	private detectionProcess: ChildProcess | null = null;
	private currentConfig: AppEmulatorConfig | null = null;
	private serverUrl: string | null = null;
	private pythonPath = "python";
	private autoBuildSourcePath: string | null = null;
	/** Synchronous guard — prevents concurrent startServer calls (race condition on port check) */
	private startingInProgress = false;
	/** Tracks all service processes for multi-service (fullstack) mode */
	private readonly activeServiceProcesses = new Map<string, ChildProcess>();
	/** Maps original paths with spaces → junction paths without spaces (Windows only) */
	private readonly junctionMap = new Map<string, string>();
	/** Maps @ngtools/webpack index.js path → original file content (for patch rollback) */
	private readonly angularWebpackPatches = new Map<string, string>();

	/**
	 * Configure paths for Python and auto-claude source.
	 */
	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) {
			this.pythonPath = pythonPath;
		}
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Get the auto-build source path.
	 * Uses the same resolution strategy as agent-process.ts.
	 */
	private getAutoBuildSourcePath(): string | null {
		const markerPath = (p: string) =>
			path.join(p, "runners", "app_emulator_runner.py");

		// If manually configured AND valid, use that.
		if (
			this.autoBuildSourcePath &&
			existsSync(markerPath(this.autoBuildSourcePath))
		) {
			return this.autoBuildSourcePath;
		}

		const appPath = app.getAppPath();
		const possiblePaths = [
			// Packaged app: backend is in extraResources (process.resourcesPath/backend)
			...(app.isPackaged ? [path.join(process.resourcesPath, "backend")] : []),
			// Dev mode: from out/main -> ../../../backend (apps/frontend/out/main -> apps/backend)
			path.resolve(__dirname, "..", "..", "..", "backend"),
			// Sibling to asar (some packaged layouts)
			path.resolve(appPath, "..", "backend"),
			// macOS bundle structure
			path.resolve(appPath, "..", "..", "Resources", "backend"),
			// If running from repo root
			path.resolve(process.cwd(), "apps", "backend"),
		];

		for (const p of possiblePaths) {
			if (existsSync(markerPath(p))) {
				this.autoBuildSourcePath = p;
				return p;
			}
		}

		return null;
	}

	/**
	 * Detect project type. Uses fast inline JS detection first,
	 * falls back to Python runner for advanced cases.
	 */
	async detectProject(projectDirRaw: string): Promise<AppEmulatorConfig> {
		// Decode URI-encoded paths (e.g. spaces stored as %20)
		const projectDirInput = decodeURIComponent(projectDirRaw);

		if (!existsSync(projectDirInput)) {
			throw new Error(`Project directory not found: ${projectDirInput}`);
		}

		// If the configured directory is a WorkPilot workspace stub (contains .workpilot/
		// but no source files), resolve to a nearby directory that has real code.
		const projectDir = this.resolveSourceDir(projectDirInput);

		// Cancel any existing detection
		if (this.detectionProcess) {
			this.detectionProcess.kill();
			this.detectionProcess = null;
		}

		// Try fast inline JS detection first (no Python needed)
		const jsResult = this.detectProjectInline(projectDir);
		if (jsResult) {
			// Use subdirectory projectDir if detection found a nested project, otherwise use root
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			const resolvedProjectDir = (jsResult as any).projectDir || projectDir;
			const config: AppEmulatorConfig = {
				...jsResult,
				projectDir: resolvedProjectDir,
			};
			this.currentConfig = config;
			this.emit("config", config);
			return config;
		}

		// Fallback: Python runner
		return this.detectProjectViaPython(projectDir);
	}

	/**
	 * Check whether a directory looks like a runnable project root.
	 * Used to pick a real source dir when the configured project is a WorkPilot stub.
	 */
	private hasProjectMarkers(dir: string): boolean {
		try {
			const entries = readdirSync(dir);
			if (
				entries.includes("package.json") ||
				entries.includes("pyproject.toml") ||
				entries.includes("requirements.txt") ||
				entries.includes("manage.py") ||
				entries.includes("app.py") ||
				entries.includes("main.py") ||
				entries.includes("go.mod") ||
				entries.includes("Cargo.toml") ||
				entries.includes("Dockerfile") ||
				entries.includes("docker-compose.yml") ||
				entries.includes("docker-compose.yaml") ||
				entries.some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))
			) {
				return true;
			}
		} catch {
			/* ignore */
		}
		return false;
	}

	private isLikelyTestProjectPath(candidatePath: string): boolean {
		const segments = candidatePath
			.toLowerCase()
			.split(/[\\/]+/)
			.map((segment) => segment.replace(/\.csproj$/i, ""));
		return segments.some(
			(segment) =>
				segment === "tests" ||
				segment === "test" ||
				segment === "unittests" ||
				segment === "automatedtests" ||
				segment.endsWith(".tests") ||
				segment.endsWith(".test") ||
				segment.endsWith(".testapplication") ||
				segment.includes("testapplication"),
		);
	}

	private findSolutionStartupCsprojFile(solutionDir: string): string | null {
		let entries: string[];
		try {
			entries = readdirSync(solutionDir);
		} catch {
			return null;
		}

		const solutionFiles = entries
			.filter((entry) => entry.endsWith(".sln"))
			.filter((entry) => !this.isLikelyTestProjectPath(entry))
			.sort((left, right) => left.localeCompare(right));

		for (const solutionFile of solutionFiles) {
			const solutionPath = path.join(solutionDir, solutionFile);
			let content: string;
			try {
				content = readFileSync(solutionPath, "utf-8");
			} catch {
				continue;
			}

			const matches = content.matchAll(
				/Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gi,
			);
			for (const match of matches) {
				const relativeProjectPath = match[1];
				const csprojPath = path.resolve(solutionDir, relativeProjectPath);
				if (
					this.isLikelyTestProjectPath(csprojPath) ||
					!existsSync(csprojPath) ||
					this.isCsprojLibrary(csprojPath)
				) {
					continue;
				}
				return csprojPath;
			}
		}

		return null;
	}

	private findNestedProjectDir(rootDir: string, maxDepth: number): string | null {
		const skipDirs = new Set([
			".git",
			".workpilot",
			".vs",
			"bin",
			"obj",
			"node_modules",
			"packages",
			"TestResults",
			"dist",
			"build",
		]);
		const preferredNames = new Set(["src", "source", "sources", "app", "web"]);
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: rootDir, depth: 0 },
		];
		const candidates: Array<{ dir: string; score: number }> = [];

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || current.depth > maxDepth) continue;

			let entries: string[];
			try {
				entries = readdirSync(current.dir);
			} catch {
				continue;
			}

			if (current.dir !== rootDir && this.hasProjectMarkers(current.dir)) {
				const baseName = path.basename(current.dir).toLowerCase();
				const hasSolution = entries.some((entry) => entry.endsWith(".sln"));
				const hasCsproj = entries.some((entry) => entry.endsWith(".csproj"));
				const score =
					current.depth * 10 +
					(hasSolution ? 0 : hasCsproj ? 1 : 3) +
					(preferredNames.has(baseName) ? -2 : 0);
				candidates.push({ dir: current.dir, score });
				continue;
			}

			const directories = entries
				.filter(
					(entry) =>
						!entry.startsWith(".") &&
						!skipDirs.has(entry) &&
						!this.isLikelyTestProjectPath(entry),
				)
				.sort((left, right) => {
					const leftPreferred = preferredNames.has(left.toLowerCase()) ? 0 : 1;
					const rightPreferred = preferredNames.has(right.toLowerCase()) ? 0 : 1;
					return leftPreferred - rightPreferred || left.localeCompare(right);
				});

			for (const entry of directories) {
				const fullPath = path.join(current.dir, entry);
				try {
					if (statSync(fullPath).isDirectory()) {
						queue.push({ dir: fullPath, depth: current.depth + 1 });
					}
				} catch {
					/* ignore */
				}
			}
		}

		candidates.sort((left, right) => left.score - right.score);
		return candidates[0]?.dir ?? null;
	}

	/**
	 * If `projectDir` is a WorkPilot workspace stub (contains .workpilot/ but no
	 * actual source), try the parent and its sibling directories (preferring ones
	 * named Sources/src/source) before giving up and returning the original path.
	 */
	private resolveSourceDir(projectDir: string): string {
		if (this.hasProjectMarkers(projectDir)) return projectDir;

		const nestedProjectDir = this.findNestedProjectDir(projectDir, 5);
		if (nestedProjectDir) return nestedProjectDir;

		const hasWorkpilot = existsSync(path.join(projectDir, ".workpilot"));
		if (!hasWorkpilot) return projectDir;

		const parent = path.dirname(projectDir);
		if (!parent || parent === projectDir) return projectDir;

		if (this.hasProjectMarkers(parent)) return parent;

		let siblings: string[];
		try {
			siblings = readdirSync(parent);
		} catch {
			return projectDir;
		}

		const preferred = new Set(["sources", "src", "source"]);
		const ordered = siblings
			.filter((s) => path.join(parent, s) !== projectDir)
			.sort((a, b) => {
				const ap = preferred.has(a.toLowerCase()) ? 0 : 1;
				const bp = preferred.has(b.toLowerCase()) ? 0 : 1;
				return ap - bp;
			});

		for (const name of ordered) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const candidate = path.join(parent, name);
			try {
				if (!statSync(candidate).isDirectory()) continue;
			} catch {
				continue;
			}
			if (this.hasProjectMarkers(candidate)) return candidate;
		}

		return projectDir;
	}

	/**
	 * Fast inline detection — handles common project types without Python.
	 */
	private detectProjectInline(projectDir: string): AppEmulatorConfig | null {
		// Node.js / frontend projects
		const pkgPath = path.join(projectDir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const scripts = pkg.scripts ?? {};
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };

				let framework = "node";
				let type = "web";
				let port = 3000;

				if ("next" in deps) {
					framework = "next";
				} else if ("nuxt" in deps || "nuxt3" in deps) {
					framework = "nuxt";
				} else if ("react-scripts" in deps) {
					framework = "create-react-app";
				} else if ("vite" in deps) {
					framework = "vite";
					port = 5173;
				} else if ("@angular/core" in deps) {
					framework = "angular";
					port = 4200;
				} else if ("vue" in deps && !("vite" in deps)) {
					framework = "vue-cli";
					port = 8080;
				} else if ("svelte" in deps || "@sveltejs/kit" in deps) {
					framework = "svelte";
					port = 5173;
				} else if ("electron" in deps) {
					framework = "electron";
					type = "desktop";
					port = 0;
				}
				// Node.js API/backend frameworks
				else if ("@nestjs/core" in deps) {
					framework = "nestjs";
					port = 3000;
				} else if (
					"express" in deps ||
					"fastify" in deps ||
					"koa" in deps ||
					"hapi" in deps ||
					"@hapi/hapi" in deps
				) {
					framework = "express";
					port = 3000;
				}

				// Detect start command from scripts
				let startCommand = "";
				const pm = this.detectPackageManager(projectDir);
				for (const name of ["dev", "start:dev", "serve", "start"]) {
					if (name in scripts) {
						startCommand =
							name === "start" ? `${pm} start` : `${pm} run ${name}`;
						break;
					}
				}
				if (!startCommand && Object.keys(scripts).length > 0) {
					const first = Object.keys(scripts)[0];
					startCommand = `${pm} run ${first}`;
				}

				// For Angular, always use explicit --port so the port can be replaced
				// on conflict and to avoid Angular's interactive "use different port?" prompt.
				if (framework === "angular") {
					startCommand = `npx ng serve --port ${port}`;
				}

				// Pure frontend → look for a backend counterpart in subdirectories
				const PURE_FRONTEND = new Set([
					"angular",
					"vite",
					"svelte",
					"create-react-app",
					"vue-cli",
					"nuxt",
				]);
				if (PURE_FRONTEND.has(framework)) {
					const backendResult = this.findBackendInSubdirs(projectDir);
					if (backendResult) {
						return this.buildFullstackConfig(backendResult, {
							framework,
							startCommand,
							port,
							projectDir,
						});
					}
				}

				// Node.js backend → look for a frontend counterpart in subdirectories
				const NODE_BACKEND = new Set(["nestjs", "express"]);
				if (NODE_BACKEND.has(framework)) {
					const frontendResult = this.findFrontendInSubdirs(projectDir, 3);
					if (frontendResult) {
						const frontendDir = frontendResult.projectDir ?? projectDir;
						return this.buildFullstackConfig(
							{ framework, startCommand, port, projectDir },
							{
								framework: frontendResult.framework,
								startCommand: frontendResult.startCommand,
								port: frontendResult.port,
								projectDir: frontendDir,
							},
						);
					}
				}

				return { type, framework, startCommand, port, isWeb: type === "web" };
			} catch {
				// JSON parse error — skip
			}
		}

		// Python projects
		const hasPyproject = existsSync(path.join(projectDir, "pyproject.toml"));
		const hasRequirements = existsSync(
			path.join(projectDir, "requirements.txt"),
		);
		const hasManagePy = existsSync(path.join(projectDir, "manage.py"));
		const hasAppPy = existsSync(path.join(projectDir, "app.py"));
		const hasMainPy = existsSync(path.join(projectDir, "main.py"));

		if (
			hasPyproject ||
			hasRequirements ||
			hasManagePy ||
			hasAppPy ||
			hasMainPy
		) {
			let depsText = "";
			try {
				if (hasRequirements)
					depsText += readFileSync(
						path.join(projectDir, "requirements.txt"),
						"utf-8",
					).toLowerCase();
				if (hasPyproject)
					depsText +=
						"\n" +
						readFileSync(
							path.join(projectDir, "pyproject.toml"),
							"utf-8",
						).toLowerCase();
			} catch {
				/* ignore */
			}

			let backendCfg: {
				framework: string;
				startCommand: string;
				port: number;
				isWeb: boolean;
			} | null = null;
			if (hasManagePy || depsText.includes("django")) {
				backendCfg = {
					framework: "django",
					startCommand: "python manage.py runserver",
					port: 8000,
					isWeb: true,
				};
			} else if (depsText.includes("fastapi")) {
				backendCfg = {
					framework: "fastapi",
					startCommand: `uvicorn ${hasAppPy ? "app:app" : "main:app"} --reload --port 8000`,
					port: 8000,
					isWeb: true,
				};
			} else if (depsText.includes("flask")) {
				backendCfg = {
					framework: "flask",
					startCommand: `python ${hasAppPy ? "app.py" : "main.py"}`,
					port: 5000,
					isWeb: true,
				};
			} else if (depsText.includes("streamlit")) {
				backendCfg = {
					framework: "streamlit",
					startCommand: `streamlit run ${hasAppPy ? "app.py" : "main.py"}`,
					port: 8501,
					isWeb: true,
				};
			} else if (hasMainPy || hasAppPy) {
				backendCfg = {
					framework: "python",
					startCommand: `python ${hasMainPy ? "main.py" : "app.py"}`,
					port: 0,
					isWeb: false,
				};
			}

			if (backendCfg) {
				if (backendCfg.isWeb) {
					const frontendResult = this.findFrontendInSubdirs(projectDir, 3);
					if (frontendResult) {
						const frontendDir = frontendResult.projectDir ?? projectDir;
						return this.buildFullstackConfig(
							{ ...backendCfg, projectDir },
							{
								framework: frontendResult.framework,
								startCommand: frontendResult.startCommand,
								port: frontendResult.port,
								projectDir: frontendDir,
							},
						);
					}
				}
				return { type: backendCfg.isWeb ? "web" : "cli", ...backendCfg };
			}
		}

		// Go projects
		if (existsSync(path.join(projectDir, "go.mod"))) {
			const frontendResult = this.findFrontendInSubdirs(projectDir, 3);
			if (frontendResult) {
				const frontendDir = frontendResult.projectDir ?? projectDir;
				return this.buildFullstackConfig(
					{ framework: "go", startCommand: "go run .", port: 8080, projectDir },
					{
						framework: frontendResult.framework,
						startCommand: frontendResult.startCommand,
						port: frontendResult.port,
						projectDir: frontendDir,
					},
				);
			}
			return {
				type: "web",
				framework: "go",
				startCommand: "go run .",
				port: 8080,
				isWeb: true,
			};
		}

		// Rust projects
		if (existsSync(path.join(projectDir, "Cargo.toml"))) {
			return {
				type: "cli",
				framework: "rust",
				startCommand: "cargo run",
				port: 0,
				isWeb: false,
			};
		}

		// Docker projects
		if (
			existsSync(path.join(projectDir, "docker-compose.yml")) ||
			existsSync(path.join(projectDir, "docker-compose.yaml"))
		) {
			return {
				type: "web",
				framework: "docker-compose",
				startCommand: "docker-compose up",
				port: 3000,
				isWeb: true,
			};
		}
		if (existsSync(path.join(projectDir, "Dockerfile"))) {
			return {
				type: "web",
				framework: "docker",
				startCommand: "docker build -t app . && docker run -p 3000:3000 app",
				port: 3000,
				isWeb: true,
			};
		}

		// .NET projects (*.sln or *.csproj at root)
		try {
			const rootFiles = readdirSync(projectDir);
			const rootCsproj = rootFiles.find((file) => file.endsWith(".csproj"));
			if (rootFiles.some((f) => f.endsWith(".sln")) || rootCsproj) {
				// Find the .NET project directory (contains *.csproj) and read its HTTP port.
				// findDotnetProjectDir looks for a dir with a .csproj + Program.cs/Startup.cs.
				// If it returns null (e.g. multiple .csproj without a clear entry point), fall back
				// to locating any .csproj file and using its parent directory.
				const solutionCsproj = this.findSolutionStartupCsprojFile(projectDir);
				let dotnetDir = solutionCsproj
					? path.dirname(solutionCsproj)
					: this.findDotnetProjectDir(projectDir, 4);
				const csprojFile =
					solutionCsproj ??
					(rootCsproj && dotnetDir === projectDir
						? path.join(projectDir, rootCsproj)
						: this.findFirstCsprojFile(projectDir, 5));
				dotnetDir = dotnetDir ?? (csprojFile ? path.dirname(csprojFile) : projectDir);
				return this.buildDotnetConfig(projectDir, dotnetDir, csprojFile);
			}
		} catch {
			/* ignore */
		}

		// Last resort: scan subdirectories (up to 3 levels deep) for package.json
		const subResult = this.findFrontendInSubdirs(projectDir, 3);
		if (subResult) return subResult;

		return null;
	}

	/**
	 * Recursively search subdirectories for a frontend project (package.json with scripts).
	 */
	private findFrontendInSubdirs(
		dir: string,
		maxDepth: number,
	): AppEmulatorConfig | null {
		if (maxDepth <= 0) return null;

		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				// Skip hidden dirs, node_modules, and common non-project dirs
				if (
					entry.startsWith(".") ||
					entry === "node_modules" ||
					entry === "dist" ||
					entry === "build" ||
					entry === "bin" ||
					entry === "obj"
				)
					continue;

				const fullPath = path.join(dir, entry);
				try {
					if (!statSync(fullPath).isDirectory()) continue;
				} catch {
					continue;
				}

				// Check for package.json in this subdirectory
				const pkgPath = path.join(fullPath, "package.json");
				if (existsSync(pkgPath)) {
					try {
						const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
						const scripts = pkg.scripts ?? {};
						// Only consider it if it has dev/start scripts (not just a lockfile)
						if (Object.keys(scripts).length > 0) {
							// Only create deps object if there are actual dependencies
							const hasDeps =
								(pkg.dependencies &&
									Object.keys(pkg.dependencies).length > 0) ||
								(pkg.devDependencies &&
									Object.keys(pkg.devDependencies).length > 0);

							// Declare variables outside the conditional
							let framework = "node";
							let type = "web";
							let port = 3000;

							// Only proceed with framework detection if there are dependencies
							if (hasDeps) {
								const deps = { ...pkg.dependencies, ...pkg.devDependencies };
								if ("@angular/core" in deps) {
									framework = "angular";
									port = 4200;
								} else if ("next" in deps) {
									framework = "next";
								} else if ("nuxt" in deps || "nuxt3" in deps) {
									framework = "nuxt";
								} else if ("react-scripts" in deps) {
									framework = "create-react-app";
								} else if ("vite" in deps) {
									framework = "vite";
									port = 5173;
								} else if ("vue" in deps && !("vite" in deps)) {
									framework = "vue-cli";
									port = 8080;
								} else if ("svelte" in deps || "@sveltejs/kit" in deps) {
									framework = "svelte";
									port = 5173;
								} else if ("electron" in deps) {
									framework = "electron";
									type = "desktop";
									port = 0;
								}
							}
							// If no dependencies, defaults (node, web, 3000) are already set

							const pm = this.detectPackageManager(fullPath);
							let startCommand = "";
							for (const name of ["dev", "start:dev", "serve", "start"]) {
								if (name in scripts) {
									startCommand =
										name === "start" ? `${pm} start` : `${pm} run ${name}`;
									break;
								}
							}
							if (!startCommand) {
								const first = Object.keys(scripts)[0];
								startCommand = `${pm} run ${first}`;
							}

							// For Angular, always use explicit --port so the port can be replaced
							// on conflict and to avoid Angular's interactive "use different port?" prompt.
							if (framework === "angular") {
								startCommand = `npx ng serve --port ${port}`;
							}
							// Return config with projectDir pointing to the subdirectory where package.json lives
							return {
								type,
								framework,
								startCommand,
								port,
								isWeb: type === "web",
								projectDir: fullPath,
							};
						}
					} catch {
						/* ignore parse error */
					}
				}

				// Recurse deeper
				const deeper = this.findFrontendInSubdirs(fullPath, maxDepth - 1);
				if (deeper) return deeper;
			}
		} catch {
			/* ignore readdir error */
		}

		return null;
	}

	/**
	 * Check whether a .csproj file is a class library (not directly runnable).
	 *
	 * .NET SDK default OutputType rules (when <OutputType> is absent):
	 *   Microsoft.NET.Sdk        → Library  (class library — NOT runnable)
	 *   Microsoft.NET.Sdk.Web    → Exe      (ASP.NET Core / Web API — runnable)
	 *   Microsoft.NET.Sdk.Worker → Exe      (Worker service — runnable)
	 *   Microsoft.NET.Sdk.Razor  → Library  (Razor Class Library — NOT runnable)
	 */
	private isCsprojLibrary(csprojPath: string): boolean {
		try {
			const content = readFileSync(csprojPath, "utf-8");

			// Explicit <OutputType> wins over everything else
			if (/<OutputType>\s*Library\s*<\/OutputType>/i.test(content)) return true;
			if (/<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(content))
				return false;

			// Executable SDK types don't need an explicit OutputType=Exe
			if (/Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']/i.test(content))
				return false;
			if (/Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Worker["']/i.test(content))
				return false;

			// Microsoft.NET.Sdk (base SDK) without explicit OutputType → default is Library
			if (/Sdk\s*=\s*["']Microsoft\.NET\.Sdk["']/i.test(content)) return true;

			// Razor Class Library
			if (/Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Razor["']/i.test(content))
				return true;

			// Old-style / unknown project — can't determine; assume runnable
			return false;
		} catch {
			return false;
		}
	}

	private readCsprojContent(csprojPath: string): string {
		try {
			return readFileSync(csprojPath, "utf-8");
		} catch {
			return "";
		}
	}

	private isLegacyDotnetFrameworkProject(csprojPath: string): boolean {
		const content = this.readCsprojContent(csprojPath);
		return (
			/<TargetFrameworkVersion>\s*v4(?:\.\d+)?\s*<\/TargetFrameworkVersion>/i.test(
				content,
			) || /<TargetFramework>\s*net4\d+\s*<\/TargetFramework>/i.test(content)
		);
	}

	private isLegacyWebProject(csprojPath: string): boolean {
		const content = this.readCsprojContent(csprojPath);
		const projectDir = path.dirname(csprojPath);
		return (
			/\{349c5851-65df-11da-9384-00065b846f21\}/i.test(content) ||
			/Microsoft\.WebApplication\.targets/i.test(content) ||
			existsSync(path.join(projectDir, "Web.config")) ||
			existsSync(path.join(projectDir, "Global.asax"))
		);
	}

	private buildIisExpressCommand(projectDir: string, port: number): string {
		if (process.platform !== "win32") {
			const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
			const root = shellQuote(projectDir);
			const unavailable = shellQuote(IIS_EXPRESS_UNAVAILABLE_MESSAGE);
			return [
				"sh -lc",
				shellQuote(
					[
						"set -e",
						'IIS="$' + `{${IIS_EXPRESS_ENV}:-}"`,
						'if [ -n "$IIS" ] && [ ! -x "$IIS" ] && command -v "$IIS" >/dev/null 2>&1; then IIS="$(command -v "$IIS")"; fi',
						'if [ -z "$IIS" ] && command -v xsp4 >/dev/null 2>&1; then IIS="$(command -v xsp4)"; fi',
						'if [ -z "$IIS" ] && command -v xsp >/dev/null 2>&1; then IIS="$(command -v xsp)"; fi',
						`if [ -n "$IIS" ]; then "$IIS" --root ${root} --port ${port}; else echo ${unavailable} >&2; exit 127; fi`,
					].join("; "),
				),
			].join(" ");
		}

		const candidates = [
			process.env[IIS_EXPRESS_ENV],
			process.env["PROGRAMFILES(X86)"]
				? path.join(process.env["PROGRAMFILES(X86)"], "IIS Express", "iisexpress.exe")
				: null,
			process.env.ProgramFiles
				? path.join(process.env.ProgramFiles, "IIS Express", "iisexpress.exe")
				: null,
		]
			.filter((candidate): candidate is string => Boolean(candidate))
			.map(quotePowerShellSingle)
			.join(",");
		const psProjectDir = quotePowerShellSingle(projectDir);
		const psUnavailable = quotePowerShellSingle(IIS_EXPRESS_UNAVAILABLE_MESSAGE);
		return [
			"powershell",
			"-NoProfile",
			"-ExecutionPolicy Bypass",
			"-Command",
			`"$ErrorActionPreference='Stop'; $iis=$env:${IIS_EXPRESS_ENV}; if ($iis -and -not (Test-Path $iis)) { $cmd=Get-Command $iis -ErrorAction SilentlyContinue; if ($cmd) { $iis=$cmd.Source } }; if (-not $iis) { $known=@(${candidates}); $iis=$known | Where-Object { Test-Path $_ } | Select-Object -First 1 }; if (-not $iis) { $cmd=Get-Command iisexpress -ErrorAction SilentlyContinue; if ($cmd) { $iis=$cmd.Source } }; if (-not $iis) { $cmd=Get-Command xsp4 -ErrorAction SilentlyContinue; if ($cmd) { $iis=$cmd.Source } }; if (-not $iis) { $cmd=Get-Command xsp -ErrorAction SilentlyContinue; if ($cmd) { $iis=$cmd.Source } }; if (-not $iis) { throw ${psUnavailable} }; $hostName=[IO.Path]::GetFileNameWithoutExtension($iis); if ($hostName -ieq 'xsp' -or $hostName -ieq 'xsp4') { & $iis --root ${psProjectDir} --port ${port} } else { & $iis /path:${psProjectDir} /port:${port} }"`,
		].join(" ");
	}

	private readAssemblyName(csprojPath: string): string {
		const content = this.readCsprojContent(csprojPath);
		const assemblyMatch = content.match(/<AssemblyName>\s*([^<]+)\s*<\/AssemblyName>/i);
		if (assemblyMatch?.[1]) return assemblyMatch[1].trim();
		return path.basename(csprojPath, path.extname(csprojPath));
	}

	private findContainingSolutionDir(csprojPath: string): string {
		const normalizedCsprojPath = path.normalize(csprojPath).toLowerCase();
		let currentDir = path.dirname(csprojPath);
		for (let depth = 0; depth < 6; depth += 1) {
			let entries: string[];
			try {
				entries = readdirSync(currentDir);
			} catch {
				return `${path.dirname(csprojPath)}${path.sep}`;
			}
			for (const entry of entries.filter((file) => file.endsWith(".sln"))) {
				const content = this.readCsprojContent(path.join(currentDir, entry));
				const matches = content.matchAll(
					/Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gi,
				);
				for (const match of matches) {
					// Les chemins déclarés dans un .sln utilisent toujours le
					// séparateur Windows "\". Sur POSIX, path.resolve ne le traite
					// pas comme séparateur : on normalise donc vers path.sep.
					const relativeFromSolution = match[1].split(/[\\/]+/).join(path.sep);
					const candidatePath = path
						.resolve(currentDir, relativeFromSolution)
						.toLowerCase();
					if (path.normalize(candidatePath) === normalizedCsprojPath) {
						return `${currentDir}${path.sep}`;
					}
				}
			}
			const parentDir = path.dirname(currentDir);
			if (!parentDir || parentDir === currentDir) break;
			currentDir = parentDir;
		}
		return `${path.dirname(csprojPath)}${path.sep}`;
	}

	private writeLegacyDesktopPowerShellScript(
		csprojPath: string,
		assemblyName: string,
		solutionDir: string,
	): string {
		const projectDir = path.dirname(csprojPath);
		const scriptPath = path.join(projectDir, "obj", "workpilot-run-legacy-desktop.ps1");
		mkdirSync(path.dirname(scriptPath), { recursive: true });
		const script = String.raw`$ErrorActionPreference = 'Stop'
$projectPath = ${quotePowerShellSingle(csprojPath)}
$sourceProjectPath = ${quotePowerShellSingle(csprojPath)}
$sourceSolutionDir = ${quotePowerShellSingle(solutionDir)}
$relativeProjectPath = ${quotePowerShellSingle(path.relative(solutionDir, csprojPath))}
$solutionDir = $sourceSolutionDir
$binDir = ${quotePowerShellSingle(path.join(projectDir, "bin", "Debug"))}
$assemblyFilter = ${quotePowerShellSingle(`${assemblyName}.exe`)}
$knownMsbuild = @(${buildPowerShellKnownMsBuildArray()})
$shortSolutionLink = $null

try {
	$shortRoot = Join-Path ([IO.Path]::GetTempPath()) 'workpilot-msbuild'
	New-Item -ItemType Directory -Force -Path $shortRoot | Out-Null
	$shortSolutionLink = Join-Path $shortRoot ([Guid]::NewGuid().ToString('N').Substring(0, 12))
	New-Item -ItemType Junction -Path $shortSolutionLink -Target $sourceSolutionDir | Out-Null
	$projectPath = Join-Path $shortSolutionLink $relativeProjectPath
	$solutionDir = $shortSolutionLink + [IO.Path]::DirectorySeparatorChar
} catch {
	if ($shortSolutionLink -and (Test-Path $shortSolutionLink)) {
		Remove-Item $shortSolutionLink -Force -ErrorAction SilentlyContinue
	}
	$shortSolutionLink = $null
	$projectPath = $sourceProjectPath
	Write-Output "WorkPilot could not create short legacy build path: $($_.Exception.Message)"
}

$buildArgs = @(
	$projectPath,
	'/t:Build',
	'/nologo',
	'/v:minimal',
	'/clp:ErrorsOnly;Summary',
	'/p:Configuration=Debug',
	"/p:SolutionDir=$solutionDir",
	'${LEGACY_RESOURCE_PROPERTY}'
)

function Escape-Xml([string]$value) {
	return [System.Security.SecurityElement]::Escape($value)
}

function Compare-VersionLike([string]$left, [string]$right) {
	$leftParts = $left -split '[.-]' | ForEach-Object {
		$match = [regex]::Match($_, '^\d+')
		if ($match.Success) { [int]$match.Value } else { 0 }
	}
	$rightParts = $right -split '[.-]' | ForEach-Object {
		$match = [regex]::Match($_, '^\d+')
		if ($match.Success) { [int]$match.Value } else { 0 }
	}
	$maxLength = [Math]::Max($leftParts.Count, $rightParts.Count)
	for ($index = 0; $index -lt $maxLength; $index++) {
		$leftPart = if ($index -lt $leftParts.Count) { $leftParts[$index] } else { 0 }
		$rightPart = if ($index -lt $rightParts.Count) { $rightParts[$index] } else { 0 }
		if ($leftPart -ne $rightPart) { return ($leftPart - $rightPart) }
	}
	return 0
}

function Add-LegacyReference(
	[hashtable]$references,
	[string]$include,
	[string]$hintPath,
	[string]$packageVersion,
	[int]$frameworkScore
) {
	$key = $include.ToLowerInvariant()
	if (-not $references.ContainsKey($key) -or
		(Compare-VersionLike $packageVersion $references[$key].PackageVersion) -gt 0 -or
		((Compare-VersionLike $packageVersion $references[$key].PackageVersion) -eq 0 -and
			$frameworkScore -gt $references[$key].FrameworkScore)) {
		$references[$key] = [PSCustomObject]@{
			Include = $include
			HintPath = $hintPath
			PackageVersion = $packageVersion
			FrameworkScore = $frameworkScore
		}
	}
}

function Get-LegacyReferenceScore([string]$hintPath) {
	$parts = $hintPath.Replace('\', '/').Split('/')
	$libIndex = -1
	for ($index = 0; $index -lt $parts.Length; $index++) {
		if ($parts[$index].ToLowerInvariant() -eq 'lib') {
			$libIndex = $index
			break
		}
	}
	if ($libIndex -lt 0) { return 0 }
	if ($libIndex + 1 -ge $parts.Length -or $parts[$libIndex + 1].ToLowerInvariant().EndsWith('.dll')) {
		return 1600
	}
	$framework = $parts[$libIndex + 1].ToLowerInvariant()
	if ($framework -match '^net(\d+)$') {
		$version = $Matches[1]
		if ($version.Length -eq 2) { return 1000 + ([int]$version * 10) }
		return 1000 + [int]$version
	}
	if ($framework -match '^netstandard(\d+)(?:\.(\d+))?$') {
		$minor = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
		return 700 + ([int]$Matches[1] * 10) + $minor
	}
	if ($framework.StartsWith('portable')) { return 600 }
	if ($framework.StartsWith('netcoreapp')) { return 100 }
	return 200
}

function Should-CopyRuntimeReference([string]$hintPath) {
	$normalized = $hintPath.Replace('\', '/').ToLowerInvariant()
	return -not $normalized.Contains('/reference assemblies/') -and
		-not $normalized.Contains('/packs/netstandard.library.ref/')
}

function Find-NetStandardFacadePaths {
	$results = New-Object System.Collections.Generic.List[string]
	$candidates = @(
		'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades\netstandard.dll',
		'C:\Program Files\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades\netstandard.dll',
		'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2\Facades\netstandard.dll',
		'C:\Program Files\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2\Facades\netstandard.dll'
	)
	foreach ($candidate in $candidates) {
		if ((Test-Path $candidate) -and -not $results.Contains($candidate)) {
			$results.Add($candidate)
		}
	}
	$dotnetPackRoot = 'C:\Program Files\dotnet\packs\NETStandard.Library.Ref'
	if (Test-Path $dotnetPackRoot) {
		$pack = Get-ChildItem $dotnetPackRoot -Directory -ErrorAction SilentlyContinue |
			Sort-Object Name -Descending |
			Select-Object -First 1
		if ($pack) {
			$candidate = Join-Path $pack.FullName 'ref\netstandard2.1\netstandard.dll'
			if ((Test-Path $candidate) -and -not $results.Contains($candidate)) {
				$results.Add($candidate)
			}
		}
	}
	return $results
}

function Find-BuildToolAssemblyNames([string]$solutionDir) {
	$results = @{}
	Get-ChildItem -Path $solutionDir -Recurse -Include '*.licx','*.resx' -File -ErrorAction SilentlyContinue |
		Where-Object { $_.FullName -notmatch '\\(bin|obj|packages)\\' } |
		ForEach-Object {
			$content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
			if ($content) {
				[regex]::Matches($content, '(?:,\s*|name=")([A-Za-z_][A-Za-z0-9_.-]*)(?=\s*(?:,|"))') |
					ForEach-Object {
						$assemblyName = $_.Groups[1].Value.ToLowerInvariant()
						if ($assemblyName) { $results[$assemblyName] = $true }
					}
			}
			if ($_.Extension -ieq '.licx') {
				Get-Content $_.FullName -ErrorAction SilentlyContinue |
				ForEach-Object {
					$parts = $_.Split(',')
					if ($parts.Length -gt 1) {
						$assemblyName = $parts[1].Trim().ToLowerInvariant()
						if ($assemblyName) { $results[$assemblyName] = $true }
					}
				}
			}
		}
	return $results
}

function New-LegacyPackageReferencesTarget([string]$projectPath) {
	$projectDir = Split-Path $projectPath
	$assetsFiles = New-Object System.Collections.Generic.List[string]
	$primaryAssets = Join-Path $projectDir 'obj\project.assets.json'
	if (Test-Path $primaryAssets) { $assetsFiles.Add($primaryAssets) }
	Get-ChildItem -Path $solutionDir -Recurse -Filter 'project.assets.json' -File -ErrorAction SilentlyContinue |
		Where-Object { $_.FullName -notmatch '\\packages\\' } |
		ForEach-Object {
			if (-not $assetsFiles.Contains($_.FullName)) { $assetsFiles.Add($_.FullName) }
		}
	if ($assetsFiles.Count -eq 0) { return $null }

	$references = @{}
	foreach ($assets in $assetsFiles) {
		$json = Get-Content $assets -Raw | ConvertFrom-Json
		$packagesRoot = $json.project.restore.packagesPath
		if (-not $packagesRoot) { continue }
		foreach ($target in $json.targets.PSObject.Properties) {
			foreach ($package in $target.Value.PSObject.Properties) {
				$parts = $package.Name.Split('/')
				if ($parts.Length -lt 2) { continue }
				$packageRoot = Join-Path (Join-Path $packagesRoot $parts[0].ToLowerInvariant()) $parts[1]
				$libRoot = Join-Path $packageRoot 'lib'
				if ($parts[0].ToLowerInvariant().StartsWith('ebp.') -and (Test-Path $libRoot)) {
					Get-ChildItem -Path $libRoot -Recurse -Filter '*.dll' -File -ErrorAction SilentlyContinue |
						ForEach-Object {
							Add-LegacyReference $references ([IO.Path]::GetFileNameWithoutExtension($_.FullName)) $_.FullName $parts[1] (Get-LegacyReferenceScore $_.FullName)
						}
				}
				if ($null -ne $package.Value.compile) {
					foreach ($compile in $package.Value.compile.PSObject.Properties) {
						$relative = $compile.Name
						if ($relative -eq '_._' -or -not $relative.EndsWith('.dll')) { continue }
						$hintPath = Join-Path $packageRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
						if (-not (Test-Path $hintPath)) { continue }
						Add-LegacyReference $references ([IO.Path]::GetFileNameWithoutExtension($hintPath)) $hintPath $parts[1] (Get-LegacyReferenceScore $hintPath)
					}
				}
			}
		}
	}
	if ($references.Count -eq 0) { return $null }
	foreach ($facadePath in Find-NetStandardFacadePaths) {
		Add-LegacyReference $references 'netstandard' $facadePath '0' 2000
	}

	$lines = New-Object System.Collections.Generic.List[string]
	$lines.Add('<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">')
	$lines.Add('  <Target Name="WorkPilotSkipLegacyLicxResources" BeforeTargets="SplitResourcesByCulture">')
	$lines.Add('    <ItemGroup>')
	$lines.Add('      <EmbeddedResource Remove="@(EmbeddedResource)" Condition="''%(EmbeddedResource.Extension)'' == ''.licx''" />')
	$lines.Add('    </ItemGroup>')
	$lines.Add('  </Target>')
	$buildToolAssemblyNames = Find-BuildToolAssemblyNames $solutionDir
	$buildToolReferences = New-Object System.Collections.Generic.List[object]
	foreach ($reference in $references.Values) {
		if ($buildToolAssemblyNames.ContainsKey($reference.Include.ToLowerInvariant())) {
			$buildToolReferences.Add($reference)
		}
	}
	if ($buildToolReferences.Count -gt 0) {
		$lines.Add('  <Target Name="WorkPilotLegacyBuildToolReferencePath" BeforeTargets="CoreResGen;CompileLicxFiles">')
		$lines.Add('    <ItemGroup>')
		foreach ($reference in $buildToolReferences | Sort-Object HintPath) {
			$lines.Add('      <ReferencePath Include="' + (Escape-Xml $reference.HintPath) + '" />')
		}
		$lines.Add('    </ItemGroup>')
		$lines.Add('  </Target>')
	}
	$runtimeReferences = New-Object System.Collections.Generic.List[object]
	foreach ($reference in $references.Values) {
		if (Should-CopyRuntimeReference $reference.HintPath) {
			$runtimeReferences.Add($reference)
		}
	}
	if ($runtimeReferences.Count -gt 0) {
		$lines.Add('  <Target Name="WorkPilotCopyLegacyRuntimeDependencies" AfterTargets="CopyFilesToOutputDirectory" Condition="''$(OutputType)'' == ''Exe'' or ''$(OutputType)'' == ''WinExe''">')
		$lines.Add('    <ItemGroup>')
		foreach ($reference in $runtimeReferences | Sort-Object HintPath) {
			$lines.Add('      <_WorkPilotLegacyRuntimeDependency Include="' + (Escape-Xml $reference.HintPath) + '" />')
		}
		$lines.Add('      <_WorkPilotLegacyRuntimeDependency Include="%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\$(Configuration)\%(ProjectReference.Filename).dll" Condition="Exists(''%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\$(Configuration)\%(ProjectReference.Filename).dll'')" />')
		$lines.Add('    </ItemGroup>')
		$lines.Add('    <Copy SourceFiles="@(_WorkPilotLegacyRuntimeDependency)" DestinationFolder="$(TargetDir)" SkipUnchangedFiles="true" Condition="''$(TargetDir)'' != ''''" />')
		$lines.Add('  </Target>')
	}
	$lines.Add('  <Target Name="WorkPilotLegacyReferencePath" BeforeTargets="CoreCompile">')
	$lines.Add('    <ItemGroup>')
	foreach ($reference in $references.Values | Sort-Object HintPath) {
		$lines.Add('      <ReferencePath Include="' + (Escape-Xml $reference.HintPath) + '" />')
	}
	$lines.Add('      <ReferencePath Include="%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\$(Configuration)\%(ProjectReference.Filename).dll" Condition="Exists(''%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\$(Configuration)\%(ProjectReference.Filename).dll'')" />')
	$lines.Add('    </ItemGroup>')
	$lines.Add('  </Target>')
	$lines.Add('</Project>')
	$output = Join-Path $projectDir 'obj\workpilot-legacy-package-references.targets'
	[IO.File]::WriteAllLines($output, $lines)
	return $output
}

function Invoke-WithLegacyXmlNamespacePatch([scriptblock]$Action) {
	$backups = @{}
	Get-ChildItem -Path $solutionDir -Recurse -Filter '*.csproj' -File -ErrorAction SilentlyContinue |
		Where-Object { $_.FullName -notmatch '\\(bin|obj|packages)\\' } |
		ForEach-Object {
			$content = [IO.File]::ReadAllText($_.FullName)
			if ($content.Contains('xmlns=""')) {
				$backups[$_.FullName] = $content
				[IO.File]::WriteAllText($_.FullName, ($content -replace '\s+xmlns=""', ''))
			}
		}
	try {
		& $Action
	} finally {
		foreach ($path in $backups.Keys) {
			[IO.File]::WriteAllText($path, [string]$backups[$path])
		}
	}
}

function Throw-CompatibleMsBuildRequired {
	throw 'A compatible MSBuild 15+ / Roslyn C# compiler is required for this .NET Framework project. Install Visual Studio Build Tools 2017+ with MSBuild/.NET desktop build tools, set WORKPILOT_MSBUILD_PATH to that MSBuild.exe, or use a remote/VM runner. dotnet msbuild is disabled for this legacy desktop build because the installed .NET SDK fails on the AL task.'
}

function Find-LegacyMsBuild {
	$msbuild = $env:WORKPILOT_MSBUILD_PATH
	if ($msbuild -and -not (Test-Path $msbuild)) {
		$cmd = Get-Command $msbuild -ErrorAction SilentlyContinue
		if ($cmd) { $msbuild = $cmd.Source }
	}
	if ($msbuild -and [IO.Path]::GetFileNameWithoutExtension($msbuild) -ieq 'dotnet') {
		$msbuild = $null
	}
	if (-not $msbuild) {
		$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
		if (Test-Path $vswhere) {
			$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\MSBuild.exe' | Select-Object -First 1
			if (-not $msbuild) {
				$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
			}
		}
	}
	if (-not $msbuild) {
		$msbuild = $knownMsbuild | Where-Object { Test-Path $_ } | Select-Object -First 1
	}
	if (-not $msbuild) {
		$cmd = Get-Command msbuild -ErrorAction SilentlyContinue
		if ($cmd) { $msbuild = $cmd.Source }
	}
	if ($msbuild -and [IO.Path]::GetFileNameWithoutExtension($msbuild) -ieq 'dotnet') {
		return $null
	}
	return $msbuild
}

function Find-RoslynCscToolPath {
	$configured = $env:WORKPILOT_CSC_TOOL_PATH
	if ($configured -and (Test-Path (Join-Path $configured 'csc.exe'))) {
		return $configured
	}
	$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
	if (-not $dotnet) { return $null }
	$sdkLines = & $dotnet.Source --list-sdks 2>$null
	if (-not $sdkLines) { return $null }
	$candidates = New-Object System.Collections.Generic.List[object]
	foreach ($line in $sdkLines) {
		if ($line -match '^(\S+)\s+\[(.+)\]$') {
			$candidates.Add([PSCustomObject]@{
				Version = $Matches[1]
				Path = Join-Path (Join-Path $Matches[2] $Matches[1]) 'Roslyn\bincore'
			})
		}
	}
	foreach ($candidate in $candidates | Sort-Object Version -Descending) {
		if (Test-Path (Join-Path $candidate.Path 'csc.exe')) {
			return $candidate.Path
		}
	}
	return $null
}

function Find-SdkToolsPath {
	$configured = $env:WORKPILOT_SDK_TOOLS_PATH
	if ($configured -and (Test-Path (Join-Path $configured 'al.exe'))) {
		return $configured
	}
	$candidates = @(
		'C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools',
		'C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools\x64',
		'C:\Program Files\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools',
		'C:\Program Files\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools\x64',
		'C:\Program Files (x86)\Microsoft SDKs\Windows\v8.1A\bin\NETFX 4.5.1 Tools',
		'C:\Program Files (x86)\Microsoft SDKs\Windows\v8.1A\bin\NETFX 4.5.1 Tools\x64'
	)
	foreach ($candidate in $candidates) {
		if (Test-Path (Join-Path $candidate 'al.exe')) {
			return $candidate
		}
	}
	return $null
}

function Should-UseExternalRoslynCompiler([string]$msbuild) {
	$normalized = $msbuild.Replace('\', '/').ToLowerInvariant()
	return $normalized.Contains('/windows/microsoft.net/framework') -or
		$normalized.Contains('/msbuild/14.0/')
}

$exe = $null
try {
	$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
	if ($dotnet) {
		try {
			& $dotnet.Source restore $projectPath "/p:SolutionDir=$solutionDir"
		} catch {
			Write-Output "WorkPilot legacy restore failed: $($_.Exception.Message)"
		}
	}
	try {
		$referencesTarget = New-LegacyPackageReferencesTarget $projectPath
		if ($referencesTarget) {
			$buildArgs += "/p:CustomBeforeMicrosoftCommonTargets=$referencesTarget"
		}
	} catch {
		Write-Output "WorkPilot legacy import preparation failed: $($_.Exception.Message)"
	}

	$msbuild = Find-LegacyMsBuild
	if ($msbuild) {
		$roslynCscToolPath = Find-RoslynCscToolPath
		if ($roslynCscToolPath -and (Should-UseExternalRoslynCompiler $msbuild)) {
			$buildArgs += "/p:CscToolPath=$roslynCscToolPath"
			$buildArgs += '/p:CscToolExe=csc.exe'
		}
		$sdkToolsPath = Find-SdkToolsPath
		if ($sdkToolsPath -and (Should-UseExternalRoslynCompiler $msbuild)) {
			$buildArgs += "/p:TargetFrameworkSDKToolsDirectory=$sdkToolsPath"
		}
		# Le patch xmlns="" est appliqué de façon proactive : les projets legacy
		# EBP contiennent des éléments <Compile ... xmlns=""> qui déclenchent
		# MSB4097. On nettoie avant le build pour éviter un double build.
		$script:buildExit = 0
		$output = Invoke-WithLegacyXmlNamespacePatch {
			& $msbuild @buildArgs 2>&1
			$script:buildExit = $LASTEXITCODE
		}
		$output | Write-Output
		if ($script:buildExit -ne 0) {
			if (($output -join [Environment]::NewLine) -match 'CS1617|Option .+ langversion|Invalid option.*/langversion') {
				Throw-CompatibleMsBuildRequired
			}
			exit $script:buildExit
		}
	} else {
		$exe = Get-ChildItem -Path $binDir -Recurse -Filter $assemblyFilter -ErrorAction SilentlyContinue | Select-Object -First 1
		if (-not $exe) {
			throw ${quotePowerShellSingle(LEGACY_MSBUILD_UNAVAILABLE_MESSAGE)}
		}
	}
	$exe = Get-ChildItem -Path $binDir -Recurse -Filter $assemblyFilter -ErrorAction SilentlyContinue | Select-Object -First 1
} finally {
	if ($shortSolutionLink -and (Test-Path $shortSolutionLink)) {
		[IO.Directory]::Delete($shortSolutionLink)
	}
}

if (-not $exe) { throw 'No executable produced' }
# Les applications client lourd EBP exigent les droits administrateur (réparation
# de la base de registre). On élève via Start-Process -Verb RunAs (UAC).
$launched = Start-Process -FilePath $exe.FullName -WorkingDirectory $exe.DirectoryName -Verb RunAs -PassThru
$launched.WaitForExit()
exit $launched.ExitCode
`;
		writeFileSync(scriptPath, script, "utf-8");
		return scriptPath;
	}

	private buildLegacyDesktopCommand(csprojPath: string): string {
		const projectDir = path.dirname(csprojPath);
		const assemblyName = this.readAssemblyName(csprojPath);
		const solutionDir = this.findContainingSolutionDir(csprojPath);
		ensureLegacyWorktreeBuildAssets(solutionDir, (message) =>
			this.emit("output", message),
		);
		const referencesTarget = createLegacyPackageReferencesTarget(csprojPath, solutionDir);
		const buildArgs = [
			"/t:Build",
			"/nologo",
			"/v:minimal",
			"/clp:ErrorsOnly;Summary",
			"/p:Configuration=Debug",
			`/p:SolutionDir=${solutionDir}`,
			LEGACY_RESOURCE_PROPERTY,
			...(referencesTarget
				? [`/p:CustomBeforeMicrosoftCommonTargets=${referencesTarget}`]
				: []),
		];
		if (process.platform !== "win32") {
			const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
			const shBuildPath = shellQuote(csprojPath);
			const shBuildArgs = buildArgs.map(shellQuote).join(" ");
			const shBinDir = shellQuote(path.join(projectDir, "bin", "Debug"));
			const shAssemblyName = shellQuote(`${assemblyName}.exe`);
			const shBuildError = shellQuote(LEGACY_MSBUILD_UNAVAILABLE_MESSAGE);
			const shRuntimeError = shellQuote(WINDOWS_RUNTIME_UNAVAILABLE_MESSAGE);
			return [
				"sh -lc",
				shellQuote(
					[
						"set -e",
						'MSBUILD="$' + '{WORKPILOT_MSBUILD_PATH:-}"',
						'if [ -n "$MSBUILD" ] && [ ! -x "$MSBUILD" ] && command -v "$MSBUILD" >/dev/null 2>&1; then MSBUILD="$(command -v "$MSBUILD")"; fi',
						'if [ -z "$MSBUILD" ] && command -v msbuild >/dev/null 2>&1; then MSBUILD="$(command -v msbuild)"; fi',
						'if [ -z "$MSBUILD" ] && command -v xbuild >/dev/null 2>&1; then MSBUILD="$(command -v xbuild)"; fi',
						`EXE="$(find ${shBinDir} -name ${shAssemblyName} -print -quit)"`,
						'if [ -n "$MSBUILD" ] && [ "$(basename "$MSBUILD" .exe)" = "dotnet" ] && [ -z "$EXE" ]; then echo ' +
							`${shBuildError} >&2; exit 127; fi`,
						`if [ -n "$MSBUILD" ] && [ "$(basename "$MSBUILD" .exe)" != "dotnet" ]; then set +e; BUILD_OUTPUT="$("$MSBUILD" ${shBuildPath} ${shBuildArgs} 2>&1)"; BUILD_EXIT=$?; set -e; printf '%s\\n' "$BUILD_OUTPUT"; if [ "$BUILD_EXIT" -ne 0 ]; then if printf '%s' "$BUILD_OUTPUT" | grep -q MSB4097; then echo "A compatible MSBuild/Mono build tool is required for this legacy .NET Framework project; dotnet msbuild is disabled for desktop legacy builds. Configure WORKPILOT_MSBUILD_PATH or use a remote/VM runner." >&2; fi; exit "$BUILD_EXIT"; fi; EXE="$(find ${shBinDir} -name ${shAssemblyName} -print -quit)"; fi`,
						`if [ -z "$EXE" ] && [ -z "$MSBUILD" ]; then echo ${shBuildError} >&2; exit 127; fi`,
						'if [ -z "$EXE" ]; then echo "No executable produced" >&2; exit 1; fi',
						'if command -v mono >/dev/null 2>&1; then mono "$EXE"; elif command -v wine >/dev/null 2>&1; then wine "$EXE"; else echo ' +
							`${shRuntimeError} >&2; exit 127; fi`,
					].join("; "),
				),
			].join(" ");
		}
		const scriptPath = this.writeLegacyDesktopPowerShellScript(
			csprojPath,
			assemblyName,
			solutionDir,
		);
		return [
			"powershell",
			"-NoProfile",
			"-ExecutionPolicy Bypass",
			"-File",
			quoteWindowsShellArgument(scriptPath),
		].join(" ");
	}

	private buildDotnetConfig(
		rootDir: string,
		dotnetDir: string,
		csprojPath: string | null,
	): AppEmulatorConfig {
		if (csprojPath && this.isLegacyDotnetFrameworkProject(csprojPath)) {
			const port = this.readDotnetPort(dotnetDir) ?? 8080;
			if (this.isLegacyWebProject(csprojPath)) {
				return {
					type: "web",
					framework: "dotnet-framework-iis-express",
					startCommand: this.buildIisExpressCommand(dotnetDir, port),
					port,
					isWeb: true,
					projectDir: dotnetDir,
				};
			}
			return {
				type: "desktop",
				framework: "dotnet-framework-desktop",
				startCommand: this.buildLegacyDesktopCommand(csprojPath),
				port: 0,
				isWeb: false,
				projectDir: dotnetDir,
			};
		}

		const dotnetPort = this.readDotnetPort(dotnetDir) ?? 5000;
		const frontendResult = this.findFrontendInSubdirs(rootDir, 3);

		if (frontendResult) {
			const frontendDir = frontendResult.projectDir ?? rootDir;
			return this.buildFullstackConfig(
				{
					framework: "dotnet",
					startCommand: "dotnet run",
					port: dotnetPort,
					projectDir: dotnetDir,
				},
				{
					framework: frontendResult.framework,
					startCommand: frontendResult.startCommand,
					port: frontendResult.port,
					projectDir: frontendDir,
				},
			);
		}

		return {
			type: "web",
			framework: "dotnet",
			startCommand: "dotnet run",
			port: dotnetPort,
			isWeb: true,
			projectDir: dotnetDir,
		};
	}

	private parseStartCommand(startCommand: string): {
		cmd: string;
		args: string[];
		shell?: boolean;
	} {
		const useShell =
			process.platform === "win32" ||
			/["'|&;<>()$]/.test(startCommand) ||
			startCommand.startsWith("sh -lc ") ||
			startCommand.startsWith("bash -lc ");
		if (useShell) {
			return { cmd: startCommand, args: [], shell: true };
		}
		const [cmd, ...args] = startCommand.split(" ");
		return { cmd, args };
	}

	/**
	 * Find the directory that should be used as cwd for `dotnet run`.
	 * Priority:
	 *   1. Dir with .csproj + Program.cs/Startup.cs  (definite executable)
	 *   2. Dir with .csproj that is not a Library     (executable without runtime file)
	 *   3. Any dir with .csproj                       (last resort fallback)
	 * Searches up to maxDepth levels.
	 */
	private findDotnetProjectDir(
		rootDir: string,
		maxDepth: number,
	): string | null {
		const skipDirs = new Set([
			"node_modules",
			"bin",
			"obj",
			"dist",
			"build",
			".git",
			".vs",
			"packages",
			"TestResults",
		]);
		let fallbackDir: string | null = null; // best dir when no perfect match found

		const scan = (dir: string, depth: number): string | null => {
			if (depth < 0) return null;
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return null;
			}

			const csprojsHere = entries.filter(
				(f) => f.endsWith(".csproj") && !this.isLikelyTestProjectPath(f),
			);
			if (csprojsHere.length > 0) {
				// Tier 1 — has runtime entry point (Program.cs / Startup.cs)
				const hasRuntime = entries.some(
					(f) =>
						f === "Program.cs" ||
						f === "program.cs" ||
						f === "Startup.cs" ||
						f === "startup.cs",
				);
				if (hasRuntime) return dir;

				// Tier 2 — at least one .csproj is executable (not a library)
				const executableCsprojs = csprojsHere.filter(
					(f) => !this.isCsprojLibrary(path.join(dir, f)),
				);
				if (executableCsprojs.length > 0) return dir;

				// All .csproj here are libraries — remember as last-resort fallback
				if (!fallbackDir) fallbackDir = dir;
			}

			for (const entry of entries) {
				if (
					entry.startsWith(".") ||
					skipDirs.has(entry) ||
					this.isLikelyTestProjectPath(entry)
				)
					continue;
				const fullPath = path.join(dir, entry);
				try {
					if (!statSync(fullPath).isDirectory()) continue;
				} catch {
					continue;
				}
				const found = scan(fullPath, depth - 1);
				if (found) return found;
			}
			return null;
		};

		const result = scan(rootDir, maxDepth);
		const finalResult = result ?? fallbackDir;
		return finalResult;
	}

	/**
	 * Last-resort fallback: find the path to the first executable (non-Library) .csproj in the tree.
	 * If no executable .csproj is found, returns any .csproj (excluding test projects).
	 */
	private findFirstCsprojFile(
		rootDir: string,
		maxDepth: number,
	): string | null {
		const skipDirs = new Set([
			"node_modules",
			"bin",
			"obj",
			"dist",
			"build",
			".git",
			".vs",
			"packages",
			"TestResults",
		]);
		let libraryFallback: string | null = null; // fallback if only libraries found

		const scan = (dir: string, depth: number): string | null => {
			if (depth < 0) return null;
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return null;
			}

			const csprojs = entries.filter(
				(f) => f.endsWith(".csproj") && !this.isLikelyTestProjectPath(f),
			);
			for (const csproj of csprojs) {
				const fullPath = path.join(dir, csproj);
				if (!this.isCsprojLibrary(fullPath)) return fullPath; // executable → use it
				if (!libraryFallback) libraryFallback = fullPath; // library → remember as fallback
			}

			for (const entry of entries) {
				if (
					entry.startsWith(".") ||
					skipDirs.has(entry) ||
					this.isLikelyTestProjectPath(entry)
				)
					continue;
				const fullPath = path.join(dir, entry);
				try {
					if (!statSync(fullPath).isDirectory()) continue;
				} catch {
					continue;
				}
				const found = scan(fullPath, depth - 1);
				if (found) return found;
			}
			return null;
		};

		return scan(rootDir, maxDepth) ?? libraryFallback;
	}

	/**
	 * Read the HTTP port from launchSettings.json in a .NET project directory.
	 * Prefers http:// over https:// to avoid certificate issues.
	 */
	private readDotnetPort(csprojDir: string): number | null {
		const launchSettingsPath = path.join(
			csprojDir,
			"Properties",
			"launchSettings.json",
		);
		if (!existsSync(launchSettingsPath)) return null;
		try {
			const settings = JSON.parse(readFileSync(launchSettingsPath, "utf-8"));
			for (const profile of Object.values(settings.profiles ?? {})) {
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const url: string | undefined = (profile as any).applicationUrl;
				if (!url) continue;
				const httpMatch = url.match(/http:\/\/[^;:]+:(\d+)/);
				if (httpMatch) return parseInt(httpMatch[1], 10);
				const httpsMatch = url.match(/https:\/\/[^;:]+:(\d+)/);
				if (httpsMatch) return parseInt(httpsMatch[1], 10);
			}
		} catch {
			/* ignore */
		}
		return null;
	}

	/**
	 * Detect if a specific directory contains a backend server.
	 * Returns config if found, null otherwise.
	 */
	private detectBackendAt(dir: string): {
		framework: string;
		startCommand: string;
		port: number;
		projectDir?: string;
	} | null {
		// Python
		const hasManagePy = existsSync(path.join(dir, "manage.py"));
		const hasAppPy = existsSync(path.join(dir, "app.py"));
		const hasMainPy = existsSync(path.join(dir, "main.py"));
		const hasRequirements = existsSync(path.join(dir, "requirements.txt"));
		const hasPyproject = existsSync(path.join(dir, "pyproject.toml"));
		if (
			hasPyproject ||
			hasRequirements ||
			hasManagePy ||
			hasAppPy ||
			hasMainPy
		) {
			let depsText = "";
			try {
				if (hasRequirements)
					depsText += readFileSync(
						path.join(dir, "requirements.txt"),
						"utf-8",
					).toLowerCase();
				if (hasPyproject)
					depsText += readFileSync(
						path.join(dir, "pyproject.toml"),
						"utf-8",
					).toLowerCase();
			} catch {
				/* ignore */
			}
			if (hasManagePy || depsText.includes("django"))
				return {
					framework: "django",
					startCommand: "python manage.py runserver",
					port: 8000,
				};
			if (depsText.includes("fastapi"))
				return {
					framework: "fastapi",
					startCommand: `uvicorn ${hasAppPy ? "app:app" : "main:app"} --reload --port 8000`,
					port: 8000,
				};
			if (depsText.includes("flask"))
				return {
					framework: "flask",
					startCommand: `python ${hasAppPy ? "app.py" : "main.py"}`,
					port: 5000,
				};
			if ((hasMainPy || hasAppPy) && !depsText.includes("streamlit"))
				return {
					framework: "python",
					startCommand: `python ${hasMainPy ? "main.py" : "app.py"}`,
					port: 8000,
				};
		}
		// Go
		if (existsSync(path.join(dir, "go.mod")))
			return { framework: "go", startCommand: "go run .", port: 8080 };
		// Rust
		if (existsSync(path.join(dir, "Cargo.toml")))
			return { framework: "rust", startCommand: "cargo run", port: 8080 };
		// .NET: check this dir AND one level of subdirs (covers nested project layouts)
		try {
			const entries = readdirSync(dir);
			const csproj = entries.find((f) => f.endsWith(".csproj"));
			if (csproj) {
				const config = this.buildDotnetConfig(dir, dir, path.join(dir, csproj));
				return {
					framework: config.framework,
					startCommand: config.startCommand,
					port: config.port,
					projectDir: config.projectDir,
				};
			}
			// One level deeper (e.g. solution root → project subdir)
			for (const entry of entries) {
				if (
					entry.startsWith(".") ||
					entry === "node_modules" ||
					entry === "bin" ||
					entry === "obj"
				)
					continue;
				const sub = path.join(dir, entry);
				try {
					if (!statSync(sub).isDirectory()) continue;
					const subCsproj = readdirSync(sub).find((f) => f.endsWith(".csproj"));
					if (subCsproj) {
						const config = this.buildDotnetConfig(
							dir,
							sub,
							path.join(sub, subCsproj),
						);
						return {
							framework: config.framework,
							startCommand: config.startCommand,
							port: config.port,
							projectDir: config.projectDir,
						};
					}
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
		// Node.js API frameworks (express, fastify, nestjs, etc.)
		const pkgPath = path.join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };
				// Skip if it's clearly a frontend project
				if (
					"@angular/core" in deps ||
					"react-scripts" in deps ||
					"@sveltejs/kit" in deps
				)
					return null;
				if ("@nestjs/core" in deps) {
					const pm = this.detectPackageManager(dir);
					const scripts = pkg.scripts ?? {};
					const cmd =
						"start:dev" in scripts ? `${pm} run start:dev` : `${pm} run dev`;
					return { framework: "nestjs", startCommand: cmd, port: 3000 };
				}
				if (
					"express" in deps ||
					"fastify" in deps ||
					"koa" in deps ||
					"hapi" in deps ||
					"@hapi/hapi" in deps
				) {
					const pm = this.detectPackageManager(dir);
					const scripts = pkg.scripts ?? {};
					const cmd =
						"dev" in scripts
							? `${pm} run dev`
							: "start:dev" in scripts
								? `${pm} run start:dev`
								: `${pm} start`;
					return { framework: "express", startCommand: cmd, port: 3000 };
				}
			} catch {
				/* ignore */
			}
		}
		return null;
	}

	/**
	 * Scan subdirectories for a backend server.
	 * Prioritises common backend folder names (backend, server, api, etc.).
	 */
	private findBackendInSubdirs(
		rootDir: string,
		maxDepth = 2,
	): {
		framework: string;
		startCommand: string;
		port: number;
		projectDir: string;
	} | null {
		if (maxDepth <= 0) return null;
		const skipDirs = new Set([
			"node_modules",
			"dist",
			"build",
			".git",
			"bin",
			"obj",
			"public",
			"static",
			"assets",
			"coverage",
		]);
		const backendHints = new Set([
			"backend",
			"server",
			"api",
			"service",
			"services",
			"app",
			"src",
		]);
		try {
			const entries = readdirSync(rootDir);
			// Prioritise entries that look like backend directories
			const sorted = [
				...entries.filter((e) => backendHints.has(e.toLowerCase())),
				...entries.filter((e) => !backendHints.has(e.toLowerCase())),
			];
			for (const entry of sorted) {
				if (entry.startsWith(".") || skipDirs.has(entry)) continue;
				const fullPath = path.join(rootDir, entry);
				try {
					if (!statSync(fullPath).isDirectory()) continue;
				} catch {
					continue;
				}
				const result = this.detectBackendAt(fullPath);
				if (result) return { ...result, projectDir: fullPath };
			}
			if (maxDepth > 1) {
				for (const entry of sorted) {
					if (entry.startsWith(".") || skipDirs.has(entry)) continue;
					const fullPath = path.join(rootDir, entry);
					try {
						if (!statSync(fullPath).isDirectory()) continue;
					} catch {
						continue;
					}
					const deeper = this.findBackendInSubdirs(fullPath, maxDepth - 1);
					if (deeper) return deeper;
				}
			}
		} catch {
			/* ignore */
		}
		return null;
	}

	/**
	 * Build a fullstack multi-service config from a detected backend and frontend.
	 * The backend is always the primary service (API Studio base URL).
	 */
	private buildFullstackConfig(
		backend: {
			framework: string;
			startCommand: string;
			port: number;
			projectDir: string;
		},
		frontend: {
			framework: string;
			startCommand: string;
			port: number;
			projectDir: string;
		},
	): AppEmulatorConfig {
		return {
			type: "web",
			framework: backend.framework,
			startCommand: backend.startCommand,
			port: backend.port,
			isWeb: true,
			projectDir: backend.projectDir,
			services: [
				{
					label: `Backend (${backend.framework})`,
					framework: backend.framework,
					startCommand: backend.startCommand,
					port: backend.port,
					projectDir: backend.projectDir,
					isPrimary: true,
				},
				{
					label: `Frontend (${frontend.framework})`,
					framework: frontend.framework,
					startCommand: frontend.startCommand,
					port: frontend.port,
					projectDir: frontend.projectDir,
					isPrimary: false,
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} as any;
	}

	/**
	 * Detect the package manager from lock files.
	 */
	private detectPackageManager(projectDir: string): string {
		if (existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
		if (existsSync(path.join(projectDir, "yarn.lock"))) return "yarn";
		if (
			existsSync(path.join(projectDir, "bun.lockb")) ||
			existsSync(path.join(projectDir, "bun.lock"))
		)
			return "bun";
		return "npm";
	}

	/**
	 * Ensure Node.js project dependencies are installed.
	 * Runs `{packageManager} install` if package.json exists but node_modules is missing.
	 */
	private ensureDependenciesInstalled(
		projectDir: string,
		label?: string,
	): Promise<void> {
		const prefix = label ? `[${label}] ` : "";
		const packageJsonPath = path.join(projectDir, "package.json");
		const nodeModulesPath = path.join(projectDir, "node_modules");

		if (!existsSync(packageJsonPath)) return Promise.resolve();
		if (existsSync(nodeModulesPath)) return Promise.resolve();

		const pm = this.detectPackageManager(projectDir);
		const isWindows = process.platform === "win32";

		this.emit("status", `${prefix}Installing dependencies with ${pm}...`);
		this.emit(
			"output",
			`${prefix}node_modules not found — running "${pm} install"...`,
		);

		return new Promise<void>((resolve, reject) => {
			const proc = spawn(pm, ["install"], {
				cwd: projectDir,
				env: process.env as Record<string, string>,
				shell: isWindows ? true : undefined,
				stdio: ["ignore", "pipe", "pipe"],
			});
			proc.stdout?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `${prefix}${line}`);
				}
			});
			proc.stderr?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `${prefix}${line}`);
				}
			});
			proc.on("error", (err) =>
				reject(
					new Error(`${prefix}Failed to run "${pm} install": ${err.message}`),
				),
			);
			proc.on("close", (code) => {
				if (code === 0) {
					this.emit("output", `${prefix}Dependencies installed successfully.`);
					resolve();
				} else {
					reject(
						new Error(`${prefix}"${pm} install" exited with code ${code}`),
					);
				}
			});
		});
	}

	/**
	 * Ensure Python project dependencies are installed.
	 * Skips if a virtual environment already exists.
	 * Supports: pip (requirements.txt), poetry, uv, pipenv.
	 */
	private ensurePythonDependenciesInstalled(
		projectDir: string,
		label?: string,
	): Promise<void> {
		const prefix = label ? `[${label}] ` : "";

		// If a virtual environment already exists, assume deps are installed.
		const venvMarkers = [".venv", "venv", "env", ".env"];
		const hasVenv = venvMarkers.some(
			(d) =>
				existsSync(path.join(projectDir, d, "lib")) || // Unix
				existsSync(path.join(projectDir, d, "Lib")), // Windows
		);
		if (hasVenv) return Promise.resolve();

		// Detect Python package manager by lock/config files (most specific first).
		const hasPoetryLock = existsSync(path.join(projectDir, "poetry.lock"));
		const hasUvLock = existsSync(path.join(projectDir, "uv.lock"));
		const hasPipfileLock = existsSync(path.join(projectDir, "Pipfile.lock"));
		const hasRequirements = existsSync(
			path.join(projectDir, "requirements.txt"),
		);
		const hasPyproject = existsSync(path.join(projectDir, "pyproject.toml"));

		let installCmd: string | null = null;
		if (hasPoetryLock) installCmd = "poetry install";
		else if (hasUvLock) installCmd = "uv sync";
		else if (hasPipfileLock) installCmd = "pipenv install";
		else if (hasRequirements) installCmd = "pip install -r requirements.txt";
		else if (hasPyproject) installCmd = "pip install -e .";

		if (!installCmd) return Promise.resolve();

		const isWindows = process.platform === "win32";
		this.emit("status", `${prefix}Installing Python dependencies...`);
		this.emit(
			"output",
			`${prefix}No virtual environment found — running "${installCmd}"...`,
		);

		return new Promise<void>((resolve, reject) => {
			const [cmd, ...args] = installCmd?.split(" ") || [];
			const proc = spawn(cmd, args, {
				cwd: projectDir,
				env: process.env as Record<string, string>,
				shell: isWindows ? true : undefined,
				stdio: ["ignore", "pipe", "pipe"],
			});
			proc.stdout?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `${prefix}${line}`);
				}
			});
			proc.stderr?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `${prefix}${line}`);
				}
			});
			proc.on("error", (err) =>
				reject(
					new Error(`${prefix}Failed to run "${installCmd}": ${err.message}`),
				),
			);
			proc.on("close", (code) => {
				if (code === 0) {
					this.emit(
						"output",
						`${prefix}Python dependencies installed successfully.`,
					);
					resolve();
				} else {
					reject(
						new Error(`${prefix}"${installCmd}" exited with code ${code}`),
					);
				}
			});
		});
	}

	/**
	 * Fallback: Detect project type via Python runner.
	 */
	private detectProjectViaPython(
		projectDir: string,
	): Promise<AppEmulatorConfig> {
		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			throw new Error(`Could not detect project type in: ${projectDir}`);
		}

		const runnerPath = path.join(
			autoBuildSource,
			"runners",
			"app_emulator_runner.py",
		);
		if (!existsSync(runnerPath)) {
			throw new Error(`Could not detect project type in: ${projectDir}`);
		}

		return new Promise((resolve, reject) => {
			const proc = spawn(
				this.pythonPath,
				[runnerPath, "--project-dir", projectDir],
				{
					cwd: autoBuildSource,
					env: { ...process.env } as Record<string, string>,
				},
			);

			this.detectionProcess = proc;
			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString("utf-8");
			});

			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString("utf-8");
			});

			proc.on("close", (code) => {
				this.detectionProcess = null;

				// Parse the result from stdout
				const marker = "__APP_EMULATOR_RESULT__:";
				const markerIdx = stdout.indexOf(marker);

				if (markerIdx >= 0) {
					try {
						const jsonStr = stdout.substring(markerIdx + marker.length).trim();
						const result = JSON.parse(jsonStr);

						if (result.success) {
							const config: AppEmulatorConfig = {
								type: result.type,
								framework: result.framework,
								startCommand: result.startCommand,
								port: result.port,
								isWeb: result.isWeb,
								projectDir,
							};
							this.currentConfig = config;
							this.emit("config", config);
							resolve(config);
						} else {
							reject(
								new Error(
									result.error ||
										`Could not detect project type in: ${projectDir}`,
								),
							);
						}
					} catch (parseErr) {
						reject(new Error(`Failed to parse detection result: ${parseErr}`));
					}
				} else {
					reject(
						new Error(
							`Detection failed (exit code ${code}): ${stderr.slice(-500)}`,
						),
					);
				}
			});

			proc.on("error", (err) => {
				this.detectionProcess = null;
				reject(new Error(`Failed to start detection: ${err.message}`));
			});
		});
	}

	/**
	 * Start the dev server with the given config.
	 */
	async startServer(config: AppEmulatorConfig): Promise<void> {
		// Synchronous guard — prevents race condition when two calls arrive before either awaits
		if (this.startingInProgress) {
			return;
		}
		this.startingInProgress = true;

		try {
			// Stop any existing server
			this.stopServer();

			// On Windows, taskkill is fire-and-forget. Wait for the OS to fully release
			// ports from killed processes before probing them.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));

			this.currentConfig = config;

			// Fullstack multi-service path (e.g. .NET backend + Angular frontend)
			if (config.services && config.services.length > 1) {
				await this.startMultipleServices(config);
				return;
			}

			const rawDir = config.projectDir || process.cwd();
			const projectDir = rawDir; // No junction — Angular runs from the real path

			// Patch @ngtools/webpack to fix the %20 encoding bug for paths with spaces.
			// Must run from real path (not junction) so TypeScript & webpack use the same paths.
			if (config.framework === "angular") {
				await this.patchAngularWebpack(rawDir);
			}

			// Ensure Node.js dependencies are installed before starting the dev server.
			try {
				await this.ensureDependenciesInstalled(projectDir);
			} catch (err) {
				this.emit("error", String(err));
				return;
			}

			// Ensure Python dependencies are installed before starting the dev server.
			const PYTHON_FRAMEWORKS = new Set([
				"django",
				"fastapi",
				"flask",
				"streamlit",
				"python",
			]);
			if (PYTHON_FRAMEWORKS.has(config.framework)) {
				try {
					await this.ensurePythonDependenciesInstalled(projectDir);
				} catch (err) {
					this.emit("error", String(err));
					return;
				}
			}

			if (!config.startCommand) {
				this.emit("error", "No start command configured");
				return;
			}

			// Check if something is already running on the configured port
			if (config.isWeb && config.port > 0) {
				const portFree = await this.isPortAvailable(config.port);
				if (!portFree) {
					// Port is occupied — check if there's a working HTTP server we can reuse
					const alreadyServing = await this.isHttpReachable(config.port);
					if (alreadyServing) {
						this.serverUrl = `http://localhost:${config.port}`;
						this.emit("status", `Running at ${this.serverUrl}`);
						this.emit("ready", this.serverUrl);
						return;
					}

					// Port occupied but no usable HTTP server — try to kill the orphaned process first.
					await this.killProcessOnPort(config.port);
					if (!(await this.isPortAvailable(config.port))) {
						// Still occupied after kill — fall back to next available port
						const availablePort = await this.findAvailablePort(config.port + 1);
						this.emit(
							"status",
							`Port ${config.port} in use — using port ${availablePort} instead`,
						);
						const updatedCommand = this.replacePortInCommand(
							config.startCommand,
							config.port,
							availablePort,
						);
						if (updatedCommand === config.startCommand) {
							if (config.framework === "angular") {
								config.startCommand = `npx ng serve --port ${availablePort}`;
							} else {
								config.startCommand = `${config.startCommand} -- --port ${availablePort}`;
							}
						} else {
							config.startCommand = updatedCommand;
						}
						config.port = availablePort;
						this.currentConfig = config;
						this.emit("config", config);
					}
				}
			}

			this.emit("status", `Starting: ${config.startCommand}`);

			const { cmd, args, shell } = this.parseStartCommand(config.startCommand);

			const proc = spawn(cmd, args, {
				cwd: projectDir,
				env: {
					...process.env,
					BROWSER: "none",
					PORT: String(config.port),
				} as Record<string, string>,
				shell,
				stdio: ["ignore", "pipe", "pipe"],
			});

			this.activeServerProcess = proc;

			const recentOutput: string[] = [];
			const captureOutput = (line: string): void => {
				recentOutput.push(line);
				if (recentOutput.length > SERVER_OUTPUT_BUFFER_LIMIT) {
					recentOutput.shift();
				}
				this.emit("output", line);
			};

			proc.stdout?.on("data", (data: Buffer) => {
				const text = data.toString("utf-8");
				for (const line of text.split("\n")) {
					if (line.trim()) {
						captureOutput(line);
					}
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				const text = data.toString("utf-8");
				for (const line of text.split("\n")) {
					if (line.trim()) {
						captureOutput(line);
					}
				}
			});

			proc.on("close", (code) => {
				this.activeServerProcess = null;
				this.serverUrl = null;
				// Release startingInProgress so a retry can start immediately
				this.startingInProgress = false;
				if (code !== null && code !== 0) {
					this.emit("error", formatServerExitError(code, recentOutput));
				}
				this.emit("stopped");
			});

			proc.on("error", (err) => {
				this.activeServerProcess = null;
				this.serverUrl = null;
				this.startingInProgress = false;
				this.emit("error", `Failed to start server: ${err.message}`);
			});

			// Wait for the port to become available (for web apps)
			if (config.isWeb && config.port > 0) {
				try {
					await this.waitForPort(config.port, 60000);
				} catch {
					// Port didn't open in time; bail if the process died
					if (!this.activeServerProcess || this.activeServerProcess.killed)
						return;
				}

				// After TCP is up, wait for the server to actually serve HTTP (e.g. Angular
				// dev-server binds the port immediately but compiles for 30-60 s before
				// responding with 2xx).  We poll for up to 90 s; if still not 2xx we emit
				// 'ready' anyway so the user at least sees the terminal output.
				await this.waitForHttpSuccess(config.port, 90000);

				if (this.activeServerProcess && !this.activeServerProcess.killed) {
					this.serverUrl = `http://localhost:${config.port}`;
					this.emit("ready", this.serverUrl);
				}
			}
		} finally {
			this.startingInProgress = false;
		}
	}

	/**
	 * Launch all services defined in config.services in parallel.
	 * The primary service (isPrimary === true) drives the 'ready' event and
	 * sets the API Studio base URL. Secondary services (e.g. frontend) are
	 * started fire-and-forget alongside.
	 */
	private async startMultipleServices(
		config: AppEmulatorConfig,
	): Promise<void> {
		// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
		const services = config.services!;
		const primary = services.find((s) => s.isPrimary) ?? services[0];
		const secondaries = services.filter((s) => !s.isPrimary);

		// Resolve port conflicts for each service before spawning anything.
		// Services whose port is already served by a live HTTP server are skipped entirely
		// (no need to restart them).
		const skipSpawn = new Set<string>();
		for (const svc of services) {
			if (svc.port <= 0) continue;
			const portFree = await this.isPortAvailable(svc.port);
			if (!portFree) {
				const alreadyServing = await this.isHttpReachable(svc.port);
				if (alreadyServing) {
					this.emit(
						"output",
						`[${svc.label}] Port ${svc.port} already has a running server — reusing it`,
					);
					skipSpawn.add(svc.label); // don't spawn: a server is already listening there
					continue;
				}
				// Port occupied but not serving HTTP — likely an orphaned process from a
				// previous session (e.g. after navigating away without stopping). Kill it.
				this.emit(
					"output",
					`[${svc.label}] Port ${svc.port} occupied — stopping previous process...`,
				);
				await this.killProcessOnPort(svc.port);
				// Re-check after kill
				const freeAfterKill = await this.isPortAvailable(svc.port);
				if (!freeAfterKill) {
					// Still occupied (e.g. another unrelated process) — find alternative port
					const availablePort = await this.findAvailablePort(svc.port + 1);
					this.emit(
						"status",
						`[${svc.label}] Port ${svc.port} still in use — using ${availablePort} instead`,
					);
					const updatedCmd = this.replacePortInCommand(
						svc.startCommand,
						svc.port,
						availablePort,
					);
					svc.startCommand =
						updatedCmd !== svc.startCommand
							? updatedCmd
							: svc.framework === "angular"
								? `npx ng serve --port ${availablePort}`
								: `${svc.startCommand} -- --port ${availablePort}`;
					svc.port = availablePort;
				}
			}
		}
		// Notify renderer of updated config (ports may have changed)
		this.emit("config", config);

		// Spawn secondary services (fire-and-forget — no waiting for ready)
		for (const svc of secondaries) {
			if (skipSpawn.has(svc.label)) continue;
			this.emit("output", `[${svc.label}] Starting: ${svc.startCommand}`);
			const { cmd, args, shell } = this.parseStartCommand(svc.startCommand);
			// Patch @ngtools/webpack to fix the %20 encoding bug (paths with spaces).
			// Angular must run from the real path so TypeScript & webpack use the same paths.
			if (svc.framework === "angular") {
				await this.patchAngularWebpack(svc.projectDir);
			}
			try {
				await this.ensureDependenciesInstalled(svc.projectDir, svc.label);
				await this.ensurePythonDependenciesInstalled(svc.projectDir, svc.label);
			} catch (err) {
				this.emit("output", `[${svc.label}] ${String(err)}`);
			}
			const proc = spawn(cmd, args, {
				cwd: svc.projectDir,
				env: {
					...process.env,
					BROWSER: "none",
					PORT: String(svc.port),
				} as Record<string, string>,
				shell,
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.activeServiceProcesses.set(svc.label, proc);
			proc.stdout?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `[${svc.label}] ${line}`);
				}
			});
			proc.stderr?.on("data", (data: Buffer) => {
				for (const line of data.toString("utf-8").split("\n")) {
					if (line.trim()) this.emit("output", `[${svc.label}] ${line}`);
				}
			});
			proc.on("close", (code) => {
				this.activeServiceProcesses.delete(svc.label);
				if (code !== null && code !== 0) {
					this.emit("output", `[${svc.label}] exited with code ${code}`);
				}
			});
			proc.on("error", (err) => {
				this.activeServiceProcesses.delete(svc.label);
				this.emit("output", `[${svc.label}] failed to start: ${err.message}`);
			});
		}

		// Spawn primary service — drives 'ready' and waitForPort checks
		this.emit("status", `Starting: ${primary.startCommand}`);
		const {
			cmd: primaryCmd,
			args: primaryArgs,
			shell,
		} = this.parseStartCommand(primary.startCommand);
		// Patch @ngtools/webpack for the %20 bug if primary is Angular.
		if (primary.framework === "angular") {
			await this.patchAngularWebpack(primary.projectDir);
		}
		try {
			await this.ensureDependenciesInstalled(primary.projectDir, primary.label);
			await this.ensurePythonDependenciesInstalled(
				primary.projectDir,
				primary.label,
			);
		} catch (err) {
			this.emit("error", String(err));
			this.startingInProgress = false;
			return;
		}
		const primaryProc = spawn(primaryCmd, primaryArgs, {
			cwd: primary.projectDir,
			env: {
				...process.env,
				BROWSER: "none",
				PORT: String(primary.port),
			} as Record<string, string>,
			shell,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Assign to activeServerProcess so waitForPort/waitForHttpSuccess bail correctly
		this.activeServerProcess = primaryProc;
		this.activeServiceProcesses.set(primary.label, primaryProc);

		const primaryRecentOutput: string[] = [];
		const capturePrimaryOutput = (line: string): void => {
			primaryRecentOutput.push(line);
			if (primaryRecentOutput.length > SERVER_OUTPUT_BUFFER_LIMIT) {
				primaryRecentOutput.shift();
			}
			this.emit("output", `[${primary.label}] ${line}`);
		};

		primaryProc.stdout?.on("data", (data: Buffer) => {
			for (const line of data.toString("utf-8").split("\n")) {
				if (line.trim()) capturePrimaryOutput(line);
			}
		});
		primaryProc.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString("utf-8").split("\n")) {
				if (line.trim()) capturePrimaryOutput(line);
			}
		});
		primaryProc.on("close", (code) => {
			this.activeServerProcess = null;
			this.serverUrl = null;
			this.startingInProgress = false;
			this.activeServiceProcesses.delete(primary.label);
			if (code !== null && code !== 0) {
				this.emit("error", formatServerExitError(code, primaryRecentOutput));
			}
			this.emit("stopped");
		});
		primaryProc.on("error", (err) => {
			this.activeServerProcess = null;
			this.serverUrl = null;
			this.startingInProgress = false;
			this.emit("error", `Failed to start server: ${err.message}`);
		});

		// Wait for the primary (backend) to accept connections — longer timeout for .NET compilation
		try {
			await this.waitForPort(primary.port, 120000);
		} catch {
			if (!this.activeServerProcess || this.activeServerProcess.killed) return;
		}
		// For fullstack projects, poll the frontend HTTP (no auth required) rather than
		// the backend API which may return 401 and pollute the backend logs.
		const frontendSvc = secondaries.find((s) =>
			[
				"angular",
				"vite",
				"next",
				"nuxt",
				"create-react-app",
				"vue-cli",
				"svelte",
			].includes(s.framework),
		);
		if (frontendSvc) {
			await this.waitForHttpSuccess(frontendSvc.port, 120000);
		} else {
			await this.waitForHttpSuccess(primary.port, 120000);
		}

		if (this.activeServerProcess && !this.activeServerProcess.killed) {
			this.serverUrl = frontendSvc
				? `http://localhost:${frontendSvc.port}`
				: `http://localhost:${primary.port}`;
			this.emit("ready", this.serverUrl);
		}
	}

	/**
	 * Replace every occurrence of `oldPort` in a start command with `newPort`.
	 * Handles both `--port N` and `PORT=N` forms.
	 */
	private replacePortInCommand(
		cmd: string,
		oldPort: number,
		newPort: number,
	): string {
		return cmd.replaceAll(
			new RegExp(
				String.raw`(--port\s+)${oldPort}|(\bPORT=)${oldPort}|(/port:)${oldPort}`,
				"g",
			),
			(_m: string, p1: string, p2: string, p3: string) =>
				p1 ? `${p1}${newPort}` : p2 ? `${p2}${newPort}` : `${p3}${newPort}`,
		);
	}

	/**
	 * Quick check: is there an HTTP server responding on this port?
	 * Returns true if we get any HTTP response within 1.5 s.
	 */
	private isHttpReachable(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const req = http.get(
				{ hostname: "127.0.0.1", port, path: "/", timeout: 1500 },
				(res) => {
					res.resume();
					resolve(true);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
		});
	}

	/**
	 * Check if a port is available (not in use).
	 * Probes both IPv4 (0.0.0.0) and IPv6 (::) to catch all listener types on Windows:
	 *  • 0.0.0.0 catches: IPv4, IPv6 dual-stack (IPV6_V6ONLY=false)
	 *  • ::        catches: IPv6-only (IPV6_V6ONLY=true) listeners missed by the IPv4 probe
	 * Only reports "free" when BOTH binds succeed.
	 */
	private async isPortAvailable(port: number): Promise<boolean> {
		const tryBind = (host: string): Promise<boolean> =>
			new Promise((resolve) => {
				const server = net.createServer();
				server.once("error", (err: NodeJS.ErrnoException) => {
					// EADDRINUSE → port occupied; other errors (no IPv6 support, etc.) → treat as free
					resolve(err.code !== "EADDRINUSE");
				});
				server.once("listening", () => server.close(() => resolve(true)));
				server.listen(port, host);
			});

		const ipv4Free = await tryBind("0.0.0.0");
		return ipv4Free ? tryBind("::") : false;
	}

	/**
	 * Find an available port starting from startPort.
	 */
	private async findAvailablePort(startPort: number): Promise<number> {
		let port = startPort;
		while (port < startPort + 20) {
			if (await this.isPortAvailable(port)) return port;
			port++;
		}
		return startPort; // fallback
	}

	/**
	 * Wait for a port to accept connections.
	 */
	private waitForPort(port: number, timeout: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const startTime = Date.now();

			const tryConnect = () => {
				if (Date.now() - startTime > timeout) {
					reject(new Error(`Timeout waiting for port ${port}`));
					return;
				}

				// Bail out immediately if the process died
				if (!this.activeServerProcess || this.activeServerProcess.killed) {
					resolve();
					return;
				}

				const socket = new net.Socket();
				socket.setTimeout(1000);

				socket.on("connect", () => {
					socket.destroy();
					resolve();
				});

				socket.on("error", () => {
					socket.destroy();
					setTimeout(tryConnect, 500);
				});

				socket.on("timeout", () => {
					socket.destroy();
					setTimeout(tryConnect, 500);
				});

				socket.connect(port, "127.0.0.1");
			};

			tryConnect();
		});
	}

	/**
	 * Poll the server with an HTTP GET until it responds with a 2xx status code
	 * (meaning the app is compiled and actually serving content), or until
	 * `timeout` ms elapses, whichever comes first.
	 */
	private waitForHttpSuccess(port: number, timeout: number): Promise<void> {
		return new Promise((resolve) => {
			const startTime = Date.now();

			const tryGet = () => {
				// Stop polling if the process died
				if (!this.activeServerProcess || this.activeServerProcess.killed) {
					resolve();
					return;
				}

				if (Date.now() - startTime > timeout) {
					// Timed out — emit ready anyway so the user can see what's happening
					resolve();
					return;
				}

				const req = http.get(
					{ hostname: "127.0.0.1", port, path: "/", timeout: 3000 },
					(res) => {
						res.resume(); // drain the response body
						if (res.statusCode !== undefined && res.statusCode < 500) {
							// Any non-5xx response (including 401/403) means the server is up and reachable
							resolve();
						} else {
							// 5xx or no status — server not ready yet (e.g. still compiling)
							setTimeout(tryGet, 2000);
						}
					},
				);

				req.on("error", () => setTimeout(tryGet, 1000));
				req.on("timeout", () => {
					req.destroy();
					setTimeout(tryGet, 1000);
				});
			};

			tryGet();
		});
	}

	private killProcessOnPort(port: number): Promise<void> {
		if (process.platform !== "win32") return Promise.resolve();
		return new Promise<void>((resolve) => {
			const ps = spawn(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					// Get all TCP connections on this port (any state), extract unique owning PIDs,
					// skip system PIDs (0-4), then force-stop each process.
					`Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue |` +
						` Select-Object -ExpandProperty OwningProcess -Unique |` +
						` Where-Object { $_ -gt 4 } |` +
						` ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
				],
				{ stdio: "ignore" },
			);
			// Wait 1000 ms after kill for the OS to fully release the port
			ps.on("close", () => setTimeout(resolve, 1000));
			ps.on("error", () => resolve());
			setTimeout(() => {
				try {
					ps.kill();
				} catch {
					/* ignore */
				}
				resolve();
			}, 4000);
		});
	}

	/**
	 * Stop the dev server (single-service) or all services (multi-service).
	 */
	stopServer(): void {
		const killProc = (proc: ChildProcess) => {
			const pid = proc.pid;
			try {
				if (process.platform === "win32" && pid) {
					spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
						stdio: "ignore",
					});
				} else {
					proc.kill("SIGKILL");
				}
			} catch {
				/* already dead */
			}
		};

		// Capture ports before clearing config — used for fallback port-based kill below
		const portsToKill: number[] = [];
		if (this.currentConfig) {
			if (this.currentConfig.services) {
				for (const svc of this.currentConfig.services) {
					if (svc.port > 0) portsToKill.push(svc.port);
				}
			} else if (this.currentConfig.port > 0) {
				portsToKill.push(this.currentConfig.port);
			}
		}

		// Kill all tracked secondary service processes
		for (const proc of this.activeServiceProcesses.values()) {
			killProc(proc);
		}
		this.activeServiceProcesses.clear();

		// Kill the primary / single-service process
		if (this.activeServerProcess) {
			killProc(this.activeServerProcess);
			this.activeServerProcess = null;
		}

		this.serverUrl = null;
		this.currentConfig = null;

		// Fallback port-based kill: on Windows, dotnet run spawns the actual web server
		// as a grandchild process that taskkill /t sometimes misses. Kill by port to be sure.
		for (const port of portsToKill) {
			this.killProcessOnPort(port).catch(() => {
				/* noop */
			});
		}

		// Remove any junctions created to work around spaces-in-path issues
		this.cleanupJunctions();
		// Restore any @ngtools/webpack patches applied for the spaces-in-path bug
		this.restoreAngularWebpackPatches();

		this.emit("stopped");
	}

	/**
	 * Remove all junctions created by ensureNoSpacesPath and clear the map.
	 */
	private cleanupJunctions(): void {
		for (const junctionPath of this.junctionMap.values()) {
			spawn(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Remove-Item -Path '${junctionPath}' -Force -ErrorAction SilentlyContinue`,
				],
				{ stdio: "ignore" },
			);
		}
		this.junctionMap.clear();
	}

	/**
	 * Patch @ngtools/webpack/src/ivy/plugin.js to add decodeURIComponent() around
	 * resource paths before they are looked up in the TypeScript compilation.
	 *
	 * Root cause: webpack URL-encodes paths containing spaces, producing module IDs
	 * like "MeCa%20Web/...". The TypeScript compilation registers source files with
	 * the real decoded path ("MeCa Web/..."). On incremental rebuilds the lookup in
	 * `createFileEmitter` calls `normalizePath(file)` where `file` still has `%20`,
	 * so `program.getSourceFile()` returns undefined → "missing from TypeScript
	 * compilation" error.
	 *
	 * Fix: wrap `file` and `resource` in `decodeURIComponent()` before passing to
	 * `normalizePath()`, matching the same fix shipped in Angular CLI 15.1
	 * (angular-cli#24798).
	 *
	 * IMPORTANT: Angular must run from the real project path (no junction symlink),
	 * otherwise TypeScript compiles with junction paths and the lookup still fails.
	 *
	 * No-op if:
	 *  - projectDir has no spaces
	 *  - plugin.js does not exist (Angular CLI not installed)
	 *  - the fix is already present (Angular CLI 15.1+)
	 *  - the expected pattern is not found in this compiled version
	 */
	private async patchAngularWebpack(projectDir: string): Promise<void> {
		if (!projectDir.includes(" ")) return;

		const pluginPath = path.join(
			projectDir,
			"node_modules",
			"@ngtools",
			"webpack",
			"src",
			"ivy",
			"plugin.js",
		);
		if (!existsSync(pluginPath)) return;
		if (this.angularWebpackPatches.has(pluginPath)) return; // already patched this session

		try {
			const original = readFileSync(pluginPath, "utf-8");

			// Guard: patch already present (Angular CLI 15.1+)
			if (
				original.includes("decodeURIComponent(file)") ||
				original.includes("decodeURIComponent(resource)")
			)
				return;

			let patched = original;

			// Fix 1: createFileEmitter — decode the resource path before TypeScript program lookup.
			// normalizePath)(file) → normalizePath)(decodeURIComponent(file))
			patched = patched.replace(
				/normalizePath\)\(file\)/g,
				"normalizePath)(decodeURIComponent(file))",
			);

			// Fix 2: unused-file detection and rebuild-file detection.
			// normalizePath)(resource) → normalizePath)(decodeURIComponent(resource))
			patched = patched.replace(
				/normalizePath\)\(resource\)/g,
				"normalizePath)(decodeURIComponent(resource))",
			);

			if (patched === original) {
				return;
			}

			writeFileSync(pluginPath, patched, "utf-8");
			this.angularWebpackPatches.set(pluginPath, original);
		} catch (err) {
			console.warn("[AppEmulator] Could not patch @ngtools/webpack:", err);
		}
	}

	/**
	 * Restore all @ngtools/webpack files that were patched by patchAngularWebpack.
	 */
	private restoreAngularWebpackPatches(): void {
		for (const [indexPath, original] of this.angularWebpackPatches) {
			try {
				writeFileSync(indexPath, original, "utf-8");
			} catch {
				/* ignore — file may have been deleted */
			}
		}
		this.angularWebpackPatches.clear();
	}

	/**
	 * Check if a server is currently running.
	 */
	isRunning(): boolean {
		return (
			this.activeServerProcess !== null && !this.activeServerProcess.killed
		);
	}

	/**
	 * Get the current server URL.
	 */
	getUrl(): string | null {
		return this.serverUrl;
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): AppEmulatorConfig | null {
		return this.currentConfig;
	}

	/**
	 * Cancel any active detection.
	 */
	cancelDetection(): void {
		if (this.detectionProcess) {
			this.detectionProcess.kill();
			this.detectionProcess = null;
		}
	}
}

// Singleton instance
export const appEmulatorService = new AppEmulatorService();
