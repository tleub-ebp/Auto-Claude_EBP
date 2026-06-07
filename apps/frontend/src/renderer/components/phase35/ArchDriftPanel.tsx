/**
 * #3.9 Architecture Drift panel.
 *
 * Three actions: scan now, save current as baseline, compare against baseline.
 * Shows new / resolved / persistent violations + severity badge.
 */

import { useTranslation } from "react-i18next";
import { useArchDriftStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

interface ArchDriftPanelProps {
	projectPath: string;
}

const SEV_COLOR: Record<string, string> = {
	none: "bg-muted text-muted-foreground",
	low: "bg-amber-500/20 text-amber-700 border-amber-500/40",
	medium: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	high: "bg-red-500/20 text-red-700 border-red-500/40",
	critical: "bg-red-700/30 text-red-900 border-red-700/40",
};

export function ArchDriftPanel({ projectPath }: ArchDriftPanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, scanReport, driftReport, scan, saveBaseline, compare } =
		useArchDriftStore();
	const isRunning = phase === "running";

	return (
		<PanelShell
			title={t("archDrift.title")}
			subtitle={t("archDrift.subtitle")}
			error={error}
			actions={
				<>
					<Button
						size="sm"
						variant="outline"
						onClick={() => scan(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.scan")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => saveBaseline(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.saveBaseline")}
					</Button>
					<Button
						size="sm"
						onClick={() => compare(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.compare")}
					</Button>
				</>
			}
		>
			{!projectPath && (
				<p className="text-sm text-muted-foreground">
					{t("common.projectPathRequired")}
				</p>
			)}
			{scanReport && (
				<div className="text-sm space-y-1 mb-3">
					<div>
						<span className="font-medium">{t("common.status")}: </span>
						<Badge variant="outline">{scanReport.status}</Badge>
					</div>
					<div className="text-muted-foreground">
						{scanReport.violation_count} {t("common.violations")} ·{" "}
						{scanReport.warning_count} {t("common.warnings")}
					</div>
				</div>
			)}
			{driftReport && (
				<div className="space-y-2 text-sm">
					<div className="flex items-center gap-3">
						<span className="font-medium">{t("archDrift.severity")}:</span>
						<Badge className={SEV_COLOR[driftReport.severity] ?? "bg-muted"}>
							{driftReport.severity}
						</Badge>
					</div>
					<div className="grid grid-cols-3 gap-3">
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.newViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.new_violations.length}
							</div>
						</div>
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.resolvedViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.resolved_violations.length}
							</div>
						</div>
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.persistentViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.persistent_violations.length}
							</div>
						</div>
					</div>
				</div>
			)}
		</PanelShell>
	);
}
