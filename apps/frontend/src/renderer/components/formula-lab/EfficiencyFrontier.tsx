import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Formula } from "../../stores/formula-matrix-store";
import { formulaKey } from "../../stores/formula-matrix-store";
import {
	effortLabel,
	formatCost,
	providerColor,
	shortModel,
	totalTokens,
} from "./formula-utils";

export interface EfficiencyFrontierProps {
	readonly formulas: Formula[];
	readonly selectedKey: string | null;
	readonly paretoKeys: Set<string>;
	readonly onSelect: (formula: Formula) => void;
}

const W = 640;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 36, left: 44 };

/**
 * EfficiencyFrontier — a hand-rolled SVG bubble chart (zero dependency).
 *
 *   x = expected cost · y = success probability · bubble size = total tokens
 *   colour = provider · Pareto-optimal formulas glow.
 *
 * The whole point: the user *sees* the cost/confidence trade-off and clicks
 * the bubble that matches their appetite.
 */
export function EfficiencyFrontier({
	formulas,
	selectedKey,
	paretoKeys,
	onSelect,
}: EfficiencyFrontierProps) {
	const { t } = useTranslation(["formulaLab"]);

	const { points, costTicks, successTicks } = useMemo(() => {
		const plotW = W - PAD.left - PAD.right;
		const plotH = H - PAD.top - PAD.bottom;

		const costs = formulas.map((f) => f.expected_cost_usd);
		const maxCost = Math.max(0.01, ...costs);
		const successes = formulas.map((f) => f.success_probability);
		const minS = Math.min(...successes, 0.5);
		const maxS = Math.max(...successes, 0.9);
		const sLo = Math.max(0, Math.floor(minS * 20) / 20 - 0.05);
		const sHi = Math.min(1, Math.ceil(maxS * 20) / 20 + 0.02);
		const sSpan = Math.max(0.1, sHi - sLo);

		const tokens = formulas.map(totalTokens);
		const maxTok = Math.max(1, ...tokens);

		// Square-root cost axis spreads the cheap cluster without losing the
		// expensive tail.
		const xOf = (cost: number) =>
			PAD.left + (Math.sqrt(cost) / Math.sqrt(maxCost)) * plotW;
		const yOf = (s: number) =>
			PAD.top + plotH - ((s - sLo) / sSpan) * plotH;
		const rOf = (tok: number) => 4 + (tok / maxTok) * 11;

		const pts = formulas.map((f) => ({
			f,
			key: formulaKey(f),
			x: xOf(f.expected_cost_usd),
			y: yOf(f.success_probability),
			r: rOf(totalTokens(f)),
		}));

		const cTicks = [0, 0.25, 0.5, 1].map((frac) => {
			const cost = maxCost * frac;
			return { x: xOf(cost), label: formatCost(cost) };
		});
		const sTicks: { y: number; label: string }[] = [];
		for (let s = Math.ceil(sLo * 10) / 10; s <= sHi; s += 0.1) {
			sTicks.push({ y: yOf(s), label: `${Math.round(s * 100)}%` });
		}

		return { points: pts, costTicks: cTicks, successTicks: sTicks };
	}, [formulas]);

	if (formulas.length === 0) return null;

	return (
		<div className="rounded-xl border bg-card/40 p-2">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="w-full"
				style={{ maxHeight: 320 }}
				role="img"
				aria-label={t("formulaLab:chart.aria")}
			>
				<title>{t("formulaLab:chart.aria")}</title>
				{/* gridlines + success (y) ticks */}
				{successTicks.map((tk) => (
					<g key={`y-${tk.label}`}>
						<line
							x1={PAD.left}
							y1={tk.y}
							x2={W - PAD.right}
							y2={tk.y}
							className="stroke-muted-foreground/10"
							strokeWidth={1}
						/>
						<text
							x={PAD.left - 6}
							y={tk.y + 3}
							textAnchor="end"
							className="fill-muted-foreground text-[9px]"
						>
							{tk.label}
						</text>
					</g>
				))}
				{/* cost (x) ticks */}
				{costTicks.map((tk) => (
					<text
						key={`x-${tk.label}`}
						x={tk.x}
						y={H - PAD.bottom + 14}
						textAnchor="middle"
						className="fill-muted-foreground text-[9px]"
					>
						{tk.label}
					</text>
				))}
				{/* axis labels */}
				<text
					x={(W - PAD.right + PAD.left) / 2}
					y={H - 4}
					textAnchor="middle"
					className="fill-muted-foreground text-[10px] font-medium"
				>
					{t("formulaLab:chart.xAxis")} →
				</text>
				<text
					x={-((H - PAD.bottom + PAD.top) / 2)}
					y={12}
					textAnchor="middle"
					transform="rotate(-90)"
					className="fill-muted-foreground text-[10px] font-medium"
				>
					{t("formulaLab:chart.yAxis")} →
				</text>

				{/* bubbles — pareto last so they paint on top */}
				{points
					.slice()
					.sort(
						(a, b) =>
							Number(paretoKeys.has(a.key)) - Number(paretoKeys.has(b.key)),
					)
					.map((p) => {
						const isPareto = paretoKeys.has(p.key);
						const isSelected = p.key === selectedKey;
						const color = providerColor(p.f.provider);
						return (
							<circle
								key={p.key}
								cx={p.x}
								cy={p.y}
								r={isSelected ? p.r + 2 : p.r}
								fill={color}
								fillOpacity={isPareto ? 0.85 : 0.32}
								stroke={isSelected ? "currentColor" : color}
								strokeWidth={isSelected ? 2.5 : isPareto ? 1.5 : 0.5}
								className={`cursor-pointer transition-all ${
									isSelected ? "text-primary" : ""
								}`}
								style={
									isPareto
										? { filter: `drop-shadow(0 0 4px ${color})` }
										: undefined
								}
								onClick={() => onSelect(p.f)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										onSelect(p.f);
									}
								}}
							>
								<title>
									{`${p.f.provider} ${shortModel(p.f.model)} · ${effortLabel(
										p.f.effort,
									)}\n${formatCost(p.f.expected_cost_usd)} · ${Math.round(
										p.f.success_probability * 100,
									)}% success`}
								</title>
							</circle>
						);
					})}
			</svg>
		</div>
	);
}
