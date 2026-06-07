import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../shared/constants";
import {
	mapStateToLegacy,
	XSTATE_SETTLED_STATES,
	XSTATE_TO_PHASE,
} from "../../shared/state-machines";
import type {
	AuthFailureInfo,
	ImplementationPlan,
	SDKRateLimitInfo,
} from "../../shared/types";
import type { Project } from "../../shared/types/project";
import type { Task } from "../../shared/types/task";
import type {
	AgentManager,
	ExecutionProgressData,
	ProcessType,
} from "../agent";
import type { TaskEventPayload } from "../agent/task-event-schema";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { fileWatcher } from "../file-watcher";
import { notificationService } from "../notification-service";
import { taskStateManager } from "../task-state-manager";
import { titleGenerator } from "../title-generator";
import { findTaskWorktree } from "../worktree-paths";
import {
	getPlanPath,
	persistPlanLastEventSync,
	persistPlanPhaseSync,
	persistPlanStatusAndReasonSync,
} from "./task/plan-file-utils";
import { findTaskAndProject } from "./task/shared";
import { safeSendToRenderer } from "./utils";

/**
 * Validate that an implementation plan has proper structure with phases and subtasks
 * Returns true if valid, false if invalid
 */
function isValidImplementationPlan(plan: ImplementationPlan): boolean {
	if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
		return false;
	}

	return plan.phases.every(
		(phase) =>
			phase &&
			Array.isArray(phase.subtasks) &&
			phase.subtasks.length > 0 &&
			phase.subtasks.every(
				(subtask) =>
					subtask &&
					typeof subtask === "object" &&
					subtask.description &&
					typeof subtask.description === "string" &&
					subtask.description.trim() !== "",
			),
	);
}

/**
 * Log debug information about why a plan validation failed
 */
function logInvalidPlanDetails(
	_taskId: string,
	_plan: ImplementationPlan,
): void {
	// noop
}

/**
 * Re-stamp XState status fields on plan files if the backend overwrote them
 * This prevents tasks from snapping back to backlog on refresh
 */
function restampXStateStatusIfNeeded(
	taskId: string,
	plan: ImplementationPlan,
	hasValidPhases: boolean,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	task: any,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	project: any,
): void {
	const planWithStatus = plan as {
		xstateState?: string;
		executionPhase?: string;
		status?: string;
		phases?: unknown[];
	};
	const currentXState = taskStateManager.getCurrentState(taskId);

	if (
		currentXState &&
		!planWithStatus.xstateState &&
		hasValidPhases &&
		task &&
		project
	) {
		const mainPlanPath = getPlanPath(project, task);
		const { status, reviewReason } = mapStateToLegacy(currentXState);
		const phase = XSTATE_TO_PHASE[currentXState] || "idle";
		persistPlanStatusAndReasonSync(
			mainPlanPath,
			status,
			reviewReason,
			project.id,
			currentXState,
			phase,
		);

		// Also re-stamp worktree copy if it exists
		const worktreePath = findTaskWorktree(project.path, task.specId);
		if (worktreePath) {
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const worktreePlanPath = path.join(
				worktreePath,
				specsBaseDir,
				task.specId,
				AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
			);
			if (existsSync(worktreePlanPath)) {
				persistPlanStatusAndReasonSync(
					worktreePlanPath,
					status,
					reviewReason,
					project.id,
					currentXState,
					phase,
				);
			}
		}
	} else if (currentXState && !planWithStatus.xstateState && !hasValidPhases) {
		// noop
	}
}

/**
 * Log detailed information for CODING_FAILED events
 */
function logCodingFailedEvent(
	taskId: string,
	event: unknown,
	projectId?: string,
): void {
	console.error(
		`[agent-events-handlers] CODING_FAILED RECEIVED FROM BACKEND:`,
		{
			taskId,
			projectId,
			event,
			timestamp: new Date().toISOString(),
			stackTrace: new Error("CODING_FAILED event stack trace").stack,
		},
	);
}

/**
 * Initialize task sequence from plan file if not already set
 */
function initializeTaskSequenceIfNeeded(
	taskId: string,
	projectId?: string,
): void {
	if (taskStateManager.getLastSequence(taskId) !== undefined) {
		return; // Already initialized
	}

	const { task, project } = findTaskAndProject(taskId, projectId);
	if (!task || !project) {
		return;
	}

	try {
		const planPath = getPlanPath(project, task);
		const planContent = readFileSync(planPath, "utf-8");
		const plan = JSON.parse(planContent);
		const lastSeq = plan?.lastEvent?.sequence;
		if (typeof lastSeq === "number" && lastSeq >= 0) {
			taskStateManager.setLastSequence(taskId, lastSeq);
		}
	} catch {
		// Ignore missing/invalid plan files
	}
}

/**
 * Persist last event to both main and worktree plan files
 */
