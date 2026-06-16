import type { TFunction } from "i18next";
import {
	AlertTriangle,
	Archive,
	Bug,
	CheckCircle2,
	Clock,
	Copy,
	FileCode,
	FileText,
	FlaskConical,
	Gauge,
	GitMerge,
	GitPullRequest,
	Loader2,
	Monitor,
	MoreVertical,
	Palette,
	Pause,
	Play,
	RotateCcw,
	Shield,
	Square,
	Target,
	Wrench,
	X,
	XCircle,
	type Zap,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatRelativeTime } from "@/hooks/useFormatRelativeTime";
import AzureDevOpsLogo from "../assets/logos/azure-devops.svg";
import JiraLogo from "../assets/logos/jira.svg";
import {
	EXECUTION_PHASE_BADGE_COLORS,
	EXECUTION_PHASE_LABELS,
	isExecutionPhaseActive,
	JSON_ERROR_PREFIX,
	JSON_ERROR_TITLE_SUFFIX,
	TASK_CATEGORY_COLORS,
	TASK_CATEGORY_LABELS,
	TASK_COMPLEXITY_COLORS,
	TASK_COMPLEXITY_LABELS,
	TASK_IMPACT_COLORS,
	TASK_IMPACT_LABELS,
	TASK_PRIORITY_COLORS,
	TASK_PRIORITY_LABELS,
	TASK_STATUS_COLUMNS,
	TASK_STATUS_LABELS,
} from "../../shared/constants";
import type {
	ReviewReason,
	Task,
	TaskCategory,
	TaskStatus,
} from "../../shared/types";
import { setPendingTaskDetailTab } from "../lib/task-detail-nav";
import { cn, extractTextFromHtml, sanitizeMarkdownForDisplay } from "../lib/utils";
import { useProjectStore } from "../stores/project-store";
import {
	archiveTasks,
	checkTaskRunning,
	hasRecentActivity,
	isIncompleteHumanReview,
	pauseTask,
	recoverStuckTask,
	resumeTask,
	startTask,
	stopTask,
	useTaskStore,
} from "../stores/task-store";
import { PhaseProgressIndicator } from "./PhaseProgressIndicator";
import { SessionCompactionBadge } from "./SessionCompactionBadge";
import { StreamingSessionButton } from "./streaming/StreamingSessionButton";
import { SyncFromBranchDialog } from "./task-detail/task-review/SyncFromBranchDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { FormulaBadge } from "./formula-lab/FormulaBadge";
import { Checkbox } from "./ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Zap> = {
	feature: Target,
	bug_fix: Bug,
	refactoring: Wrench,
	documentation: FileCode,
	security: Shield,
	performance: Gauge,
	ui_ux: Palette,
	infrastructure: Wrench,
	testing: FileCode,
};

// Catastrophic stuck detection interval (ms).
// XState handles all normal process-exit transitions via PROCESS_EXITED events.
// This is a last-resort safety net: if XState somehow fails to transition the task
// out of in_progress after the process dies, flag it as stuck after 60 seconds.
const STUCK_CHECK_INTERVAL_MS = 60_000;

interface TaskCardProps {
	task: Task;
	onClick: () => void;
	onStatusChange?: (newStatus: TaskStatus) => unknown;
	// Optional selectable mode props for multi-selection
	isSelectable?: boolean;
	isSelected?: boolean;
	onToggleSelect?: () => void;
	// Optional delete handler
	onDelete?: () => void;
	// Optional duplicate handler (clone the task into a fresh backlog ticket)
	onDuplicate?: () => void;
	// Optional PR files viewer handler
	onViewPRFiles?: (prUrl: string, taskId: string) => void;
	// Optional app preview handler for done, human_review, and ai_review tasks
	onPreviewApp?: () => void;
}

/**
 * Live Azure DevOps pipeline badge for the kanban card.
 * Reads the latest build pushed by the main-process poller; clicking the
 * badge opens the build in the browser. When the build is red, a small
 * repair action lets the user (re)launch the agent fix loop manually.
 */
