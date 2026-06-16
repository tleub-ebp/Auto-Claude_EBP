/**
 * Tests unitaires du parsing de la sortie du générateur de plan de navigation
 * (preuves visuelles). Couvre la tolérance aux fences/préambule, le filtrage
 * par cible (web vs desktop) et le rejet des étapes vides ou non pertinentes.
 */

import { describe, expect, it } from "vitest";
import { parseNavigationPlanOutput } from "./visual-proof-navigation-service";

describe("parseNavigationPlanOutput", () => {
	it("parses a web plan object and keeps only web steps", () => {
		const plan = parseNavigationPlanOutput(
			JSON.stringify({
				web: [{ path: "/invoices/new", label: "Nouvelle facture" }],
				desktop: [{ invoke: "Ventes" }],
			}),
			"web",
		);
		expect(plan).toEqual({
			web: [{ path: "/invoices/new", label: "Nouvelle facture" }],
		});
	});

	it("parses a desktop plan when the target is desktop", () => {
		const plan = parseNavigationPlanOutput(
			JSON.stringify({ desktop: [{ invoke: "Facturation" }] }),
			"desktop",
		);
		expect(plan).toEqual({ desktop: [{ invoke: "Facturation" }] });
	});

	it("tolerates markdown fences and a preamble", () => {
		const raw = [
			"Here is the navigation plan:",
			"```json",
			'{"web": [{"path": "/login", "click": "#submit"}]}',
			"```",
		].join("\n");
		const plan = parseNavigationPlanOutput(raw, "web");
		expect(plan?.web).toEqual([{ path: "/login", click: "#submit" }]);
	});

	it("accepts a bare array of steps", () => {
		const plan = parseNavigationPlanOutput('[{"path": "/feature"}]', "web");
		expect(plan?.web).toEqual([{ path: "/feature" }]);
	});

	it("keeps label, delayMs and capture flags", () => {
		const plan = parseNavigationPlanOutput(
			JSON.stringify({
				web: [
					{ path: "/x", label: "Étape", delayMs: 500, capture: false },
				],
			}),
			"web",
		);
		expect(plan?.web?.[0]).toEqual({
			path: "/x",
			label: "Étape",
			delayMs: 500,
			capture: false,
		});
	});

	it("drops web steps that carry only desktop fields", () => {
		expect(
			parseNavigationPlanOutput(JSON.stringify({ web: [{ invoke: "X" }] }), "web"),
		).toBeNull();
	});

	it("drops steps with no actionable field", () => {
		expect(
			parseNavigationPlanOutput(
				JSON.stringify({ web: [{ label: "just a label" }] }),
				"web",
			),
		).toBeNull();
	});

	it("returns null for non-JSON or empty output", () => {
		expect(parseNavigationPlanOutput("nope, no json here", "web")).toBeNull();
		expect(parseNavigationPlanOutput("", "web")).toBeNull();
		expect(parseNavigationPlanOutput(JSON.stringify({ web: [] }), "web")).toBeNull();
	});

	it("preserves a desktop setText step", () => {
		const plan = parseNavigationPlanOutput(
			JSON.stringify({
				desktop: [{ setText: { name: "TVA", value: "FR123" }, label: "TVA" }],
			}),
			"desktop",
		);
		expect(plan?.desktop).toEqual([
			{ setText: { name: "TVA", value: "FR123" }, label: "TVA" },
		]);
	});
});
