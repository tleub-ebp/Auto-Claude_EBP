import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enAccessibility from "./locales/en/accessibility.json";
import enAgentCoach from "./locales/en/agentCoach.json";
import enAgentDebugger from "./locales/en/agentDebugger.json";
import enBlastRadius from "./locales/en/blastRadius.json";
import enEnvSnapshot from "./locales/en/envSnapshot.json";
import enOfflineMode from "./locales/en/offlineMode.json";
import enBountyBoard from "./locales/en/bountyBoard.json";
import enTechDebt from "./locales/en/techDebt.json";
import enTeamBot from "./locales/en/teamBot.json";
import enFlakyTests from "./locales/en/flakyTests.json";
import enI18nAgent from "./locales/en/i18nAgent.json";
import enOnboardingAgent from "./locales/en/onboardingAgent.json";
import enAnalytics from "./locales/en/analytics.json";
import enApiExplorer from "./locales/en/apiExplorer.json";
import enCarbonProfiler from "./locales/en/carbonProfiler.json";
import enCompliance from "./locales/en/compliance.json";
import enConsensusArbiter from "./locales/en/consensusArbiter.json";
import enDocDrift from "./locales/en/docDrift.json";
import enGitSurgeon from "./locales/en/gitSurgeon.json";
import enNotebookAgent from "./locales/en/notebookAgent.json";
import enReleaseCoordinator from "./locales/en/releaseCoordinator.json";
import enSpecRefinement from "./locales/en/specRefinement.json";
import enSandbox from "./locales/en/sandbox.json";
import enRegressionGuardian from "./locales/en/regressionGuardian.json";
import enInjectionGuard from "./locales/en/injectionGuard.json";
import enApiWatcher from "./locales/en/api-watcher.json";
import enAgentTools from "./locales/en/agentTools.json";

// Import English translation resources
import enAppEmulator from "./locales/en/appEmulator.json";
import enPhase35 from "./locales/en/phase35.json";
import enArena from "./locales/en/arena.json";
import enBrowserAgent from "./locales/en/browserAgent.json";
import enChangelog from "./locales/en/changelog.json";
import enCodePlayground from "./locales/en/codePlayground.json";
import enCodeReview from "./locales/en/codeReview.json";
import enCollaboration from "./locales/en/collaboration.json";
import enCommon from "./locales/en/common.json";
import enConflictPredictor from "./locales/en/conflictPredictor.json";
import enContext from "./locales/en/context.json";
import enContextAwareSnippets from "./locales/en/contextAwareSnippets.json";
import enContinuousAI from "./locales/en/continuousAI.json";
import enCostEstimator from "./locales/en/costEstimator.json";
import enDashboard from "./locales/en/dashboard.json";
import enDesignToCode from "./locales/en/designToCode.json";
import enDialogs from "./locales/en/dialogs.json";
import enDocumentation from "./locales/en/documentation.json";
import enErrors from "./locales/en/errors.json";
import enGitlab from "./locales/en/gitlab.json";
import enIdeation from "./locales/en/ideation.json";
import enInitDialog from "./locales/en/initDialog.json";
import enInsights from "./locales/en/insights.json";
import enLearningLoop from "./locales/en/learningLoop.json";
import enMigrationWizard from "./locales/en/migration-wizard.json";
import enMissionControl from "./locales/en/missionControl.json";
import enMultiRepo from "./locales/en/multiRepo.json";
import enNaturalLanguageGit from "./locales/en/naturalLanguageGit.json";
import enNavigation from "./locales/en/navigation.json";
import enOnboarding from "./locales/en/onboarding.json";
import enPairProgramming from "./locales/en/pairProgramming.json";
import enPipelineGenerator from "./locales/en/pipelineGenerator.json";
import enPixelOffice from "./locales/en/pixelOffice.json";
import enProjectInitModal from "./locales/en/projectInitModal.json";
import enPromptOptimizer from "./locales/en/promptOptimizer.json";
import enQualityScore from "./locales/en/qualityScore.json";
import enRefactoring from "./locales/en/refactoring.json";
import enReplay from "./locales/en/replay.json";
import enRoadmap from "./locales/en/roadmap.json";
import enSelfHealing from "./locales/en/selfHealing.json";
import enSessionHistory from "./locales/en/sessionHistory.json";
import enSettings from "./locales/en/settings.json";
import enStreaming from "./locales/en/streaming.json";
import enSwarm from "./locales/en/swarm.json";
import enTaskReview from "./locales/en/taskReview.json";
import enTasks from "./locales/en/tasks.json";
import enTerminal from "./locales/en/terminal.json";
import enTestGeneration from "./locales/en/testGeneration.json";
import enVisualProgramming from "./locales/en/visualProgramming.json";
import enVisualToCode from "./locales/en/visualToCode.json";
import enVoiceControl from "./locales/en/voiceContol.json";
import enWelcome from "./locales/en/welcome.json";
import frAccessibility from "./locales/fr/accessibility.json";
import frAgentCoach from "./locales/fr/agentCoach.json";
import frAgentDebugger from "./locales/fr/agentDebugger.json";
import frBlastRadius from "./locales/fr/blastRadius.json";
import frEnvSnapshot from "./locales/fr/envSnapshot.json";
import frOfflineMode from "./locales/fr/offlineMode.json";
import frBountyBoard from "./locales/fr/bountyBoard.json";
import frTechDebt from "./locales/fr/techDebt.json";
import frTeamBot from "./locales/fr/teamBot.json";
import frFlakyTests from "./locales/fr/flakyTests.json";
import frI18nAgent from "./locales/fr/i18nAgent.json";
import frOnboardingAgent from "./locales/fr/onboardingAgent.json";
import frAnalytics from "./locales/fr/analytics.json";
import frApiExplorer from "./locales/fr/apiExplorer.json";
import frCarbonProfiler from "./locales/fr/carbonProfiler.json";
import frCompliance from "./locales/fr/compliance.json";
import frConsensusArbiter from "./locales/fr/consensusArbiter.json";
import frDocDrift from "./locales/fr/docDrift.json";
import frGitSurgeon from "./locales/fr/gitSurgeon.json";
import frNotebookAgent from "./locales/fr/notebookAgent.json";
import frReleaseCoordinator from "./locales/fr/releaseCoordinator.json";
import frSpecRefinement from "./locales/fr/specRefinement.json";
import frSandbox from "./locales/fr/sandbox.json";
import frRegressionGuardian from "./locales/fr/regressionGuardian.json";
import frInjectionGuard from "./locales/fr/injectionGuard.json";
import frApiWatcher from "./locales/fr/api-watcher.json";
import frAgentTools from "./locales/fr/agentTools.json";

