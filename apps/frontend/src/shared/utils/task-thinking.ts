import type { TaskLogPhase, TaskMetadata } from "../types";
import { DEFAULT_PHASE_THINKING } from "../constants/models";
import type {
	PhaseThinkingConfig,
	ThinkingLevel,
} from "../types/settings";

/**
 * Correspondance phase de logs → clé de configuration.
 * La phase de logs « planning » couvre la création de spec ; elle pilote donc
 * le thinking de la phase `spec`.
 */
export const LOG_PHASE_TO_CONFIG_PHASE: Record<
	TaskLogPhase,
	keyof PhaseThinkingConfig
> = {
	planning: "spec",
	coding: "coding",
	validation: "qa",
};

/**
 * Vrai lorsque la tâche utilise une configuration par phase (profil Auto), où
 * chaque phase peut avoir son propre niveau de réflexion.
 */
export function isPerPhaseThinkingTask(
	metadata: TaskMetadata | undefined,
): boolean {
	return Boolean(
		metadata?.isAutoProfile && metadata.phaseModels && metadata.phaseThinking,
	);
}

/**
 * Construit la mise à jour de metadata pour changer le « thinking effort »
 * d'une phase donnée.
 *
 * - Tâche par phase (profil Auto) : on met à jour `phaseThinking[phase]` en
 *   conservant les autres phases.
 * - Tâche mono-modèle : il n'existe qu'un seul niveau partagé, on met donc à
 *   jour `thinkingLevel`.
 */
export function buildThinkingMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	level: ThinkingLevel,
): Partial<TaskMetadata> {
	if (isPerPhaseThinkingTask(metadata)) {
		const base = metadata?.phaseThinking ?? DEFAULT_PHASE_THINKING;
		const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
		return { phaseThinking: { ...base, [configPhase]: level } };
	}
	return { thinkingLevel: level };
}
