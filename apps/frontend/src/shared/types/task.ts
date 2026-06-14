/**
 * Task-related types
 */

import type {
	CompletablePhase,
	ExecutionPhase as ExecutionPhaseType,
} from "../constants/phase-protocol";
import type {
	PhaseModelConfig,
	PhaseProviderConfig,
	PhaseThinkingConfig,
	ThinkingLevel,
} from "./settings";

export type TaskStatus =
	| "backlog"
	| "queue"
	| "in_progress"
	| "ai_review"
	| "human_review"
	| "build_failed" // CI pipeline (any provider) went red on this task's branch — "Build rouge" column
	| "done"
	| "pr_created"
	| "error";

// Maps task status columns to ordered task IDs for kanban board reordering
export type TaskOrderState = Record<TaskStatus, string[]>;

// Reason why a task is in human_review status
// - 'completed': All subtasks done and QA passed, ready for final approval/merge
// - 'errors': Subtasks failed during execution
// - 'qa_rejected': QA found issues that need fixing
// - 'plan_review': Spec/plan created and awaiting approval before coding starts
// - 'prompt_too_long': The accumulated conversation exceeded the LLM context
//                     limit; retrying with the same context will never succeed.
//                     User should reset the conversation or switch to a provider
//                     with a larger context window.
export type ReviewReason =
	| "completed"
	| "errors"
	| "qa_rejected"
	| "plan_review"
	| "stopped"
	| "prompt_too_long";

// "blocked" = the agent did all it could but the subtask needs manual action
// (e.g. an e2e test that must be run by a human). The backend treats it as DONE
// for build-completion (see core/progress.py count_subtasks), so the frontend
// must too — otherwise a finished build shows e.g. 2/3 and an undersized %.
export type SubtaskStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "blocked"
	| "failed";

// Re-exported from constants - single source of truth
export type ExecutionPhase = ExecutionPhaseType;

export interface ExecutionProgress {
	phase: ExecutionPhase;
	phaseProgress: number; // 0-100 within current phase
	overallProgress: number; // 0-100 overall
	currentSubtask?: string; // Current subtask being processed
	message?: string; // Current status message
	startedAt?: Date;
	sequenceNumber?: number; // Monotonically increasing counter to detect stale updates
	// FIX (ACS-203): Track completed phases to prevent phase overlaps
	// When a phase completes, it's added to this array before transitioning to the next phase
	// This ensures that planning is marked complete before coding starts, etc.
	completedPhases?: CompletablePhase[]; // Phases that have successfully completed
}

export interface Subtask {
	id: string;
	title: string;
	description: string;
	status: SubtaskStatus;
	files: string[];
	/**
	 * Why a subtask ended up "blocked" (e.g. "Failed after 5 attempts"). Set by
	 * the backend when the agent gives up; surfaced in the UI so a blocked
	 * subtask reads as "needs attention" rather than a silent gray state.
	 */
	blockedReason?: string;
	verification?: {
		type: "command" | "browser";
		run?: string;
		scenario?: string;
	};
}

/**
 * A clarifying question produced by the pre-planning spec interview.
 * Answers are appended to the task description before planning starts.
 */
export interface SpecInterviewQuestion {
	id: string;
	question: string;
	/** Why this question matters for the implementation. */
	rationale?: string;
	/** A plausible default answer the user can accept as-is. */
	suggestion?: string;
}

export interface QAReport {
	status: "passed" | "failed" | "pending";
	issues: QAIssue[];
	timestamp: Date;
}

export interface QAIssue {
	id: string;
	severity: "critical" | "major" | "minor";
	description: string;
	file?: string;
	line?: number;
}

// Task Log Types - for persistent, phase-based logging
export type TaskLogPhase = "planning" | "coding" | "validation";
export type TaskLogPhaseStatus = "pending" | "active" | "completed" | "failed";
export type TaskLogEntryType =
	| "text"
	| "tool_start"
	| "tool_end"
	| "phase_start"
	| "phase_end"
	| "error"
	| "success"
	| "info";

