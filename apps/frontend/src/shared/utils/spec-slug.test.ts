/**
 * Tests pour slugifySpecTitle.
 *
 * Le point critique : les caractères accentués (« numéro ») doivent être
 * translittérés en ASCII pour respecter la whitelist backend
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Une régression ici recréerait le bug
 * « Invalid spec_name … must match … » lors de la création du worktree.
 */

import { describe, expect, it } from "vitest";

import { slugifySpecTitle } from "./spec-slug";

const WHITELIST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

describe("slugifySpecTitle", () => {
	it("translittère les accents en ASCII", () => {
		const slug = slugifySpecTitle(
			"Limitation du numéro de TVA intracommunautaire",
		);
		expect(slug).toBe("limitation-du-numero-de-tva-intracommunautaire");
		expect(slug).not.toContain("é");
	});

	it("produit un slug conforme à la whitelist backend", () => {
		const slug = slugifySpecTitle("Çà et là : éàù où ?");
		expect(slug).toMatch(WHITELIST);
	});

	it("met en minuscules et remplace les séparateurs par des tirets", () => {
		expect(slugifySpecTitle("Add User Authentication")).toBe(
			"add-user-authentication",
		);
	});

	it("ne laisse pas de tiret en début ou fin", () => {
		expect(slugifySpecTitle("  !!Hello World!!  ")).toBe("hello-world");
	});

	it("tronque à maxLength sans laisser de tiret final", () => {
		const slug = slugifySpecTitle("a".repeat(40) + " " + "b".repeat(40), 41);
		expect(slug.length).toBeLessThanOrEqual(41);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("retourne une chaîne vide pour une entrée non slugifiable", () => {
		expect(slugifySpecTitle("éé")).toBe("ee");
		expect(slugifySpecTitle("！？")).toBe("");
	});
});
