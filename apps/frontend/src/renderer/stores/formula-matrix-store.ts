import { create } from "zustand";
import type {
	Formula,
	FormulaMatrix,
	RefinedFormula,
} from "../../preload/api/modules/formula-matrix-api";
import type {
	AppliedFormula,
	TaskMetadata,
	ThinkingLevel,
} from "../../shared/types/task";
import { persistUpdateTask } from "./task-store";

export type { Formula, FormulaMatrix } from "../../preload/api/modules/formula-matrix-api";

/** Stable identity for a formula (Provider × LLM × Effort). */
export function formulaKey(f: Pick<Formula, "provider" | "model" | "effort">): string {
	return `${f.provider}::${f.model}::${f.effort}`;
}

/**
 * "Value" score (success per dollar), mirroring the backend default. Free /
 * flat-rate models are scored on success alone (scaled) so they stay
 * competitive without dominating purely by being free.
 */
function _defaultValueScore(success: number, cost: number): number {
	if (cost <= 1e-4) return Math.round(success * 8 * 1e4) / 1e4;
	return Math.round((success / cost) * 1e4) / 1e4;
}

/**
 * Adjusted score used to re-rank formulas live as the user drags the
 * Cost ↔ Confidence slider. ``weight`` ∈ [0,1]: 0 = cost-first (cheapest wins),
 * 1 = confidence-first (highest success wins). Cost is min-max normalised
 * across the candidate set so the two axes are comparable.
 */
export function computeAdjustedScore(
	formula: Formula,
	weight: number,
	minCost: number,
	maxCost: number,
): number {
	const span = maxCost - minCost;
	const costNorm = span <= 1e-9 ? 0 : (formula.expected_cost_usd - minCost) / span;
	const cheapScore = 1 - costNorm; // 1 = cheapest
	return weight * formula.success_probability + (1 - weight) * cheapScore;
}

/** Return formulas sorted by adjusted score (best first) for a given weight. */
export function rankFormulas(formulas: Formula[], weight: number): Formula[] {
	if (formulas.length === 0) return [];
	const costs = formulas.map((f) => f.expected_cost_usd);
	const minCost = Math.min(...costs);
	const maxCost = Math.max(...costs);
	return [...formulas].sort(
		(a, b) =>
			computeAdjustedScore(b, weight, minCost, maxCost) -
			computeAdjustedScore(a, weight, minCost, maxCost),
	);
}

export interface SmartPicks {
	bestValue: Formula | null;
	safest: Formula | null;
	cheapest: Formula | null;
	fastest: Formula | null;
}

function totalTokens(f: Formula): number {
	return (
		f.expected_input_tokens +
		f.expected_output_tokens +
		f.expected_thinking_tokens
	);
}

/** The four headline "smart picks" surfaced above the comparison table. */
export function pickSmart(formulas: Formula[]): SmartPicks {
	if (formulas.length === 0) {
		return { bestValue: null, safest: null, cheapest: null, fastest: null };
	}
	const bestValue = formulas.reduce((a, b) =>
		b.value_score > a.value_score ? b : a,
	);
	const safest = formulas.reduce((a, b) => {
		if (b.success_probability !== a.success_probability) {
			return b.success_probability > a.success_probability ? b : a;
		}
		return b.expected_cost_usd < a.expected_cost_usd ? b : a;
	});
	const cheapest = formulas.reduce((a, b) => {
		if (b.expected_cost_usd !== a.expected_cost_usd) {
			return b.expected_cost_usd < a.expected_cost_usd ? b : a;
		}
		return b.success_probability > a.success_probability ? b : a;
	});
	const fastest = formulas.reduce((a, b) => {
		const ta = totalTokens(a);
		const tb = totalTokens(b);
		if (tb !== ta) return tb < ta ? b : a;
		return b.success_probability > a.success_probability ? b : a;
	});
	return { bestValue, safest, cheapest, fastest };
}

/**
 * Pareto-optimal formulas: those not dominated by any other on both axes
 * (a formula dominates another if it is at least as cheap AND at least as
 * likely to succeed, and strictly better on one). These get the "glow" in
 * the efficiency-frontier chart.
 */
export function paretoFront(formulas: Formula[]): Set<string> {
	const front = new Set<string>();
	for (const f of formulas) {
		const dominated = formulas.some(
			(o) =>
				o !== f &&
				o.expected_cost_usd <= f.expected_cost_usd &&
				o.success_probability >= f.success_probability &&
				(o.expected_cost_usd < f.expected_cost_usd ||
					o.success_probability > f.success_probability),
		);
		if (!dominated) front.add(formulaKey(f));
	}
	return front;
}

interface OpenLabArgs {
	ticketId: string;
	ticketTitle: string;
	description?: string;
	projectPath?: string;
	specDir?: string;
	/** Restrict to configured providers; omit for the full catalog. */
	providers?: string[];
	/** Currently-applied formula key, to pre-select it in the table. */
	appliedKey?: string;
}

