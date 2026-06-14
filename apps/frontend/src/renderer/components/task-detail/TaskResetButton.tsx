import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { resetTask } from "../../stores/task-store";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

// A reset only makes sense once the pipeline produced something and the task
// is not actively being processed (the backend refuses running tasks anyway).
const RESETTABLE_STATUSES: TaskStatus[] = [
	"human_review",
	"error",
	"ai_review",
	"done",
];

interface TaskResetButtonProps {
	readonly task: Task;
	readonly onReset?: () => void;
	readonly className?: string;
}

/**
 * Destructive "start over" action: discards the plan/subtasks, the worktree
 * and all runtime artifacts of the task (the spec is kept) and sends the task
 * back to the backlog. Guarded by a confirmation dialog.
 */
export function TaskResetButton({
	task,
	onReset,
	className,
}: TaskResetButtonProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isResetting, setIsResetting] = useState(false);

	if (!RESETTABLE_STATUSES.includes(task.status)) {
		return null;
	}

	const handleReset = async () => {
		setIsResetting(true);
		try {
			const result = await resetTask(task.id);
			if (result.success) {
				toast({
					title: t("tasks:reset.successTitle"),
					description: t("tasks:reset.successDescription"),
				});
				setConfirmOpen(false);
				onReset?.();
			} else {
				toast({
					title: t("tasks:reset.errorTitle"),
					description: result.error || t("tasks:reset.errorDescription"),
					variant: "destructive",
				});
			}
		} finally {
			setIsResetting(false);
		}
	};

	return (
		<>
			<Button
				size="sm"
				variant="outline"
				onClick={() => setConfirmOpen(true)}
				className={className}
				title={t("tasks:reset.button")}
			>
				<RotateCcw className="h-3.5 w-3.5 mr-1.5" />
				{t("tasks:reset.button")}
			</Button>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("tasks:reset.confirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("tasks:reset.confirmDescription")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isResetting}>
							{t("tasks:reset.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								// Keep the dialog open while the reset runs
								e.preventDefault();
								void handleReset();
							}}
							disabled={isResetting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isResetting ? (
								<>
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
									{t("tasks:reset.resetting")}
								</>
							) : (
								t("tasks:reset.confirm")
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
