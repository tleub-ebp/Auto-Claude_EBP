import { Check, Download, HardDriveDownload, Loader2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Formula } from "../../stores/formula-matrix-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	effortLabel,
	formatCostBand,
	formatTokens,
	providerColor,
	shortModel,
	totalTokens,
} from "./formula-utils";
import { SuccessRing } from "./SuccessRing";

export interface FormulaCardProps {
	readonly formula: Formula;
	/** Headline tag, e.g. "🏆 Best value". */
	readonly pickLabel?: string;
	/** Accent colour for the headline tag. */
	readonly accent?: string;
	readonly selected?: boolean;
	readonly applied?: boolean;
	readonly applying?: boolean;
	readonly onSelect?: () => void;
	readonly onApply?: () => void;
}

/**
 * A single Provider × LLM × Effort formula, shown as a headline "smart pick"
 * card above the comparison table.
 */
export function FormulaCard({
	formula,
	pickLabel,
	accent,
	selected,
	applied,
	applying,
	onSelect,
	onApply,
}: FormulaCardProps) {
	const { t } = useTranslation(["formulaLab", "common"]);
	const color = providerColor(formula.provider);

	return (
		// A div (not a button) so the inner "Apply" Button isn't a nested button —
		// nested <button> is invalid HTML and triggers a hydration error.
		// biome-ignore lint/a11y/useSemanticElements: nested button constraint required
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect?.();
				}
			}}
			className={`group relative flex w-full cursor-pointer flex-col gap-2 rounded-xl border p-3 text-left transition-all hover:shadow-md ${
				selected
					? "border-primary ring-2 ring-primary/40"
					: "border-border hover:border-primary/40"
			}`}
		>
			{pickLabel && (
				<span
					className="absolute -top-2 left-3 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
					style={{ backgroundColor: accent ?? color }}
				>
					{pickLabel}
				</span>
			)}

			<div className="flex items-center justify-between gap-2 pt-1">
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<span
							className="h-2 w-2 shrink-0 rounded-full"
							style={{ backgroundColor: color }}
						/>
						<span className="truncate text-sm font-semibold">
							{shortModel(formula.model)}
						</span>
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[11px] capitalize text-muted-foreground">
						<span>
							{formula.provider} · {effortLabel(formula.effort)}
						</span>
						{formula.provider === "ollama" &&
							(formula.installed ? (
								<Badge
									variant="outline"
									className="gap-1 border-emerald-500/40 text-[9px] normal-case text-emerald-600 dark:text-emerald-400"
									title={t("formulaLab:local.installedTooltip")}
								>
									<HardDriveDownload className="h-2.5 w-2.5" />
									{t("formulaLab:local.installed")}
								</Badge>
							) : (
								<Badge
									variant="outline"
									className="gap-1 text-[9px] normal-case text-muted-foreground"
									title={t("formulaLab:local.notInstalledTooltip")}
								>
									<Download className="h-2.5 w-2.5" />
									{t("formulaLab:local.notInstalled")}
								</Badge>
							))}
					</div>
				</div>
				<SuccessRing value={formula.success_probability} size={42} />
			</div>

			<div className="flex items-end justify-between">
				<div>
					<div className="text-base font-semibold tabular-nums">
						{formatCostBand(formula)}
					</div>
					<div className="text-[11px] text-muted-foreground">
						{formatTokens(totalTokens(formula))} {t("formulaLab:tokens")}
					</div>
				</div>
				{!formula.per_token_billed && (
					<Badge variant="outline" className="gap-1 text-[10px]">
						<Zap className="h-3 w-3" />
						{t("formulaLab:flatRate")}
					</Badge>
				)}
			</div>

			{onApply && (
				<Button
					size="sm"
					variant={applied ? "secondary" : "default"}
					className="mt-1 w-full gap-1.5"
					disabled={applying || applied}
					onClick={(e) => {
						e.stopPropagation();
						onApply();
					}}
				>
					{applying ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : applied ? (
						<Check className="h-3.5 w-3.5" />
					) : null}
					{applied
						? t("formulaLab:applied")
						: t("formulaLab:apply")}
				</Button>
			)}
		</div>
	);
}
