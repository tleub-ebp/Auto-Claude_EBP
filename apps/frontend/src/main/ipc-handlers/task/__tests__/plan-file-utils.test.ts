import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addChangeRequestSubtaskToPlan,
	buildChangeRequestSubtask,
} from "../plan-file-utils";

interface Phase {
	name: string;
	subtasks: Array<{ id: string; origin?: string }>;
}

describe("buildChangeRequestSubtask", () => {
	it("always returns a single pending change-request subtask", () => {
		const subtask = buildChangeRequestSubtask("Please fix the VAT limit");

		expect(subtask.origin).toBe("change_request");
		expect(subtask.status).toBe("pending");
		expect(subtask.id).toMatch(/^change-request-/);
		// requested_at must be a valid ISO timestamp for the UI trace line.
		expect(Number.isNaN(Date.parse(subtask.requested_at))).toBe(false);
	});

	it("leaves files empty so the viewer shows only files_changed (ground truth)", () => {
		// The branch diff must NOT be attached — files the change actually touches
		// are recorded by the backend after the agent runs.
		const subtask = buildChangeRequestSubtask("Fix both files");

		expect(subtask.files).toEqual([]);
		expect(subtask.description).toBe("Fix both files");
	});

	it("uses the first feedback line as the title and keeps the full text in the description", () => {
		const feedback = "Limit the field to 18 chars\nshow a warning on the 19th";
		const subtask = buildChangeRequestSubtask(feedback);

		expect(subtask.title).toBe("Limit the field to 18 chars");
		expect(subtask.description).toContain("show a warning on the 19th");
	});

	it("truncates an overly long title to 120 characters", () => {
		const longLine = "x".repeat(200);
		const subtask = buildChangeRequestSubtask(longLine);

		expect(subtask.title).toHaveLength(120);
	});

	it("falls back to a default summary when feedback is empty", () => {
		const subtask = buildChangeRequestSubtask("   ");

		expect(subtask.title).toBe("Change requested by user");
		expect(subtask.origin).toBe("change_request");
	});
});

describe("addChangeRequestSubtaskToPlan", () => {
	let dir: string;
	let planPath: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "plan-utils-"));
		planPath = path.join(dir, "implementation_plan.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends the subtask to an existing Implementation phase", () => {
		writeFileSync(
			planPath,
			JSON.stringify({
				phases: [{ name: "Implementation", subtasks: [{ id: "a" }] }],
			}),
			"utf-8",
		);
		const subtask = buildChangeRequestSubtask("do X");

		const ok = addChangeRequestSubtaskToPlan(planPath, subtask);

		expect(ok).toBe(true);
		const plan = JSON.parse(readFileSync(planPath, "utf-8"));
		const impl = plan.phases.find((p: Phase) => p.name === "Implementation");
		expect(impl.subtasks).toHaveLength(2);
		expect(impl.subtasks[1].origin).toBe("change_request");
		expect(impl.subtasks[1].id).toBe(subtask.id);
	});

	it("creates an Implementation phase when none exists, preserving other phases", () => {
		writeFileSync(
			planPath,
			JSON.stringify({
				phases: [{ name: "Phase 1", subtasks: [{ id: "orig" }] }],
			}),
			"utf-8",
		);

		const ok = addChangeRequestSubtaskToPlan(
			planPath,
			buildChangeRequestSubtask("do Y"),
		);

		expect(ok).toBe(true);
		const plan = JSON.parse(readFileSync(planPath, "utf-8"));
		expect(plan.phases).toHaveLength(2);
		// Original phase untouched
		expect(plan.phases[0].subtasks[0].id).toBe("orig");
		const impl = plan.phases.find((p: Phase) => p.name === "Implementation");
		expect(impl.subtasks).toHaveLength(1);
		expect(impl.subtasks[0].origin).toBe("change_request");
	});

	it("returns false when the plan file is missing or unreadable", () => {
		const ok = addChangeRequestSubtaskToPlan(
			path.join(dir, "does-not-exist.json"),
			buildChangeRequestSubtask("do Z"),
		);
		expect(ok).toBe(false);
	});
});
