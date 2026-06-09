/**
 * Tests unitaires pour PhaseProgressIndicator (mode tile).
 *
 * Régression ciblée : pendant la revue QA (status `ai_review`), la card en mode
 * tile affichait l'avancement par sous-tâches (figé, ex. 50%) au lieu de la
 * progression temps réel `overallProgress` (ex. 94%). Le flag `hasActiveExecution`
 * doit primer sur `isRunning` (limité à `in_progress`).
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Subtask } from "../../../shared/types";
import { PhaseProgressIndicator } from "../PhaseProgressIndicator";

vi.mock("motion/react", () => {
	const passthrough = new Proxy(
		{},
		{
			get: () => (props: Record<string, unknown>) => {
				const { children, ...rest } = props as { children?: unknown };
				return <div {...(rest as object)}>{children as never}</div>;
			},
		},
	);
	return {
		motion: passthrough,
		AnimatePresence: ({ children }: { children?: unknown }) => (
			<>{children as never}</>
		),
	};
});

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

beforeAll(() => {
	class MockIntersectionObserver {
		observe = vi.fn();
		disconnect = vi.fn();
		unobserve = vi.fn();
	}
	vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

const makeSubtasks = (completed: number, total: number): Subtask[] =>
	Array.from({ length: total }, (_, i) => ({
		id: `st-${i}`,
		title: `Subtask ${i}`,
		status: i < completed ? "completed" : "pending",
	})) as Subtask[];

describe("PhaseProgressIndicator — progression en mode tile", () => {
	it("privilégie overallProgress pendant la revue QA (hasActiveExecution)", () => {
		// 2/4 sous-tâches = 50%, mais le backend est à 94% en revue QA.
		render(
			<PhaseProgressIndicator
				phase="qa_review"
				subtasks={makeSubtasks(2, 4)}
				overallProgress={94}
				isRunning={false}
				hasActiveExecution={true}
			/>,
		);

		expect(screen.getByText("94%")).toBeInTheDocument();
		expect(screen.queryByText("50%")).not.toBeInTheDocument();
	});

	it("retombe sur l'avancement par sous-tâches hors exécution active", () => {
		render(
			<PhaseProgressIndicator
				phase="idle"
				subtasks={makeSubtasks(2, 4)}
				overallProgress={94}
				isRunning={false}
				hasActiveExecution={false}
			/>,
		);

		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(screen.queryByText("94%")).not.toBeInTheDocument();
	});

	it("se replie sur isRunning quand hasActiveExecution n'est pas fourni", () => {
		render(
			<PhaseProgressIndicator
				phase="coding"
				subtasks={makeSubtasks(1, 4)}
				overallProgress={60}
				isRunning={true}
			/>,
		);

		expect(screen.getByText("60%")).toBeInTheDocument();
	});
});
