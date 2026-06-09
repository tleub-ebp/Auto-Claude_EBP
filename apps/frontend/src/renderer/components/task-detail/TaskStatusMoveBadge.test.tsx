import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { TaskStatusMoveBadge } from "./TaskStatusMoveBadge";

// Mock i18n : renvoie la clé (ou le 2e argument en fallback) afin que les
// libellés soient stables, indépendamment des fichiers de traduction.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string) => fallback ?? key,
	}),
}));

function makeTask(status: Task["status"]): Task {
	return { id: "task-1", status } as unknown as Task;
}

describe("TaskStatusMoveBadge", () => {
	it("affiche le libellé de la colonne courante et le déclencheur de déplacement", () => {
		render(
			<TaskStatusMoveBadge
				task={makeTask("in_progress")}
				variant="info"
				isRunning
				onMove={vi.fn()}
			/>,
		);

		// Libellé de statut courant (clé i18n renvoyée telle quelle par le mock).
		expect(screen.getByText("columns.in_progress")).toBeInTheDocument();
		// Le badge est un déclencheur accessible vers le menu « Déplacer vers ».
		expect(
			screen.getByRole("button", { name: "tasks:modal.move.trigger" }),
		).toBeInTheDocument();
	});

	it("utilise le libellé personnalisé pour les états spéciaux (Bloqué)", () => {
		render(
			<TaskStatusMoveBadge
				task={makeTask("in_progress")}
				variant="warning"
				isRunning
				onMove={vi.fn()}
				pulse
				label="Bloqué"
			/>,
		);

		// Le libellé override remplace le nom de la colonne, mais le déplacement
		// reste disponible (déclencheur présent).
		expect(screen.getByText("Bloqué")).toBeInTheDocument();
		expect(screen.queryByText("columns.in_progress")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "tasks:modal.move.trigger" }),
		).toBeInTheDocument();
	});
});
