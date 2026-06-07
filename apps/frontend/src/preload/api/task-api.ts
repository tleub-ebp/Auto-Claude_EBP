import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	ImageAttachment,
	ImplementationPlan,
	IPCResult,
	MergeProgress,
	PRDetailsResult,
	ReviewReason,
	SupportedIDE,
	SupportedTerminal,
	Task,
	TaskLogStreamChunk,
	TaskLogs,
	TaskMetadata,
	TaskRecoveryResult,
	TaskStartOptions,
	TaskStatus,
	VisualProofRun,
	WorktreeAnalyzeImpactResult,
	WorktreeCreatePROptions,
	WorktreeCreatePRResult,
} from "../../shared/types";

export interface TaskAPI {
	// Task Operations
	getTasks: (
		projectId: string,
		options?: { forceRefresh?: boolean },
	) => Promise<IPCResult<Task[]>>;
	createTask: (
		projectId: string,
		title: string,
		description: string,
		metadata?: TaskMetadata,
	) => Promise<IPCResult<Task>>;
	deleteTask: (taskId: string) => Promise<IPCResult>;
	updateTask: (
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			metadata?: Partial<TaskMetadata>;
		},
	) => Promise<IPCResult<Task>>;
	startTask: (taskId: string, options?: TaskStartOptions) => void;
	stopTask: (taskId: string) => void;
	submitReview: (
		taskId: string,
		approved: boolean,
		feedback?: string,
		images?: ImageAttachment[],
	) => Promise<IPCResult>;
	updateTaskStatus: (
		taskId: string,
		status: TaskStatus,
		options?: { forceCleanup?: boolean },
	) => Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }>;
	updatePlanSubtasks: (
		taskId: string,
		phases: Array<Record<string, unknown>>,
	) => Promise<IPCResult>;
	recoverStuckTask: (
		taskId: string,
		options?: import("../../shared/types").TaskRecoveryOptions,
	) => Promise<IPCResult<TaskRecoveryResult>>;
	checkTaskRunning: (taskId: string) => Promise<IPCResult<boolean>>;
	resumePausedTask: (taskId: string) => Promise<IPCResult>;
	resumeTaskSession: (taskId: string) => Promise<IPCResult>;
	resumeTaskWithProvider: (
		taskId: string,
		providerName: string,
		model?: string,
	) => Promise<IPCResult>;
	resetTaskConversation: (taskId: string) => Promise<IPCResult>;

	// Image Operations
	loadImageThumbnail: (
		projectPath: string,
		specId: string,
		imagePath: string,
	) => Promise<IPCResult<string>>;

	// Workspace Management (for human review)
	getWorktreeStatus: (
		taskId: string,
	) => Promise<IPCResult<import("../../shared/types").WorktreeStatus>>;
	getWorktreeDiff: (
		taskId: string,
	) => Promise<IPCResult<import("../../shared/types").WorktreeDiff>>;
	mergeWorktree: (
		taskId: string,
		options?: { noCommit?: boolean },
	) => Promise<IPCResult<import("../../shared/types").WorktreeMergeResult>>;
	mergeWorktreePreview: (
		taskId: string,
	) => Promise<IPCResult<import("../../shared/types").WorktreeMergeResult>>;
	discardWorktree: (
		taskId: string,
		skipStatusChange?: boolean,
	) => Promise<IPCResult<import("../../shared/types").WorktreeDiscardResult>>;
	discardOrphanedWorktree: (
		projectId: string,
		specName: string,
	) => Promise<IPCResult<import("../../shared/types").WorktreeDiscardResult>>;
	syncWorktreeFromBranch: (
		taskId: string,
		sourceBranch: string,
		strategy: "merge" | "rebase",
	) => Promise<IPCResult<import("../../shared/types").WorktreeSyncResult>>;
	clearStagedState: (
		taskId: string,
	) => Promise<IPCResult<{ cleared: boolean }>>;
	listWorktrees: (
		projectId: string,
		options?: { includeStats?: boolean },
	) => Promise<IPCResult<import("../../shared/types").WorktreeListResult>>;
	worktreeOpenInIDE: (
		worktreePath: string,
		ide: SupportedIDE,
		customPath?: string,
	) => Promise<IPCResult<{ opened: boolean }>>;
	worktreeOpenInTerminal: (
		worktreePath: string,
		terminal: SupportedTerminal,
		customPath?: string,
	) => Promise<IPCResult<{ opened: boolean }>>;
	worktreeDetectTools: () => Promise<
		IPCResult<{
			ides: Array<{
				id: string;
				name: string;
				path: string;
				installed: boolean;
			}>;
			terminals: Array<{
				id: string;
				name: string;
				path: string;
				installed: boolean;
			}>;
		}>
	>;
	worktreeReadFile: (
		worktreePath: string,
		relativePath: string,
	) => Promise<IPCResult<string>>;
	worktreeWriteFile: (
		worktreePath: string,
		relativePath: string,
		content: string,
	) => Promise<IPCResult<{ written: boolean }>>;
	worktreeDeleteFiles: (
		worktreePath: string,
		relativePaths: string[],
	) => Promise<IPCResult<{ deleted: string[]; failed: string[] }>>;
	archiveTasks: (
		projectId: string,
		taskIds: string[],
		version?: string,
	) => Promise<IPCResult<boolean>>;
	unarchiveTasks: (
		projectId: string,
		taskIds: string[],
	) => Promise<IPCResult<boolean>>;
	createWorktreePR: (
		taskId: string,
		options?: WorktreeCreatePROptions,
	) => Promise<IPCResult<WorktreeCreatePRResult>>;
	analyzeWorktreeImpact: (
		taskId: string,
		targetBranch?: string,
	) => Promise<IPCResult<WorktreeAnalyzeImpactResult>>;
	runVisualProof: (taskId: string) => Promise<IPCResult<VisualProofRun>>;
	getVisualProofStatus: (
		taskId: string,
	) => Promise<IPCResult<{ running: boolean }>>;
	getPRDetails: (
		prNumber: number,
		taskId?: string,
	) => Promise<IPCResult<PRDetailsResult>>;

	// Task Event Listeners
	// Note: projectId is optional for backward compatibility - events without projectId will still work
	onTaskProgress: (
		callback: (
			taskId: string,
			plan: ImplementationPlan,
			projectId?: string,
		) => void,
	) => () => void;
	onTaskError: (
		callback: (taskId: string, error: string, projectId?: string) => void,
	) => () => void;
	onTaskLog: (
		callback: (taskId: string, log: string, projectId?: string) => void,
	) => () => void;
	onTaskStatusChange: (
		callback: (
			taskId: string,
			status: TaskStatus,
			projectId?: string,
			reviewReason?: ReviewReason,
		) => void,
	) => () => void;
	onTaskExecutionProgress: (
		callback: (
			taskId: string,
			progress: import("../../shared/types").ExecutionProgress,
			projectId?: string,
		) => void,
	) => () => void;

	// Task Phase Logs
	getTaskLogs: (
		projectId: string,
		specId: string,
	) => Promise<IPCResult<TaskLogs | null>>;
	watchTaskLogs: (projectId: string, specId: string) => Promise<IPCResult>;
	unwatchTaskLogs: (specId: string) => Promise<IPCResult>;
	onTaskLogsChanged: (
		callback: (specId: string, logs: TaskLogs) => void,
	) => () => void;
	onTaskLogsStream: (
		callback: (specId: string, chunk: TaskLogStreamChunk) => void,
	) => () => void;

	// Merge Progress Events
	onMergeProgress: (
		callback: (taskId: string, progress: MergeProgress) => void,
	) => () => void;

	// Visual Proof Events
	onVisualProofRunning: (
		callback: (taskId: string, running: boolean) => void,
	) => () => void;
}