export interface TaskLogEntry {
	timestamp: string;
	type: TaskLogEntryType;
	content: string;
	phase: TaskLogPhase;
	tool_name?: string;
	tool_input?: string;
	subtask_id?: string;
	session?: number;
	// Fields for expandable detail view
	detail?: string; // Full content that can be expanded (e.g., file contents, command output)
	subphase?: string; // Subphase grouping (e.g., "PROJECT DISCOVERY", "CONTEXT GATHERING")
	collapsed?: boolean; // Whether to show collapsed by default in UI
}

export interface TaskPhaseLog {
	phase: TaskLogPhase;
	status: TaskLogPhaseStatus;
	started_at: string | null;
	completed_at: string | null;
	entries: TaskLogEntry[];
}

export interface TaskLogs {
	spec_id: string;
	created_at: string;
	updated_at: string;
	phases: {
		planning: TaskPhaseLog;
		coding: TaskPhaseLog;
		validation: TaskPhaseLog;
	};
}

// Streaming markers from Python (similar to InsightsStreamChunk)
export interface TaskLogStreamChunk {
	type:
		| "text"
		| "tool_start"
		| "tool_end"
		| "phase_start"
		| "phase_end"
		| "error";
	content?: string;
	phase?: TaskLogPhase;
	timestamp?: string;
	tool?: {
		name: string;
		input?: string;
		success?: boolean;
	};
	subtask_id?: string;
}

// Image attachment types for task creation
export interface ImageAttachment {
	id: string; // Unique identifier (UUID)
	filename: string; // Original filename
	mimeType: string; // e.g., 'image/png'
	size: number; // Size in bytes
	data?: string; // Base64 data (for transport)
	path?: string; // Relative path after storage
	thumbnail?: string; // Base64 thumbnail for preview
}

// Referenced file types for task creation (files/folders from project)
export interface ReferencedFile {
	id: string; // Unique identifier (UUID)
	path: string; // Relative path from project root
	name: string; // File or folder name
	isDirectory: boolean; // True if this is a directory
	addedAt: Date; // When the file was added as reference
}

// Draft state for task creation (auto-saved when dialog closes)
export interface TaskDraft {
	projectId: string;
	title: string;
	description: string;
	category: TaskCategory | "";
	priority: TaskPriority | "";
	complexity: TaskComplexity | "";
	impact: TaskImpact | "";
	profileId?: string; // Agent profile ID ('auto', 'complex', 'balanced', 'quick', 'custom')
	model: string;
	thinkingLevel: ThinkingLevel | "";
	// Auto profile - per-phase configuration
	phaseModels?: PhaseModelConfig;
	phaseThinking?: PhaseThinkingConfig;
	images: ImageAttachment[];
	referencedFiles: ReferencedFile[];
	requireReviewBeforeCoding?: boolean;
	tddMode?: boolean;
	savedAt: Date;
}

// Task metadata from ideation or manual entry
export type TaskComplexity =
	| "trivial"
	| "small"
	| "medium"
	| "large"
	| "complex";
export type TaskImpact = "low" | "medium" | "high" | "critical";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
// Re-export ThinkingLevel (defined in settings.ts) for convenience
export type { ThinkingLevel } from "./settings";
export type ModelType = "haiku" | "sonnet" | "opus";

/**
 * The Provider × LLM × Effort "formula" a user selected in the Formula Lab,
 * persisted on a task so the kanban card can show its cost/success badge.
 */
export interface AppliedFormula {
	provider: string;
	model: string;
	effort: string; // ThinkingLevel: none | low | medium | high | ultrathink
	expectedCostUsd: number;
	successProbability: number; // 0-1
	perTokenBilled: boolean;
	appliedAt: string; // ISO timestamp
}
export type TaskCategory =
	| "feature"
	| "bug_fix"
	| "refactoring"
	| "documentation"
	| "security"
	| "performance"
	| "ui_ux"
	| "infrastructure"
	| "testing";

