import { type IpcRendererEvent, ipcRenderer } from "electron";

/**
 * Test Generation API
 *
 * Provides access to test generation functionality from the renderer process.
 */

/** A live pipeline-stage event streamed during generation. */
export interface TestGenStageEvent {
	type: "stage";
	stage: "detect" | "read" | "generate" | "write" | "done";
	status?: "done";
	detail?: string;
	language?: string;
	framework?: string;
	path?: string;
	tests?: number;
}

export interface TestGenerationAPI {
	analyzeTestCoverage: (
		filePath: string,
		existingTestPath?: string,
		projectPath?: string,
	) => Promise<{ success: boolean; error?: string }>;
	generateUnitTests: (
		filePath: string,
		existingTestPath?: string,
		coverageTarget?: number,
		projectPath?: string,
	) => Promise<{ success: boolean; error?: string }>;
	generateE2ETests: (
		userStory: string,
		targetModule: string,
		projectPath?: string,
	) => Promise<{ success: boolean; error?: string }>;
	generateTDDTests: (
		description: string,
		language: string,
		snippetType: string,
		projectPath?: string,
	) => Promise<{ success: boolean; error?: string }>;
	cancelTestGeneration: () => Promise<{
		success: boolean;
		cancelled?: boolean;
		error?: string;
	}>;
	onTestGenerationStatus: (callback: (status: string) => void) => void;
	onTestGenerationError: (callback: (error: string) => void) => void;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	onTestGenerationResult: (callback: (result: any) => void) => void;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	onTestGenerationComplete: (callback: (result: any) => void) => void;
	/** Live pipeline stage events (detect → read → generate → write → done). */
	onTestGenerationProgress: (
		callback: (event: TestGenStageEvent) => void,
	) => void;
	/** Streamed chunks of clean generated test code. */
	onTestGenerationCode: (callback: (delta: string) => void) => void;
	removeTestGenerationStatusListener: (
		callback: (status: string) => void,
	) => void;
	removeTestGenerationErrorListener: (
		callback: (error: string) => void,
	) => void;
	removeTestGenerationResultListener: (callback: (result: unknown) => void) => void;
	removeTestGenerationCompleteListener: (
		callback: (result: unknown) => void,
	) => void;
	removeTestGenerationProgressListener: (
		callback: (event: TestGenStageEvent) => void,
	) => void;
	removeTestGenerationCodeListener: (callback: (delta: string) => void) => void;
}

// Type aliases for different callback signatures
type StatusListenerFn = (status: string) => void;
type ErrorListenerFn = (error: string) => void;
type ResultListenerFn = (result: unknown) => void;
type CompleteListenerFn = (result: unknown) => void;
type ProgressListenerFn = (event: TestGenStageEvent) => void;
type CodeListenerFn = (delta: string) => void;

// Maps to store callback → actual IPC listener so removeListener can find the exact reference
const statusListeners = new Map<
	StatusListenerFn,
	(event: IpcRendererEvent, status: string) => void
>();
const errorListeners = new Map<
	ErrorListenerFn,
	(event: IpcRendererEvent, error: string) => void
>();
const resultListeners = new Map<
	ResultListenerFn,
	(event: IpcRendererEvent, result: unknown) => void
>();
const completeListeners = new Map<
	CompleteListenerFn,
	(event: IpcRendererEvent, result: unknown) => void
>();
const progressListeners = new Map<
	ProgressListenerFn,
	(event: IpcRendererEvent, payload: TestGenStageEvent) => void
>();
const codeListeners = new Map<
	CodeListenerFn,
	(event: IpcRendererEvent, delta: string) => void
>();