const PipelineBadge: React.FC<{ task: Task; t: TFunction }> = ({ task, t }) => {
	const pipeline = useTaskStore((s) => s.pipelineStatuses[task.id]);
	const [isFixing, setIsFixing] = useState(false);

	if (!pipeline || pipeline.state === "none") return null;

	const openBuild = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (pipeline.webUrl) {
			// biome-ignore lint/suspicious/noExplicitAny: electronAPI shape is dynamic
			(globalThis as any).electronAPI?.openExternal?.(pipeline.webUrl);
		}
	};

	const handleFix = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsFixing(true);
		try {
			await globalThis.electronAPI.fixRedBuild(task.id);
		} finally {
			setIsFixing(false);
		}
	};

	const label = pipeline.buildNumber ?? pipeline.definitionName ?? "CI";
	let icon: React.ReactNode;
	let badgeClass: string;
	switch (pipeline.state) {
		case "succeeded":
			icon = <CheckCircle2 className="h-2.5 w-2.5" />;
			badgeClass = "bg-success/10 text-success border-success/30";
			break;
		case "failed":
			icon = <XCircle className="h-2.5 w-2.5" />;
			badgeClass = "bg-destructive/10 text-destructive border-destructive/30";
			break;
		case "partiallySucceeded":
			icon = <AlertTriangle className="h-2.5 w-2.5" />;
			badgeClass = "bg-warning/10 text-warning border-warning/30";
			break;
		case "canceled":
			icon = <XCircle className="h-2.5 w-2.5" />;
			badgeClass = "bg-muted text-muted-foreground border-border";
			break;
		default: // queued | running
			icon = <Loader2 className="h-2.5 w-2.5 animate-spin" />;
			badgeClass = "bg-info/10 text-info border-info/30";
			break;
	}

	return (
		<div className="mt-2 flex flex-wrap items-center gap-1">
			<Badge
				variant="outline"
				className={cn(
					"text-[10px] px-1.5 py-0.5 flex items-center gap-1",
					pipeline.webUrl && "cursor-pointer hover:opacity-80",
					badgeClass,
				)}
				onClick={openBuild}
				title={`${pipeline.providerLabel ?? t("labels.pipeline")} — ${pipeline.definitionName ?? ""} ${label}`}
			>
				{icon}
				{t("labels.pipeline")} {label}
			</Badge>
			{pipeline.state === "failed" && (
				<Button
					size="sm"
					variant="outline"
					className="h-5 px-1.5 text-[10px] text-destructive border-destructive/30 hover:bg-destructive/10"
					onClick={handleFix}
					disabled={isFixing || pipeline.autoFixInProgress}
				>
					{isFixing || pipeline.autoFixInProgress ? (
						<Loader2 className="h-2.5 w-2.5 animate-spin mr-1" />
					) : (
						<Wrench className="h-2.5 w-2.5 mr-1" />
					)}
					{t("labels.repairBuild")}
				</Button>
			)}
		</div>
	);
};

/**
 * Tracker reference badge — shows the originating work-item number for tasks
 * imported from Azure DevOps or Jira (the "US number" the user asked for).
 * Clicking the badge opens the work item in the external tracker.
 */
const TrackerBadge: React.FC<{ task: Task; t: TFunction }> = ({ task, t }) => {
	const m = task.metadata;

	let logo: string;
	let alt: string;
	let identifier: string;
	let url: string | undefined;

	if (m?.azureDevOpsIdentifier) {
		logo = AzureDevOpsLogo;
		alt = "Azure DevOps";
		// Azure work-item ids are bare numbers — prefix with # for readability.
		identifier = `#${m.azureDevOpsIdentifier}`;
		url = m.azureDevOpsUrl;
	} else if (m?.jiraIdentifier) {
		logo = JiraLogo;
		alt = "Jira";
		// Jira keys already read like "PROJ-123".
		identifier = m.jiraIdentifier;
		url = m.jiraUrl;
	} else {
		return null;
	}

	const open = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (url) {
			// biome-ignore lint/suspicious/noExplicitAny: electronAPI shape is dynamic
			(globalThis as any).electronAPI?.openExternal?.(url);
		}
	};

	return (
		<Badge
			variant="outline"
			className={cn(
				"text-[10px] px-1.5 py-0.5 flex w-fit items-center gap-1 bg-muted/40 text-muted-foreground border-border font-mono",
				url && "cursor-pointer hover:bg-muted hover:text-foreground",
			)}
			onClick={url ? open : undefined}
			title={t("labels.openInTracker", { tracker: alt })}
		>
			<img src={logo} alt={alt} className="h-3 w-3" />
			{identifier}
		</Badge>
	);
};

// Metadata badges component - extracted to reduce complexity
interface MetadataBadgesProps {
	task: Task;
	isStuck: boolean;
	isIncomplete: boolean;
	hasActiveExecution?: boolean;
	executionPhase?: string;
	reviewReasonInfo: {
		label: string;
		variant: "success" | "destructive" | "warning";
	} | null;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	t: any;
}