export interface TaskMetadata {
	// Origin tracking
	sourceType?:
		| "ideation"
		| "manual"
		| "imported"
		| "insights"
		| "roadmap"
		| "linear"
		| "github"
		| "gitlab";
	ideationType?: string; // e.g., 'code_improvements', 'security_hardening'
	ideaId?: string; // Reference to the original idea if converted
	featureId?: string; // Reference to roadmap feature if from roadmap
	linearIssueId?: string; // Reference to Linear issue if from Linear
	linearIdentifier?: string; // Linear issue identifier (e.g., 'ABC-123')
	linearUrl?: string; // Linear issue URL
	githubIssueNumber?: number; // Reference to GitHub issue number if from GitHub (single issue)
	githubIssueNumbers?: number[]; // Reference to multiple GitHub issues if from a batch
	githubUrl?: string; // GitHub issue URL
	githubBatchTheme?: string; // Theme/title of the GitHub issue batch
	gitlabIssueIid?: number; // Reference to GitLab issue IID if from GitLab
	gitlabUrl?: string; // GitLab issue URL
	azureDevOpsIdentifier?: string; // Azure DevOps work item identifier (e.g., '12345')
	azureDevOpsUrl?: string; // Azure DevOps work item URL
	azureDevOpsState?: string; // Azure DevOps work item state
	azureDevOpsType?: string; // Azure DevOps work item type (Bug, User Story, Task, etc.)

	// Jira Integration
	jiraIdentifier?: string; // Jira issue key (e.g., 'PROJ-123')
	jiraUrl?: string; // Jira issue URL
	jiraState?: string; // Jira issue state
	jiraType?: string; // Jira issue type (Bug, Story, Task, etc.)

	// Tracker d'origine de l'import (pilote le post-traitement : strip HTML,
	// inlining des images en pièce jointe, etc.).
	importSource?: "azure-devops" | "jira";

	// Classification
	category?: TaskCategory;
	complexity?: TaskComplexity;
	impact?: TaskImpact;
	priority?: TaskPriority;

	// Context
	rationale?: string; // Why this task matters
	problemSolved?: string; // What problem this addresses
	targetAudience?: string; // Who benefits

	// Technical details
	affectedFiles?: string[]; // Files likely to be modified
	dependencies?: string[]; // Other features/tasks this depends on
	acceptanceCriteria?: string[]; // What defines "done"
	extraNote?: string; // Free-form note added on the Kanban card; injected
	// into requirements.json as additional_context for every pipeline phase.

	// Effort estimation
	estimatedEffort?: TaskComplexity;

	// Type-specific metadata (from different idea types)
	securitySeverity?: "low" | "medium" | "high" | "critical";
	performanceCategory?: string;
	uiuxCategory?: string;
	codeQualitySeverity?: "suggestion" | "minor" | "major" | "critical";

	// Image attachments (screenshots, mockups, diagrams)
	attachedImages?: ImageAttachment[];

	// Referenced files (files/folders from project for context)
	referencedFiles?: ReferencedFile[];

	// Review settings
	requireReviewBeforeCoding?: boolean; // Require human review of spec/plan before coding starts

	// TDD override (per-task). When set, overrides project.settings.tddMode:
	// true -> force strict TDD, false -> force disabled, undefined -> inherit project default.
	tddMode?: boolean;

	// Agent configuration (from agent profile or manual selection)
	provider?: string; // Active LLM provider (e.g. 'anthropic', 'openai', 'google', 'ollama', ...)
	model?: string; // Model ID to use (supports multi-provider) - used when not auto profile
	thinkingLevel?: ThinkingLevel; // Thinking budget level (none, low, medium, high, ultrathink)
	// Auto profile - per-phase model configuration
	isAutoProfile?: boolean; // True when using Auto (Optimized) profile
	phaseModels?: PhaseModelConfig; // Per-phase model configuration
	phaseThinking?: PhaseThinkingConfig; // Per-phase thinking configuration
	phaseProviders?: PhaseProviderConfig; // Per-phase LLM provider configuration

	// Formula Lab — the Provider × LLM × Effort "formula" the user picked for
	// this ticket before development. Drives the compact kanban badge and seeds
	// the per-phase provider/model/thinking config above.
	appliedFormula?: AppliedFormula;

	// Git/Worktree configuration
	baseBranch?: string; // Override base branch for this task's worktree
	prUrl?: string; // GitHub PR URL if task has been submitted as a PR
	visualProof?: VisualProofRun; // Latest automated emulator/screenshots proof for the PR
	useWorktree?: boolean; // If false, use direct mode (no worktree isolation) - default is true for safety
	useLocalBranch?: boolean; // If true, use the local branch directly instead of preferring origin/branch (preserves gitignored files)

