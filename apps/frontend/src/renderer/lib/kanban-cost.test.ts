import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../shared/types";
import { computeBoardCostForecast } from "./kanban-cost";

function makeTask(status: TaskStatus, cost?: number): Task {
	const now = new Date();
	return {
		id: `t-${status}-${cost ?? "none"}-${Math.random()}`,
		specId: "spec",
		projectId: "proj",
		title: "Task",
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: now,
		updatedAt: now,
		metadata:
			cost === undefined
				? undefined
				: {
						appliedFormula: {
							provider: "anthropic",
							model: "claude-sonnet-4-6",
							effort: "medium",
							expectedCostUsd: cost,
							successProbability: 0.9,
							perTokenBilled: true,
							appliedAt: now.toISOString(),
						},
					},
	};
}

describe("computeBoardCostForecast", () => {
	it("sums expected cost and splits active vs pending", () => {
		const forecast = computeBoardCostForecast([
			makeTask("backlog", 1),
			makeTask("queue", 2),
			makeTask("in_progress", 4),
			makeTask("ai_review", 8),
			makeTask("human_review", 16), // counts in total, not in active/pending
		]);
		expect(forecast.totalUsd).toBe(31);
		expect(forecast.activeUsd).toBe(12);
		expect(forecast.pendingUsd).toBe(3);
		expect(forecast.withFormula).toBe(5);
	});

	it("ignores terminal columns", () => {
		const forecast = computeBoardCostForecast([
			makeTask("done", 100),
			makeTask("pr_created", 100),
			makeTask("in_progress", 5),
		]);
		expect(forecast.totalUsd).toBe(5);
	});

	it("counts tickets without a usable estimate", () => {
		const forecast = computeBoardCostForecast([
			makeTask("backlog"), // no metadata
			makeTask("queue", 0), // zero cost = not a usable estimate
			makeTask("in_progress", 3),
		]);
		expect(forecast.withoutFormula).toBe(2);
		expect(forecast.withFormula).toBe(1);
		expect(forecast.totalUsd).toBe(3);
	});
});