const MetadataBadges: React.FC<MetadataBadgesProps> = ({
	task,
	isStuck,
	isIncomplete,
	hasActiveExecution,
	executionPhase,
	reviewReasonInfo,
	t,
}) => {
	// Extract status badge variant and label for non-done tasks
	let statusBadgeVariant:
		| "default"
		| "destructive"
		| "outline"
		| "secondary"
		| "success"
		| "warning"
		| "info"
		| "purple"
		| "muted";
	let statusBadgeLabel: string;

	if (isStuck) {
		statusBadgeVariant = "warning";
		statusBadgeLabel = t("labels.needsRecovery");
	} else if (isIncomplete) {
		statusBadgeVariant = "warning";
		statusBadgeLabel = t("labels.needsResume");
	} else {
		statusBadgeVariant = getStatusBadgeVariant(task.status);
		statusBadgeLabel = getStatusLabel(task.status, t);
	}

	if (
		!task.metadata &&
		!isStuck &&
		!isIncomplete &&
		!hasActiveExecution &&
		!reviewReasonInfo
	) {
		return null;
	}

	return (
		<div className="mt-2 flex flex-wrap gap-1">
			{/* Stuck indicator - highest priority */}
			{isStuck && (
				<Badge
					variant="outline"
					className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-warning/10 text-warning border-warning/30 badge-priority-urgent"
				>
					<AlertTriangle className="h-2.5 w-2.5" />
					{t("labels.stuck")}
				</Badge>
			)}

			{/* Incomplete indicator - task in human_review but no subtasks completed */}
			{isIncomplete && !isStuck && (
				<Badge
					variant="outline"
					className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-orange-500/10 text-orange-400 border-orange-500/30"
				>
					<AlertTriangle className="h-2.5 w-2.5" />
					{t("labels.incomplete")}
				</Badge>
			)}

			{/* Archived indicator - task has been released */}
			{task.metadata?.archivedAt && (
				<Badge
					variant="outline"
					className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-muted text-muted-foreground border-border"
				>
					<Archive className="h-2.5 w-2.5" />
					{t("status.archived")}
				</Badge>
			)}

			{/* Execution phase badge - shown when actively running */}
			{hasActiveExecution && executionPhase && !isStuck && !isIncomplete && (
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0.5 flex items-center gap-1",
						EXECUTION_PHASE_BADGE_COLORS[executionPhase],
					)}
				>
					<Loader2 className="h-2.5 w-2.5 animate-spin" />
					{EXECUTION_PHASE_LABELS[executionPhase]}
				</Badge>
			)}

			{/* Status badge - hide when execution phase badge is showing */}
			{!hasActiveExecution &&
				(task.status === "done" ? (
					<Badge
						variant={getStatusBadgeVariant(task.status)}
						className="text-[10px] px-1.5 py-0.5"
					>
						{getStatusLabel(task.status, t)}
					</Badge>
				) : (
					<Badge
						variant={statusBadgeVariant}
						className="text-[10px] px-1.5 py-0.5"
					>
						{statusBadgeLabel}
					</Badge>
				))}

			{/* Review reason badge - explains why task needs human review */}
			{reviewReasonInfo && !isStuck && !isIncomplete && (
				<Badge
					variant={reviewReasonInfo.variant}
					className="text-[10px] px-1.5 py-0.5"
				>
					{reviewReasonInfo.label}
				</Badge>
			)}

			{/* TDD override badge - task-level strict TDD enabled */}
			{task.metadata?.tddMode && (
				<Badge
					variant="outline"
					className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
				>
					<FlaskConical className="h-2.5 w-2.5" />
					{t("labels.tdd")}
				</Badge>
			)}

			{/* Category badge with icon */}
			{task.metadata?.category && (
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0",
						TASK_CATEGORY_COLORS[task.metadata.category],
					)}
				>
					{CategoryIcon[task.metadata.category] &&
						(() => {
							const Icon = CategoryIcon[task.metadata.category];
							return <Icon className="h-2.5 w-2.5 mr-0.5" />;
						})()}
					{TASK_CATEGORY_LABELS[task.metadata.category]}
				</Badge>
			)}

			{/* Impact badge - high visibility for important tasks */}
			{task.metadata?.impact &&
				(task.metadata.impact === "high" ||
					task.metadata.impact === "critical") && (
					<Badge
						variant="outline"
						className={cn(
							"text-[10px] px-1.5 py-0",
							TASK_IMPACT_COLORS[task.metadata.impact],
						)}
					>
						{TASK_IMPACT_LABELS[task.metadata.impact]}
					</Badge>
				)}

			{/* Complexity badge */}
			{task.metadata?.complexity && (
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0",
						TASK_COMPLEXITY_COLORS[task.metadata.complexity],
					)}
				>
					{TASK_COMPLEXITY_LABELS[task.metadata.complexity]}
				</Badge>
			)}

			{/* Priority badge - only show urgent/high */}
			{task.metadata?.priority &&
				(task.metadata.priority === "urgent" ||
					task.metadata.priority === "high") && (
					<Badge
						variant="outline"
						className={cn(
							"text-[10px] px-1.5 py-0",
							TASK_PRIORITY_COLORS[task.metadata.priority],
						)}
					>
						{TASK_PRIORITY_LABELS[task.metadata.priority]}
					</Badge>
				)}

			{/* Security severity - always show */}
			{task.metadata?.securitySeverity && (
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0",
						TASK_IMPACT_COLORS[task.metadata.securitySeverity],
					)}
				>
					{task.metadata.securitySeverity} {t("metadata.severity")}
				</Badge>
			)}
		</div>
	);
};

