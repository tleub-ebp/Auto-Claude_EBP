import { describe, expect, it } from "vitest";
import { getDisplayProgress } from "../utils";

describe("getDisplayProgress", () => {
	it("renvoie l'avancement par sous-tâches hors exécution active", () => {
		expect(getDisplayProgress(25, 74, false)).toBe(25);
	});

	it("privilégie la progression temps réel pendant une exécution active", () => {
		// Cas du bug : sous-tâches figées à 25% alors que le backend est à 74%.
		expect(getDisplayProgress(25, 74, true)).toBe(74);
	});

	it("se replie sur les sous-tâches si overallProgress est absent", () => {
		expect(getDisplayProgress(25, undefined, true)).toBe(25);
	});

	it("ne régresse jamais sous l'avancement par sous-tâches", () => {
		expect(getDisplayProgress(50, 10, true)).toBe(50);
	});

	it("gère overallProgress à 0 pendant l'exécution", () => {
		expect(getDisplayProgress(0, 0, true)).toBe(0);
	});

	it("reflète le travail réel (sous-tâches) quand il y en a, sans gonfler", () => {
		// Bug signalé : QA en boucle d'échec, overallProgress=94 (bande QA) mais
		// seules 2/3 sous-tâches faites → on affiche 67%, le travail réel.
		expect(getDisplayProgress(67, 94, true, true)).toBe(67);
	});

	it("affiche 100% quand toutes les sous-tâches sont faites", () => {
		expect(getDisplayProgress(100, 94, true, true)).toBe(100);
	});

	it("retombe sur la progression de phase sans sous-tâches (planning)", () => {
		// Pas encore de sous-tâches (création de spec) : la barre suit la phase.
		expect(getDisplayProgress(0, 15, true, false)).toBe(15);
	});
});
