import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { MODEL_ID_MAP } from "../shared/constants";
import type { AppSettings } from "../shared/types";
import { buildMemoryEnvVars } from "./memory-env-builder";

/**
 * Request configuration for a learning loop analysis
 */
export interface LearningLoopRequest {
	projectDir: string;
	specId?: string;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Service for Autonomous Agent Learning Loop
 *
 * Spawns the Python learning_loop_runner.py process and streams output
 * back to the renderer via events.
 *
 * Events emitted:
 * - 'status' (status: string) — Status update message
 * - 'stream-chunk' (chunk: string) — Streaming text output
 * - 'error' (error: string) — Error message
 * - 'complete' (result: object) — Analysis complete with report, summary, patterns
 */
export class LearningLoopService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;
	private pythonPath: string = "python";
	private autoBuildSourcePath: string | null = null;

	/**
	 * Configure paths for Python and auto-claude source
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
	 * Get the auto-build source path, resolving from settings if needed
	 */
	private getAutoBuildSourcePath(): string | null {
		if (this.autoBuildSourcePath) return this.autoBuildSourcePath;

		const validatePath = (p: string): boolean =>
			existsSync(path.join(p, "runners", "learning_loop_runner.py"));

		// Try common locations (mirrors agent-process.ts resolution logic)
		const possiblePaths = [
			// Packaged app: backend is in extraResources
			...(app.isPackaged ? [path.join(process.resourcesPath, "backend")] : []),
			// Dev mode: from dist/main -> ../../backend (apps/frontend/out/main -> apps/backend)
			path.resolve(__dirname, "..", "..", "..", "backend"),
			// Alternative: from app root -> apps/backend
			path.resolve(app.getAppPath(), "..", "backend"),
			// If running from repo root with apps structure
			path.resolve(process.cwd(), "apps", "backend"),
		];

		for (const p of possiblePaths) {
			if (validatePath(p)) {
				this.autoBuildSourcePath = p;
				return p;
			}
		}

		return null;
	}

	/**
	 * Record a task outcome (human verdict or CI failure) and run a
	 * single-build pattern analysis on it, in the background.
	 *
	 * Fire-and-forget: runs detached from the dialog-driven analyze() flow so
	 * it never cancels or blocks a user-triggered analysis, and failures only
	 * log a warning (learning must never break the kanban workflow).
	 */
	recordTaskOutcome(
		projectDir: string,
		specId: string,
		verdict: "approved" | "rejected" | "build_failed",
		details?: string,
	): void {
		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			console.warn(
				"[LearningLoop] Cannot record outcome: backend source not found",
			);
			return;
		}

		const runnerPath = path.join(
			autoBuildSource,
			"runners",
			"learning_loop_runner.py",
		);
		const args = [
			runnerPath,
			"--project-dir",
			projectDir,
			"--spec-id",
			specId,
			"--record-outcome",
			verdict,
		];
		if (details) {
			args.push("--outcome-details", details.slice(0, 2000));
		}