function persistLastEventToAllPlans(
	_taskId: string,
	event: TaskEventPayload,
	task: Task,
	project: Project,
): void {
	const mainPlanPath = getPlanPath(project, task);
	persistPlanLastEventSync(mainPlanPath, event);

	const worktreePath = findTaskWorktree(project.path, task.specId);
	if (worktreePath) {
		const specsBaseDir = getSpecsDir(project.autoBuildPath);
		const worktreePlanPath = path.join(
			worktreePath,
			specsBaseDir,
			task.specId,
			AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
		);
		if (existsSync(worktreePlanPath)) {
			persistPlanLastEventSync(worktreePlanPath, event);
		}
	}
}

/**
 * Register all agent-events-related IPC handlers
 */
export function registerAgenteventsHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	taskStateManager.configure(getMainWindow);

	// Track task IDs that have hit rate limits to prevent them from being
	// incorrectly moved to human_review when the process exits non-zero.
	// When a rate limit is detected, the sdk-rate-limit event fires before exit.
	// We use this set to suppress handleProcessExited for rate-limited tasks.
	const rateLimitedTaskIds = new Set<string>();

	// ============================================
	// Agent Manager Events → Renderer
	// ============================================

	agentManager.on("log", (taskId: string, log: string, projectId?: string) => {
		// Use projectId from event when available; fall back to lookup for backward compatibility
		if (!projectId) {
			const { project } = findTaskAndProject(taskId);
			projectId = project?.id;
		}
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.TASK_LOG,
			taskId,
			log,
			projectId,
		);
	});

	agentManager.on(
		"error",
		(taskId: string, error: string, projectId?: string) => {
			// Use projectId from event when available; fall back to lookup for backward compatibility
			if (!projectId) {
				const { project } = findTaskAndProject(taskId);
				projectId = project?.id;
			}
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.TASK_ERROR,
				taskId,
				error,
				projectId,
			);
		},
	);

	// Handle SDK rate limit events from agent manager
	agentManager.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
		// Track this task as rate-limited to prevent it from being moved to human_review
		// when the process exits with a non-zero code
		if (rateLimitInfo.taskId) {
			rateLimitedTaskIds.add(rateLimitInfo.taskId);
		}
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT,
			rateLimitInfo,
		);
	});

	// Handle SDK rate limit events from title generator
	titleGenerator.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT,
			rateLimitInfo,
		);
	});

	// Handle auth failure events (401 errors requiring re-authentication)
	agentManager.on(
		"auth-failure",
		(
			taskId: string,
			authFailure: {
				profileId?: string;
				failureType?: "missing" | "invalid" | "expired" | "unknown";
				message?: string;
				originalError?: string;
			},
		) => {
			console.warn(
				`[AgentEvents] Auth failure detected for task ${taskId}:`,
				authFailure,
			);

			// Get profile name for display
			const profileManager = getClaudeProfileManager();
			const profile = authFailure.profileId
				? profileManager.getProfile(authFailure.profileId)
				: profileManager.getActiveProfile();

			const authFailureInfo: AuthFailureInfo = {
				profileId: authFailure.profileId || profile?.id || "unknown",
				profileName: profile?.name,
				failureType: authFailure.failureType || "unknown",
				message:
					authFailure.message ||
					"Authentication failed. Please re-authenticate.",
				originalError: authFailure.originalError,
				taskId,
				detectedAt: new Date(),
			};

			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.CLAUDE_AUTH_FAILURE,
				authFailureInfo,
			);
		},
	);

	agentManager.on(
		"exit",
		(
			taskId: string,
			code: number | null,
			processType: ProcessType,
			projectId?: string,
		) => {
			// Use projectId from event to scope the lookup (prevents cross-project contamination)
			const { task: exitTask, project: exitProject } = findTaskAndProject(
				taskId,
				projectId,
			);
			const exitProjectId = exitProject?.id || projectId;

			// Skip handleProcessExited for rate-limited tasks.
			// The sdk-rate-limit event fires before exit for rate-limited processes.
			// Without this guard, handleProcessExited sends PROCESS_EXITED { unexpected: true }
			// which transitions the task to error → human_review, incorrectly moving the card
			// to the Human Review column even though the task is just paused waiting for rate limit reset.
			const isRateLimited = rateLimitedTaskIds.has(taskId);
			if (!isRateLimited) {
				taskStateManager.handleProcessExited(taskId, code, exitTask, exitProject);
			} else {
				rateLimitedTaskIds.delete(taskId);
			}

			// Send final plan state to renderer BEFORE unwatching
			// This ensures the renderer has the final subtask data (fixes 0/0 subtask bug)
			const finalPlan = fileWatcher.getCurrentPlan(taskId);
			if (finalPlan) {
				safeSendToRenderer(
					getMainWindow,
					IPC_CHANNELS.TASK_PROGRESS,
					taskId,
					finalPlan,
					exitProjectId,
				);
			}

			fileWatcher.unwatch(taskId);

			if (processType === "spec-creation") {
				console.warn(
					`[Task ${taskId}] Spec creation completed with code ${code}`,
				);
				return;
			}

			const { task, project } = findTaskAndProject(taskId, projectId);
			if (!task || !project) return;

			const taskTitle = task.title || task.specId;
			if (code === 0) {
				notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);
			} else {
				notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
			}
		},
	);

	agentManager.on("task-event", (taskId: string, event, projectId?: string) => {
		// Forward decision log entries directly to renderer without going through XState (Feature 30)
		if (event.type === "DECISION_LOG_ENTRY") {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.AGENT_DECISION_LOG_ENTRY,
				taskId,
				event.entry,
				projectId,
			);
			return; // Skip XState processing — decision entries are not state transitions
		}

		// Log detailed information for CODING_FAILED events
		if (event.type === "CODING_FAILED") {
			logCodingFailedEvent(taskId, event, projectId);
		}

		// Initialize task sequence if needed
		initializeTaskSequenceIfNeeded(taskId, projectId);

		const { task, project } = findTaskAndProject(taskId, projectId);
		if (!task || !project) {
			return;
		}

		const accepted = taskStateManager.handleTaskEvent(
			taskId,
			event,
			task,
			project,
		);

		if (!accepted) {
			return;
		}

		// Persist last event to both main and worktree plan files
		persistLastEventToAllPlans(taskId, event, task, project);
	});

	agentManager.on(
		"execution-progress",
		(taskId: string, progress: ExecutionProgressData, projectId?: string) => {
			// Use projectId from event to scope the lookup (prevents cross-project contamination)
			const { task, project } = findTaskAndProject(taskId, projectId);
			const taskProjectId = project?.id || projectId;

			// Check if XState has already established a terminal/review state for this task.
			// XState is the source of truth for status. When XState is in a terminal state
			// (e.g., plan_review after PLANNING_COMPLETE), execution-progress events from the
			// agent process are stale and must not overwrite XState's persisted status.
			//
			// Example: When requireReviewBeforeCoding=true, the process exits with code 1 after
			// PLANNING_COMPLETE. The exit handler emits execution-progress with phase='failed',
			// which would incorrectly overwrite status='human_review' with status='error' via
			// persistPlanPhaseSync, and send a 'failed' phase to the renderer overwriting the
			// 'planning' phase that XState already emitted via emitPhaseFromState.
			const currentXState = taskStateManager.getCurrentState(taskId);
			const xstateInTerminalState =
				currentXState && XSTATE_SETTLED_STATES.has(currentXState);

			// Persist phase to plan file for restoration on app refresh
			// Must persist to BOTH main project and worktree (if exists) since task may be loaded from either
			//
			// GUARD: Only persist phase to files that ALREADY exist. During the spec creation
			// pipeline, the backend's planning phase deletes stub plan files before running the
			// planner agent. If we recreate the file here (via persistPlanPhaseSync's
			// create-if-missing behavior), the planner validator would find an empty stub
			// instead of the real plan the agent is supposed to create.
			if (task && project && progress.phase && !xstateInTerminalState) {
				const mainPlanPath = getPlanPath(project, task);
				if (existsSync(mainPlanPath)) {
					persistPlanPhaseSync(mainPlanPath, progress.phase, project.id);
				} else {
					// noop
				}

				// Also persist to worktree if task has one
				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (worktreePath) {
					const specsBaseDir = getSpecsDir(project.autoBuildPath);
					const worktreePlanPath = path.join(
						worktreePath,
						specsBaseDir,
						task.specId,
						AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
					);
					if (existsSync(worktreePlanPath)) {
						persistPlanPhaseSync(worktreePlanPath, progress.phase, project.id);
					}
				}
			} else if (xstateInTerminalState && progress.phase) {
				// noop
			}

			// Skip sending execution-progress to renderer when XState has settled.
			// XState's emitPhaseFromState already sent the correct phase to the renderer.
			if (xstateInTerminalState) {
				return;
			}
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
				taskId,
				progress,
				taskProjectId,
			);
		},
	);

	// ============================================
	// File Watcher Events → Renderer
	// ============================================

	fileWatcher.on("progress", (taskId: string, plan: ImplementationPlan) => {
		// File watcher events don't carry projectId — fall back to lookup
		const { task, project } = findTaskAndProject(taskId);

		// Validate plan data before sending to frontend to prevent validation errors
		const hasValidPhases = isValidImplementationPlan(plan);

		if (hasValidPhases) {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.TASK_PROGRESS,
				taskId,
				plan,
				project?.id,
			);
		} else {
			logInvalidPlanDetails(taskId, plan);
		}

		// Re-stamp XState status fields if the backend overwrote the plan file without them
		if (task && project) {
			restampXStateStatusIfNeeded(taskId, plan, hasValidPhases, task, project);
		}
	});

	fileWatcher.on("error", (taskId: string, error: string) => {
		// File watcher events don't carry projectId — fall back to lookup
		const { project } = findTaskAndProject(taskId);
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.TASK_ERROR,
			taskId,
			error,
			project?.id,
		);
	});
}