	// Pause/Resume state (from implementation_plan.json)
	paused?: {
		enabled: boolean;
		paused_at: string | null;
		paused_subtask_id: string | null;
		provider?: string;
		model?: string;
	};

	// Archive status
	archivedAt?: string; // ISO date when task was archived
	archivedInVersion?: string; // Version in which task was archived (from changelog)
}

export interface Task {
	id: string;
	specId: string;
	projectId: string;
	title: string;
	description: string;
	status: TaskStatus;
	reviewReason?: ReviewReason; // Why task needs human review (only set when status is 'human_review')
	subtasks: Subtask[];
	qaReport?: QAReport;
	logs: string[];
	metadata?: TaskMetadata; // Rich metadata from ideation or manual entry
	executionProgress?: ExecutionProgress; // Real-time execution progress
	releasedInVersion?: string; // Version in which this task was released
	stagedInMainProject?: boolean; // True if changes were staged to main project (worktree merged with --no-commit)
	stagedAt?: string; // ISO timestamp when changes were staged
	location?: "main" | "worktree"; // Where task was loaded from (main project or worktree)
	specsPath?: string; // Full path to specs directory for this task
	prUrl?: string; // URL of the PR created automatically when task is completed
	createdAt: Date;
	updatedAt: Date;
}

// Implementation Plan (from auto-claude)
export interface ImplementationPlan {
	feature?: string; // Some plans use 'feature', some use 'title'
	title?: string; // Alternative to 'feature' for task name
	workflow_type: string;
	services_involved?: string[];
	phases: Phase[];
	final_acceptance: string[];
	created_at: string;
	updated_at: string;
	spec_file: string;
	// Added for UI status persistence
	status?: TaskStatus;
	planStatus?: string;
	reviewReason?: ReviewReason;
	xstateState?: string; // Persisted XState machine state for restoration (e.g., 'planning', 'coding')
	lastEvent?: {
		eventId: string;
		sequence: number;
		type: string;
		timestamp: string;
	};
	recoveryNote?: string;
	description?: string;
	// Pause/Resume state. Written by the TASK_PAUSE handler and read back by the
	// backend coder loop (cooperative stop) and the task scanner (so the UI's
	// paused controls survive task-list reloads).
	paused?: {
		enabled: boolean;
		paused_at: string | null;
		paused_subtask_id: string | null;
		provider?: string;
		model?: string;
	};
}

export interface Phase {
	phase: number;
	name: string;
	type: string;
	subtasks: PlanSubtask[];
	depends_on?: number[];
}

export interface PlanSubtask {
	id: string;
	description: string;
	status: SubtaskStatus;
	/**
	 * Files impacted by this subtask. `files_changed` is the actual git diff
	 * recorded once the subtask completes (ground truth); the planner emits the
	 * `files_to_modify` / `files_to_create` predictions before coding; `files`
	 * is a legacy fallback. Use `extractSubtaskFiles()` to read a normalized
	 * flat list that prefers the ground truth.
	 */
	files?: string[];
	files_changed?: string[];
	files_to_modify?: string[];
	files_to_create?: string[];
	/** Backend-emitted reason a subtask was marked "blocked". */
	blocked_reason?: string;
	verification?: {
		type: string;
		run?: string;
		scenario?: string;
	};
}

// Workspace management types (for human review)
export interface WorktreeStatus {
	exists: boolean;
	worktreePath?: string;
	branch?: string;
	baseBranch?: string;
	currentProjectBranch?: string; // User's current checked-out branch in main project (merge target)
	commitCount?: number;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
}

export interface WorktreeDiff {
	files: WorktreeDiffFile[];
	summary: string;
}

export interface WorktreeDiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	patch?: string; // Git patch/diff content for the file
}

// ============================================
// CI/CD pipeline loop (provider-agnostic)
// ============================================

/** Supported CI/CD providers for the « Build rouge » loop. */
export type PipelineProviderId =
	| "azure-devops"
	| "github-actions"
	| "gitlab-ci"
	| "jenkins";

/** Normalized state of the latest pipeline run on a task's branch. */
export type PipelineRunState =
	| "none" // No build found for the branch (or pipeline not configured)
	| "queued"
	| "running"
	| "succeeded"
	| "partiallySucceeded"
	| "failed"
	| "canceled";

