import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	AzureDevOpsImportResult,
	AzureDevOpsProject,
	AzureDevOpsRepository,
	AzureDevOpsSyncStatus,
	AzureDevOpsWorkItem,
	IPCResult,
} from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

/**
 * Azure DevOps Integration API operations
 */
export interface AzureDevOpsAPI {
	getAzureDevOpsProjects: (
		projectId: string,
	) => Promise<IPCResult<AzureDevOpsProject[]>>;
	listAzureDevOpsRepositories: (
		projectId: string,
	) => Promise<IPCResult<AzureDevOpsRepository[]>>;
	detectAzureDevOpsRepository: (
		projectId: string,
	) => Promise<IPCResult<{ repository: string | null }>>;
	getAzureDevOpsWorkItems: (
		projectId: string,
		azureProject?: string,
		itemTypes?: string[],
		maxItems?: number,
	) => Promise<IPCResult<AzureDevOpsWorkItem[]>>;
	getAzureDevOpsWorkItem: (
		projectId: string,
		workItemId: number,
	) => Promise<IPCResult<AzureDevOpsWorkItem>>;
	importAzureDevOpsWorkItems: (
		projectId: string,
		workItemIds: number[],
	) => Promise<IPCResult<AzureDevOpsImportResult>>;
	checkAzureDevOpsConnection: (
		projectId: string,
	) => Promise<IPCResult<AzureDevOpsSyncStatus>>;
	syncAzureDevOpsTaskAC: (
		projectId: string,
		taskId: string,
		workItemId: number,
	) => Promise<IPCResult<{ acceptanceCriteria: string[] }>>;
	hydrateAzureDevOpsTaskDisplay: (
		projectId: string,
		taskId: string,
	) => Promise<IPCResult<{ html: string; title?: string }>>;
}

/**
 * Creates the Azure DevOps Integration API implementation
 */
export const createAzureDevOpsAPI = (): AzureDevOpsAPI => ({
	getAzureDevOpsProjects: (
		projectId: string,
	): Promise<IPCResult<AzureDevOpsProject[]>> =>
		invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_PROJECTS, projectId),

	listAzureDevOpsRepositories: (
		projectId: string,
	): Promise<IPCResult<AzureDevOpsRepository[]>> =>
		invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES, projectId),

	detectAzureDevOpsRepository: (
		projectId: string,
	): Promise<IPCResult<{ repository: string | null }>> =>
		invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, projectId),

	getAzureDevOpsWorkItems: (
		projectId: string,
		azureProject?: string,
		itemTypes?: string[],
		maxItems?: number,
	): Promise<IPCResult<AzureDevOpsWorkItem[]>> =>
		invokeIpc(
			IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS,
			projectId,
			azureProject,
			itemTypes,
			maxItems,
		),

	getAzureDevOpsWorkItem: (
		projectId: string,
		workItemId: number,
	): Promise<IPCResult<AzureDevOpsWorkItem>> =>
		invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, projectId, workItemId),

	importAzureDevOpsWorkItems: (
		projectId: string,
		workItemIds: number[],
		options?: { requireReviewBeforeCoding?: boolean },
	): Promise<IPCResult<AzureDevOpsImportResult>> =>
		invokeIpc(
			IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS,
			projectId,
			workItemIds,
			options,
		),

	checkAzureDevOpsConnection: (
		projectId: string,
	): Promise<IPCResult<AzureDevOpsSyncStatus>> =>
		invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, projectId),

	syncAzureDevOpsTaskAC: (
		projectId: string,
		taskId: string,
		workItemId: number,
	): Promise<IPCResult<{ acceptanceCriteria: string[] }>> =>
		invokeIpc(
			IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC,
			projectId,
			taskId,
			workItemId,
		),

	hydrateAzureDevOpsTaskDisplay: (
		projectId: string,
		taskId: string,
	): Promise<IPCResult<{ html: string; title?: string }>> =>
		invokeIpc(
			IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY,
			projectId,
			taskId,
		),
});
