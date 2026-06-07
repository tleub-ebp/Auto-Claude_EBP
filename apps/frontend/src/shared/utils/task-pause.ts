import type { Task } from "../types";

/**
 * Une tâche est « en pause » dès que le flag coopératif a été écrit dans le plan
 * (puis remonté sur `task.metadata.paused` par le scanner). Tant que ce flag est
 * actif, l'absence de sous-processus est l'état attendu — pas un blocage.
 */
export function isTaskPaused(task: Task): boolean {
	return task.metadata?.paused?.enabled === true;
}

export type PauseUiState = "none" | "pausing" | "paused";

/**
 * Détermine l'état d'interface de la pause.
 *
 * Le statut de la tâche reste `in_progress` pendant toute la pause : on ne peut
 * donc pas s'y fier pour savoir si l'étape en cours est terminée. On s'appuie
 * sur la vivacité réelle du sous-processus.
 *
 * @param isPaused      Flag de pause coopératif actif.
 * @param processAlive  `true` = l'étape se termine encore, `false` = processus
 *                      sorti, `null` = inconnu (traité comme « encore en cours »).
 */
export function derivePauseUiState(
	isPaused: boolean,
	processAlive: boolean | null,
): PauseUiState {
	if (!isPaused) return "none";
	return processAlive === false ? "paused" : "pausing";
}