// Import French translation resources
import frAppEmulator from "./locales/fr/appEmulator.json";
import frPhase35 from "./locales/fr/phase35.json";
import frArena from "./locales/fr/arena.json";
import frBrowserAgent from "./locales/fr/browserAgent.json";
import frChangelog from "./locales/fr/changelog.json";
import frCodePlayground from "./locales/fr/codePlayground.json";
import frCodeReview from "./locales/fr/codeReview.json";
import frCollaboration from "./locales/fr/collaboration.json";
import frCommon from "./locales/fr/common.json";
import frConflictPredictor from "./locales/fr/conflictPredictor.json";
import frContext from "./locales/fr/context.json";
import frContextAwareSnippets from "./locales/fr/contextAwareSnippets.json";
import frContinuousAI from "./locales/fr/continuousAI.json";
import frCostEstimator from "./locales/fr/costEstimator.json";
import frDashboard from "./locales/fr/dashboard.json";
import frDesignToCode from "./locales/fr/designToCode.json";
import frDialogs from "./locales/fr/dialogs.json";
import frDocumentation from "./locales/fr/documentation.json";
import frErrors from "./locales/fr/errors.json";
import frGitlab from "./locales/fr/gitlab.json";
import frIdeation from "./locales/fr/ideation.json";
import frInitDialog from "./locales/fr/initDialog.json";
import frInsights from "./locales/fr/insights.json";
import frLearningLoop from "./locales/fr/learningLoop.json";
import frMigrationWizard from "./locales/fr/migration-wizard.json";
import frMissionControl from "./locales/fr/missionControl.json";
import frMultiRepo from "./locales/fr/multiRepo.json";
import frNaturalLanguageGit from "./locales/fr/naturalLanguageGit.json";
import frNavigation from "./locales/fr/navigation.json";
import frOnboarding from "./locales/fr/onboarding.json";
import frPairProgramming from "./locales/fr/pairProgramming.json";
import frPipelineGenerator from "./locales/fr/pipelineGenerator.json";
import frPixelOffice from "./locales/fr/pixelOffice.json";
import frProjectInitModal from "./locales/fr/projectInitModal.json";
import frPromptOptimizer from "./locales/fr/promptOptimizer.json";
import frQualityScore from "./locales/fr/qualityScore.json";
import frRefactoring from "./locales/fr/refactoring.json";
import frReplay from "./locales/fr/replay.json";
import frRoadmap from "./locales/fr/roadmap.json";
import frSelfHealing from "./locales/fr/selfHealing.json";
import frSessionHistory from "./locales/fr/sessionHistory.json";
import frSettings from "./locales/fr/settings.json";
import frStreaming from "./locales/fr/streaming.json";
import frSwarm from "./locales/fr/swarm.json";
import frTaskReview from "./locales/fr/taskReview.json";
import frTasks from "./locales/fr/tasks.json";
import frTerminal from "./locales/fr/terminal.json";
import frTestGeneration from "./locales/fr/testGeneration.json";
import frVisualProgramming from "./locales/fr/visualProgramming.json";
import frVisualToCode from "./locales/fr/visualToCode.json";
import frVoiceControl from "./locales/fr/voiceContol.json";
import frWelcome from "./locales/fr/welcome.json";

