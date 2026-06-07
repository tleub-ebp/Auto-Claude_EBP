import type { ChildProcess } from "node:child_process";
import type {
	CompletablePhase,
	ExecutionPhase,
} from "../../shared/constants/phase-protocol";
import type { TaskEventPayload } from "./task-event-schema";

/**
 * Agent-specific types for process and state management
 */

export type QueueProcessType = "ideation" | "roadmap";

export interface AgentProcess {
	taskId: string;
	process: ChildProcess | null; // null during async spawn setup before ChildProcess is created
	startedAt: Date;
	projectPath?: string; // For ideation processes to load session on completion
	spawnId: number; // Unique ID to identify this specific spawn
	queueProcessType?: QueueProcessType; // Type of queue process (ideation or roadmap)
}

export interface ExecutionProgressData {
	phase: ExecutionPhase;
	phaseProgress: number;
	overallProgress: number;
	currentSubtask?: string;
	message?: string;
	// FIX (ACS-203): Track completed phases to prevent phase overlaps
	completedPhases?: CompletablePhase[];
}

export type ProcessType = "spec-creation" | "task-execution" | "qa-process";

export interface AgentManagerEvents {
	log: (taskId: string, log: string, projectId?: string) => void;
	error: (taskId: string, error: string, projectId?: string) => void;
	exit: (
		taskId: string,
		code: number | null,
		processType: ProcessType,
		projectId?: string,
	) => void;
	"execution-progress": (
		taskId: string,
		progress: ExecutionProgressData,
		projectId?: string,
	) => void;
	"task-event": (
		taskId: string,
		event: TaskEventPayload,
		projectId?: string,
	) => void;
}

// IdeationConfig now imported from shared types to maintain consistency

export interface RoadmapConfig {
	model?: string; // Model shorthand (opus, sonnet, haiku)
	thinkingLevel?: string; // Thinking level (none, low, medium, high, ultrathink)
}

export interface TaskExecutionOptions {
	parallel?: boolean;
	workers?: number;
	baseBranch?: string;
	useWorktree?: boolean; // If false, use --direct mode (no worktree isolation)
	useLocalBranch?: boolean; // If true, use local branch directly instead of preferring origin/branch
	enableStreaming?: boolean; // Enable streaming mode for this task
	streamingSessionId?: string; // Streaming session ID for live coding
	// Claude Agent SDK session_id to resume. When set, the backend rehydrates
	// transcript context instead of starting from scratch — used when a card
	// hit error_max_turns or error_max_budget_usd and the user clicks "Reprendre".
	// Injected into the subprocess env as AUTO_CLAUDE_RESUME_SESSION_ID.
	resumeSessionId?: string;
	// Per-task TDD override. true -> force strict TDD, false -> force disabled,
	// undefined -> inherit project default. Injected as TDD_MODE env at spawn time.
	tddMode?: boolean;
}

export interface SpecCreationMetadata {
	requireReviewBeforeCoding?: boolean;
	// Per-task TDD override. true -> force strict TDD, false -> force disabled,
	// undefined -> inherit project default. Injected as TDD_MODE env at spawn time.
	tddMode?: boolean;
	// LLM provider (anthropic, openai, copilot, google, mistral, deepseek, grok, meta, aws, ollama)
	provider?: string;
	// Auto profile - phase-based model and thinking configuration
	isAutoProfile?: boolean;
	phaseModels?: {
		spec: string; // Model ID (Claude shorthand or full model ID for any provider)
		planning: string;
		coding: string;
		qa: string;
	};
	phaseThinking?: {
		spec: "none" | "low" | "medium" | "high" | "ultrathink";
		planning: "none" | "low" | "medium" | "high" | "ultrathink";
		coding: "none" | "low" | "medium" | "high" | "ultrathink";
		qa: "none" | "low" | "medium" | "high" | "ultrathink";
	};
	// Non-auto profile - single model and thinking level
	model?: string; // Model ID (Claude shorthand like 'sonnet' or full ID like 'gpt-4o')
	thinkingLevel?: "none" | "low" | "medium" | "high" | "ultrathink";
	// Workspace mode - whether to use worktree isolation
	useWorktree?: boolean; // If false, use --direct mode (no worktree isolation)
	useLocalBranch?: boolean; // If true, use local branch directly instead of preferring origin/branch
}

export interface IdeationProgressData {
	phase: string;
	progress: number;
	message: string;
	completedTypes?: string[];
}

export interface RoadmapProgressData {
	phase: string;
	progress: number;
	message: string;
}
