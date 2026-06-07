import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { derivePauseUiState, isTaskPaused } from "../task-pause";

function makeTask(paused?: boolean): Task {
	return {
		metadata: paused === undefined ? {} : { paused: { enabled: paused } },
	} as unknown as Task;
}

describe("isTaskPaused", () => {
	it("retourne true quand le flag de pause est actif", () => {
		expect(isTaskPaused(makeTask(true))).toBe(true);
	});

	it("retourne false quand le flag est désactivé ou absent", () => {
		expect(isTaskPaused(makeTask(false))).toBe(false);
		expect(isTaskPaused(makeTask())).toBe(false);
	});
});

describe("derivePauseUiState", () => {
	it("est 'none' tant que la tâche n'est pas en pause", () => {
		expect(derivePauseUiState(false, null)).toBe("none");
		expect(derivePauseUiState(false, true)).toBe("none");
		expect(derivePauseUiState(false, false)).toBe("none");
	});

	it("reste 'pausing' tant que le sous-processus n'a pas fini l'étape", () => {
		// inconnu (null) → on suppose que l'étape se termine encore
		expect(derivePauseUiState(true, null)).toBe("pausing");
		expect(derivePauseUiState(true, true)).toBe("pausing");
	});

	it("passe à 'paused' une fois le sous-processus sorti", () => {
		expect(derivePauseUiState(true, false)).toBe("paused");
	});
});
