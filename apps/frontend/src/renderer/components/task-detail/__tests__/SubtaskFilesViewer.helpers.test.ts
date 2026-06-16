/**
 * Tests des helpers purs de SubtaskFilesViewer :
 * - matchDiffFile : association chemin sous-tâche ↔ diff worktree (normalisation
 *   slashes, repli sur suffixe pour chemins relatifs/absolus).
 * - buildFileTree : arborescence enrichie avec le diff par fichier feuille.
 */

import { describe, expect, it } from "vitest";

import type { WorktreeDiffFile } from "../../../../shared/types";
import { buildFileTree, matchDiffFile } from "../SubtaskFilesViewer";

function diffFile(
	path: string,
	overrides: Partial<WorktreeDiffFile> = {},
): WorktreeDiffFile {
	return {
		path,
		status: "modified",
		additions: 1,
		deletions: 0,
		...overrides,
	};
}

function toMap(files: WorktreeDiffFile[]): Map<string, WorktreeDiffFile> {
	const map = new Map<string, WorktreeDiffFile>();
	for (const file of files) {
		map.set(file.path.replace(/\\/g, "/"), file);
	}
	return map;
}

describe("matchDiffFile", () => {
	it("correspond exactement sur un chemin normalisé", () => {
		const map = toMap([diffFile("src/a.ts")]);
		expect(matchDiffFile("src/a.ts", map)?.path).toBe("src/a.ts");
	});

	it("normalise les backslashes Windows", () => {
		const map = toMap([diffFile("src/a.ts")]);
		expect(matchDiffFile("src\\a.ts", map)?.path).toBe("src/a.ts");
	});

	it("se replie sur le suffixe quand un préfixe diffère", () => {
		const map = toMap([diffFile("apps/frontend/src/a.ts")]);
		expect(matchDiffFile("src/a.ts", map)?.path).toBe(
			"apps/frontend/src/a.ts",
		);
	});

	it("retourne undefined sans correspondance", () => {
		const map = toMap([diffFile("src/a.ts")]);
		expect(matchDiffFile("src/zzz.ts", map)).toBeUndefined();
	});
});

describe("buildFileTree", () => {
	it("construit une arborescence dossiers/fichiers", () => {
		const tree = buildFileTree(["src/a.ts", "src/b.ts"], new Map());
		expect(tree).toHaveLength(1);
		expect(tree[0].isFolder).toBe(true);
		expect(tree[0].children).toHaveLength(2);
	});

	it("attache le diff au fichier feuille", () => {
		const map = toMap([diffFile("src/a.ts", { additions: 12, deletions: 3 })]);
		const tree = buildFileTree(["src/a.ts"], map);
		const leaf = tree[0].children?.[0];
		expect(leaf?.diff?.additions).toBe(12);
		expect(leaf?.diff?.deletions).toBe(3);
	});

	it("laisse le diff indéfini quand le fichier n'est pas dans le worktree", () => {
		const tree = buildFileTree(["src/a.ts"], new Map());
		expect(tree[0].children?.[0].diff).toBeUndefined();
	});
});
