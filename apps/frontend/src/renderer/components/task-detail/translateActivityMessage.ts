import type { TFunction } from "i18next";

/**
 * Traduit les messages d'activité d'exécution émis par le parser de phases
 * (`execution-phase-parser.ts`). Ces messages sont des constantes anglaises
 * canoniques côté main process (et conservées telles quelles dans les logs) ;
 * on les rebascule ici sur les clés i18n `tasks:execution.activity.*` pour
 * l'affichage dans le renderer (barre de phase, etc.).
 *
 * Les deux variantes dynamiques (sous-tâche en cours / terminée) sont gérées
 * par expression régulière avec interpolation. Tout message inconnu (erreurs
 * brutes, événements structurés arbitraires) est renvoyé inchangé.
 */

const STATIC_MESSAGE_KEYS: Record<string, string> = {
	"Discovering project context...": "discoveringContext",
	"Gathering requirements...": "gatheringRequirements",
	"Writing specification...": "writingSpec",
	"Validating specification...": "validatingSpec",
	"Specification complete": "specComplete",
	"Creating implementation plan...": "creatingPlan",
	"Implementing code changes...": "implementingCode",
	"Fixing QA issues...": "fixingQa",
	"Running QA review...": "runningQa",
	"Build paused - subtasks still pending": "buildPaused",
};

const WORKING_ON_SUBTASK = /^Working on subtask (.+?)\.\.\.$/;
const SUBTASK_COMPLETED = /^Subtask (.+?) completed$/;

export function translateActivityMessage(
	t: TFunction,
	message: string | null | undefined,
): string | null {
	if (!message) return null;

	const trimmed = message.trim();

	const staticKey = STATIC_MESSAGE_KEYS[trimmed];
	if (staticKey) {
		return t(`tasks:execution.activity.${staticKey}`);
	}

	const working = trimmed.match(WORKING_ON_SUBTASK);
	if (working) {
		return t("tasks:execution.activity.workingOnSubtask", {
			subtask: working[1],
		});
	}

	const completed = trimmed.match(SUBTASK_COMPLETED);
	if (completed) {
		return t("tasks:execution.activity.subtaskCompleted", {
			subtask: completed[1],
		});
	}

	return message;
}