		try {
			const proc = spawn(this.pythonPath, args, {
				cwd: autoBuildSource,
				env: this.buildProcessEnvironment(),
				stdio: "ignore",
				detached: true,
			});
			proc.on("error", (err) => {
				console.warn("[LearningLoop] Outcome recording failed:", err.message);
			});
			proc.unref();
		} catch (err) {
			console.warn("[LearningLoop] Failed to spawn outcome recorder:", err);
		}
	}

	/**
	 * Cancel any active analysis
	 */
	cancel(): boolean {
		if (!this.activeProcess) return false;
		this.activeProcess.kill();
		this.activeProcess = null;
		return true;
	}

	/**
	 * Run learning loop analysis
	 */
	async analyze(request: LearningLoopRequest): Promise<void> {
		// Cancel any existing process
		this.cancel();

		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			this.emit(
				"error",
				"WorkPilot AI source not found. Cannot locate learning_loop_runner.py",
			);
			return;
		}

		const runnerPath = path.join(
			autoBuildSource,
			"runners",
			"learning_loop_runner.py",
		);
		if (!existsSync(runnerPath)) {
			this.emit(
				"error",
				"learning_loop_runner.py not found in auto-claude directory",
			);
			return;
		}

		// Emit initial status
		this.emit("status", "Initializing Learning Loop analysis...");

		const args = this.buildCommandArgs(request, runnerPath);
		const processEnv = this.buildProcessEnvironment();

		await this.executeProcess(args, processEnv, autoBuildSource);
	}

	private buildCommandArgs(
		request: LearningLoopRequest,
		runnerPath: string,
	): string[] {
		const args = [runnerPath, "--project-dir", request.projectDir];

		if (request.specId) {
			args.push("--spec-id", request.specId);
		}
		if (request.model) {
			const modelId = MODEL_ID_MAP[request.model] || request.model;
			args.push("--model", modelId);
		}
		if (request.thinkingLevel) {
			args.push("--thinking-level", request.thinkingLevel);
		}

		return args;
	}

	private buildProcessEnvironment(): Record<string, string> {
		const processEnv: Record<string, string> = {
			...(process.env as Record<string, string>),
		};

		// Read OAuth token from settings if available
		try {
			const settingsPath = path.join(app.getPath("userData"), "settings.json");
			if (existsSync(settingsPath)) {
				const { readFileSync } = require("node:fs");
				const settings: AppSettings = JSON.parse(
					readFileSync(settingsPath, "utf-8"),
				);
				if (settings.globalClaudeOAuthToken) {
					processEnv.CLAUDE_OAUTH_TOKEN = settings.globalClaudeOAuthToken;
				}
				if (settings.globalAnthropicApiKey) {
					processEnv.ANTHROPIC_API_KEY = settings.globalAnthropicApiKey;
				}
				// Graphiti memory config so outcome episodes reach the knowledge graph
				Object.assign(processEnv, buildMemoryEnvVars(settings));
			}
		} catch {
			// Ignore settings read errors
		}

		return processEnv;
	}

	private async executeProcess(
		args: string[],
		processEnv: Record<string, string>,
		cwd: string,
	): Promise<void> {
		// Spawn Python process
		const proc = spawn(this.pythonPath, args, {
			cwd,
			env: processEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.activeProcess = proc;

		const processor = new LearningLoopOutputProcessor();

		this.setupProcessHandlers(proc, processor);
	}

	private setupProcessHandlers(
		proc: ChildProcess,
		processor: LearningLoopOutputProcessor,
	): void {
		proc.stdout?.on("data", (data: Buffer) => {
			processor.processStdout(data.toString("utf-8"), this);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			processor.processStderr(data.toString("utf-8"));
		});

		proc.on("close", (code) => {
			this.activeProcess = null;
			this.handleProcessCompletion(code, processor);
		});

		proc.on("error", (err) => {
			this.activeProcess = null;
			this.emit(
				"error",
				`Failed to start learning loop analysis: ${err.message}`,
			);
		});
	}

	private handleProcessCompletion(
		code: number | null,
		processor: LearningLoopOutputProcessor,
	): void {
		if (code === 0 && processor.completeResult) {
			this.emit("complete", processor.completeResult);
		} else if (code && code > 0) {
			this.handleProcessError(code, processor);
		} else {
			this.emit(
				"error",
				"Learning loop analysis completed but produced no output.",
			);
		}
	}

	private handleProcessError(
		code: number,
		processor: LearningLoopOutputProcessor,
	): void {
		const combinedOutput = processor.fullOutput + processor.stderrOutput;
		if (
			combinedOutput.includes("rate_limit") ||
			combinedOutput.includes("Rate limit")
		) {
			this.emit(
				"error",
				"Rate limit reached. Please try again in a few moments.",
			);
		} else if (
			combinedOutput.includes("authentication") ||
			combinedOutput.includes("CLAUDE_OAUTH_TOKEN")
		) {
			this.emit(
				"error",
				"Authentication error. Please check your Claude credentials in Settings.",
			);
		} else {
			this.emit(
				"error",
				`Learning loop analysis failed (exit code ${code}). ${processor.stderrOutput.slice(-500)}`,
			);
		}
	}
}

class LearningLoopOutputProcessor {
	fullOutput = "";
	stderrOutput = "";
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	completeResult: any = null;

	processStdout(text: string, emitter: LearningLoopService): void {
		const lines = text.split("\n");

		for (const line of lines) {
			this.processLine(line, emitter);
		}
	}

	private processLine(line: string, emitter: LearningLoopService): void {
		if (line.startsWith("LEARNING_LOOP_EVENT:")) {
			this.handleEvent(line, emitter);
		} else if (line.trim()) {
			this.fullOutput += `${line}\n`;
			emitter.emit("stream-chunk", `${line}\n`);
		}
	}

	private handleEvent(line: string, emitter: LearningLoopService): void {
		try {
			const jsonStr = line.substring("LEARNING_LOOP_EVENT:".length);
			const event = JSON.parse(jsonStr);

			switch (event.type) {
				case "status":
					emitter.emit("status", event.message);
					break;
				case "stream_chunk":
					emitter.emit("stream-chunk", event.content);
					this.fullOutput += event.content;
					break;
				case "complete":
					this.completeResult = event.data;
					break;
				case "error":
					emitter.emit("error", event.message);
					break;
				default:
					console.warn("[LearningLoop] Unknown event type:", event.type);
			}
		} catch (parseErr) {
			console.error("[LearningLoop] Failed to parse event:", parseErr);
		}
	}

	processStderr(text: string): void {
		this.stderrOutput = (this.stderrOutput + text).slice(-5000);
		console.error("[LearningLoop]", text);
	}
}

// Singleton instance
export const learningLoopService = new LearningLoopService();
