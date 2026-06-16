import { AlertTriangle, FileWarning, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants/task";
import type {
	IPCResult,
	PlanConflictReport,
	Task,
} from "../../../shared/types";

interface PlanConflictAlertProps {
	readonly task: Task;
}

const MAX_FILES_SHOWN = 6;

/**
 * PlanConflictAlert - Warns at plan review time when another active task's
 * plan touches the same files as this one. Two parallel worktrees modifying
 * the same file will almost certainly produce a merge conflict at the end;
 * raising it here lets the user sequence the tasks or re-scope the plan.
 */
export function PlanConflictAlert({ task }: PlanConflictAlertProps) {
	const { t } = useTranslation(["tasks"]);
	const [report, setReport] = useState<PlanConflictReport | null>(null);
	const [isChecking, setIsChecking] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setIsChecking(true);
		globalThis.electronAPI
			.checkPlanConflicts(task.id)
			.then((result: IPCResult<PlanConflictReport>) => {
				if (!cancelled && result.success && result.data) {
					setReport(result.data);
				}
			})
			.catch((err: unknown) => {
				console.error("Plan conflict check failed:", err);
			})
			.finally(() => {
				if (!cancelled) setIsChecking(false);
			});
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	if (isChecking) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				{t("tasks:modal.plan.conflictsChecking")}
			</div>
		);
	}

	if (!report) {
		return null;
	}

	if (report.conflictingTasks.length === 0) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<ShieldCheck className="h-3.5 w-3.5 text-success" />
				{t("tasks:modal.plan.conflictsNone")}
			</div>
		);
	}

	return (
		<div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-3">
			<div className="flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
				<span className="font-semibold text-sm text-foreground">
					{t("tasks:modal.plan.conflictsTitle")}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("tasks:modal.plan.conflictsDescription", {
					count: report.totalConflictingFiles,
				})}
			</p>
			<div className="space-y-2">
				{report.conflictingTasks.map((conflict) => (
					<div
						key={conflict.taskId}
						className="rounded-md border border-border bg-background/60 p-2"
					>
						<div className="flex items-center justify-between gap-2 mb-1.5">
							<span className="text-xs font-medium text-foreground truncate">
								{conflict.taskTitle}
							</span>
							<span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
								{t(`tasks:${TASK_STATUS_LABELS[conflict.taskStatus]}`, {
									defaultValue: conflict.taskStatus,
								})}
							</span>
						</div>
						<ul className="space-y-0.5">
							{conflict.files.slice(0, MAX_FILES_SHOWN).map((file) => (
								<li
									key={file}
									className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground"
								>
									<FileWarning className="h-3 w-3 text-warning shrink-0" />
									<span className="truncate" title={file}>
										{file}
									</span>
								</li>
							))}
						</ul>
						{conflict.files.length > MAX_FILES_SHOWN && (
							<span className="text-[10px] text-muted-foreground">
								{t("tasks:modal.plan.conflictsMoreFiles", {
									count: conflict.files.length - MAX_FILES_SHOWN,
								})}
							</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
