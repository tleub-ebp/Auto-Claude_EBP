import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../shared/types";
import {
	countAgingTasks,
	formatAgingDuration,
	getTaskAgingHours,
	getTaskAgingLevel,
	listAgingTasks,
} from "./kanban-aging";

const NOW = new Date("2026-06-21T12:00:00Z").getTime();

function makeTask(status: TaskStatus, updatedHoursAgo: number): Task {
	const updatedAt = new Date(NOW - updatedHoursAgo * 3_600_000);
	return {
		id: `t-${status}-${updatedHoursAgo}`,
		specId: "spec",
		projectId: "proj",
		title: "Task",
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: updatedAt,
		updatedAt,
	};
}

describe("getTaskAgingHours", () => {
	it("returns elapsed hours since updatedAt", () => {
		expect(getTaskAgingHours(makeTask("in_progress", 5), NOW)).toBeCloseTo(5);
	});

	it("clamps future timestamps to 0", () => {
		expect(getTaskAgingHours(makeTask("in_progress", -3), NOW)).toBe(0);
	});

	it("returns 0 for an invalid date", () => {
		const task = makeTask("in_progress", 1);
		(task as { updatedAt: unknown }).updatedAt = "not-a-date";
		expect(getTaskAgingHours(task, NOW)).toBe(0);
	});
});

describe("getTaskAgingLevel", () => {
	it("is 'none' for fresh cards", () => {
		expect(getTaskAgingLevel(makeTask("in_progress", 1), NOW)).toBe("none");
	});

	it("escalates in_progress to 'aging' then 'stuck'", () => {
		expect(getTaskAgingLevel(makeTask("in_progress", 5), NOW)).toBe("aging");
		expect(getTaskAgingLevel(makeTask("in_progress", 13), NOW)).toBe("stuck");
	});

	it("never ages terminal columns", () => {
		expect(getTaskAgingLevel(makeTask("done", 1000), NOW)).toBe("none");
		expect(getTaskAgingLevel(makeTask("pr_created", 1000), NOW)).toBe("none");
	});

	it("gives human_review more patience than in_progress", () => {
		// 13h: stuck for in_progress, still fresh for human_review.
		expect(getTaskAgingLevel(makeTask("human_review", 13), NOW)).toBe("none");
		expect(getTaskAgingLevel(makeTask("human_review", 80), NOW)).toBe("stuck");
	});
});

describe("formatAgingDuration", () => {
	it("formats days, hours and minutes", () => {
		expect(formatAgingDuration(50)).toBe("2j");
		expect(formatAgingDuration(5)).toBe("5h");
		expect(formatAgingDuration(0.5)).toBe("30min");
	});

	it("never shows 0min", () => {
		expect(formatAgingDuration(0)).toBe("1min");
	});
});

describe("listAgingTasks", () => {
	it("returns only stale tasks, stuck first then by longest idle", () => {
		const fresh = makeTask("in_progress", 1); // none — excluded
		const aging = makeTask("in_progress", 5); // aging
		const stuckShort = makeTask("in_progress", 13); // stuck, 13h
		const stuckLong = makeTask("build_failed", 40); // stuck, 40h
		const list = listAgingTasks(
			[fresh, aging, stuckShort, stuckLong],
			NOW,
		);
		expect(list.map((e) => e.task.id)).toEqual([
			stuckLong.id,
			stuckShort.id,
			aging.id,
		]);
		expect(list.map((e) => e.level)).toEqual(["stuck", "stuck", "aging"]);
	});
});

describe("countAgingTasks", () => {
	it("tallies aging and stuck cards", () => {
		const tasks = [
			makeTask("in_progress", 1), // none
			makeTask("in_progress", 5), // aging
			makeTask("in_progress", 13), // stuck
			makeTask("build_failed", 30), // stuck
			makeTask("done", 1000), // none
		];
		expect(countAgingTasks(tasks, NOW)).toEqual({ aging: 1, stuck: 2 });
	});
});
