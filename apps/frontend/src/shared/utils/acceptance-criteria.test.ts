/**
 * Tests for the acceptance-criteria helpers.
 *
 * Focus on stripAcceptanceCriteriaSection() — it runs against every imported
 * Azure DevOps work item description, so regressions here would silently
 * change every newly-imported task's description.
 */

import { describe, expect, it } from "vitest";

import {
	parseAcceptanceCriteriaText,
	stripAcceptanceCriteriaSection,
} from "./acceptance-criteria";

describe("stripAcceptanceCriteriaSection", () => {
	it("returns the input untouched when there's no AC heading", () => {
		const html = "<div>Just a plain description.</div>";
		expect(stripAcceptanceCriteriaSection(html)).toBe(html);
	});

	it("returns empty for empty input", () => {
		expect(stripAcceptanceCriteriaSection("")).toBe("");
	});

	it("trims at an English 'Acceptance Criteria' h2", () => {
		const html =
			"<div>Description here.</div>" +
			"<h2>Acceptance Criteria</h2>" +
			"<ol><li>Scenario 1</li></ol>";
		expect(stripAcceptanceCriteriaSection(html)).toBe(
			"<div>Description here.</div>",
		);
	});

	it("trims at a French 'Critères d'acceptation' h3 (with curly apostrophe)", () => {
		const html =
			"<p>Contexte métier.</p>" +
			"<h3>Critères d’acceptation</h3>" +
			"<ul><li>Scénario 1</li></ul>";
		expect(stripAcceptanceCriteriaSection(html)).toBe(
			"<p>Contexte métier.</p>",
		);
	});

	it("trims at 'Scénarios' as an alternate AC marker", () => {
		const html =
			"<div>Story description.</div>" +
			"<h2>Scénarios</h2>" +
			"<div>Scénario 1 — happy path</div>";
		expect(stripAcceptanceCriteriaSection(html)).toBe(
			"<div>Story description.</div>",
		);
	});

	it("trims at 'Cas d'usage' too", () => {
		const html =
			"<p>Why this matters.</p>" +
			"<h4>Cas d'usage</h4>" +
			"<p>Use case 1</p>";
		expect(stripAcceptanceCriteriaSection(html)).toBe(
			"<p>Why this matters.</p>",
		);
	});

	it("matches the heading text even when wrapped in bold/markdown noise", () => {
		const html =
			"<div>Intro.</div>" +
			"<h2><strong>**Critères d'acceptation**</strong></h2>" +
			"<ol><li>x</li></ol>";
		expect(stripAcceptanceCriteriaSection(html)).toBe("<div>Intro.</div>");
	});

	it("does not strip headings that just mention 'criteria' in passing", () => {
		const html =
			"<h2>Other criteria for selection</h2>" + "<p>blah blah</p>";
		// Heading is 'criteria for selection', not 'acceptance criteria' / FR variant.
		expect(stripAcceptanceCriteriaSection(html)).toBe(html);
	});

	it("uses the FIRST AC heading when several are present (defensive)", () => {
		const html =
			"<div>Intro.</div>" +
			"<h2>Acceptance Criteria</h2>" +
			"<p>first list</p>" +
			"<h2>Critères d'acceptation</h2>" +
			"<p>second list</p>";
		expect(stripAcceptanceCriteriaSection(html)).toBe("<div>Intro.</div>");
	});

	// Markdown-heading path: covers descriptions that were already flattened
	// to markdown before reaching us (e.g. the KanbanBoard ADO import path
	// that used to concatenate "## Acceptance Criteria" manually).

	it("trims at a markdown '## Acceptance Criteria' heading", () => {
		const md =
			"Description line one.\n\nDescription line two.\n\n" +
			"## Acceptance Criteria\n\n- Scénario 1\n- Scénario 2";
		expect(stripAcceptanceCriteriaSection(md)).toBe(
			"Description line one.\n\nDescription line two.",
		);
	});

	it("trims at a markdown '### Critères d'acceptation' heading", () => {
		const md = "Some context.\n### Critères d'acceptation\n- crit 1";
		expect(stripAcceptanceCriteriaSection(md)).toBe("Some context.");
	});

	it("tolerates bold markdown wrapping around the heading text", () => {
		const md = "Intro\n\n## **Critères d'acceptation**\n- a";
		expect(stripAcceptanceCriteriaSection(md)).toBe("Intro");
	});

	it("does not trim plain '## Notes' headings (false-positive guard)", () => {
		const md = "Intro\n\n## Notes\n- nothing AC about this";
		expect(stripAcceptanceCriteriaSection(md)).toBe(md);
	});
});

describe("parseAcceptanceCriteriaText (regression sanity)", () => {
	// Existing helper — keep these so any breakage to the AC pipeline is
	// caught alongside the new strip helper.
	it("returns [] for empty input", () => {
		expect(parseAcceptanceCriteriaText("")).toEqual([]);
		expect(parseAcceptanceCriteriaText(undefined)).toEqual([]);
	});

	it("extracts criteria from an HTML <ol><li>… list", () => {
		const html = "<ol><li>First criterion</li><li>Second criterion</li></ol>";
		expect(parseAcceptanceCriteriaText(html)).toEqual([
			"First criterion",
			"Second criterion",
		]);
	});

	it("strips leading numeric / bullet markers", () => {
		const raw = "1. First\n2. Second\n- Third";
		expect(parseAcceptanceCriteriaText(raw)).toEqual([
			"First",
			"Second",
			"Third",
		]);
	});
});
