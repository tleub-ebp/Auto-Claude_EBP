import type { Project, ProjectSettings } from "@shared/types";
import { create } from "zustand";

// localStorage keys for persisting project state (legacy - now using IPC)
const LAST_SELECTED_PROJECT_KEY = "lastSelectedProjectId";

// Debounce timer for saving tab state
let saveTabStateTimeout: ReturnType<typeof setTimeout> | null = null;

interface ProjectState {
	projects: Project[];
	selectedProjectId: string | null;
	isLoading: boolean;
	error: string | null;

	// Tab state
	openProjectIds: string[]; // Array of open project IDs
	activeProjectId: string | null; // Currently active tab
	tabOrder: string[]; // Order of tabs for drag and drop

	/**
	 * Set of project IDs whose on-disk path no longer exists. Refreshed
	 * via `refreshMissingPaths()` and consumed by the tab bar to display
	 * a warning indicator. An ID is absent from the set when the path is
	 * known to exist OR when the check has not run yet.
	 */
	missingPaths: ReadonlySet<string>;

	// Actions
	setProjects: (projects: Project[]) => void;
	addProject: (project: Project) => void;
	removeProject: (projectId: string) => void;
	updateProject: (projectId: string, updates: Partial<ProjectSettings>) => void;
	selectProject: (projectId: string | null) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;

	/**
	 * Refresh `missingPaths` by asking the main process whether each
	 * project's path still exists. Safe to call repeatedly (cheap fs.stat
	 * batch in the main process).
	 */
	refreshMissingPaths: () => Promise<void>;
	/**
	 * Repoint a project at a new on-disk location after the user picked
	 * a folder via the directory picker. Updates state and clears the
	 * missing-path flag on success.
	 */
	repathProject: (projectId: string, newPath: string) => Promise<boolean>;

	// Tab management actions
	openProjectTab: (projectId: string) => void;
	closeProjectTab: (projectId: string) => void;
	setActiveProject: (projectId: string | null) => void;
	reorderTabs: (fromIndex: number, toIndex: number) => void;
	restoreTabState: () => void;

	// Selectors
	getSelectedProject: () => Project | undefined;
	getOpenProjects: () => Project[];
	getActiveProject: () => Project | undefined;
	getProjectTabs: () => Project[];
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projects: [],
	selectedProjectId: null,
	isLoading: false,
	error: null,

	// Tab state - initialized empty, loaded via IPC from main process for reliability
	openProjectIds: [],
	activeProjectId: null,
	tabOrder: [],

	missingPaths: new Set<string>(),

	setProjects: (projects) => set({ projects }),

	addProject: (project) =>
		set((state) => ({
			projects: [...state.projects, project],
		})),

	removeProject: (projectId) =>
		set((state) => {
			const isSelectedProject = state.selectedProjectId === projectId;
			// Clear localStorage if we're removing the currently selected project
			if (isSelectedProject) {
				localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
			}
			return {
				projects: state.projects.filter((p) => p.id !== projectId),
				selectedProjectId: isSelectedProject ? null : state.selectedProjectId,
			};
		}),

	updateProject: (projectId, updates) =>
		set((state) => ({
			projects: state.projects.map((p) =>
				p.id === projectId ? { ...p, ...updates } : p,
			),
		})),

	selectProject: (projectId) => {
		// Persist to localStorage for restoration on app reload
		if (projectId) {
			localStorage.setItem(LAST_SELECTED_PROJECT_KEY, projectId);
		} else {
			localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
		}
		set({ selectedProjectId: projectId });
	},

	setLoading: (isLoading) => set({ isLoading }),

	setError: (error) => set({ error }),

	refreshMissingPaths: async () => {
		try {
			const api = globalThis.electronAPI?.checkProjectPaths;
			if (!api) return;
			const result = await api();
			if (!result.success || !result.data) return;
			const missing = new Set<string>();
			for (const [projectId, exists] of Object.entries(result.data)) {
				if (!exists) missing.add(projectId);
			}
			set({ missingPaths: missing });
		} catch (err) {
			console.error("[ProjectStore] refreshMissingPaths failed:", err);
		}
	},

	repathProject: async (projectId, newPath) => {
		try {
			const api = globalThis.electronAPI?.repathProject;
			if (!api) return false;
			const result = await api(projectId, newPath);
			if (!result.success || !result.data) return false;
			const updated = result.data;
			set((state) => {
				const newMissing = new Set(state.missingPaths);
				newMissing.delete(projectId);
				return {
					projects: state.projects.map((p) =>
						p.id === projectId ? { ...p, path: updated.path } : p,
					),
					missingPaths: newMissing,
				};
			});
			return true;
		} catch (err) {
			console.error("[ProjectStore] repathProject failed:", err);
			return false;
		}
	},

