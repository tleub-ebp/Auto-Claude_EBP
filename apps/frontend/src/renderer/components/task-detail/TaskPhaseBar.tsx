import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import { AnimatedEllipsis } from "../ui/AnimatedEllipsis";
import { getSubStepLabel } from "./task-log-substep";

interface TaskPhaseBarProps {
	phaseLogs: TaskLogs | null;
	/** Phase currently visible at the top of the logs viewport (scroll-driven). */
	currentPhase?: TaskLogPhase | null;
	/**
	 * Libellé de l'activité en cours (ex: titre du sous-tâche en cours de
	 * traitement). Affiché après le numéro de phase pour préciser ce qui est
	 * réellement traité. Sert de repli quand aucune sous-étape précise n'est
	 * dérivable des logs (typiquement la phase de codage).
	 */
	currentActivity?: string | null;
	/**
	 * Sous-étape courante pilotée par le défilement, fournie par TaskLogs (la
	 * dernière borne « phase N: NOM » passée sous le haut du viewport). Quand
	 * elle est fournie (même `null`), elle prime sur la dérivation interne.
	 * Laissée `undefined` en usage autonome (tests) : le composant retombe alors
	 * sur la dernière sous-étape connue des logs.
	 */
	subStep?: string | null;
	/**
	 * Appelé au clic sur l'indicateur de phase/étape. Permet de remonter
	 * directement au début des logs de la phase affichée.
	 */
	onStepClick?: (phase: TaskLogPhase) => void;
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
	subStep,
	onStepClick,
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

	// Détermine la sous-étape réellement traitée dans la phase affichée.
	// En usage réel, TaskLogs fournit `subStep` (piloté par le défilement). En
	// repli (tests / usage autonome), on dérive la dernière sous-étape connue
	// des entrées de la phase. À défaut (typiquement le codage), on retombe sur
	// le libellé d'activité fourni par le parent (titre de la sous-tâche).
	const phaseEntries = phaseLogs.phases[displayPhase]?.entries ?? [];
	const derivedSubStep = (() => {
		for (let i = phaseEntries.length - 1; i >= 0; i--) {
			const label = getSubStepLabel(phaseEntries[i]);
			if (label) return label;
		}
		return null;
	})();
	const resolvedSubStep = subStep !== undefined ? subStep : derivedSubStep;
	const liveActivity =
		displayPhase === activePhase ? currentActivity?.trim() : undefined;
	const rawActivity = resolvedSubStep || liveActivity || null;

	// La phase affichée correspond-elle à celle réellement en cours d'exécution ?
	// Dans ce cas, on signale la « réflexion » via des points de suspension animés.
	const isRunning = displayPhase === activePhase;

	// Évite de doubler les points : on retire toute ellipsis finale du libellé
	// lorsqu'on ajoute l'animation juste après.
	const activity =
		isRunning && rawActivity
			? rawActivity.replace(/[.\u2026]+\s*$/, "").trim() || null
			: rawActivity;

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 px-5 py-1.5 shrink-0 min-w-0 text-xs",
				styles.bg,
			)}
		>
			{/* Nom de la phase + numéro d'étape. Cliquable pour remonter au début
			    des logs de cette phase. */}
			<button
				type="button"
				onClick={onStepClick ? () => onStepClick(displayPhase) : undefined}
				disabled={!onStepClick}
				title={
					onStepClick ? t("execution.labels.stepScrollHint") : undefined
				}
				className={cn(
					"flex items-center gap-1.5 shrink-0 rounded -mx-1 px-1 py-0.5 transition-colors",
					onStepClick && "cursor-pointer hover:bg-foreground/5",
				)}
			>
				<span className={cn("font-medium", styles.text)}>
					{t(PHASE_I18N_KEYS[displayPhase])}
				</span>
				<span className="text-muted-foreground">
					{"("}
					<span>
						{t("execution.labels.step", {
							current: phaseNumber,
							total: PHASE_ORDER.length,
						})}
					</span>
					{")"}
				</span>
			</button>
			{activity && (
				<>
					<span className="text-muted-foreground shrink-0">-</span>
					<span
						className={cn("font-medium truncate", styles.text)}
						title={activity}
					>
						{activity}
					</span>
				</>
			)}
			{isRunning && (
				<AnimatedEllipsis
					className={cn("font-medium shrink-0", styles.text)}
					aria-label={t("execution.labels.thinking")}
				/>
			)}
		</div>
	);
}
