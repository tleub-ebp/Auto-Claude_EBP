import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "./ui/tooltip";

// Mock du contexte CLI : on contrôle le statut/version renvoyés au badge.
const mockUseCliStatus = vi.fn();
vi.mock("@/contexts/CliStatusContext", () => ({
	useCliStatus: () => mockUseCliStatus(),
}));

// Mock i18n : renvoie le fallback (2e argument) afin que "Update"/"Install"
// soient des libellés stables, indépendants des fichiers de traduction.
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({
		t: (_key: string, fallback?: string) => fallback ?? _key,
	})),
}));

import { CodexCliStatusBadge } from "./CodexCliStatusBadge";

function setStatus(status: string, installed?: string) {
	mockUseCliStatus.mockReturnValue({
		data: {
			codex: {
				status,
				versionInfo: installed ? { installed } : null,
				lastChecked: null,
			},
		},
		refreshCodex: vi.fn(),
	});
}

// Le badge utilise Radix Tooltip, qui exige un TooltipProvider ancêtre
// (fourni par la Sidebar en production).
function renderBadge(ui: ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("CodexCliStatusBadge", () => {
	beforeEach(() => {
		mockUseCliStatus.mockReset();
	});

	describe("mode replié (isCollapsed)", () => {
		it("masque le libellé et le badge Update quand le statut est outdated", () => {
			setStatus("outdated", "1.0.0");
			renderBadge(<CodexCliStatusBadge isCollapsed />);

			// Le texte "Codex" et le badge "Update" ne doivent pas déborder.
			expect(screen.queryByText(/Codex/)).not.toBeInTheDocument();
			expect(screen.queryByText("Update")).not.toBeInTheDocument();
		});

		it("masque le badge Install quand le statut est not-found", () => {
			setStatus("not-found");
			renderBadge(<CodexCliStatusBadge isCollapsed />);

			expect(screen.queryByText("Install")).not.toBeInTheDocument();
		});
	});

	describe("mode déplié (par défaut)", () => {
		it("affiche le libellé avec la version et le badge Update quand outdated", () => {
			setStatus("outdated", "1.0.0");
			renderBadge(<CodexCliStatusBadge />);

			expect(screen.getByText(/Codex \(1\.0\.0\)/)).toBeInTheDocument();
			expect(screen.getByText("Update")).toBeInTheDocument();
		});

		it("affiche le badge Install quand not-found", () => {
			setStatus("not-found");
			renderBadge(<CodexCliStatusBadge />);

			expect(screen.getByText("Install")).toBeInTheDocument();
		});
	});
});
