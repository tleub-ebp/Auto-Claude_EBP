import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { getOAuthModeClearVars } from "./agent/env-utils";
import { logger } from "./app-logger";
import { parsePythonCommand } from "./python-detector";
import { getConfiguredPythonPath } from "./python-env-manager";
import {
	createSDKRateLimitInfo,
	detectRateLimit,
	getBestAvailableProfileEnv,
	type SDKRateLimitInfo,
} from "./rate-limit-detector";
import { credentialManager } from "./services/credential-manager";
import { getAPIProfileEnv } from "./services/profile";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Marker the runner prints before the raw model output (see runner docstring). */
const RESULT_MARKER = "__ONESHOT_RESULT__:";
const ONESHOT_RUNNER = "oneshot_completion_runner.py";
const DEFAULT_TIMEOUT_MS = 60000;

export interface OneShotLLMOptions {
	/** The complete user prompt to send. */
	prompt: string;
	/** Optional system prompt. */
	systemPrompt?: string;
	/** Working directory (enables exotic-provider routing for the runner). */
	projectDir?: string;
	/** Spec directory — used by the runner to resolve the active provider/model. */
	specDir?: string;
	/** Per-call timeout (defaults to 60s). */
	timeoutMs?: number;
	/** Override the Python interpreter (else the configured/venv Python). */
	pythonPath?: string;
	/** Override the backend source directory (else auto-detected). */
	autoBuildSourcePath?: string;
	/** When set, failures are scanned for rate limits and reported via onRateLimit. */
	rateLimitSource?: SDKRateLimitInfo["source"];
	/** Called when a rate limit is detected in a failed run. */
	onRateLimit?: (info: SDKRateLimitInfo) => void;
	/** Short label for log messages. */
	debugLabel?: string;
}

/**
 * Locate the backend source directory (where the runners live). Mirrors the
 * resolution used across the main process: an explicit override, then the
 * packaged-app locations (user-updated `backend-source`, then bundled
 * `resources/backend`), then development paths. The `spec_runner.py` marker
 * confirms it's a real backend checkout.
 */
function resolveBackendSource(override?: string): string | null {
	const hasBackend = (dir: string): boolean =>
		existsSync(dir) && existsSync(path.join(dir, "runners", "spec_runner.py"));

	if (override && hasBackend(override)) return override;

	if (app.isPackaged) {
		const userOverride = path.join(app.getPath("userData"), "backend-source");
		if (hasBackend(userOverride)) return userOverride;
		const resources = path.join(process.resourcesPath, "backend");
		if (hasBackend(resources)) return resources;
	}

	const candidates = [
		path.resolve(__dirname, "..", "..", "..", "backend"),
		path.resolve(app.getAppPath(), "..", "backend"),
		path.resolve(process.cwd(), "apps", "backend"),
	];
	for (const candidate of candidates) {
		if (hasBackend(candidate)) return candidate;
	}
	return null;
}

/** Parse the backend's `.env` into key/value pairs (best-effort). */
function loadAutoBuildEnv(autoBuildSource: string): Record<string, string> {
	const envPath = path.join(autoBuildSource, ".env");
	if (!existsSync(envPath)) return {};
	try {
		const envVars: Record<string, string> = {};
		for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex > 0) {
				const key = trimmed.substring(0, eqIndex).trim();
				let value = trimmed.substring(eqIndex + 1).trim();
				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}
				envVars[key] = value;
			}
		}
		return envVars;
	} catch {
		return {};
	}
}

/**
 * Build the subprocess environment. Layers, in order: backend `.env`, the Claude
 * API/OAuth profile env (so the Claude provider authenticates), then the active
 * provider's credentials from the credential manager (`SELECTED_LLM_PROVIDER` +
 * e.g. WINDSURF_API_KEY / OPENAI_API_KEY), which wins so the runner routes to
 * whatever provider the user selected.
 */