// Action buttons component - extracted to reduce complexity
interface ActionButtonsProps {
	isStuck: boolean;
	isRecovering: boolean;
	isIncomplete: boolean;
	isRunning: boolean;
	task: Task;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	currentProject?: any;
	onViewPRFiles?: (prUrl: string, taskId: string) => void;
	onPreviewApp?: () => void;
	handleRecover: (e: React.MouseEvent) => void;
	handleStartStop: (e: React.MouseEvent) => void;
	handlePause: (e: React.MouseEvent) => void;
	handleResume: (e: React.MouseEvent) => void;
	handleViewPR: (e: React.MouseEvent) => void;
	handleArchive: (e: React.MouseEvent) => void;
	statusMenuItems: React.ReactNode;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	t: any;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
	isStuck,
	isRecovering,
	isIncomplete,
	isRunning,
	task,
	currentProject,
	onViewPRFiles,
	onPreviewApp,
	handleRecover,
	handleStartStop,
	handlePause,
	handleResume,
	handleViewPR,
	handleArchive,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	statusMenuItems,
	t,
}) => {
	// A cooperatively-paused task (flag on disk) shows Reprendre instead of Pause.
	const isPaused = task.metadata?.paused?.enabled === true;
	// Compact Pause / Reprendre toggle reused by the active-task branches below.
	const pauseResumeButton = (
		<Button
			variant="outline"
			size="sm"
			className="h-7 w-7 p-0"
			onClick={isPaused ? handleResume : handlePause}
			title={isPaused ? t("actions.resume") : t("actions.pause")}
			aria-label={isPaused ? t("actions.resume") : t("actions.pause")}
		>
			{isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
		</Button>
	);

	if (isStuck) {
		return (
			<Button
				variant="warning"
				size="sm"
				className="h-7 px-2.5"
				onClick={handleRecover}
				disabled={isRecovering}
			>
				{isRecovering ? (
					<>
						<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
						{t("labels.recovering")}
					</>
				) : (
					<>
						<RotateCcw className="mr-1.5 h-3 w-3" />
						{t("actions.recover")}
					</>
				)}
			</Button>
		);
	}

	if (isIncomplete) {
		return (
			<Button
				variant="default"
				size="sm"
				className="h-7 px-2.5"
				onClick={handleStartStop}
			>
				<Play className="mr-1.5 h-3 w-3" />
				{t("actions.resume")}
			</Button>
		);
	}

	if (task.status === "done" && task.metadata?.prUrl) {
		return (
			<div className="flex gap-1">
				{onPreviewApp && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={(e) => {
							e.stopPropagation();
							onPreviewApp();
						}}
						title={t("tooltips.previewApp")}
					>
						<Monitor className="h-3 w-3" />
					</Button>
				)}
				{task.metadata?.prUrl && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={handleViewPR}
						title={t("tooltips.viewPR")}
					>
						<GitPullRequest className="h-3 w-3" />
					</Button>
				)}
				{task.metadata?.prUrl && onViewPRFiles && (
					<Button
						variant="outline"
						size="sm"
						className="h-7 px-2 hover:bg-primary/10 transition-colors"
						onClick={() =>
							task.metadata?.prUrl &&
							onViewPRFiles(task.metadata.prUrl, task.id)
						}
						title={t("tooltips.viewPRFiles")}
					>
						<FileText className="h-3 w-3 mr-1" />
						{t("tasks:prFiles.short")}
					</Button>
				)}
				{!task.metadata?.archivedAt && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={handleArchive}
						title={t("tooltips.archiveTask")}
					>
						<Archive className="h-3 w-3" />
					</Button>
				)}
			</div>
		);
	}

	if (task.status === "done" && !task.metadata?.archivedAt) {
		return (
			<div className="flex gap-1">
				{onPreviewApp && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={(e) => {
							e.stopPropagation();
							onPreviewApp();
						}}
						title={t("tooltips.previewApp")}
					>
						<Monitor className="h-3 w-3" />
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2.5 hover:bg-muted-foreground/10"
					onClick={handleArchive}
					title={t("tooltips.archiveTask")}
				>
					<Archive className="mr-1.5 h-3 w-3" />
					{t("actions.archive")}
				</Button>
			</div>
		);
	}

	// Preview button for human_review tasks (validate rendering before PR approval)
	if (task.status === "human_review") {
		return (
			<div className="flex gap-1">
				{onPreviewApp && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={(e) => {
							e.stopPropagation();
							onPreviewApp();
						}}
						title={t("tooltips.previewApp")}
					>
						<Monitor className="h-3 w-3" />
					</Button>
				)}
			</div>
		);
	}

	// ai_review tasks: QA is actively running, so offer Pause / Reprendre /
	// Arrêter (and the preview button) right on the card — the user can pause the
	// AI review at any moment without opening the modal.
	if (task.status === "ai_review") {
		return (
			<div className="flex gap-1">
				{onPreviewApp && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 cursor-pointer"
						onClick={(e) => {
							e.stopPropagation();
							onPreviewApp();
						}}
						title={t("tooltips.previewApp")}
					>
						<Monitor className="h-3 w-3" />
					</Button>
				)}
				{pauseResumeButton}
				<Button
					variant="destructive"
					size="sm"
					className="h-7 px-2.5"
					onClick={handleStartStop}
				>
					<Square className="mr-1.5 h-3 w-3" />
					{t("actions.stop")}
				</Button>
			</div>
		);
	}

	if (
		task.status === "backlog" ||
		task.status === "queue" ||
		task.status === "in_progress"
	) {
		return (
			<>
				{isRunning && !isStuck && currentProject?.path && (
					<StreamingSessionButton
						taskId={task.id}
						projectPath={currentProject.path}
						compact
					/>
				)}
				{/* Pause / Reprendre — only meaningful while the task is running. */}
				{(isRunning || isPaused) && pauseResumeButton}
				{isRunning ? (
					// While running, the footer already carries Watch-live + Pause, so
					// keep Stop icon-only — the whole row then fits on a single line and
					// the in-progress card stays as compact as the other columns.
					<Button
						variant="destructive"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={handleStartStop}
						title={t("actions.stop")}
						aria-label={t("actions.stop")}
					>
						<Square className="h-3 w-3" />
					</Button>
				) : (
					<Button
						variant="default"
						size="sm"
						className="h-7 px-2.5"
						onClick={handleStartStop}
					>
						<Play className="mr-1.5 h-3 w-3" />
						{t("actions.start")}
					</Button>
				)}
			</>
		);
	}

	return null;
};

