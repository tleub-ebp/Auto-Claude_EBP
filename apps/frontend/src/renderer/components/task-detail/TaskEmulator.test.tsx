/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { Project } from "../../../shared/types";
import { useAppEmulatorStore } from "../../stores/app-emulator-store";
import { TaskEmulator } from "./TaskEmulator";

const project: Project = {
	id: "project-1",
	name: "Demo project",
	path: "C:\\Repos\\Demo",
	autoBuildPath: ".workpilot",
	settings: {
		model: "claude",
		memoryBackend: "file",
		linearSync: false,
		notifications: {
			onTaskComplete: false,
			onTaskFailed: false,
			onReviewNeeded: false,
			sound: false,
		},
		graphitiMcpEnabled: false,
	},
	createdAt: new Date("2026-06-05T08:00:00.000Z"),
	updatedAt: new Date("2026-06-05T08:00:00.000Z"),
};

const noopUnsubscribe = () => {
	/* noop */
};

const mockDetectAppProject = vi.fn();
const mockStartAppEmulator = vi.fn();
const mockStopAppEmulator = vi.fn();
const mockGetWorktreeStatus = vi.fn();

Object.defineProperty(window, "electronAPI", {
	value: {
		getAppEmulatorStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { running: false },
		}),
		getWorktreeStatus: mockGetWorktreeStatus,
		detectAppProject: mockDetectAppProject,
		startAppEmulator: mockStartAppEmulator,
		stopAppEmulator: mockStopAppEmulator,
		openExternal: vi.fn(),
		onAppEmulatorStatus: vi.fn(() => noopUnsubscribe),
		onAppEmulatorReady: vi.fn(() => noopUnsubscribe),
		onAppEmulatorOutput: vi.fn(() => noopUnsubscribe),
		onAppEmulatorError: vi.fn(() => noopUnsubscribe),
		onAppEmulatorStopped: vi.fn(() => noopUnsubscribe),
		onAppEmulatorConfig: vi.fn(() => noopUnsubscribe),
	},
	writable: true,
});

describe("TaskEmulator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useAppEmulatorStore.getState().reset();
		mockGetWorktreeStatus.mockResolvedValue({
			success: true,
			data: { exists: false },
		});
		mockDetectAppProject.mockResolvedValue({
			success: true,
			data: {
				type: "web",
				framework: "vite",
				startCommand: "pnpm dev",
				port: 5173,
				isWeb: true,
				projectDir: project.path,
			},
		});
		mockStartAppEmulator.mockResolvedValue({ success: true });
	});

	it("starts the emulator for the task project", async () => {
		render(<TaskEmulator taskId="task-1" project={project} />);

		fireEvent.click(screen.getByRole("button", { name: /start server/i }));

		await waitFor(() => {
			expect(mockDetectAppProject).toHaveBeenCalledWith(project.path);
			expect(mockStartAppEmulator).toHaveBeenCalledWith(
				expect.objectContaining({
					framework: "vite",
					projectDir: project.path,
				}),
			);
		});
	});

	it("prefers the task worktree path when it exists", async () => {
		const worktreePath = "C:\\Repos\\Demo\\.worktrees\\spec-1";
		mockGetWorktreeStatus.mockResolvedValue({
			success: true,
			data: { exists: true, worktreePath },
		});
		render(<TaskEmulator taskId="task-1" project={project} />);

		await screen.findByText(new RegExp(worktreePath.replaceAll("\\", "\\\\")));
		fireEvent.click(screen.getByRole("button", { name: /start server/i }));

		await waitFor(() => {
			expect(mockDetectAppProject).toHaveBeenCalledWith(worktreePath);
		});
	});

	it("shows an empty state when the task project cannot be resolved", () => {
		render(<TaskEmulator taskId="task-1" />);

		expect(screen.getByText("Project not found")).toBeInTheDocument();
	});
});
