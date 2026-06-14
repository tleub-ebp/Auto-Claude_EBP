/**
 * Model and agent profile constants
 * Claude models, thinking levels, memory backends, and agent profiles
 */

import type {
	AgentProfile,
	FeatureModelConfig,
	FeatureThinkingConfig,
	PhaseModelConfig,
} from "../types/settings";

// ============================================
// Provider Model Catalog
// ============================================

export interface ProviderModel {
	value: string; // Model ID as sent to the API
	label: string; // Human-readable label
	tier: "flagship" | "standard" | "fast" | "local"; // Capability tier
	supportsThinking?: boolean; // Extended thinking / reasoning support
}

/** Models grouped by provider. Keys match provider names used in ProviderContext / provider_api.py */
export const PROVIDER_MODELS_MAP: Record<string, ProviderModel[]> = {
	// ---- Anthropic (Claude) ----
	anthropic: [
		{
			value: "claude-fable-5",
			label: "Claude Fable 5",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4-8",
			label: "Claude Opus 4.8",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4-7",
			label: "Claude Opus 4.7",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4-6",
			label: "Claude Opus 4.6",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "claude-haiku-4-6",
			label: "Claude Haiku 4.6",
			tier: "fast",
			supportsThinking: false,
		},
		{
			value: "claude-opus-4-5-20251101",
			label: "Claude Opus 4.5",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-sonnet-4-5-20250929",
			label: "Claude Sonnet 4.5",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "claude-haiku-4-5-20251001",
			label: "Claude Haiku 4.5",
			tier: "fast",
			supportsThinking: false,
		},
	],

	// ---- GitHub Copilot ----
	// Source: docs.github.com/en/copilot/reference/ai-models/supported-models
	// Updated: May 2026 — includes Claude 4.x Opus/Sonnet, GPT-5.x, o3/o4 families
	copilot: [
		// ── Flagship ─────────────────────────────────────────────────────────
		{
			value: "claude-opus-4.8",
			label: "Claude Opus 4.8 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4.7",
			label: "Claude Opus 4.7 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4.6",
			label: "Claude Opus 4.6 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4.5",
			label: "Claude Opus 4.5 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "gpt-5.5",
			label: "GPT-5.5 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "gpt-5.4",
			label: "GPT-5.4 (Copilot)",
			tier: "flagship",
			supportsThinking: true,
		},
		{ value: "gpt-4.1", label: "GPT-4.1 (Copilot)", tier: "flagship" },
		{ value: "gpt-4o", label: "GPT-4o (Copilot)", tier: "flagship" },
		// ── Standard ─────────────────────────────────────────────────────────
		{
			value: "claude-sonnet-4.6",
			label: "Claude Sonnet 4.6 (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "claude-sonnet-4.5",
			label: "Claude Sonnet 4.5 (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "o4-mini",
			label: "o4-mini (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "o3",
			label: "o3 (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "o3-mini",
			label: "o3-mini (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "o1",
			label: "o1 (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "claude-3.7-sonnet",
			label: "Claude 3.7 Sonnet (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "gemini-2.5-pro",
			label: "Gemini 2.5 Pro (Copilot)",
			tier: "standard",
			supportsThinking: true,
		},
		// ── Fast ─────────────────────────────────────────────────────────────
		{
			value: "claude-haiku-4.5",
			label: "Claude Haiku 4.5 (Copilot)",
			tier: "fast",
		},
		{
			value: "gemini-2.0-flash",
			label: "Gemini 2.0 Flash (Copilot)",
			tier: "fast",
		},
		{
			value: "gpt-4.1-mini",
			label: "GPT-4.1 mini (Copilot)",
			tier: "fast",
		},
		{
			value: "o1-mini",
			label: "o1-mini (Copilot)",
			tier: "fast",
			supportsThinking: true,
		},
		{ value: "gpt-4o-mini", label: "GPT-4o mini (Copilot)", tier: "fast" },
	],

	// ---- OpenAI ----
	// Source: platform.openai.com/docs/models — GPT-5.5 family released April 2026
	openai: [
		{
			value: "gpt-5.5-pro",
			label: "GPT-5.5 Pro",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "gpt-5.5",
			label: "GPT-5.5",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "gpt-5.5-mini",
			label: "GPT-5.5 mini",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "gpt-5.2",
			label: "GPT-5.2",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "o4",
			label: "o4",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "o4-mini",
			label: "o4-mini",
			tier: "standard",
			supportsThinking: true,
		},
		{ value: "gpt-4.1", label: "GPT-4.1", tier: "standard" },
		{ value: "gpt-4.1-mini", label: "GPT-4.1 mini", tier: "fast" },
	],

	// ---- Google Gemini ----
	google: [
		{
			value: "gemini-3.1-pro",
			label: "Gemini 3.1 Pro",
			tier: "flagship",
			supportsThinking: true,
		},
		{ value: "gemini-3-flash", label: "Gemini 3 Flash", tier: "flagship" },
		{
			value: "gemini-3.1-flash-lite",
			label: "Gemini 3.1 Flash-Lite",
			tier: "standard",
		},
		{
			value: "gemini-2.5-pro",
			label: "Gemini 2.5 Pro",
			tier: "flagship",
			supportsThinking: true,
		},
		{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast" },
		{
			value: "gemini-2.0-flash-thinking",
			label: "Gemini 2.0 Flash Thinking",
			tier: "standard",
			supportsThinking: true,
		},
		{ value: "gemini-1.5-pro", label: "Gemini 1.5 Pro", tier: "standard" },
		{ value: "gemini-1.5-flash", label: "Gemini 1.5 Flash", tier: "fast" },
	],

	// ---- Mistral AI ----
	mistral: [
		{ value: "mistral-large-3", label: "Mistral Large 3", tier: "flagship" },
		{ value: "ministral-3-14b", label: "Ministral 3 14B", tier: "standard" },
		{ value: "ministral-3-8b", label: "Ministral 3 8B", tier: "standard" },
		{ value: "ministral-3-3b", label: "Ministral 3 3B", tier: "fast" },
		{ value: "mistral-medium-3", label: "Mistral Medium 3", tier: "standard" },
		{ value: "mistral-small-3", label: "Mistral Small 3", tier: "fast" },
		{ value: "codestral", label: "Codestral", tier: "standard" },
		{ value: "mistral-7b", label: "Mistral 7B", tier: "fast" },
	],

	// ---- DeepSeek ----
	deepseek: [
		{ value: "deepseek-v3.2", label: "DeepSeek V3.2", tier: "flagship" },
		{
			value: "deepseek-r2",
			label: "DeepSeek R2",
			tier: "flagship",
			supportsThinking: true,
		},
		{ value: "deepseek-v3", label: "DeepSeek V3", tier: "standard" },
		{
			value: "deepseek-r1",
			label: "DeepSeek R1",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "deepseek-coder-v2",
			label: "DeepSeek Coder V2",
			tier: "standard",
		},
	],

	// ---- Grok (xAI) ----
	// Source: docs.x.ai/developers/models — Grok 4.3 flagship as of April 30, 2026
	grok: [
		{
			value: "grok-4.3",
			label: "Grok 4.3",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "grok-4.20-reasoning",
			label: "Grok 4.20 Reasoning",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "grok-4.1-fast",
			label: "Grok 4.1 Fast",
			tier: "fast",
			supportsThinking: true,
		},
		{
			value: "grok-4",
			label: "Grok 4",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "grok-3",
			label: "Grok 3",
			tier: "standard",
			supportsThinking: true,
		},
	],

	// ---- Meta (LLaMA) ----
	meta: [
		{
			value: "meta-llama/llama-4-scout",
			label: "Llama 4 Scout",
			tier: "flagship",
		},
		{
			value: "meta-llama/llama-3.3-70b",
			label: "Llama 3.3 70B",
			tier: "standard",
		},
		{
			value: "meta-llama/llama-3.1-70b",
			label: "Llama 3.1 70B",
			tier: "standard",
		},
		{ value: "meta-llama/llama-3.1-8b", label: "Llama 3.1 8B", tier: "fast" },
	],

	// ---- AWS Bedrock ----
	aws: [
		{
			value: "anthropic.claude-opus-4-8-v1",
			label: "Claude Opus 4.8 (Bedrock)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "anthropic.claude-fable-5",
			label: "Claude Fable 5 (Bedrock)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "anthropic.claude-opus-4-7-v1",
			label: "Claude Opus 4.7 (Bedrock)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "anthropic.claude-opus-4-6-v1",
			label: "Claude Opus 4.6 (Bedrock)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "anthropic.claude-sonnet-4-6-v1",
			label: "Claude Sonnet 4.6 (Bedrock)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "anthropic.claude-sonnet-4-5-v1",
			label: "Claude Sonnet 4.5 (Bedrock)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "amazon.titan-text-premier-v1",
			label: "Amazon Titan Premier",
			tier: "standard",
		},
		{
			value: "meta.llama3-70b-instruct-v1",
			label: "Llama 3 70B (Bedrock)",
			tier: "standard",
		},
	],

	// ---- Ollama / LLM local ----
	ollama: [
		{ value: "llama3.3", label: "Llama 3.3", tier: "local" },
		{ value: "llama3.2", label: "Llama 3.2", tier: "local" },
		{ value: "llama3.1", label: "Llama 3.1", tier: "local" },
		{ value: "mistral-large-3", label: "Mistral Large 3", tier: "local" },
		{ value: "mistral", label: "Mistral", tier: "local" },
		{ value: "mistral-large", label: "Mistral Large", tier: "local" },
		{ value: "deepseek-v3.2", label: "DeepSeek V3.2", tier: "local" },
		{
			value: "deepseek-r2",
			label: "DeepSeek R2",
			tier: "local",
			supportsThinking: true,
		},
		{
			value: "deepseek-r1",
			label: "DeepSeek R1",
			tier: "local",
			supportsThinking: true,
		},
		{ value: "deepseek-coder-v2", label: "DeepSeek Coder V2", tier: "local" },
		{ value: "qwen2.5-coder", label: "Qwen 2.5 Coder", tier: "local" },
		{ value: "qwen2.5", label: "Qwen 2.5", tier: "local" },
		{ value: "phi4", label: "Phi-4", tier: "local" },
		{ value: "gemma3", label: "Gemma 3", tier: "local" },
		{ value: "gemma2", label: "Gemma 2", tier: "local" },
		{ value: "codellama", label: "CodeLlama", tier: "local" },
		{ value: "yi", label: "Yi", tier: "local" },
		{ value: "mixtral", label: "Mixtral", tier: "local" },
		{ value: "vicuna", label: "Vicuna", tier: "local" },
		{ value: "wizardlm", label: "WizardLM", tier: "local" },
		{ value: "solar", label: "Solar Pro", tier: "local" },
		{ value: "custom", label: "Autre (saisie libre)", tier: "local" },
	],

	// ---- Custom/Enterprise API ----
	custom: [
		{
			value: "custom-model-1",
			label: "Custom Model 1",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "custom-model-2",
			label: "Custom Model 2",
			tier: "standard",
			supportsThinking: true,
		},
		{ value: "custom-model-3", label: "Custom Model 3", tier: "fast" },
		{
			value: "custom",
			label: "Autre (saisie libre)",
			tier: "local",
			supportsThinking: true,
		},
	],

	// ---- Windsurf (Codeium) ----
	// Source: docs.windsurf.com/windsurf/models
	// Model IDs MUST be the friendly slugs resolved by the Windsurf proxy
	// (apps/backend/integrations/windsurf_proxy/models.py → MODEL_NAME_TO_ENUM).
	// Generic future IDs (claude-opus-4-8, gpt-5.5, gemini-3.1-pro) are NOT
	// served by the Windsurf gRPC backend and must not be exposed here.
	windsurf: [
		{ value: "swe-1.6", label: "SWE-1.6", tier: "flagship" },
		{ value: "swe-1.6-fast", label: "SWE-1.6 Fast", tier: "fast" },
		{ value: "swe-1.5", label: "SWE-1.5", tier: "flagship" },
		{
			value: "swe-1.5-thinking",
			label: "SWE-1.5 Thinking",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-opus-4",
			label: "Claude Opus 4 (Windsurf)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-sonnet-4",
			label: "Claude Sonnet 4 (Windsurf)",
			tier: "flagship",
			supportsThinking: true,
		},
		{
			value: "claude-3.7-sonnet",
			label: "Claude 3.7 Sonnet (Windsurf)",
			tier: "standard",
			supportsThinking: true,
		},
		{ value: "gpt-4.1", label: "GPT-4.1 (Windsurf)", tier: "standard" },
		{ value: "gpt-4o", label: "GPT-4o (Windsurf)", tier: "standard" },
		{
			value: "gemini-2.5-pro",
			label: "Gemini 2.5 Pro (Windsurf)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "deepseek-r1",
			label: "DeepSeek R1 (Windsurf)",
			tier: "standard",
			supportsThinking: true,
		},
		{
			value: "deepseek-v3",
			label: "DeepSeek V3 (Windsurf)",
			tier: "standard",
		},
		{
			value: "gemini-2.0-flash",
			label: "Gemini 2.0 Flash (Windsurf)",
			tier: "fast",
		},
		{ value: "swe-1.5-fast", label: "SWE-1.5 Fast", tier: "fast" },
	],
};

// Alias for legacy providers listed in provider_api.py
PROVIDER_MODELS_MAP.claude = PROVIDER_MODELS_MAP.anthropic;

/** Returns models for the currently selected provider, falling back to anthropic */
export function getModelsForProvider(provider: string): ProviderModel[] {
	return PROVIDER_MODELS_MAP[provider] ?? PROVIDER_MODELS_MAP.anthropic;
}

/** Returns the default (flagship) model ID for a given provider */
export function getDefaultModelForProvider(provider: string): string {
	const models = getModelsForProvider(provider);
	const flagship = models.find((m) => m.tier === "flagship") ?? models[0];
	return flagship?.value ?? "";
}

/**
 * Détecte un identifiant de modèle Claude au format natif Anthropic, c.-à-d.
 * versionné avec des tirets (ex. "claude-sonnet-4-5-20250929", "claude-opus-4-6").
 *
 * Ces IDs ne sont PAS valides pour les fournisseurs non-Anthropic (Copilot,
 * etc.). Copilot utilise la notation pointée (ex. "claude-opus-4.8",
 * "claude-sonnet-4.6") qui doit être préservée et NE DOIT PAS être interceptée.
 *
 * Le motif exige au moins deux groupes numériques séparés par un tiret après le
 * nom du modèle (`-\d+-\d`), ce qui distingue la forme Anthropic (tirets) de la
 * forme Copilot (point). Ce comportement reflète celui du backend
 * (`phase_config._resolve_provider_model`).
 *
 * Les modèles « Mythos-class » natifs Anthropic (`claude-fable-5`,
 * `claude-mythos-5`) n'ont qu'un seul groupe de version et sont détectés via un
 * second motif dédié (`-\d` au lieu de `-\d+-\d`).
 */
export function isAnthropicNativeVersionedModelId(model: string): boolean {
	return (
		/^claude-(opus|sonnet|haiku)-\d+-\d/.test(model) ||
		/^claude-(fable|mythos)-\d/.test(model)
	);
}

// ============================================
// Fenêtres de contexte des modèles (tokens)
// ============================================

/**
 * Fenêtre de contexte par défaut quand le modèle est inconnu.
 * 128k est la valeur la plus courante (GPT-4o, GPT-4.1 via Copilot, etc.).
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Fenêtres de contexte natives (approximatives) par préfixe d'identifiant de
 * modèle. La recherche se fait par sous-chaîne (premier préfixe correspondant),
 * ce qui couvre les variantes datées/suffixées (ex. "claude-sonnet-4-5-2025...").
 *
 * Sert à calculer le « % de fenêtre de contexte consommée » façon Claude Code.
 * Les valeurs sont indicatives : à ajuster si GitHub/les fournisseurs évoluent.
 */
export const CONTEXT_WINDOW_BY_MODEL_PREFIX: ReadonlyArray<
	readonly [prefix: string, contextWindow: number]
> = [
	// Anthropic / Claude (natif 200k)
	["claude-opus", 200_000],
	["claude-sonnet", 200_000],
	["claude-haiku", 200_000],
	["claude-3.7", 200_000],
	["claude-3-7", 200_000],
	["claude", 200_000],
	// OpenAI GPT-5.x (256k)
	["gpt-5", 256_000],
	// OpenAI GPT-4.1 (1M natif)
	["gpt-4.1", 1_000_000],
	["gpt-4-1", 1_000_000],
	// OpenAI GPT-4o / 4-turbo (128k)
	["gpt-4o", 128_000],
	["gpt-4", 128_000],
	// OpenAI raisonnement o-series (200k)
	["o4", 200_000],
	["o3", 200_000],
	["o1", 200_000],
	// Google Gemini 2.5 (1M)
	["gemini", 1_000_000],
];

/**
 * Retourne la fenêtre de contexte (en tokens) pour un modèle donné.
 *
 * @param model Identifiant du modèle (ex. "gpt-4o", "claude-sonnet-4.6").
 * @returns Taille de la fenêtre de contexte, ou {@link DEFAULT_CONTEXT_WINDOW}.
 */
export function getContextWindowForModel(model: string | undefined): number {
	if (!model) return DEFAULT_CONTEXT_WINDOW;
	const normalized = model.toLowerCase().trim();
	for (const [prefix, window] of CONTEXT_WINDOW_BY_MODEL_PREFIX) {
		if (normalized.includes(prefix)) return window;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

/** Returns whether the selected provider supports extended thinking */
export function providerSupportsThinking(provider: string): boolean {
	return [
		"anthropic",
		"openai",
		"google",
		"deepseek",
		"mistral",
		"ollama",
		"copilot",
		"custom",
		"grok",
		"windsurf",
	].includes(provider);
}

// ============================================
// Available Models (legacy – Claude only, kept for backward compatibility)
// ============================================

export const AVAILABLE_MODELS = [
	{ value: "opus-4-8", label: "Claude Opus 4.8" },
	{ value: "opus-4-7", label: "Claude Opus 4.7" },
	{ value: "opus", label: "Claude Opus 4.6" },
	{ value: "sonnet", label: "Claude Sonnet 4.6" },
	{ value: "haiku", label: "Claude Haiku 4.6" },
	{ value: "opus-4-5", label: "Claude Opus 4.5" },
	{ value: "sonnet-4-5", label: "Claude Sonnet 4.5" },
	{ value: "haiku-4-5", label: "Claude Haiku 4.5" },
] as const;

// Maps model shorthand to actual Claude model IDs.
// Short aliases (opus/sonnet/haiku) intentionally still point to 4.6 so
// existing tasks persisted with these values keep working. Newer versions
// are exposed under explicit version-suffixed keys (e.g. "opus-4-7").
export const MODEL_ID_MAP: Record<string, string> = {
	"opus-4-8": "claude-opus-4-8",
	"opus-4-7": "claude-opus-4-7",
	opus: "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-6",
	"opus-4-5": "claude-opus-4-5",
	"sonnet-4-5": "claude-sonnet-4-5",
	"haiku-4-5": "claude-haiku-4-5",
} as const;

// ============================================
// Déduplication des modèles par identité canonique
// ============================================

/**
 * Réduit un identifiant de modèle à une **clé d'identité canonique** qui
 * regroupe toutes les écritures d'une même version pour un même provider :
 *
 *  - alias court (`opus`, `sonnet`, `opus-4-8`) → id complet via {@link MODEL_ID_MAP}
 *  - notation pointée Copilot (`claude-opus-4.6`) et tirets Anthropic
 *    (`claude-opus-4-6`) → forme unifiée à tirets
 *  - snapshot daté (`claude-opus-4-5-20251101`) → version sans la date
 *  - préfixe Gemini `models/` retiré
 *
 * Sert de clé de regroupement pour {@link dedupeModelCatalog} et
 * {@link resolveCatalogModelValue}. Ne PAS l'envoyer à une API : c'est une clé
 * interne, pas un id de modèle valide.
 */
export function getCanonicalModelKey(value: string): string {
	if (!value) return value;
	// 1. Alias court → id complet (ex. "opus" → "claude-opus-4-6").
	let id = MODEL_ID_MAP[value] ?? value;
	id = id.toLowerCase().trim();
	// 2. Préfixe Gemini live ("models/gemini-3.1-pro").
	if (id.startsWith("models/")) id = id.slice("models/".length);
	// 3. Unifier séparateurs de version pointés (Copilot) et tirets (Anthropic).
	id = id.replace(/\./g, "-");
	// 4. Retirer un snapshot daté final "-YYYYMMDD" (8 chiffres).
	id = id.replace(/-\d{8}$/, "");
	return id;
}

/** Vrai si `value` est un alias court (clé de {@link MODEL_ID_MAP}). */
function isShortAlias(value: string): boolean {
	return Object.hasOwn(MODEL_ID_MAP, value);
}

/** Vrai si `value` se termine par un snapshot daté "-YYYYMMDD". */
function isDatedSnapshot(value: string): boolean {
	return /-\d{8}$/.test(value);
}

/**
 * Score de préférence pour choisir l'entrée unique à garder lorsqu'une même
 * version est représentée plusieurs fois. Préférence :
 * id explicite non-daté (2) > snapshot daté (1) > alias court (0).
 */
function representativeScore(value: string): number {
	if (isShortAlias(value)) return 0;
	if (isDatedSnapshot(value)) return 1;
	return 2;
}

/**
 * Déduplique un catalogue de modèles par {@link getCanonicalModelKey}, en ne
 * gardant qu'**une seule entrée par version** (la mieux notée :
 * id explicite versionné de préférence). L'ordre des versions rencontrées est
 * préservé (donc la priorité live > statique du hook est respectée).
 */
export function dedupeModelCatalog<T extends { value: string }>(
	models: readonly T[],
): T[] {
	const best = new Map<string, T>();
	const order: string[] = [];
	for (const m of models) {
		if (!m.value) continue;
		const key = getCanonicalModelKey(m.value);
		const existing = best.get(key);
		if (!existing) {
			best.set(key, m);
			order.push(key);
		} else if (
			representativeScore(m.value) > representativeScore(existing.value)
		) {
			best.set(key, m);
		}
	}
	return order.map((k) => best.get(k) as T);
}

/**
 * Mappe une valeur de modèle persistée (potentiellement un alias court ou un
 * snapshot daté désormais masqué) vers la valeur réellement présente dans le
 * catalogue dédupliqué `models`, en comparant par identité canonique.
 *
 * Garantit qu'un `<Select>` affiche l'entrée correcte même si la valeur stockée
 * n'est plus exposée telle quelle. Renvoie `value` inchangée si aucune
 * correspondance (ex. valeur d'un autre provider).
 */
export function resolveCatalogModelValue(
	value: string,
	models: readonly { value: string }[],
): string {
	if (!value) return value;
	const key = getCanonicalModelKey(value);
	const match = models.find((m) => getCanonicalModelKey(m.value) === key);
	return match ? match.value : value;
}

// Maps thinking levels to budget tokens (null = no extended thinking)
export const THINKING_BUDGET_MAP: Record<string, number | null> = {
	none: null,
	low: 1024,
	medium: 4096,
	high: 16384,
	ultrathink: 63999, // Maximum reasoning depth (API requires max_tokens >= budget + 1, so 63999 + 1 = 64000 limit)
} as const;

// ============================================
// Thinking Levels
// ============================================

// Thinking levels for Claude model (budget token allocation)
export const THINKING_LEVELS = [
	{ value: "none", label: "None", description: "No extended thinking" },
	{ value: "low", label: "Low", description: "Brief consideration" },
	{ value: "medium", label: "Medium", description: "Moderate analysis" },
	{ value: "high", label: "High", description: "Deep thinking" },
	{
		value: "ultrathink",
		label: "Ultra Think",
		description: "Maximum reasoning depth",
	},
] as const;

// ============================================
// Agent Profiles - Phase Configurations
// ============================================

// Phase configurations for each preset profile
// Each profile has its own default phase models and thinking levels

// Auto (Optimized) - Opus with optimized thinking per phase
export const AUTO_PHASE_MODELS: PhaseModelConfig = {
	spec: "opus",
	planning: "opus",
	coding: "opus",
	qa: "opus",
};

export const AUTO_PHASE_THINKING: import("../types/settings").PhaseThinkingConfig =
	{
		spec: "ultrathink", // Deep thinking for comprehensive spec creation
		planning: "high", // High thinking for planning complex features
		coding: "low", // Faster coding iterations
		qa: "low", // Efficient QA review
	};

// Complex Tasks - Opus with ultrathink across all phases
export const COMPLEX_PHASE_MODELS: PhaseModelConfig = {
	spec: "opus",
	planning: "opus",
	coding: "opus",
	qa: "opus",
};

export const COMPLEX_PHASE_THINKING: import("../types/settings").PhaseThinkingConfig =
	{
		spec: "ultrathink",
		planning: "ultrathink",
		coding: "ultrathink",
		qa: "ultrathink",
	};

// Balanced - Sonnet with medium thinking across all phases
export const BALANCED_PHASE_MODELS: PhaseModelConfig = {
	spec: "sonnet",
	planning: "sonnet",
	coding: "sonnet",
	qa: "sonnet",
};

export const BALANCED_PHASE_THINKING: import("../types/settings").PhaseThinkingConfig =
	{
		spec: "medium",
		planning: "medium",
		coding: "medium",
		qa: "medium",
	};

// Quick Edits - Haiku with low thinking across all phases
export const QUICK_PHASE_MODELS: PhaseModelConfig = {
	spec: "haiku",
	planning: "haiku",
	coding: "haiku",
	qa: "haiku",
};

export const QUICK_PHASE_THINKING: import("../types/settings").PhaseThinkingConfig =
	{
		spec: "low",
		planning: "low",
		coding: "low",
		qa: "low",
	};

// Default phase configuration (used for fallback, matches 'Balanced' profile for cost-effectiveness)
export const DEFAULT_PHASE_MODELS: PhaseModelConfig = BALANCED_PHASE_MODELS;
export const DEFAULT_PHASE_THINKING: import("../types/settings").PhaseThinkingConfig =
	BALANCED_PHASE_THINKING;

// ============================================
// Feature Settings (Non-Pipeline Features)
// ============================================

// Default feature model configuration (for insights, ideation, roadmap, github, utility).
// Values must match the `value` field of entries in PROVIDER_MODELS_MAP['anthropic'].
export const DEFAULT_FEATURE_MODELS: FeatureModelConfig = {
	insights: "claude-sonnet-4-6", // Fast, responsive chat with latest model
	ideation: "claude-opus-4-6", // Creative ideation benefits from Opus
	roadmap: "claude-opus-4-6", // Strategic planning benefits from Opus
	"natural-language-git": "claude-sonnet-4-6", // Natural language Git commands
	githubIssues: "claude-opus-4-6", // Issue triage and analysis benefits from Opus
	githubPrs: "claude-opus-4-6", // PR review benefits from thorough Opus analysis
	utility: "claude-haiku-4-6", // Fast utility operations (commit messages, merge resolution)
	promptOptimizer: "claude-sonnet-4-6", // Balanced prompt optimization
	testGenerator: "claude-sonnet-4-6", // Balanced test generation for comprehensive coverage
	codeReview: "claude-opus-4-6", // Code review benefits from thorough Opus analysis
	voiceControl: "claude-haiku-4-6", // Fast voice control operations
};

// Default feature thinking configuration
export const DEFAULT_FEATURE_THINKING: FeatureThinkingConfig = {
	insights: "medium", // Balanced thinking for chat
	ideation: "high", // Deep thinking for creative ideas
	roadmap: "high", // Strategic thinking for roadmap
	"natural-language-git": "medium", // Natural language Git commands
	githubIssues: "medium", // Moderate thinking for issue analysis
	githubPrs: "medium", // Moderate thinking for PR review
	utility: "low", // Fast thinking for utility operations
	promptOptimizer: "medium", // Balanced thinking for prompt optimization
	testGenerator: "medium", // Balanced thinking for test generation
	codeReview: "medium", // Balanced thinking for code review
	voiceControl: "low", // Fast thinking for voice control
};

// Feature labels for UI display
export const FEATURE_LABELS: Record<
	keyof FeatureModelConfig,
	{ label: string; description: string }
> = {
	insights: {
		label: "Insights Chat",
		description: "Ask questions about your codebase",
	},
	ideation: {
		label: "Ideation",
		description: "Generate feature ideas and improvements",
	},
	roadmap: {
		label: "Roadmap",
		description: "Create strategic feature roadmaps",
	},
	"natural-language-git": {
		label: "Natural Language Git",
		description: "Execute Git commands using natural language",
	},
	githubIssues: {
		label: "GitHub Issues",
		description: "Automated issue triage and labeling",
	},
	githubPrs: {
		label: "GitHub PR Review",
		description: "AI-powered pull request reviews",
	},
	utility: {
		label: "Utility",
		description: "Commit messages and merge conflict resolution",
	},
	promptOptimizer: {
		label: "Prompt Optimizer",
		description: "AI-powered prompt enhancement with project context",
	},
	testGenerator: {
		label: "Test Generation Agent",
		description: "AI-powered test generation and coverage analysis",
	},
	codeReview: {
		label: "Code Review Agent",
		description: "AI-powered code review and quality analysis",
	},
	voiceControl: {
		label: "Voice Control",
		description: "Voice-activated development commands",
	},
};

// Default agent profiles for preset model/thinking configurations
// All profiles have per-phase configuration for full customization
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
	{
		id: "auto",
		name: "Auto (Optimized)",
		description: "Uses Opus across all phases with optimized thinking levels",
		model: "opus",
		thinkingLevel: "high",
		icon: "Sparkles",
		phaseModels: AUTO_PHASE_MODELS,
		phaseThinking: AUTO_PHASE_THINKING,
	},
	{
		id: "complex",
		name: "Complex Tasks",
		description:
			"For intricate, multi-step implementations requiring deep analysis",
		model: "opus",
		thinkingLevel: "ultrathink",
		icon: "Brain",
		phaseModels: COMPLEX_PHASE_MODELS,
		phaseThinking: COMPLEX_PHASE_THINKING,
	},
	{
		id: "balanced",
		name: "Balanced",
		description: "Good balance of speed and quality for most tasks",
		model: "sonnet",
		thinkingLevel: "medium",
		icon: "Scale",
		phaseModels: BALANCED_PHASE_MODELS,
		phaseThinking: BALANCED_PHASE_THINKING,
	},
	{
		id: "quick",
		name: "Quick Edits",
		description: "Fast iterations for simple changes and quick fixes",
		model: "haiku",
		thinkingLevel: "low",
		icon: "Zap",
		phaseModels: QUICK_PHASE_MODELS,
		phaseThinking: QUICK_PHASE_THINKING,
	},
];

// ============================================
// Memory Backends
// ============================================

export const MEMORY_BACKENDS = [
	{ value: "file", label: "File-based (default)" },
	{ value: "graphiti", label: "Graphiti (LadybugDB)" },
] as const;
