/**
 * Tiny widget that turns a token count into a localized cost estimate
 * for the active provider/model.
 *
 * - USD ↔ EUR conversion uses the same `getEurRate` helper as `CostEstimator.tsx`.
 * - When the model is on a flat-rate plan (Cursor / Windsurf / Copilot / Ollama),
 *   we explicitly say so instead of pretending the cost is $0.00.
 * - When pricing is unknown for the (provider, model) pair we surface that
 *   as well — silent zeros are misleading.
 */

import { Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveModel } from "../../hooks/useActiveModel";
import { formatCurrency, getEurRate } from "../../lib/currency";
import {
	estimateUsdCost,
	getModelPricing,
	isPerTokenBilled,
} from "../../lib/model-pricing";

interface TokenCostEstimateProps {
	readonly totalTokens: number;
	/** 0–1 fraction of the budget assumed to come back as output. */
	readonly outputRatio?: number;
	/** Decimal places shown in the headline cost. Defaults to 4. */
	readonly decimals?: number;
}

export function TokenCostEstimate({
	totalTokens,
	outputRatio = 0.25,
	decimals = 4,
}: TokenCostEstimateProps) {
	const { t, i18n } = useTranslation("phase35");
	const { provider, model } = useActiveModel();
	const [eurRate, setEurRate] = useState(0.92);

	const isFr = i18n.language.startsWith("fr");

	useEffect(() => {
		if (!isFr) return;
		let cancelled = false;
		void getEurRate().then((r) => {
			if (!cancelled) setEurRate(r);
		});
		return () => {
			cancelled = true;
		};
	}, [isFr]);

	const pricing = useMemo(() => getModelPricing(provider, model), [provider, model]);
	const flatRate = useMemo(
		() => Boolean(pricing) && !isPerTokenBilled(provider, model),
		[pricing, provider, model],
	);

	if (!model) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				{t("cogContext.costNoModel")}
			</p>
		);
	}

	if (!pricing) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				<Info className="inline h-3 w-3 mr-1" aria-hidden />
				{t("cogContext.costUnknown")}
				<span className="ml-1 font-mono opacity-70">
					({provider}/{model})
				</span>
			</p>
		);
	}

	if (flatRate) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				<Info className="inline h-3 w-3 mr-1" aria-hidden />
				{t("cogContext.costFlatRate")}
				<span className="ml-1 font-mono opacity-70">
					({provider}/{pricing.model})
				</span>
			</p>
		);
	}

	const safeTokens = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
	const cost = estimateUsdCost(pricing, safeTokens, outputRatio);
	const formatted = formatCurrency(cost.total, i18n.language, eurRate, decimals);
	const inputFmt = formatCurrency(cost.input, i18n.language, eurRate, decimals);
	const outputFmt = formatCurrency(cost.output, i18n.language, eurRate, decimals);
	const ratioPct = Math.round(outputRatio * 100);

	const breakdown = t("cogContext.costBreakdown", {
		input: inputFmt,
		output: outputFmt,
		ratio: ratioPct,
	});
	const subtitle = t("cogContext.costFor", {
		provider,
		model: pricing.model,
	});

	return (
		<div className="mt-1 space-y-0.5 text-xs">
			<div className="flex items-baseline gap-2">
				<span className="font-medium">{t("cogContext.estimatedCost")}:</span>
				<span className="font-mono font-semibold">{formatted}</span>
			</div>
			<div className="text-muted-foreground" title={breakdown}>
				{subtitle}
			</div>
			<div className="text-muted-foreground/80 font-mono text-[10px]">
				{breakdown}
			</div>
		</div>
	);
}