export const createTaskAPI = (): TaskAPI => ({
	// Task Operations
	getTasks: (
		projectId: string,
		options?: { forceRefresh?: boolean },
	): Promise<IPCResult<Task[]>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST, projectId, options),

	createTask: (
		projectId: string,
		title: string,
		description: string,
		metadata?: TaskMetadata,
	): Promise<IPCResult<Task>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_CREATE,
			projectId,
			title,
			description,
			metadata,
		),

	deleteTask: (taskId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, taskId),

	updateTask: (
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			metadata?: Partial<TaskMetadata>;
		},
	): Promise<IPCResult<Task>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_UPDATE, taskId, updates),

	startTask: (taskId: string, options?: TaskStartOptions): void =>
		ipcRenderer.send(IPC_CHANNELS.TASK_START, taskId, options),

	stopTask: (taskId: string): void =>
		ipcRenderer.send(IPC_CHANNELS.TASK_STOP, taskId),

	submitReview: (
		taskId: string,
		approved: boolean,
		feedback?: string,
		images?: ImageAttachment[],
	): Promise<IPCResult> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_REVIEW,
			taskId,
			approved,
			feedback,
			images,
		),

	updateTaskStatus: (
		taskId: string,
		status: TaskStatus,
		options?: { forceCleanup?: boolean },
	): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_UPDATE_STATUS,
			taskId,
			status,
			options,
		),

	updatePlanSubtasks: (
		taskId: string,
		phases: Array<Record<string, unknown>>,
	): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_UPDATE_PLAN, taskId, phases),

	recoverStuckTask: (
		taskId: string,
		options?: import("../../shared/types").TaskRecoveryOptions,
	): Promise<IPCResult<TaskRecoveryResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_RECOVER_STUCK, taskId, options),

	checkTaskRunning: (taskId: string): Promise<IPCResult<boolean>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_CHECK_RUNNING, taskId),

	resumePausedTask: (taskId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, taskId),

	resumeTaskSession: (taskId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME_SESSION, taskId),

	resumeTaskWithProvider: (
		taskId: string,
		providerName: string,
		model?: string,
	): Promise<IPCResult> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_RESUME_WITH_PROVIDER,
			taskId,
			providerName,
			model,
		),

	resetTaskConversation: (taskId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_RESET_CONVERSATION, taskId),

	// Image Operations
	loadImageThumbnail: (
		projectPath: string,
		specId: string,
		imagePath: string,
	): Promise<IPCResult<string>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_LOAD_IMAGE_THUMBNAIL,
			projectPath,
			specId,
			imagePath,
		),

	// Workspace Management
	getWorktreeStatus: (
		taskId: string,
	): Promise<IPCResult<import("../../shared/types").WorktreeStatus>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, taskId),

	getWorktreeDiff: (
		taskId: string,
	): Promise<IPCResult<import("../../shared/types").WorktreeDiff>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, taskId),

	mergeWorktree: (
		taskId: string,
		options?: { noCommit?: boolean },
	): Promise<IPCResult<import("../../shared/types").WorktreeMergeResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_MERGE, taskId, options),

	mergeWorktreePreview: (
		taskId: string,
	): Promise<IPCResult<import("../../shared/types").WorktreeMergeResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW, taskId),

	discardWorktree: (
		taskId: string,
		skipStatusChange?: boolean,
	): Promise<IPCResult<import("../../shared/types").WorktreeDiscardResult>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_DISCARD,
			taskId,
			skipStatusChange,
		),

	discardOrphanedWorktree: (
		projectId: string,
		specName: string,
	): Promise<IPCResult<import("../../shared/types").WorktreeDiscardResult>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN,
			projectId,
			specName,
		),

	syncWorktreeFromBranch: (
		taskId: string,
		sourceBranch: string,
		strategy: "merge" | "rebase",
	): Promise<IPCResult<import("../../shared/types").WorktreeSyncResult>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_SYNC_FROM_BRANCH,
			taskId,
			sourceBranch,
			strategy,
		),

	clearStagedState: (
		taskId: string,
	): Promise<IPCResult<{ cleared: boolean }>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, taskId),

	listWorktrees: (
		projectId: string,
		options?: { includeStats?: boolean },
	): Promise<IPCResult<import("../../shared/types").WorktreeListResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, projectId, options),

	worktreeOpenInIDE: (
		worktreePath: string,
		ide: SupportedIDE,
		customPath?: string,
	): Promise<IPCResult<{ opened: boolean }>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE,
			worktreePath,
			ide,
			customPath,
		),

	worktreeOpenInTerminal: (
		worktreePath: string,
		terminal: SupportedTerminal,
		customPath?: string,
	): Promise<IPCResult<{ opened: boolean }>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL,
			worktreePath,
			terminal,
			customPath,
		),

	worktreeDetectTools: (): Promise<
		IPCResult<{
			ides: Array<{
				id: string;
				name: string;
				path: string;
				installed: boolean;
			}>;
			terminals: Array<{
				id: string;
				name: string;
				path: string;
				installed: boolean;
			}>;
		}>
	> => ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS),

	worktreeReadFile: (worktreePath: string, relativePath: string) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_READ_FILE,
			worktreePath,
			relativePath,
		),

	worktreeWriteFile: (
		worktreePath: string,
		relativePath: string,
		content: string,
	) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE,
			worktreePath,
			relativePath,
			content,
		),

	worktreeDeleteFiles: (worktreePath: string, relativePaths: string[]) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_DELETE_FILES,
			worktreePath,
			relativePaths,
		),

	archiveTasks: (
		projectId: string,
		taskIds: string[],
		version?: string,
	): Promise<IPCResult<boolean>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_ARCHIVE, projectId, taskIds, version),

	unarchiveTasks: (
		projectId: string,
		taskIds: string[],
	): Promise<IPCResult<boolean>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_UNARCHIVE, projectId, taskIds),

	createWorktreePR: (
		taskId: string,
		options?: WorktreeCreatePROptions,
	): Promise<IPCResult<WorktreeCreatePRResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR, taskId, options),

	analyzeWorktreeImpact: (
		taskId: string,
		targetBranch?: string,
	): Promise<IPCResult<WorktreeAnalyzeImpactResult>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.TASK_WORKTREE_ANALYZE_IMPACT,
			taskId,
			targetBranch,
		),

	runVisualProof: (taskId: string): Promise<IPCResult<VisualProofRun>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, taskId),

	getVisualProofStatus: (
		taskId: string,
	): Promise<IPCResult<{ running: boolean }>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_STATUS, taskId),

	getPRDetails: (
		prNumber: number,
		taskId?: string,
	): Promise<IPCResult<PRDetailsResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PR_DETAILS, prNumber, taskId),

	// Task Event Listeners
	onTaskProgress: (
		callback: (
			taskId: string,
			plan: ImplementationPlan,
			projectId?: string,
		) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			plan: ImplementationPlan,
			projectId?: string,
		): void => {
			callback(taskId, plan, projectId);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_PROGRESS, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_PROGRESS, handler);
		};
	},

	onTaskError: (
		callback: (taskId: string, error: string, projectId?: string) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			error: string,
			projectId?: string,
		): void => {
			callback(taskId, error, projectId);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_ERROR, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_ERROR, handler);
		};
	},

	onTaskLog: (
		callback: (taskId: string, log: string, projectId?: string) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			log: string,
			projectId?: string,
		): void => {
			callback(taskId, log, projectId);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_LOG, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_LOG, handler);
		};
	},

	onTaskStatusChange: (
		callback: (
			taskId: string,
			status: TaskStatus,
			projectId?: string,
			reviewReason?: ReviewReason,
		) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			status: TaskStatus,
			projectId?: string,
			reviewReason?: ReviewReason,
		): void => {
			callback(taskId, status, projectId, reviewReason);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_STATUS_CHANGE, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_STATUS_CHANGE, handler);
		};
	},

	onTaskExecutionProgress: (
		callback: (
			taskId: string,
			progress: import("../../shared/types").ExecutionProgress,
			projectId?: string,
		) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			progress: import("../../shared/types").ExecutionProgress,
			projectId?: string,
		): void => {
			callback(taskId, progress, projectId);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_EXECUTION_PROGRESS, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_EXECUTION_PROGRESS, handler);
		};
	},

	// Task Phase Logs
	getTaskLogs: (
		projectId: string,
		specId: string,
	): Promise<IPCResult<TaskLogs | null>> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_LOGS_GET, projectId, specId),

	watchTaskLogs: (projectId: string, specId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_LOGS_WATCH, projectId, specId),

	unwatchTaskLogs: (specId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.TASK_LOGS_UNWATCH, specId),

	onTaskLogsChanged: (
		callback: (specId: string, logs: TaskLogs) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			specId: string,
			logs: TaskLogs,
		): void => {
			callback(specId, logs);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_LOGS_CHANGED, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_LOGS_CHANGED, handler);
		};
	},

	onTaskLogsStream: (
		callback: (specId: string, chunk: TaskLogStreamChunk) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			specId: string,
			chunk: TaskLogStreamChunk,
		): void => {
			callback(specId, chunk);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_LOGS_STREAM, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_LOGS_STREAM, handler);
		};
	},

	// Merge Progress Events
	onMergeProgress: (
		callback: (taskId: string, progress: MergeProgress) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			progress: MergeProgress,
		): void => {
			callback(taskId, progress);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_MERGE_PROGRESS, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_MERGE_PROGRESS, handler);
		};
	},

	onVisualProofRunning: (
		callback: (taskId: string, running: boolean) => void,
	): (() => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			taskId: string,
			running: boolean,
		): void => {
			callback(taskId, running);
		};
		ipcRenderer.on(IPC_CHANNELS.TASK_VISUAL_PROOF_RUNNING, handler);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.TASK_VISUAL_PROOF_RUNNING, handler);
		};
	},
});