	// Tab management actions
	openProjectTab: (projectId) => {
		const state = get();

		if (!state.openProjectIds.includes(projectId)) {
			const newOpenProjectIds = [...state.openProjectIds, projectId];
			const newTabOrder = state.tabOrder.includes(projectId)
				? state.tabOrder
				: [...state.tabOrder, projectId];

			set({
				openProjectIds: newOpenProjectIds,
				tabOrder: newTabOrder,
				activeProjectId: projectId,
			});

			// Save to main process (debounced)
			saveTabStateToMain();
		} else {
			// Project already open, just make it active
			get().setActiveProject(projectId);
		}
	},

	closeProjectTab: (projectId) => {
		const state = get();
		const newOpenProjectIds = state.openProjectIds.filter(
			(id) => id !== projectId,
		);
		const newTabOrder = state.tabOrder.filter((id) => id !== projectId);

		// If closing the active project, select another one or null
		let newActiveProjectId = state.activeProjectId;
		if (state.activeProjectId === projectId) {
			const remainingTabs = newTabOrder.length > 0 ? newTabOrder : [];
			newActiveProjectId = remainingTabs.length > 0 ? remainingTabs[0] : null;
		}

		set({
			openProjectIds: newOpenProjectIds,
			tabOrder: newTabOrder,
			activeProjectId: newActiveProjectId,
		});

		// Save to main process (debounced)
		saveTabStateToMain();
	},

	setActiveProject: (projectId) => {
		set({ activeProjectId: projectId });
		// Also update selectedProjectId for backward compatibility
		get().selectProject(projectId);
		// Save to main process (debounced)
		saveTabStateToMain();
	},

	reorderTabs: (fromIndex, toIndex) => {
		const state = get();
		const newTabOrder = [...state.tabOrder];
		const [movedTab] = newTabOrder.splice(fromIndex, 1);
		newTabOrder.splice(toIndex, 0, movedTab);

		set({ tabOrder: newTabOrder });
		// Save to main process (debounced)
		saveTabStateToMain();
	},

	restoreTabState: () => {
		// This is now handled by loadTabStateFromMain() called during loadProjects()
	},

	// Original selectors
	getSelectedProject: () => {
		const state = get();
		return state.projects.find((p) => p.id === state.selectedProjectId);
	},

	// New selectors for tab functionality
	getOpenProjects: () => {
		const state = get();
		return state.projects.filter((p) => state.openProjectIds.includes(p.id));
	},

	getActiveProject: () => {
		const state = get();
		return state.projects.find((p) => p.id === state.activeProjectId);
	},

	getProjectTabs: () => {
		const state = get();
		const orderedProjects = state.tabOrder
			.map((id) => state.projects.find((p) => p.id === id))
			.filter(Boolean) as Project[];

		// Add any open projects not in tabOrder to the end
		const remainingProjects = state.projects.filter(
			(p) =>
				state.openProjectIds.includes(p.id) && !state.tabOrder.includes(p.id),
		);

		return [...orderedProjects, ...remainingProjects];
	},
}));

/**
 * Save tab state to main process (debounced to avoid excessive IPC calls)
 */
function saveTabStateToMain(): void {
	// Clear any pending save
	if (saveTabStateTimeout) {
		clearTimeout(saveTabStateTimeout);
	}

	// Debounce saves to avoid excessive IPC calls
	saveTabStateTimeout = setTimeout(async () => {
		const store = useProjectStore.getState();
		const tabState = {
			openProjectIds: store.openProjectIds,
			activeProjectId: store.activeProjectId,
			tabOrder: store.tabOrder,
		};
		try {
			await window.electronAPI.saveTabState(tabState);
		} catch (err) {
			console.error("[ProjectStore] Failed to save tab state:", err);
		}
	}, 100);
}

/**
 * Load projects from main process
 */
