import { AlertTriangle, Loader2, Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface TaskWarningsProps {
	readonly isStuck: boolean;
	readonly isIncomplete: boolean;
	readonly isRecovering: boolean;
	readonly taskProgress: { completed: number; total: number };
	readonly onRecover: () => void;
	readonly onResume: () => void;
}

export function TaskWarnings({
	isStuck,
	isIncomplete,
	isRecovering,
	taskProgress,
	onRecover,
	onResume,
}: TaskWarningsProps) {
	const { t } = useTranslation(["tasks"]);

	if (!isStuck && !isIncomplete) return null;

	return (
		<>
			{/* Stuck Task Warning */}
			{isStuck && (
				<div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
					<div className="flex items-start gap-3">
						<AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
						<div className="flex-1">
							<h3 className="font-medium text-sm text-foreground mb-1">
								{t("tasks:warnings.stuck.title")}
							</h3>
							<p className="text-sm text-muted-foreground mb-3">
								{t("tasks:warnings.stuck.description")}
							</p>
							<Button
								variant="warning"
								size="sm"
								onClick={onRecover}
								disabled={isRecovering}
								className="w-full"
							>
								{isRecovering ? (
									<>
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										{t("tasks:warnings.stuck.recovering")}
									</>
								) : (
									<>
										<RotateCcw className="mr-2 h-4 w-4" />
										{t("tasks:warnings.stuck.button")}
									</>
								)}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Incomplete Task Warning */}
			{isIncomplete && !isStuck && (
				<div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-4">
					<div className="flex items-start gap-3">
						<AlertTriangle className="h-5 w-5 text-orange-400 shrink-0 mt-0.5" />
						<div className="flex-1">
							<h3 className="font-medium text-sm text-foreground mb-1">
								{t("tasks:warnings.incomplete.title")}
							</h3>
							<p className="text-sm text-muted-foreground mb-3">
								{t("tasks:warnings.incomplete.description", {
									completed: taskProgress.completed,
									total: taskProgress.total,
								})}
							</p>
							<Button
								variant="default"
								size="sm"
								onClick={onResume}
								className="w-full"
							>
								<Play className="mr-2 h-4 w-4" />
								{t("tasks:warnings.incomplete.button")}
							</Button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