async function buildEnv(autoBuildSource: string): Promise<NodeJS.ProcessEnv> {
	const autoBuildEnv = loadAutoBuildEnv(autoBuildSource);
	const apiProfileEnv = await getAPIProfileEnv();
	const isApiProfileActive = Object.keys(apiProfileEnv).length > 0;
	const profileEnv = isApiProfileActive ? {} : getBestAvailableProfileEnv().env;
	const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);
	let providerEnv: Record<string, string> = {};
	try {
		providerEnv = credentialManager.getEnvironmentVariables();
	} catch (error) {
		logger.warn("[OneShotLLM] Could not read provider env:", error);
	}

	return {
		...process.env,
		...autoBuildEnv,
		...profileEnv,
		...apiProfileEnv,
		...oauthModeClearVars,
		...providerEnv,
		PYTHONUNBUFFERED: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
	};
}

/**
 * Run a single, provider-agnostic LLM text completion via the backend
 * `oneshot_completion_runner.py`. Returns the raw model text, or null on any
 * failure (missing backend, timeout, empty/failed run) so callers degrade
 * gracefully. The prompt is built by the caller; this only handles transport.
 */
export async function runOneShotLLM(
	options: OneShotLLMOptions,
): Promise<string | null> {
	const label = options.debugLabel ?? "OneShotLLM";
	const autoBuildSource = resolveBackendSource(options.autoBuildSourcePath);
	if (!autoBuildSource) {
		logger.warn(`[${label}] Backend source path not found`);
		return null;
	}
	const runnerPath = path.join(autoBuildSource, "runners", ONESHOT_RUNNER);
	if (!existsSync(runnerPath)) {
		logger.warn(`[${label}] One-shot runner not found at ${runnerPath}`);
		return null;
	}

	const payload: Record<string, unknown> = { prompt: options.prompt };
	if (options.systemPrompt) payload.system_prompt = options.systemPrompt;
	if (options.projectDir) payload.project_dir = options.projectDir;
	if (options.specDir) payload.spec_dir = options.specDir;

	let inputFile: string | null = null;
	try {
		const dir = mkdtempSync(path.join(tmpdir(), "wp-oneshot-"));
		inputFile = path.join(dir, "input.json");
		writeFileSync(inputFile, JSON.stringify(payload), "utf-8");
	} catch (error) {
		logger.warn(`[${label}] Could not write runner input:`, error);
		return null;
	}

	const env = await buildEnv(autoBuildSource);
	const pythonPath = options.pythonPath ?? getConfiguredPythonPath();
	const cleanup = () => {
		if (inputFile) rmSync(path.dirname(inputFile), { recursive: true, force: true });
	};

	return new Promise((resolve) => {
		const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonPath);
		const child = spawn(
			pythonCommand,
			[...pythonBaseArgs, runnerPath, "--input", inputFile as string],
			{ cwd: autoBuildSource, env },
		);

		let output = "";
		let errorOutput = "";
		const timeout = setTimeout(() => {
			logger.warn(`[${label}] Generation timed out`);
			child.kill();
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString("utf-8");
		});
		child.stderr?.on("data", (data: Buffer) => {
			errorOutput += data.toString("utf-8");
		});

		child.on("exit", (code: number | null) => {
			clearTimeout(timeout);
			cleanup();
			const markerIndex = output.indexOf(RESULT_MARKER);
			if (code === 0 && markerIndex !== -1) {
				resolve(output.slice(markerIndex + RESULT_MARKER.length).trim());
				return;
			}

			// Best-effort rate-limit reporting on failure.
			if (options.rateLimitSource && options.onRateLimit) {
				const detection = detectRateLimit(`${output}\n${errorOutput}`);
				if (detection.isRateLimited) {
					options.onRateLimit(
						createSDKRateLimitInfo(options.rateLimitSource, detection),
					);
				}
			}
			logger.warn(`[${label}] Generation failed`, {
				code,
				errorOutput: errorOutput.substring(0, 500),
			});
			resolve(null);
		});

		child.on("error", (err) => {
			clearTimeout(timeout);
			cleanup();
			logger.warn(`[${label}] Process error:`, err.message);
			resolve(null);
		});
	});
}
