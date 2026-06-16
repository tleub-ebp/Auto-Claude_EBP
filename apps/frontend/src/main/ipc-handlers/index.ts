/**
 * IPC Handlers Module Index
 *
 * This module exports a single setup function that registers all IPC handlers
 * organized by domain into separate handler modules.
 */

import type { BrowserWindow } from "electron";
import type { AgentManager } from "../agent";
import { notificationService } from "../notification-service";
import type { PythonEnvManager } from "../python-env-manager";
import type { TerminalManager } from "../terminal-manager";
import { registerAccessibilityHandlers } from "./accessibility-handlers";
import { registerAgentDebuggerHandlers } from "./agent-debugger-handlers";
import { registerAgenteventsHandlers } from "./agent-events-handlers";
import { registerBlastRadiusHandlers } from "./blast-radius-handlers";
import { registerBountyBoardHandlers } from "./bounty-board-handlers";
import { registerTechDebtHandlers } from "./tech-debt-handlers";
import { registerTeamBotHandlers } from "./team-bot-handlers";
import { registerApiExplorerHandlers } from "./api-explorer-handlers";
import { registerApiWatcherHandlers } from "./api-watcher-handlers";
import { registerAppEmulatorHandlers } from "./app-emulator-handlers";
import { registerAppUpdateHandlers } from "./app-update-handlers";
import {
	registerArchitectureVisualizerHandlers,
	setupArchitectureVisualizerEventForwarding,
} from "./architecture-visualizer-handlers";
import { registerArenaHandlers } from "./arena-handlers";
import { registerAzureDevOpsHandlers } from "./azure-devops-handlers";
import { registerBrowserAgentHandlers } from "./browser-agent-handlers";
import { registerCarbonProfilerHandlers } from "./carbon-profiler-handlers";
import { registerChangelogHandlers } from "./changelog-handlers";
import {
	registerCICDTriggersHandlers,
	setupCICDTriggersEventForwarding,
} from "./cicd-triggers-handlers";
import { registerClaudeCodeHandlers } from "./claude-code-handlers";
import { registerComplianceHandlers } from "./compliance-handlers";
import {
	registerCodeMigrationHandlers,
	setupCodeMigrationEventForwarding,
} from "./code-migration-handlers";
import {
	registerCodePlaygroundHandlers,
	setupCodePlaygroundEventForwarding,
} from "./code-playground-handlers";
import { setupConflictPredictorHandlers } from "./conflict-predictor-handlers";
import { registerContextHandlers } from "./context-handlers";
import { registerContextMeshHandlers } from "./context-mesh-handlers";
import { registerCopilotCliHandlers } from "./copilot-cli-handlers";
import { registerCopilotOAuthHandlers } from "./copilot-oauth-handlers";
import { registerCostHandlers } from "./cost-handlers";
import { registerCostPredictorHandlers } from "./cost-predictor-handlers";
import { registerFormulaMatrixHandlers } from "./formula-matrix-handlers";
import { registerCredentialHandlers } from "./credential-handlers";
import { registerCrossLanguageTranslationHandlers } from "./cross-language-translation-handlers";
import { registerDebugHandlers } from "./debug-handlers";
import { registerDecisionLoggerHandlers } from "./decision-logger-handlers";
import { registerDocDriftHandlers } from "./doc-drift-handlers";
import {
	registerDocumentationAgentHandlers,
	setupDocumentationAgentEventForwarding,
} from "./documentation-agent-handlers";
import { registerEnvHandlers } from "./env-handlers";
import { registerEnvSnapshotHandlers } from "./env-snapshot-handlers";
import { registerOfflineModeHandlers } from "./offline-mode-handlers";
import { registerFileHandlers } from "./file-handlers";
import { registerFlakyTestsHandlers } from "./flaky-tests-handlers";
import { registerGitHubCopilotHandlers } from "./github-copilot-handlers";
import { registerGitSurgeonHandlers } from "./git-surgeon-handlers";
import { registerGithubHandlers } from "./github-handlers";
import { registerGitlabHandlers } from "./gitlab-handlers";
import { registerGuardrailsHandlers } from "./guardrails-handlers";
import { registerI18nAgentHandlers } from "./i18n-agent-handlers";
import { registerIdeationHandlers } from "./ideation-handlers";
import { registerInsightsHandlers } from "./insights-handlers";
import { registerJiraHandlers } from "./jira-handlers";
import { registerLearningLoopHandlers } from "./learning-loop-handlers";
import { registerLinearHandlers } from "./linear-handlers";
import { registerLiveCompanionHandlers } from "./live-companion-handlers";
import { registerMcpHandlers } from "./mcp-handlers";
import { registerMcpMarketplaceHandlers } from "./mcp-marketplace-handlers";
import { registerMemoryHandlers } from "./memory-handlers";
import {
	registerMemoryLifecycleHandlers,
	setupMemoryLifecycleEventForwarding,
} from "./memory-lifecycle-handlers";
import { registerMultiRepoHandlers } from "./multi-repo-handlers";
import { setupNaturalLanguageGitHandlers } from "./natural-language-git-handlers";
import { registerNotebookAgentHandlers } from "./notebook-agent-handlers";
import { registerPairProgrammingHandlers } from "./pair-programming-handlers";
import {
	registerPerformanceProfilerHandlers,
	setupPerformanceProfilerEventForwarding,
} from "./performance-profiler-handlers";
import {
	registerPipelineGeneratorHandlers,
	setupPipelineGeneratorEventForwarding,
} from "./pipeline-generator-handlers";
import { registerPluginMarketplaceHandlers } from "./plugin-marketplace-handlers";
import { registerPRDetailsHandlers } from "./pr-details-handlers";
import { registerProfileHandlers } from "./profile-handlers";
// Import all handler registration functions for internal use
import { registerProjectHandlers } from "./project-handlers";
import { registerPromptOptimizerHandlers } from "./prompt-optimizer-handlers";
import { registerReleaseCoordinatorHandlers } from "./release-coordinator-handlers";
import { setupQualityHandlers } from "./quality-handlers";
import { registerRoadmapHandlers } from "./roadmap-handlers";
import { registerScreenshotHandlers } from "./screenshot-handlers";
import { registerSelfHealingHandlers } from "./self-healing-handlers";
import { registerServerAuthHandlers } from "./server-auth-handlers";
import { registerSettingsHandlers } from "./settings-handlers";
import { setupSmartEstimationHandlers } from "./smart-estimation-handlers";
import { registerAgentCoachHandlers } from "./agent-coach-handlers";
import { registerOnboardingAgentHandlers } from "./onboarding-agent-handlers";
import { registerSandboxHandlers } from "./sandbox-handlers";
import { registerRegressionGuardianHandlers } from "./regression-guardian-handlers";
import { registerConsensusArbiterHandlers } from "./consensus-arbiter-handlers";
import { registerInjectionGuardHandlers } from "./injection-guard-handlers";
import { registerSpecApprovalHandlers } from "./spec-approval-handlers";
import { registerSpecRefinementHandlers } from "./spec-refinement-handlers";
import { registerPhase35FeatureHandlers } from "./phase35-features-handlers";
import { registerPipelineHandlers } from "./pipeline-handlers";
import { registerTaskHandlers } from "./task-handlers";
import { registerTeamSyncHandlers } from "./team-sync-handlers";
import { registerTerminalWorktreeIpcHandlers } from "./terminal";
import { registerTerminalHandlers } from "./terminal-handlers";
import { setupTestGenerationHandlers } from "./test-generation-handlers";
import { registerTimeTravelHandlers } from "./time-travel-handlers";
import {
	registerVisualProgrammingHandlers,
	setupVisualProgrammingEventForwarding,
} from "./visual-programming-handlers";
import {
	registerVoiceControlHandlers,
	setupVoiceControlEvents,
} from "./voice-control-handlers";

