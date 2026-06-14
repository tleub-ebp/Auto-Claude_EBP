import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formulaKey, useFormulaMatrixStore } from "../../stores/formula-matrix-store";
import type { Task } from "../../../shared/types/task";
import { formatCost, effortLabel, shortModel } from "./formula-utils";
import { SuccessRing } from "./SuccessRing";

export interface FormulaBadgeProps {
	readonly task: Task;
	readonly projectPath?: string;
	readonly specDir?: string;
}

/**
 * Compact kanban-card affordance for the Formula Lab.
 *
 * When a formula has been applied it shows a success ring + model·effort + cost.
 * Otherwise it shows a discreet "estimate" call-to-action. Either way, clicking
 * opens the Formula Lab for this ticket.
 */
export function FormulaBadge({ task, projectPath, specDir }: FormulaBadgeProps) {
	const { t } = useTranslation(["formulaLab"]);
	const openLab = useFormulaMatrixStore((s) => s.openLab);
	const applied = task.metadata?.appliedFormula;

	const open = (e: React.MouseEvent) => {
		e.stopPropagation();
		openLab({
			ticketId: task.id,
			ticketTitle: task.title,
			description: task.description,
			projectPath,
			specDir,
			appliedKey: applied
				? formulaKey({
						provider: applied.provider,
						model: applied.model,
						effort: applied.effort,
					})
				: undefined,
		});
	};

	if (applied) {
		return (
			<button
				type="button"
				onClick={open}
				title={t("formulaLab:badge.appliedTooltip")}
				className="flex items-center gap-1 rounded-full border border-border bg-card/60 px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:border-primary/50 hover:bg-primary/5"
			>
				<SuccessRing
					value={applied.successProbability}
					size={16}
					stroke={2.5}
					showLabel={false}
				/>
				<span className="max-w-[90px] truncate">
					{shortModel(applied.model)}·{effortLabel(applied.effort)}
				</span>
				<span className="text-muted-foreground">
					{formatCost(applied.expectedCostUsd)}
				</span>
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={open}
			title={t("formulaLab:badge.estimateTooltip")}
			className="flex items-center gap-1 rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
		>
			<Sparkles className="h-3 w-3" />
			{t("formulaLab:badge.estimate")}
		</button>
	);
}
