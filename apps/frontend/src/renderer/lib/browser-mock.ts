/**
 * Browser mock for window.electronAPI
 * This allows the app to run in a regular browser for UI development/testing
 *
 * This module aggregates all mock implementations from separate modules
 * for better code organization and maintainability.
 */

import type { ElectronAPI } from "../../shared/types";
import {
	changelogMock,
	claudeProfileMock,
	contextMock,
	infrastructureMock,
	insightsMock,
	integrationMock,
	phase35Mock,
	projectMock,
	settingsMock,
	taskMock,
	terminalMock,
	workspaceMock,
} from "./mocks";

// Check if we're in a browser (not Electron)
const isElectron =
	typeof window !== "undefined" && window.electronAPI !== undefined;

/**
 * Create mock electronAPI for browser
 * Aggregates all mock implementations from separate modules
 */
const browserMockAPI: ElectronAPI = {
	// Project Operations
	...projectMock,

	// Task Operations
	...taskMock,

	// Workspace Management
	...workspaceMock,

	// Phase 3-5 backend feature modules (browser fallback: report unavailable)
	...phase35Mock,

	// Terminal Operations
	...terminalMock,

	// Claude Profile Management
	...claudeProfileMock,

	// Settings
	...settingsMock,

	// Roadmap Operations
	getRoadmap: async () => ({
		success: true,
		data: null,
	}),

	getRoadmapStatus: async () => ({
		success: true,
		data: { isRunning: false },
	}),

	saveRoadmap: async () => ({
		success: true,
	}),

	generateRoadmap: (
		_projectId: string,
		_enableCompetitorAnalysis?: boolean,
		_refreshCompetitorAnalysis?: boolean,
	) => {
		console.warn("[Browser Mock] generateRoadmap called");
	},

	refreshRoadmap: (
		_projectId: string,
		_enableCompetitorAnalysis?: boolean,
		_refreshCompetitorAnalysis?: boolean,
	) => {
		console.warn("[Browser Mock] refreshRoadmap called");
	},

	updateFeatureStatus: async () => ({ success: true }),

	convertFeatureToSpec: async (projectId: string, _featureId: string) => ({
		success: true,
		data: {
			id: `task-${Date.now()}`,
			specId: "",
			projectId,
			title: "Converted Feature",
			description: "Feature converted from roadmap",
			status: "backlog" as const,
			subtasks: [],
			logs: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	}),

	stopRoadmap: async () => ({ success: true }),

	// Roadmap Progress Persistence
	saveRoadmapProgress: async () => ({ success: true }),
	loadRoadmapProgress: async () => ({ success: true, data: null }),
	clearRoadmapProgress: async () => ({ success: true }),

	// Roadmap Event Listeners
	onRoadmapProgress: () => () => {
		/* noop */
	},
	onRoadmapComplete: () => () => {
		/* noop */
	},
	onRoadmapError: () => () => {
		/* noop */
	},
	onRoadmapStopped: () => () => {
		/* noop */
	},
	// File Explorer Operations (browser fallback: no filesystem access)
	searchProjectFiles: async () => ({ success: true, data: [] }),

	// Context Operations
	...contextMock,

	// Environment Configuration & Integration Operations
	...integrationMock,

	// Changelog & Release Operations
	...changelogMock,

	// Insights Operations
	...insightsMock,

	// Infrastructure & Docker Operations
	...infrastructureMock,

	// API Profile Management (custom Anthropic-compatible endpoints)
	getAPIProfiles: async () => ({
		success: true,
		data: {
			profiles: [],
			activeProfileId: null,
			version: 1,
		},
	}),

	saveAPIProfile: async (profile) => ({
		success: true,
		data: {
			id: `mock-profile-${Date.now()}`,
			...profile,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	}),

	updateAPIProfile: async (profile) => ({
		success: true,
		data: {
			...profile,
			updatedAt: Date.now(),
		},
	}),

	deleteAPIProfile: async (_profileId: string) => ({
		success: true,
	}),

	setActiveAPIProfile: async (_profileId: string | null) => ({
		success: true,
	}),

	testConnection: async (
		_baseUrl: string,
		_apiKey: string,
		_signal?: AbortSignal,
	) => ({
		success: true,
		data: {
			success: true,
			message: "Connection successful (mock)",
		},
	}),

	discoverModels: async (
		_baseUrl: string,
		_apiKey: string,
		_signal?: AbortSignal,
	) => ({
		success: true,
		data: {
			models: [],
		},
	}),

	// GitHub API
	github: {
		getGitHubRepositories: async () => ({ success: true, data: [] }),
		getGitHubIssues: async () => ({
			success: true,
			data: { issues: [], hasMore: false },
		}),
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		getGitHubIssue: async () => ({ success: true, data: null as any }),
		getIssueComments: async () => ({ success: true, data: [] }),
		checkGitHubConnection: async () => ({
			success: true,
			data: { connected: false, repoFullName: undefined, error: undefined },
		}),
		investigateGitHubIssue: () => {
			/* noop */
		},
		importGitHubIssues: async () => ({
			success: true,
			data: { success: true, imported: 0, failed: 0, issues: [] },
		}),
		createGitHubRelease: async () => ({ success: true, data: { url: "" } }),
		suggestReleaseVersion: async () => ({
			success: true,
			data: {
				suggestedVersion: "1.0.0",
				currentVersion: "0.0.0",
				bumpType: "minor" as const,
				commitCount: 0,
				reason: "Initial",
			},
		}),
		checkGitHubCli: async () => ({ success: true, data: { installed: false } }),
		checkGitHubAuth: async () => ({
			success: true,
			data: { authenticated: false },
		}),
		startGitHubAuth: async () => ({ success: true, data: { success: false } }),
		getGitHubToken: async () => ({ success: true, data: { token: "" } }),
		getGitHubUser: async () => ({ success: true, data: { username: "" } }),
		listGitHubUserRepos: async () => ({ success: true, data: { repos: [] } }),
		detectGitHubRepo: async () => ({ success: true, data: "" }),
		getGitHubBranches: async () => ({ success: true, data: [] }),
		createGitHubRepo: async () => ({
			success: true,
			data: { fullName: "", url: "" },
		}),
		addGitRemote: async () => ({ success: true, data: { remoteUrl: "" } }),
		listGitHubOrgs: async () => ({ success: true, data: { orgs: [] } }),
		onGitHubAuthDeviceCode: () => () => {
			/* noop */
		},
		onGitHubAuthChanged: () => () => {
			/* noop */
		},
		onGitHubInvestigationProgress: () => () => {
			/* noop */
		},
		onGitHubInvestigationComplete: () => () => {
			/* noop */
		},
		onGitHubInvestigationError: () => () => {
			/* noop */
		},
		getAutoFixConfig: async () => null,
		saveAutoFixConfig: async () => true,
		getAutoFixQueue: async () => [],
		checkAutoFixLabels: async () => [],
		checkNewIssues: async () => [],
		startAutoFix: () => {
			/* noop */
		},
		onAutoFixProgress: () => () => {
			/* noop */
		},
		onAutoFixComplete: () => () => {
			/* noop */
		},
		onAutoFixError: () => () => {
			/* noop */
		},
		listPRs: async () => ({ prs: [], hasNextPage: false }),
		listMorePRs: async () => ({ prs: [], hasNextPage: false }),
		getPR: async () => null,
		runPRReview: () => {
			/* noop */
		},
		cancelPRReview: async () => true,
		postPRReview: async () => true,
		postPRComment: async () => true,
		mergePR: async () => true,
		assignPR: async () => true,
		markReviewPosted: async () => true,
		getPRReview: async () => null,
		getPRReviewsBatch: async () => ({}),
		deletePRReview: async () => true,
		checkNewCommits: async () => ({ hasNewCommits: false, newCommitCount: 0 }),
		checkMergeReadiness: async () => ({
			isDraft: false,
			mergeable: "UNKNOWN" as const,
			isBehind: false,
			ciStatus: "none" as const,
			blockers: [],
		}),
		updatePRBranch: async () => ({ success: true }),
		runFollowupReview: () => {
			/* noop */
		},
		getPRLogs: async () => null,
		getWorkflowsAwaitingApproval: async () => ({
			awaiting_approval: 0,
			workflow_runs: [],
			can_approve: false,
		}),
		approveWorkflow: async () => true,
		onPRReviewProgress: () => () => {
			/* noop */
		},
		onPRReviewComplete: () => () => {
			/* noop */
		},
		onPRReviewError: () => () => {
			/* noop */
		},
		batchAutoFix: () => {
			/* noop */
		},
		getBatches: async () => [],
		onBatchProgress: () => () => {
			/* noop */
		},
		onBatchComplete: () => () => {
			/* noop */
		},
		onBatchError: () => () => {
			/* noop */
		},
		// Analyze & Group Issues (proactive workflow)
		analyzeIssuesPreview: () => {
			/* noop */
		},
		approveBatches: async () => ({ success: true, batches: [] }),
		onAnalyzePreviewProgress: () => () => {
			/* noop */
		},
		onAnalyzePreviewComplete: () => () => {
			/* noop */
		},
		onAnalyzePreviewError: () => () => {
			/* noop */
		},
		testGitHubConnection: async () => ({
			success: false,
			error: "Not available in browser mode",
		}),
	},

	// Queue Routing API (rate limit recovery)
	queue: {
		getRunningTasksByProfile: async () => ({
			success: true,
			data: { byProfile: {}, totalRunning: 0 },
		}),
		getBestProfileForTask: async () => ({ success: true, data: null }),
		assignProfileToTask: async () => ({ success: true }),
		updateTaskSession: async () => ({ success: true }),
		getTaskSession: async () => ({ success: true, data: null }),
		onQueueProfileSwapped: () => () => {
			/* noop */
		},
		onQueueSessionCaptured: () => () => {
			/* noop */
		},
		onQueueBlockedNoProfiles: () => () => {
			/* noop */
		},
	},

	// Claude Code Operations
	checkClaudeCodeVersion: async () => ({
		success: true,
		data: {
			installed: "1.0.0",
			latest: "1.0.0",
			isOutdated: false,
			path: "/usr/local/bin/claude",
			detectionResult: {
				found: true,
				version: "1.0.0",
				path: "/usr/local/bin/claude",
				source: "system-path" as const,
				message: "Claude Code CLI found",
			},
		},
	}),
	installClaudeCode: async () => ({
		success: true,
		data: { command: "npm install -g @anthropic-ai/claude-code" },
	}),
	installClaudeCodeSilent: async () => ({
		success: true,
		data: { stdout: "[browser-mock] no-op", stderr: "" },
	}),
	getClaudeCodeVersions: async () => ({
		success: true,
		data: {
			versions: ["1.0.5", "1.0.4", "1.0.3", "1.0.2", "1.0.1", "1.0.0"],
		},
	}),
	installClaudeCodeVersion: async (version: string) => ({
		success: true,
		data: {
			command: `npm install -g @anthropic-ai/claude-code@${version}`,
			version,
		},
	}),
	getClaudeCodeInstallations: async () => ({
		success: true,
		data: {
			installations: [
				{
					path: "/usr/local/bin/claude",
					version: "1.0.0",
					source: "system-path" as const,
					isActive: true,
				},
			],
			activePath: "/usr/local/bin/claude",
		},
	}),
	setClaudeCodeActivePath: async (cliPath: string) => ({
		success: true,
		data: { path: cliPath },
	}),

	// Terminal Worktree Operations
	createTerminalWorktree: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	listTerminalWorktrees: async () => ({
		success: true,
		data: [],
	}),
	removeTerminalWorktree: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	listOtherWorktrees: async () => ({
		success: true,
		data: [],
	}),

	// MCP Server Health Check Operations
	checkMcpHealth: async (server) => ({
		success: true,
		data: {
			serverId: server.id,
			status: "unknown" as const,
			message: "Health check not available in browser mode",
			checkedAt: new Date().toISOString(),
		},
	}),
	testMcpConnection: async (server) => ({
		success: true,
		data: {
			serverId: server.id,
			success: false,
			message: "Connection test not available in browser mode",
		},
	}),

	// Screenshot capture operations
	getSources: async () => ({
		success: true,
		data: [],
	}),
	capture: async (_options: { sourceId: string }) => ({
		success: false,
		error: "Screenshot capture not available in browser mode",
	}),

	// Debug Operations
	getDebugInfo: async () => ({
		systemInfo: {
			appVersion: "0.0.0-browser-mock",
			platform: "browser",
			isPackaged: "false",
		},
		recentErrors: [],
		logsPath: "/mock/logs",
		debugReport: "[Browser Mock] Debug report not available in browser mode",
	}),
	openLogsFolder: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	copyDebugInfo: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	getRecentErrors: async () => [],
	listLogFiles: async () => [],

	// Azure DevOps Operations
	getAzureDevOpsProjects: async () => ({
		success: true,
		data: [],
	}),
	listAzureDevOpsRepositories: async () => ({
		success: true,
		data: [],
	}),
	detectAzureDevOpsRepository: async () => ({
		success: true,
		data: { repository: null },
	}),
	getAzureDevOpsWorkItems: async () => ({
		success: true,
		data: [],
	}),
	importAzureDevOpsWorkItems: async () => ({
		success: true,
		data: { success: true, imported: 0, failed: 0, errors: [] },
	}),
	checkAzureDevOpsConnection: async () => ({
		success: true,
		data: {
			connected: false,
			organization: null,
			project: null,
			error: undefined,
		},
	}),
	syncAzureDevOpsTaskAC: async () => ({
		success: true,
		data: { acceptanceCriteria: [] },
	}),

	// Jira Operations
	getJiraIssues: async () => ({
		success: true,
		data: [],
	}),
	checkJiraConnection: async () => ({
		success: true,
		data: { connected: false, siteUrl: null, error: undefined },
	}),

	// Repository Provider Detection
	detectRepoProvider: async () => ({
		success: true,
		data: {
			provider: "unknown" as const,
			remoteName: "origin",
			remoteUrl: undefined,
		},
	}),

	// File operations
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	saveJsonFile: async (_folderPath: string, _fileName: string, _data: any) => ({
		success: false,
		error: "Not available in browser mode",
	}),

	// User directory operations
	getUserHome: async () => "/mock/user/home",

	// Learning Loop Operations
	getLearningPatterns: async () => ({ success: true, data: [] }),
	getLearningSummary: async () => ({
		success: true,
		data: {
			total_patterns: 0,
			by_category: {},
			by_phase: {},
			by_type: {},
			average_confidence: 0,
			total_builds_analyzed: 0,
			last_analyzed_at: null,
			improvement_metrics: null,
			enabled_count: 0,
			disabled_count: 0,
		},
	}),
	runLearningAnalysis: () => {
		/* noop */
	},
	stopLearningAnalysis: async () => ({ success: true, cancelled: false }),
	deleteLearningPattern: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	toggleLearningPattern: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	onLearningLoopStatus: () => () => {
		/* noop */
	},
	onLearningLoopStreamChunk: () => () => {
		/* noop */
	},
	onLearningLoopError: () => () => {
		/* noop */
	},
	onLearningLoopComplete: () => () => {
		/* noop */
	},

	// Provider selection
	selectProvider: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	getSelectedProvider: async () => ({ success: false, data: null }),

	// Conflict Predictor
	runConflictPrediction: async () => {
		/* noop */
	},
	cancelConflictPrediction: async () => false,
	onConflictPredictionStreamChunk: () => () => {
		/* noop */
	},
	onConflictPredictionStatus: () => () => {
		/* noop */
	},
	onConflictPredictionError: () => () => {
		/* noop */
	},
	onConflictPredictionComplete: () => () => {
		/* noop */
	},
	onConflictPredictionEvent: () => () => {
		/* noop */
	},

	// Token/OAuth detection
	detectWindsurfToken: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),
	checkClaudeOAuth: async () => ({ isAuthenticated: false }),
	checkOpenAICodexOAuth: async () => ({ isAuthenticated: false }),
	updateCodexCli: async () => ({
		success: false,
		error: "Not available in browser mode",
	}),

	// Generic invoke method for IPC calls
	invoke: async (channel: string, ...args: unknown[]) => {
		console.warn(`[Browser Mock] invoke called for channel: ${channel}`, args);
		return { success: false, error: "Not available in browser mode" };
	},

	// Prompt Optimizer API
	onPromptOptimizerStreamChunk: () => () => {
		/* noop */
	},
	onPromptOptimizerStatus: () => () => {
		/* noop */
	},
	onPromptOptimizerError: () => () => {
		/* noop */
	},
	onPromptOptimizerComplete: () => () => {
		/* noop */
	},

	// Context-Aware Snippets API
	onSnippetStreamChunk: () => {
		/* noop */
	},
	onSnippetStatus: () => {
		/* noop */
	},
	onSnippetError: () => {
		/* noop */
	},
	onSnippetComplete: () => {
		/* noop */
	},
	removeSnippetStreamChunkListener: () => {
		/* noop */
	},
	removeSnippetStatusListener: () => {
		/* noop */
	},
	removeSnippetErrorListener: () => {
		/* noop */
	},
	removeSnippetCompleteListener: () => {
		/* noop */
	},

	// Voice Control API
	onVoiceControlStatus: () => () => {
		/* noop */
	},
	onVoiceControlStreamChunk: () => () => {
		/* noop */
	},
	onVoiceControlError: () => () => {
		/* noop */
	},
	onVoiceControlComplete: () => () => {
		/* noop */
	},
	onVoiceControlAudioLevel: () => () => {
		/* noop */
	},
	onVoiceControlDuration: () => () => {
		/* noop */
	},

	// App Emulator API
	onAppEmulatorStatus: () => () => {
		/* noop */
	},
	onAppEmulatorReady: () => () => {
		/* noop */
	},
	onAppEmulatorOutput: () => () => {
		/* noop */
	},
	onAppEmulatorError: () => () => {
		/* noop */
	},
	onAppEmulatorStopped: () => () => {
		/* noop */
	},
	onAppEmulatorConfig: () => () => {
		/* noop */
	},
};

/**
 * Initialize browser mock if not running in Electron
 */
export function initBrowserMock(): void {
	if (!isElectron) {
		console.warn(
			"%c[Browser Mock] Initializing mock electronAPI for browser preview",
			"color: #f0ad4e; font-weight: bold;",
		);
		(window as Window & { electronAPI: ElectronAPI }).electronAPI =
			browserMockAPI;
	}
}

// Auto-initialize
initBrowserMock();
