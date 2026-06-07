/**
 * Tests pour worktree-cleanup — actuellement focalisés sur l'extraction
 * du numéro de PR depuis une URL, utilisée par la fermeture automatique
 * de la PR lors de la suppression d'une tâche dans le Kanban.
 */

import { describe, expect, it } from "vitest";
import { extractPrNumber } from "../worktree-cleanup";

describe("extractPrNumber", () => {
	it("extrait le numéro depuis une URL GitHub standard", () => {
		expect(extractPrNumber("https://github.com/owner/repo/pull/123")).toBe(
			123,
		);
	});

	it("supporte les URLs avec sous-chemins (files, commits, ...)", () => {
		expect(
			extractPrNumber("https://github.com/owner/repo/pull/42/files"),
		).toBe(42);
		expect(
			extractPrNumber("https://github.com/owner/repo/pull/42/commits"),
		).toBe(42);
	});

	it("supporte les query strings et fragments", () => {
		expect(
			extractPrNumber("https://github.com/owner/repo/pull/7?diff=split"),
		).toBe(7);
		expect(
			extractPrNumber("https://github.com/owner/repo/pull/7#discussion_r1"),
		).toBe(7);
	});

	it("supporte les hôtes GitHub Enterprise", () => {
		expect(
			extractPrNumber("https://git.enterprise.example.com/org/repo/pull/999"),
		).toBe(999);
	});

	it("retourne null pour les URLs sans /pull/<n>", () => {
		expect(extractPrNumber("https://github.com/owner/repo")).toBeNull();
		expect(
			extractPrNumber("https://github.com/owner/repo/issues/123"),
		).toBeNull();
	});

	it("retourne null pour une URL vide ou non numérique", () => {
		expect(extractPrNumber("")).toBeNull();
		expect(extractPrNumber("https://github.com/owner/repo/pull/abc")).toBeNull();
	});

	it("retourne null pour une valeur <= 0", () => {
		expect(extractPrNumber("https://github.com/owner/repo/pull/0")).toBeNull();
	});
});
