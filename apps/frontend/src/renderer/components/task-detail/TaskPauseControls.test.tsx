/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskPauseControls — le bloc « Changer de LLM en cours d'exécution ».
 *
 * Couvre la clarification UX : le bouton de pause/override à chaud n'est
 * actionnable que pendant l'exécution. Hors exécution, il est désactivé (les
 * étapes non démarrées se configurent via les sélecteurs LLM de chaque phase).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: vi.fn(),
}));

vi.mock("../../hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

import type { Task } from "../../../shared/types";
import { useSettingsStore } from "../../stores/settings-store";
import { TooltipProvider } from "../ui/tooltip";
import { TaskPauseControls } from "./TaskPauseControls";

const fakeStoreState = { settings: {}, profiles: [] };

function makeTask(): Task {
	return {
		id: "task-1",
		metadata: {},
	} as unknown as Task;
}

function renderControls(props: Parameters<typeof TaskPauseControls>[0]) {
	return render(
		<TooltipProvider>
			<TaskPauseControls {...props} />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	(useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		(selector: (s: typeof fakeStoreState) => unknown) =>
			selector(fakeStoreState),
	);
});

describe("TaskPauseControls", () => {
	it("désactive le bouton de pause quand la tâche n'est pas en cours d'exécution", () => {
		renderControls({ task: makeTask(), isPaused: false, isRunning: false });
		const button = screen.getByRole("button", { name: /pause and switch llm/i });
		expect(button).toBeDisabled();
	});

	it("active le bouton et déclenche onPause quand la tâche est en cours d'exécution", async () => {
		const onPause = vi.fn().mockResolvedValue(undefined);
		renderControls({
			task: makeTask(),
			isPaused: false,
			isRunning: true,
			onPause,
		});
		const button = screen.getByRole("button", { name: /pause and switch llm/i });
		expect(button).toBeEnabled();
		fireEvent.click(button);
		await waitFor(() => expect(onPause).toHaveBeenCalledTimes(1));
	});
});
