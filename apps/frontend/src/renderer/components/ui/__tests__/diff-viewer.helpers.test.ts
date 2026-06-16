/**
 * Tests des helpers purs de DiffViewer :
 * - parseDiff : transforme un patch git unifié en lignes typées avec numéros.
 * - buildSplitRows : apparie les lignes en lignes côte à côte (vue "split"),
 *   en zippant les suppressions face aux ajouts comme le fait GitHub.
 */

import { describe, expect, it } from "vitest";
import { buildSplitRows, parseDiff } from "../diff-viewer";

describe("parseDiff", () => {
	it("type chaque ligne et calcule les numéros à partir du hunk", () => {
		const patch = ["@@ -1,2 +1,2 @@", " ctx", "-old", "+new"].join("\n");
		const lines = parseDiff(patch);

		expect(lines.map((l) => l.type)).toEqual([
			"hunk",
			"context",
			"removed",
			"added",
		]);
		// Contexte : présent des deux côtés, première ligne du hunk.
		expect(lines[1]).toMatchObject({ oldLineNumber: 1, newLineNumber: 1 });
		// Suppression : numérotée côté ancien uniquement.
		expect(lines[2]).toMatchObject({ type: "removed", oldLineNumber: 2 });
		expect(lines[2].newLineNumber).toBeUndefined();
		// Ajout : numéroté côté nouveau uniquement.
		expect(lines[3]).toMatchObject({ type: "added", newLineNumber: 2 });
		expect(lines[3].oldLineNumber).toBeUndefined();
	});
});

describe("buildSplitRows", () => {
	it("place une ligne de contexte des deux côtés", () => {
		const rows = buildSplitRows(parseDiff([" ctx"].join("\n")));
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe("context");
		expect(rows[0].left?.content).toBe("ctx");
		expect(rows[0].right?.content).toBe("ctx");
	});

	it("met un ajout pur à droite, côté gauche vide", () => {
		const rows = buildSplitRows(parseDiff(["@@ -1,0 +1,1 @@", "+added"].join("\n")));
		const change = rows.find((r) => r.type === "change");
		expect(change?.left).toBeUndefined();
		expect(change?.right?.content).toBe("added");
	});

	it("met une suppression pure à gauche, côté droit vide", () => {
		const rows = buildSplitRows(parseDiff(["@@ -1,1 +1,0 @@", "-removed"].join("\n")));
		const change = rows.find((r) => r.type === "change");
		expect(change?.left?.content).toBe("removed");
		expect(change?.right).toBeUndefined();
	});

	it("zippe un bloc de remplacement (suppressions face aux ajouts)", () => {
		const patch = ["-a", "-b", "+c", "+d"].join("\n");
		const rows = buildSplitRows(parseDiff(patch));
		const changes = rows.filter((r) => r.type === "change");

		expect(changes).toHaveLength(2);
		expect(changes[0].left?.content).toBe("a");
		expect(changes[0].right?.content).toBe("c");
		expect(changes[1].left?.content).toBe("b");
		expect(changes[1].right?.content).toBe("d");
	});

	it("comble avec une cellule vide quand suppressions et ajouts diffèrent en nombre", () => {
		// 1 suppression, 2 ajouts → 2 lignes, la 2e sans côté gauche.
		const rows = buildSplitRows(parseDiff(["-a", "+c", "+d"].join("\n")));
		const changes = rows.filter((r) => r.type === "change");

		expect(changes).toHaveLength(2);
		expect(changes[0].left?.content).toBe("a");
		expect(changes[1].left).toBeUndefined();
		expect(changes[1].right?.content).toBe("d");
	});

	it("conserve l'en-tête de hunk sur une ligne pleine largeur", () => {
		const rows = buildSplitRows(parseDiff(["@@ -1,1 +1,1 @@", " ctx"].join("\n")));
		expect(rows[0].type).toBe("hunk");
		expect(rows[0].left).toBe(rows[0].right);
	});
});
