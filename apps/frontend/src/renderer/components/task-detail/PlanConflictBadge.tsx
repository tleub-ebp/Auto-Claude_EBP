import { GitMerge } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IPCResult, PlanConflictReport, Task } from "../../../shared/types";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface PlanConflictBadgeProps {
	readonly task: Task;
}

/**
 * Compact plan-conflict badge for the task-detail header.
 *
 * Unlike the kanban card badge (driven by the board store, which only checks
 * the actively-parallel in_progress/ai_review tasks), this one runs its own
 * `checkPlanConflicts` call. The backend compares against the broader set of
 * worktree-bearing statuses (queue / in_progress / ai_review / human_review /
 * error), so the badge stays visible even when the rival task isn't actively
 * running — a more reliable place to spot the conflict than hovering cards.
 */
export function PlanConflictBadge({ task }: PlanConflictBadgeProps) {
	const { t } = useTranslation(["tasks"]);
	const [report, setReport] = useState<PlanConflictReport | null>(null);

	useEffect(() => {
		let cancelled = false;
		setReport(null);
		globalThis.electronAPI
			.checkPlanConflicts(task.id)
			.then((result: IPCResult<PlanConflictReport>) => {
				if (!cancelled && result.success && result.data) {
					setReport(result.data);
				}
			})
			.catch((err: unknown) => {
				console.error("Plan conflict check failed:", err);
			});
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	if (!report || report.conflictingTasks.length === 0) {
		return null;
	}

	const titles = report.conflictingTasks.map((c) => c.taskTitle);
	const conflictLabel = t("kanban.conflict.badge", {
		count: report.totalConflictingFiles,
		tasks: titles.join(", "),
	});

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge
					variant="outline"
					aria-label={conflictLabel}
					className="text-xs flex items-center gap-1 bg-destructive/10 text-destructive border-destructive/30 cursor-help"
				>
					<GitMerge className="h-3 w-3" />
					{t("kanban.conflict.label")} {titles.length}
				</Badge>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs space-y-1.5">
				<p className="flex items-center gap-1.5 font-semibold text-destructive">
					<GitMerge className="h-3.5 w-3.5" />
					{t("kanban.conflict.title")}
				</p>
				<p className="text-xs text-muted-foreground">
					{t("kanban.conflict.description")}
				</p>
				<p className="text-xs">
					{t("kanban.conflict.files", { count: report.totalConflictingFiles })}
				</p>
				<p className="text-xs">
					{t("kanban.conflict.withTasks", { tasks: titles.join(", ") })}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}