export const defaultNS = "common";

export const resources = {
	en: {
		accessibility: enAccessibility,
		agentCoach: enAgentCoach,
		agentDebugger: enAgentDebugger,
		blastRadius: enBlastRadius,
		envSnapshot: enEnvSnapshot,
		offlineMode: enOfflineMode,
		bountyBoard: enBountyBoard,
		techDebt: enTechDebt,
		teamBot: enTeamBot,
		flakyTests: enFlakyTests,
		i18nAgent: enI18nAgent,
		onboardingAgent: enOnboardingAgent,
		appEmulator: enAppEmulator,
		phase35: enPhase35,
		analytics: enAnalytics,
		browserAgent: enBrowserAgent,
		carbonProfiler: enCarbonProfiler,
		compliance: enCompliance,
		consensusArbiter: enConsensusArbiter,
		docDrift: enDocDrift,
		gitSurgeon: enGitSurgeon,
		notebookAgent: enNotebookAgent,
		releaseCoordinator: enReleaseCoordinator,
		specRefinement: enSpecRefinement,
		sandbox: enSandbox,
		regressionGuardian: enRegressionGuardian,
		injectionGuard: enInjectionGuard,
		apiWatcher: enApiWatcher,
		agentTools: enAgentTools,
		changelog: enChangelog,
		codePlayground: enCodePlayground,
		codeReview: enCodeReview,
		collaboration: enCollaboration,
		common: enCommon,
		conflictPredictor: enConflictPredictor,
		context: enContext,
		contextAwareSnippets: enContextAwareSnippets,
		designToCode: enDesignToCode,
		dialogs: enDialogs,
		documentation: enDocumentation,
		errors: enErrors,
		gitlab: enGitlab,
		initDialog: enInitDialog,
		insights: enInsights,
		learningLoop: enLearningLoop,
		multiRepo: enMultiRepo,
		migrationWizard: enMigrationWizard,
		missionControl: enMissionControl,
		pixelOffice: enPixelOffice,
		selfHealing: enSelfHealing,
		sessionHistory: enSessionHistory,
		voiceControl: enVoiceControl,
		ideation: enIdeation,
		costEstimator: enCostEstimator,
		dashboard: enDashboard,
		naturalLanguageGit: enNaturalLanguageGit,
		navigation: enNavigation,
		onboarding: enOnboarding,
		promptOptimizer: enPromptOptimizer,
		projectInitModal: enProjectInitModal,
		replay: enReplay,
		refactoring: enRefactoring,
		roadmap: enRoadmap,
		settings: enSettings,
		streaming: enStreaming,
		taskReview: enTaskReview,
		tasks: enTasks,
		terminal: enTerminal,
		testGeneration: enTestGeneration,
		visualProgramming: enVisualProgramming,
		welcome: enWelcome,
		pairProgramming: enPairProgramming,
		arena: enArena,
		apiExplorer: enApiExplorer,
		pipelineGenerator: enPipelineGenerator,
		visualToCode: enVisualToCode,
		qualityScore: enQualityScore,
		swarm: enSwarm,
		continuousAI: enContinuousAI,
	},
	fr: {
		accessibility: frAccessibility,
		agentCoach: frAgentCoach,
		agentDebugger: frAgentDebugger,
		blastRadius: frBlastRadius,
		envSnapshot: frEnvSnapshot,
		offlineMode: frOfflineMode,
		bountyBoard: frBountyBoard,
		techDebt: frTechDebt,
		teamBot: frTeamBot,
		flakyTests: frFlakyTests,
		i18nAgent: frI18nAgent,
		onboardingAgent: frOnboardingAgent,
		appEmulator: frAppEmulator,
		phase35: frPhase35,
		analytics: frAnalytics,
		browserAgent: frBrowserAgent,
		carbonProfiler: frCarbonProfiler,
		compliance: frCompliance,
		consensusArbiter: frConsensusArbiter,
		docDrift: frDocDrift,
		gitSurgeon: frGitSurgeon,
		notebookAgent: frNotebookAgent,
		releaseCoordinator: frReleaseCoordinator,
		specRefinement: frSpecRefinement,
		sandbox: frSandbox,
		regressionGuardian: frRegressionGuardian,
		injectionGuard: frInjectionGuard,
		apiWatcher: frApiWatcher,
		agentTools: frAgentTools,
		changelog: frChangelog,
		codePlayground: frCodePlayground,
		codeReview: frCodeReview,
		collaboration: frCollaboration,
		common: frCommon,
		conflictPredictor: frConflictPredictor,
		context: frContext,
		contextAwareSnippets: frContextAwareSnippets,
		designToCode: frDesignToCode,
		dialogs: frDialogs,
		documentation: frDocumentation,
		errors: frErrors,
		gitlab: frGitlab,
		initDialog: frInitDialog,
		insights: frInsights,
		learningLoop: frLearningLoop,
		multiRepo: frMultiRepo,
		migrationWizard: frMigrationWizard,
		missionControl: frMissionControl,
		pixelOffice: frPixelOffice,
		selfHealing: frSelfHealing,
		sessionHistory: frSessionHistory,
		voiceControl: frVoiceControl,
		ideation: frIdeation,
		costEstimator: frCostEstimator,
		dashboard: frDashboard,
		naturalLanguageGit: frNaturalLanguageGit,
		navigation: frNavigation,
		onboarding: frOnboarding,
		promptOptimizer: frPromptOptimizer,
		projectInitModal: frProjectInitModal,
		replay: frReplay,
		refactoring: frRefactoring,
		roadmap: frRoadmap,
		settings: frSettings,
		streaming: frStreaming,
		taskReview: frTaskReview,
		tasks: frTasks,
		terminal: frTerminal,
		testGeneration: frTestGeneration,
		visualProgramming: frVisualProgramming,
		welcome: frWelcome,
		pairProgramming: frPairProgramming,
		arena: frArena,
		apiExplorer: frApiExplorer,
		pipelineGenerator: frPipelineGenerator,
		visualToCode: frVisualToCode,
		qualityScore: frQualityScore,
		swarm: frSwarm,
		continuousAI: frContinuousAI,
	},
} as const;

