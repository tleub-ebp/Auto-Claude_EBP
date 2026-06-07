/**
 * Typed client for the three agent-tooling endpoints added with the
 * "Cost Estimator / Restart / Prompt Preview" feature.
 *
 *   POST /api/cost-estimator/preview
 *   GET  /api/restart/plan
 *   POST /api/restart/prepare
 *   GET  /api/prompt-preview/
 *
 * Each call returns `{ ok: true, data: T } | { ok: false, error: string }`
 * so callers don't have to repeat the success/error switch. AbortSignal
 * is supported on every call (for useEffect cleanup).
 */

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

const backendUrl = (): string =>
	(import.meta.env?.VITE_BACKEND_URL) ?? "";

async function _post<T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<ApiResult<T>> {
	try {
		const res = await fetch(`${backendUrl()}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const json = (await res.json()) as Record<string, unknown>;
		if (json.success === true) {
			return { ok: true, data: json as T };
		}
		return {
			ok: false,
			error:
				typeof json.error === "string"
					? json.error
					: `request failed with HTTP ${res.status}`,
		};
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			return { ok: false, error: "aborted" };
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "network error",
		};
	}
}

async function _get<T>(
	path: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<ApiResult<T>> {
	try {
		const qs = new URLSearchParams(params).toString();
		const res = await fetch(`${backendUrl()}${path}?${qs}`, { signal });
		const json = (await res.json()) as Record<string, unknown>;
		if (json.success === true) {
			return { ok: true, data: json as T };
		}
		return {
			ok: false,
			error:
				typeof json.error === "string"
					? json.error
					: `request failed with HTTP ${res.status}`,
		};
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			return { ok: false, error: "aborted" };
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "network error",
		};
	}
}

// ---------------------------------------------------------------------------
// Cost Estimator

export interface PhaseEstimate {
	phase: string;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	iterations: number;
	estimated_cost_usd: number;
	notes: string[];
}

export interface CostEstimate {
	spec_id: string;
	spec_chars: number;
	base_input_tokens: number;
	phases: PhaseEstimate[];
	total_cost_usd: number;
	confidence: "high" | "medium" | "low";
	warnings: string[];
}

export async function previewBuildCost(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ estimate: CostEstimate }>> {
	return _post<{ estimate: CostEstimate }>(
		"/api/cost-estimator/preview",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Restart Planner

export type RestartMode = "qa" | "coder" | "full";

export interface RestartPlan {
	spec_id: string;
	can_restart_qa: boolean;
	can_restart_coder: boolean;
	can_restart_full: boolean;
	reasons: Record<string, string>;
	next_subtask_for_coder: string | null;
	completed_subtasks: number;
	total_subtasks: number;
	files_to_clean: Record<RestartMode, string[]>;
}

export async function fetchRestartPlan(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ plan: RestartPlan }>> {
	return _get<{ plan: RestartPlan }>(
		"/api/restart/plan",
		{ spec_dir: specDir },
		signal,
	);
}

export interface RestartPrepareResult {
	mode: RestartMode;
	deleted: string[];
	warnings: string[];
}

export async function prepareRestart(
	specDir: string,
	mode: RestartMode,
	signal?: AbortSignal,
): Promise<ApiResult<RestartPrepareResult>> {
	return _post<RestartPrepareResult>(
		"/api/restart/prepare",
		{ spec_dir: specDir, mode },
		signal,
	);
}

// ---------------------------------------------------------------------------
// System Prompt Preview

export interface PromptPreview {
	project_dir: string;
	spec_dir: string;
	agent_type: string;
	model: string;
	provider: string;
	system_prompt: string;
	system_prompt_length: number;
	claude_md_included: boolean;
	domain_addendum_included: boolean;
	domain_addendum_chars: number;
	allowed_tools: string[];
	notes: string[];
}

export async function fetchPromptPreview(
	projectDir: string,
	specDir: string,
	agentType: string = "coder",
	signal?: AbortSignal,
): Promise<ApiResult<{ preview: PromptPreview }>> {
	return _get<{ preview: PromptPreview }>(
		"/api/prompt-preview/",
		{
			project_dir: projectDir,
			spec_dir: specDir,
			agent_type: agentType,
		},
		signal,
	);
}

// ---------------------------------------------------------------------------
// Timeline (audit trail per spec)

export interface TimelineEntry {
	sequence: number;
	timestamp_unix: number;
	timestamp_iso: string;
	delta_seconds: number;
	kind: string;
	actor: string;
	phase: string;
	summary: string;
	payload: Record<string, unknown>;
	event_hash: string;
}

export interface Timeline {
	correlation_id: string;
	entries: TimelineEntry[];
	entry_count: number;
	integrity: { intact: boolean; reason: string | null };
	duration_seconds: number;
	phase_counts: Record<string, number>;
}

export async function fetchTimeline(
	projectDir: string,
	correlationId: string,
	options?: {
		actor?: string;
		kind?: string;
		signal?: AbortSignal;
	},
): Promise<ApiResult<{ timeline: Timeline }>> {
	const params: Record<string, string> = { project_dir: projectDir };
	if (options?.actor) params.actor = options.actor;
	if (options?.kind) params.kind = options.kind;
	return _get<{ timeline: Timeline }>(
		`/api/timeline/${encodeURIComponent(correlationId)}`,
		params,
		options?.signal,
	);
}

// ---------------------------------------------------------------------------
// Progress indicator (fine-grained sub-status)

export interface ProgressIndicatorPayload {
	spec_id: string;
	label: string;
	phase:
		| "planning"
		| "coding"
		| "qa"
		| "idle"
		| "completed"
		| "unknown";
	sub_phase: string | null;
	subtasks_completed: number;
	subtasks_total: number;
	current_subtask_id: string | null;
	current_session: number | null;
	last_activity_iso: string | null;
	warnings: string[];
}

export async function fetchProgressIndicator(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ indicator: ProgressIndicatorPayload }>> {
	return _get<{ indicator: ProgressIndicatorPayload }>(
		"/api/progress-indicator/",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// QA auto-promotion (item 8)

export interface PromotionDecision {
	spec_id: string;
	score: number;
	threshold: number | null;
	promote: boolean;
	reasons: string[];
	breakdown: Record<string, number>;
}

export async function fetchPromotionDecision(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ decision: PromotionDecision }>> {
	return _post<{ decision: PromotionDecision }>(
		"/api/qa-promotion/decide",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Parallel variations (item 9)

export interface VariationDescriptor {
	label: string;
	path: string;
	spec_id: string;
	seed: number;
}

export interface VariationManifest {
	spec_id: string;
	parent_path: string;
	variations: VariationDescriptor[];
}

export interface VariationComparison {
	spec_id: string;
	rows: Array<{
		label: string;
		subtasks_completed: number;
		subtasks_total: number;
		qa_status: string;
		qa_report_chars: number;
		has_self_review: boolean;
	}>;
	suggested_winner: string | null;
}

export async function listVariations(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ manifest: VariationManifest }>> {
	return _get<{ manifest: VariationManifest }>(
		"/api/parallel-variations/list",
		{ spec_dir: specDir },
		signal,
	);
}

export async function createVariations(
	specDir: string,
	count: number,
	signal?: AbortSignal,
): Promise<ApiResult<{ manifest: VariationManifest }>> {
	return _post<{ manifest: VariationManifest }>(
		"/api/parallel-variations/create",
		{ spec_dir: specDir, count },
		signal,
	);
}

export async function compareVariations(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ comparison: VariationComparison }>> {
	return _get<{ comparison: VariationComparison }>(
		"/api/parallel-variations/compare",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Virtual reviewer (item 10)

export interface VirtualReviewSummaryPayload {
	spec_id: string;
	spec_chars: number;
	qa_report_chars: number;
	self_review_present: boolean;
	diff_excerpt: string;
	diff_truncated: boolean;
	error: string | null;
}

export async function fetchVirtualReviewSummary(
	specDir: string,
	projectDir: string,
	signal?: AbortSignal,
): Promise<
	ApiResult<{ summary: VirtualReviewSummaryPayload; enabled: boolean }>
> {
	return _get<{ summary: VirtualReviewSummaryPayload; enabled: boolean }>(
		"/api/virtual-reviewer/summary",
		{ spec_dir: specDir, project_dir: projectDir },
		signal,
	);
}

export async function runVirtualReview(
	specDir: string,
	projectDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ written_to: string; filename: string }>> {
	return _post<{ written_to: string; filename: string }>(
		"/api/virtual-reviewer/run",
		{ spec_dir: specDir, project_dir: projectDir },
		signal,
	);
}