// Utility functions - moved outside component to reduce complexity
const getStatusBadgeVariant = (
	status: string,
):
	| "default"
	| "destructive"
	| "outline"
	| "secondary"
	| "success"
	| "warning"
	| "info"
	| "purple"
	| "muted" => {
	switch (status) {
		case "in_progress":
			return "info";
		case "ai_review":
			return "warning";
		case "human_review":
			return "purple";
		case "build_failed":
			return "destructive";
		case "done":
			return "success";
		default:
			return "secondary";
	}
};

const getReviewReasonLabel = (
	reason?: ReviewReason,
	t?: TFunction,
): { label: string; variant: "success" | "destructive" | "warning" } | null => {
	if (!reason || !t) return null;
	switch (reason) {
		case "completed":
			return { label: t("reviewReason.completed"), variant: "success" };
		case "errors":
			return { label: t("reviewReason.hasErrors"), variant: "destructive" };
		case "qa_rejected":
			return { label: t("reviewReason.qaIssues"), variant: "warning" };
		case "plan_review":
			return { label: t("reviewReason.approvePlan"), variant: "warning" };
		case "stopped":
			return { label: t("reviewReason.stopped"), variant: "warning" };
		default:
			return null;
	}
};

// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
const getStatusLabel = (status: string, t?: any): string => {
	if (!t) return status;
	switch (status) {
		case "in_progress":
			return t("labels.running");
		case "ai_review":
			return t("labels.aiReview");
		case "human_review":
			return t("labels.needsReview");
		case "build_failed":
			return t("labels.buildFailed");
		case "done":
			return t("status.complete");
		default:
			return t("labels.pending");
	}
};

const isDeleteAreaClick = (e: React.MouseEvent, rect: DOMRect): boolean => {
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	const deleteArea = { x: rect.width - 32, y: 0, width: 32, height: 32 };
	return (
		x >= deleteArea.x &&
		x <= deleteArea.x + deleteArea.width &&
		y >= deleteArea.y &&
		y <= deleteArea.y + deleteArea.height
	);
};

const isDeleteAreaMouseDown = (e: React.MouseEvent, rect: DOMRect): boolean => {
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	const deleteArea = { x: rect.width - 50, y: 0, width: 50, height: 40 };
	return (
		x >= deleteArea.x &&
		x <= deleteArea.x + deleteArea.width &&
		y >= deleteArea.y &&
		y <= deleteArea.y + deleteArea.height
	);
};

// Custom comparator for React.memo - only re-render when relevant task data changes
function taskCardPropsAreEqual(
	prevProps: TaskCardProps,
	nextProps: TaskCardProps,
): boolean {
	const prevTask = prevProps.task;
	const nextTask = nextProps.task;

	// Fast path: same reference (include selectable props)
	if (
		prevTask === nextTask &&
		prevProps.onClick === nextProps.onClick &&
		prevProps.onStatusChange === nextProps.onStatusChange &&
		prevProps.isSelectable === nextProps.isSelectable &&
		prevProps.isSelected === nextProps.isSelected &&
		prevProps.onToggleSelect === nextProps.onToggleSelect &&
		prevProps.onViewPRFiles === nextProps.onViewPRFiles &&
		prevProps.onDelete === nextProps.onDelete &&
		prevProps.onDuplicate === nextProps.onDuplicate &&
		prevProps.onPreviewApp === nextProps.onPreviewApp
	) {
		return true;
	}

	// Check selectable props first (cheap comparison)
	if (
		prevProps.isSelectable !== nextProps.isSelectable ||
		prevProps.isSelected !== nextProps.isSelected
	) {
		return false;
	}

	// Compare only the fields that affect rendering
	const isEqual =
		prevTask.id === nextTask.id &&
		prevTask.status === nextTask.status &&
		prevTask.title === nextTask.title &&
		prevTask.description === nextTask.description &&
		prevTask.updatedAt === nextTask.updatedAt &&
		prevTask.reviewReason === nextTask.reviewReason &&
		prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
		prevTask.executionProgress?.phaseProgress ===
			nextTask.executionProgress?.phaseProgress &&
		prevTask.executionProgress?.overallProgress ===
			nextTask.executionProgress?.overallProgress &&
		prevTask.subtasks.length === nextTask.subtasks.length &&
		prevTask.metadata?.category === nextTask.metadata?.category &&
		prevTask.metadata?.complexity === nextTask.metadata?.complexity &&
		prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
		prevTask.metadata?.prUrl === nextTask.metadata?.prUrl &&
		// Check if any subtask statuses changed (compare all subtasks)
		prevTask.subtasks.every(
			(s, i) => s.status === nextTask.subtasks[i]?.status,
		);

	// Only log when actually re-rendering (reduces noise significantly)
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	if ((globalThis as any).DEBUG && !isEqual) {
		const changes: string[] = [];
		if (prevTask.status !== nextTask.status)
			changes.push(`status: ${prevTask.status} -> ${nextTask.status}`);
		if (
			prevTask.executionProgress?.phase !== nextTask.executionProgress?.phase
		) {
			changes.push(
				`phase: ${prevTask.executionProgress?.phase} -> ${nextTask.executionProgress?.phase}`,
			);
		}
		if (prevTask.subtasks.length !== nextTask.subtasks.length) {
			changes.push(
				`subtasks: ${prevTask.subtasks.length} -> ${nextTask.subtasks.length}`,
			);
		}

		if (changes.length > 0) {
			/* intentionally empty */
		}
	}

	return isEqual;
}

