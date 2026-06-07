/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the 12 Phase 3-5 panels.
 *
 * The goal is intentionally narrow: confirm that each panel renders
 * its title without crashing, with all `electronAPI.*` and `useTranslation`
 * mocked. We don't drill into widget behaviour here — the backend logic
 * already has 327 unit tests, the panels are thin shells over the stores.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// react-i18next: return the key suffix as the translation so we can
// assert on stable substrings even when the JSON evolves.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// Strip the namespace if present, then strip dotted prefix → keep the leaf.
			const noNs = key.includes(":") ? key.split(":")[1] : key;
			const parts = noNs.split(".");
			return parts[parts.length - 1];
		},
		i18n: { language: "en" },
	}),
}));

// We mock the entire phase35-stores module so the panels don't actually
// hit Zustand or invoke electronAPI. Each store returns a minimal idle
// state and a no-op action set.
const idleSlice = {
	phase: "idle" as const,
	error: null,
	report: null,
	scores: [],
	knownAgents: [],
	chosen: null,
	comparison: null,
	domains: [],
	selectedDomain: null,
	profile: null,
	bundle: null,
	signals: [],
	scanReport: null,
	driftReport: null,
	configSource: null,
	generations: [],
	regression: null,
	skeleton: null,
	diff: null,
	context: null,
	events: [],
	replayEvents: [],
	integrity: null,
	currentRoom: null,
	ops: [],
	subscriptionId: null,
	isStreaming: false,
};

const noop = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../stores/phase35-stores", () => ({
	useLongevityStore: () => ({ ...idleSlice, compute: noop, reset: noop }),
	useAgentHealthStore: () => ({ ...idleSlice, refresh: noop, resetMonitor: noop }),
	useModelRouterStore: () => ({ ...idleSlice, route: noop, compare: noop }),
	useDomainAgentsStore: () => ({
		...idleSlice,
		loadDomains: noop,
		loadProfile: noop,
		build: noop,
	}),
	useCicdAnomalyStore: () => ({ ...idleSlice, scan: noop, analyse: noop }),
	useLicenseStore: () => ({ ...idleSlice, scan: noop }),
	useArchDriftStore: () => ({
		...idleSlice,
		scan: noop,
		saveBaseline: noop,
		compare: noop,
	}),
	useGenTestsStore: () => ({
		...idleSlice,
		listGenerations: noop,
		capture: noop,
		compare: noop,
		deleteGen: noop,
	}),
	useI18nScalerStore: () => ({ ...idleSlice, runReport: noop }),
	useCogContextStore: () => ({ ...idleSlice, optimize: noop }),
	useAuditTrailStore: () => ({
		...idleSlice,
		loadEvents: noop,
		replay: noop,
		verify: noop,
	}),
	usePairRealtimeStore: () => ({
		...idleSlice,
		createOrJoin: noop,
		leave: noop,
		sendChat: noop,
		sendEdit: noop,
		subscribe: noop,
		unsubscribe: noop,
		_appendOp: noop,
	}),
	setupPairRealtimeListeners: () => () => undefined,
	unwrap: <T,>(res: T) => res,
	errorMessage: (e: unknown) => String(e),
}));

// Stub the global electronAPI so anything that slips past the store mock
// (auto-refresh on mount, etc.) doesn't crash on `undefined`.
beforeEach(() => {
	(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {};
});

afterEach(() => {
	cleanup();
});

// Now import the panels — must happen AFTER the mocks are set up.
import { AgentHealthPanel } from "../AgentHealthPanel";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { AuditTrailPanel } from "../AuditTrailPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { CogContextPanel } from "../CogContextPanel";
import { DomainAgentsPanel } from "../DomainAgentsPanel";
import { GenTestsPanel } from "../GenTestsPanel";
import { I18nScalerPanel } from "../I18nScalerPanel";
import { LicensePanel } from "../LicensePanel";
import { LongevityPanel } from "../LongevityPanel";
import { ModelRouterPanel } from "../ModelRouterPanel";
import { PairProgrammingPanel } from "../PairProgrammingPanel";
import { Phase35Hub } from "../Phase35Hub";

describe("Phase 3-5 panels smoke tests", () => {
	it("LongevityPanel renders title", () => {
		render(<LongevityPanel projectPath="/tmp/proj" />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("AgentHealthPanel renders title", () => {
		render(<AgentHealthPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("ModelRouterPanel renders title", () => {
		render(<ModelRouterPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("DomainAgentsPanel renders title", () => {
		render(<DomainAgentsPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("CicdAnomalyPanel renders title", () => {
		render(<CicdAnomalyPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("LicensePanel renders title", () => {
		render(<LicensePanel projectPath="/tmp/proj" />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("ArchDriftPanel renders title", () => {
		render(<ArchDriftPanel projectPath="/tmp/proj" />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("GenTestsPanel renders title", () => {
		render(<GenTestsPanel projectPath="/tmp/proj" />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("I18nScalerPanel renders title", () => {
		render(<I18nScalerPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("CogContextPanel renders title", () => {
		render(<CogContextPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("AuditTrailPanel renders title", () => {
		render(<AuditTrailPanel />);
		expect(screen.getByText("title")).toBeInTheDocument();
	});

	it("PairProgrammingPanel renders join form when not in a room", () => {
		render(<PairProgrammingPanel />);
		expect(screen.getAllByText("title").length).toBeGreaterThan(0);
		// Join button label is the leaf "joinRoom" — confirms the empty-room branch.
		expect(screen.getByText("joinRoom")).toBeInTheDocument();
	});

	it("Phase35Hub renders the navigation with all 12 panels listed", () => {
		render(<Phase35Hub projectPath="/tmp/proj" />);
		// All 12 leaf "title" entries appear at least once in the side nav
		// (the active panel renders its own "title" too — so ≥ 12).
		const titles = screen.getAllByText("title");
		expect(titles.length).toBeGreaterThanOrEqual(12);
	});
});
