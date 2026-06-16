import type { TaskLogEntry, TaskLogPhase } from "../../../shared/types";

/**
 * Libellé de sous-étape porté par une entrée de log, ou `null`. On reconnaît :
 *   1. un tag `subphase` explicite ;
 *   2. l'en-tête « Starting phase N: NOM » émis par l'orchestrateur de
 *      planification (entrée de type `info`) → renvoyé sous la forme
 *      « phase N: NOM ».
 *
 * Les narrations libres de l'agent (entrées `text` du style « Phase 0: Deep
 * Codebase Investigation. Let me explore… ») sont volontairement ignorées : ce
 * ne sont pas des bornes de sous-étape fiables.
 */
export function getSubStepLabel(
	entry: Pick<TaskLogEntry, "type" | "content" | "subphase">,
): string | null {
	const sub = entry.subphase?.trim();
	if (sub) return sub;
	if (entry.type === "info" && entry.content) {
		const match = entry.content.match(/^\s*Starting (phase\s+\d+\s*:\s*\S.*)$/i);
		if (match) return match[1].trim();
	}
	return null;
}

export interface BuildSubStepOptions {
	/** Table id → titre de sous-tâche, pour le repli de sous-étape du codage. */
	subtaskTitles?: Record<string, string>;
	/** Formate le libellé d'une session QA (anciens logs) pour la passe `n` (1-based). */
	formatQaPass: (n: number) => string;
}

/**
 * Construit la table « entrée → libellé de sous-étape » pour une phase.
 *
 * Priorité : si la phase porte des bornes structurées (tag `subphase` ou
 * en-tête « Starting phase N: »), on s'appuie uniquement dessus. Sinon, repli
 * sur les anciens logs :
 *   - codage : le titre de la sous-tâche, posé à chaque changement de
 *     `subtask_id` (une borne par sous-tâche, pas par entrée) ;
 *   - validation : chaque session QA (entrée `phase_start`) numérotée.
 *
 * On parcourt les entrées dans l'ordre chronologique (`phaseLog.entries`) pour
 * détecter correctement les bornes ; la table renvoyée est indexée par
 * référence d'entrée, donc utilisable quel que soit l'ordre d'affichage.
 */
export function buildPhaseSubSteps(
	entries: TaskLogEntry[],
	phase: TaskLogPhase,
	options: BuildSubStepOptions,
): Map<TaskLogEntry, string> {
	const labels = new Map<TaskLogEntry, string>();

	// 1. Bornes structurées (nouveaux logs).
	let hasStructured = false;
	for (const entry of entries) {
		const label = getSubStepLabel(entry);
		if (label) {
			labels.set(entry, label);
			hasStructured = true;
		}
	}
	if (hasStructured) return labels;

	// 2. Replis pour les anciens logs dépourvus de bornes structurées.
	if (phase === "coding") {
		let prev: string | null = null;
		for (const entry of entries) {
			const sid = entry.subtask_id || null;
			if (sid && sid !== prev) {
				labels.set(entry, options.subtaskTitles?.[sid] ?? sid);
			}
			if (sid) prev = sid;
		}
	} else if (phase === "validation") {
		let pass = 0;
		for (const entry of entries) {
			if (entry.type === "phase_start") {
				pass += 1;
				labels.set(entry, options.formatQaPass(pass));
			}
		}
	}

	return labels;
}
