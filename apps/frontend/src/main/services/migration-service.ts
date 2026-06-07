/**
 * Migration Service - Handles auto-migration operations
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { ipcMain } from "electron";

export interface MigrationConfig {
	projectPath: string;
	targetFramework: string;
	enableLLM?: boolean;
	autoFix?: boolean;
}

export interface MigrationStatus {
	migrationId: string;
	state: string;
	currentPhase: string;
	progress: number;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	transformations?: any[];
	error?: string;
}

class MigrationService {
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	private activeMigrations: Map<string, any> = new Map();

	register() {
		// Start migration
		ipcMain.handle(
			"migration:start",
			async (_event, config: MigrationConfig) => {
				try {
					const result = await this.startMigration(config);
					return { success: true, ...result };
				} catch (error) {
					return { success: false, error: (error as Error).message };
				}
			},
		);

		// Get status
		ipcMain.handle(
			"migration:getStatus",
			async (_event, migrationId: string) => {
				try {
					const status = await this.getMigrationStatus(migrationId);
					return { success: true, ...status };
				} catch (error) {
					return { success: false, error: (error as Error).message };
				}
			},
		);

		// Pause migration
		ipcMain.handle("migration:pause", async (_event, migrationId: string) => {
			try {
				await this.pauseMigration(migrationId);
				return { success: true };
			} catch (error) {
				return { success: false, error: (error as Error).message };
			}
		});

		// Resume migration
		ipcMain.handle("migration:resume", async (_event, migrationId: string) => {
			try {
				const result = await this.resumeMigration(migrationId);
				return { success: true, ...result };
			} catch (error) {
				return { success: false, error: (error as Error).message };
			}
		});

		// Rollback migration
		ipcMain.handle(
			"migration:rollback",
			async (_event, migrationId: string, checkpoint?: string) => {
				try {
					await this.rollbackMigration(migrationId, checkpoint);
					return { success: true };
				} catch (error) {
					return { success: false, error: (error as Error).message };
				}
			},
		);

		// List supported migrations
		ipcMain.handle("migration:listSupported", async () => {
			return {
				success: true,
				migrations: [
					// Frontend Frameworks (Bidirectional)
					{
						source: "react",
						target: "vue",
						label: "React → Vue 3",
						complexity: "medium",
					},
					{
						source: "vue",
						target: "react",
						label: "Vue 3 → React",
						complexity: "medium",
					},
					{
						source: "react",
						target: "angular",
						label: "React → Angular",
						complexity: "high",
					},
					{
						source: "angular",
						target: "react",
						label: "Angular → React",
						complexity: "high",
					},
					{
						source: "vue",
						target: "angular",
						label: "Vue → Angular",
						complexity: "high",
					},
					{
						source: "angular",
						target: "vue",
						label: "Angular → Vue",
						complexity: "high",
					},
					{
						source: "react",
						target: "svelte",
						label: "React → Svelte",
						complexity: "medium",
					},
					{
						source: "svelte",
						target: "react",
						label: "Svelte → React",
						complexity: "medium",
					},
					{
						source: "vue",
						target: "svelte",
						label: "Vue → Svelte",
						complexity: "medium",
					},
					{
						source: "svelte",
						target: "vue",
						label: "Svelte → Vue",
						complexity: "medium",
					},

					// Databases (Bidirectional)
					{
						source: "mysql",
						target: "postgresql",
						label: "MySQL → PostgreSQL",
						complexity: "medium",
					},
					{
						source: "postgresql",
						target: "mysql",
						label: "PostgreSQL → MySQL",
						complexity: "medium",
					},
					{
						source: "mysql",
						target: "mongodb",
						label: "MySQL → MongoDB",
						complexity: "high",
					},
					{
						source: "mongodb",
						target: "mysql",
						label: "MongoDB → MySQL",
						complexity: "high",
					},
					{
						source: "postgresql",
						target: "mongodb",
						label: "PostgreSQL → MongoDB",
						complexity: "high",
					},
					{
						source: "mongodb",
						target: "postgresql",
						label: "MongoDB → PostgreSQL",
						complexity: "high",
					},
					{
						source: "sqlite",
						target: "postgresql",
						label: "SQLite → PostgreSQL",
						complexity: "low",
					},
					{
						source: "postgresql",
						target: "sqlite",
						label: "PostgreSQL → SQLite",
						complexity: "low",
					},

					// Languages
					{
						source: "python2",
						target: "python3",
						label: "Python 2 → Python 3",
						complexity: "medium",
					},
					{
						source: "javascript",
						target: "typescript",
						label: "JavaScript → TypeScript",
						complexity: "low",
					},
					{
						source: "typescript",
						target: "javascript",
						label: "TypeScript → JavaScript",
						complexity: "low",
					},
					{
						source: "javascript",
						target: "python",
						label: "JavaScript → Python",
						complexity: "high",
					},
					{
						source: "python",
						target: "javascript",
						label: "Python → JavaScript",
						complexity: "high",
					},
					{
						source: "javascript",
						target: "csharp",
						label: "JavaScript → C#",
						complexity: "high",
					},
					{
						source: "csharp",
						target: "javascript",
						label: "C# → JavaScript",
						complexity: "high",
					},
					{
						source: "python",
						target: "csharp",
						label: "Python → C#",
						complexity: "high",
					},
					{
						source: "csharp",
						target: "python",
						label: "C# → Python",
						complexity: "high",
					},
					{
						source: "java",
						target: "kotlin",
						label: "Java → Kotlin",
						complexity: "medium",
					},
					{
						source: "kotlin",
						target: "java",
						label: "Kotlin → Java",
						complexity: "medium",
					},
					{
						source: "javascript",
						target: "go",
						label: "JavaScript → Go",
						complexity: "high",
					},
					{
						source: "go",
						target: "javascript",
						label: "Go → JavaScript",
						complexity: "high",
					},
					{
						source: "python",
						target: "go",
						label: "Python → Go",
						complexity: "high",
					},
					{
						source: "go",
						target: "python",
						label: "Go → Python",
						complexity: "high",
					},

					// API Styles
					{
						source: "rest",
						target: "graphql",
						label: "REST → GraphQL",
						complexity: "high",
					},
					{
						source: "graphql",
						target: "rest",
						label: "GraphQL → REST",
						complexity: "high",
					},
					{
						source: "rest",
						target: "grpc",
						label: "REST → gRPC",
						complexity: "high",
					},
					{
						source: "grpc",
						target: "rest",
						label: "gRPC → REST",
						complexity: "high",
					},

					// Backend Frameworks
					{
						source: "express",
						target: "fastify",
						label: "Express → Fastify",
						complexity: "medium",
					},
					{
						source: "fastify",
						target: "express",
						label: "Fastify → Express",
						complexity: "medium",
					},
					{
						source: "django",
						target: "fastapi",
						label: "Django → FastAPI",
						complexity: "high",
					},
					{
						source: "fastapi",
						target: "django",
						label: "FastAPI → Django",
						complexity: "high",
					},
					{
						source: "flask",
						target: "fastapi",
						label: "Flask → FastAPI",
						complexity: "medium",
					},
					{
						source: "fastapi",
						target: "flask",
						label: "FastAPI → Flask",
						complexity: "medium",
					},
					{
						source: "rails",
						target: "sinatra",
						label: "Rails → Sinatra",
						complexity: "high",
					},
					{
						source: "sinatra",
						target: "rails",
						label: "Sinatra → Rails",
						complexity: "high",
					},

					// CSS Frameworks
					{
						source: "sass",
						target: "less",
						label: "Sass → Less",
						complexity: "low",
					},
					{
						source: "less",
						target: "sass",
						label: "Less → Sass",
						complexity: "low",
					},
					{
						source: "sass",
						target: "tailwind",
						label: "Sass → Tailwind",
						complexity: "high",
					},
					{
						source: "less",
						target: "tailwind",
						label: "Less → Tailwind",
						complexity: "high",
					},
					{
						source: "bootstrap",
						target: "tailwind",
						label: "Bootstrap → Tailwind",
						complexity: "medium",
					},
					{
						source: "tailwind",
						target: "bootstrap",
						label: "Tailwind → Bootstrap",
						complexity: "medium",
					},

					// Build Tools
					{
						source: "webpack",
						target: "vite",
						label: "Webpack → Vite",
						complexity: "medium",
					},
					{
						source: "vite",
						target: "webpack",
						label: "Vite → Webpack",
						complexity: "medium",
					},
					{
						source: "webpack",
						target: "rollup",
						label: "Webpack → Rollup",
						complexity: "medium",
					},
					{
						source: "rollup",
						target: "webpack",
						label: "Rollup → Webpack",
						complexity: "medium",
					},
					{
						source: "gulp",
						target: "vite",
						label: "Gulp → Vite",
						complexity: "high",
					},
					{
						source: "grunt",
						target: "vite",
						label: "Grunt → Vite",
						complexity: "high",
					},

					// Testing Frameworks
					{
						source: "jest",
						target: "vitest",
						label: "Jest → Vitest",
						complexity: "low",
					},
					{
						source: "vitest",
						target: "jest",
						label: "Vitest → Jest",
						complexity: "low",
					},
					{
						source: "mocha",
						target: "jest",
						label: "Mocha → Jest",
						complexity: "medium",
					},
					{
						source: "jest",
						target: "mocha",
						label: "Jest → Mocha",
						complexity: "medium",
					},
					{
						source: "unittest",
						target: "pytest",
						label: "unittest → pytest",
						complexity: "medium",
					},
					{
						source: "pytest",
						target: "unittest",
						label: "pytest → unittest",
						complexity: "medium",
					},

					// Mobile Frameworks
					{
						source: "reactnative",
						target: "flutter",
						label: "React Native → Flutter",
						complexity: "very_high",
					},
					{
						source: "flutter",
						target: "reactnative",
						label: "Flutter → React Native",
						complexity: "very_high",
					},
					{
						source: "ionic",
						target: "reactnative",
						label: "Ionic → React Native",
						complexity: "high",
					},
					{
						source: "reactnative",
						target: "ionic",
						label: "React Native → Ionic",
						complexity: "high",
					},

					// Package Managers
					{
						source: "npm",
						target: "yarn",
						label: "npm → Yarn",
						complexity: "low",
					},
					{
						source: "yarn",
						target: "pnpm",
						label: "Yarn → pnpm",
						complexity: "low",
					},
					{
						source: "pnpm",
						target: "npm",
						label: "pnpm → npm",
						complexity: "low",
					},
					{
						source: "pip",
						target: "poetry",
						label: "pip → Poetry",
						complexity: "low",
					},
					{
						source: "poetry",
						target: "pip",
						label: "Poetry → pip",
						complexity: "low",
					},
				],
			};
		});
	}

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	private async startMigration(config: MigrationConfig): Promise<any> {
		return new Promise((resolve, reject) => {
			const pythonPath: string = process.env.PYTHON_PATH || "python";
			const backendPath = path.join(__dirname, "..", "..", "..", "backend");

			const args = [
				"-m",
				"migration",
				"migrate",
				"--project-dir",
				config.projectPath,
				"--target-framework",
				config.targetFramework,
			];

			if (config.enableLLM) {
				args.push("--enable-llm");
			}

			if (config.autoFix) {
				args.push("--auto-fix");
			}

			const childProcess = spawn(pythonPath, args, {
				cwd: backendPath,
				env: { ...process.env, PYTHONPATH: backendPath },
			});

			let output = "";
			let errorOutput = "";

			childProcess.stdout.on("data", (data) => {
				output += data.toString();
			});

			childProcess.stderr.on("data", (data) => {
				errorOutput += data.toString();
			});

			childProcess.on("close", (code) => {
				if (code === 0) {
					try {
						// Parse output to get migration ID
						const lines = output.split("\n");
						const idLine = lines.find((l) => l.includes("Migration ID:"));
						const migrationId = idLine ? idLine.split(":")[1].trim() : null;

						if (migrationId) {
							this.activeMigrations.set(migrationId, {
								config,
								startedAt: new Date(),
							});

							resolve({ migrationId });
						} else {
							reject(new Error("Failed to get migration ID"));
						}
					} catch (error) {
						reject(error);
					}
				} else {
					reject(new Error(errorOutput || "Migration failed to start"));
				}
			});

			childProcess.on("error", (error) => {
				reject(error);
			});
		});
	}

	private async getMigrationStatus(
		migrationId: string,
	): Promise<MigrationStatus> {
		return new Promise((resolve, reject) => {
			const pythonPath: string = process.env.PYTHON_PATH || "python";
			const backendPath = path.join(__dirname, "..", "..", "..", "backend");

			const childProcess = spawn(
				pythonPath,
				["-m", "migration", "status", "--migration-id", migrationId, "--json"],
				{
					cwd: backendPath,
				},
			);

			let output = "";
			let errorOutput = "";

			childProcess.stdout.on("data", (data) => {
				output += data.toString();
			});

			childProcess.stderr.on("data", (data) => {
				errorOutput += data.toString();
			});

			childProcess.on("close", (code) => {
				if (code === 0) {
					try {
						const status = JSON.parse(output);
						resolve(status);
					} catch (_error) {
						reject(new Error("Failed to parse status"));
					}
				} else {
					reject(new Error(errorOutput || "Failed to get status"));
				}
			});

			childProcess.on("error", (error) => {
				reject(error);
			});
		});
	}

	private async pauseMigration(migrationId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const pythonPath: string = process.env.PYTHON_PATH || "python";
			const backendPath = path.join(__dirname, "..", "..", "..", "backend");

			const childProcess = spawn(
				pythonPath,
				["-m", "migration", "pause", "--migration-id", migrationId],
				{
					cwd: backendPath,
				},
			);

			childProcess.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error("Failed to pause migration"));
				}
			});

			childProcess.on("error", (error) => {
				reject(error);
			});
		});
	}

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	private async resumeMigration(migrationId: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const pythonPath: string = process.env.PYTHON_PATH || "python";
			const backendPath = path.join(__dirname, "..", "..", "..", "backend");

			const childProcess = spawn(
				pythonPath,
				["-m", "migration", "resume", "--migration-id", migrationId],
				{
					cwd: backendPath,
				},
			);

			childProcess.on("close", (code) => {
				if (code === 0) {
					resolve({ migrationId });
				} else {
					reject(new Error("Failed to resume migration"));
				}
			});

			childProcess.on("error", (error) => {
				reject(error);
			});
		});
	}

	private async rollbackMigration(
		migrationId: string,
		checkpoint?: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const pythonPath: string = process.env.PYTHON_PATH || "python";
			const backendPath = path.join(__dirname, "..", "..", "..", "backend");

			const args = [
				"-m",
				"migration",
				"rollback",
				"--migration-id",
				migrationId,
			];

			if (checkpoint) {
				args.push("--checkpoint", checkpoint);
			}

			const childProcess = spawn(pythonPath, args, {
				cwd: backendPath,
			});

			childProcess.on("close", (code) => {
				if (code === 0) {
					this.activeMigrations.delete(migrationId);
					resolve();
				} else {
					reject(new Error("Failed to rollback migration"));
				}
			});

			childProcess.on("error", (error) => {
				reject(error);
			});
		});
	}
}

export const migrationService = new MigrationService();
