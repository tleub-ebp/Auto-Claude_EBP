/**
 * #3.4 CI/CD Anomaly Detective panel.
 *
 * Paste a CI log → see detected signals (kind / severity / suggested fix)
 * + recurring patterns when multiple logs were analysed.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCicdAnomalyStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

const SEV_COLOR: Record<string, string> = {
	critical: "bg-red-500/20 text-red-700 border-red-500/40",
	high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	medium: "bg-amber-500/20 text-amber-700 border-amber-500/40",
	low: "bg-muted text-muted-foreground",
};

const LOG_MAX_LEN = 200_000;

export function CicdAnomalyPanel() {
	const { t } = useTranslation("phase35");
	const { phase, error, signals, scan } = useCicdAnomalyStore();
	const [log, setLog] = useState("");

	const isRunning = phase === "running";

	const logError = useMemo(() => {
		if (log.trim().length === 0) return t("cicdAnomaly.validation.logRequired");
		if (log.length > LOG_MAX_LEN)
			return t("cicdAnomaly.validation.logTooLarge", { max: LOG_MAX_LEN });
		return null;
	}, [log, t]);

	return (
		<PanelShell
			title={t("cicdAnomaly.title")}
			subtitle={t("cicdAnomaly.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => scan(log)}
					disabled={isRunning || Boolean(logError)}
				>
					{isRunning ? t("common.running") : t("cicdAnomaly.scan")}
				</Button>
			}
		>
			<div className="space-y-3">
				<div>
					<label htmlFor="log-textarea" className="block text-sm font-medium mb-1">
						{t("cicdAnomaly.logLabel")}
					</label>
					<textarea
						id="log-textarea"
						value={log}
						onChange={(e) => setLog(e.target.value.slice(0, LOG_MAX_LEN))}
						rows={10}
						maxLength={LOG_MAX_LEN}
						aria-invalid={Boolean(logError) || undefined}
						aria-describedby={logError ? "log-error" : undefined}
						className="w-full rounded border bg-background p-2 text-xs font-mono"
						placeholder={t("cicdAnomaly.logPlaceholder")}
					/>
					{logError && (
						<p id="log-error" className="mt-1 text-xs text-destructive">
							{logError}
						</p>
					)}
				</div>

				{signals.length > 0 && (
					<div>
						<div className="mb-2 font-medium text-sm">
							{t("cicdAnomaly.signals")} ({signals.length})
						</div>
						<ul className="space-y-2 text-sm">
							{signals.map((s) => (
								<li key={`${s.kind}-${s.line_number}`} className="rounded border p-2">
									<div className="flex items-center gap-2">
										<Badge className={SEV_COLOR[s.severity] ?? "bg-muted"}>
											{s.severity}
										</Badge>
										<span className="font-mono text-xs">{s.kind}</span>
										<span className="text-xs text-muted-foreground">
											{t("cicdAnomaly.line")} {s.line_number}
										</span>
									</div>
									<div className="mt-1 font-mono text-xs text-muted-foreground truncate">
										{s.matching_line}
									</div>
									<div className="mt-1 text-xs">
										<span className="font-medium">→ </span>
										{s.suggested_fix}
									</div>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
