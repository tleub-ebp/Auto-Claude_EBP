/**
 * CI/CD pipeline IPC handlers (« Build rouge » loop) — provider-agnostic
 * (Azure DevOps, GitHub Actions, GitLab CI, Jenkins).
 *
 * Channels:
 *   task:pipelineStatusGet — On-demand fetch of the latest run for a task's branch
 *   task:pipelineFix       — Launch the agent to repair a red build
 *
 * The polling loop itself lives in ci-pipeline-service.ts and pushes
 * task:pipelineStatus events to the renderer.
 */

import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult, TaskPipelineStatus } from "../../shared/types";
import type { AgentManager } from "../agent";
import { ciPipelineService } from "../ci-pipeline-service";

export function registerPipelineHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	// Start the background polling loop (no-op for projects without CI config)
	ciPipelineService.start(getMainWindow, agentManager);

	ipcMain.handle(
		IPC_CHANNELS.TASK_PIPELINE_STATUS_GET,
		async (
			_,
			taskId: string,
			options?: { refresh?: boolean },
		): Promise<IPCResult<TaskPipelineStatus | null>> => {
			try {
				const status = options?.refresh
					? await ciPipelineService.refreshTask(taskId)
					: ciPipelineService.getStatus(taskId);
				return { success: true, data: status };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_PIPELINE_FIX,
		async (_, taskId: string): Promise<IPCResult> => {
			try {
				const result = await ciPipelineService.fixRedBuild(taskId);
				return result.success
					? { success: true }
					: { success: false, error: result.error };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);
}
