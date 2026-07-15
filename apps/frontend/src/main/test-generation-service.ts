import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { getRunnerEnv } from "./ipc-handlers/github/utils/runner-env";

/**
 * Service for test generation
 *
 * Spawns the Python test_generation_runner.py process and streams output
 * back to the renderer via events.
 *
 * Events emitted:
 * - 'status' (status: string) — Status update message
 * - 'error' (error: string) — Error message
 * - 'result' (result: unknown) — Coverage analysis result (analyze-coverage action)
 * - 'complete' (result: unknown) — Generation complete with structured result
 * - 'progress' (event: TestGenStageEvent) — Live pipeline stage (detect/read/generate/write/done)
 * - 'code' (delta: string) — A chunk of clean generated test code, streamed live
 */

/** A live pipeline-stage event forwarded to the renderer. */
export interface TestGenStageEvent {
	type: "stage";
	stage: "detect" | "read" | "generate" | "write" | "done";
	/** Present once the stage completes. */
	status?: "done";
	/** Human-readable chip text, e.g. "csharp · xunit" or "42 lignes". */
	detail?: string;
	language?: string;
	framework?: string;
	path?: string;
	tests?: number;
}
export class TestGenerationService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;
	private pythonPath: string = "python";
	private backendPath: string | null = null;

	/**
	 * Configure paths for Python and backend
	 */
	configure(pythonPath?: string, backendPath?: string): void {
		if (pythonPath) {
			this.pythonPath = pythonPath;
		}
		if (backendPath) {
			this.backendPath = backendPath;
		}
	}

	/**
	 * Get the backend path, trying common locations
	 */
	private getBackendPath(): string | null {
		if (this.backendPath) return this.backendPath;

		const possiblePaths = [
			// Production install (same pattern as context-aware-snippets-service)
			path.join(
				app.getPath("userData"),
				"..",
				"auto-claude",
				"apps",
				"backend",
			),
			// Dev mode via app.getAppPath() (same pattern as quality-handlers)
			path.join(app.getAppPath(), "..", "..", "apps", "backend"),
			// Dev mode via process.cwd()
			path.join(process.cwd(), "apps", "backend"),
			// Fallback: app is inside apps/frontend, go up
			path.join(app.getAppPath(), "..", "backend"),
		];

		for (const p of possiblePaths) {
			const runnerPath = path.join(p, "runners", "test_generation_runner.py");
			if (existsSync(runnerPath)) {
				this.backendPath = p;
				return p;
			}
		}

		console.error("[TestGeneration] Tried paths:", possiblePaths);
		return null;
	}

	/**
	 * Cancel any active generation
	 */
	cancel(): boolean {
		if (!this.activeProcess) return false;
		this.activeProcess.kill();
		this.activeProcess = null;
		return true;
	}

	/**
	 * Analyze test coverage for a file
	 */
	async analyzeCoverage(
		filePath: string,
		existingTestPath?: string,
		projectPath?: string,
	): Promise<void> {
		const args = ["--action", "analyze-coverage", "--file-path", filePath];
		if (existingTestPath) {
			args.push("--existing-test-path", existingTestPath);
		}
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		await this.spawnRunner(args, "result");
	}

	/**
	 * Generate unit tests for a file
	 */
	async generateUnitTests(
		filePath: string,
		existingTestPath?: string,
		coverageTarget?: number,
		projectPath?: string,
	): Promise<void> {
		const args = [
			"--action",
			"generate-unit",
			"--file-path",
			filePath,
			"--coverage-target",
			String(coverageTarget ?? 80),
		];
		if (existingTestPath) {
			args.push("--existing-test-path", existingTestPath);
		}
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Generate E2E tests from a user story
	 */
	async generateE2ETests(
		userStory: string,
		targetModule: string,
		projectPath?: string,
	): Promise<void> {
		const args = [
			"--action",
			"generate-e2e",
			"--user-story",
			userStory,
			"--target-module",
			targetModule,
		];
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Generate TDD tests from a description
	 */
	async generateTDDTests(
		description: string,
		language: string,
		snippetType: string,
		projectPath?: string,
	): Promise<void> {
		const args = [
			"--action",
			"generate-tdd",
			"--description",
			description,
			"--language",
			language,
			"--snippet-type",
			snippetType,
		];
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Spawn the runner script and handle output parsing
	 * @param args - Arguments to pass to the runner (after the script path)
	 * @param successEvent - Event to emit when the result is received ('result' or 'complete')
	 */
	private async spawnRunner(
		args: string[],
		successEvent: "result" | "complete",
	): Promise<void> {
		// Cancel any existing process
		this.cancel();

		const backendSource = this.getBackendPath();
		if (!backendSource) {
			this.emit(
				"error",
				"WorkPilot AI backend not found. Cannot locate test_generation_runner.py",
			);
			return;
		}

		const runnerPath = path.join(
			backendSource,
			"runners",
			"test_generation_runner.py",
		);
		if (!existsSync(runnerPath)) {
			this.emit(
				"error",
				"test_generation_runner.py not found in backend directory",
			);
			return;
		}

		// Build clean environment using the same pattern as other runners.
		// This ensures the correct Claude profile (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN)
		// is used and prevents host IDE env vars (e.g. Windsurf) from redirecting the SDK
		// to the wrong API provider.
		const processEnv = await getRunnerEnv({ PYTHONPATH: backendSource });

		const fullArgs = [runnerPath, ...args];

		const proc = spawn(this.pythonPath, fullArgs, {
			cwd: backendSource,
			env: processEnv,
		});

		this.activeProcess = proc;

		let stderrOutput = "";
		let generationResult: unknown = null;
		// Buffer partial lines: a single stdout 'data' chunk can split a line
		// mid-way (common now that we stream many small __TG_EVENT__ lines), so
		// we only process complete '\n'-terminated lines and keep the remainder.
		let stdoutBuffer = "";

		const handleLine = (line: string): void => {
			if (line.startsWith("__TEST_GENERATION_RESULT__:")) {
				try {
					const jsonStr = line.substring("__TEST_GENERATION_RESULT__:".length);
					generationResult = JSON.parse(jsonStr);
					this.emit("status", "Test generation complete");
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse result:", parseErr);
				}
			} else if (line.startsWith("__TEST_GENERATION_ERROR__:")) {
				this.emit("error", line.substring("__TEST_GENERATION_ERROR__:".length));
			} else if (line.startsWith("__TG_EVENT__:")) {
				try {
					const evt = JSON.parse(line.substring("__TG_EVENT__:".length));
					if (evt?.type === "code" && typeof evt.delta === "string") {
						this.emit("code", evt.delta);
					} else if (evt?.type === "stage") {
						this.emit("progress", evt as TestGenStageEvent);
					}
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse event:", parseErr);
				}
			} else if (line.trim()) {
				// Plain progress/status line
				this.emit("status", line.trim());
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString("utf-8");
			let nl = stdoutBuffer.indexOf("\n");
			while (nl !== -1) {
				handleLine(stdoutBuffer.slice(0, nl));
				stdoutBuffer = stdoutBuffer.slice(nl + 1);
				nl = stdoutBuffer.indexOf("\n");
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			stderrOutput = (stderrOutput + text).slice(-5000);
			console.error("[TestGeneration]", text);
		});

		proc.on("close", (code) => {
			if (this.activeProcess === proc) {
				this.activeProcess = null;
			}

			// Flush any trailing line that wasn't newline-terminated.
			if (stdoutBuffer.trim()) {
				handleLine(stdoutBuffer);
				stdoutBuffer = "";
			}

			// code === null means killed by signal (e.g. cancel() was called) — ignore silently
			if (code === null) return;

			if (generationResult !== null) {
				this.emit(successEvent, generationResult);
			} else if (code === 0) {
				// Process exited cleanly (code 0) but produced no result — report it so the UI doesn't hang
				this.emit(
					"error",
					"Test generation completed without output. Check that the source file is readable and Claude is authenticated.",
				);
			} else {
				// Strip ANSI escape codes so the error message is readable
				const clean = stderrOutput
					// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips ANSI escape codes from error output
					.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, "")
					.replaceAll(/[\u2500-\u257F]/g, "")
					.trim();
				if (clean.includes("rate_limit") || clean.includes("Rate limit")) {
					this.emit(
						"error",
						"Rate limit reached. Please try again in a few moments.",
					);
				} else if (
					clean.includes("authentication") ||
					clean.includes("CLAUDE_OAUTH_TOKEN")
				) {
					this.emit(
						"error",
						"Authentication error. Please check your Claude credentials in Settings.",
					);
				} else {
					this.emit(
						"error",
						`Test generation failed (exit code ${code}). ${clean.slice(-500)}`,
					);
				}
			}
		});

		proc.on("error", (err) => {
			if (this.activeProcess === proc) {
				this.activeProcess = null;
			}
			this.emit("error", `Failed to start test generator: ${err.message}`);
		});
	}
}

// Singleton instance
export const testGenerationService = new TestGenerationService();
