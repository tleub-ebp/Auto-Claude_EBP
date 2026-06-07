/**
 * Conflict Predictor API
 *
 * Provides API interface for Conflict Predictor functionality
 */

import type {
	ConflictPredictionEvent,
	ConflictPredictionResult,
} from "../../../renderer/stores/conflict-predictor-store";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface ConflictPredictorAPI {
	runConflictPrediction: (projectId: string) => Promise<void>;
	cancelConflictPrediction: () => Promise<boolean>;
	onConflictPredictionStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;
	onConflictPredictionStatus: (
		callback: (status: string) => void,
	) => () => void;
	onConflictPredictionError: (callback: (error: string) => void) => () => void;
	onConflictPredictionComplete: (
		callback: (result: ConflictPredictionResult) => void,
	) => () => void;
	onConflictPredictionEvent: (
		callback: (event: ConflictPredictionEvent) => void,
	) => () => void;
}

export const createConflictPredictorAPI = (): ConflictPredictorAPI => ({
	runConflictPrediction: (projectId: string) =>
		invokeIpc("run-conflict-prediction", { projectId }),

	cancelConflictPrediction: () => invokeIpc("cancel-conflict-prediction"),

	onConflictPredictionStreamChunk: (callback: (chunk: string) => void) => {
		return createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		});
	},

	onConflictPredictionStatus: (callback: (status: string) => void) => {
		return createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		});
	},

	onConflictPredictionError: (callback: (error: string) => void) => {
		return createIpcListener("conflict-predictor-error", (error: string) => {
			callback(error);
		});
	},

	onConflictPredictionComplete: (callback: (result: ConflictPredictionResult) => void) => {
		return createIpcListener("conflict-predictor-complete", (result: ConflictPredictionResult) => {
			callback(result);
		});
	},

	onConflictPredictionEvent: (callback: (event: ConflictPredictionEvent) => void) => {
		return createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			callback(event);
		});
	},
});

export const conflictPredictorAPI: ConflictPredictorAPI = {
	runConflictPrediction: (projectId: string) =>
		invokeIpc("run-conflict-prediction", { projectId }),

	cancelConflictPrediction: () => invokeIpc("cancel-conflict-prediction"),

	onConflictPredictionStreamChunk: (callback: (chunk: string) => void) =>
		createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		}),

	onConflictPredictionStatus: (callback: (status: string) => void) =>
		createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		}),

	onConflictPredictionError: (callback: (error: string) => void) =>
		createIpcListener("conflict-predictor-error", (error: string) => {
			callback(error);
		}),

	onConflictPredictionComplete: (callback: (result: ConflictPredictionResult) => void) =>
		createIpcListener("conflict-predictor-complete", (result: ConflictPredictionResult) => {
			callback(result);
		}),

	onConflictPredictionEvent: (callback: (event: ConflictPredictionEvent) => void) =>
		createIpcListener("conflict-predictor-event", (event: ConflictPredictionEvent) => {
			callback(event);
		}),
};