export { registerAccessibilityHandlers } from "./accessibility-handlers";
export { registerAgenteventsHandlers } from "./agent-events-handlers";
export { registerApiExplorerHandlers } from "./api-explorer-handlers";
export { registerApiWatcherHandlers } from "./api-watcher-handlers";
export { registerAppEmulatorHandlers } from "./app-emulator-handlers";
export { registerAppUpdateHandlers } from "./app-update-handlers";
export {
	registerArchitectureVisualizerHandlers,
	setupArchitectureVisualizerEventForwarding,
} from "./architecture-visualizer-handlers";
export { registerArenaHandlers } from "./arena-handlers";
export { registerAzureDevOpsHandlers } from "./azure-devops-handlers";
export { registerBrowserAgentHandlers } from "./browser-agent-handlers";
export { registerCarbonProfilerHandlers } from "./carbon-profiler-handlers";
export { registerChangelogHandlers } from "./changelog-handlers";
export {
	registerCICDTriggersHandlers,
	setupCICDTriggersEventForwarding,
} from "./cicd-triggers-handlers";
export { registerClaudeCodeHandlers } from "./claude-code-handlers";
export { registerComplianceHandlers } from "./compliance-handlers";
export {
	registerCodeMigrationHandlers,
	setupCodeMigrationEventForwarding,
} from "./code-migration-handlers";
export {
	registerCodePlaygroundHandlers,
	setupCodePlaygroundEventForwarding,
} from "./code-playground-handlers";
export { setupConflictPredictorHandlers } from "./conflict-predictor-handlers";
export { registerContextHandlers } from "./context-handlers";
export { registerContextMeshHandlers } from "./context-mesh-handlers";
export { registerCopilotCliHandlers } from "./copilot-cli-handlers";
export { registerCopilotOAuthHandlers } from "./copilot-oauth-handlers";
export { registerCostHandlers } from "./cost-handlers";
export { registerCostPredictorHandlers } from "./cost-predictor-handlers";
export { registerCredentialHandlers } from "./credential-handlers";
export { registerCrossLanguageTranslationHandlers } from "./cross-language-translation-handlers";
export { registerDebugHandlers } from "./debug-handlers";
export { registerDecisionLoggerHandlers } from "./decision-logger-handlers";
export { registerDocDriftHandlers } from "./doc-drift-handlers";
export {
	registerDocumentationAgentHandlers,
	setupDocumentationAgentEventForwarding,
} from "./documentation-agent-handlers";
export { registerEnvHandlers } from "./env-handlers";
export { registerEnvSnapshotHandlers } from "./env-snapshot-handlers";
export { registerOfflineModeHandlers } from "./offline-mode-handlers";
export { registerFileHandlers } from "./file-handlers";
export { registerFlakyTestsHandlers } from "./flaky-tests-handlers";
export { registerGitHubCopilotHandlers } from "./github-copilot-handlers";
export { registerGitSurgeonHandlers } from "./git-surgeon-handlers";
export { registerGithubHandlers } from "./github-handlers";
export { registerGitlabHandlers } from "./gitlab-handlers";
export { registerGuardrailsHandlers } from "./guardrails-handlers";
export { registerI18nAgentHandlers } from "./i18n-agent-handlers";
export { registerIdeationHandlers } from "./ideation-handlers";
export { registerInsightsHandlers } from "./insights-handlers";
export { registerJiraHandlers } from "./jira-handlers";
export { registerLearningLoopHandlers } from "./learning-loop-handlers";
export { registerLinearHandlers } from "./linear-handlers";
export { registerLiveCompanionHandlers } from "./live-companion-handlers";
export { registerMcpHandlers } from "./mcp-handlers";
export { registerMcpMarketplaceHandlers } from "./mcp-marketplace-handlers";
export { registerMemoryHandlers } from "./memory-handlers";
export {
	registerMemoryLifecycleHandlers,
	setupMemoryLifecycleEventForwarding,
} from "./memory-lifecycle-handlers";
export { registerMultiRepoHandlers } from "./multi-repo-handlers";
export { setupNaturalLanguageGitHandlers } from "./natural-language-git-handlers";
export { registerNotebookAgentHandlers } from "./notebook-agent-handlers";
export { registerPairProgrammingHandlers } from "./pair-programming-handlers";
export {
	registerPerformanceProfilerHandlers,
	setupPerformanceProfilerEventForwarding,
} from "./performance-profiler-handlers";
export {
	registerPipelineGeneratorHandlers,
	setupPipelineGeneratorEventForwarding,
} from "./pipeline-generator-handlers";
export { registerPluginMarketplaceHandlers } from "./plugin-marketplace-handlers";
export { registerPRDetailsHandlers } from "./pr-details-handlers";
export { registerProfileHandlers } from "./profile-handlers";
// Re-export all handler registration functions using export...from syntax
export { registerProjectHandlers } from "./project-handlers";
export { registerPromptOptimizerHandlers } from "./prompt-optimizer-handlers";
export { registerReleaseCoordinatorHandlers } from "./release-coordinator-handlers";
export { setupQualityHandlers } from "./quality-handlers";
export { registerRoadmapHandlers } from "./roadmap-handlers";
export { registerScreenshotHandlers } from "./screenshot-handlers";
export { registerSelfHealingHandlers } from "./self-healing-handlers";
export { registerSettingsHandlers } from "./settings-handlers";
export { setupSmartEstimationHandlers } from "./smart-estimation-handlers";
export { registerAgentCoachHandlers } from "./agent-coach-handlers";
export { registerOnboardingAgentHandlers } from "./onboarding-agent-handlers";
export { registerSandboxHandlers } from "./sandbox-handlers";
export { registerRegressionGuardianHandlers } from "./regression-guardian-handlers";
export { registerConsensusArbiterHandlers } from "./consensus-arbiter-handlers";
export { registerInjectionGuardHandlers } from "./injection-guard-handlers";
export { registerSpecApprovalHandlers } from "./spec-approval-handlers";
export { registerSpecRefinementHandlers } from "./spec-refinement-handlers";
export { registerTaskHandlers } from "./task-handlers";
export { registerTeamSyncHandlers } from "./team-sync-handlers";
export { registerTerminalWorktreeIpcHandlers } from "./terminal";
export { registerTerminalHandlers } from "./terminal-handlers";
export { setupTestGenerationHandlers } from "./test-generation-handlers";
export { registerTimeTravelHandlers } from "./time-travel-handlers";
export {
	registerVisualProgrammingHandlers,
	setupVisualProgrammingEventForwarding,
} from "./visual-programming-handlers";
export { registerVoiceControlHandlers } from "./voice-control-handlers";

