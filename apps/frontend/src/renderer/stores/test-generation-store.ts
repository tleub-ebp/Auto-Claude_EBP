import { create } from "zustand";
import { useProjectStore } from "./project-store";

/**
 * Function information from coverage analysis
 */
export interface FunctionInfo {
	name: string;
	module: string;
	class_name: string | null;
	args: string[];
	return_type: string | null;
	docstring: string;
	line_number: number;
	is_async: boolean;
	decorators: string[];
	complexity: number;
	full_name: string;
	is_private: boolean;
	is_dunder: boolean;
}

/**
 * Coverage gap information
 */
export interface CoverageGap {
	function: FunctionInfo;
	priority: "high" | "medium" | "low";
	reason: string;
	suggested_test_count: number;
}

/**
 * Generated test information
 */
export interface GeneratedTest {
	test_name: string;
	test_code: string;
	target_function: string;
	test_type: "unit" | "integration" | "e2e";
	description: string;
	imports: string[];
	fixtures: string[];
}

/**
 * Test generation result
 */
export interface TestGenerationResult {
	source_file: string;
	functions_analyzed: number;
	tests_generated: number;
	coverage_gaps: CoverageGap[];
	generated_tests: GeneratedTest[];
	test_file_content: string;
	test_file_path: string;
}

/**
 * Post-build generation result
 */
export interface PostBuildResult {
	source_file: string;
	tests_generated: number;
	test_file_path: string;
	test_file_content: string;
}

export type TestGenerationPhase =
	| "idle"
	| "analyzing"
	| "generating"
	| "complete"
	| "error";

/** Pipeline stage ids emitted by the backend during a live generation. */
export type StageId = "detect" | "read" | "generate" | "write" | "done";

/** A live pipeline-stage event coming from the backend runner. */
export interface TestGenStageEvent {
	type: "stage";
	stage: StageId;
	status?: "done";
	detail?: string;
	language?: string;
	framework?: string;
	path?: string;
	tests?: number;
}

/** A stage as tracked in the store (arrival order preserved). */
export interface LiveStage {
	id: StageId;
	status: "active" | "done";
	detail?: string;
}

/** Rolling metadata surfaced in the live stats strip. */
export interface LiveMeta {
	language?: string;
	framework?: string;
	path?: string;
	tests?: number;
}

interface TestGenerationState {
	// State
	phase: TestGenerationPhase;
	status: string;
	result: TestGenerationResult | null;
	postBuildResults: PostBuildResult[] | null;
	error: string | null;
	isOpen: boolean;
	selectedFile: string;
	existingTestPath: string | null;
	coverageTarget: number;
	tddLanguage: string;
	tddSnippetType: string;

	// Live streaming state
	liveStages: LiveStage[];
	streamedCode: string;
	liveMeta: LiveMeta;
	genStartedAt: number | null;
	/** True when the current/last run is a streaming generation (not analyze). */
	isLiveRun: boolean;

	// Actions
	openDialog: (filePath: string, existingTestPath?: string) => void;
	closeDialog: () => void;
	setPhase: (phase: TestGenerationPhase) => void;
	setStatus: (status: string) => void;
	setResult: (result: TestGenerationResult) => void;
	setPostBuildResults: (postBuildResults: PostBuildResult[]) => void;
	setError: (error: string) => void;
	setCoverageTarget: (target: number) => void;
	setTddLanguage: (language: string) => void;
	setTddSnippetType: (snippetType: string) => void;
	setSelectedFile: (filePath: string) => void;
	reset: () => void;
	resetLive: () => void;
	applyStageEvent: (event: TestGenStageEvent) => void;
	appendCode: (delta: string) => void;
	cancelGeneration: () => void;
	createErrorHandler: (
		cleanup: () => void,
		reject: (reason?: unknown) => void,
	) => (error: string) => void;
	createCleanupHandler: (listeners: Array<() => void>) => () => void;

	// API Actions
	analyzeCoverage: (
		filePath: string,
		existingTestPath?: string,
	) => Promise<CoverageGap[]>;
	generateUnitTests: (
		filePath: string,
		existingTestPath?: string,
		coverageTarget?: number,
	) => Promise<TestGenerationResult>;
	generateE2ETests: (
		userStory: string,
		targetModule: string,
	) => Promise<TestGenerationResult>;
	generateTDDTests: (spec: {
		description: string;
		language: string;
		snippet_type: string;
	}) => Promise<TestGenerationResult>;
	runPostBuildGeneration: (
		projectPath: string,
		modifiedFiles: string[],
	) => Promise<PostBuildResult[]>;
}