/**
 * Latest CI pipeline run observed for a task's worktree branch
 * (`workpilot/{specId}`), whatever the provider (Azure DevOps, GitHub
 * Actions, GitLab CI, Jenkins). Pushed from the main-process polling service
 * to the renderer so the kanban card can display a live pipeline badge, and
 * used to drive the « Build rouge » column + automatic repair loop.
 */
export interface TaskPipelineStatus {
	taskId: string;
	projectId: string;
	state: PipelineRunState;
	/** CI provider that produced this run. */
	provider?: PipelineProviderId;
	/** Human-readable provider name ("GitHub Actions", "Jenkins"…). */
	providerLabel?: string;
	buildId?: number | string;
	buildNumber?: string;
	definitionName?: string;
	branch?: string;
	/** Web URL of the run on the CI provider (clickable from the kanban card). */
	webUrl?: string;
	queueTime?: string;
	finishTime?: string;
	checkedAt: string;
	/** True while an automatic repair run for this red build is in flight. */
	autoFixInProgress?: boolean;
}

// ============================================
// Plan-time worktree conflict detection
// ============================================

/**
 * A task whose planned/modified files overlap with the inspected task.
 * Computed at planning time (plan review) so parallel tasks touching the
 * same files raise an alert BEFORE coding starts, instead of surfacing as
 * a merge conflict at the end.
 */
export interface PlanConflictTask {
	taskId: string;
	taskTitle: string;
	taskStatus: TaskStatus;
	/** Files shared between the two task plans (normalized, deduplicated). */
	files: string[];
}

export interface PlanConflictReport {
	/** Task the report was computed for. */
	taskId: string;
	/** Other active tasks sharing at least one file with this task's plan. */
	conflictingTasks: PlanConflictTask[];
	/** Total number of distinct overlapping files across all conflicting tasks. */
	totalConflictingFiles: number;
	checkedAt: string;
}

// Conflict severity levels from merge system
export type ConflictSeverity = "none" | "low" | "medium" | "high" | "critical";

// Type of conflict
export type ConflictType = "semantic" | "git";

// Information about a detected conflict
export interface MergeConflict {
	file: string;
	location: string;
	tasks: string[];
	severity: ConflictSeverity;
	canAutoMerge: boolean;
	strategy?: string;
	reason: string;
	type?: ConflictType; // 'semantic' = parallel task conflict, 'git' = branch divergence
}

// Path-mapped file that needs AI merge due to rename
export interface PathMappedAIMerge {
	oldPath: string;
	newPath: string;
	reason: string;
}

// Conflict scenario types for better UX messaging
// - 'already_merged': Task changes already identical in target branch
// - 'superseded': Target has newer version of same feature
// - 'diverged': Standard diverged branches (AI can resolve)
// - 'normal_conflict': Actual conflicting changes
export type ConflictScenario =
	| "already_merged"
	| "superseded"
	| "diverged"
	| "normal_conflict";

// Git-level conflict information (branch divergence)
export interface GitConflictInfo {
	hasConflicts: boolean;
	conflictingFiles: string[];
	needsRebase: boolean;
	commitsBehind: number;
	baseBranch: string;
	specBranch: string;
	// Files that need AI merge due to path mappings (file renames)
	pathMappedAIMerges?: PathMappedAIMerge[];
	// Total number of file renames detected
	totalRenames?: number;
	// Conflict scenario for better UX messaging
	scenario?: ConflictScenario;
	// Files that are already merged (identical in both branches)
	alreadyMergedFiles?: string[];
	// Human-readable message about the scenario
	scenarioMessage?: string;
}

// Summary statistics from merge preview/execution
export interface MergeStats {
	totalFiles: number;
	conflictFiles: number;
	totalConflicts: number;
	autoMergeable: number;
	aiResolved?: number;
	humanRequired?: number;
	hasGitConflicts?: boolean; // True if there are git-level conflicts requiring rebase
	// Count of files needing AI merge due to path mappings (file renames)
	pathMappedAIMergeCount?: number;
}

// Merge progress tracking (for progress bar during merge operations)
export type MergeStage =
	| "analyzing"
	| "detecting_conflicts"
	| "resolving"
	| "validating"
	| "complete"
	| "error";

