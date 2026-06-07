/**
 * Unit tests for Project Store — Core CRUD Operations
 * Tests project creation, removal, update, selection, and loading
 * Improvement 6.1: Add tests for critical Zustand stores (project-store CRUD)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSettings } from "../../shared/types";
import {
	updateProjectSettings,
	useProjectStore,
} from "../stores/project-store";

// Helper to create test projects
function createTestProject(overrides: Partial<Project> = {}): Project {
	const defaultSettings: ProjectSettings = {
		model: "claude-3-opus",
		memoryBackend: "graphiti",
		linearSync: false,
		notifications: {
			onTaskComplete: true,
			onTaskFailed: true,
			onReviewNeeded: true,
			sound: false,
		},
		graphitiMcpEnabled: false,
	};

	return {
		id: `project-${Date.now()}-${Math.random().toString(36).substring(7)}`,
		name: "Test Project",
		path: "/path/to/test-project",
		autoBuildPath: ".workpilot",
		settings: defaultSettings,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe("Project Store — Core CRUD Operations", () => {
	beforeEach(() => {
		useProjectStore.setState({
			projects: [],
			selectedProjectId: null,
			isLoading: false,
			error: null,
			openProjectIds: [],
			activeProjectId: null,
			tabOrder: [],
		});
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("setProjects", () => {
		it("should set projects array", () => {
			const projects = [
				createTestProject({ id: "p1", name: "Project 1" }),
				createTestProject({ id: "p2", name: "Project 2" }),
			];

			useProjectStore.getState().setProjects(projects);

			expect(useProjectStore.getState().projects).toHaveLength(2);
			expect(useProjectStore.getState().projects[0].name).toBe("Project 1");
		});

		it("should replace existing projects", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "old" })],
			});

			useProjectStore
				.getState()
				.setProjects([createTestProject({ id: "new" })]);

			expect(useProjectStore.getState().projects).toHaveLength(1);
			expect(useProjectStore.getState().projects[0].id).toBe("new");
		});

		it("should handle empty array", () => {
			useProjectStore.setState({ projects: [createTestProject()] });

			useProjectStore.getState().setProjects([]);

			expect(useProjectStore.getState().projects).toHaveLength(0);
		});
	});

	describe("addProject", () => {
		it("should add project to empty list", () => {
			const project = createTestProject({ id: "p1" });

			useProjectStore.getState().addProject(project);

			expect(useProjectStore.getState().projects).toHaveLength(1);
			expect(useProjectStore.getState().projects[0].id).toBe("p1");
		});

		it("should append project to existing list", () => {
			useProjectStore.setState({ projects: [createTestProject({ id: "p1" })] });

			useProjectStore.getState().addProject(createTestProject({ id: "p2" }));

			expect(useProjectStore.getState().projects).toHaveLength(2);
			expect(useProjectStore.getState().projects[1].id).toBe("p2");
		});
	});

	describe("removeProject", () => {
		it("should remove project by id", () => {
			useProjectStore.setState({
				projects: [
					createTestProject({ id: "p1" }),
					createTestProject({ id: "p2" }),
				],
			});

			useProjectStore.getState().removeProject("p1");

			expect(useProjectStore.getState().projects).toHaveLength(1);
			expect(useProjectStore.getState().projects[0].id).toBe("p2");
		});

		it("should clear selectedProjectId when removing selected project", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
				selectedProjectId: "p1",
			});

			useProjectStore.getState().removeProject("p1");

			expect(useProjectStore.getState().selectedProjectId).toBeNull();
		});

		it("should not affect selectedProjectId when removing other project", () => {
			useProjectStore.setState({
				projects: [
					createTestProject({ id: "p1" }),
					createTestProject({ id: "p2" }),
				],
				selectedProjectId: "p2",
			});

			useProjectStore.getState().removeProject("p1");

			expect(useProjectStore.getState().selectedProjectId).toBe("p2");
		});

		it("should handle removing non-existent project", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
			});

			useProjectStore.getState().removeProject("nonexistent");

			expect(useProjectStore.getState().projects).toHaveLength(1);
		});
	});

	describe("updateProject", () => {
		it("should update project by merging updates", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1", name: "Original" })],
			});

			useProjectStore
				.getState()
				.updateProject("p1", { name: "Updated Name" } as never);

			const project = useProjectStore.getState().projects[0];
			expect(project.name).toBe("Updated Name");
		});

		it("should not affect other projects", () => {
			useProjectStore.setState({
				projects: [
					createTestProject({ id: "p1", name: "Project 1" }),
					createTestProject({ id: "p2", name: "Project 2" }),
				],
			});

			useProjectStore
				.getState()
				.updateProject("p1", { model: "new-model" } as never);

			expect(useProjectStore.getState().projects[1].name).toBe("Project 2");
		});
	});

	describe("updateProjectSettings (persisted)", () => {
		it("merges saved values into project.settings (not the top-level project)", async () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
			});

			const ok = await updateProjectSettings("p1", { tddMode: true });

			expect(ok).toBe(true);
			const project = useProjectStore.getState().projects[0];
			// The value must live inside project.settings so the settings dialog
			// (which reads project.settings) reflects the persisted toggle.
			expect(project.settings.tddMode).toBe(true);
			// Regression guard: it must NOT leak onto the top-level project object.
			expect(
				(project as unknown as { tddMode?: boolean }).tddMode,
			).toBeUndefined();
		});

		it("preserves other settings fields when updating one", async () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
			});

			await updateProjectSettings("p1", { tddMode: true });

			const project = useProjectStore.getState().projects[0];
			expect(project.settings.tddMode).toBe(true);
			expect(project.settings.model).toBe("claude-3-opus");
			expect(project.settings.notifications.onTaskComplete).toBe(true);
		});

		it("does not affect other projects", async () => {
			useProjectStore.setState({
				projects: [
					createTestProject({ id: "p1" }),
					createTestProject({ id: "p2" }),
				],
			});

			await updateProjectSettings("p1", { tddMode: true });

			const other = useProjectStore
				.getState()
				.projects.find((p) => p.id === "p2");
			expect(other?.settings.tddMode).toBeUndefined();
		});
	});

	describe("selectProject", () => {
		it("should set selected project id", () => {
			useProjectStore.getState().selectProject("p1");

			expect(useProjectStore.getState().selectedProjectId).toBe("p1");
		});

		it("should persist selection to localStorage", () => {
			useProjectStore.getState().selectProject("p1");

			expect(localStorage.getItem("lastSelectedProjectId")).toBe("p1");
		});

		it("should clear selection and localStorage with null", () => {
			useProjectStore.getState().selectProject("p1");
			useProjectStore.getState().selectProject(null);

			expect(useProjectStore.getState().selectedProjectId).toBeNull();
			expect(localStorage.getItem("lastSelectedProjectId")).toBeNull();
		});
	});

	describe("setLoading / setError", () => {
		it("should set loading state", () => {
			useProjectStore.getState().setLoading(true);
			expect(useProjectStore.getState().isLoading).toBe(true);

			useProjectStore.getState().setLoading(false);
			expect(useProjectStore.getState().isLoading).toBe(false);
		});

		it("should set and clear error", () => {
			useProjectStore.getState().setError("Something went wrong");
			expect(useProjectStore.getState().error).toBe("Something went wrong");

			useProjectStore.getState().setError(null);
			expect(useProjectStore.getState().error).toBeNull();
		});
	});

	describe("getSelectedProject", () => {
		it("should return undefined when no project selected", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
				selectedProjectId: null,
			});

			expect(useProjectStore.getState().getSelectedProject()).toBeUndefined();
		});

		it("should return selected project", () => {
			useProjectStore.setState({
				projects: [
					createTestProject({ id: "p1", name: "Project 1" }),
					createTestProject({ id: "p2", name: "Project 2" }),
				],
				selectedProjectId: "p2",
			});

			const selected = useProjectStore.getState().getSelectedProject();
			expect(selected?.name).toBe("Project 2");
		});

		it("should return undefined for non-existent selected id", () => {
			useProjectStore.setState({
				projects: [createTestProject({ id: "p1" })],
				selectedProjectId: "nonexistent",
			});

			expect(useProjectStore.getState().getSelectedProject()).toBeUndefined();
		});
	});

	describe("Multiple operations consistency", () => {
		it("should maintain consistency after add + select + remove sequence", () => {
			const p1 = createTestProject({ id: "p1", name: "First" });
			const p2 = createTestProject({ id: "p2", name: "Second" });
			const p3 = createTestProject({ id: "p3", name: "Third" });

			useProjectStore.getState().addProject(p1);
			useProjectStore.getState().addProject(p2);
			useProjectStore.getState().addProject(p3);
			useProjectStore.getState().selectProject("p2");

			expect(useProjectStore.getState().projects).toHaveLength(3);
			expect(useProjectStore.getState().selectedProjectId).toBe("p2");

			useProjectStore.getState().removeProject("p2");

			expect(useProjectStore.getState().projects).toHaveLength(2);
			expect(useProjectStore.getState().selectedProjectId).toBeNull();
			expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
				"p1",
				"p3",
			]);
		});

		it("should handle rapid setProjects calls", () => {
			for (let i = 0; i < 10; i++) {
				useProjectStore
					.getState()
					.setProjects([
						createTestProject({ id: `p-${i}`, name: `Project ${i}` }),
					]);
			}

			expect(useProjectStore.getState().projects).toHaveLength(1);
			expect(useProjectStore.getState().projects[0].id).toBe("p-9");
		});
	});
});
