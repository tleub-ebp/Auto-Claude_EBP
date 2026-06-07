import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";

interface TaskPhaseBarProps {
	phaseLogs: TaskLogs | null;
	/** Phase currently visible at the top of the logs viewport (scroll-driven). */
	currentPhase?: TaskLogPhase | null;
	/**
	 * Libellé de l'activité en cours (ex: titre du sous-tâche en cours de
	 * traitement). Affiché après le numéro de phase pour préciser ce qui est
	 * réellement traité. Prioritaire sur le sous-titre dérivé des logs.
	 */
	currentActivity?: string | null;
}

const PHASE_ORDER: TaskLogPhase[] = ["planning", "coding", "validation"];

const PHASE_STYLES: Record<
	TaskLogPhase,
	{ text: string; bg: string }
> = {
	planning: {
		text: "text-amber-600 dark:text-amber-400",
		bg: "bg-amber-500/10 border-b border-amber-500/30",
	},
	coding: {
		text: "text-info",
		bg: "bg-info/10 border-b border-info/30",
	},
	validation: {
		text: "text-purple-600 dark:text-purple-400",
		bg: "bg-purple-500/10 border-b border-purple-500/30",
	},
};

const PHASE_I18N_KEYS: Record<TaskLogPhase, string> = {
	planning: "execution.phases.planning",
	coding: "execution.phases.coding",
	validation: "execution.phases.validation",
};

export function TaskPhaseBar({
	phaseLogs,
	currentPhase,
	currentActivity,
}: TaskPhaseBarProps) {
	const { t } = useTranslation("tasks");

	if (!phaseLogs) return null;

	const activePhase = PHASE_ORDER.find(
		(p) => phaseLogs.phases[p]?.status === "active",
	);

	// Prefer the phase the user is currently scrolled to; fall back to the
	// running phase so the bar still reflects progress before any scroll.
	const displayPhase = currentPhase ?? activePhase;

	if (!displayPhase) return null;

	const phaseNumber = PHASE_ORDER.indexOf(displayPhase) + 1;
	const styles = PHASE_STYLES[displayPhase];

	// Détermine ce qui est réellement traité dans la phase affichée.
	// - Pour la phase en cours d'exécution, on privilégie l'activité fournie
	//   par le parent (titre du sous-tâche en cours).
	// - Sinon (ou à défaut), on dérive le dernier sous-titre rencontré dans les
	//   logs de la phase affichée.
	const phaseEntries = phaseLogs.phases[displayPhase]?.entries ?? [];
	const lastSubphase = [...phaseEntries]
		.reverse()
		.find((entry) => entry.subphase?.trim())?.subphase;
	const liveActivity =
		displayPhase === activePhase ? currentActivity?.trim() : undefined;
	const activity = liveActivity || lastSubphase?.trim() || null;

	return (
		<div
			className={cn(
				"flex items-center gap-2 px-5 py-1.5 shrink-0 min-w-0",
				styles.bg,
			)}
		>
			<span className={cn("text-xs font-medium shrink-0", styles.text)}>
				{t(PHASE_I18N_KEYS[displayPhase])}
			</span>
			<span className="text-xs text-muted-foreground shrink-0">•</span>
			<span className="text-xs text-muted-foreground shrink-0">
				{t("execution.labels.step", {
					current: phaseNumber,
					total: PHASE_ORDER.length,
				})}
			</span>
			{activity && (
				<>
					<span className="text-xs text-muted-foreground shrink-0">:</span>
					<span
						className={cn("text-xs font-medium truncate", styles.text)}
						title={activity}
					>
						{activity}
					</span>
				</>
			)}
		</div>
	);
}
