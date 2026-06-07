import type { ElectronAPI } from "@shared/types/ipc";
import { create } from "zustand";

// Extend globalThis to include electronAPI
declare global {
	var electronAPI: ElectronAPI;
}

/**
 * Conflict predictor event types
 */
export type ConflictPredictionStartEvent = {
	type: "start";
	data: { status?: string };
};

export type ConflictPredictionProgressEvent = {
	type: "progress";
	data: { status?: string };
};

export type ConflictPredictionOutputEvent = {
	type: "output";
	data: string;
};

export type ConflictPredictionEvent =
	| ConflictPredictionStartEvent
	| ConflictPredictionProgressEvent
	| ConflictPredictionOutputEvent;

/**
 * Conflict risk information
 */
export interface ConflictRisk {
	risk_level: "low" | "medium" | "high" | "critical";
	conflict_type: string;
	file_path: string;
	worktree1: string;
	worktree2: string;
	branch1: string;
	branch2: string;
	description: string;
	resolution_strategy: string;
}

/**
 * File modification information
 */
export interface FileModification {
	file_path: string;
	modification_type: "added" | "modified" | "deleted" | "renamed";
	lines_added: number;
	lines_removed: number;
	worktree_name: string;
	branch_name: string;
}

/**
 * Result of conflict prediction analysis
 */
export interface ConflictPredictionResult {
	total_worktrees: number;
	active_worktrees: string[];
	conflicts_detected: ConflictRisk[];
	modified_files: FileModification[];
	recommendations: string[];
	safe_merge_order: string[];
	high_risk_areas: string[];
	summary: {
		critical_conflicts: number;
		high_conflicts: number;
		medium_conflicts: number;
		total_conflicts: number;
		risk_assessment: string;
	};
}

export type ConflictPredictorPhase =
	| "idle"
	| "analyzing"
	| "complete"
	| "error";

interface ConflictPredictorState {
	// State
	phase: ConflictPredictorPhase;
	status: string;
	streamingOutput: string;
	result: ConflictPredictionResult | null;
	error: string | null;
	isOpen: boolean;

	// Actions
	openDialog: () => void;
	closeDialog: () => void;
	setPhase: (phase: ConflictPredictorPhase) => void;
	setStatus: (status: string) => void;
	appendStreamingOutput: (chunk: string) => void;
	setResult: (result: ConflictPredictionResult) => void;
	setError: (error: string) => void;
	reset: () => void;
}

const initialState = {
	phase: "idle" as ConflictPredictorPhase,
	status: "",
	streamingOutput: "",
	result: null,
	error: null,
	isOpen: false,
};

export const useConflictPredictorStore = create<ConflictPredictorState>(
	(set) => ({
		...initialState,

		openDialog: () =>
			set({
				isOpen: true,
				phase: "idle",
				status: "",
				streamingOutput: "",
				result: null,
				error: null,
			}),

		closeDialog: () =>
			set({
				isOpen: false,
				phase: "idle",
				status: "",
				streamingOutput: "",
				result: null,
				error: null,
			}),

		setPhase: (phase) => set({ phase }),

		setStatus: (status) => set({ status }),

		appendStreamingOutput: (chunk) =>
			set((state) => ({
				streamingOutput: state.streamingOutput + chunk,
			})),

		setResult: (result) =>
			set({
				result,
				phase: "complete",
			}),

		setError: (error) =>
			set({
				error,
				phase: "error",
			}),

		reset: () =>
			set({
				phase: "idle",
				status: "",
				streamingOutput: "",
				result: null,
				error: null,
			}),
	}),
);

/**
 * Open the conflict predictor dialog
 */
export const openConflictPredictorDialog = () => {
	useConflictPredictorStore.getState().reset();
	useConflictPredictorStore.setState({ isOpen: true });
};

/**
 * Start conflict prediction analysis
 * Uses globalThis.electronAPI (preload bridge) instead of direct IPC imports
 */
export const startConflictPrediction = async (projectId: string) => {
	useConflictPredictorStore.setState({
		phase: "analyzing",
		status: "Starting conflict analysis...",
		streamingOutput: "",
		result: null,
		error: null,
	});

	try {
		if (
			globalThis.electronAPI &&
			typeof globalThis.electronAPI.runConflictPrediction === "function"
		) {
			await globalThis.electronAPI.runConflictPrediction(projectId);
		} else {
			throw new Error("Conflict prediction API not available");
		}
	} catch (error) {
		useConflictPredictorStore.setState({
			error:
				error instanceof Error
					? error.message
					: "Failed to start conflict analysis",
			phase: "error",
		});
	}
};

/**
 * Handle conflict prediction events
 */
const handleConflictPredictionEvent = (data: ConflictPredictionEvent) => {
	const { type, data: eventData } = data;

	switch (type) {
		case "start":
			useConflictPredictorStore.setState({
				phase: "analyzing",
				status: eventData.status || "Starting analysis...",
			});
			break;

		case "progress":
			useConflictPredictorStore.setState({ status: eventData.status || "" });
			break;
		case "output":
			useConflictPredictorStore.setState((state) => ({
				streamingOutput: state.streamingOutput + eventData,
			}));
			break;
		default:
	}
};

/**
 * Handle conflict prediction completion
 */
const handleConflictPredictionComplete = (data: ConflictPredictionResult) => {
	useConflictPredictorStore.setState({
		result: data,
		phase: "complete",
		status: "Analysis complete",
	});
};

/**
 * Handle conflict prediction error
 */
const handleConflictPredictionError = (error: string) => {
	useConflictPredictorStore.setState({
		error,
		phase: "error",
		status: "Analysis failed",
	});
};

/**
 * Helper function to setup event listener with error handling
 */
const setupEventListener = <T>(
	apiFunction: (callback: (data: T) => void) => (() => void) | undefined,
	eventName: string,
	handler: (data: T) => void,
	cleanupFns: (() => void)[],
) => {
	if (apiFunction) {
		try {
			const unsub = apiFunction(handler);
			if (unsub) cleanupFns.push(unsub);
		} catch (error) {
			console.error(`Failed to setup ${eventName} listener:`, error);
		}
	}
};

/**
 * Setup IPC event listeners for conflict predictor events
 * Uses globalThis.electronAPI (preload bridge) instead of direct IPC imports
 */
export const setupConflictPredictorListeners = () => {
	const cleanupFns: (() => void)[] = [];

	// Listen for conflict predictor events via preload API
	setupEventListener(
		globalThis.electronAPI?.onConflictPredictionEvent,
		"conflict prediction event",
		handleConflictPredictionEvent,
		cleanupFns,
	);

	// Use individual event listeners as fallback
	setupEventListener(
		globalThis.electronAPI?.onConflictPredictionComplete,
		"conflict prediction complete",
		handleConflictPredictionComplete,
		cleanupFns,
	);

	setupEventListener(
		globalThis.electronAPI?.onConflictPredictionError,
		"conflict prediction error",
		handleConflictPredictionError,
		cleanupFns,
	);

	// Return cleanup function
	return () => {
		cleanupFns.forEach((fn) => fn());
	};
};
