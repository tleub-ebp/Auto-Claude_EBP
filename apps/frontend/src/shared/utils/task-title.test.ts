import { describe, expect, it } from "vitest";
import { isMeaningfulFeatureTitle } from "./task-title";

describe("isMeaningfulFeatureTitle", () => {
	it("accepts a real, human-readable title", () => {
		expect(
			isMeaningfulFeatureTitle(
				"Limitation du numéro de TVA intracommunautaire à 18 caractères",
			),
		).toBe(true);
	});

	it("trims and accepts a padded title", () => {
		expect(isMeaningfulFeatureTitle("  Add upstream connection test  ")).toBe(
			true,
		);
	});

	it.each([
		"001-limitation-du-num-ro-de-tva-intracommunautaire-18-",
		"002-add-upstream-connection-test",
		"123-anything",
	])("rejects the spec-folder slug %s", (slug) => {
		expect(isMeaningfulFeatureTitle(slug)).toBe(false);
	});

	it.each(["Unnamed Feature", "unnamed feature", "  UNNAMED FEATURE  "])(
		"rejects the auto-fixer placeholder %s",
		(placeholder) => {
			expect(isMeaningfulFeatureTitle(placeholder)).toBe(false);
		},
	);

	it.each([undefined, null, "", "   "])(
		"rejects empty / missing value %s",
		(value) => {
			expect(isMeaningfulFeatureTitle(value)).toBe(false);
		},
	);

	it("accepts a title that merely contains digits but is not a slug", () => {
		expect(isMeaningfulFeatureTitle("Support HTTP 2 and 3")).toBe(true);
	});
});
