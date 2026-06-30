/**
 * Heuristic agentic-suitability assessment for Hugging Face models.
 *
 * HF repos in the "Discover models" list are NOT installed, so we can't ask
 * Ollama `/api/show` for capabilities — we infer from the repo name + pipeline
 * tag. Deliberately conservative and honest: "uncertain" means "check the model
 * card", not "bad".
 */

import type { HuggingFaceModelInfo } from "../types/mcp-marketplace";

export type HfVerdict = "good" | "ok" | "uncertain" | "unsuitable";

/** Min parameters (billions) we consider safe for the PLANNING phase. Set so a
 * 27B/32B model counts as "Recommandé" while 7–14B stays "trop petit". */
export const PLANNING_MIN_PARAM_B = 24;

// Model families known to support native tool/function calling.
const TOOL_FAMILY_RE =
	/llama-?3\.[123]|llama-?4|qwen-?2\.5|qwen-?3|qwq|mistral-?(?:nemo|small|large)|mixtral|command-?r|firefunction|hermes|nemotron|granite-?3|devstral|magistral/i;
// Fine-tune name hints that the repo is instruction / tool tuned.
const AGENTIC_KEYWORD_RE =
	/agentic|tool[-_ ]?call|function[-_ ]?call|instruct|composer|coder|chat/i;
const EMBED_RE = /embed|minilm|arctic-embed|jina-embed|nomic-embed|mxbai|bge-|e5-/i;

/** Parse a parameter count in billions from a repo name (e.g. "…-35B-GGUF" → 35).
 * A version like "1.0" or a "GB" file size must NOT be read as a size.
 *
 * For Mixture-of-Experts repos written "<total>B-A<active>B", the ACTIVE params
 * drive real capability (a 30B-A3B behaves like a small ~3B model), so we read
 * the active count — otherwise a tiny-but-MoE model looks "big" and recommended.
 */
export function parseParamBillions(name: string): number | null {
	const active = name.match(/[-_ ]a(\d+(?:\.\d+)?)\s*b\b/i);
	if (active) return Number.parseFloat(active[1]);
	const match = name.match(/(\d+(?:\.\d+)?)\s*b\b/i);
	return match ? Number.parseFloat(match[1]) : null;
}

/** Rough on-disk size in GB for a common 4-bit (Q4_K_M) GGUF quant, from the
 * parameter count. HF search has no size facet and a GGUF repo holds many quants,
 * so this is only an order-of-magnitude estimate. ~0.6 GB per billion params. */
export function estimateGbFromParams(paramB: number | null): number | null {
	if (paramB == null) return null;
	return Math.round(paramB * 0.6 * 10) / 10;
}

export function assessHfModel(m: HuggingFaceModelInfo): {
	verdict: HfVerdict;
	paramB: number | null;
	reason: string;
} {
	const name = m.id;
	const paramB = parseParamBillions(name);
	const tag = (m.pipelineTag ?? "").toLowerCase();
	if (tag.includes("feature-extraction") || EMBED_RE.test(name)) {
		return {
			verdict: "unsuitable",
			paramB,
			reason: "Modèle d'embedding — pas pour l'agentique.",
		};
	}
	if (paramB != null && paramB < 3) {
		return {
			verdict: "unsuitable",
			paramB,
			reason: `Trop petit (${paramB}B) pour piloter des outils.`,
		};
	}
	const agentic = TOOL_FAMILY_RE.test(name) || AGENTIC_KEYWORD_RE.test(name);
	if (agentic && paramB != null && paramB >= PLANNING_MIN_PARAM_B) {
		return {
			verdict: "good",
			paramB,
			reason: `Assez gros (${paramB} milliards de paramètres) et compatible tool-calling → utilisable pour TOUTES les étapes : planification, codage et validation.`,
		};
	}
	if (agentic) {
		return {
			verdict: "ok",
			paramB,
			reason:
				paramB != null
					? `Compatible tool-calling mais petit (${paramB}B) → ok pour le codage et la validation, mais DÉCONSEILLÉ pour la planification (trop petit pour produire un plan valide).`
					: "Réglage agentique détecté, mais taille inconnue — vérifiez la carte du modèle (nombre de paramètres).",
		};
	}
	return {
		verdict: "uncertain",
		paramB,
		reason:
			"Tool-calling non confirmé d'après le nom — ouvrez la carte du modèle et cherchez « tools » / « function calling » dans ses capacités.",
	};
}
