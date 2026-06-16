import { describe, expect, it } from "vitest";
import type { TaskLogEntry } from "../../../shared/types";
import { buildPhaseSubSteps, getSubStepLabel } from "./task-log-substep";

/** Fabrique une entrée de log minimale pour les tests. */
function entry(partial: Partial<TaskLogEntry>): TaskLogEntry {
	return {
		timestamp: "2026-06-15T10:00:00Z",
		type: "text",
		content: "",
		phase: "coding",
		...partial,
	} as TaskLogEntry;
}

const formatQaPass = (n: number) => `QA — vérification ${n}`;

describe("getSubStepLabel", () => {
	it("renvoie le tag subphase explicite", () => {
		expect(getSubStepLabel(entry({ subphase: "SUBTASK 2/5: X" }))).toBe(
			"SUBTASK 2/5: X",
		);
	});

	it("extrait l'en-tête « phase N: NOM » de planification", () => {
		expect(
			getSubStepLabel(
				entry({ type: "info", content: "Starting phase 4: CONTEXT DISCOVERY" }),
			),
		).toBe("phase 4: CONTEXT DISCOVERY");
	});

	it("ignore les narrations libres de l'agent (type text)", () => {
		expect(
			getSubStepLabel(
				entry({
					type: "text",
					content: "Phase 0: Deep Codebase Investigation. Let me explore…",
				}),
			),
		).toBeNull();
	});
});

describe("buildPhaseSubSteps", () => {
	it("privilégie les bornes structurées et désactive le repli (codage)", () => {
		const a = entry({ subphase: "SUBTASK 1/2: A" });
		const b = entry({ subtask_id: "st-1" });
		const labels = buildPhaseSubSteps([a, b], "coding", { formatQaPass });
		expect(labels.get(a)).toBe("SUBTASK 1/2: A");
		// Le repli par sous-tâche est désactivé dès qu'une borne structurée existe.
		expect(labels.has(b)).toBe(false);
	});

	it("retombe sur le titre de la sous-tâche aux changements (anciens logs codage)", () => {
		const a = entry({ subtask_id: "st-1" });
		const b = entry({ subtask_id: "st-1" });
		const c = entry({ subtask_id: "st-2" });
		const labels = buildPhaseSubSteps([a, b, c], "coding", {
			subtaskTitles: { "st-1": "Titre 1", "st-2": "Titre 2" },
			formatQaPass,
		});
		expect(labels.get(a)).toBe("Titre 1");
		// Même sous-tâche que la précédente → pas une borne.
		expect(labels.has(b)).toBe(false);
		expect(labels.get(c)).toBe("Titre 2");
	});

	it("retombe sur l'id brut quand le titre est inconnu (codage)", () => {
		const a = entry({ subtask_id: "st-9" });
		const labels = buildPhaseSubSteps([a], "coding", { formatQaPass });
		expect(labels.get(a)).toBe("st-9");
	});

	it("numérote les sessions QA des anciens logs de validation", () => {
		const entries = [
			entry({
				phase: "validation",
				type: "phase_start",
				content: "Starting QA validation...",
			}),
			entry({ phase: "validation", type: "text", content: "travail en cours" }),
			entry({
				phase: "validation",
				type: "phase_start",
				content: "Starting QA validation...",
			}),
		];
		const labels = buildPhaseSubSteps(entries, "validation", { formatQaPass });
		expect(labels.get(entries[0])).toBe("QA — vérification 1");
		expect(labels.has(entries[1])).toBe(false);
		expect(labels.get(entries[2])).toBe("QA — vérification 2");
	});

	it("ne produit aucune borne pour une phase de validation sans session", () => {
		const labels = buildPhaseSubSteps(
			[entry({ phase: "validation", type: "text", content: "rien" })],
			"validation",
			{ formatQaPass },
		);
		expect(labels.size).toBe(0);
	});
});