const initialState = {
	phase: "idle" as TestGenerationPhase,
	status: "",
	result: null,
	postBuildResults: null,
	error: null,
	isOpen: false,
	selectedFile: "",
	existingTestPath: null,
	coverageTarget: 80,
	tddLanguage: "typescript",
	tddSnippetType: "function",
	liveStages: [] as LiveStage[],
	streamedCode: "",
	liveMeta: {} as LiveMeta,
	genStartedAt: null as number | null,
	isLiveRun: false,
};

export const useTestGenerationStore = create<TestGenerationState>(
	(set, get) => ({
		...initialState,

		// Common error handler for test generation
		createErrorHandler: (
			cleanup: () => void,
			reject: (reason?: unknown) => void,
		) => {
			const { setPhase, setError } = get();
			return (error: string) => {
				cleanup();
				setPhase("error");
				setError(error);
				reject(new Error(error));
			};
		},

		// Common cleanup handler for removing listeners
		createCleanupHandler: (listeners: Array<() => void>) => {
			return () => {
				listeners.forEach((listener) => listener());
			};
		},

		openDialog: (filePath: string, existingTestPath?: string) => {
			set({
				isOpen: true,
				selectedFile: filePath,
				existingTestPath: existingTestPath || null,
				phase: "idle",
				status: "",
				result: null,
				error: null,
			});
		},

		closeDialog: () => {
			set({
				isOpen: false,
				phase: "idle",
				status: "",
				result: null,
				error: null,
			});
		},

		setPhase: (phase: TestGenerationPhase) => set({ phase }),
		setStatus: (status: string) => set({ status }),
		setResult: (result: TestGenerationResult) => set({ result }),
		setPostBuildResults: (postBuildResults: PostBuildResult[]) =>
			set({ postBuildResults }),
		setError: (error: string) => set({ error }),
		setCoverageTarget: (coverageTarget: number) => set({ coverageTarget }),
		setTddLanguage: (tddLanguage: string) => set({ tddLanguage }),
		setTddSnippetType: (tddSnippetType: string) => set({ tddSnippetType }),
		setSelectedFile: (filePath: string) => set({ selectedFile: filePath }),

		reset: () => set(initialState),

		resetLive: () =>
			set({
				liveStages: [],
				streamedCode: "",
				liveMeta: {},
				genStartedAt: Date.now(),
				isLiveRun: true,
			}),

		applyStageEvent: (event: TestGenStageEvent) =>
			set((state) => {
				// The terminal "done" event finalises the run: mark every stage done
				// and fold in the final metadata (path, test count) — it is not a
				// visible pipeline step of its own.
				if (event.stage === "done") {
					const liveMeta: LiveMeta = { ...state.liveMeta };
					if (event.path) liveMeta.path = event.path;
					if (typeof event.tests === "number") liveMeta.tests = event.tests;
					return {
						liveStages: state.liveStages.map((s) => ({
							...s,
							status: "done" as const,
						})),
						liveMeta,
					};
				}
				const isDone = event.status === "done";
				const existing = state.liveStages.find((s) => s.id === event.stage);
				let liveStages: LiveStage[];
				if (existing) {
					liveStages = state.liveStages.map((s) =>
						s.id === event.stage
							? {
									id: s.id,
									status: isDone ? "done" : s.status,
									detail: event.detail ?? s.detail,
								}
							: s,
					);
				} else {
					// First sight of this stage: mark any still-active earlier stage
					// done (the backend has clearly moved on), then append.
					liveStages = [
						...state.liveStages.map((s) =>
							s.status === "active" ? { ...s, status: "done" as const } : s,
						),
						{
							id: event.stage,
							status: isDone ? "done" : "active",
							detail: event.detail,
						},
					];
				}
				const liveMeta: LiveMeta = { ...state.liveMeta };
				if (event.language) liveMeta.language = event.language;
				if (event.framework) liveMeta.framework = event.framework;
				if (event.path) liveMeta.path = event.path;
				if (typeof event.tests === "number") liveMeta.tests = event.tests;
				return { liveStages, liveMeta };
			}),

		appendCode: (delta: string) =>
			set((state) => ({ streamedCode: state.streamedCode + delta })),

		cancelGeneration: () => {
			try {
				globalThis.electronAPI.cancelTestGeneration();
			} catch {
				// best-effort — the process may already be gone
			}
			set({
				phase: "idle",
				status: "",
				liveStages: [],
				streamedCode: "",
				liveMeta: {},
				genStartedAt: null,
			});
		},

		analyzeCoverage: async (filePath: string, existingTestPath?: string) => {
			const { setPhase, setStatus } = get();
			setPhase("analyzing");
			setStatus("Analyzing test coverage...");
			set({ isLiveRun: false });

			return new Promise<CoverageGap[]>((resolve, reject) => {
				const onStatus = (status: string) => setStatus(status);
				const cleanup = get().createCleanupHandler([
					() =>
						globalThis.electronAPI.removeTestGenerationStatusListener(onStatus),
					() =>
						globalThis.electronAPI.removeTestGenerationResultListener(onResult),
					() =>
						globalThis.electronAPI.removeTestGenerationErrorListener(onError),
				]);
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const onResult = (data: any) => {
					cleanup();
					setPhase("complete");
					setStatus("Coverage analysis complete");
					resolve((data as { gaps?: CoverageGap[] }).gaps || []);
				};
				const onError = get().createErrorHandler(cleanup, reject);
				const projectPath = useProjectStore.getState().getActiveProject()?.path;
				globalThis.electronAPI.onTestGenerationStatus(onStatus);
				globalThis.electronAPI.onTestGenerationResult(onResult);
				globalThis.electronAPI.onTestGenerationError(onError);
				globalThis.electronAPI.analyzeTestCoverage(
					filePath,
					existingTestPath,
					projectPath,
				);
			});
		},

		generateUnitTests: async (
			filePath: string,
			existingTestPath?: string,
			coverageTarget?: number,
		) => {
			const { setPhase, setStatus, setResult, resetLive } = get();
			setPhase("generating");
			setStatus("Generating unit tests...");
			resetLive();

			return new Promise<TestGenerationResult>((resolve, reject) => {
				const onStatus = (status: string) => setStatus(status);
				const onProgress = (event: TestGenStageEvent) =>
					get().applyStageEvent(event);
				const onCode = (delta: string) => get().appendCode(delta);
				const cleanup = get().createCleanupHandler([
					() =>
						globalThis.electronAPI.removeTestGenerationStatusListener(onStatus),
					() =>
						globalThis.electronAPI.removeTestGenerationCompleteListener(
							onComplete,
						),
					() =>
						globalThis.electronAPI.removeTestGenerationErrorListener(onError),
					() =>
						globalThis.electronAPI.removeTestGenerationProgressListener(
							onProgress,
						),
					() => globalThis.electronAPI.removeTestGenerationCodeListener(onCode),
				]);
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const onComplete = (data: any) => {
					cleanup();
					const parsed = data as { result?: TestGenerationResult };
					const result = parsed.result as TestGenerationResult;
					setPhase("complete");
					setStatus("Unit tests generated successfully");
					setResult(result);
					resolve(result);
				};
				const onError = get().createErrorHandler(cleanup, reject);
				const projectPath = useProjectStore.getState().getActiveProject()?.path;
				globalThis.electronAPI.onTestGenerationStatus(onStatus);
				globalThis.electronAPI.onTestGenerationComplete(onComplete);
				globalThis.electronAPI.onTestGenerationError(onError);
				globalThis.electronAPI.onTestGenerationProgress(onProgress);
				globalThis.electronAPI.onTestGenerationCode(onCode);
				globalThis.electronAPI.generateUnitTests(
					filePath,
					existingTestPath,
					coverageTarget,
					projectPath,
				);
			});
		},

		generateE2ETests: async (userStory: string, targetModule: string) => {
			const { setPhase, setStatus, setResult, resetLive } = get();
			setPhase("generating");
			setStatus("Generating E2E tests...");
			resetLive();

			return new Promise<TestGenerationResult>((resolve, reject) => {
				const onStatus = (status: string) => setStatus(status);
				const onProgress = (event: TestGenStageEvent) =>
					get().applyStageEvent(event);
				const onCode = (delta: string) => get().appendCode(delta);
				const cleanup = get().createCleanupHandler([
					() =>
						globalThis.electronAPI.removeTestGenerationStatusListener(onStatus),
					() =>
						globalThis.electronAPI.removeTestGenerationCompleteListener(
							onComplete,
						),
					() =>
						globalThis.electronAPI.removeTestGenerationErrorListener(onError),
					() =>
						globalThis.electronAPI.removeTestGenerationProgressListener(
							onProgress,
						),
					() => globalThis.electronAPI.removeTestGenerationCodeListener(onCode),
				]);
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const onComplete = (data: any) => {
					cleanup();
					const parsed = data as { result?: TestGenerationResult };
					const result = parsed.result as TestGenerationResult;
					setPhase("complete");
					setStatus("E2E tests generated successfully");
					setResult(result);
					resolve(result);
				};
				const onError = get().createErrorHandler(cleanup, reject);
				const projectPath = useProjectStore.getState().getActiveProject()?.path;
				globalThis.electronAPI.onTestGenerationStatus(onStatus);
				globalThis.electronAPI.onTestGenerationComplete(onComplete);
				globalThis.electronAPI.onTestGenerationError(onError);
				globalThis.electronAPI.onTestGenerationProgress(onProgress);
				globalThis.electronAPI.onTestGenerationCode(onCode);
				globalThis.electronAPI.generateE2ETests(
					userStory,
					targetModule,
					projectPath,
				);
			});
		},

		generateTDDTests: async (spec: {
			description: string;
			language: string;
			snippet_type: string;
		}) => {
			const { setPhase, setStatus, setResult, resetLive } = get();
			setPhase("generating");
			setStatus("Generating TDD tests...");
			resetLive();

			return new Promise<TestGenerationResult>((resolve, reject) => {
				const onStatus = (status: string) => setStatus(status);
				const onProgress = (event: TestGenStageEvent) =>
					get().applyStageEvent(event);
				const onCode = (delta: string) => get().appendCode(delta);
				const cleanup = get().createCleanupHandler([
					() =>
						globalThis.electronAPI.removeTestGenerationStatusListener(onStatus),
					() =>
						globalThis.electronAPI.removeTestGenerationCompleteListener(
							onComplete,
						),
					() =>
						globalThis.electronAPI.removeTestGenerationErrorListener(onError),
					() =>
						globalThis.electronAPI.removeTestGenerationProgressListener(
							onProgress,
						),
					() => globalThis.electronAPI.removeTestGenerationCodeListener(onCode),
				]);
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const onComplete = (data: any) => {
					cleanup();
					const parsed = data as { result?: TestGenerationResult };
					const result = parsed.result as TestGenerationResult;
					setPhase("complete");
					setStatus("TDD tests generated successfully");
					setResult(result);
					resolve(result);
				};
				const onError = get().createErrorHandler(cleanup, reject);
				const projectPath = useProjectStore.getState().getActiveProject()?.path;
				globalThis.electronAPI.onTestGenerationStatus(onStatus);
				globalThis.electronAPI.onTestGenerationComplete(onComplete);
				globalThis.electronAPI.onTestGenerationError(onError);
				globalThis.electronAPI.onTestGenerationProgress(onProgress);
				globalThis.electronAPI.onTestGenerationCode(onCode);
				globalThis.electronAPI.generateTDDTests(
					spec.description,
					spec.language,
					spec.snippet_type,
					projectPath,
				);
			});
		},

		runPostBuildGeneration: async (
			projectPath: string,
			modifiedFiles: string[],
		) => {
			const { setPhase, setStatus, setError } = get();

			try {
				setPhase("generating");
				setStatus("Running post-build test generation...");

				// Post-build generation is not yet wired via IPC — placeholder for future implementation
				throw new Error(
					`Post-build generation for ${projectPath} with ${modifiedFiles.length} file(s) is not yet implemented via IPC`,
				);
			} catch (error) {
				setPhase("error");
				setError(error instanceof Error ? error.message : "Unknown error");
				throw error;
			}
		},
	}),
);

// Helper function to open dialog
export const openTestGenerationDialog = () => {
	const store = useTestGenerationStore.getState();
	store.reset();
	store.openDialog("", "");
};
