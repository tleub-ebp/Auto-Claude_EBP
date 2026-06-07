/**
 * #3.7 License Governance panel.
 *
 * Pick a policy preset, scan the project, see which dependencies have
 * conflicting licences and the suggested remediation.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLicenseStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

interface LicensePanelProps {
	readonly projectPath: string;
}

const POLICIES = [
	{ value: "permissive_only", labelKey: "license.policyPermissive" },
	{ value: "open_source_friendly", labelKey: "license.policyOpen" },
	{ value: "saas_safe", labelKey: "license.policySaas" },
] as const;

export function LicensePanel({ projectPath }: LicensePanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, report, scan } = useLicenseStore();
	const [policy, setPolicy] =
		useState<"permissive_only" | "open_source_friendly" | "saas_safe">("permissive_only");

	const isRunning = phase === "running";

	return (
		<PanelShell
			title={t("license.title")}
			subtitle={t("license.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => scan(projectPath, policy)}
					disabled={isRunning || !projectPath}
				>
					{isRunning ? t("common.running") : t("license.scan")}
				</Button>
			}
		>
			<div className="space-y-3">
				<div>
					<label htmlFor="policy-select" className="block text-sm font-medium mb-1">
						{t("license.policy")}
					</label>
					<select
						id="policy-select"
						value={policy}
						onChange={(e) => setPolicy(e.target.value as typeof policy)}
						className="w-full rounded border bg-background p-2 text-sm"
					>
						{POLICIES.map((p) => (
							<option key={p.value} value={p.value}>
								{t(p.labelKey as never)}
							</option>
						))}
					</select>
				</div>
				{!projectPath && (
					<p className="text-sm text-muted-foreground">
						{t("common.projectPathRequired")}
					</p>
				)}
				{report && (
					<div className="space-y-2">
						<div className="flex items-center gap-3">
							<Badge
								className={
									report.passed
										? "bg-green-500/20 text-green-700 border-green-500/40"
										: "bg-red-500/20 text-red-700 border-red-500/40"
								}
							>
								{report.passed ? t("license.passed") : t("license.failed")}
							</Badge>
							<span className="text-sm text-muted-foreground">
								{t("license.dependencies")}: {report.dependencies.length} ·{" "}
								{t("license.conflicts")}: {report.conflicts.length}
							</span>
						</div>
						{report.conflicts.length > 0 && (
							<table className="w-full text-sm border">
								<thead>
									<tr className="border-b bg-muted/40">
										<th className="text-left p-2">{t("license.colPackage")}</th>
										<th className="text-left p-2">{t("license.colCategory")}</th>
										<th className="text-left p-2">{t("license.colRemediation")}</th>
									</tr>
								</thead>
								<tbody>
									{report.conflicts.map((c) => (
										<tr key={c.dependency.name} className="border-b">
											<td className="p-2 font-mono">{c.dependency.name}</td>
											<td className="p-2">{c.category}</td>
											<td className="p-2 text-xs text-muted-foreground">
												{c.remediation}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				)}
			</div>
		</PanelShell>
	);
}
