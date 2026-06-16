import type { IPCResult, UsageSnapshot } from "../../shared/types";
import {
	type AgentAPI,
	type AzureDevOpsAPI,
	createAgentAPI,
	type GitLabAPI,
	type IdeationAPI,
	type InsightsAPI,
} from "./agent-api";
import { type AppUpdateAPI, createAppUpdateAPI } from "./app-update-api";
import { createFileAPI, type FileAPI } from "./file-api";
import {
	type AccessibilityAPI,
	createAccessibilityAPI,
} from "./modules/accessibility-api";
import {
	type AgentDebuggerAPI,
	createAgentDebuggerAPI,
} from "./modules/agent-debugger-api";
import {
	type BlastRadiusAPI,
	createBlastRadiusAPI,
} from "./modules/blast-radius-api";
import {
	type Phase35FeaturesAPI,
	createPhase35FeaturesAPI,
} from "./modules/phase35-features-api";
import {
	type BountyBoardAPI,
	createBountyBoardAPI,
} from "./modules/bounty-board-api";
import {
	type TechDebtAPI,
	createTechDebtAPI,
} from "./modules/tech-debt-api";
import {
	type TeamBotAPI,
	createTeamBotAPI,
} from "./modules/team-bot-api";
import {
	type ApiExplorerAPI,
	createApiExplorerAPI,
} from "./modules/api-explorer-api";
import {
	type ApiWatcherAPI,
	createApiWatcherAPI,
} from "./modules/api-watcher-api";
import {
	type DocDriftAPI,
	createDocDriftAPI,
} from "./modules/doc-drift-api";
import {
	type CarbonProfilerAPI,
	createCarbonProfilerAPI,
} from "./modules/carbon-profiler-api";
import {
	type ComplianceAPI,
	createComplianceAPI,
} from "./modules/compliance-api";
import {
	type FlakyTestsAPI,
	createFlakyTestsAPI,
} from "./modules/flaky-tests-api";
import {
	type GitSurgeonAPI,
	createGitSurgeonAPI,
} from "./modules/git-surgeon-api";
import {
	type ReleaseCoordinatorAPI,
	createReleaseCoordinatorAPI,
} from "./modules/release-coordinator-api";
import {
	type NotebookAgentAPI,
	createNotebookAgentAPI,
} from "./modules/notebook-agent-api";
import {
	type SpecRefinementAPI,
	createSpecRefinementAPI,
} from "./modules/spec-refinement-api";
import {
	type AgentCoachAPI,
	createAgentCoachAPI,
} from "./modules/agent-coach-api";
import {
	type OnboardingAgentAPI,
	createOnboardingAgentAPI,
} from "./modules/onboarding-agent-api";
import { type SandboxAPI, createSandboxAPI } from "./modules/sandbox-api";
import {
	type RegressionGuardianAPI,
	createRegressionGuardianAPI,
} from "./modules/regression-guardian-api";
import {
	type ConsensusArbiterAPI,
	createConsensusArbiterAPI,
} from "./modules/consensus-arbiter-api";
import {
	type InjectionGuardAPI,
	createInjectionGuardAPI,
} from "./modules/injection-guard-api";
import {
	type I18nAgentAPI,
	createI18nAgentAPI,
} from "./modules/i18n-agent-api";
import type { AppEmulatorAPI } from "./modules/app-emulator-api";
import { createAppEmulatorAPI } from "./modules/app-emulator-api";
import type { ArchitectureVisualizerAPI } from "./modules/architecture-visualizer-api";
import { createArchitectureVisualizerAPI } from "./modules/architecture-visualizer-api";
import type { ArenaAPI } from "./modules/arena-api";
import { createArenaAPI } from "./modules/arena-api";
import {
	type ClaudeCodeAPI,
	createClaudeCodeAPI,
} from "./modules/claude-code-api";
import type { CodeMigrationAPI } from "./modules/code-migration-api";
import { createCodeMigrationAPI } from "./modules/code-migration-api";
import type { CodePlaygroundAPI } from "./modules/code-playground-api";
import { createCodePlaygroundAPI } from "./modules/code-playground-api";
import type { ConflictPredictorAPI } from "./modules/conflict-predictor-api";
import { createConflictPredictorAPI } from "./modules/conflict-predictor-api";
import type { ContextAwareSnippetsAPI } from "./modules/context-aware-snippets-api";
import { createContextAwareSnippetsAPI } from "./modules/context-aware-snippets-api";
import {
	type CopilotCliAPI,
	createCopilotCliAPI,
} from "./modules/copilot-cli-api";
import {
	type CopilotOAuthAPI,
	createCopilotOAuthAPI,
} from "./modules/copilot-oauth-api";
import { type CostAPI, createCostAPI } from "./modules/cost-api";
import {
	type CostPredictorAPI,
	createCostPredictorAPI,
} from "./modules/cost-predictor-api";
import {
	createFormulaMatrixAPI,
	type FormulaMatrixAPI,
} from "./modules/formula-matrix-api";
import { createDebugAPI, type DebugAPI } from "./modules/debug-api";
import type { DecisionLoggerAPI } from "./modules/decision-logger-api";
import { createDecisionLoggerAPI } from "./modules/decision-logger-api";
import type { DocumentationAgentAPI } from "./modules/documentation-agent-api";
import { createDocumentationAgentAPI } from "./modules/documentation-agent-api";
import { createGitHubAPI, type GitHubAPI } from "./modules/github-api";
import {
	createEnvSnapshotAPI,
	type EnvSnapshotAPI,
} from "./modules/env-snapshot-api";
import {
	createOfflineModeAPI,
	type OfflineModeAPI,
} from "./modules/offline-mode-api";
import {
	type GuardrailsAPI,
	createGuardrailsAPI,
} from "./modules/guardrails-api";
import { invokeIpc } from "./modules/ipc-utils";
import type { LearningLoopAPI } from "./modules/learning-loop-api";
import { createLearningLoopAPI } from "./modules/learning-loop-api";
import { createMcpAPI, type McpAPI } from "./modules/mcp-api";
import type { MultiRepoAPI } from "./modules/multi-repo-api";
import { createMultiRepoAPI } from "./modules/multi-repo-api";
import type { PairProgrammingAPI } from "./modules/pair-programming-api";
import { createPairProgrammingAPI } from "./modules/pair-programming-api";
import type { PerformanceProfilerAPI } from "./modules/performance-profiler-api";
import { createPerformanceProfilerAPI } from "./modules/performance-profiler-api";
import type { PipelineGeneratorAPI } from "./modules/pipeline-generator-api";
import { createPipelineGeneratorAPI } from "./modules/pipeline-generator-api";
import type { PromptOptimizerAPI } from "./modules/prompt-optimizer-api";
import { createPromptOptimizerAPI } from "./modules/prompt-optimizer-api";
import { createQualityAPI, type QualityAPI } from "./modules/quality-api";
import type { SelfHealingAPIObject } from "./modules/self-healing-api";
import { createSelfHealingAPI } from "./modules/self-healing-api";
import {
	createSmartEstimationAPI,
	type SmartEstimationAPI,
} from "./modules/smart-estimation-api";
import type { TeamSyncAPI } from "./modules/team-sync-api";
import { createTeamSyncAPI } from "./modules/team-sync-api";
import type { TestGenerationAPI } from "./modules/test-generation-api";
import { createTestGenerationAPI } from "./modules/test-generation-api";
import type { VisualProgrammingAPI } from "./modules/visual-programming-api";
import { createVisualProgrammingAPI } from "./modules/visual-programming-api";
import {
	createVoiceControlAPI,
	type VoiceControlAPI,
} from "./modules/voice-control-api";
import {
	createNaturalLanguageGitAPI,
	type NaturalLanguageGitAPI,
} from "./natural-language-git-api";
import { createProfileAPI, type ProfileAPI } from "./profile-api";
import { createProjectAPI, type ProjectAPI } from "./project-api";
import { createQueueAPI, type QueueAPI } from "./queue-api";
import { createScreenshotAPI, type ScreenshotAPI } from "./screenshot-api";
import {
	createServerAuthAPI,
	type ServerAuthAPI,
} from "./modules/server-auth-api";
import { createSettingsAPI, type SettingsAPI } from "./settings-api";
import { createTaskAPI, type TaskAPI } from "./task-api";
import { createTerminalAPI, type TerminalAPI } from "./terminal-api";

