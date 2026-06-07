/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Task, VisualProofRun } from "../../../shared/types";
import { TaskVisualProof } from "./TaskVisualProof";

const initialProof: VisualProofRun = {
	id: "visual-proof-1",
	status: "passed",
	taskId: "task-1",
	specId: "spec-1",
	prUrl: "https://github.com/acme/widgets/pull/42",
	provider: "local-web",
	targetKind: "web",
	isolated: false,
	providerDetails: "Local web preview through the app emulator.",
	framework: "vite",
	appUrl: "http://localhost:5173",
	commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-1",
	screenshots: [
		{
			label: "Home page",
			relativePath: "specs/visual-proofs/spec-1/run/home.png",
			absolutePath: "C:\\tmp\\home.png",
			url: "https://github.com/acme/widgets/blob/branch/home.png?raw=1",
			width: 1440,
			height: 1000,
			capturedAt: "2026-06-05T09:00:00.000Z",
		},
	],
	startedAt: "2026-06-05T08:59:00.000Z",
	completedAt: "2026-06-05T09:00:00.000Z",
};

const task: Task = {
	id: "task-1",
	specId: "spec-1",
	projectId: "project-1",
	title: "Task with proof",
	description: "Task description",
	status: "done",
	subtasks: [],
	logs: [],
	createdAt: new Date("2026-06-05T08:00:00.000Z"),
	updatedAt: new Date("2026-06-05T09:00:00.000Z"),
	metadata: {
		visualProof: initialProof,
	},
};

const mockOpenExternal = vi.fn();
const mockRunVisualProof = vi.fn();
const mockInvoke = vi.fn();
const mockGetVisualProofStatus = vi.fn();
const mockOnVisualProofRunning = vi.fn();

Object.defineProperty(window, "electronAPI", {
	value: {
		openExternal: mockOpenExternal,
		runVisualProof: mockRunVisualProof,
		invoke: mockInvoke,
		getVisualProofStatus: mockGetVisualProofStatus,
		onVisualProofRunning: mockOnVisualProofRunning,
	},
	writable: true,
});

describe("TaskVisualProof", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetVisualProofStatus.mockResolvedValue({
			success: true,
			data: { running: false },
		});
		mockOnVisualProofRunning.mockReturnValue(() => {
			/* unsubscribe noop */
		});
		mockInvoke.mockResolvedValue({
			success: true,
			data: { base64: "cG5n", mimeType: "image/png" },
		});
		mockRunVisualProof.mockResolvedValue({
			success: true,
			data: {
				...initialProof,
				id: "visual-proof-2",
				status: "skipped",
				screenshots: [],
			},
		});
	});

	it("renders visual proof metadata and screenshots", () => {
		render(<TaskVisualProof task={task} />);

		expect(screen.getByText("PR visual proof")).toBeInTheDocument();
		expect(screen.getByText("passed")).toBeInTheDocument();
		expect(screen.getByText("local-web")).toBeInTheDocument();
		expect(screen.getByAltText("Home page")).toHaveAttribute(
			"src",
			initialProof.screenshots[0].url,
		);
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("loads local screenshots through IPC instead of file URLs", async () => {
		const localProof: VisualProofRun = {
			...initialProof,
			screenshots: [
				{
					...initialProof.screenshots[0],
					relativePath: "visual-proof/run/desktop.png",
					absolutePath: "C:\\tmp\\visual-proof\\desktop.png",
					url: undefined,
				},
			],
		};

		render(
			<TaskVisualProof
				task={{
					...task,
					metadata: { ...task.metadata, visualProof: localProof },
				}}
			/>,
		);

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
				"C:\\tmp\\visual-proof\\desktop.png",
			);
		});
		expect(screen.getByAltText("Home page")).toHaveAttribute(
			"src",
			"data:image/png;base64,cG5n",
		);
		expect(screen.getByAltText("Home page")).not.toHaveAttribute(
			"src",
			expect.stringContaining("file://"),
		);
	});

	it("restores the running spinner when a run is already in progress", async () => {
		mockGetVisualProofStatus.mockResolvedValue({
			success: true,
			data: { running: true },
		});

		render(<TaskVisualProof task={task} />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
		});
		expect(mockOnVisualProofRunning).toHaveBeenCalled();
	});

	it("can retry the visual proof run", async () => {
		render(<TaskVisualProof task={task} />);

		fireEvent.click(screen.getByRole("button", { name: /retry/i }));

		await waitFor(() => {
			expect(mockRunVisualProof).toHaveBeenCalledWith("task-1");
		});
		expect(await screen.findByText("skipped")).toBeInTheDocument();
	});
});