interface FormulaMatrixState {
	isOpen: boolean;
	ticketId: string | null;
	ticketTitle: string;
	openArgs: OpenLabArgs | null;
	matrix: FormulaMatrix | null;
	loading: boolean;
	error: string | null;
	/** Cost ↔ Confidence preference, 0-1. Persisted across opens. */
	weight: number;
	selectedKey: string | null;
	applying: boolean;
	/** AI refine pass in flight. */
	refining: boolean;
	/** Error from the last refine attempt, if any. */
	refineError: string | null;

	openLab: (args: OpenLabArgs) => void;
	closeLab: () => void;
	setWeight: (weight: number) => void;
	setSelectedKey: (key: string | null) => void;
	fetchMatrix: () => Promise<void>;
	applyFormula: (formula: Formula) => Promise<boolean>;
	/** Run the hybrid AI pass on the current top-N ranked formulas. */
	refineTopFormulas: (topN?: number) => Promise<void>;
}

/** Build the metadata patch that applies a formula uniformly across phases. */
export function buildAppliedFormulaMetadata(
	formula: Formula,
): Partial<TaskMetadata> {
	const { provider, model, effort } = formula;
	const applied: AppliedFormula = {
		provider,
		model,
		effort,
		expectedCostUsd: formula.expected_cost_usd,
		successProbability: formula.success_probability,
		perTokenBilled: formula.per_token_billed,
		appliedAt: new Date().toISOString(),
	};
	const level = effort as ThinkingLevel;
	return {
		isAutoProfile: true,
		provider,
		model,
		thinkingLevel: level,
		phaseProviders: {
			spec: provider,
			planning: provider,
			coding: provider,
			qa: provider,
		},
		phaseModels: { spec: model, planning: model, coding: model, qa: model },
		phaseThinking: { spec: level, planning: level, coding: level, qa: level },
		appliedFormula: applied,
	};
}

export const useFormulaMatrixStore = create<FormulaMatrixState>((set, get) => ({
	isOpen: false,
	ticketId: null,
	ticketTitle: "",
	openArgs: null,
	matrix: null,
	loading: false,
	error: null,
	weight: 0.5,
	selectedKey: null,
	applying: false,
	refining: false,
	refineError: null,

	openLab: (args) => {
		set({
			isOpen: true,
			ticketId: args.ticketId,
			ticketTitle: args.ticketTitle,
			openArgs: args,
			matrix: null,
			error: null,
			selectedKey: args.appliedKey ?? null,
		});
		void get().fetchMatrix();
	},

	closeLab: () =>
		set({
			isOpen: false,
			ticketId: null,
			openArgs: null,
			matrix: null,
			error: null,
			selectedKey: null,
			refining: false,
			refineError: null,
		}),

	setWeight: (weight) => set({ weight: Math.max(0, Math.min(1, weight)) }),

	setSelectedKey: (selectedKey) => set({ selectedKey }),

	fetchMatrix: async () => {
		const args = get().openArgs;
		if (!args) return;
		set({ loading: true, error: null });
		try {
			const { matrix } = await globalThis.electronAPI.runFormulaMatrix({
				ticketId: args.ticketId,
				description: args.description,
				projectPath: args.projectPath,
				specDir: args.specDir,
				providers: args.providers,
			});
			set({ matrix, loading: false });
		} catch (err) {
			set({
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	applyFormula: async (formula) => {
		const ticketId = get().ticketId;
		if (!ticketId) return false;
		set({ applying: true });
		try {
			const ok = await persistUpdateTask(ticketId, {
				metadata: buildAppliedFormulaMetadata(formula),
			});
			if (ok) set({ selectedKey: formulaKey(formula) });
			return ok;
		} finally {
			set({ applying: false });
		}
	},

	refineTopFormulas: async (topN = 3) => {
		const { matrix, weight, openArgs } = get();
		if (!matrix || matrix.formulas.length === 0) return;

		// Refine the user's current top-N (respecting the live preference).
		const top = rankFormulas(matrix.formulas, weight).slice(0, topN);
		const candidates = top.map((f) => ({
			key: formulaKey(f),
			provider: f.provider,
			model: f.model,
			effort: f.effort,
			tier: f.tier,
			base_probability: f.success_probability,
		}));

		set({ refining: true, refineError: null });
		try {
			const { refined } = (await globalThis.electronAPI.refineFormulas({
				description: openArgs?.description,
				candidates,
			})) as { refined: RefinedFormula[] };
			if (refined.length === 0) {
				set({ refineError: "no_assessment" });
				return;
			}
			const byKey = new Map(refined.map((r) => [r.key, r]));
			const merged = matrix.formulas.map((f) => {
				const r = byKey.get(formulaKey(f));
				if (!r) return f;
				return {
					...f,
					success_probability: r.success_probability,
					value_score: _defaultValueScore(
						r.success_probability,
						f.expected_cost_usd,
					),
					ai_refined: true,
					refine_reason: r.reason,
				};
			});
			set({ matrix: { ...matrix, formulas: merged } });
		} catch (err) {
			set({
				refineError: err instanceof Error ? err.message : String(err),
			});
		} finally {
			set({ refining: false });
		}
	},
}));