export interface MergeProgress {
	stage: MergeStage;
	percent: number;
	message: string;
	details?: {
		conflicts_found?: number;
		conflicts_resolved?: number;
		current_file?: string;
	};
}

// Merge log entry (for conflict resolution logging)
export type MergeLogEntryType = "info" | "success" | "warning" | "error";

export interface MergeLogEntry {
	timestamp: string;
	type: MergeLogEntryType;
	message: string;
	details?: string;
}

export interface WorktreeMergeResult {
	success: boolean;
	message: string;
	merged?: boolean;
	conflictFiles?: string[];
	staged?: boolean;
	alreadyStaged?: boolean;
	projectPath?: string;
	// AI-generated commit message suggestion (for stage-only mode)
	suggestedCommitMessage?: string;
	// New conflict info from smart merge
	conflicts?: MergeConflict[];
	stats?: MergeStats;
	gitConflicts?: GitConflictInfo; // Git-level conflict info
	// Preview mode results
	preview?: {
		files: string[];
		conflicts: MergeConflict[];
		summary: MergeStats;
		gitConflicts?: GitConflictInfo;
		// Uncommitted changes in the main project that could block merge
		uncommittedChanges?: {
			hasChanges: boolean;
			files: string[];
			count: number;
		} | null;
	};
}

export interface WorktreeDiscardResult {
	success: boolean;
	message: string;
}

export interface WorktreeSyncResult {
	success: boolean;
	message: string;
	hasConflicts?: boolean;
	conflictFiles?: string[];
}

/**
 * Options for creating a PR from a worktree
 */
export interface WorktreeCreatePROptions {
	targetBranch?: string;
	title?: string;
	draft?: boolean;
	/**
	 * If provided, used verbatim as the PR body (no AI generation, no impact
	 * block auto-injection). Caller is responsible for the full content,
	 * including any impact block at the end. Used by the review modal after
	 * the user has edited the auto-filled values.
	 */
	customBody?: string;
	/**
	 * Run automated app emulation and screenshot proof after the PR is created.
	 * Defaults to true.
	 */
	runVisualProof?: boolean;
}

/**
 * Result of creating a PR from a worktree
 */
export interface WorktreeCreatePRResult {
	success: boolean;
	prUrl?: string;
	error?: string;
	message?: string; // Human-readable message for both success and error cases
	alreadyExists?: boolean;
	visualProof?: VisualProofRun;
}

export type VisualProofStatus = "pending" | "passed" | "failed" | "skipped";

export type VisualProofTargetKind = "web" | "desktop" | "remote";

export type VisualProofProviderId =
	| "local-web"
	| "local-iis-express"
	| "local-windows-desktop"
	| "docker"
	| "wsl"
	| "hyper-v"
	| "remote-runner";

export interface VisualProofScreenshot {
	label: string;
	relativePath: string;
	absolutePath: string;
	url?: string;
	width: number;
	height: number;
	capturedAt: string;
}

/** One endpoint call performed during the API smoke proof. */
export interface ApiSmokeEndpointResult {
	method: string;
	path: string;
	/** HTTP status, absent when the request itself failed (network/timeout). */
	status?: number;
	ok: boolean;
	durationMs: number;
	error?: string;
}

/**
 * Result of the API smoke proof: when the emulated app exposes an
 * OpenAPI/Swagger document, parameterless GET endpoints are called and the
 * outcome is recorded alongside the visual screenshots.
 */
export interface VisualProofApiSmoke {
	specUrl: string;
	swaggerUiUrl?: string;
	attempted: number;
	passed: number;
	failed: number;
	results: ApiSmokeEndpointResult[];
	/** Markdown report file, relative to the artifact dir. */
	reportFileName: string;
}

export interface VisualProofRun {
	id: string;
	status: VisualProofStatus;
	taskId: string;
	specId: string;
	prUrl: string;
	framework?: string;
	provider?: VisualProofProviderId;
	targetKind?: VisualProofTargetKind;
	isolated?: boolean;
	providerDetails?: string;
	appUrl?: string;
	artifactDir?: string;
	commentUrl?: string;
	commitSha?: string;
	screenshots: VisualProofScreenshot[];
	/** API smoke proof, present when an OpenAPI document was discovered. */
	apiSmoke?: VisualProofApiSmoke;
	error?: string;
	startedAt: string;
	completedAt?: string;
}

