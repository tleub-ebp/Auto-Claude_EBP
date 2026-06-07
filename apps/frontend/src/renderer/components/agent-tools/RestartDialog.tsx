import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	fetchRestartPlan,
	prepareRestart,
	type RestartMode,
	type RestartPlan,
} from "../../lib/agent-tools-api";

export interface RestartDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly specDir: string;
	/**
	 * Called after the cleanup endpoint succeeds. The caller is responsible
	 * for actually triggering the restart (typically via the existing
	 * electronAPI task-start IPC). Receives the restart mode + the list of
	 * files that were cleaned up so the caller can log it.
	 */
	readonly onRestartReady: (mode: RestartMode, deleted: string[]) => void;
}

export function RestartDialog({
	open,
	onOpenChange,
	specDir,
	onRestartReady,
}: RestartDialogProps) {
	const { t } = useTranslation("agentTools");
	const [plan, setPlan] = useState<RestartPlan | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);

	useEffect(() => {
		if (!open) {
			setPlan(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchRestartPlan(specDir, controller.signal)
			.then((res) => {
				if (res.ok) setPlan(res.data.plan);
				else if (res.error !== "aborted") setError(res.error);
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, specDir]);

	const triggerRestart = async (mode: RestartMode) => {
		setRunning(true);
		setError(null);
		const res = await prepareRestart(specDir, mode);
		setRunning(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		onRestartReady(mode, res.data.deleted);
		onOpenChange(false);
	};

	const renderModeButton = (mode: RestartMode, available: boolean) => {
		const reason = plan?.reasons[mode];
		const filesCount = plan?.files_to_clean[mode]?.length ?? 0;
		return (
			<div
				key={mode}
				className="rounded-md border p-3"
				aria-disabled={!available}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="flex-1">
						<div className="font-medium">{t(`restartDialog.modes.${mode}.title`)}</div>
						<div className="text-xs text-muted-foreground mt-1">
							{t(`restartDialog.modes.${mode}.description`)}
						</div>
						{!available && reason && (
							<div className="text-xs text-amber-700 dark:text-amber-300 mt-2">
								{reason}
							</div>
						)}
						{available && filesCount > 0 && (
							<div className="text-xs text-muted-foreground mt-2">
								{t("restartDialog.willDelete", { count: filesCount })}{" "}
								<code className="text-[10px]">
									{plan?.files_to_clean[mode].join(", ")}
								</code>
							</div>
						)}
					</div>
					<Button
						size="sm"
						variant={mode === "full" ? "destructive" : "default"}
						disabled={!available || running}
						onClick={() => triggerRestart(mode)}
					>
						{t("restartDialog.restart")}
					</Button>
				</div>
			</div>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("restartDialog.title")}</DialogTitle>
					<DialogDescription>
						{t("restartDialog.description")}{" "}
						{plan && (
							<>
								{t("restartDialog.progress", {
									completed: plan.completed_subtasks,
									total: plan.total_subtasks,
								})}
								{plan.next_subtask_for_coder && (
									t("restartDialog.nextSubtask", { next: plan.next_subtask_for_coder })
								)}
								.
							</>
						)}
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						{t("restartDialog.loading")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{plan && (
					<div className="space-y-2">
						{renderModeButton("qa", plan.can_restart_qa)}
						{renderModeButton("coder", plan.can_restart_coder)}
						{renderModeButton("full", plan.can_restart_full)}
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("restartDialog.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
