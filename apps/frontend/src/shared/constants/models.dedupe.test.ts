import { describe, expect, it } from "vitest";
import {
	dedupeModelCatalog,
	getCanonicalModelKey,
	resolveCatalogModelValue,
} from "./models";

describe("getCanonicalModelKey", () => {
	it("résout les alias courts vers l'id complet", () => {
		expect(getCanonicalModelKey("opus")).toBe("claude-opus-4-6");
		expect(getCanonicalModelKey("sonnet")).toBe("claude-sonnet-4-6");
		expect(getCanonicalModelKey("opus-4-8")).toBe("claude-opus-4-8");
	});

	it("unifie les notations pointée (Copilot) et tirets (Anthropic)", () => {
		expect(getCanonicalModelKey("claude-opus-4.6")).toBe("claude-opus-4-6");
		expect(getCanonicalModelKey("claude-opus-4-6")).toBe("claude-opus-4-6");
		// Même clé pour la même version, quelle que soit l'écriture.
		expect(getCanonicalModelKey("claude-sonnet-4.5")).toBe(
			getCanonicalModelKey("claude-sonnet-4-5"),
		);
	});

	it("retire un snapshot daté final -YYYYMMDD", () => {
		expect(getCanonicalModelKey("claude-opus-4-5-20251101")).toBe(
			"claude-opus-4-5",
		);
		expect(getCanonicalModelKey("claude-sonnet-4-5-20250929")).toBe(
			"claude-sonnet-4-5",
		);
	});

	it("retire le préfixe Gemini models/", () => {
		expect(getCanonicalModelKey("models/gemini-3.1-pro")).toBe(
			"gemini-3-1-pro",
		);
	});

	it("ne collisionne pas des versions distinctes (deepseek-v3 vs v4)", () => {
		expect(getCanonicalModelKey("deepseek-v3")).not.toBe(
			getCanonicalModelKey("deepseek-v4"),
		);
	});
});

describe("dedupeModelCatalog", () => {
	it("garde l'id explicite versionné et masque alias + snapshot daté", () => {
		const input = [
			{ value: "opus", label: "Claude Opus 4.6" },
			{ value: "claude-opus-4-6", label: "Claude Opus 4.6" },
			{ value: "opus-4-5", label: "Claude Opus 4.5" },
			{ value: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
		];
		const out = dedupeModelCatalog(input);
		const values = out.map((m) => m.value);
		// Une seule entrée par version.
		expect(values).toEqual(["claude-opus-4-6", "claude-opus-4-5-20251101"]);
		// L'alias court a bien été masqué.
		expect(values).not.toContain("opus");
		expect(values).not.toContain("opus-4-5");
	});

	it("préfère l'id non-daté au snapshot daté quand les deux existent", () => {
		const input = [
			{ value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
			{ value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
		];
		const out = dedupeModelCatalog(input);
		expect(out).toHaveLength(1);
		expect(out[0].value).toBe("claude-sonnet-4-5");
	});

	it("collapse les notations pointée et tirets en une entrée", () => {
		const input = [
			{ value: "claude-opus-4-6", label: "Anthropic" },
			{ value: "claude-opus-4.6", label: "Copilot" },
		];
		expect(dedupeModelCatalog(input)).toHaveLength(1);
	});

	it("préserve l'ordre d'apparition des versions", () => {
		const input = [
			{ value: "claude-opus-4-8", label: "4.8" },
			{ value: "claude-opus-4-6", label: "4.6" },
			{ value: "opus-4-8", label: "alias 4.8" },
		];
		const out = dedupeModelCatalog(input);
		expect(out.map((m) => m.value)).toEqual([
			"claude-opus-4-8",
			"claude-opus-4-6",
		]);
	});

	it("conserve les modèles distincts sans doublon", () => {
		const input = [
			{ value: "gpt-5.5", label: "GPT-5.5" },
			{ value: "gpt-4.1", label: "GPT-4.1" },
			{ value: "o3", label: "o3" },
		];
		expect(dedupeModelCatalog(input)).toHaveLength(3);
	});
});

describe("resolveCatalogModelValue", () => {
	const catalog = [
		{ value: "claude-opus-4-8", label: "4.8" },
		{ value: "claude-opus-4-6", label: "4.6" },
		{ value: "claude-opus-4-5-20251101", label: "4.5" },
	];

	it("mappe un alias persisté vers l'entrée canonique visible", () => {
		expect(resolveCatalogModelValue("opus", catalog)).toBe("claude-opus-4-6");
		expect(resolveCatalogModelValue("opus-4-8", catalog)).toBe(
			"claude-opus-4-8",
		);
	});

	it("mappe une notation pointée vers l'entrée tirets du catalogue", () => {
		expect(resolveCatalogModelValue("claude-opus-4.6", catalog)).toBe(
			"claude-opus-4-6",
		);
	});

	it("renvoie la valeur inchangée si déjà présente", () => {
		expect(resolveCatalogModelValue("claude-opus-4-8", catalog)).toBe(
			"claude-opus-4-8",
		);
	});

	it("renvoie la valeur inchangée si aucune correspondance (autre provider)", () => {
		expect(resolveCatalogModelValue("gpt-5.5", catalog)).toBe("gpt-5.5");
		expect(resolveCatalogModelValue("", catalog)).toBe("");
	});
});