export interface ElectronAPI
	extends ProjectAPI,
		ApiExplorerAPI,
		TerminalAPI,
		TaskAPI,
		SettingsAPI,
		FileAPI,
		AgentAPI,
		IdeationAPI,
		InsightsAPI,
		AppUpdateAPI,
		GitLabAPI,
		AzureDevOpsAPI,
		DebugAPI,
		ClaudeCodeAPI,
		CopilotCliAPI,
		CopilotOAuthAPI,
		McpAPI,
		ProfileAPI,
		ScreenshotAPI,
		NaturalLanguageGitAPI,
		PromptOptimizerAPI,
		CodePlaygroundAPI,
		ConflictPredictorAPI,
		VoiceControlAPI,
		SmartEstimationAPI,
		ContextAwareSnippetsAPI,
		AppEmulatorAPI,
		LearningLoopAPI,
		MultiRepoAPI,
		ArchitectureVisualizerAPI,
		CodeMigrationAPI,
		PerformanceProfilerAPI,
		DocumentationAgentAPI,
		DecisionLoggerAPI,
		PairProgrammingAPI,
		PipelineGeneratorAPI,
		TeamSyncAPI,
		ArenaAPI,
		TestGenerationAPI,
		CostAPI,
		CostPredictorAPI,
		FormulaMatrixAPI,
		AccessibilityAPI,
		I18nAgentAPI,
		DocDriftAPI,
		FlakyTestsAPI,
		CarbonProfilerAPI,
		ComplianceAPI,
		ApiWatcherAPI,
		GitSurgeonAPI,
		ReleaseCoordinatorAPI,
		NotebookAgentAPI,
		SpecRefinementAPI,
		AgentCoachAPI,
		OnboardingAgentAPI,
		SandboxAPI,
		RegressionGuardianAPI,
		ConsensusArbiterAPI,
		InjectionGuardAPI,
		GuardrailsAPI,
		AgentDebuggerAPI,
		BlastRadiusAPI,
		Phase35FeaturesAPI,
		BountyBoardAPI,
		TechDebtAPI,
		TeamBotAPI,
		EnvSnapshotAPI,
		OfflineModeAPI,
		VisualProgrammingAPI {
	github: GitHubAPI;
	/** Multi-user server mode: connection + login (local / Entra ID) */
	serverAuth: ServerAuthAPI;
	/** Queue routing API for rate limit recovery */
	queue: QueueAPI;
	/** Code quality analysis API */
	quality: QualityAPI;
	/** Self-Healing Codebase + Incident Responder API */
	selfHealing: SelfHealingAPIObject;
	createClaudeProfileDirectory: (
		profileName: string,
	) => Promise<{ success: boolean; data?: string; error?: string }>;
	requestUsageUpdate: (
		providerName?: string,
	) => Promise<IPCResult<UsageSnapshot | null>>;
	/** Get GitHub CLI status for Copilot authentication */
	getGithubCliStatus: () => Promise<
		IPCResult<{ available: boolean; isAuth?: boolean; username?: string }>
	>;
	/** LLM Provider operations */
	selectProvider: (provider: string) => Promise<IPCResult<string>>;
	getSelectedProvider: () => Promise<IPCResult<string | null>>;
	/** Test GitHub connection for remote configuration */
	testGitHubConnection: (config: {
		repo: string;
		token: string;
	}) => Promise<{ success: boolean; status?: number; error?: string }>;
	/** Detect Windsurf API key from local IDE installation (state.vscdb) + account info */
	detectWindsurfToken: () => Promise<{
		success: boolean;
		apiKey?: string;
		userName?: string;
		planName?: string;
		usageInfo?: {
			usedMessages: number;
			totalMessages: number;
			usedFlowActions: number;
			totalFlowActions: number;
		};
		error?: string;
	}>;
	/** Check Claude OAuth status from CLI config files on disk */
	checkClaudeOAuth: () => Promise<{
		isAuthenticated: boolean;
		profileName?: string;
	}>;
	/** Check OpenAI Codex CLI OAuth status from config files on disk */
	checkOpenAICodexOAuth: () => Promise<{
		isAuthenticated: boolean;
		profileName?: string;
		version?: string;
		latest?: string;
		isOutdated?: boolean;
	}>;
	/** Install or update Codex CLI via `npm install -g @openai/codex@latest` in background */
	updateCodexCli: () => Promise<{
		success: boolean;
		version?: string;
		latest?: string;
		isOutdated?: boolean;
		error?: string;
	}>;
}