export const TaskCard = memo(function TaskCard({
	task,
	onClick,
	onStatusChange,
	isSelectable,
	isSelected,
	onToggleSelect,
	onDelete,
	onDuplicate,
	onViewPRFiles,
	onPreviewApp,
}: TaskCardProps) {
	const { t } = useTranslation(["tasks", "errors"]);
	const formatRelativeTime = useFormatRelativeTime();
	const [isStuck, setIsStuck] = useState(false);
	const [isRecovering, setIsRecovering] = useState(false);
	const [showSyncDialog, setShowSyncDialog] = useState(false);
	const stuckIntervalRef = useRef<NodeJS.Timeout | null>(null);
	const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);

	// ── Spotlight (jump-to from Pixel Office) ─────────────────
	const [isSpotlit, setIsSpotlit] = useState(false);
	const jumpToTaskId = useTaskStore((s) => s.jumpToTaskId);
	const clearJump = useTaskStore((s) => s.clearJump);

	useEffect(() => {
		if (jumpToTaskId !== task.id) return;
		// Small delay so the Kanban view has time to mount before scrolling
		const scrollTimer = setTimeout(() => {
			cardRef.current?.scrollIntoView({
				behavior: "smooth",
				block: "center",
				inline: "nearest",
			});
			setIsSpotlit(true);
			clearJump();
		}, 120);
		const clearTimer = setTimeout(() => setIsSpotlit(false), 120 + 2200); // 3 × 0.7s animation
		return () => {
			clearTimeout(scrollTimer);
			clearTimeout(clearTimer);
		};
	}, [jumpToTaskId, task.id, clearJump]);

	// Get project details from store to access projectPath
	const projects = useProjectStore((state) => state.projects);
	const currentProject = projects.find((p) => p.id === task.projectId);

	const isRunning = task.status === "in_progress";
	const executionPhase = task.executionProgress?.phase;
	// La phase d'exécution (avec son spinner) ne doit être considérée comme
	// active que lorsque la tâche tourne réellement (in_progress / ai_review).
	// Sans ce garde-fou, une tâche terminée conservant une phase obsolète
	// (ex. "qa_review") afficherait à tort le badge "AI Review" animé.
	const hasActiveExecution = isExecutionPhaseActive(
		task.status,
		executionPhase,
	);

	// Check if task is in human_review but has no completed subtasks (crashed/incomplete)
	const isIncomplete = isIncompleteHumanReview(task);

	// Memoize expensive computations to avoid running on every render
	// Truncate description for card display - full description shown in modal
	// Handle JSON error tasks with i18n
	const sanitizedDescription = useMemo(() => {
		if (!task.description) return null;
		// Check for JSON error marker and use i18n
		if (task.description.startsWith(JSON_ERROR_PREFIX)) {
			const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
			const translatedDesc = t("errors:task.jsonError.description", {
				error: errorMessage,
			});
			return sanitizeMarkdownForDisplay(translatedDesc, 120);
		}
		return sanitizeMarkdownForDisplay(task.description, 120);
	}, [task.description, t]);

	// Memoize title with JSON error suffix handling.
	// Strip HTML tags too: tasks imported from Azure DevOps / Jira sometimes
	// carry raw <div><span><b>Description:</b>… into the title field, which
	// React would otherwise render verbatim as text.
	const displayTitle = useMemo(() => {
		const stripped = task.title.trim().startsWith("<")
			? extractTextFromHtml(task.title) || task.title
			: task.title;
		if (stripped.endsWith(JSON_ERROR_TITLE_SUFFIX)) {
			const baseName = stripped.slice(0, -JSON_ERROR_TITLE_SUFFIX.length);
			return `${baseName} ${t("errors:task.jsonError.titleSuffix")}`;
		}
		return stripped;
	}, [task.title, t]);

	// Memoize relative time (recalculates only when updatedAt changes)
	const relativeTime = useMemo(
		() => formatRelativeTime(task.updatedAt),
		[task.updatedAt, formatRelativeTime],
	);

	// Memoize status menu items to avoid recreating on every render
	const statusMenuItems = useMemo(() => {
		if (!onStatusChange) return null;
		return TASK_STATUS_COLUMNS.filter((status) => status !== task.status).map(
			(status) => (
				<DropdownMenuItem key={status} onClick={() => onStatusChange(status)}>
					{t(TASK_STATUS_LABELS[status])}
				</DropdownMenuItem>
			),
		);
	}, [task.status, onStatusChange, t]);

	// Catastrophic stuck detection — last-resort safety net.
	// XState handles all normal transitions via PROCESS_EXITED events.
	// This only fires if XState somehow fails to transition after 60s with no activity.
	useEffect(() => {
		if (!isRunning) {
			setIsStuck(false);
			if (stuckIntervalRef.current) {
				clearInterval(stuckIntervalRef.current);
				stuckIntervalRef.current = null;
			}
			return;
		}

		stuckIntervalRef.current = setInterval(() => {
			// If any activity (status, progress, logs) was recorded recently, task is alive
			if (hasRecentActivity(task.id)) {
				setIsStuck(false);
				return;
			}

			// No activity for 60s — verify process is actually gone
			checkTaskRunning(task.id).then((actuallyRunning) => {
				// Re-check activity in case something arrived while the IPC was in flight
				if (hasRecentActivity(task.id)) {
					setIsStuck(false);
				} else {
					setIsStuck(!actuallyRunning);
				}
			});
		}, STUCK_CHECK_INTERVAL_MS);

		return () => {
			if (stuckIntervalRef.current) {
				clearInterval(stuckIntervalRef.current);
			}
		};
	}, [task.id, isRunning]);

	const handleStartStop = (e: React.MouseEvent) => {
		e.stopPropagation();
		// Stop covers any actively-executing task — in_progress AND ai_review
		// (QA running) — so the card's Stop works during the AI review too.
		if ((isRunning || task.status === "ai_review") && !isStuck) {
			stopTask(task.id);
		} else {
			startTask(task.id);
		}
	};

	const handleRecover = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsRecovering(true);
		// Auto-restart the task after recovery (no need to click Start again)
		const result = await recoverStuckTask(task.id, { autoRestart: true });
		if (result.success) {
			setIsStuck(false);
		}
		setIsRecovering(false);
	};

	const handleArchive = async (e: React.MouseEvent) => {
		e.stopPropagation();
		const result = await archiveTasks(task.projectId, [task.id]);
		if (!result.success) {
			console.error(
				"[TaskCard] Failed to archive task:",
				task.id,
				result.error,
			);
		}
	};

	const handleViewPR = (e: React.MouseEvent) => {
		e.stopPropagation();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		if (task.metadata?.prUrl && (globalThis as any).electronAPI?.openExternal) {
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			(globalThis as any).electronAPI.openExternal(task.metadata.prUrl);
		}
	};

	const handlePause = async (e: React.MouseEvent) => {
		e.stopPropagation();
		await pauseTask(task.id);
	};

	const handleResume = async (e: React.MouseEvent) => {
		e.stopPropagation();
		await resumeTask(task.id);
	};

	const handleDelete = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (onDelete) {
			onDelete();
		}
	};

	const handleDuplicate = (e: React.MouseEvent) => {
		e.stopPropagation();
		onDuplicate?.();
	};

	const handleCardClick = (e: React.MouseEvent) => {
		// Don't open task modal while sync dialog is open (prevents portal event leak)
		if (showSyncDialog) return;
		// If delete functionality is available, don't open the task when clicking near the delete button
		if (onDelete) {
			// Get the click coordinates relative to the card
			const rect = cardRef.current?.getBoundingClientRect();
			if (rect && isDeleteAreaClick(e, rect)) {
				return; // Don't open the task if clicking in the delete area
			}
		}
		// Open task details on click
		onClick();
	};

	const handlePlanClick = () => {
		setPendingTaskDetailTab("subtasks");
		onClick();
	};

	// When executionPhase is 'complete', always show 'completed' badge regardless of reviewReason
	// This ensures the user sees "Complete" when the task finished successfully
	const effectiveReviewReason: ReviewReason | undefined =
		executionPhase === "complete" ? "completed" : task.reviewReason;
	const reviewReasonInfo =
		task.status === "human_review"
			? getReviewReasonLabel(effectiveReviewReason, t)
			: null;

	const isArchived = !!task.metadata?.archivedAt;

	// Check if task was imported from Azure DevOps
	const isFromAzureDevOps = !!(
		task.metadata?.azureDevOpsIdentifier || task.metadata?.azureDevOpsUrl
	);

	return (
		<Card
			role="option"
			aria-label={displayTitle}
			aria-selected={isSelectable ? isSelected : undefined}
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
			ref={cardRef}
			className={cn(
				"card-surface task-card-enhanced cursor-pointer relative group",
				isRunning &&
					!isStuck &&
					"ring-2 ring-primary border-primary task-running-pulse",
				isStuck && "ring-2 ring-warning border-warning task-stuck-pulse",
				isArchived && "opacity-60 hover:opacity-80",
				isSelectable &&
					isSelected &&
					"ring-2 ring-ring border-ring bg-accent/10",
				isFromAzureDevOps && "azure-devops-task",
				isSpotlit && "ring-2 task-spotlight", // violet spotlight on jump-to
			)}
			onClick={handleCardClick}
			onMouseDown={(e) => {
				// Additional mouse down handler to catch events early
				if (onDelete) {
					const rect = cardRef.current?.getBoundingClientRect();
					if (rect && isDeleteAreaMouseDown(e, rect)) {
						e.preventDefault();
						e.stopPropagation();
					}
				}
			}}
		>
			<CardContent className="p-3">
				{/* Delete button - positioned at the top right, outside the content flow */}
				{onDelete && (
					<Button
						ref={deleteButtonRef}
						variant="ghost"
						size="sm"
						className="absolute top-2 right-2 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive z-50"
						title={t("actions.delete")}
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							handleDelete(e);
						}}
					>
						<X className="h-4 w-4" />
					</Button>
				)}
				<div className={cn(isSelectable ? "flex gap-2" : "w-full")}>
					{/* Checkbox for selectable mode - stops event propagation */}
					{isSelectable && (
						<div className="shrink-0 pt-0.5">
							<Checkbox
								checked={isSelected}
								onCheckedChange={onToggleSelect}
								onClick={(e) => e.stopPropagation()}
								aria-label={t("tasks:actions.selectTask", {
									title: displayTitle,
								})}
							/>
						</div>
					)}

					<div className={cn("flex-1 min-w-0", !isSelectable && "w-full")}>
						{/* Tracker reference (Azure DevOps / Jira work-item number) */}
						<TrackerBadge task={task} t={t} />

						{/* Title - full width, no wrapper */}
						<h3
							className="mt-1 font-semibold text-sm text-foreground line-clamp-2 leading-snug"
							title={displayTitle}
						>
							{displayTitle}
						</h3>

						{/* Description - sanitized to handle markdown content (memoized) */}
						{sanitizedDescription && (
							<p className="mt-2 text-xs text-muted-foreground line-clamp-2">
								{sanitizedDescription}
							</p>
						)}

						{/* Metadata badges */}
						<MetadataBadges
							task={task}
							isStuck={isStuck}
							isIncomplete={isIncomplete}
							hasActiveExecution={hasActiveExecution}
							executionPhase={executionPhase}
							reviewReasonInfo={reviewReasonInfo}
							t={t}
						/>

						{/* Azure DevOps pipeline badge (CI/CD loop) */}
						<PipelineBadge task={task} t={t} />


						{/* Progress section - Phase-aware with animations */}
						{(task.subtasks.length > 0 ||
							hasActiveExecution ||
							isRunning ||
							isStuck) && (
							<div className="mt-3 space-y-2">
								<PhaseProgressIndicator
									phase={executionPhase}
									subtasks={task.subtasks}
									phaseProgress={task.executionProgress?.phaseProgress}
									overallProgress={task.executionProgress?.overallProgress}
									isStuck={isStuck}
									isRunning={isRunning}
									hasActiveExecution={hasActiveExecution}
									onPlanClick={
										task.subtasks.length > 0 ? handlePlanClick : undefined
									}
								/>
								{/* Compaction affordance for long-running tasks (10+ phases) */}
								<SessionCompactionBadge task={task} />
							</div>
						)}

						{/* Footer */}
						<div className="mt-3 flex items-center justify-between">
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Clock className="h-3 w-3" />
								<span>{relativeTime}</span>
								<FormulaBadge
									task={task}
									projectPath={currentProject?.path}
								/>
							</div>

							<div className="flex items-center gap-1.5">
								<ActionButtons
									isStuck={isStuck}
									isRecovering={isRecovering}
									isIncomplete={isIncomplete}
									isRunning={isRunning}
									task={task}
									currentProject={currentProject}
									onViewPRFiles={onViewPRFiles}
									onPreviewApp={onPreviewApp}
									handleRecover={handleRecover}
									handleStartStop={handleStartStop}
									handlePause={handlePause}
									handleResume={handleResume}
									handleViewPR={handleViewPR}
									handleArchive={handleArchive}
									statusMenuItems={statusMenuItems}
									t={t}
								/>

								{/* More options menu - includes duplicate, pause/resume and status changes */}
								{(statusMenuItems ||
									isRunning ||
									onDuplicate ||
									task.metadata?.paused?.enabled) && (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												className="h-7 w-7 p-0"
												onClick={(e) => e.stopPropagation()}
												aria-label={t("actions.taskActions")}
											>
												<MoreVertical className="h-4 w-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											onClick={(e) => e.stopPropagation()}
										>
											{/* Duplicate - clone the task into a fresh backlog ticket */}
											{onDuplicate && (
												<>
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															handleDuplicate(e as React.MouseEvent);
														}}
													>
														<Copy className="mr-2 h-4 w-4" />
														{t("actions.duplicate")}
													</DropdownMenuItem>
													<DropdownMenuSeparator />
												</>
											)}
											{/* Pause/Resume - show when task is running or paused */}
											{(isRunning || task.metadata?.paused?.enabled) && (
												<>
													{task.metadata?.paused?.enabled ? (
														<DropdownMenuItem
															onClick={(e) => {
																e.stopPropagation();
																handleResume(e as React.MouseEvent);
															}}
														>
															<Play className="mr-2 h-4 w-4" />
															{t("actions.resume")}
														</DropdownMenuItem>
													) : (
														<DropdownMenuItem
															onClick={(e) => {
																e.stopPropagation();
																handlePause(e as React.MouseEvent);
															}}
														>
															<Pause className="mr-2 h-4 w-4" />
															{t("actions.pause")}
														</DropdownMenuItem>
													)}
													<DropdownMenuSeparator />
												</>
											)}
											{task.status !== "done" && (
												<>
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															setShowSyncDialog(true);
														}}
													>
														<GitMerge className="mr-2 h-4 w-4" />
														{t("tasks:actions.syncFromBranch")}
													</DropdownMenuItem>
													<DropdownMenuSeparator />
												</>
											)}
											{statusMenuItems && (
												<>
													<DropdownMenuLabel>
														{t("actions.moveTo")}
													</DropdownMenuLabel>
													<DropdownMenuSeparator />
													{statusMenuItems}
												</>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
								)}
							</div>
						</div>
						{/* Close content wrapper for selectable mode */}
					</div>
					{/* Close flex container for selectable mode */}
				</div>
			</CardContent>

			{/* Sync from Branch Dialog */}
			{currentProject?.path && (
				<SyncFromBranchDialog
					open={showSyncDialog}
					task={task}
					projectPath={currentProject.path}
					onOpenChange={setShowSyncDialog}
				/>
			)}
		</Card>
	);
}, taskCardPropsAreEqual);