i18n.use(initReactI18next).init({
	resources,
	lng: "en",
	fallbackLng: "en",
	defaultNS,
	ns: [
		"accessibility",
		"agentCoach",
		"agentDebugger",
		"blastRadius",
		"envSnapshot",
		"offlineMode",
		"bountyBoard",
		"techDebt",
		"teamBot",
		"flakyTests",
		"i18nAgent",
		"onboardingAgent",
		"appEmulator",
		"phase35",
		"analytics",
		"browserAgent",
		"carbonProfiler",
		"compliance",
		"consensusArbiter",
		"docDrift",
		"gitSurgeon",
		"notebookAgent",
		"releaseCoordinator",
		"specRefinement",
		"sandbox",
		"regressionGuardian",
		"injectionGuard",
		"apiWatcher",
		"agentTools",
		"changelog",
		"codePlayground",
		"codeReview",
		"collaboration",
		"common",
		"conflictPredictor",
		"context",
		"contextAwareSnippets",
		"designToCode",
		"dialogs",
		"documentation",
		"errors",
		"gitlab",
		"initDialog",
		"insights",
		"learningLoop",
		"multiRepo",
		"migrationWizard",
		"missionControl",
		"pixelOffice",
		"selfHealing",
		"sessionHistory",
		"voiceControl",
		"ideation",
		"costEstimator",
		"dashboard",
		"naturalLanguageGit",
		"navigation",
		"onboarding",
		"promptOptimizer",
		"projectInitModal",
		"replay",
		"refactoring",
		"roadmap",
		"settings",
		"streaming",
		"taskReview",
		"tasks",
		"terminal",
		"testGeneration",
		"visualProgramming",
		"welcome",
		"pairProgramming",
		"arena",
		"apiExplorer",
		"pipelineGenerator",
		"visualToCode",
		"qualityScore",
		"swarm",
		"continuousAI",
	],
	interpolation: {
		escapeValue: false,
	},
	react: {
		useSuspense: false,
	},
});

export default i18n;
