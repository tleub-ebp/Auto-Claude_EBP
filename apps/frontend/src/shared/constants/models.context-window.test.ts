import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, getContextWindowForModel } from "./models";

describe("getContextWindowForModel", () => {
	it("retourne 200k pour les modèles Claude (Copilot ou natifs)", () => {
		expect(getContextWindowForModel("claude-opus-4.8")).toBe(200_000);
		expect(getContextWindowForModel("claude-sonnet-4.6")).toBe(200_000);
		expect(getContextWindowForModel("claude-haiku-4.5")).toBe(200_000);
		expect(getContextWindowForModel("claude-3.7-sonnet")).toBe(200_000);
	});

	it("retourne 128k pour GPT-4o / GPT-4", () => {
		expect(getContextWindowForModel("gpt-4o")).toBe(128_000);
		expect(getContextWindowForModel("gpt-4")).toBe(128_000);
	});

	it("retourne 256k pour GPT-5.x", () => {
		expect(getContextWindowForModel("gpt-5.5")).toBe(256_000);
		expect(getContextWindowForModel("gpt-5.4")).toBe(256_000);
	});

	it("retourne 1M pour GPT-4.1 et Gemini", () => {
		expect(getContextWindowForModel("gpt-4.1")).toBe(1_000_000);
		expect(getContextWindowForModel("gemini-2.5-pro")).toBe(1_000_000);
	});

	it("retourne 200k pour les modèles o-series (o1/o3/o4)", () => {
		expect(getContextWindowForModel("o4-mini")).toBe(200_000);
		expect(getContextWindowForModel("o3")).toBe(200_000);
		expect(getContextWindowForModel("o1")).toBe(200_000);
	});

	it("est insensible à la casse et aux espaces", () => {
		expect(getContextWindowForModel("  GPT-4O  ")).toBe(128_000);
		expect(getContextWindowForModel("Claude-Sonnet-4.5")).toBe(200_000);
	});

	it("retombe sur la valeur par défaut pour un modèle inconnu/vide", () => {
		expect(getContextWindowForModel("modele-inconnu-xyz")).toBe(
			DEFAULT_CONTEXT_WINDOW,
		);
		expect(getContextWindowForModel("")).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(getContextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
	});
});
