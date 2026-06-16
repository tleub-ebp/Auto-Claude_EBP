/**
 * Helpers pour le pré-requis « Provider × LLM × Effort » (Formula Lab).
 *
 * Les tâches importées (Azure DevOps, Jira, Linear, GitHub, GitLab, roadmap) et
 * dupliquées arrivent dans le backlog sans choix explicite de moteur : elles
 * héritent du défaut global. On propose alors à l'utilisateur de choisir une
 * formule (provider/modèle/effort) avant de lancer la tâche.
 *
 * Les tâches créées manuellement via l'assistant ne sont pas concernées : le
 * profil y est déjà sélectionné inline à la création.
 */

import type { Task, TaskMetadata } from "../types";

/** `sourceType` qui dénotent une origine « tracker / import » (vs. "manual"). */
const IMPORTED_SOURCE_TYPES: ReadonlySet<NonNullable<TaskMetadata["sourceType"]>> =
	new Set(["imported", "linear", "github", "gitlab", "roadmap"]);

/**
 * Vrai si la tâche provient d'un import externe : marqueur `importSource`,
 * `sourceType` de tracker, ou présence d'un identifiant de ticket distant.
 */
export function isImportedTask(task: Task): boolean {
	const m = task.metadata;
	if (!m) return false;
	if (m.importSource) return true;
	if (m.sourceType && IMPORTED_SOURCE_TYPES.has(m.sourceType)) return true;
	return Boolean(
		m.azureDevOpsIdentifier ||
			m.jiraIdentifier ||
			m.linearIssueId ||
			m.githubIssueNumber ||
			(m.githubIssueNumbers && m.githubIssueNumbers.length > 0) ||
			m.gitlabIssueIid,
	);
}

/** Vrai si la tâche a été créée par duplication (cf. TASK_DUPLICATE). */
export function isDuplicatedTask(task: Task): boolean {
	return Boolean(task.metadata?.duplicatedFrom);
}

/** Vrai si une formule (Provider × LLM × Effort) a déjà été appliquée. */
export function hasExecutionFormula(task: Task): boolean {
	return Boolean(task.metadata?.appliedFormula);
}

/**
 * Vrai lorsqu'il faut proposer le pré-requis de choix de moteur : tâche importée
 * ou dupliquée, pas encore configurée, et toujours en amont de l'exécution
 * (backlog ou file d'attente).
 */
export function needsExecutionFormula(task: Task): boolean {
	if (task.status !== "backlog" && task.status !== "queue") return false;
	if (hasExecutionFormula(task)) return false;
	return isImportedTask(task) || isDuplicatedTask(task);
}
