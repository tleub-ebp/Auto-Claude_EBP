/**
 * Unit tests for the session-compaction data layer. These guard the bug class
 * the first implementation shipped with: comparing against subtask statuses that
 * don't exist ("done"/"error") and reading a non-existent `metadata` field.
 */
import { describe, expect, it } from "vitest";
import type { Subtask, SubtaskStatus, Task } from "../../shared/types";
import {
	compactSessionHistory,
	injectCompactionContext,
	MIN_PHASES_TO_COMPACT,
} from "./session-compaction";

function createSubtask(overrides: Partial<Subtask> = {}): Subtask {
	return {
		id: Math.random().toString(36).slice(2),
		title: "Step",
		description: "",
		status: "completed" as SubtaskStatus,
		files: [],
		...overrides,
	};
}

function createTask(subtasks: Subtask[]): Task {
	return {
		id: "task",
		specId: "spec",
		projectId: "project-1",
		title: "Task",
		description: "",
		status: "in_progress",
		subtasks,
		logs: [],
		createdAt: new Date("2024-01-01T00:00:00Z"),
		updatedAt: new Date("2024-01-01T00:00:00Z"),
	};
}

/** Build N subtasks with sequential titles, all completed by default. */
function manySubtasks(n: number, overrides: (i: number) => Partial<Subtask> = () => ({})): Subtask[] {
	return Array.from({ length: n }, (_, i) =>
		createSubtask({ title: `Step ${i + 1}`, ...overrides(i) }),
	);
}

describe("compactSessionHistory", () => {
	it("returns null below the compaction threshold", () => {
		const task = createTask(manySubtasks(MIN_PHASES_TO_COMPACT - 1));
		expect(compactSessionHistory(task)).toBeNull();
	});

	it("counts completed and failed phases using the real status values", () => {
		const task = createTask(
			manySubtasks(12, (i) => {
				if (i === 3) return { status: "failed" };
				if (i === 7) return { status: "blocked" };
				if (i === 11) return { status: "in_progress" };
				return { status: "completed" };
			}),
		);
		const handoff = compactSessionHistory(task);
		expect(handoff).not.toBeNull();
		// 12 total, 9 completed, 2 failures (failed + blocked), 1 in_progress.
		expect(handoff?.totalPhases).toBe(12);
		expect(handoff?.completedPhases).toBe(9);
		expect(handoff?.failedPhases).toBe(2);
		expect(handoff?.completionPercent).toBe(Math.round((9 / 12) * 100));
	});

	it("always preserves failed phases and surfaces their blockedReason", () => {
		const task = createTask(
			manySubtasks(12, (i) =>
				i === 5
					? { status: "failed", blockedReason: "Timed out after 5 attempts" }
					: {},
			),
		);
		const handoff = compactSessionHistory(task);
		const failed = handoff?.criticalPhases.find((p) => p.status === "failed");
		expect(failed).toBeDefined();
		expect(failed?.index).toBe(6); // 1-indexed
		expect(failed?.failureReason).toBe("Timed out after 5 attempts");
		expect(failed?.critical).toBe(true);
	});

	it("identifies the last failure scanning from the end", () => {
		const task = createTask(
			manySubtasks(12, (i) =>
				i === 2 || i === 9 ? { status: "failed", title: `Fail ${i}` } : {},
			),
		);
		const handoff = compactSessionHistory(task);
		expect(handoff?.lastFailure?.index).toBe(10); // the i===9 one, 1-indexed
	});

	it("marks keyword phases (test/review/...) as critical even when completed", () => {
		const task = createTask(
			manySubtasks(12, (i) =>
				i === 4 ? { title: "Run integration tests" } : {},
			),
		);
		const handoff = compactSessionHistory(task);
		const testPhase = handoff?.criticalPhases.find((p) => p.index === 5);
		expect(testPhase?.critical).toBe(true);
	});

	it("anchors the first and last phases for trajectory context", () => {
		const handoff = compactSessionHistory(createTask(manySubtasks(20)));
		const indices = handoff?.criticalPhases.map((p) => p.index) ?? [];
		expect(indices).toContain(1);
		expect(indices).toContain(20);
	});

	it("reports no failures cleanly in the context summary", () => {
		const handoff = compactSessionHistory(createTask(manySubtasks(10)));
		expect(handoff?.contextSummary).toContain("no failures");
		expect(handoff?.lastFailure).toBeUndefined();
	});
});

describe("injectCompactionContext", () => {
	it("produces a single-line handoff string with key steps", () => {
		const handoff = compactSessionHistory(createTask(manySubtasks(10)));
		// biome-ignore lint/style/noNonNullAssertion: guarded by the 10-phase task
		const line = injectCompactionContext(handoff!);
		expect(line).toMatch(/^\[Session handoff\]/);
		expect(line).toContain("Key steps:");
		expect(line).not.toContain("\n");
	});
});
