/**
 * CI/CD pipeline loop (« Build rouge ») — provider-agnostic.
 *
 * Polls the configured CI provider (Azure DevOps, GitHub Actions, GitLab CI
 * or Jenkins — see ci-pipeline-providers.ts) for the latest run on each
 * task's worktree branch (`workpilot/{specId}`) and:
 *  - pushes a live pipeline badge to the kanban card (TASK_PIPELINE_STATUS_EVENT);
 *  - when a build goes red, moves the task to the `build_failed` column,
 *    writes the pipeline errors into `BUILD_FAILURE.md` in the spec dir, and
 *    (unless disabled) launches the agent to repair the build automatically
 *    by appending a "fix the CI build" subtask to the implementation plan.
 *
 * Configuration comes from the project's `.env` files (root and
 * {autoBuildPath}/.env): provider credentials (see ci-pipeline-providers.ts),
 * plus the generic knobs CICD_POLL_SECONDS (default 60) and
 * CICD_AUTO_FIX=false to disable the automatic repair loop
 * (AZURE_PIPELINE_POLL_SECONDS / AZURE_PIPELINE_AUTO_FIX still honored for
 * backward compatibility).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../shared/constants";
import type {
	Project,
	Task,
	TaskPipelineStatus,
	TaskStatus,
} from "../shared/types";
import type { AgentManager } from "./agent";
import {
	type MergedEnv,
	type PipelineProviderAdapter,
	type PipelineRun,
	resolvePipelineProvider,
} from "./ci-pipeline-providers";
import {
	getPlanPath,
	persistPlanStatus,
	updatePlanFile,
} from "./ipc-handlers/task/plan-file-utils";
import { parseEnvFile } from "./ipc-handlers/utils";
import { learningLoopService } from "./learning-loop-service";
import { projectStore } from "./project-store";

const DEFAULT_POLL_SECONDS = 60;
/** Re-resolve provider credentials at most every 5 minutes per project. */
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

/** Statuses whose branch has (or may have) pushed commits worth monitoring. */
const MONITORED_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"ai_review",
	"human_review",
	"build_failed",
	"done",
	"pr_created",
]);

/**
 * Merge the project's env files: root `.env` first, then
 * `{autoBuildPath}/.env` (the workpilot one wins on conflicts).
 */
export function readMergedProjectEnv(project: Project): MergedEnv {
	const merged: MergedEnv = {};
	const candidates = [
		path.join(project.path, ".env"),
		path.join(project.path, project.autoBuildPath || ".workpilot", ".env"),
	];
	for (const envPath of candidates) {
		try {
			if (existsSync(envPath)) {
				Object.assign(merged, parseEnvFile(readFileSync(envPath, "utf-8")));
			}
		} catch {
			/* unreadable env file — ignore */
		}
	}
	return merged;
}

function isAutoFixEnabled(env: MergedEnv): boolean {
	const value = env.CICD_AUTO_FIX ?? env.AZURE_PIPELINE_AUTO_FIX;
	return value !== "false";
}

function buildFailureMarkdown(
	status: TaskPipelineStatus,
	errors: string[],
): string {
	const lines = [
		"# CI Build Failure",
		"",
		`- Provider: ${status.providerLabel ?? status.provider ?? "unknown"}`,
		`- Pipeline: ${status.definitionName ?? "unknown"}`,
		`- Build: ${status.buildNumber ?? status.buildId ?? "unknown"}`,
		`- Branch: ${status.branch ?? "unknown"}`,
		`- Finished: ${status.finishTime ?? "unknown"}`,
		...(status.webUrl ? [`- URL: ${status.webUrl}`] : []),
		"",
		"## Errors reported by the pipeline",
		"",
	];
	if (errors.length > 0) {
		lines.push(...errors.map((e) => `- ${e}`));
	} else {
		lines.push(
			"- No structured error issues were reported; inspect the build logs at the URL above.",
		);
	}
	lines.push(
		"",
		"## Instructions",
		"",
		"The CI build for this task's branch is red. Reproduce the failure locally",
		"(restore/build/test with the project's standard commands), fix the root",
		"cause, and make sure the build passes before completing the subtask.",
		"",
	);
	return lines.join("\n");
}

