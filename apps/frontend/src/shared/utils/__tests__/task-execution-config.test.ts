import { describe, expect, it } from "vitest";
import type { AppliedFormula, Task, TaskMetadata, TaskStatus } from "../../types";
import {
	hasExecutionFormula,
	isDuplicatedTask,
	isImportedTask,
	needsExecutionFormula,
} from "../task-execution-config";

const APPLIED: AppliedFormula = {
	provider: "anthropic",
	model: "claude-opus-4-8",
	effort: "high",
	expectedCostUsd: 0.42,
	successProbability: 0.88,
	perTokenBilled: true,
	appliedAt: "2026-06-15T00:00:00.000Z",
};

function makeTask(
	metadata: TaskMetadata | undefined,
	status: TaskStatus = "backlog",
): Task {
	return {
		id: "001-x",
		specId: "001-x",
		projectId: "proj-1",
		title: "X",
		description: "",
		status,
		subtasks: [],
		logs: [],
		metadata,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

describe("isImportedTask", () => {
	it("detects importSource", () => {
		expect(isImportedTask(makeTask({ importSource: "azure-devops" }))).toBe(true);
	});

	it("detects tracker sourceType", () => {
		expect(isImportedTask(makeTask({ sourceType: "linear" }))).toBe(true);
		expect(isImportedTask(makeTask({ sourceType: "github" }))).toBe(true);
	});

	it("detects a remote ticket identifier", () => {
		expect(isImportedTask(makeTask({ jiraIdentifier: "PROJ-1" }))).toBe(true);
		expect(isImportedTask(makeTask({ githubIssueNumbers: [12] }))).toBe(true);
	});

	it("is false for a manual task", () => {
		expect(isImportedTask(makeTask({ sourceType: "manual" }))).toBe(false);
		expect(isImportedTask(makeTask(undefined))).toBe(false);
	});
});

describe("isDuplicatedTask", () => {
	it("detects the duplicatedFrom lineage marker", () => {
		expect(isDuplicatedTask(makeTask({ duplicatedFrom: "001-src" }))).toBe(true);
	});

	it("is false without the marker", () => {
		expect(isDuplicatedTask(makeTask({ sourceType: "manual" }))).toBe(false);
	});
});

describe("hasExecutionFormula", () => {
	it("reflects appliedFormula presence", () => {
		expect(hasExecutionFormula(makeTask({ appliedFormula: APPLIED }))).toBe(true);
		expect(hasExecutionFormula(makeTask({}))).toBe(false);
	});
});

describe("needsExecutionFormula", () => {
	it("is true for an unconfigured imported backlog task", () => {
		expect(needsExecutionFormula(makeTask({ importSource: "jira" }))).toBe(true);
	});

	it("is true for an unconfigured duplicated queue task", () => {
		expect(
			needsExecutionFormula(makeTask({ duplicatedFrom: "001-src" }, "queue")),
		).toBe(true);
	});

	it("is false for a manually created task", () => {
		expect(needsExecutionFormula(makeTask({ sourceType: "manual" }))).toBe(false);
	});

	it("is false once a formula has been applied", () => {
		expect(
			needsExecutionFormula(
				makeTask({ importSource: "jira", appliedFormula: APPLIED }),
			),
		).toBe(false);
	});

	it("is false once the task has progressed past backlog/queue", () => {
		expect(
			needsExecutionFormula(makeTask({ importSource: "jira" }, "in_progress")),
		).toBe(false);
		expect(
			needsExecutionFormula(makeTask({ duplicatedFrom: "001-src" }, "done")),
		).toBe(false);
	});
});
