import { AlertTriangle, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants";
import type { Project, Task } from "../../../shared/types";
import { cn, extractTextFromHtml } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { TaskWarnings } from "./TaskWarnings";

interface TaskDetailModalHeaderProps {
	readonly task: Task;
	readonly state: ReturnType<
		typeof import("./hooks/useTaskDetail").useTaskDetail
	>;
	readonly completedSubtasks: number;
	readonly totalSubtasks: number;
	readonly progressPercent: number;
	readonly onEdit: () => void;
	readonly onClose: () => void;
	readonly activeProject?: Project;
	readonly onRecover: () => void;
	readonly onResume: () => void;
}

/**
 * Strip HTML tags from imported task titles before rendering. See
 * TaskDetailModal.tsx for the rationale (Azure DevOps / Jira sometimes
 * push HTML into the title field).
 */
function cleanTitleForDisplay(title: string): string {
	if (!title) return "";
	const trimmed = title.trim();
	if (!trimmed.startsWith("<")) return title;
	const text = extractTextFromHtml(title);
	return text || title;
}

export function TaskDetailModalHeader({
	task,
	state,
	completedSubtasks,
	totalSubtasks,
	progressPercent,
	onEdit,
	onClose,
	activeProject,
	onRecover,
	onResume,
}: TaskDetailModalHeaderProps) {
	const { t } = useTranslation(["tasks"]);

	// Helper function to get status badge variant
	const getStatusBadgeVariant = (status: string, isStuck: boolean) => {
		if (isStuck) return "warning";
		switch (status) {
			case "done":
				return "success";
			case "human_review":
				return "purple";
			case "in_progress":
				return "info";
			default:
				return "secondary";
		}
	};

	// Helper function to get review reason badge variant
	const getReviewReasonBadgeVariant = (reviewReason: string) => {
		switch (reviewReason) {
			case "completed":
				return "success";
			case "errors":
				return "destructive";
			default:
				return "warning";
		}
	};

	// Helper function to get review reason badge text
	const getReviewReasonBadgeText = (reviewReason: string) => {
		switch (reviewReason) {
			case "completed":
				return t("tasks:modal.badges.completed");
			case "errors":
				return t("tasks:modal.badges.hasErrors");
			case "plan_review":
				return t("tasks:modal.badges.approvePlan");
			case "stopped":
				return t("tasks:modal.badges.stopped");
			default:
				return t("tasks:modal.badges.qaIssues");
		}
	};

	const renderStatusBadges = () => {
		if (state.isStuck) {
			return (
				<Badge
					variant="warning"
					className="text-xs flex items-center gap-1 animate-pulse"
				>
					<AlertTriangle className="h-3 w-3" />
					Stuck
				</Badge>
			);
		}

		if (state.isIncomplete) {
			return (
				<Badge variant="warning" className="text-xs flex items-center gap-1">
					<AlertTriangle className="h-3 w-3" />
					Incomplete
				</Badge>
			);
		}

		return (
			<>
				<Badge
					variant={getStatusBadgeVariant(task.status, state.isStuck)}
					className={cn(
						"text-xs",
						task.status === "in_progress" && !state.isStuck && "status-running",
					)}
				>
					{t(TASK_STATUS_LABELS[task.status])}
				</Badge>
				{task.status === "human_review" && task.reviewReason && (
					<Badge
						variant={getReviewReasonBadgeVariant(task.reviewReason)}
						className="text-xs"
					>
						{getReviewReasonBadgeText(task.reviewReason)}
					</Badge>
				)}
			</>
		);
	};

	return (
		<div className="p-5 pb-4 border-b border-border shrink-0">
			<div className="flex items-start justify-between gap-4">
				<div className="flex-1 min-w-0 overflow-hidden">
					<h2 className="text-xl font-semibold leading-tight text-foreground truncate">
						{cleanTitleForDisplay(task.title)}
					</h2>
					<div className="mt-2.5 flex items-center gap-2 flex-wrap">
						<Badge variant="outline" className="text-xs font-mono">
							{task.specId}
						</Badge>
						{renderStatusBadges()}
						{/* Compact progress indicator */}
						{totalSubtasks > 0 && (
							<span className="text-xs text-muted-foreground ml-1">
								{t("tasks:modal.progress.subtasks", {
									completed: completedSubtasks,
									total: totalSubtasks,
								})}
							</span>
						)}
					</div>
				</div>
				<div className="flex items-center gap-1 shrink-0 electron-no-drag">
					<Button
						variant="ghost"
						size="icon"
						className="hover:bg-primary/10 hover:text-primary transition-colors"
						onClick={onEdit}
						disabled={state.isRunning && !state.isStuck}
					>
						<Pencil className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="hover:bg-muted transition-colors"
						onClick={onClose}
					>
						<X className="h-5 w-5" />
						<span className="sr-only">Close</span>
					</Button>
				</div>
			</div>

			{/* Progress bar - only show when running or has progress */}
			{(state.isRunning || completedSubtasks > 0) && totalSubtasks > 0 && (
				<div className="mt-3 flex items-center gap-3">
					<Progress value={progressPercent} className="h-1.5 flex-1" />
					<span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
						{progressPercent}%
					</span>
				</div>
			)}

			{/* Warnings - compact inline */}
			{(state.isStuck || state.isIncomplete) && (
				<div className="mt-3">
					<TaskWarnings
						isStuck={state.isStuck}
						isIncomplete={state.isIncomplete}
						isRecovering={state.isRecovering}
						taskProgress={{
							completed: completedSubtasks,
							total: totalSubtasks,
						}}
						onRecover={onRecover}
						onResume={onResume}
					/>
				</div>
			)}
		</div>
	);
}
