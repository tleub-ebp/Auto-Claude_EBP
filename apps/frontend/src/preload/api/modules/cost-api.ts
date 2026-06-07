/**
 * Cost Estimator Preload API
 * Exposes cost summary and budget IPC calls to the renderer process.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface CostSummary {
	total_cost: number;
	cost_by_provider: Record<string, number>;
	cost_by_model: Record<string, number>;
	total_tokens: number;
	tokens_input: number;
	tokens_output: number;
	period_days: number;
	daily_avg: number;
	trend_pct: number;
}

export interface BudgetInfo {
	monthly_budget: number;
	spent_this_month: number;
	remaining: number;
	utilization_pct: number;
	alerts: string[];
	forecast_end_of_month: number;
}

export interface DashboardSnapshot {
	tasks_by_status: Record<string, number>;
	avg_completion_by_complexity: Record<string, number>;
	qa_first_pass_rate: number;
	qa_avg_score: number;
	total_tokens: number;
	tokens_by_provider: Record<string, number>;
	total_cost: number;
	cost_by_model: Record<string, number>;
	merge_auto_count: number;
	merge_manual_count: number;
}

export interface ContextUsage {
	provider: string;
	model: string;
	/** input_tokens de la dernière requête = remplissage du contexte */
	contextTokens: number;
	outputTokens: number;
	timestamp: string;
}

export interface CostAPI {
	getCostSummary(
		projectPath: string,
	): Promise<{ success: boolean; summary?: CostSummary; error?: string }>;
	getContextUsage(
		projectPath: string,
		provider: string,
	): Promise<{
		success: boolean;
		contextUsage?: ContextUsage | null;
		error?: string;
	}>;
	getCostBudget(
		projectPath: string,
	): Promise<{ success: boolean; budget?: BudgetInfo; error?: string }>;
	setCostBudget(
		projectPath: string,
		limit: number,
		period?: string,
	): Promise<{ success: boolean; error?: string }>;
	getDashboardSnapshot(projectPath: string): Promise<{
		success: boolean;
		snapshot?: DashboardSnapshot;
		error?: string;
	}>;
	onCostsUpdated(callback: (projectPath: string) => void): () => void;
	onDashboardSnapshotUpdated(
		callback: (projectPath: string) => void,
	): () => void;
}

export const createCostAPI = (): CostAPI => ({
	getCostSummary: (projectPath: string) =>
		ipcRenderer.invoke("costs:getSummary", projectPath),

	getContextUsage: (projectPath: string, provider: string) =>
		ipcRenderer.invoke("costs:getContextUsage", projectPath, provider),

	getCostBudget: (projectPath: string) =>
		ipcRenderer.invoke("costs:getBudget", projectPath),

	setCostBudget: (projectPath: string, limit: number, period = "monthly") =>
		ipcRenderer.invoke("costs:setBudget", projectPath, limit, period),

	getDashboardSnapshot: (projectPath: string) =>
		ipcRenderer.invoke("dashboard:getSnapshot", projectPath),

	onCostsUpdated: (callback: (projectPath: string) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, projectPath: string) =>
			callback(projectPath);
		ipcRenderer.on(IPC_CHANNELS.COSTS_DATA_UPDATED, handler);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.COSTS_DATA_UPDATED, handler);
	},

	onDashboardSnapshotUpdated: (callback: (projectPath: string) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, projectPath: string) =>
			callback(projectPath);
		ipcRenderer.on(IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED, handler);
		return () =>
			ipcRenderer.removeListener(
				IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED,
				handler,
			);
	},
});
