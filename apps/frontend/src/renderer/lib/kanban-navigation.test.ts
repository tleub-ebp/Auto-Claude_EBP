/**
 * Tests unitaires pour la navigation entre tâches dans l'ordre du Kanban.
 */
import { describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../shared/constants";
import type {
	Task,
	TaskOrderState,
	TaskStatus,
} from "../../shared/types";
import {
	getKanbanOrderedTasks,
	getKanbanSiblings,
} from "./kanban-navigation";

function createTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task",
		specId: "spec",
		projectId: "project-1",
		title: "Task",
		description: "",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2024-01-01T00:00:00Z"),
		updatedAt: new Date("2024-01-01T00:00:00Z"),
		...overrides,
	};
}

function emptyTaskOrder(): TaskOrderState {
	return {
		backlog: [],
		queue: [],
		in_progress: [],
		ai_review: [],
		human_review: [],
		build_failed: [],
		done: [],
		pr_created: [],
		error: [],
	} as TaskOrderState;
}

describe("getKanbanOrderedTasks", () => {
	it("ordonne les tâches colonne par colonne puis selon taskOrder", () => {
		const tasks = [
			createTask({ id: "b2", status: "backlog" }),
			createTask({ id: "b1", status: "backlog" }),
			createTask({ id: "d1", status: "done" }),
			createTask({ id: "p1", status: "in_progress" }),
		];
		const taskOrder = {
			...emptyTaskOrder(),
			backlog: ["b1", "b2"],
			in_progress: ["p1"],
			done: ["d1"],
		};

		const ordered = getKanbanOrderedTasks(tasks, taskOrder, [
			...TASK_STATUS_COLUMNS,
		]);

		expect(ordered.map((t) => t.id)).toEqual(["b1", "b2", "p1", "d1"]);
	});

	it("respecte l'ordre des colonnes (columnOrder)", () => {
		const tasks = [
			createTask({ id: "b1", status: "backlog" }),
			createTask({ id: "d1", status: "done" }),
		];

		const ordered = getKanbanOrderedTasks(tasks, emptyTaskOrder(), [
			"done",
			"backlog",
			"queue",
			"in_progress",
			"ai_review",
			"human_review",
		]);

		expect(ordered.map((t) => t.id)).toEqual(["d1", "b1"]);
	});

	it("place les tâches pr_created dans done et error dans human_review", () => {
		const tasks = [
			createTask({ id: "err", status: "error" }),
			createTask({ id: "pr", status: "pr_created" }),
		];

		const ordered = getKanbanOrderedTasks(tasks, emptyTaskOrder(), [
			...TASK_STATUS_COLUMNS,
		]);

		// human_review (err) vient avant done (pr) dans l'ordre par défaut
		expect(ordered.map((t) => t.id)).toEqual(["err", "pr"]);
	});

	it("trie par date de création (récent d'abord) sans ordre personnalisé", () => {
		const tasks = [
			createTask({
				id: "old",
				status: "backlog",
				createdAt: new Date("2024-01-01T00:00:00Z"),
			}),
			createTask({
				id: "new",
				status: "backlog",
				createdAt: new Date("2024-02-01T00:00:00Z"),
			}),
		];

		const ordered = getKanbanOrderedTasks(tasks, null, [
			...TASK_STATUS_COLUMNS,
		]);

		expect(ordered.map((t) => t.id)).toEqual(["new", "old"]);
	});
});

describe("getKanbanSiblings", () => {
	const ordered = [
		createTask({ id: "a" }),
		createTask({ id: "b" }),
		createTask({ id: "c" }),
	];

	it("retourne la précédente et la suivante au milieu", () => {
		const { previous, next, index } = getKanbanSiblings(ordered, "b");
		expect(previous?.id).toBe("a");
		expect(next?.id).toBe("c");
		expect(index).toBe(1);
	});

	it("ne boucle pas aux extrémités", () => {
		expect(getKanbanSiblings(ordered, "a").previous).toBeNull();
		expect(getKanbanSiblings(ordered, "c").next).toBeNull();
	});

	it("renvoie null si la tâche est introuvable", () => {
		const { previous, next, index } = getKanbanSiblings(ordered, "z");
		expect(previous).toBeNull();
		expect(next).toBeNull();
		expect(index).toBe(-1);
	});
});
