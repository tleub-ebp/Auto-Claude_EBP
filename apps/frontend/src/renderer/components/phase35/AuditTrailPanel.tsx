/**
 * #3.3 Audit Trail panel.
 *
 * Inspect a trail directory: list events, replay by correlation_id, verify
 * the hash chain. Read-only — append happens from agents, not the UI.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuditTrailStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

export function AuditTrailPanel() {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		events,
		replayEvents,
		integrity,
		loadEvents,
		replay,
		verify,
	} = useAuditTrailStore();
	const [storageDir, setStorageDir] = useState("");
	const [trailName, setTrailName] = useState("default");
	const [correlationId, setCorrelationId] = useState("");

	const isRunning = phase === "running";

	const storageDirError = useMemo(
		() => (storageDir.trim().length === 0 ? t("audit.validation.storageDirRequired") : null),
		[storageDir, t],
	);
	const trailNameError = useMemo(
		() => (trailName.trim().length === 0 ? t("audit.validation.trailNameRequired") : null),
		[trailName, t],
	);
	const correlationIdError = useMemo(
		() =>
			correlationId.trim().length === 0
				? t("audit.validation.correlationIdRequired")
				: null,
		[correlationId, t],
	);

	const canBrowse = !storageDirError && !trailNameError;
	const canReplay = canBrowse && !correlationIdError;

	return (
		<PanelShell
			title={t("audit.title")}
			subtitle={t("audit.subtitle")}
			error={error}
			actions={
				<>
					<Button
						size="sm"
						variant="outline"
						onClick={() => loadEvents(storageDir.trim(), trailName.trim())}
						disabled={isRunning || !canBrowse}
					>
						{t("audit.events")}
					</Button>
					<Button
						size="sm"
						onClick={() => verify(storageDir.trim(), trailName.trim())}
						disabled={isRunning || !canBrowse}
					>
						{t("audit.verify")}
					</Button>
				</>
			}
		>
			<div className="space-y-3 text-sm">
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="storage-dir-input" className="block font-medium mb-1">
							{t("audit.storageDir")}
						</label>
						<input
							id="storage-dir-input"
							value={storageDir}
							onChange={(e) => setStorageDir(e.target.value)}
							aria-invalid={Boolean(storageDirError) || undefined}
							aria-describedby={storageDirError ? "storage-dir-error" : undefined}
							className="w-full rounded border bg-background p-2 font-mono text-xs"
							placeholder={t("audit.storageDirPlaceholder")}
						/>
						{storageDirError && (
							<p id="storage-dir-error" className="mt-1 text-xs text-destructive">
								{storageDirError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="trail-name-input" className="block font-medium mb-1">
							{t("audit.trailName")}
						</label>
						<input
							id="trail-name-input"
							value={trailName}
							onChange={(e) => setTrailName(e.target.value.slice(0, 64))}
							maxLength={64}
							aria-invalid={Boolean(trailNameError) || undefined}
							aria-describedby={trailNameError ? "trail-name-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm"
						/>
						{trailNameError && (
							<p id="trail-name-error" className="mt-1 text-xs text-destructive">
								{trailNameError}
							</p>
						)}
					</div>
				</div>

				<div className="flex gap-2 items-end">
					<div className="flex-1">
						<label htmlFor="correlation-id-input" className="block font-medium mb-1">
							{t("audit.correlationId")}
						</label>
						<input
							id="correlation-id-input"
							value={correlationId}
							onChange={(e) => setCorrelationId(e.target.value.slice(0, 128))}
							maxLength={128}
							aria-invalid={Boolean(correlationIdError) || undefined}
							aria-describedby={correlationIdError ? "correlation-id-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm"
							placeholder={t("audit.correlationIdPlaceholder")}
						/>
						{correlationIdError && (
							<p id="correlation-id-error" className="mt-1 text-xs text-destructive">
								{correlationIdError}
							</p>
						)}
					</div>
					<Button
						size="sm"
						onClick={() =>
							replay(correlationId.trim(), storageDir.trim(), trailName.trim())
						}
						disabled={isRunning || !canReplay}
					>
						{t("audit.replay")}
					</Button>
				</div>

				{integrity && (
					<div className="rounded border p-2">
						<Badge
							className={
								integrity.is_intact
									? "bg-green-500/20 text-green-700 border-green-500/40"
									: "bg-red-500/20 text-red-700 border-red-500/40"
							}
						>
							{integrity.is_intact ? t("audit.intact") : t("audit.tampered")}
						</Badge>
						<span className="ml-2 text-xs text-muted-foreground">
							{integrity.events_checked} {t("audit.eventsChecked")}
						</span>
						{integrity.breakage_reason && (
							<div className="mt-1 text-xs text-destructive">
								{integrity.breakage_reason}
							</div>
						)}
					</div>
				)}

				{(replayEvents.length > 0 || events.length > 0) && (
					<div>
						<div className="font-medium mb-1">
							{replayEvents.length > 0 ? t("audit.replayLabel") : t("audit.events")} (
							{(replayEvents.length || events.length).toLocaleString()})
						</div>
						<ol className="space-y-1 text-xs max-h-96 overflow-auto">
							{(replayEvents.length > 0 ? replayEvents : events).map((e) => (
								<li
									key={e.event_hash}
									className="rounded border p-2 font-mono"
								>
									<div className="flex justify-between">
										<span>
											#{e.sequence} · {e.kind}
										</span>
										<span className="text-muted-foreground">
											{new Date(e.timestamp * 1000).toISOString()}
										</span>
									</div>
									<div className="mt-1">
										<span className="text-muted-foreground">actor=</span>
										{e.actor}{" "}
										<span className="text-muted-foreground">cid=</span>
										{e.correlation_id}
									</div>
									<div className="mt-1 text-muted-foreground truncate">
										{e.summary}
									</div>
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