export const createTestGenerationAPI = (): TestGenerationAPI => ({
	analyzeTestCoverage: async (
		filePath: string,
		existingTestPath?: string,
		projectPath?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("test-generation:analyze-coverage", {
			filePath,
			existingTestPath,
			projectPath,
		});
	},

	generateUnitTests: async (
		filePath: string,
		existingTestPath?: string,
		coverageTarget?: number,
		projectPath?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("test-generation:generate-unit", {
			filePath,
			existingTestPath,
			coverageTarget,
			projectPath,
		});
	},

	generateE2ETests: async (
		userStory: string,
		targetModule: string,
		projectPath?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("test-generation:generate-e2e", {
			userStory,
			targetModule,
			projectPath,
		});
	},

	generateTDDTests: async (
		description: string,
		language: string,
		snippetType: string,
		projectPath?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("test-generation:generate-tdd", {
			description,
			language,
			snippetType,
			projectPath,
		});
	},

	cancelTestGeneration: async (): Promise<{
		success: boolean;
		cancelled?: boolean;
		error?: string;
	}> => {
		return await ipcRenderer.invoke("test-generation:cancel");
	},

	onTestGenerationStatus: (callback: (status: string) => void) => {
		// Remove any existing listener for this callback before adding a new one
		const existing = statusListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:status", existing);
		}
		const listener = (_event: IpcRendererEvent, status: string) =>
			callback(status);
		statusListeners.set(callback, listener);
		ipcRenderer.on("test-generation:status", listener);
	},

	onTestGenerationError: (callback: (error: string) => void) => {
		const existing = errorListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:error", existing);
		}
		const listener = (_event: IpcRendererEvent, error: string) =>
			callback(error);
		errorListeners.set(callback, listener);
		ipcRenderer.on("test-generation:error", listener);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	onTestGenerationResult: (callback: (result: any) => void) => {
		const existing = resultListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:result", existing);
		}
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		const listener = (_event: IpcRendererEvent, result: any) =>
			callback(result);
		resultListeners.set(callback, listener);
		ipcRenderer.on("test-generation:result", listener);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	onTestGenerationComplete: (callback: (result: any) => void) => {
		const existing = completeListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:complete", existing);
		}
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		const listener = (_event: IpcRendererEvent, result: any) =>
			callback(result);
		completeListeners.set(callback, listener);
		ipcRenderer.on("test-generation:complete", listener);
	},

	onTestGenerationProgress: (callback: (event: TestGenStageEvent) => void) => {
		const existing = progressListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:progress", existing);
		}
		const listener = (_event: IpcRendererEvent, payload: TestGenStageEvent) =>
			callback(payload);
		progressListeners.set(callback, listener);
		ipcRenderer.on("test-generation:progress", listener);
	},

	onTestGenerationCode: (callback: (delta: string) => void) => {
		const existing = codeListeners.get(callback);
		if (existing) {
			ipcRenderer.removeListener("test-generation:code", existing);
		}
		const listener = (_event: IpcRendererEvent, delta: string) =>
			callback(delta);
		codeListeners.set(callback, listener);
		ipcRenderer.on("test-generation:code", listener);
	},

	removeTestGenerationStatusListener: (callback: (status: string) => void) => {
		const listener = statusListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:status", listener);
			statusListeners.delete(callback);
		}
	},

	removeTestGenerationProgressListener: (
		callback: (event: TestGenStageEvent) => void,
	) => {
		const listener = progressListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:progress", listener);
			progressListeners.delete(callback);
		}
	},

	removeTestGenerationCodeListener: (callback: (delta: string) => void) => {
		const listener = codeListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:code", listener);
			codeListeners.delete(callback);
		}
	},

	removeTestGenerationErrorListener: (callback: (error: string) => void) => {
		const listener = errorListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:error", listener);
			errorListeners.delete(callback);
		}
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	removeTestGenerationResultListener: (callback: (result: any) => void) => {
		const listener = resultListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:result", listener);
			resultListeners.delete(callback);
		}
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	removeTestGenerationCompleteListener: (callback: (result: any) => void) => {
		const listener = completeListeners.get(callback);
		if (listener) {
			ipcRenderer.removeListener("test-generation:complete", listener);
			completeListeners.delete(callback);
		}
	},
});