export interface VisualProofRunOptions {
	taskId: string;
	projectPath: string;
	specId: string;
	prUrl: string;
	worktreePath?: string;
	autoBuildPath?: string;
	provider?: VisualProofProviderId | "auto";
}

/**
 * A single navigation/interaction step performed before capturing a screenshot.
 *
 * Web fields drive a headless BrowserWindow (route navigation + DOM actions),
 * desktop fields drive Windows UI Automation (invoke controls / set text by name)
 * on the running heavy client. Fields not relevant to the active target are
 * simply ignored, so the same plan shape works for both worlds.
 */
export interface VisualProofNavigationStep {
	/** Label used for the screenshot taken after this step. */
	label?: string;
	/** Web: route (relative to the app origin) or absolute URL to open. */
	path?: string;
	/** Web: CSS selector to wait for before continuing. */
	waitForSelector?: string;
	/** Web: CSS selector to click. */
	click?: string;
	/** Web: fill a form control. */
	fill?: { selector: string; value: string };
	/** Desktop: name of the UI Automation element to invoke (menu item/button). */
	invoke?: string;
	/** Desktop: set text into an edit control identified by name. */
	setText?: { name: string; value: string };
	/** Milliseconds to wait after the step so the UI can settle. */
	delayMs?: number;
	/** Capture a screenshot after this step (default true). */
	capture?: boolean;
}

/**
 * Navigation plan describing how to reach the implemented feature before taking
 * visual proof screenshots. Steps can be split per target or shared by both.
 */
export interface VisualProofNavigationPlan {
	web?: VisualProofNavigationStep[];
	desktop?: VisualProofNavigationStep[];
}

/**
 * Result of a preview impact analysis (no PR creation, no push).
 */
export interface WorktreeAnalyzeImpactResult {
	success: boolean;
	/** Full PR body markdown including the impact block at the end. */
	body?: string;
	/** Rating "1".."5" or "N/A" on failure. */
	rating?: string;
	/** French free-text feature list, or "Non evalue" on failure. */
	features?: string;
	error?: string;
}

/**
 * Pull Request file data structure
 */
export interface PRFileData {
	filename: string;
	status: "added" | "removed" | "modified" | "renamed";
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previous_filename?: string;
}

/**
 * Pull Request data structure with files
 */
export interface PRData {
	number: number;
	title: string;
	body: string;
	author: string;
	state: string;
	source_branch: string;
	target_branch: string;
	additions: number;
	deletions: number;
	changed_files: number;
	files: PRFileData[];
	diff: string;
	url: string;
	created_at: string;
	updated_at: string;
	labels: string[];
	reviewers: string[];
	is_draft: boolean;
	mergeable: boolean;
}

/**
 * Result of fetching PR details with files
 */
export interface PRDetailsResult {
	success: boolean;
	data?: PRData;
	error?: string;
}

/**
 * Information about a single spec worktree
 * Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
 */
export interface WorktreeListItem {
	specName: string;
	path: string;
	branch: string;
	baseBranch: string;
	commitCount?: number;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
	/** True if git commands failed on this worktree (corrupted/orphaned state) */
	isOrphaned?: boolean;
}

/**
 * Result of listing all spec worktrees
 */
export interface WorktreeListResult {
	worktrees: WorktreeListItem[];
}

// Stuck task recovery types
export interface StuckTaskInfo {
	taskId: string;
	specId: string;
	title: string;
	status: TaskStatus;
	isActuallyRunning: boolean;
	lastUpdated: Date;
}

export interface TaskRecoveryResult {
	taskId: string;
	recovered: boolean;
	newStatus: TaskStatus;
	message: string;
	autoRestarted?: boolean;
}

export interface TaskRecoveryOptions {
	targetStatus?: TaskStatus;
	autoRestart?: boolean;
}

export interface TaskProgressUpdate {
	taskId: string;
	plan: ImplementationPlan;
	currentSubtask?: string;
}

export interface TaskStartOptions {
	parallel?: boolean;
	workers?: number;
	model?: string;
	baseBranch?: string; // Override base branch for worktree creation
	enableStreaming?: boolean; // Enable streaming mode for live coding
	streamingSessionId?: string; // Session ID for streaming
	projectPath?: string; // Project path for streaming
}
