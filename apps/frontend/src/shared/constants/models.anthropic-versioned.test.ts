import { describe, expect, it } from "vitest";
import { isAnthropicNativeVersionedModelId } from "./models";

describe("isAnthropicNativeVersionedModelId", () => {
	it("préserve les modèles Claude en notation pointée (Copilot)", () => {
		// Régression: ces IDs sont valides pour Copilot et ne doivent PAS être
		// détectés comme des IDs Anthropic natifs (sinon le backend retombe sur le
		// modèle par défaut du fournisseur, ex. claude-sonnet-4.6).
		expect(isAnthropicNativeVersionedModelId("claude-opus-4.8")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4.7")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-4.6")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-4.5")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-haiku-4.5")).toBe(false);
	});

	it("détecte les IDs Anthropic natifs versionnés avec des tirets", () => {
		expect(
			isAnthropicNativeVersionedModelId("claude-sonnet-4-5-20250929"),
		).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4-5-20251101")).toBe(
			true,
		);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4-6")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-haiku-4-5-20251001")).toBe(
			true,
		);
	});

	it("détecte les IDs natifs « Mythos-class » (fable/mythos)", () => {
		// Nouvelle famille au-dessus d'Opus : un seul groupe de version (-5).
		expect(isAnthropicNativeVersionedModelId("claude-fable-5")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-mythos-5")).toBe(true);
	});

	it("ignore les modèles non-Claude", () => {
		expect(isAnthropicNativeVersionedModelId("gpt-5.5")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("gemini-3.1-pro")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-3.7-sonnet")).toBe(false);
	});
});
