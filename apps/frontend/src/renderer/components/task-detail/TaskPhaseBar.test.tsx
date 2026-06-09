/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskPhaseBar — la barre de phase collante au-dessus des logs.
 *
 * Couvre le suivi de la phase en fonction du défilement (`currentPhase`) et le
 * repli sur la phase active lorsque l'utilisateur n'a pas encore défilé.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { TaskPhaseBar } from "./TaskPhaseBar";

function makePhaseLogs(activePhase?: TaskLogPhase): TaskLogs {
	const phase = (name: TaskLogPhase) => ({
		status: name === activePhase ? "active" : "pending",
		entries: [],
	});
	return {
		phases: {
			planning: phase("planning"),
			coding: phase("coding"),
			validation: phase("validation"),
		},
	} as unknown as TaskLogs;
}

describe("TaskPhaseBar", () => {
	it("ne rend rien sans phaseLogs", () => {
		const { container } = render(<TaskPhaseBar phaseLogs={null} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("affiche la phase active quand aucune phase de défilement n'est fournie", () => {
		render(<TaskPhaseBar phaseLogs={makePhaseLogs("validation")} />);
		expect(screen.getByText("Validation")).toBeInTheDocument();
		expect(screen.getByText("Step 3/3")).toBeInTheDocument();
	});

	it("privilégie la phase de défilement sur la phase active", () => {
		render(
			<TaskPhaseBar
				phaseLogs={makePhaseLogs("validation")}
				currentPhase="coding"
			/>,
		);
		expect(screen.getByText("Coding")).toBeInTheDocument();
		expect(screen.getByText("Step 2/3")).toBeInTheDocument();
		expect(screen.queryByText("Validation")).not.toBeInTheDocument();
	});

	it("se replie sur la phase active quand currentPhase vaut null", () => {
		render(
			<TaskPhaseBar phaseLogs={makePhaseLogs("coding")} currentPhase={null} />,
		);
		expect(screen.getByText("Coding")).toBeInTheDocument();
		expect(screen.getByText("Step 2/3")).toBeInTheDocument();
	});

	it("ne rend rien quand aucune phase active ni de défilement", () => {
		const { container } = render(
			<TaskPhaseBar phaseLogs={makePhaseLogs()} currentPhase={null} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("affiche l'activité fournie après le numéro de phase", () => {
		render(
			<TaskPhaseBar
				phaseLogs={makePhaseLogs("coding")}
				currentActivity="Implémentation du paiement"
			/>,
		);
		expect(screen.getByText("Step 2/3")).toBeInTheDocument();
		expect(
			screen.getByText("Implémentation du paiement"),
		).toBeInTheDocument();
	});

	it("dérive l'activité depuis le dernier sous-titre des logs", () => {
		const logs = {
			phases: {
				planning: {
					status: "active",
					entries: [{ subphase: "DÉCOUVERTE" }, { subphase: "ANALYSE" }],
				},
				coding: { status: "pending", entries: [] },
				validation: { status: "pending", entries: [] },
			},
		} as unknown as TaskLogs;
		render(<TaskPhaseBar phaseLogs={logs} />);
		expect(screen.getByText("Step 1/3")).toBeInTheDocument();
		expect(screen.getByText("ANALYSE")).toBeInTheDocument();
	});

	it("privilégie l'activité fournie sur le sous-titre des logs", () => {
		const logs = {
			phases: {
				planning: {
					status: "active",
					entries: [{ subphase: "ANALYSE" }],
				},
				coding: { status: "pending", entries: [] },
				validation: { status: "pending", entries: [] },
			},
		} as unknown as TaskLogs;
		render(
			<TaskPhaseBar phaseLogs={logs} currentActivity="Rédaction du plan" />,
		);
		expect(screen.getByText("Rédaction du plan")).toBeInTheDocument();
		expect(screen.queryByText("ANALYSE")).not.toBeInTheDocument();
	});

	it("affiche l'ellipsis animée quand la phase affichée est en cours", () => {
		render(<TaskPhaseBar phaseLogs={makePhaseLogs("coding")} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("masque l'ellipsis animée quand on défile vers une phase inactive", () => {
		render(
			<TaskPhaseBar
				phaseLogs={makePhaseLogs("validation")}
				currentPhase="planning"
			/>,
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("retire l'ellipsis finale de l'activité pour éviter les points doublés", () => {
		render(
			<TaskPhaseBar
				phaseLogs={makePhaseLogs("coding")}
				currentActivity="Starting build process..."
			/>,
		);
		expect(screen.getByText("Starting build process")).toBeInTheDocument();
		expect(
			screen.queryByText("Starting build process..."),
		).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toBeInTheDocument();
	});
});
