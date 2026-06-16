/**
 * Tests for the TASK_DUPLICATE IPC handler.
 *
 * Verifies that duplicating a task clones the spec-defining artifacts
 * (spec.md, requirements.json, task_metadata.json, attachments) into a fresh
 * backlog task while:
 *  - retitling spec.md H1 / requirements.display_title / plan.feature,
 *  - stripping runtime + tracker metadata (PR/worktree/archive/pause, Azure,
 *    Jira, GitHub, GitLab, Linear, importSource),
 *  - writing a fresh empty implementation_plan.json (no phases),
 *  - NOT copying runtime artifacts (QA report, progress, conversation logs).
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project, Task } from "../../../../shared/types";
import type { AgentManager } from "../../../agent";
import { registerTaskCRUDHandlers } from "../crud-handlers";

// Capture handlers registered through ipcMain.handle. Spread the shared electron
// mock so transitive imports (app, BrowserWindow, nativeImage…) keep working.
vi.mock("electron", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		ipcMain: { handle: vi.fn() },
	};
});

// vi.mock factories are hoisted above the imports, so the shared mock state has
// to be hoisted with them (cannot reference module-level consts otherwise).
const { mockProjects, mockTasksByProject, invalidateTasksCache } = vi.hoisted(
	() => ({
		mockProjects: [] as Project[],
		mockTasksByProject: new Map<string, Task[]>(),
		invalidateTasksCache: vi.fn(),
	}),
);

// Mock the project store used by both crud-handlers and findTaskAndProject.
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => mockProjects,
		getTasks: (projectId: string) => mockTasksByProject.get(projectId) || [],
		invalidateTasksCache,
	},
}));

// biome-ignore lint/complexity/noBannedTypes: test helper invokes captured IPC handlers
type Handler = Function;

function createProject(rootPath: string): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: rootPath,
		autoBuildPath: ".workpilot",
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
	} as unknown as Project;
}

describe("TASK_DUPLICATE handler", () => {
	let tmpRoot: string;
	let specsDir: string;
	let registeredHandlers: Map<string, Handler>;
	let duplicateHandler: Handler;

	const sourceSpecId = "001-original-feature";

	beforeEach(() => {
		vi.clearAllMocks();
		mockProjects.length = 0;
		mockTasksByProject.clear();

		// Real temp filesystem for the spec artifacts.
		tmpRoot = mkdtempSync(path.join(tmpdir(), "wp-dup-"));
		specsDir = path.join(tmpRoot, ".workpilot", "specs");
		const sourceDir = path.join(specsDir, sourceSpecId);
		mkdirSync(sourceDir, { recursive: true });

		writeFileSync(
			path.join(sourceDir, "spec.md"),
			"# Original Feature\n\n## Overview\nDo the thing.\n",
			"utf-8",
		);
		writeFileSync(
			path.join(sourceDir, "requirements.json"),
			JSON.stringify(
				{
					task_description: "Do the thing.",
					workflow_type: "feature",
					display_title: "Original Feature",
					acceptance_criteria: ["AC1"],
				},
				null,
				2,
			),
			"utf-8",
		);
		writeFileSync(
			path.join(sourceDir, "task_metadata.json"),
			JSON.stringify(
				{
					sourceType: "imported",
					category: "feature",
					complexity: "medium",
					acceptanceCriteria: ["AC1"],
					prUrl: "https://github.com/x/y/pull/1",
					archivedAt: "2026-01-01T00:00:00.000Z",
					azureDevOpsIdentifier: "12345",
					azureDevOpsUrl: "https://dev.azure.com/x/y/_workitems/edit/12345",
					jiraIdentifier: "PROJ-1",
					importSource: "azure-devops",
					paused: {
						enabled: true,
						paused_at: "2026-01-01T00:00:00.000Z",
						paused_subtask_id: null,
					},
				},
				null,
				2,
			),
			"utf-8",
		);
		// Runtime artifacts that must NOT be copied.
		writeFileSync(path.join(sourceDir, "qa_report.md"), "issues", "utf-8");
		writeFileSync(path.join(sourceDir, "build-progress.txt"), "50%", "utf-8");
		writeFileSync(
			path.join(sourceDir, "conversation.jsonl"),
			'{"role":"user"}',
			"utf-8",
		);
		// Implementation plan WITH phases (clone must reset this).
		writeFileSync(
			path.join(sourceDir, "implementation_plan.json"),
			JSON.stringify({
				feature: "Original Feature",
				description: "Do the thing.",
				status: "in_progress",
				phases: [{ phase: 1, name: "P1", type: "code", subtasks: [] }],
			}),
			"utf-8",
		);
		// Attachment that must be copied.
		mkdirSync(path.join(sourceDir, "attachments"), { recursive: true });
		writeFileSync(
			path.join(sourceDir, "attachments", "diagram.png"),
			Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		);

		const project = createProject(tmpRoot);
		const task: Task = {
			id: sourceSpecId,
			specId: sourceSpecId,
			projectId: project.id,
			title: "Original Feature",
			description: "Do the thing.",
			status: "human_review",
			subtasks: [],
			logs: [],
			metadata: {
				sourceType: "imported",
				category: "feature",
				complexity: "medium",
				acceptanceCriteria: ["AC1"],
				prUrl: "https://github.com/x/y/pull/1",
				archivedAt: "2026-01-01T00:00:00.000Z",
				azureDevOpsIdentifier: "12345",
				azureDevOpsUrl:
					"https://dev.azure.com/x/y/_workitems/edit/12345",
				jiraIdentifier: "PROJ-1",
				importSource: "azure-devops",
				paused: {
					enabled: true,
					paused_at: "2026-01-01T00:00:00.000Z",
					paused_subtask_id: null,
				},
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		mockProjects.push(project);
		mockTasksByProject.set(project.id, [task]);

		// Register handlers and capture the duplicate one.
		registeredHandlers = new Map();
		(ipcMain.handle as ReturnType<typeof vi.fn>).mockImplementation(
			(channel: string, handler: Handler) => {
				registeredHandlers.set(channel, handler);
			},
		);
		registerTaskCRUDHandlers({} as AgentManager);
		const handler = registeredHandlers.get(IPC_CHANNELS.TASK_DUPLICATE);
		if (!handler) throw new Error("TASK_DUPLICATE handler not registered");
		duplicateHandler = handler;
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("registers the TASK_DUPLICATE handler", () => {
		expect(ipcMain.handle).toHaveBeenCalledWith(
			IPC_CHANNELS.TASK_DUPLICATE,
			expect.any(Function),
		);
	});

	it("creates a fresh backlog task with a new spec id", async () => {
		const result = await duplicateHandler(null, sourceSpecId);

		expect(result.success).toBe(true);
		expect(result.data.status).toBe("backlog");
		// Next free number after 001 → 002.
		expect(result.data.id).toMatch(/^002-/);
		expect(result.data.id).not.toBe(sourceSpecId);
		expect(result.data.specId).toBe(result.data.id);
		expect(result.data.subtasks).toEqual([]);
		expect(invalidateTasksCache).toHaveBeenCalledWith("proj-1");
	});

	it("appends a default (copy) suffix when no title override is given", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		expect(result.data.title).toBe("Original Feature (copy)");
	});

	it("uses the caller-supplied title verbatim", async () => {
		const result = await duplicateHandler(
			null,
			sourceSpecId,
			"Original Feature (copie)",
		);
		expect(result.data.title).toBe("Original Feature (copie)");

		const reqPath = path.join(
			specsDir,
			result.data.id,
			"requirements.json",
		);
		const req = JSON.parse(readFileSync(reqPath, "utf-8"));
		expect(req.display_title).toBe("Original Feature (copie)");
	});

	it("retitles spec.md H1 and preserves the overview", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const specMd = readFileSync(
			path.join(specsDir, result.data.id, "spec.md"),
			"utf-8",
		);
		expect(specMd).toContain("# Original Feature (copy)");
		expect(specMd).not.toContain("# Original Feature\n");
		expect(specMd).toContain("Do the thing.");
	});

	it("preserves task_description while keeping acceptance criteria", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const req = JSON.parse(
			readFileSync(
				path.join(specsDir, result.data.id, "requirements.json"),
				"utf-8",
			),
		);
		expect(req.task_description).toBe("Do the thing.");
		expect(req.acceptance_criteria).toEqual(["AC1"]);
	});

	it("strips runtime + tracker metadata but keeps classification", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const meta = JSON.parse(
			readFileSync(
				path.join(specsDir, result.data.id, "task_metadata.json"),
				"utf-8",
			),
		);

		// Kept
		expect(meta.category).toBe("feature");
		expect(meta.complexity).toBe("medium");
		expect(meta.acceptanceCriteria).toEqual(["AC1"]);
		expect(meta.sourceType).toBe("manual");

		// Stripped
		expect(meta.prUrl).toBeUndefined();
		expect(meta.archivedAt).toBeUndefined();
		expect(meta.paused).toBeUndefined();
		expect(meta.azureDevOpsIdentifier).toBeUndefined();
		expect(meta.azureDevOpsUrl).toBeUndefined();
		expect(meta.jiraIdentifier).toBeUndefined();
		expect(meta.importSource).toBeUndefined();

		// Lineage marker so the UI can treat the clone like an import.
		expect(meta.duplicatedFrom).toBe(sourceSpecId);

		// And the returned task object matches the persisted metadata.
		expect(result.data.metadata.sourceType).toBe("manual");
		expect(result.data.metadata.prUrl).toBeUndefined();
		expect(result.data.metadata.azureDevOpsIdentifier).toBeUndefined();
		expect(result.data.metadata.duplicatedFrom).toBe(sourceSpecId);
	});

	it("writes a fresh empty implementation plan", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const plan = JSON.parse(
			readFileSync(
				path.join(specsDir, result.data.id, "implementation_plan.json"),
				"utf-8",
			),
		);
		expect(plan.status).toBe("pending");
		expect(plan.phases).toEqual([]);
		expect(plan.feature).toBe("Original Feature (copy)");
		expect(plan.description).toBe("Do the thing.");
	});

	it("copies attachments", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const copied = path.join(
			specsDir,
			result.data.id,
			"attachments",
			"diagram.png",
		);
		expect(existsSync(copied)).toBe(true);
	});

	it("does not copy runtime artifacts", async () => {
		const result = await duplicateHandler(null, sourceSpecId);
		const dir = path.join(specsDir, result.data.id);
		expect(existsSync(path.join(dir, "qa_report.md"))).toBe(false);
		expect(existsSync(path.join(dir, "build-progress.txt"))).toBe(false);
		expect(existsSync(path.join(dir, "conversation.jsonl"))).toBe(false);
	});

	it("returns an error when the task is unknown", async () => {
		const result = await duplicateHandler(null, "does-not-exist");
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("returns an error when the source spec directory is missing", async () => {
		// Point the task at a spec id that has no directory on disk.
		const ghostTask: Task = {
			...(mockTasksByProject.get("proj-1") as Task[])[0],
			id: "009-ghost",
			specId: "009-ghost",
		};
		mockTasksByProject.set("proj-1", [ghostTask]);

		const result = await duplicateHandler(null, "009-ghost");
		expect(result.success).toBe(false);
		expect(result.error).toContain("Source spec directory not found");
	});
});
