import { describe, expect, it } from "vitest";
import {
	getModelsForProvider,
	getModelTier,
	resolveModelForProviderCatalog,
} from "./models";

describe("getModelTier", () => {
	it("derives the tier of a preset alias via canonical identity", () => {
		expect(getModelTier("opus")).toBe("flagship");
		expect(getModelTier("sonnet")).toBe("standard");
		expect(getModelTier("haiku")).toBe("fast");
	});

	it("resolves explicit versioned ids too", () => {
		expect(getModelTier("claude-opus-4-6")).toBe("flagship");
		expect(getModelTier("gpt-5.5-pro")).toBe("flagship");
		expect(getModelTier("gpt-4.1-mini")).toBe("fast");
	});

	it("returns undefined for an unknown model", () => {
		expect(getModelTier("totally-unknown-model")).toBeUndefined();
	});
});

describe("resolveModelForProviderCatalog", () => {
	const openai = getModelsForProvider("openai");
	const anthropic = getModelsForProvider("anthropic");

	it("keeps a value already offered by the provider", () => {
		expect(
			resolveModelForProviderCatalog("claude-opus-4-6", anthropic, "anthropic"),
		).toBe("claude-opus-4-6");
	});

	it("maps an alias onto the catalog's canonical spelling", () => {
		const catalog = [{ value: "opus", tier: "flagship" as const }];
		expect(
			resolveModelForProviderCatalog("claude-opus-4-6", catalog, "anthropic"),
		).toBe("opus");
	});

	it("remaps an Anthropic preset onto the matching OpenAI tier (not Claude)", () => {
		// The whole point of the fix: choosing OpenAI must not surface Claude ids.
		const flagship = resolveModelForProviderCatalog("opus", openai, "openai");
		const standard = resolveModelForProviderCatalog("sonnet", openai, "openai");
		const fast = resolveModelForProviderCatalog("haiku", openai, "openai");

		expect(flagship.toLowerCase()).not.toContain("claude");
		expect(standard.toLowerCase()).not.toContain("claude");
		expect(fast.toLowerCase()).not.toContain("claude");

		expect(getModelTier(flagship)).toBe("flagship");
		expect(getModelTier(standard)).toBe("standard");
		expect(getModelTier(fast)).toBe("fast");
	});

	it("falls back to the flagship when the source tier is unknown", () => {
		const resolved = resolveModelForProviderCatalog(
			"some-unknown-model",
			openai,
			"openai",
		);
		expect(getModelTier(resolved)).toBe("flagship");
	});
});
