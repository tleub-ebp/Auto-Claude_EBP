/**
 * Unit tests for Project Store
 * Tests project CRUD operations and task reading from filesystem
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test directories - will be set in beforeEach with unique temp dir
let TEST_DIR: string;
let USER_DATA_PATH: string;
let TEST_PROJECT_PATH: string;

// Mock Electron before importing the store
vi.mock("electron", () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === "userData") return USER_DATA_PATH;
			return TEST_DIR;
		}),
	},
}));

// Setup test directories with unique secure temp dir
function setupTestDirs(): void {
	// Create a unique, secure temporary directory
	TEST_DIR = mkdtempSync(path.join(tmpdir(), "project-store-test-"));
	USER_DATA_PATH = path.join(TEST_DIR, "userData");
	TEST_PROJECT_PATH = path.join(TEST_DIR, "test-project");

	mkdirSync(USER_DATA_PATH, { recursive: true });
	mkdirSync(path.join(USER_DATA_PATH, "store"), { recursive: true });
	mkdirSync(TEST_PROJECT_PATH, { recursive: true });
}

// Cleanup test directories
function cleanupTestDirs(): void {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}
}

describe("ProjectStore", () => {
	beforeEach(async () => {
		cleanupTestDirs();
		setupTestDirs();
		vi.resetModules();
	});

	afterEach(() => {
		cleanupTestDirs();
		vi.clearAllMocks();
	});

	describe("addProject", () => {
		it("should create a new project with correct structure", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			expect(project).toHaveProperty("id");
			expect(project.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
			expect(project.path).toBe(TEST_PROJECT_PATH);
			expect(project.name).toBe("test-project"); // Derived from path
			expect(project.settings).toBeDefined();
			expect(project.createdAt).toBeInstanceOf(Date);
			expect(project.updatedAt).toBeInstanceOf(Date);
		});

		it("should use provided name if given", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH, "Custom Name");

			expect(project.name).toBe("Custom Name");
		});

		it("should return existing project if already added", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project1 = store.addProject(TEST_PROJECT_PATH);
			const project2 = store.addProject(TEST_PROJECT_PATH);

			expect(project1.id).toBe(project2.id);
		});

		it("should detect auto-claude directory if present", async () => {
			// Create .workpilot directory (the data directory, not source code)
			mkdirSync(path.join(TEST_PROJECT_PATH, ".workpilot"), {
				recursive: true,
			});

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			expect(project.autoBuildPath).toBe(".workpilot");
		});

		it("should set empty autoBuildPath if not present", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			expect(project.autoBuildPath).toBe("");
		});

		it("should persist project to disk", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			store.addProject(TEST_PROJECT_PATH);

			// Check file exists
			const storePath = path.join(USER_DATA_PATH, "store", "projects.json");
			expect(existsSync(storePath)).toBe(true);

			// Check content
			const content = JSON.parse(readFileSync(storePath, "utf-8"));
			expect(content.projects).toHaveLength(1);
			expect(content.projects[0].path).toBe(TEST_PROJECT_PATH);
		});
	});

	describe("removeProject", () => {
		it("should return false for non-existent project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const result = store.removeProject("nonexistent-id");

			expect(result).toBe(false);
		});

		it("should remove existing project and return true", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const result = store.removeProject(project.id);

			expect(result).toBe(true);
			expect(store.getProjects()).toHaveLength(0);
		});

		it("should persist removal to disk", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			store.removeProject(project.id);

			// Check file content
			const storePath = path.join(USER_DATA_PATH, "store", "projects.json");
			const content = JSON.parse(readFileSync(storePath, "utf-8"));
			expect(content.projects).toHaveLength(0);
		});
	});

	describe("getProjects", () => {
		it("should return empty array when no projects", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const projects = store.getProjects();

			expect(projects).toEqual([]);
		});

		it("should return all projects", async () => {
			const project2Path = path.join(TEST_DIR, "test-project-2");
			mkdirSync(project2Path, { recursive: true });

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			store.addProject(TEST_PROJECT_PATH);
			store.addProject(project2Path);

			const projects = store.getProjects();

			expect(projects).toHaveLength(2);
		});
	});

	describe("getProject", () => {
		it("should return undefined for non-existent project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.getProject("nonexistent-id");

			expect(project).toBeUndefined();
		});

		it("should return project by ID", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const added = store.addProject(TEST_PROJECT_PATH);
			const retrieved = store.getProject(added.id);

			expect(retrieved).toBeDefined();
			expect(retrieved?.id).toBe(added.id);
		});
	});

	describe("updateProjectSettings", () => {
		it("should return undefined for non-existent project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const result = store.updateProjectSettings("nonexistent-id", {
				model: "sonnet",
			});

			expect(result).toBeUndefined();
		});

		it("should update settings and return updated project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const updated = store.updateProjectSettings(project.id, {
				model: "sonnet",
				linearSync: true,
			});

			expect(updated).toBeDefined();
			expect(updated?.settings.model).toBe("sonnet");
			expect(updated?.settings.linearSync).toBe(true);
		});

		it("should update updatedAt timestamp", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const originalUpdatedAt = project.updatedAt;

			// Small delay to ensure timestamp difference
			await new Promise((resolve) => setTimeout(resolve, 10));

			const updated = store.updateProjectSettings(project.id, {
				model: "haiku",
			});

			expect(updated?.updatedAt.getTime()).toBeGreaterThan(
				originalUpdatedAt.getTime(),
			);
		});

		it("should persist settings changes", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			store.updateProjectSettings(project.id, { model: "sonnet" });

			// Read directly from file
			const storePath = path.join(USER_DATA_PATH, "store", "projects.json");
			const content = JSON.parse(readFileSync(storePath, "utf-8"));
			expect(content.projects[0].settings.model).toBe("sonnet");
		});
	});

	describe("getTasks", () => {
		it("should return empty array for non-existent project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const tasks = store.getTasks("nonexistent-id");

			expect(tasks).toEqual([]);
		});

		it("should return empty array if specs directory does not exist", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toEqual([]);
		});

		it("should read tasks from filesystem correctly", async () => {
			// Create spec directory structure in .workpilot (the data directory)
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"001-test-feature",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Test Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "in_progress",
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{
								id: "subtask-1",
								description: "First subtask",
								status: "completed",
							},
							{
								id: "subtask-2",
								description: "Second subtask",
								status: "pending",
							},
						],
					},
				],
				final_acceptance: ["Test passes"],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-02T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const specContent = `# Test Feature\n\n## Overview\n\nThis is a test feature description.\n`;
			writeFileSync(path.join(specsDir, "spec.md"), specContent);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe("Test Feature");
			expect(tasks[0].specId).toBe("001-test-feature");
			expect(tasks[0].subtasks).toHaveLength(2);
			expect(tasks[0].status).toBe("in_progress"); // Some completed, some pending
		});

		// Regression: anciens imports Azure DevOps (US/RsD) sans
		// requirements.display_title. Leur spec.md a un titre H1 dérivé de la
		// description (« # Specification: Description :En tant qu'utilisateur… »),
		// ce qui affichait « Description : » comme titre de carte. On doit
		// retomber sur un libellé propre dérivé du nom de dossier.
		it("derives a clean title from the folder name when spec title is description boilerplate", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"002-limitation-du-numero-de-tva-intracommunautaire-du",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# Specification: Description :En tant qu'utilisateur du DMS, lorsque je renseigne le numero de TVA\n\n## Overview\n\nStuff.\n",
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({
					task_description: "Description :\n\nEn tant qu'utilisateur du DMS...",
					workflow_type: "feature",
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe(
				"Limitation du numero de tva intracommunautaire du",
			);
			expect(tasks[0].title.toLowerCase()).not.toContain("description");
		});

		// Same legacy-import bug, but the boilerplate H1 does NOT start with
		// "Description :" — here it begins with "N° de version" (a RsD work item).
		// The title must still fall back to the folder name, proving detection is
		// based on matching the task_description, not a hardcoded prefix.
		it("derives a clean title when boilerplate H1 starts with arbitrary text", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"003-fenetre-d-avertissement-a-la-saisie-du-19eme-carac",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# Specification: N° de versionConditions de reproduction :Ouvrir la fiche\n\n## Overview\n\nStuff.\n",
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({
					task_description:
						"N° de version\n\nConditions de reproduction :\n\nOuvrir la fiche d'un client",
					workflow_type: "documentation",
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe(
				"Fenetre d avertissement a la saisie du 19eme carac",
			);
			expect(tasks[0].title).not.toContain("N° de version");
		});

		// When requirements.display_title IS present (new imports), it wins over
		// everything else — the real accented Azure title is shown verbatim.
		it("prefers requirements.display_title when present", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"002-limitation-du-numero",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# Specification: Description :Garbage\n\n## Overview\n\nStuff.\n",
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({
					display_title:
						"Limitation du numéro de TVA intracommunautaire du vendeur à 18 caractères",
					task_description: "Description :...",
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe(
				"Limitation du numéro de TVA intracommunautaire du vendeur à 18 caractères",
			);
		});

		// Regression (kanban title "s'inspire du dossier du worktree"): a legacy
		// import has no display_title and a boilerplate spec.md H1, but the planner
		// produced a real, accented plan.feature. We must serve that title AND
		// persist it as display_title so a later scan that reads the plan mid-write
		// (plan === null) can't regress the card to the slugified folder name.
		it("backfills requirements.display_title from a meaningful plan feature", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"004-limitation-du-num-ro-de-tva-intracommunautaire-18-",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# Specification: Description :En tant qu'utilisateur\n\n## Overview\n\nStuff.\n",
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({
					task_description: "Description :\n\nEn tant qu'utilisateur",
					workflow_type: "feature",
				}),
			);
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify({
					feature:
						"Limitation du numéro de TVA intracommunautaire à 18 caractères",
					workflow_type: "feature",
					phases: [],
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);

			const tasks = store.getTasks(project.id);
			expect(tasks[0].title).toBe(
				"Limitation du numéro de TVA intracommunautaire à 18 caractères",
			);

			// The title is now durable in requirements.json.
			const persisted = JSON.parse(
				readFileSync(path.join(specsDir, "requirements.json"), "utf-8"),
			);
			expect(persisted.display_title).toBe(
				"Limitation du numéro de TVA intracommunautaire à 18 caractères",
			);

			// Simulate the transient mid-write state: remove the plan, re-scan, the
			// title must hold instead of regressing to the folder name.
			rmSync(path.join(specsDir, "implementation_plan.json"));
			store.invalidateTasksCache(project.id);
			const tasksAfter = store.getTasks(project.id);
			expect(tasksAfter[0].title).toBe(
				"Limitation du numéro de TVA intracommunautaire à 18 caractères",
			);
		});

		// A plan.feature that is itself the spec-folder slug (written by the backend
		// auto-fixer when no real feature exists) must NOT be shown verbatim — it is
		// the worktree directory name. We fall back to a readable folder label.
		it("ignores a plan feature that is a spec-folder slug", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"005-add-upstream-connection-test",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify({
					feature: "005-add-upstream-connection-test",
					workflow_type: "feature",
					phases: [],
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].title).toBe("Add upstream connection test");
		});

		// Regression: when implementation_plan.json is missing OR empty we used
		// to flag the task as "JSON parse error", which replaced the User Story
		// description with a scary "malformed JSON" banner. Missing/empty file
		// is NOT a parse error — only files that throw on JSON.parse are.
		it("should NOT flag missing implementation_plan.json as JSON parse error", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"007-no-plan",
			);
			mkdirSync(specsDir, { recursive: true });
			// No implementation_plan.json file written — only a spec.md fallback.
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# VAT Feature\n\n## Overview\n\nUser story description.\n",
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].description).not.toContain("JSON parse error");
			// Should fall back to the spec.md Overview, not the error banner.
			expect(tasks[0].description).toContain("User story description");
		});

		it("should NOT flag an empty implementation_plan.json as JSON parse error", async () => {
			// An empty file is an in-flight write (the planner just truncated
			// before re-writing) — surfacing this transient state as a parse
			// error spammed the UI every refresh tick.
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"008-empty-plan",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(path.join(specsDir, "implementation_plan.json"), "");
			writeFileSync(
				path.join(specsDir, "spec.md"),
				"# Empty Plan\n\n## Overview\n\nUser story content.\n",
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].description).not.toContain("JSON parse error");
		});

		it("should flag a truly malformed implementation_plan.json", async () => {
			// Sanity check: actual JSON syntax errors must still surface so the
			// user has something to act on.
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"009-bad-plan",
			);
			mkdirSync(specsDir, { recursive: true });
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				'{ "feature": "broken", ',
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();
			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks).toHaveLength(1);
			// The "__JSON_ERROR__:" marker prefix is what the TaskCard /
			// TaskMetadata renderers key off of to swap in the localised error
			// banner; everything after it is the real JSON.parse message.
			expect(tasks[0].description).toMatch(/^__JSON_ERROR__:/);
		});

		it("should determine status as backlog when no subtasks completed", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"002-pending",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Pending Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "backlog",
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{ id: "subtask-1", description: "Subtask 1", status: "pending" },
							{ id: "subtask-2", description: "Subtask 2", status: "pending" },
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].status).toBe("backlog");
		});

		it("should determine status as ai_review when all subtasks completed", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"003-complete",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Complete Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "ai_review",
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{
								id: "subtask-1",
								description: "Subtask 1",
								status: "completed",
							},
							{
								id: "subtask-2",
								description: "Subtask 2",
								status: "completed",
							},
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].status).toBe("ai_review");
		});

		it("should determine status as human_review when plan status is human_review", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"004-rejected",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Rejected Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "human_review",
				reviewReason: "qa_rejected",
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{
								id: "subtask-1",
								description: "Subtask 1",
								status: "completed",
							},
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].status).toBe("human_review");
		});

		it("should determine reviewReason from plan when status is human_review", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"005-approved",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Approved Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "human_review",
				reviewReason: "completed",
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{
								id: "subtask-1",
								description: "Subtask 1",
								status: "completed",
							},
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].status).toBe("human_review");
			expect(tasks[0].reviewReason).toBe("completed");
		});

		it("should determine status as done when plan status is explicitly done", async () => {
			// User explicitly marking task as done via drag-and-drop sets status to done
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"006-done",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Done Feature",
				workflow_type: "feature",
				services_involved: [],
				status: "done", // Explicitly set by user
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{
								id: "subtask-1",
								description: "Subtask 1",
								status: "completed",
							},
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].status).toBe("done");
		});
	});

	describe("persistence", () => {
		it("should load existing data on construction", async () => {
			// Create store file manually
			const storePath = path.join(USER_DATA_PATH, "store", "projects.json");
			writeFileSync(
				storePath,
				JSON.stringify({
					projects: [
						{
							id: "test-id-123",
							name: "Preexisting Project",
							path: "/test/path",
							autoBuildPath: "",
							settings: {
								model: "sonnet",
								memoryBackend: "file",
								linearSync: false,
								notifications: {
									onTaskComplete: true,
									onTaskFailed: true,
									onReviewNeeded: true,
									sound: false,
								},
								graphitiMcpEnabled: true,
								graphitiMcpUrl: "http://localhost:8000/mcp/",
							},
							createdAt: "2024-01-01T00:00:00Z",
							updatedAt: "2024-01-01T00:00:00Z",
						},
					],
					settings: {},
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const projects = store.getProjects();

			expect(projects).toHaveLength(1);
			expect(projects[0].id).toBe("test-id-123");
			expect(projects[0].createdAt).toBeInstanceOf(Date);
		});

		it("should handle corrupted store file gracefully", async () => {
			// Create corrupted store file
			const storePath = path.join(USER_DATA_PATH, "store", "projects.json");
			writeFileSync(storePath, "not valid json {{{");

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const projects = store.getProjects();

			expect(projects).toEqual([]);
		});
	});

	describe("archiveTasks - multi-location handling", () => {
		it("should archive task from main specs directory only", async () => {
			// Create spec directory in main location only
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"001-test-task",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Test Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const result = store.archiveTasks(project.id, ["001-test-task"], "1.0.0");

			expect(result).toBe(true);

			// Verify metadata was created with archive info
			const metadataPath = path.join(specsDir, "task_metadata.json");
			expect(existsSync(metadataPath)).toBe(true);

			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
			expect(metadata.archivedAt).toBeDefined();
			expect(metadata.archivedInVersion).toBe("1.0.0");
		});

		it("should archive task from BOTH main and worktree locations", async () => {
			// Create spec directory in main location
			const mainSpecsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"002-multi-location",
			);
			mkdirSync(mainSpecsDir, { recursive: true });

			// Create spec directory in worktree location
			// Worktree path: .workpilot/worktrees/tasks/<worktreeName>/.workpilot/specs/<taskId>
			const worktreeDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"worktrees",
				"tasks",
				"my-worktree",
				".workpilot",
				"specs",
				"002-multi-location",
			);
			mkdirSync(worktreeDir, { recursive: true });

			const plan = {
				feature: "Multi-Location Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(mainSpecsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(worktreeDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const result = store.archiveTasks(
				project.id,
				["002-multi-location"],
				"2.0.0",
			);

			expect(result).toBe(true);

			// Verify metadata was created in BOTH locations
			const mainMetadataPath = path.join(mainSpecsDir, "task_metadata.json");
			const worktreeMetadataPath = path.join(worktreeDir, "task_metadata.json");

			expect(existsSync(mainMetadataPath)).toBe(true);
			expect(existsSync(worktreeMetadataPath)).toBe(true);

			const mainMetadata = JSON.parse(readFileSync(mainMetadataPath, "utf-8"));
			const worktreeMetadata = JSON.parse(
				readFileSync(worktreeMetadataPath, "utf-8"),
			);

			expect(mainMetadata.archivedAt).toBeDefined();
			expect(mainMetadata.archivedInVersion).toBe("2.0.0");
			expect(worktreeMetadata.archivedAt).toBeDefined();
			expect(worktreeMetadata.archivedInVersion).toBe("2.0.0");
		});

		it("should handle task that exists only in worktree", async () => {
			// Create spec directory ONLY in worktree location (not in main)
			const worktreeDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"worktrees",
				"tasks",
				"only-worktree",
				".workpilot",
				"specs",
				"003-worktree-only",
			);
			mkdirSync(worktreeDir, { recursive: true });

			const plan = {
				feature: "Worktree Only Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(worktreeDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const result = store.archiveTasks(
				project.id,
				["003-worktree-only"],
				"1.0.0",
			);

			expect(result).toBe(true);

			// Verify metadata was created in worktree
			const metadataPath = path.join(worktreeDir, "task_metadata.json");
			expect(existsSync(metadataPath)).toBe(true);

			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
			expect(metadata.archivedAt).toBeDefined();
		});

		it("should skip non-existent task gracefully", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			// Create .workpilot directory so project is recognized
			mkdirSync(path.join(TEST_PROJECT_PATH, ".workpilot"), {
				recursive: true,
			});

			const project = store.addProject(TEST_PROJECT_PATH);
			// Task doesn't exist anywhere
			const result = store.archiveTasks(project.id, ["nonexistent-task"]);

			// Should return true (no errors) since missing tasks are skipped
			expect(result).toBe(true);
		});

		it("should reject path traversal attempts in taskId", async () => {
			// Create a valid spec dir
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"valid-task",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = { feature: "Test", phases: [] };
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			// Try various path traversal attacks
			const maliciousIds = [
				"../../../etc/passwd",
				"..\\..\\windows\\system32",
				"task/../../../secret",
				".",
				"..",
				"task\0.json",
			];

			for (const maliciousId of maliciousIds) {
				// These should be rejected and not cause any file operations
				const result = store.archiveTasks(project.id, [maliciousId]);
				// Should return true since invalid IDs are skipped, not treated as errors
				expect(result).toBe(true);
			}
		});

		it("should return false for non-existent project", async () => {
			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const result = store.archiveTasks("nonexistent-project-id", [
				"some-task",
			]);

			expect(result).toBe(false);
		});
	});

	describe("unarchiveTasks - multi-location handling", () => {
		it("should unarchive task from BOTH main and worktree locations", async () => {
			// Create archived task in both locations
			const mainSpecsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"004-unarchive-test",
			);
			mkdirSync(mainSpecsDir, { recursive: true });

			const worktreeDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"worktrees",
				"tasks",
				"unarchive-worktree",
				".workpilot",
				"specs",
				"004-unarchive-test",
			);
			mkdirSync(worktreeDir, { recursive: true });

			const plan = {
				feature: "Unarchive Test",
				phases: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
			};

			const archivedMetadata = {
				archivedAt: "2024-06-01T00:00:00Z",
				archivedInVersion: "1.0.0",
			};

			// Create plan and archived metadata in both locations
			writeFileSync(
				path.join(mainSpecsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(mainSpecsDir, "task_metadata.json"),
				JSON.stringify(archivedMetadata),
			);
			writeFileSync(
				path.join(worktreeDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(worktreeDir, "task_metadata.json"),
				JSON.stringify(archivedMetadata),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const result = store.unarchiveTasks(project.id, ["004-unarchive-test"]);

			expect(result).toBe(true);

			// Verify archivedAt was removed from BOTH locations
			const mainMetadata = JSON.parse(
				readFileSync(path.join(mainSpecsDir, "task_metadata.json"), "utf-8"),
			);
			const worktreeMetadata = JSON.parse(
				readFileSync(path.join(worktreeDir, "task_metadata.json"), "utf-8"),
			);

			expect(mainMetadata.archivedAt).toBeUndefined();
			expect(mainMetadata.archivedInVersion).toBeUndefined();
			expect(worktreeMetadata.archivedAt).toBeUndefined();
			expect(worktreeMetadata.archivedInVersion).toBeUndefined();
		});
	});

	describe("cache invalidation", () => {
		it("should invalidate cache after archiveTasks", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"005-cache-test",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Cache Test Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{ id: "subtask-1", description: "Test", status: "pending" },
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			// First call should populate cache
			const tasksBefore = store.getTasks(project.id);
			expect(tasksBefore).toHaveLength(1);
			expect(tasksBefore[0].metadata?.archivedAt).toBeUndefined();

			// Archive the task
			store.archiveTasks(project.id, ["005-cache-test"]);

			// After archiving, cache should be invalidated and getTasks should return updated data
			const tasksAfter = store.getTasks(project.id);
			expect(tasksAfter[0].metadata?.archivedAt).toBeDefined();
		});

		it("should return fresh data after invalidateTasksCache is called", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"006-invalidate-test",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "Initial Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);

			// First call should populate cache
			const tasksBefore = store.getTasks(project.id);
			expect(tasksBefore[0].title).toBe("Initial Feature");

			// Modify the file directly (simulating external change)
			const updatedPlan = { ...plan, feature: "Updated Feature" };
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(updatedPlan),
			);

			// Without invalidation, should still return cached data
			const tasksCached = store.getTasks(project.id);
			expect(tasksCached[0].title).toBe("Initial Feature");

			// Invalidate cache
			store.invalidateTasksCache(project.id);

			// Now should return fresh data
			const tasksAfterInvalidation = store.getTasks(project.id);
			expect(tasksAfterInvalidation[0].title).toBe("Updated Feature");
		});
	});

	describe("loadTaskMetadata - acceptanceCriteria fallback", () => {
		it("should load acceptanceCriteria from task_metadata.json when present", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"008-ac-from-metadata",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "AC from Metadata",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(specsDir, "task_metadata.json"),
				JSON.stringify({ acceptanceCriteria: ["Criterion A", "Criterion B"] }),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].metadata?.acceptanceCriteria).toEqual([
				"Criterion A",
				"Criterion B",
			]);
		});

		it("should fall back to requirements.json when task_metadata.json has no acceptanceCriteria", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"009-ac-fallback",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "AC Fallback",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			// Old-format task_metadata.json without acceptanceCriteria
			writeFileSync(
				path.join(specsDir, "task_metadata.json"),
				JSON.stringify({ azureDevopsId: 1234 }),
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({
					acceptance_criteria: ["L'utilisateur peut se connecter", "L'utilisateur peut se déconnecter"],
				}),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].metadata?.acceptanceCriteria).toEqual([
				"L'utilisateur peut se connecter",
				"L'utilisateur peut se déconnecter",
			]);
		});

		it("should fall back to requirements.json when task_metadata.json is absent", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"010-ac-no-metadata",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "AC No Metadata",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(specsDir, "requirements.json"),
				JSON.stringify({ acceptance_criteria: ["Critère unique"] }),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].metadata?.acceptanceCriteria).toEqual(["Critère unique"]);
		});

		it("should have undefined acceptanceCriteria when neither source has it", async () => {
			const specsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"011-ac-absent",
			);
			mkdirSync(specsDir, { recursive: true });

			const plan = {
				feature: "No AC",
				workflow_type: "feature",
				services_involved: [],
				phases: [],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};
			writeFileSync(
				path.join(specsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			expect(tasks[0].metadata?.acceptanceCriteria).toBeUndefined();
		});
	});

	describe("getTasks - worktree deduplication", () => {
		it("should not duplicate tasks that exist in both main and worktree", async () => {
			// Create same task in both main and worktree
			const mainSpecsDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"specs",
				"007-dedupe-test",
			);
			mkdirSync(mainSpecsDir, { recursive: true });

			const worktreeDir = path.join(
				TEST_PROJECT_PATH,
				".workpilot",
				"worktrees",
				"tasks",
				"dedupe-worktree",
				".workpilot",
				"specs",
				"007-dedupe-test",
			);
			mkdirSync(worktreeDir, { recursive: true });

			const plan = {
				feature: "Dedupe Test Feature",
				workflow_type: "feature",
				services_involved: [],
				phases: [
					{
						phase: 1,
						name: "Phase 1",
						type: "implementation",
						subtasks: [
							{ id: "subtask-1", description: "Test", status: "pending" },
						],
					},
				],
				final_acceptance: [],
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				spec_file: "spec.md",
			};

			writeFileSync(
				path.join(mainSpecsDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);
			writeFileSync(
				path.join(worktreeDir, "implementation_plan.json"),
				JSON.stringify(plan),
			);

			const { ProjectStore } = await import("../project-store");
			const store = new ProjectStore();

			const project = store.addProject(TEST_PROJECT_PATH);
			const tasks = store.getTasks(project.id);

			// Should only return ONE task, not two
			const matchingTasks = tasks.filter((t) => t.specId === "007-dedupe-test");
			expect(matchingTasks).toHaveLength(1);
		});
	});
});