export async function loadProjects(): Promise<void> {
	const store = useProjectStore.getState();
	store.setLoading(true);
	store.setError(null);

	try {
		// First, load tab state from main process (reliable persistence)
		const tabStateResult = await window.electronAPI.getTabState();
		if (
			typeof tabStateResult !== "object" ||
			tabStateResult === null ||
			!("success" in tabStateResult)
		) {
			throw new Error(
				"Réponse inattendue du backend (non-JSON). Vérifiez que le backend est bien lancé.",
			);
		}
		if (tabStateResult.success && tabStateResult.data) {
			useProjectStore.setState({
				openProjectIds: tabStateResult.data.openProjectIds || [],
				activeProjectId: tabStateResult.data.activeProjectId || null,
				tabOrder: tabStateResult.data.tabOrder || [],
			});
		}
		// Then load projects
		const result = await window.electronAPI.getProjects();
		if (
			typeof result !== "object" ||
			result === null ||
			!("success" in result)
		) {
			throw new Error(
				"Réponse inattendue du backend (non-JSON). Vérifiez que le backend est bien lancé.",
			);
		}
		if (result.success && result.data) {
			store.setProjects(result.data);
			// Restore selected project from localStorage if available, fallback to activeProjectId from tab state
			const lastSelectedProjectId = localStorage.getItem(
				LAST_SELECTED_PROJECT_KEY,
			);
			if (lastSelectedProjectId) {
				const lastSelectedProject = result.data.find(
					(p) => p.id === lastSelectedProjectId,
				);
				if (lastSelectedProject) {
					store.selectProject(lastSelectedProjectId);
				}
			} else {
				// localStorage is empty (e.g. fresh userData directory) — fall back to tab state activeProjectId
				const activeProjectId = useProjectStore.getState().activeProjectId;
				if (activeProjectId) {
					const activeProject = result.data.find(
						(p) => p.id === activeProjectId,
					);
					if (activeProject) {
						store.selectProject(activeProjectId);
					}
				}
			}
		} else if (!result.success) {
			store.setError(result.error || "Erreur lors du chargement des projets.");
		}

		// Refresh missing-paths flags so the tab bar can mark stale projects.
		// Don't await — this is purely cosmetic and shouldn't block load.
		void useProjectStore.getState().refreshMissingPaths();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	} catch (err: any) {
		// Gestion d'erreur améliorée pour les réponses HTML ou backend injoignable
		const message =
			typeof err?.message === "string" &&
			err.message.includes("Unexpected token <")
				? "Le backend ne répond pas ou retourne du HTML au lieu du JSON. Vérifiez que le backend est bien lancé."
				: err?.message || "Erreur inconnue lors du chargement des projets.";
		store.setError(message);
		console.error("[ProjectStore] loadProjects error:", err);
	} finally {
		store.setLoading(false);
	}
}

/**
 * Add a new project. Returns the created project plus an optional warning
 * (e.g. when the chosen path is a Git sub-folder instead of the Git root).
 */
export async function addProject(
	projectPath: string,
): Promise<{ project: Project; warning?: string } | null> {
	const store = useProjectStore.getState();

	try {
		const result = await window.electronAPI.addProject(projectPath);
		if (result.success && result.data) {
			store.addProject(result.data);
			store.selectProject(result.data.id);
			// Also open a tab for the new project
			store.openProjectTab(result.data.id);
			return { project: result.data, warning: result.warning };
		} else {
			store.setError(result.error || "Failed to add project");
			return null;
		}
	} catch (error) {
		store.setError(error instanceof Error ? error.message : "Unknown error");
		return null;
	}
}

/**
 * Remove a project
 */
export async function removeProject(projectId: string): Promise<boolean> {
	const store = useProjectStore.getState();

	try {
		const result = await window.electronAPI.removeProject(projectId);
		if (result.success) {
			store.removeProject(projectId);
			// Also close the tab if it's open
			if (store.openProjectIds.includes(projectId)) {
				store.closeProjectTab(projectId);
			}
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Rename a project (display name only — path is never changed)
 */
export async function renameProject(
	projectId: string,
	name: string,
): Promise<boolean> {
	const store = useProjectStore.getState();
	const trimmed = name.trim();
	if (!trimmed) return false;

	try {
		const result = await window.electronAPI.renameProject(projectId, trimmed);
		if (result.success && result.data) {
			store.setProjects(
				store.projects.map((p) =>
					p.id === projectId ? { ...p, name: trimmed } : p,
				),
			);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Update project settings
 */
export async function updateProjectSettings(
	projectId: string,
	settings: Partial<ProjectSettings>,
): Promise<boolean> {
	const store = useProjectStore.getState();

	try {
		const result = await window.electronAPI.updateProjectSettings(
			projectId,
			settings,
		);
		if (result.success) {
			// Merge the saved values into the in-memory project so the UI reflects
			// what was persisted. The updates MUST be merged into `project.settings`
			// (not spread onto the top-level project object), otherwise the settings
			// dialog's reset-on-project-change effect reads a stale `project.settings`
			// and reverts toggles like tddMode/useClaudeMd back to their old value.
			// Use a functional setState to avoid clobbering concurrent store updates
			// that may have landed during the await above.
			useProjectStore.setState((state) => ({
				projects: state.projects.map((p) =>
					p.id === projectId
						? { ...p, settings: { ...p.settings, ...settings } }
						: p,
				),
			}));
			return true;
		}
		return false;
	} catch (error) {
		store.setError(error instanceof Error ? error.message : "Unknown error");
		return false;
	}
}

/**
 * Initialize a project (appel IPC)
 */
export async function initializeProject(projectId: string) {
	try {
		return await window.electronAPI.initializeProject(projectId);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Check project version (appel IPC)
 */
export async function checkProjectVersion(projectId: string) {
	try {
		return await window.electronAPI.checkProjectVersion(projectId);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
