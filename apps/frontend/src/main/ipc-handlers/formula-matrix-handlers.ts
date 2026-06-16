/**
 * Formula Matrix IPC Handlers
 *
 * Spawns apps/backend/runners/formula_matrix_runner.py to compute every
 * Provider × LLM × Effort combination for a kanban ticket — token/cost
 * estimates plus a calibrated success probability — before any tokens are
 * spent. Powers the "Formula Lab".
 *
 * Channels:
 *   invoke "formulaMatrix:run"
 *     → { ticketId, description?, projectPath?, specDir?, providers?, complexity? }
 *     → { matrix }
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { pythonEnvManager } from "../python-env-manager.js";

interface FormulaMatrixRequest {
	ticketId: string;
	description?: string;
	projectPath?: string;
	specDir?: string;
	providers?: string[];
	complexity?: number;
}

interface FormulaMatrixResponse {
	matrix: unknown;
}

interface FormulaRefineRequest {
	description?: string;
	candidates: Array<{
		key: string;
		provider: string;
		model: string;
		effort: string;
		tier: string;
		base_probability: number;
	}>;
}

interface FormulaRefineResponse {
	refined: Array<{
		key: string;
		success_probability: number;
		reason: string;
	}>;
}

export function registerFormulaMatrixHandlers(): void {
	ipcMain.handle(
		"formulaMatrix:run",
		async (
			_event,
			req: FormulaMatrixRequest,
		): Promise<FormulaMatrixResponse> => {
			if (!req.ticketId) {
				throw new Error("ticketId is required");
			}

			const backendPath = app.isPackaged
				? path.resolve(process.resourcesPath, "backend")
				: path.resolve(app.getAppPath(), "..", "backend");
			const runnerPath = path.resolve(
				backendPath,
				"runners",
				"formula_matrix_runner.py",
			);

			const pythonExe = pythonEnvManager.getPythonPath();
			if (!pythonExe) throw new Error("Python environment not ready");

			const args = [runnerPath, "--ticket-id", req.ticketId];
			if (req.description) {
				args.push("--description", req.description);
			}
			if (req.projectPath) {
				args.push("--project-root", req.projectPath);
			}
			if (req.specDir) {
				args.push("--spec-dir", req.specDir);
			}
			if (req.providers && req.providers.length > 0) {
				args.push("--providers", req.providers.join(","));
			}
			if (typeof req.complexity === "number") {
				args.push("--complexity", String(req.complexity));
			}

			return await new Promise<FormulaMatrixResponse>((resolve, reject) => {
				const child = spawn(pythonExe, args, {
					cwd: backendPath,
					env: { ...process.env, PYTHONPATH: backendPath },
				} as Parameters<typeof spawn>[2]);

				let stdout = "";
				let stderr = "";

				child.stdout?.on("data", (c: Buffer) => {
					stdout += c.toString();
				});
				child.stderr?.on("data", (c: Buffer) => {
					stderr += c.toString();
				});

				child.on("error", (err) => reject(err));
				child.on("close", (code) => {
					const lines = stdout.trim().split("\n").filter(Boolean);
					const lastLine = lines[lines.length - 1] ?? "";
					try {
						const parsed = JSON.parse(lastLine);
						if (parsed.error) {
							reject(new Error(parsed.error));
							return;
						}
						if (code !== 0) {
							reject(
								new Error(
									`formula_matrix_runner exited with ${code}: ${stderr}`,
								),
							);
							return;
						}
						resolve({ matrix: parsed.matrix });
					} catch (err) {
						reject(
							new Error(
								`Failed to parse formula matrix output: ${(err as Error).message} (stdout=${stdout.slice(0, 200)})`,
							),
						);
					}
				});
			});
		},
	);

	// AI refine — one cheap LLM call to sharpen the top formulas' success.
	ipcMain.handle(
		"formulaMatrix:refine",
		async (
			_event,
			req: FormulaRefineRequest,
		): Promise<FormulaRefineResponse> => {
			if (!req.candidates || req.candidates.length === 0) {
				return { refined: [] };
			}

			const backendPath = app.isPackaged
				? path.resolve(process.resourcesPath, "backend")
				: path.resolve(app.getAppPath(), "..", "backend");
			const runnerPath = path.resolve(
				backendPath,
				"runners",
				"formula_refine_runner.py",
			);

			const pythonExe = pythonEnvManager.getPythonPath();
			if (!pythonExe) throw new Error("Python environment not ready");

			const payload = JSON.stringify({
				description: req.description ?? "",
				candidates: req.candidates,
			});

			return await new Promise<FormulaRefineResponse>((resolve, reject) => {
				const child = spawn(pythonExe, [runnerPath], {
					cwd: backendPath,
					env: { ...process.env, PYTHONPATH: backendPath },
				} as Parameters<typeof spawn>[2]);

				let stdout = "";
				let stderr = "";

				child.stdout?.on("data", (c: Buffer) => {
					stdout += c.toString();
				});
				child.stderr?.on("data", (c: Buffer) => {
					stderr += c.toString();
				});

				child.on("error", (err) => reject(err));
				child.on("close", (code) => {
					const lines = stdout.trim().split("\n").filter(Boolean);
					const lastLine = lines[lines.length - 1] ?? "";
					try {
						const parsed = JSON.parse(lastLine);
						if (parsed.error) {
							reject(new Error(parsed.error));
							return;
						}
						if (code !== 0) {
							reject(
								new Error(
									`formula_refine_runner exited with ${code}: ${stderr}`,
								),
							);
							return;
						}
						resolve({ refined: parsed.refined ?? [] });
					} catch (err) {
						reject(
							new Error(
								`Failed to parse formula refine output: ${(err as Error).message} (stdout=${stdout.slice(0, 200)})`,
							),
						);
					}
				});

				// Feed the candidate payload on stdin (avoids argv quoting limits).
				child.stdin?.write(payload);
				child.stdin?.end();
			});
		},
	);
}