export const createElectronAPI = (): ElectronAPI => {
	return {
		...createProjectAPI(),
		...createApiExplorerAPI(),
		...createTerminalAPI(),
		...createTaskAPI(),
		...createSettingsAPI(),
		...createFileAPI(),
		...createAgentAPI(),
		...createAppUpdateAPI(),
		...createDebugAPI(),
		...createClaudeCodeAPI(),
		...createCopilotCliAPI(),
		...createCopilotOAuthAPI(),
		...createMcpAPI(),
		...createProfileAPI(),
		...createScreenshotAPI(),
		...createNaturalLanguageGitAPI(),
		...createPromptOptimizerAPI(),
		...createCodePlaygroundAPI(),
		...createConflictPredictorAPI(),
		...createVoiceControlAPI(),
		...createSmartEstimationAPI(),
		...createContextAwareSnippetsAPI(),
		...createAppEmulatorAPI(),
		...createLearningLoopAPI(),
		...createMultiRepoAPI(),
		...createArchitectureVisualizerAPI(),
		...createCodeMigrationAPI(),
		...createPerformanceProfilerAPI(),
		...createDocumentationAgentAPI(),
		...createDecisionLoggerAPI(),
		...createPairProgrammingAPI(),
		...createPipelineGeneratorAPI(),
		...createTeamSyncAPI(),
		...createArenaAPI(),
		...createTestGenerationAPI(),
		...createCostAPI(),
		...createCostPredictorAPI(),
		...createFormulaMatrixAPI(),
		...createAccessibilityAPI(),
		...createI18nAgentAPI(),
		...createDocDriftAPI(),
		...createFlakyTestsAPI(),
		...createCarbonProfilerAPI(),
		...createComplianceAPI(),
		...createApiWatcherAPI(),
		...createGitSurgeonAPI(),
		...createReleaseCoordinatorAPI(),
		...createNotebookAgentAPI(),
		...createSpecRefinementAPI(),
		...createAgentCoachAPI(),
		...createOnboardingAgentAPI(),
		...createSandboxAPI(),
		...createRegressionGuardianAPI(),
		...createConsensusArbiterAPI(),
		...createInjectionGuardAPI(),
		...createGuardrailsAPI(),
		...createAgentDebuggerAPI(),
		...createBlastRadiusAPI(),
		...createPhase35FeaturesAPI(),
		...createBountyBoardAPI(),
		...createTechDebtAPI(),
		...createTeamBotAPI(),
		...createEnvSnapshotAPI(),
		...createOfflineModeAPI(),
		...createVisualProgrammingAPI(),
		github: createGitHubAPI(),
		serverAuth: createServerAuthAPI(), // Multi-user server mode
		queue: createQueueAPI(), // Queue routing for rate limit recovery
		quality: createQualityAPI(), // Code quality analysis
		selfHealing: createSelfHealingAPI(),
		createClaudeProfileDirectory: (profileName: string) =>
			invokeIpc<{ success: boolean; data?: string; error?: string }>(
				"claude:profileCreateDir",
				profileName,
			),
		requestUsageUpdate: (providerName?: string) =>
			invokeIpc<IPCResult<UsageSnapshot | null>>(
				"claude:usageRequest",
				providerName,
			),
		getGithubCliStatus: () =>
			invokeIpc<
				IPCResult<{ available: boolean; isAuth?: boolean; username?: string }>
			>("copilotCli:getStatus"),
		selectProvider: (provider: string) =>
			invokeIpc<IPCResult<string>>("provider:select", provider),
		getSelectedProvider: () =>
			invokeIpc<IPCResult<string | null>>("provider:getSelected"),
		testGitHubConnection: (config: { repo: string; token: string }) =>
			invokeIpc<{ success: boolean; status?: number; error?: string }>(
				"github:testConnection",
				config,
			),
		detectWindsurfToken: () =>
			invokeIpc<{
				success: boolean;
				apiKey?: string;
				userName?: string;
				error?: string;
			}>("credential:detectWindsurfToken"),
		checkClaudeOAuth: () =>
			invokeIpc<{ isAuthenticated: boolean; profileName?: string }>(
				"credential:checkClaudeOAuth",
			),
		checkOpenAICodexOAuth: () =>
			invokeIpc<{
				isAuthenticated: boolean;
				profileName?: string;
				version?: string;
				latest?: string;
				isOutdated?: boolean;
			}>("credential:checkOpenAICodexOAuth"),
		updateCodexCli: () =>
			invokeIpc<{
				success: boolean;
				version?: string;
				latest?: string;
				isOutdated?: boolean;
				error?: string;
			}>("credential:updateCodexCli"),
	};
};

