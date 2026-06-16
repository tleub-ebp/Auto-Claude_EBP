/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskRunControls — la commande compacte Pause / Reprendre / Arrêter de la
 * barre d'action d'une tâche en cours. Vérifie les trois états de la pause
 * coopérative et le câblage vers pauseTask / resumeTask / onStop.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

vi.mock("../../hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("../../stores/task-store", () => ({
	pauseTask: vi.fn().mockResolvedValue(true),
	resumeTask: vi.fn().mockResolvedValue(true),
}));

import type { Task } from "../../../shared/types";
import { pauseTask, resumeTask } from "../../stores/task-store";
import { TooltipProvider } from "../ui/tooltip";
import { TaskRunControls } from "./TaskRunControls";

const mockPause = pauseTask as unknown as ReturnType<typeof vi.fn>;
const mockResume = resumeTask as unknown as ReturnType<typeof vi.fn>;

function makeTask(): Task {
	return { id: "task-1", metadata: {} } as unknown as Task;
}

function renderControls(props: Parameters<typeof TaskRunControls>[0]) {
	return render(
		<TooltipProvider>
			<TaskRunControls {...props} />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("TaskRunControls", () => {
	it("état running : affiche Pause + Stop et déclenche pauseTask", async () => {
		const onStop = vi.fn().mockResolvedValue(undefined);
		renderControls({
			task: makeTask(),
			isPaused: false,
			pauseProcessAlive: null,
			onStop,
		});

		const pauseBtn = screen.getByRole("button", { name: /^pause$/i });
		expect(pauseBtn).toBeEnabled();
		fireEvent.click(pauseBtn);
		await waitFor(() => expect(mockPause).toHaveBeenCalledWith("task-1"));
		expect(mockResume).not.toHaveBeenCalled();

		// Stop is always available.
		expect(screen.getByRole("button", { name: /stop task/i })).toBeEnabled();
	});

	it("état paused : affiche Reprendre et déclenche resumeTask", async () => {
		renderControls({
			task: makeTask(),
			isPaused: true,
			pauseProcessAlive: false, // step finished → fully paused
			onStop: vi.fn(),
		});

		const resumeBtn = screen.getByRole("button", { name: /resume task/i });
		fireEvent.click(resumeBtn);
		await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"));
		expect(mockPause).not.toHaveBeenCalled();
	});

	it("état pausing : indicateur désactivé, pas de bouton Reprendre", () => {
		renderControls({
			task: makeTask(),
			isPaused: true,
			pauseProcessAlive: true, // step still finishing
			onStop: vi.fn(),
		});

		expect(
			screen.queryByRole("button", { name: /resume task/i }),
		).not.toBeInTheDocument();
		const pausing = screen.getByRole("button", { name: /pausing/i });
		expect(pausing).toBeDisabled();
	});

	it("le bouton Arrêter appelle onStop", async () => {
		const onStop = vi.fn().mockResolvedValue(undefined);
		renderControls({
			task: makeTask(),
			isPaused: false,
			pauseProcessAlive: null,
			onStop,
		});

		fireEvent.click(screen.getByRole("button", { name: /stop task/i }));
		await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
	});
});
