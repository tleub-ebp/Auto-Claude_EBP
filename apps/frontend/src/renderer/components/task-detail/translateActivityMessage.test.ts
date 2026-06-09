/**
 * Tests du mappage i18n des messages d'activité d'exécution.
 *
 * Vérifie que les constantes anglaises émises par le parser de phases sont
 * rebasculées sur les bonnes clés de traduction, y compris les variantes
 * dynamiques (sous-tâche), et que les messages inconnus restent inchangés.
 */

import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { translateActivityMessage } from "./translateActivityMessage";

// Faux `t` : renvoie la clé et sérialise les options d'interpolation pour
// pouvoir asserter le passage du paramètre `subtask`.
const fakeT = ((key: string, opts?: Record<string, unknown>) =>
	opts ? `${key}|${JSON.stringify(opts)}` : key) as unknown as TFunction;

describe("translateActivityMessage", () => {
	it("renvoie null pour une valeur vide", () => {
		expect(translateActivityMessage(fakeT, null)).toBeNull();
		expect(translateActivityMessage(fakeT, undefined)).toBeNull();
		expect(translateActivityMessage(fakeT, "")).toBeNull();
	});

	it("mappe les messages statiques connus sur leur clé", () => {
		expect(
			translateActivityMessage(fakeT, "Creating implementation plan..."),
		).toBe("tasks:execution.activity.creatingPlan");
		expect(
			translateActivityMessage(fakeT, "Implementing code changes..."),
		).toBe("tasks:execution.activity.implementingCode");
		expect(translateActivityMessage(fakeT, "Running QA review...")).toBe(
			"tasks:execution.activity.runningQa",
		);
	});

	it("interpole la sous-tâche en cours", () => {
		expect(
			translateActivityMessage(fakeT, "Working on subtask 3/7..."),
		).toBe(
			'tasks:execution.activity.workingOnSubtask|{"subtask":"3/7"}',
		);
	});

	it("interpole la sous-tâche terminée", () => {
		expect(
			translateActivityMessage(fakeT, "Subtask auth-login completed"),
		).toBe(
			'tasks:execution.activity.subtaskCompleted|{"subtask":"auth-login"}',
		);
	});

	it("laisse inchangé un message inconnu (ex: erreur brute)", () => {
		const raw = "Traceback: something exploded";
		expect(translateActivityMessage(fakeT, raw)).toBe(raw);
	});
});
