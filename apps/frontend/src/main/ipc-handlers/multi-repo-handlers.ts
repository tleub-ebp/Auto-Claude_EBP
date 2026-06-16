import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	IPCResult,
	MultiRepoCreateConfig,
	MultiRepoOrchestration,
	MultiRepoStatus,
	RepoExecutionState,
} from "../../shared/types";
import { slugifySpecTitle } from "../../shared/utils/spec-slug";
import { debugError, debugLog } from "../../shared/utils/debug-logger";
import type { AgentManager } from "../agent";
import { projectStore } from "../project-store";
import { safeSendToRenderer } from "./utils";

const MANIFEST_FILE = "multi_repo_manifest.json";

/**
 * Load orchestration manifest from a spec directory
 */
function loadManifest(specDir: string): MultiRepoOrchestration | null {
	const manifestPath = path.join(specDir, MANIFEST_FILE);
	if (!existsSync(manifestPath)) return null;

	try {
		const data = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return {
			id: path.basename(specDir),
			taskDescription: data.task_description || "",
			status: data.status || "pending",
			repos: (data.repos || []).map((r: Record<string, unknown>) => ({
				id: String(r.repo || "").replace(/[^\w-]/g, "_"),
				repo: String(r.repo || ""),
				displayName: String(r.repo || ""),
				localPath: String(r.repo_path || ""),
			})),
			dependencyGraph: {
				nodes: data.dependency_graph?.repos || [],
				edges: (data.dependency_graph?.dependencies || []).map(
					(d: Record<string, unknown>) => ({
						source: d.source_repo,
						target: d.target_repo,
						type: d.dependency_type,
						details: d.details,
					}),
				),
			},
			executionOrder: data.execution_order || [],
			repoStates: (data.repos || []).map((r: Record<string, unknown>) => ({
				repo: String(r.repo || ""),
				status: String(r.status || "pending"),
				prUrl: String(r.pr_url || ""),
				branchName: String(r.branch_name || ""),
				progress: Number(r.progress || 0),
				currentPhase: String(r.current_phase || ""),
				errorMessage: String(r.error_message || ""),
			})),
			masterSpecDir: specDir,
			breakingChanges: (data.breaking_changes || []).map(
				(bc: Record<string, unknown>) => ({
					sourceRepo: bc.source_repo,
					targetRepo: bc.target_repo,
					changeType: bc.change_type,
					description: bc.description,
					severity: bc.severity,
					filePath: bc.file_path || "",
					suggestion: bc.suggestion || "",
				}),
			),
			overallProgress: 0,
			createdAt: String(data.created_at || ""),
			updatedAt: String(data.updated_at || ""),
		} as MultiRepoOrchestration;
	} catch (error) {
		debugError("[MultiRepo] Failed to load manifest:", error);
		return null;
	}
}

/**
 * Find all multi-repo orchestrations for a project
 */
function findOrchestrations(projectPath: string): MultiRepoOrchestration[] {
	const specsDir = path.join(projectPath, ".workpilot", "specs");
	if (!existsSync(specsDir)) return [];

	const orchestrations: MultiRepoOrchestration[] = [];
	try {
		const dirs = readdirSync(specsDir, { withFileTypes: true });
		for (const dir of dirs) {
			if (!dir.isDirectory()) continue;
			const specDir = path.join(specsDir, dir.name);
			const manifestPath = path.join(specDir, MANIFEST_FILE);
			if (existsSync(manifestPath)) {
				const orch = loadManifest(specDir);
				if (orch) orchestrations.push(orch);
			}
		}
	} catch (error) {
		debugError("[MultiRepo] Failed to list orchestrations:", error);
	}

	return orchestrations;
}

/**
 * Register all multi-repo orchestration IPC handlers
 */