export type {
	AgentAPI,
	AzureDevOpsAPI,
	GitLabAPI,
	IdeationAPI,
	InsightsAPI,
} from "./agent-api";
export { createAgentAPI } from "./agent-api";
export type { AppUpdateAPI } from "./app-update-api";
export { createAppUpdateAPI } from "./app-update-api";
export type { FileAPI } from "./file-api";
export { createFileAPI } from "./file-api";
export type { ApiExplorerAPI } from "./modules/api-explorer-api";
export { createApiExplorerAPI } from "./modules/api-explorer-api";
export type { AppEmulatorAPI } from "./modules/app-emulator-api";
export { createAppEmulatorAPI } from "./modules/app-emulator-api";
export type { ArchitectureVisualizerAPI } from "./modules/architecture-visualizer-api";
export { createArchitectureVisualizerAPI } from "./modules/architecture-visualizer-api";
export type { ArenaAPI } from "./modules/arena-api";
export { createArenaAPI } from "./modules/arena-api";
export { createAutoRefactorAPI } from "./modules/auto-refactor-api";
export type { ClaudeCodeAPI } from "./modules/claude-code-api";
export { createClaudeCodeAPI } from "./modules/claude-code-api";
export type { CodeMigrationAPI } from "./modules/code-migration-api";
export { createCodeMigrationAPI } from "./modules/code-migration-api";
export { createCodePlaygroundAPI } from "./modules/code-playground-api";
export { createConflictPredictorAPI } from "./modules/conflict-predictor-api";
export type { ContextAwareSnippetsAPI } from "./modules/context-aware-snippets-api";
export { createContextAwareSnippetsAPI } from "./modules/context-aware-snippets-api";
export type { CopilotCliAPI } from "./modules/copilot-cli-api";
export { createCopilotCliAPI } from "./modules/copilot-cli-api";
export type { DebugAPI } from "./modules/debug-api";
export { createDebugAPI } from "./modules/debug-api";
export type { DecisionLoggerAPI } from "./modules/decision-logger-api";
export { createDecisionLoggerAPI } from "./modules/decision-logger-api";
export type { DocumentationAgentAPI } from "./modules/documentation-agent-api";
export { createDocumentationAgentAPI } from "./modules/documentation-agent-api";
export type { GitHubAPI } from "./modules/github-api";
export { createGitHubAPI } from "./modules/github-api";
export type { McpAPI } from "./modules/mcp-api";
export { createMcpAPI } from "./modules/mcp-api";
export type { MultiRepoAPI } from "./modules/multi-repo-api";
export { createMultiRepoAPI } from "./modules/multi-repo-api";
export type { PairProgrammingAPI } from "./modules/pair-programming-api";
export { createPairProgrammingAPI } from "./modules/pair-programming-api";
export type { PerformanceProfilerAPI } from "./modules/performance-profiler-api";
export { createPerformanceProfilerAPI } from "./modules/performance-profiler-api";
export { createPromptOptimizerAPI } from "./modules/prompt-optimizer-api";
export type { QualityAPI } from "./modules/quality-api";
export { createQualityAPI } from "./modules/quality-api";
export type { SmartEstimationAPI } from "./modules/smart-estimation-api";
export { createSmartEstimationAPI } from "./modules/smart-estimation-api";
export type { TestGenerationAPI } from "./modules/test-generation-api";
export { createTestGenerationAPI } from "./modules/test-generation-api";
export type { VisualProgrammingAPI } from "./modules/visual-programming-api";
export { createVisualProgrammingAPI } from "./modules/visual-programming-api";
export type { VoiceControlAPI } from "./modules/voice-control-api";
export { createVoiceControlAPI } from "./modules/voice-control-api";
export type { NaturalLanguageGitAPI } from "./natural-language-git-api";
export { createNaturalLanguageGitAPI } from "./natural-language-git-api";
export type { ProfileAPI } from "./profile-api";
export { createProfileAPI } from "./profile-api";
export type { ProjectAPI } from "./project-api";
// Export individual API creators for potential use in tests or specialized contexts
// Note: IdeationAPI, InsightsAPI, GitLabAPI, and AzureDevOpsAPI are included in AgentAPI
export { createProjectAPI } from "./project-api";
export type { QueueAPI } from "./queue-api";
export { createQueueAPI } from "./queue-api";
export type { ScreenshotAPI } from "./screenshot-api";
export { createScreenshotAPI } from "./screenshot-api";
export type { SettingsAPI } from "./settings-api";
export { createSettingsAPI } from "./settings-api";
export type { TaskAPI } from "./task-api";
export { createTaskAPI } from "./task-api";
export type { TerminalAPI } from "./terminal-api";
export { createTerminalAPI } from "./terminal-api";
