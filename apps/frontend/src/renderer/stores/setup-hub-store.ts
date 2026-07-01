import { create } from "zustand";

/**
 * Open/close state for the Setup Hub ("Centre de configuration").
 *
 * Kept in a tiny store (same pattern as arena-store / voice-control-store) so
 * any component — sidebar help button, settings dialog, home banner — can open
 * the hub without threading a boolean prop through App.tsx.
 */
interface SetupHubState {
	isOpen: boolean;
	openSetupHub: () => void;
	closeSetupHub: () => void;
	setSetupHubOpen: (open: boolean) => void;
}

export const useSetupHubStore = create<SetupHubState>((set) => ({
	isOpen: false,
	openSetupHub: () => set({ isOpen: true }),
	closeSetupHub: () => set({ isOpen: false }),
	setSetupHubOpen: (open) => set({ isOpen: open }),
}));

/** Imperative helper for non-React call sites. */
export const openSetupHub = () => {
	useSetupHubStore.getState().openSetupHub();
};