export function registerMultiRepoHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	// CREATE - Initialize a new multi-repo orchestration
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_CREATE,
		async (
			_,
			projectId: string,
			config: MultiRepoCreateConfig,
		): Promise<IPCResult<MultiRepoOrchestration>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				// Validate repos
				if (!config.repos || config.repos.length < 2) {
					return {
						success: false,
						error: "At least 2 repositories are required",
					};
				}

				if (!config.taskDescription?.trim()) {
					return { success: false, error: "Task description is required" };
				}

				// Validate repo paths exist
				for (const repo of config.repos) {
					if (!existsSync(repo.localPath)) {
						return {
							success: false,
							error: `Repository path not found: ${repo.localPath}`,
						};
					}
				}

				// Create spec directory
				const specsDir = path.join(project.path, ".workpilot", "specs");
				mkdirSync(specsDir, { recursive: true });

				// Find next spec number
				let maxNum = 0;
				if (existsSync(specsDir)) {
					const existing = readdirSync(specsDir);
					for (const name of existing) {
						const match = name.match(/^(\d+)-/);
						if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
					}
				}

				const slug = slugifySpecTitle(config.taskDescription);
				const specName = `${String(maxNum + 1).padStart(3, "0")}-multi-repo-${slug}`;
				const specDir = path.join(specsDir, specName);
				mkdirSync(specDir, { recursive: true });

				// Write initial manifest
				const manifest = {
					task_description: config.taskDescription,
					repos: config.repos.map((r) => ({
						repo: r.repo,
						repo_path: r.localPath,
						status: "pending",
						progress: 0,
					})),
					dependency_graph: {
						repos: config.repos.map((r) => r.repo),
						dependencies: [],
					},
					execution_order: config.repos.map((r) => r.repo),
					status: "pending",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					breaking_changes: [],
				};

				writeFileSync(
					path.join(specDir, MANIFEST_FILE),
					JSON.stringify(manifest, null, 2),
					"utf-8",
				);

				const orchestration = loadManifest(specDir);
				if (!orchestration) {
					return {
						success: false,
						error: "Failed to create orchestration manifest",
					};
				}

				debugLog("[MultiRepo] Created orchestration:", specName);
				return { success: true, data: orchestration };
			} catch (error) {
				debugError("[MultiRepo] Create failed:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	// GET - Get a specific orchestration
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_GET,
		async (
			_,
			orchestrationId: string,
			projectId: string,
		): Promise<IPCResult<MultiRepoOrchestration | null>> => {
			const project = projectStore.getProject(projectId);
			if (!project) return { success: false, error: "Project not found" };

			const specDir = path.join(
				project.path,
				".workpilot",
				"specs",
				orchestrationId,
			);
			const orchestration = loadManifest(specDir);
			return { success: true, data: orchestration };
		},
	);

	// LIST - List all orchestrations for a project
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_LIST,
		async (
			_,
			projectId: string,
		): Promise<IPCResult<MultiRepoOrchestration[]>> => {
			const project = projectStore.getProject(projectId);
			if (!project) return { success: false, error: "Project not found" };

			const orchestrations = findOrchestrations(project.path);
			return { success: true, data: orchestrations };
		},
	);

	// START - Begin orchestration execution
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_START,
		async (
			_,
			projectId: string,
			orchestrationId: string,
		): Promise<IPCResult> => {
			const project = projectStore.getProject(projectId);
			if (!project) return { success: false, error: "Project not found" };

			const specDir = path.join(
				project.path,
				".workpilot",
				"specs",
				orchestrationId,
			);
			const manifest = loadManifest(specDir);
			if (!manifest)
				return { success: false, error: "Orchestration not found" };

			try {
				// Build repos argument
				const reposArg = manifest.repos
					.map((r) => `${r.repo}::${r.localPath}`)
					.join(",");

				debugLog(
					`[MultiRepo] Starting orchestration ${orchestrationId} with ${manifest.repos.length} repos`,
				);

				// Spawn multi_repo_runner.py via agent manager
				// The runner emits [MULTI_REPO] events that we parse
				agentManager.emit("multi-repo-start", orchestrationId, {
					task: manifest.taskDescription,
					repos: reposArg,
					projectDir: project.path,
					specDir,
				});

				return { success: true };
			} catch (error) {
				debugError("[MultiRepo] Start failed:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	// STOP - Cancel execution
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_STOP,
		async (_, orchestrationId: string): Promise<IPCResult> => {
			try {
				agentManager.emit("multi-repo-stop", orchestrationId);
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// GET STATUS - Get current execution status
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_GET_STATUS,
		async (
			_,
			orchestrationId: string,
			projectId: string,
		): Promise<
			IPCResult<{ status: MultiRepoStatus; repoStates: RepoExecutionState[] }>
		> => {
			const project = projectStore.getProject(projectId);
			if (!project) return { success: false, error: "Project not found" };

			const specDir = path.join(
				project.path,
				".workpilot",
				"specs",
				orchestrationId,
			);
			const manifest = loadManifest(specDir);
			if (!manifest)
				return { success: false, error: "Orchestration not found" };

			return {
				success: true,
				data: {
					status: manifest.status,
					repoStates: manifest.repoStates,
				},
			};
		},
	);

	// Forward multi-repo events from agent manager to renderer
	agentManager.on(
		"multi-repo-progress",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_PROGRESS,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-repo-start",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_REPO_START,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-repo-complete",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_REPO_COMPLETE,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-complete",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_COMPLETE,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-error",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_ERROR,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-breaking-change",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_BREAKING_CHANGE,
				orchestrationId,
				data,
			);
		},
	);

	agentManager.on(
		"multi-repo-graph",
		(orchestrationId: string, data: Record<string, unknown>) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_GRAPH,
				orchestrationId,
				data,
			);
		},
	);

	debugLog("[MultiRepo] IPC handlers registered");
}
