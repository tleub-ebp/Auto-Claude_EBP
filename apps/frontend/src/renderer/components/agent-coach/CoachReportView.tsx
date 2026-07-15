import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCurrency } from "../../hooks/useCurrency";
import { formatCurrency } from "../../lib/currency";
import {
	setupAgentCoachListeners,
	useAgentCoachStore,
} from "../../stores/agent-coach-store";
import type { CoachReport, TipPriority } from "../../../shared/types/agent-coach";

const PRIORITY_STYLES: Record<TipPriority, string> = {
	high: "text-red-400 bg-red-500/10 border-red-500/20",
	medium: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
	low: "text-blue-400 bg-blue-500/10 border-blue-500/20",
};

interface CoachReportViewProps {
	readonly projectPath?: string;
}

function StatCard({
	label,
	value,
	color,
}: {
	readonly label: string;
	readonly value: string;
	readonly color: string;
}): React.ReactElement {
	return (
		<div className="p-3 rounded-lg bg-(--bg-secondary) border border-(--border-color)">
			<p className="text-xs text-(--text-secondary)">{label}</p>
			<p className={`text-lg font-bold truncate ${color}`}>{value}</p>
		</div>
	);
}

function ReportBody({
	report,
	t,
	formatCost,
}: {
	readonly report: CoachReport;
	readonly t: (key: string, options?: Record<string, unknown>) => string;
	readonly formatCost: (usd: number, decimals: number) => string;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-4">
			<div>
				<p className="text-sm text-(--text-secondary)">
					{t("summary", {
						runs: report.totalRuns,
						successRate: (report.successRate * 100).toFixed(1),
						cost: formatCost(report.totalCostUsd, 2),
					})}
				</p>
			</div>

			<div className="grid grid-cols-4 gap-3">
				<StatCard
					label={t("stats.runs")}
					value={String(report.totalRuns)}
					color="text-blue-400"
				/>
				<StatCard
					label={t("stats.successRate")}
					value={`${(report.successRate * 100).toFixed(0)}%`}
					color={
						report.successRate >= 0.8 ? "text-green-400" : "text-yellow-400"
					}
				/>
				<StatCard
					label={t("stats.avgCost")}
					value={formatCost(report.avgCostUsd, 4)}
					color="text-purple-400"
				/>
				<StatCard
					label={t("stats.mostFailing")}
					value={report.mostFailingAgent || t("stats.none")}
					color="text-red-400"
				/>
			</div>

			<div className="space-y-2">
				{report.tips.map((tip) => (
					<div
						key={`${tip.category}-${tip.priority}-${tip.title}`}
						className={`px-4 py-3 rounded-lg border ${PRIORITY_STYLES[tip.priority]}`}
					>
						<div className="flex items-center gap-2 mb-1">
							<span className="text-xs font-medium uppercase">
								{tip.priority}
							</span>
							<span className="text-xs opacity-70">
								{tip.category.replaceAll("_", " ")}
							</span>
						</div>
						<p className="text-sm font-medium">{tip.title}</p>
						<p className="text-xs mt-1 opacity-80">{tip.description}</p>
						{tip.evidence && (
							<p className="text-xs mt-1 opacity-60 italic">
								{t("evidence")} {tip.evidence}
							</p>
						)}
						{tip.action && (
							<p className="text-xs mt-1 text-green-400">→ {tip.action}</p>
						)}
					</div>
				))}
			</div>

			<p className="text-sm text-(--text-secondary) italic mt-2">
				{t("summaryDetail", {
					tips: report.tips.length,
					runs: report.totalRuns,
					successRate: (report.successRate * 100).toFixed(0),
					cost: formatCost(report.totalCostUsd, 2),
				})}
			</p>
		</div>
	);
}

export function CoachReportView({
	projectPath,
}: CoachReportViewProps): React.ReactElement {
	const { t, i18n } = useTranslation("agentCoach");
	const { rate } = useCurrency();

	const formatCost = (usd: number, decimals: number): string =>
		formatCurrency(usd, i18n.language, rate, decimals);

	useEffect(() => {
		const cleanup = setupAgentCoachListeners();
		return cleanup;
	}, []);

	const phase = useAgentCoachStore((s) => s.phase);
	const status = useAgentCoachStore((s) => s.status);
	const report = useAgentCoachStore((s) => s.report);
	const error = useAgentCoachStore((s) => s.error);
	const startScan = useAgentCoachStore((s) => s.startScan);
	const cancelScan = useAgentCoachStore((s) => s.cancelScan);
	const reset = useAgentCoachStore((s) => s.reset);

	const handleRun = (): void => {
		if (!projectPath) return;
		void startScan(projectPath);
	};

	const isScanning = phase === "scanning";

	return (
		<div className="flex flex-col gap-4 p-6 bg-(--bg-primary) text-(--text-primary)">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold">{t("title")}</h2>
				<div className="flex gap-2">
					{!isScanning && (
						<button
							type="button"
							onClick={handleRun}
							disabled={!projectPath}
							className="px-3 py-1.5 rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
						>
							{t("actions.runScan")}
						</button>
					)}
					{isScanning && (
						<button
							type="button"
							onClick={() => void cancelScan()}
							className="px-3 py-1.5 rounded-md bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
						>
							{t("actions.cancel")}
						</button>
					)}
					{phase === "complete" && (
						<button
							type="button"
							onClick={reset}
							className="px-3 py-1.5 rounded-md border border-(--border-color) hover:bg-(--bg-secondary) text-sm font-medium transition-colors"
						>
							{t("actions.reset")}
						</button>
					)}
				</div>
			</div>

			{!projectPath && (
				<p className="text-sm text-(--text-secondary)">
					{t("errors.noProject")}
				</p>
			)}

			{isScanning && (
				<p className="text-sm text-(--text-secondary)">
					{status || t("actions.scanning")}
				</p>
			)}

			{phase === "error" && error && (
				<p className="text-sm text-red-400">{t("errors.failed", { error })}</p>
			)}

			{phase === "complete" && report?.totalRuns === 0 && (
				<p className="text-sm text-(--text-secondary)">{t("noData")}</p>
			)}

			{phase === "complete" && report && report.totalRuns > 0 && (
				<ReportBody report={report} t={t} formatCost={formatCost} />
			)}
		</div>
	);
}
