import { describe, expect, it } from "vitest";
import {
	IMPACT_BLOCK_MARKER,
	appendImpactBlock,
	renderImpactBlock,
	stripImpactBlock,
} from "../pr-impact-block";

describe("pr-impact-block", () => {
	it("renderImpactBlock uses the agreed French labels", () => {
		const block = renderImpactBlock("3", "Fiche véhicule, doc de vente");
		expect(block).toContain("Note de l'impact (1 à 5) : 3");
		expect(block).toContain(
			"Fonctionnalité(s) impactée(s) : Fiche véhicule, doc de vente",
		);
		expect(block).toContain(IMPACT_BLOCK_MARKER);
		expect(block.startsWith("---\n")).toBe(true);
	});

	it("appendImpactBlock keeps existing body content first", () => {
		const body = "## Summary\n\nFix the bug.";
		const result = appendImpactBlock(body, "2", "API auth");
		expect(result).toContain("## Summary");
		expect(result).toContain("Fix the bug.");
		expect(result.indexOf("## Summary")).toBeLessThan(
			result.indexOf(IMPACT_BLOCK_MARKER),
		);
	});

	it("appendImpactBlock is idempotent: replaces previous block", () => {
		const body = "## Summary\nThing.";
		const once = appendImpactBlock(body, "1", "A");
		const twice = appendImpactBlock(once, "4", "B");
		expect(twice).toContain("(1 à 5) : 4");
		expect(twice).toContain("impactée(s) : B");
		expect(twice).not.toContain("(1 à 5) : 1");
		// Only one marker
		const markerCount = twice.split(IMPACT_BLOCK_MARKER).length - 1;
		expect(markerCount).toBe(1);
		// Original content preserved
		expect(twice).toContain("Thing.");
	});

	it("stripImpactBlock is a no-op when no marker is present", () => {
		const body = "## Summary\nNothing to strip.";
		expect(stripImpactBlock(body)).toBe(body);
	});

	it("stripImpactBlock removes the block but keeps preceding content", () => {
		const body = `## Summary\n\nDo the thing.\n\n---\n${IMPACT_BLOCK_MARKER}\nNote de l'impact (1 à 5) : 3\nFonctionnalité(s) impactée(s) : Foo`;
		const stripped = stripImpactBlock(body);
		expect(stripped).not.toContain(IMPACT_BLOCK_MARKER);
		expect(stripped).toContain("Do the thing.");
	});

	it("appendImpactBlock works on an empty body", () => {
		const result = appendImpactBlock("", "5", "Everything");
		expect(result.startsWith("---\n")).toBe(true);
		expect(result).toContain("(1 à 5) : 5");
	});
});