function getSpecDir(project: Project, task: Task): string {
	return path.join(
		project.path,
		getSpecsDir(project.autoBuildPath),
		task.specId,
	);
}

interface CachedProvider {
	adapter: PipelineProviderAdapter | null;
	env: MergedEnv;
	resolvedAt: number;
}

class CiPipelineService {
	private timer: NodeJS.Timeout | null = null;
	private getMainWindow: (() => BrowserWindow | null) | null = null;
	private agentManager: AgentManager | null = null;
	private polling = false;
	private statuses = new Map<string, TaskPipelineStatus>();
	/** taskId -> run id whose failure has already been handled. */
	private handledFailedRuns = new Map<string, number | string>();
	private autoFixInFlight = new Set<string>();
	/** projectId -> resolved provider (TTL'd: credentials can use CLIs). */
	private providerCache = new Map<string, CachedProvider>();
	/** projectId -> last poll timestamp, to honor per-project CICD_POLL_SECONDS. */
	private lastPolledAt = new Map<string, number>();

	start(
		getMainWindow: () => BrowserWindow | null,
		agentManager: AgentManager,
	): void {
		this.getMainWindow = getMainWindow;
		this.agentManager = agentManager;
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.pollAll();
		}, DEFAULT_POLL_SECONDS * 1000);
		// First pass shortly after startup, once projects are loaded.
		setTimeout(() => void this.pollAll(), 10_000);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getStatus(taskId: string): TaskPipelineStatus | null {
		return this.statuses.get(taskId) ?? null;
	}

	/** On-demand refresh for a single task (renderer pull). */
	async refreshTask(taskId: string): Promise<TaskPipelineStatus | null> {
		const { task, project } = this.findTaskAndProject(taskId);
		if (!task || !project) return null;
		const cached = await this.getProvider(project, { forceRefresh: true });
		if (!cached.adapter) return null;
		await this.checkTask(project, cached, task);
		return this.getStatus(taskId);
	}

	private findTaskAndProject(taskId: string): {
		task: Task | undefined;
		project: Project | undefined;
	} {
		for (const project of projectStore.getProjects()) {
			const task = projectStore
				.getTasks(project.id)
				.find((t) => t.id === taskId || t.specId === taskId);
			if (task) return { task, project };
		}
		return { task: undefined, project: undefined };
	}

	private async getProvider(
		project: Project,
		options?: { forceRefresh?: boolean },
	): Promise<CachedProvider> {
		const cached = this.providerCache.get(project.id);
		if (
			cached &&
			!options?.forceRefresh &&
			Date.now() - cached.resolvedAt < PROVIDER_CACHE_TTL_MS
		) {
			return cached;
		}
		const env = readMergedProjectEnv(project);
		let adapter: PipelineProviderAdapter | null = null;
		try {
			adapter = await resolvePipelineProvider(project, env);
		} catch (err) {
			console.warn(
				`[CiPipeline] Provider resolution failed for ${project.name}:`,
				err,
			);
		}
		const entry: CachedProvider = { adapter, env, resolvedAt: Date.now() };
		this.providerCache.set(project.id, entry);
		return entry;
	}

	private async pollAll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			for (const project of projectStore.getProjects()) {
				const cached = await this.getProvider(project);
				if (!cached.adapter) continue;
				// Per-project poll interval (the global timer ticks every 60s; a
				// larger CICD_POLL_SECONDS simply skips some ticks).
				const configured = Number.parseInt(
					cached.env.CICD_POLL_SECONDS ??
						cached.env.AZURE_PIPELINE_POLL_SECONDS ??
						"",
					10,
				);
				const intervalMs =
					(Number.isFinite(configured) && configured >= 15
						? configured
						: DEFAULT_POLL_SECONDS) * 1000;
				const lastPolled = this.lastPolledAt.get(project.id) ?? 0;
				// 5s tolerance so a 60s interval doesn't skip every other 60s tick.
				if (Date.now() - lastPolled < intervalMs - 5000) continue;
				this.lastPolledAt.set(project.id, Date.now());
				const tasks = projectStore
					.getTasks(project.id)
					.filter((t) => MONITORED_STATUSES.has(t.status));
				for (const task of tasks) {
					try {
						await this.checkTask(project, cached, task);
					} catch (err) {
						console.warn(
							`[CiPipeline] Failed to check task ${task.specId}:`,
							err,
						);
					}
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private async checkTask(
		project: Project,
		cached: CachedProvider,
		task: Task,
	): Promise<void> {
		const adapter = cached.adapter;
		if (!adapter) return;
		const branch = `workpilot/${task.specId}`;
		const run = await adapter.fetchLatestRun(branch);
		if (!run) {
			// No pipeline run for this branch — nothing to show, drop stale state.
			if (this.statuses.delete(task.id)) {
				this.emitStatus({
					taskId: task.id,
					projectId: project.id,
					state: "none",
					provider: adapter.id,
					providerLabel: adapter.label,
					branch,
					checkedAt: new Date().toISOString(),
				});
			}
			return;
		}

		const previous = this.statuses.get(task.id);
		const status: TaskPipelineStatus = {
			taskId: task.id,
			projectId: project.id,
			state: run.state,
			provider: adapter.id,
			providerLabel: adapter.label,
			buildId: run.runId,
			buildNumber: run.runNumber,
			definitionName: run.definitionName,
			branch,
			webUrl: run.webUrl,
			queueTime: run.queueTime,
			finishTime: run.finishTime,
			checkedAt: new Date().toISOString(),
			autoFixInProgress: this.autoFixInFlight.has(task.id),
		};
		this.statuses.set(task.id, status);

		const changed =
			!previous ||
			previous.state !== status.state ||
			previous.buildId !== status.buildId;
		if (changed) {
			this.emitStatus(status);
		}

		if (
			status.state === "failed" &&
			this.handledFailedRuns.get(task.id) !== run.runId
		) {
			this.handledFailedRuns.set(task.id, run.runId);
			await this.handleRedBuild(project, cached, adapter, task, status, run);
		}
	}

	private emitStatus(status: TaskPipelineStatus): void {
		this.getMainWindow?.()?.webContents.send(
			IPC_CHANNELS.TASK_PIPELINE_STATUS_EVENT,
			status,
		);
	}

	/**
	 * A build went red: persist the failure context, move the task to the
	 * « Build rouge » column and (if enabled) launch the automatic repair.
	 */
	private async handleRedBuild(
		project: Project,
		cached: CachedProvider,
		adapter: PipelineProviderAdapter,
		task: Task,
		status: TaskPipelineStatus,
		run: PipelineRun,
	): Promise<void> {
		console.warn(
			`[CiPipeline] Red build ${status.buildNumber} (${adapter.label}) on ${status.branch} (task ${task.specId})`,
		);
		const errors = await adapter.fetchRunErrors(run).catch(() => []);

		const specDir = getSpecDir(project, task);
		try {
			writeFileSync(
				path.join(specDir, "BUILD_FAILURE.md"),
				buildFailureMarkdown(status, errors),
				"utf-8",
			);
		} catch (err) {
			console.warn("[CiPipeline] Could not write BUILD_FAILURE.md:", err);
		}

		// Feed the learning loop: a red build is a strong failure signal.
		learningLoopService.recordTaskOutcome(
			project.path,
			task.specId,
			"build_failed",
			errors.length
				? errors.join("\n").slice(0, 2000)
				: `CI build ${status.buildNumber ?? ""} failed on ${status.branch ?? ""}`,
		);

		// If the agent is already repairing (or the user moved the task back to
		// work), don't yank the task out of its column.
		if (task.status !== "in_progress" && task.status !== "build_failed") {
			const planPath = getPlanPath(project, task);
			await persistPlanStatus(planPath, "build_failed", project.id);
			this.getMainWindow?.()?.webContents.send(
				IPC_CHANNELS.TASK_STATUS_CHANGE,
				task.id,
				"build_failed",
				project.id,
			);
		}

		if (isAutoFixEnabled(cached.env)) {
			const result = await this.fixRedBuild(task.id);
			if (!result.success) {
				console.warn(
					`[CiPipeline] Auto-fix could not start for ${task.specId}: ${result.error}`,
				);
			}
		}
	}

	/**
	 * Launch the agent to repair a red build: append a "fix the CI build"
	 * subtask referencing BUILD_FAILURE.md to the plan, put the task back in
	 * progress and start the standard execution loop (which only runs pending
	 * subtasks).
	 */
	async fixRedBuild(
		taskId: string,
	): Promise<{ success: boolean; error?: string }> {
		const { task, project } = this.findTaskAndProject(taskId);
		if (!task || !project) {
			return { success: false, error: "Task not found" };
		}
		if (!this.agentManager) {
			return { success: false, error: "Agent manager not initialized" };
		}
		if (this.autoFixInFlight.has(task.id)) {
			return { success: false, error: "A repair run is already in flight" };
		}

		const status = this.statuses.get(task.id);
		const buildRef = status?.buildNumber ?? status?.buildId ?? "latest";
		const providerLabel = status?.providerLabel ?? "CI";
		const runRef = String(status?.buildId ?? Date.now()).replaceAll(
			/[^a-zA-Z0-9_-]/g,
			"-",
		);
		const subtaskId = `build-fix-${runRef}`;

		const planPath = getPlanPath(project, task);
		const updated = await updatePlanFile<Record<string, unknown>>(
			planPath,
			(plan) => {
				const phases = Array.isArray(plan.phases)
					? (plan.phases as Array<Record<string, unknown>>)
					: [];
				const alreadyQueued = phases.some(
					(phase) =>
						Array.isArray(phase.subtasks) &&
						(phase.subtasks as Array<Record<string, unknown>>).some(
							(st) => st.id === subtaskId,
						),
				);
				if (!alreadyQueued) {
					phases.push({
						phase: phases.length + 1,
						name: `CI build repair (${buildRef})`,
						type: "build_fix",
						subtasks: [
							{
								id: subtaskId,
								description:
									`The ${providerLabel} pipeline build ${buildRef} failed on branch ` +
									`${status?.branch ?? `workpilot/${task.specId}`}. Read BUILD_FAILURE.md ` +
									"in this spec directory for the pipeline errors, reproduce the failure, " +
									"fix the root cause and verify the project builds and tests pass.",
								status: "pending",
								files_to_modify: [],
							},
						],
					});
				}
				plan.phases = phases;
				plan.status = "in_progress";
				plan.planStatus = "in_progress";
				return plan;
			},
		);
		if (!updated) {
			return { success: false, error: "Implementation plan not found" };
		}
		projectStore.invalidateTasksCache(project.id);

		this.autoFixInFlight.add(task.id);
		this.getMainWindow?.()?.webContents.send(
			IPC_CHANNELS.TASK_STATUS_CHANGE,
			task.id,
			"in_progress",
			project.id,
		);

		try {
			await this.agentManager.startTaskExecution(
				task.id,
				project.path,
				task.specId,
				{
					parallel: false,
					workers: 1,
					baseBranch: task.metadata?.baseBranch || project.settings?.mainBranch,
					useWorktree: task.metadata?.useWorktree,
					useLocalBranch: task.metadata?.useLocalBranch,
				},
				project.id,
			);
		} finally {
			// The execution lifecycle is tracked elsewhere (agent events); the
			// in-flight flag only prevents double-launching from here.
			setTimeout(() => this.autoFixInFlight.delete(task.id), 60_000);
		}
		return { success: true };
	}
}

export const ciPipelineService = new CiPipelineService();
