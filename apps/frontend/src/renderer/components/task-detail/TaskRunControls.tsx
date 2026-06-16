import { Loader2, Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { derivePauseUiState } from "../../../shared/utils/task-pause";
import { useToast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { pauseTask, resumeTask } from "../../stores/task-store";
import { Button } from "../ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../ui/tooltip";

interface TaskRunControlsProps {
	readonly task: Task;
	/** Pause flag set on disk (task.metadata.paused.enabled). */
	readonly isPaused: boolean;
	/** Real subprocess liveness while paused: false = step finished, null = unknown. */
	readonly pauseProcessAlive: boolean | null;
	/** Stops (kills) the running subprocess — wired to the modal's start/stop handler. */
	readonly onStop: () => Promise<void> | void;
}

type Busy = null | "pause" | "resume" | "stop";

/**
 * Compact, first-class Pause / Reprendre / Arrêter control for a running task.
 *
 * Surfaces pause & resume right next to stop (instead of only "stop"), in a
 * single segmented pill that morphs through the three cooperative-pause states:
 *
 *   • running   → [⏸ Pause] [⏹ Arrêter]
 *   • pausing   → [⏳ Pause en cours…] [⏹ Arrêter]   (step still finishing)
 *   • paused    → [▶ Reprendre] [⏹ Arrêter]
 *
 * Resume simply clears the pause flag; the backend's TASK_RESUME handler already
 * restarts execution from the checkpoint, so no extra start call is needed.
 */
export function TaskRunControls({
	task,
	isPaused,
	pauseProcessAlive,
	onStop,
}: TaskRunControlsProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [busy, setBusy] = useState<Busy>(null);

	const pauseState = derivePauseUiState(isPaused, pauseProcessAlive);
	const disabled = busy !== null;

	const handlePause = async () => {
		setBusy("pause");
		try {
			const ok = await pauseTask(task.id);
			toast(
				ok
					? {
							title: t("tasks:modal.actions.pauseRequestedTitle", "Tâche en pause"),
							description: t(
								"tasks:modal.actions.pauseRequestedDesc",
								"Exécution interrompue immédiatement. Reprenez quand vous voulez depuis le dernier point de contrôle.",
							),
						}
					: {
							variant: "destructive",
							title: t(
								"tasks:modal.actions.pauseFailed",
								"Échec de la mise en pause",
							),
						},
			);
		} finally {
			setBusy(null);
		}
	};

	const handleResume = async () => {
		setBusy("resume");
		try {
			const ok = await resumeTask(task.id);
			toast(
				ok
					? {
							title: t(
								"tasks:modal.actions.resumeRequestedTitle",
								"Reprise de la tâche",
							),
							description: t(
								"tasks:modal.actions.resumeRequestedDesc",
								"La tâche repart là où elle s'était arrêtée.",
							),
						}
					: {
							variant: "destructive",
							title: t("tasks:modal.actions.resumeFailed", "Échec de la reprise"),
						},
			);
		} finally {
			setBusy(null);
		}
	};

	const handleStop = async () => {
		setBusy("stop");
		try {
			await onStop();
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="inline-flex items-center gap-1 rounded-xl border border-border/60 bg-background/50 p-1 shadow-sm backdrop-blur-sm">
			{pauseState === "paused" ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="success"
							size="sm"
							onClick={handleResume}
							disabled={disabled}
							className="gap-1.5 shadow-sm ring-1 ring-[var(--success)]/30"
							aria-label={t("tasks:modal.actions.resumeTask", "Reprendre")}
						>
							{busy === "resume" ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Play className="h-4 w-4" />
							)}
							{t("tasks:modal.actions.resumeTask", "Reprendre")}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{t(
							"tasks:modal.actions.resumeTooltip",
							"Reprendre l'exécution depuis le point de pause",
						)}
					</TooltipContent>
				</Tooltip>
			) : pauseState === "pausing" ? (
				<Button
					variant="warning"
					size="sm"
					disabled
					className="gap-1.5"
					aria-live="polite"
				>
					<Loader2 className="h-4 w-4 animate-spin" />
					{t("tasks:modal.actions.pausingShort", "Pause en cours…")}
				</Button>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							onClick={handlePause}
							disabled={disabled}
							className="gap-1.5 hover:border-warning/50 hover:bg-warning/10 hover:text-warning"
							aria-label={t("tasks:modal.actions.pauseTask", "Mettre en pause")}
						>
							{busy === "pause" ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Pause className="h-4 w-4" />
							)}
							{t("tasks:modal.actions.pauseTask", "Mettre en pause")}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{t(
							"tasks:modal.actions.pauseTooltip",
							"Met la tâche en pause immédiatement — reprenable à tout moment",
						)}
					</TooltipContent>
				</Tooltip>
			)}

			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleStop}
						disabled={busy === "stop"}
						className={cn(
							"gap-1.5 text-muted-foreground",
							"hover:bg-destructive/10 hover:text-destructive",
						)}
						aria-label={t("tasks:modal.actions.stopTask", "Arrêter")}
					>
						{busy === "stop" ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Square className="h-4 w-4" />
						)}
						{t("tasks:modal.actions.stopTask", "Arrêter")}
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{t(
						"tasks:modal.actions.stopTooltip",
						"Arrête complètement la tâche (le travail en cours n'est pas repris)",
					)}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
