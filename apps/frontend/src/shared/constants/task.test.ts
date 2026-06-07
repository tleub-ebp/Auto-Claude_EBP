import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@shared/types/task";
import { isExecutionPhaseActive } from "./task";

describe("isExecutionPhaseActive", () => {
	it("retourne true quand la tâche tourne réellement avec une phase active", () => {
		expect(isExecutionPhaseActive("in_progress", "coding")).toBe(true);
		expect(isExecutionPhaseActive("in_progress", "planning")).toBe(true);
		expect(isExecutionPhaseActive("ai_review", "qa_review")).toBe(true);
		expect(isExecutionPhaseActive("ai_review", "qa_fixing")).toBe(true);
	});

	it("retourne false pour une tâche terminée même avec une phase obsolète", () => {
		// Régression : une tâche "done" conservant phase="qa_review" ne doit
		// pas afficher le badge animé "AI Review".
		expect(isExecutionPhaseActive("done", "qa_review")).toBe(false);
		expect(isExecutionPhaseActive("done", "coding")).toBe(false);
	});

	it("retourne false pour les statuts non actifs", () => {
		const nonRunning: TaskStatus[] = [
			"backlog",
			"queue",
			"human_review",
			"pr_created",
			"error",
		];
		for (const status of nonRunning) {
			expect(isExecutionPhaseActive(status, "qa_review")).toBe(false);
		}
	});

	it("retourne false pour les phases terminales ou absentes", () => {
		expect(isExecutionPhaseActive("in_progress", "idle")).toBe(false);
		expect(isExecutionPhaseActive("in_progress", "complete")).toBe(false);
		expect(isExecutionPhaseActive("in_progress", "failed")).toBe(false);
		expect(isExecutionPhaseActive("in_progress", undefined)).toBe(false);
	});
});
