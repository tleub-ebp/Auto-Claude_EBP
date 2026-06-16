/**
 * Per-model pricing in USD per 1M tokens.
 *
 * This is a pragmatic mirror of `apps/backend/cost_intelligence/catalog.py`
 * for use in the renderer where the backend isn't reachable (e.g. for live
 * cost previews that update as the user types). Keep input/output rates in
 * sync; cache/thinking/vision are intentionally omitted because the panels
 * that consume this estimate at the moment only have generic input+output
 * token budgets to work with.
 *
 * If you add a model here, mirror it in catalog.py and vice versa.
 */

export interface ModelPricing {
	/** Provider key (lower-case), matching `selectedProvider` in ProviderContext. */
	provider: string;
	/** Model identifier as exposed by the provider. */
	model: string;
	/** USD per 1M input tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
}

const RAW: Record<string, Record<string, { input: number; output: number }>> = {
	anthropic: {
		"claude-opus-4-8": { input: 5.0, output: 25.0 },
		// Fable 5 (Mythos-class, GA 2026-06-09) — prix public $10 / $50 par MTok.
		"claude-fable-5": { input: 10.0, output: 50.0 },
		// Mythos 5 — mêmes capacités/prix que Fable 5 (Project Glasswing).
		"claude-mythos-5": { input: 10.0, output: 50.0 },
		"claude-sonnet-4-8": { input: 3.0, output: 15.0 },
		"claude-haiku-4-8": { input: 1.0, output: 5.0 },
		"claude-opus-4-7": { input: 5.0, output: 25.0 },
		"claude-sonnet-4-7": { input: 3.0, output: 15.0 },
		"claude-haiku-4-7": { input: 1.0, output: 5.0 },
		"claude-opus-4-6": { input: 5.0, output: 25.0 },
		"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
		"claude-haiku-4-6": { input: 1.0, output: 5.0 },
		"claude-opus-4-5": { input: 5.0, output: 25.0 },
		"claude-opus-4-5-20251101": { input: 5.0, output: 25.0 },
		"claude-sonnet-4-5": { input: 3.0, output: 15.0 },
		"claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
		"claude-haiku-4-5": { input: 1.0, output: 5.0 },
		"claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
		// Shorthand aliases used by AVAILABLE_MODELS / MODEL_ID_MAP.
		opus: { input: 5.0, output: 25.0 },
		sonnet: { input: 3.0, output: 15.0 },
		haiku: { input: 1.0, output: 5.0 },
		"opus-4-5": { input: 5.0, output: 25.0 },
		"sonnet-4-5": { input: 3.0, output: 15.0 },
		"haiku-4-5": { input: 1.0, output: 5.0 },
	},
	// Non-Anthropic prices are best-effort estimates — verify against provider sheets.
	openai: {
		"gpt-5.1": { input: 1.25, output: 10.0 },
		"gpt-5": { input: 1.25, output: 10.0 },
		"gpt-5-mini": { input: 0.25, output: 2.0 },
		"gpt-4.1": { input: 2.5, output: 10.0 },
		"gpt-4o": { input: 2.5, output: 10.0 },
		"gpt-4o-mini": { input: 0.15, output: 0.6 },
		o3: { input: 2.0, output: 8.0 },
	},
	google: {
		"gemini-3-pro": { input: 2.0, output: 12.0 },
		"gemini-3-flash": { input: 0.3, output: 1.2 },
		"gemini-2.5-pro": { input: 1.25, output: 5.0 },
		"gemini-2.5-flash": { input: 0.15, output: 0.6 },
	},
	xai: {
		"grok-4": { input: 5.0, output: 15.0 },
	},
	grok: {
		"grok-4": { input: 5.0, output: 15.0 },
		"grok-2": { input: 2.0, output: 10.0 },
		"grok-2-mini": { input: 0.3, output: 0.5 },
	},
	mistral: {
		"mistral-large": { input: 2.0, output: 6.0 },
		"mistral-large-3": { input: 2.0, output: 6.0 },
		codestral: { input: 0.3, output: 0.9 },
	},
	deepseek: {
		"deepseek-v3": { input: 0.27, output: 1.1 },
		"deepseek-v3.2": { input: 0.27, output: 1.1 },
		"deepseek-coder-v3": { input: 0.14, output: 0.28 },
	},
	groq: {
		"llama-3.3-70b": { input: 0.59, output: 0.79 },
		"mixtral-8x7b": { input: 0.24, output: 0.24 },
	},
	together: {
		"llama-3.3-70b": { input: 0.88, output: 0.88 },
	},
	fireworks: {
		"llama-3.3-70b": { input: 0.9, output: 0.9 },
	},
	meta: {
		"llama-3.3-70b": { input: 0.72, output: 0.72 },
		"llama-4-maverick": { input: 2.0, output: 6.0 },
	},
	aws: {
		"anthropic.claude-opus-4-8": { input: 5.0, output: 25.0 },
		"anthropic.claude-opus-4-8-v1": { input: 5.0, output: 25.0 },
		"anthropic.claude-fable-5": { input: 10.0, output: 50.0 },
		"anthropic.claude-opus-4-6": { input: 5.0, output: 25.0 },
		"anthropic.claude-sonnet-4-6": { input: 3.0, output: 15.0 },
		"meta.llama-3.3-70b": { input: 0.72, output: 0.72 },
	},
	// Flat-rate seat licensing — token cost reported as 0 so widgets render
	// without claiming bogus numbers. Display layer should annotate this.
	copilot: {
		"gpt-4.1": { input: 0, output: 0 },
		"gpt-4o": { input: 0, output: 0 },
		"claude-sonnet-4-6": { input: 0, output: 0 },
		"gemini-2.5-pro": { input: 0, output: 0 },
	},
	windsurf: {
		"windsurf-default": { input: 0, output: 0 },
		"windsurf-premier": { input: 0, output: 0 },
		"windsurf-cascade": { input: 0, output: 0 },
		"swe-1.5": { input: 0, output: 0 },
	},
	cursor: {
		"cursor-default": { input: 0, output: 0 },
	},
	ollama: {
		"llama-3.3-70b": { input: 0, output: 0 },
		"deepseek-coder-v3": { input: 0, output: 0 },
		"mistral-large": { input: 0, output: 0 },
		"qwen-2.5-72b": { input: 0, output: 0 },
	},
};

// Aliases (provider name normalisation).
const PROVIDER_ALIASES: Record<string, string> = {
	claude: "anthropic",
};

/**
 * Look up pricing for a (provider, model) pair. Falls back to a prefix match
 * (e.g. "claude-sonnet-4-6-20251101" → "claude-sonnet-4-6") to mirror the
 * Python catalog's behaviour for versioned model IDs.
 *
 * Returns `null` when nothing matches — callers should treat that as
 * "unknown pricing", not "free".
 */
export function getModelPricing(
	provider: string | undefined | null,
	model: string | undefined | null,
): ModelPricing | null {
	if (!provider || !model) return null;
	const key = (PROVIDER_ALIASES[provider.toLowerCase()] ?? provider.toLowerCase());
	const models = RAW[key];
	if (!models) return null;

	if (models[model]) {
		return { provider: key, model, ...models[model] };
	}
	// Prefix match (handles "claude-sonnet-4-6-20251101" → "claude-sonnet-4-6")
	for (const [candidate, prices] of Object.entries(models)) {
		if (model.startsWith(candidate) || candidate.startsWith(model)) {
			return { provider: key, model: candidate, ...prices };
		}
	}
	return null;
}

/**
 * Whether a given (provider, model) is billed per token (true) or under a
 * flat-rate seat licence (false). Cursor / Windsurf / Copilot / Ollama all
 * fall in the latter bucket.
 */
export function isPerTokenBilled(
	provider: string | undefined | null,
	model: string | undefined | null,
): boolean {
	const p = getModelPricing(provider, model);
	if (!p) return false;
	return p.input > 0 || p.output > 0;
}

/**
 * Estimate USD cost for a given input + output token split.
 *
 * `outputRatio` defaults to 0.25 — i.e. for a 8000-token budget, assume the
 * model emits 2000 output tokens against 6000 input tokens. This is a
 * reasonable default for "extract relevant context" workloads but callers
 * can override it when they have better signal.
 */
export function estimateUsdCost(
	pricing: ModelPricing,
	totalTokens: number,
	outputRatio = 0.25,
): { input: number; output: number; total: number } {
	const safeRatio = Math.max(0, Math.min(1, outputRatio));
	const outputTokens = Math.round(totalTokens * safeRatio);
	const inputTokens = Math.max(0, totalTokens - outputTokens);
	const inputCost = (inputTokens * pricing.input) / 1_000_000;
	const outputCost = (outputTokens * pricing.output) / 1_000_000;
	return {
		input: inputCost,
		output: outputCost,
		total: inputCost + outputCost,
	};
}
