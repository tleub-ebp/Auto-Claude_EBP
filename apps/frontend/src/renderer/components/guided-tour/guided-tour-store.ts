import { create } from "zustand";
import type { SetupDeepLink } from "../setup-hub/useSetupStatus";

/**
 * One step of the guided tour. Pure data — the overlay component reads it to
 * place the spotlight, and the registry (`tour-steps.ts`) produces the list.
 */
export interface GuidedStep {
	/** `data-guide` anchor of the target element. */
	anchor: string;
	/** Settings section to open before resolving the anchor. */
	section: SetupDeepLink;
	/** i18n keys (namespace "guidedTour"). */
	titleKey: string;
	descKey: string;
	/**
	 * Live gate for the "Next" button. When present and returns false, Next is
	 * disabled (the user must complete the field/toggle first). Read from the
	 * env-config store, not the DOM, so it survives re-renders reliably.
	 */
	condition?: () => boolean;
	/** Informational/optional step — never gated even without a condition. */
	optional?: boolean;
}

/**
 * `navigateSettings` is injected by App.tsx (it owns the Settings dialog open
 * state + initial-section setters that the Setup Hub already wires). The tour
 * calls it to bring the right section on screen before anchoring.
 */
type NavigateSettings = (deepLink: SetupDeepLink) => void;

interface GuidedTourState {
	isActive: boolean;
	steps: GuidedStep[];
	currentIndex: number;
	navigateSettings: NavigateSettings | null;

	registerNavigate: (fn: NavigateSettings) => void;
	startTour: (steps: GuidedStep[]) => void;
	next: () => void;
	back: () => void;
	/** Jump past every remaining step of the current section to the next one. */
	skipSection: () => void;
	stop: () => void;
}

/** Two deep-links point at the same settings section. */
function sameSection(a: SetupDeepLink, b: SetupDeepLink): boolean {
	return a.kind === b.kind && a.section === b.section;
}

export const useGuidedTourStore = create<GuidedTourState>((set, get) => ({
	isActive: false,
	steps: [],
	currentIndex: 0,
	navigateSettings: null,

	registerNavigate: (fn) => set({ navigateSettings: fn }),

	startTour: (steps) => {
		if (steps.length === 0) return;
		set({ isActive: true, steps, currentIndex: 0 });
	},

	next: () => {
		const { currentIndex, steps } = get();
		if (currentIndex >= steps.length - 1) {
			set({ isActive: false, steps: [], currentIndex: 0 });
			return;
		}
		set({ currentIndex: currentIndex + 1 });
	},

	back: () => {
		const { currentIndex } = get();
		if (currentIndex > 0) set({ currentIndex: currentIndex - 1 });
	},

	skipSection: () => {
		const { currentIndex, steps } = get();
		const current = steps[currentIndex];
		if (!current) return;
		// Find the first later step in a different section.
		let i = currentIndex + 1;
		while (i < steps.length && sameSection(steps[i].section, current.section)) {
			i += 1;
		}
		if (i >= steps.length) {
			set({ isActive: false, steps: [], currentIndex: 0 });
			return;
		}
		set({ currentIndex: i });
	},

	stop: () => set({ isActive: false, steps: [], currentIndex: 0 }),
}));

/** Imperative helper for non-React call sites (e.g. the Setup Hub button). */
export const startGuidedTour = (steps: GuidedStep[]) => {
	useGuidedTourStore.getState().startTour(steps);
};
