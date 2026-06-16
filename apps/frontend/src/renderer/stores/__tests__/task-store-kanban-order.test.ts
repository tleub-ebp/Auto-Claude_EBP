/**
 * Unit tests for Task Store — Kanban Order Management
 * Tests task ordering, column reordering, drag-and-drop, and persistence
 * Improvement 6.1: Add tests for critical Zustand stores (task-store kanban order)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import { useTaskStore } from "../task-store";

// Helper to create test tasks
function createTestTask(overrides: Partial<Task> = {}): Task {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
		specId: "test-spec",
		projectId: "project-1",
		title: "Test Task",
		description: "Test description",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe("Task Store — Kanban Order Management", () => {
	beforeEach(() => {
		useTaskStore.setState({
			tasks: [],
			selectedTaskId: null,
			isLoading: false,
			error: null,
			taskOrder: null,
		});
		localStorage.clear();
	});

	afterEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	describe("setTaskOrder", () => {
		it("should set task order state", () => {
			const order = {
				backlog: ["t1", "t2"],
				queue: [],
				in_progress: ["t3"],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};

			useTaskStore.getState().setTaskOrder(order);

			expect(useTaskStore.getState().taskOrder).toEqual(order);
		});

		it("should replace existing task order", () => {
			const order1 = {
				backlog: ["t1"],
				queue: [],
				in_progress: [],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};
			const order2 = {
				backlog: ["t2", "t3"],
				queue: [],
				in_progress: [],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};

			useTaskStore.getState().setTaskOrder(order1);
			useTaskStore.getState().setTaskOrder(order2);

			expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["t2", "t3"]);
		});
	});

	describe("reorderTasksInColumn", () => {
		it("should reorder tasks within a column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2", "t3"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore.getState().reorderTasksInColumn("backlog", "t3", "t1");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["t3", "t1", "t2"]);
		});

		it("should handle reordering to end of column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2", "t3"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore.getState().reorderTasksInColumn("backlog", "t1", "t3");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["t2", "t3", "t1"]);
		});

		it("should not modify state when taskOrder is null", () => {
			useTaskStore.setState({ taskOrder: null });

			useTaskStore.getState().reorderTasksInColumn("backlog", "t1", "t2");

			expect(useTaskStore.getState().taskOrder).toBeNull();
		});

		it("should not modify state when activeId is not in column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore
				.getState()
				.reorderTasksInColumn("backlog", "nonexistent", "t1");

			expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["t1", "t2"]);
		});

		it("should not modify state when overId is not in column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore
				.getState()
				.reorderTasksInColumn("backlog", "t1", "nonexistent");

			expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["t1", "t2"]);
		});

		it("should not affect other columns", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2"],
					queue: ["t3"],
					in_progress: ["t4"],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore.getState().reorderTasksInColumn("backlog", "t2", "t1");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["t2", "t1"]);
			expect(order?.queue).toEqual(["t3"]);
			expect(order?.in_progress).toEqual(["t4"]);
		});
	});

	describe("moveTaskToColumnTop", () => {
		it("should move task to top of target column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2"],
					queue: [],
					in_progress: ["t3", "t4"],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore
				.getState()
				.moveTaskToColumnTop("t2", "in_progress", "backlog");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["t1"]);
			expect(order?.in_progress).toEqual(["t2", "t3", "t4"]);
		});

		it("should remove task from source column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1", "t2", "t3"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore
				.getState()
				.moveTaskToColumnTop("t2", "in_progress", "backlog");

			expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["t1", "t3"]);
		});

		it("should handle moving to empty column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: ["t1"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			useTaskStore
				.getState()
				.moveTaskToColumnTop("t1", "in_progress", "backlog");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual([]);
			expect(order?.in_progress).toEqual(["t1"]);
		});

		it("should deduplicate task if already in target column", () => {
			useTaskStore.setState({
				taskOrder: {
					backlog: [],
					queue: [],
					in_progress: ["t1", "t2"],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			// Move t2 to top of same column (no source removal needed)
			useTaskStore.getState().moveTaskToColumnTop("t2", "in_progress");

			expect(useTaskStore.getState().taskOrder?.in_progress).toEqual([
				"t2",
				"t1",
			]);
		});

		it("should not modify state when taskOrder is null", () => {
			useTaskStore.setState({ taskOrder: null });

			useTaskStore
				.getState()
				.moveTaskToColumnTop("t1", "in_progress", "backlog");

			expect(useTaskStore.getState().taskOrder).toBeNull();
		});
	});

	describe("addTask with taskOrder", () => {
		it("should add new task ID to top of its status column in taskOrder", () => {
			useTaskStore.setState({
				tasks: [],
				taskOrder: {
					backlog: ["existing-1"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			const newTask = createTestTask({ id: "new-task", status: "backlog" });
			useTaskStore.getState().addTask(newTask);

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["new-task", "existing-1"]);
		});

		it("should not duplicate task ID in column", () => {
			useTaskStore.setState({
				tasks: [],
				taskOrder: {
					backlog: ["task-1", "task-2"],
					queue: [],
					in_progress: [],
					ai_review: [],
					human_review: [],
					build_failed: [],
					done: [],
					pr_created: [],
					error: [],
				},
			});

			// Add task that already exists in column
			const task = createTestTask({ id: "task-1", status: "backlog" });
			useTaskStore.getState().addTask(task);

			expect(useTaskStore.getState().taskOrder?.backlog).toEqual([
				"task-1",
				"task-2",
			]);
		});

		it("should work when taskOrder is null", () => {
			useTaskStore.setState({ tasks: [], taskOrder: null });

			const task = createTestTask({ id: "new-task", status: "backlog" });
			useTaskStore.getState().addTask(task);

			// taskOrder should remain null
			expect(useTaskStore.getState().taskOrder).toBeNull();
			// Task should still be added
			expect(useTaskStore.getState().tasks).toHaveLength(1);
		});
	});

	describe("loadTaskOrder", () => {
		it("should load task order from localStorage", () => {
			const storedOrder = {
				backlog: ["t1", "t2"],
				queue: [],
				in_progress: ["t3"],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};
			localStorage.setItem(
				"task-order-state-project-1",
				JSON.stringify(storedOrder),
			);

			useTaskStore.getState().loadTaskOrder("project-1");

			expect(useTaskStore.getState().taskOrder).toEqual(storedOrder);
		});

		it("should create empty order when no stored data exists", () => {
			useTaskStore.getState().loadTaskOrder("new-project");

			const order = useTaskStore.getState().taskOrder;
			expect(order).toBeDefined();
			expect(order?.backlog).toEqual([]);
			expect(order?.in_progress).toEqual([]);
			expect(order?.done).toEqual([]);
		});

		it("should handle invalid JSON in localStorage gracefully", () => {
			localStorage.setItem("task-order-state-project-1", "not valid json");

			useTaskStore.getState().loadTaskOrder("project-1");

			// Should fallback to empty order
			const order = useTaskStore.getState().taskOrder;
			expect(order).toBeDefined();
			expect(order?.backlog).toEqual([]);
		});

		it("should handle non-object data gracefully", () => {
			localStorage.setItem(
				"task-order-state-project-1",
				JSON.stringify([1, 2, 3]),
			);

			useTaskStore.getState().loadTaskOrder("project-1");

			// Array is invalid, should reset to empty order
			const order = useTaskStore.getState().taskOrder;
			expect(order).toBeDefined();
			expect(order?.backlog).toEqual([]);
		});

		it("should handle partial data by merging with empty order", () => {
			const partialOrder = { backlog: ["t1"], in_progress: ["t2"] };
			localStorage.setItem(
				"task-order-state-project-1",
				JSON.stringify(partialOrder),
			);

			useTaskStore.getState().loadTaskOrder("project-1");

			const order = useTaskStore.getState().taskOrder;
			expect(order?.backlog).toEqual(["t1"]);
			expect(order?.in_progress).toEqual(["t2"]);
			expect(order?.queue).toEqual([]);
			expect(order?.done).toEqual([]);
		});

		it("should validate column arrays contain only strings", () => {
			const badOrder = { backlog: [1, 2, 3], in_progress: ["valid"] };
			localStorage.setItem(
				"task-order-state-project-1",
				JSON.stringify(badOrder),
			);

			useTaskStore.getState().loadTaskOrder("project-1");

			const order = useTaskStore.getState().taskOrder;
			// backlog should fall back to empty (non-string items)
			expect(order?.backlog).toEqual([]);
			expect(order?.in_progress).toEqual(["valid"]);
		});
	});

	describe("saveTaskOrder", () => {
		it("should save task order to localStorage", () => {
			const order = {
				backlog: ["t1"],
				queue: [],
				in_progress: ["t2"],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};
			useTaskStore.setState({ taskOrder: order });

			const result = useTaskStore.getState().saveTaskOrder("project-1");

			expect(result).toBe(true);
			const stored = JSON.parse(
				localStorage.getItem("task-order-state-project-1") ?? "{}",
			);
			expect(stored).toEqual(order);
		});

		it("should return false when taskOrder is null", () => {
			useTaskStore.setState({ taskOrder: null });

			const result = useTaskStore.getState().saveTaskOrder("project-1");

			expect(result).toBe(false);
		});

		it("should use project-specific key", () => {
			const order = {
				backlog: ["a"],
				queue: [],
				in_progress: [],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};
			useTaskStore.setState({ taskOrder: order });

			useTaskStore.getState().saveTaskOrder("my-project");

			expect(localStorage.getItem("task-order-state-my-project")).toBeDefined();
			expect(localStorage.getItem("task-order-state-other")).toBeNull();
		});
	});

	describe("clearTaskOrder", () => {
		it("should clear task order from state and localStorage", () => {
			const order = {
				backlog: ["t1"],
				queue: [],
				in_progress: [],
				ai_review: [],
				human_review: [],
				build_failed: [],
				done: [],
				pr_created: [],
				error: [],
			};
			useTaskStore.setState({ taskOrder: order });
			localStorage.setItem("task-order-state-project-1", JSON.stringify(order));

			useTaskStore.getState().clearTaskOrder("project-1");

			expect(useTaskStore.getState().taskOrder).toBeNull();
			expect(localStorage.getItem("task-order-state-project-1")).toBeNull();
		});
	});

	describe("Task status listener registration", () => {
		it("should register and unregister status change listeners", () => {
			const listener = vi.fn();
			const unregister = useTaskStore
				.getState()
				.registerTaskStatusChangeListener(listener);

			expect(typeof unregister).toBe("function");

			// Unregister should work without error
			unregister();
		});

		it("should notify listeners on task status change", async () => {
			const listener = vi.fn();
			useTaskStore.setState({
				tasks: [createTestTask({ id: "task-1", status: "backlog" })],
			});

			useTaskStore.getState().registerTaskStatusChangeListener(listener);
			useTaskStore.getState().updateTaskStatus("task-1", "in_progress");

			// Listener is called via queueMicrotask, so wait a tick
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(listener).toHaveBeenCalledWith("task-1", "backlog", "in_progress");
		});

		it("should not notify after unregistering", async () => {
			const listener = vi.fn();
			useTaskStore.setState({
				tasks: [createTestTask({ id: "task-1", status: "backlog" })],
			});

			const unregister = useTaskStore
				.getState()
				.registerTaskStatusChangeListener(listener);
			unregister();

			useTaskStore.getState().updateTaskStatus("task-1", "in_progress");
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(listener).not.toHaveBeenCalled();
		});
	});
});