/**
 * Setup all IPC handlers across all domains
 *
 * @param agentManager - The agent manager instance
 * @param terminalManager - The terminal manager instance
 * @param getMainWindow - Function to get the main BrowserWindow
 * @param pythonEnvManager - The Python environment manager instance
 */
export function setupIpcHandlers(
	agentManager: AgentManager,
	terminalManager: TerminalManager,
	getMainWindow: () => BrowserWindow | null,
	pythonEnvManager: PythonEnvManager,
): void {
	// Initialize notification service
	notificationService.initialize(getMainWindow);

	// Project handlers (including Python environment setup)
	registerProjectHandlers(pythonEnvManager, agentManager, getMainWindow);

	// Task handlers
	registerTaskHandlers(agentManager, pythonEnvManager, getMainWindow);

	// CI/CD pipeline loop (kanban pipeline badge + « Build rouge » auto-repair) — any provider
	registerPipelineHandlers(agentManager, getMainWindow);

	// Terminal and Claude profile handlers
	registerTerminalHandlers(terminalManager, getMainWindow);

	// Terminal worktree handlers (isolated development in worktrees)
	registerTerminalWorktreeIpcHandlers();

	// Agent event handlers (event forwarding from agent manager to renderer)
	registerAgenteventsHandlers(agentManager, getMainWindow);

	// Settings and dialog handlers
	registerSettingsHandlers(agentManager, getMainWindow);

	// Multi-user server mode: connection + login (local / Entra ID)
	registerServerAuthHandlers(getMainWindow);

	// File explorer handlers
	registerFileHandlers();

	// Roadmap handlers
	registerRoadmapHandlers(agentManager, getMainWindow);

	// Context and memory handlers
	registerContextHandlers(getMainWindow);

	// Environment configuration handlers
	registerEnvHandlers(getMainWindow);

	// Linear integration handlers
	registerLinearHandlers(agentManager, getMainWindow);

	// Azure DevOps integration handlers
	registerAzureDevOpsHandlers(agentManager, getMainWindow);

	// Universal PR Details handler (supports both GitHub and Azure DevOps)
	registerPRDetailsHandlers();

	// Jira integration handlers
	registerJiraHandlers(agentManager, getMainWindow);

	// GitHub integration handlers
	registerGithubHandlers(agentManager, getMainWindow);

	// GitLab integration handlers
	registerGitlabHandlers(agentManager, getMainWindow);

	// Ideation handlers
	registerIdeationHandlers(agentManager, getMainWindow);

	// Changelog handlers
	registerChangelogHandlers(getMainWindow);

	// Insights handlers
	registerInsightsHandlers(getMainWindow);

	// Memory & infrastructure handlers (for Graphiti/LadybugDB)
	registerMemoryHandlers();

	// App auto-update handlers
	registerAppUpdateHandlers();

	// Debug handlers (logs, debug info, etc.)
	registerDebugHandlers();

	// Claude Code CLI handlers (version checking, installation)
	registerClaudeCodeHandlers();

	// Copilot CLI handlers (version checking, installation, auth)
	registerCopilotCliHandlers();

	// Copilot OAuth handlers (web-based authentication)
	registerCopilotOAuthHandlers();

	// MCP server health check handlers
	registerMcpHandlers();

	// API Profile handlers (custom Anthropic-compatible endpoints)
	registerProfileHandlers();

	// Screenshot capture handlers
	registerScreenshotHandlers();

	// Quality Scorer handlers (AI Code Review)
	setupQualityHandlers();

	// Prompt Optimizer handlers
	registerPromptOptimizerHandlers(getMainWindow);

	// Credential Manager handlers (centralized auth and usage management)
	registerCredentialHandlers();

	// GitHub Copilot CLI handlers (CLI-based authentication)
	registerGitHubCopilotHandlers();

	// Natural Language Git handlers
	setupNaturalLanguageGitHandlers();

	// Smart Estimation handlers
	setupSmartEstimationHandlers();

	// Conflict Predictor handlers
	setupConflictPredictorHandlers();

	// Voice Control handlers
	registerVoiceControlHandlers();
	setupVoiceControlEvents();

	// App Emulator handlers
	registerAppEmulatorHandlers(getMainWindow);

	// Learning Loop handlers (Autonomous Agent Learning Loop)
	registerLearningLoopHandlers(getMainWindow);

	// MCP Marketplace handlers (catalog, install, builder)
	registerMcpMarketplaceHandlers();

	// Multi-Repo Orchestration handlers
	registerMultiRepoHandlers(agentManager, getMainWindow);

	// Self-Healing Codebase + Incident Responder handlers
	registerSelfHealingHandlers(getMainWindow);

	// Browser Agent handlers (built-in browser for testing and visual validation)
	registerBrowserAgentHandlers(getMainWindow);

	// Architecture Visualizer handlers
	registerArchitectureVisualizerHandlers();
	setupArchitectureVisualizerEventForwarding();

	// Code Migration Agent handlers
	registerCodeMigrationHandlers();
	setupCodeMigrationEventForwarding();

	// Performance Profiler Agent handlers
	registerPerformanceProfilerHandlers();
	setupPerformanceProfilerEventForwarding();

	// Documentation Agent handlers
	registerDocumentationAgentHandlers();
	setupDocumentationAgentEventForwarding();

	// Agent Decision Logger handlers (Feature 30)
	registerDecisionLoggerHandlers();

	// AI Pair Programming handlers (Feature 10)
	registerPairProgrammingHandlers(getMainWindow);

	// Pipeline Generator handlers (Feature 23)
	registerPipelineGeneratorHandlers();
	setupPipelineGeneratorEventForwarding(getMainWindow);

	// Team Knowledge Sync handlers (Feature 31)
	registerTeamSyncHandlers();

	// Plugin Marketplace handlers (Feature 37)
	registerPluginMarketplaceHandlers();

	// Arena Mode handlers (Feature 9) — Blind A/B model comparison
	registerArenaHandlers(getMainWindow);

	// Memory Lifecycle Manager handlers (Feature 43)
	registerMemoryLifecycleHandlers();
	setupMemoryLifecycleEventForwarding(getMainWindow);

	// CI/CD Deployment Triggers handlers (Feature 44)
	registerCICDTriggersHandlers();
	setupCICDTriggersEventForwarding(getMainWindow);

	// Cross-Language Translation Agent handlers (Feature 41)
	registerCrossLanguageTranslationHandlers();

	// Spec Approval Workflow handlers (Feature 42)
	registerSpecApprovalHandlers();

	// API Explorer — project route scanning
	registerApiExplorerHandlers();

	// Test Generation handlers
	setupTestGenerationHandlers(getMainWindow);

	// Cost Estimator handlers
	registerCostHandlers();

	// Visual Programming handlers (diagram → code, code → diagram)
	registerVisualProgrammingHandlers(getMainWindow);
	setupVisualProgrammingEventForwarding(getMainWindow);

	// Code Playground handlers (AI sandbox code generation)
	registerCodePlaygroundHandlers();
	setupCodePlaygroundEventForwarding();

	// Context Mesh handlers (Cross-Project Intelligence)
	registerContextMeshHandlers(getMainWindow);

	// Live Development Companion handlers (Real-time pair programming)
	registerLiveCompanionHandlers(getMainWindow);

	// Agent Time Travel handlers (Temporal debugger for AI agents)
	registerTimeTravelHandlers(getMainWindow);

	// Phase 3-5 backend feature modules (#3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12)
	registerPhase35FeatureHandlers(getMainWindow);

	// Accessibility Agent handlers (WCAG scanner)
	registerAccessibilityHandlers();

	// i18n Agent handlers (hardcoded strings, locale coverage)
	registerI18nAgentHandlers();

	// Doc Drift handlers (documentation vs code drift detection)
	registerDocDriftHandlers();

	// Flaky Tests handlers (JUnit report analysis)
	registerFlakyTestsHandlers();

	// Carbon Profiler handlers (energy and CO2 footprint)
	registerCarbonProfilerHandlers();

	// Compliance Evidence Collector handlers (SOC2, ISO 27001)
	registerComplianceHandlers();

	// API Watcher handlers (OpenAPI/GraphQL/Protobuf breaking change detection)
	registerApiWatcherHandlers();

	// Git Surgeon handlers (history analysis: blobs, secrets, messy commits)
	registerGitSurgeonHandlers();

	// Release Coordinator handlers (multi-service semver plan)
	registerReleaseCoordinatorHandlers();

	// Notebook Agent handlers (.ipynb discovery, parse, lint)
	registerNotebookAgentHandlers();

	// Spec Refinement handlers (load persisted refinement histories)
	registerSpecRefinementHandlers();

	// Agent Coach handlers (analyse persisted agent run records)
	registerAgentCoachHandlers();

	// Onboarding Agent handlers (project onboarding guide generation)
	registerOnboardingAgentHandlers();

	// Sandbox handlers (dry-run diff preview of uncommitted changes)
	registerSandboxHandlers();

	// Regression Guardian handlers (APM incident → regression test candidates)
	registerRegressionGuardianHandlers();

	// Consensus Arbiter handlers (detect & resolve inter-agent conflicts)
	registerConsensusArbiterHandlers();

	// Injection Guard handlers (prompt injection scanner)
	registerInjectionGuardHandlers();

	// Guardrails handlers (user-defined agent guardrails)
	registerGuardrailsHandlers();

	// Cost Predictor handlers (ex-ante spec cost prediction)
	registerCostPredictorHandlers();

	// Formula Matrix handlers (Provider × LLM × Effort comparator — Formula Lab)
	registerFormulaMatrixHandlers();

	// Agent Debugger handlers (Feature 1)
	registerAgentDebuggerHandlers();

	// Blast Radius handlers (Feature 6)
	registerBlastRadiusHandlers();

	// Bounty Board handlers (Feature 3 — competitive multi-agent rounds)
	registerBountyBoardHandlers();

	// Tech Debt handlers (Feature 9 — ROI-scored tech debt dashboard)
	registerTechDebtHandlers();

	// Team Bot handlers (Feature 4 — Slack / Microsoft Teams notifications)
	registerTeamBotHandlers();

	// Env Snapshot handlers (Feature 11 — reproducible environment snapshots)
	registerEnvSnapshotHandlers();

	// Offline Mode handlers (Feature 12 — local model routing + confidentiality)
	registerOfflineModeHandlers();

	console.warn("[IPC] All handler modules registered successfully");
}
