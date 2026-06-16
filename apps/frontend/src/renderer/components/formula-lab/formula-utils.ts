/** Shared formatting + colour helpers for the Formula Lab. */

import type { Formula } from "../../stores/formula-matrix-store";

/**
 * USD → EUR conversion rate. The pricing catalog is denominated in USD (that is
 * how every LLM provider bills), but the UI displays euros. Update this when the
 * real rate drifts materially, or wire it to a live FX feed if precision matters.
 */
export const USD_TO_EUR = 0.92;

/** Convert a USD amount to EUR using {@link USD_TO_EUR}. */
export function toEur(usd: number): number {
	return usd * USD_TO_EUR;
}

/** Format a USD cost as a EUR string (e.g. "€1.20", "€0", "~€0.0040"). */
export function formatCost(usd: number): string {
	const eur = toEur(usd);
	if (eur <= 0) return "€0";
	if (eur < 0.01) return `~€${eur.toFixed(4)}`;
	return `€${eur.toFixed(2)}`;
}

export function formatCostBand(f: Formula): string {
	if (f.expected_cost_usd <= 0) return "€0";
	return `${formatCost(f.low_cost_usd)}–${formatCost(f.high_cost_usd)}`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

export function totalTokens(f: Formula): number {
	return (
		f.expected_input_tokens +
		f.expected_output_tokens +
		f.expected_thinking_tokens
	);
}

/** Stable, distinct-ish colour per provider for the scatter chart + chips. */
const PROVIDER_COLORS: Record<string, string> = {
	anthropic: "#d97757",
	openai: "#10a37f",
	google: "#4285f4",
	xai: "#1d9bf0",
	grok: "#1d9bf0",
	mistral: "#ff7000",
	deepseek: "#7c3aed",
	groq: "#f55036",
	together: "#0f766e",
	fireworks: "#eab308",
	meta: "#0064e0",
	aws: "#ff9900",
	copilot: "#6e40c9",
	windsurf: "#09b6a2",
	cursor: "#64748b",
	ollama: "#94a3b8",
};

export function providerColor(provider: string): string {
	return PROVIDER_COLORS[provider.toLowerCase()] ?? "#8b5cf6";
}

export const EFFORT_ORDER = ["none", "low", "medium", "high", "ultrathink"] as const;

export function effortLabel(effort: string): string {
	switch (effort) {
		case "none":
			return "None";
		case "low":
			return "Low";
		case "medium":
			return "Med";
		case "high":
			return "High";
		case "ultrathink":
			return "Ultra";
		default:
			return effort;
	}
}

/** Short model label: strip a redundant vendor prefix for compact chips. */
export function shortModel(model: string): string {
	return model
		.replace(/^anthropic\./, "")
		.replace(/^meta\./, "")
		.replace(/^claude-/, "")
		.replace(/-\d{8}$/, "");
}

export function tierLabel(tier: string): string {
	switch (tier) {
		case "flagship":
			return "Flagship";
		case "mid":
			return "Mid";
		case "small":
			return "Small";
		case "local":
			return "Local";
		default:
			return tier;
	}
}
