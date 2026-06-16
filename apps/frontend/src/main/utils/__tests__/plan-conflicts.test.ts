/**
 * Tests pour plan-conflicts — détection à la planification des chevauchements
 * de fichiers entre tâches parallèles (worktrees), avant que le conflit ne
 * surgisse au merge.
 */

import { describe, expect, it } from "vitest";
import type { Subtask, Task, TaskStatus } from "../../../shared/types";
import { computePlanConflicts, normalizePlanPath } from "../plan-conflicts";

let taskCounter = 0;

function makeTask(
	files: string[][],
	status: TaskStatus = "in_progress",
	overrides: Partial<Task> = {},
): Task {
	taskCounter += 1;
	const id = overrides.id ?? `task-${taskCounter}`;
	return {
		id,
		specId: overrides.specId ?? `spec-${taskCounter}`,
		projectId: "project-1",
		title: overrides.title ?? `Task ${taskCounter}`,
		description: "",
		status,
		subtasks: files.map(
			(subtaskFiles, i): Subtask => ({
				id: `${id}-st-${i}`,
				title: `subtask ${i}`,
				description: "",
				status: "pending",
				files: subtaskFiles,
			}),
		),
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe("normalizePlanPath", () => {
	it("normalise séparateurs, ./ initial et casse", () => {
		expect(normalizePlanPath("src\\Foo\\Bar.cs")).toBe("src/foo/bar.cs");
		expect(normalizePlanPath("./src/app.ts")).toBe("src/app.ts");
		expect(normalizePlanPath("/src/app.ts")).toBe("src/app.ts");
	});
});

describe("computePlanConflicts", () => {
	it("détecte un chevauchement de fichiers entre deux tâches actives", () => {
		const target = makeTask([["src/api/users.ts", "src/db/schema.ts"]]);
		const other = makeTask([["src/api/users.ts"]], "in_progress", {
			title: "Autre tâche",
		});

		const report = computePlanConflicts(target, [target, other]);

		expect(report.conflictingTasks).toHaveLength(1);
		expect(report.conflictingTasks[0].taskTitle).toBe("Autre tâche");
		expect(report.conflictingTasks[0].files).toEqual(["src/api/users.ts"]);
		expect(report.totalConflictingFiles).toBe(1);
	});

	it("compare les chemins indépendamment des séparateurs et de ./", () => {
		const target = makeTask([["src\\Components\\Form.cs"]]);
		const other = makeTask([["./src/components/form.cs"]]);

		const report = computePlanConflicts(target, [target, other]);

		expect(report.conflictingTasks).toHaveLength(1);
		expect(report.totalConflictingFiles).toBe(1);
	});

	it("ignore les tâches non actives (backlog, done, pr_created)", () => {
		const target = makeTask([["src/app.ts"]]);
		const backlog = makeTask([["src/app.ts"]], "backlog");
		const done = makeTask([["src/app.ts"]], "done");
		const pr = makeTask([["src/app.ts"]], "pr_created");

		const report = computePlanConflicts(target, [target, backlog, done, pr]);

		expect(report.conflictingTasks).toHaveLength(0);
		expect(report.totalConflictingFiles).toBe(0);
	});

	it("ignore les tâches archivées", () => {
		const target = makeTask([["src/app.ts"]]);
		const archived = makeTask([["src/app.ts"]], "in_progress", {
			metadata: { archivedAt: "2026-01-01T00:00:00Z" },
		});

		const report = computePlanConflicts(target, [target, archived]);

		expect(report.conflictingTasks).toHaveLength(0);
	});

	it("ne se compare pas à elle-même et gère un plan vide", () => {
		const target = makeTask([[]]);
		const report = computePlanConflicts(target, [target]);

		expect(report.conflictingTasks).toHaveLength(0);
		expect(report.totalConflictingFiles).toBe(0);
	});

	it("trie les tâches en conflit par nombre de fichiers partagés décroissant", () => {
		const target = makeTask([["a.ts", "b.ts", "c.ts"]]);
		const small = makeTask([["a.ts"]], "queue", { title: "small" });
		const big = makeTask([["a.ts", "b.ts"]], "human_review", { title: "big" });

		const report = computePlanConflicts(target, [target, small, big]);

		expect(report.conflictingTasks.map((c) => c.taskTitle)).toEqual([
			"big",
			"small",
		]);
		// a.ts compté une seule fois même si partagé avec deux tâches
		expect(report.totalConflictingFiles).toBe(2);
	});
});
