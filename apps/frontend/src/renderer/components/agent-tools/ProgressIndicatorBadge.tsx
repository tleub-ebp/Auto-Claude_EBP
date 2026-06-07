import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import {
	type ProgressIndicatorPayload,
	fetchProgressIndicator,
} from "../../lib/agent-tools-api";

export interface ProgressIndicatorBadgeProps {
	readonly specDir: string;
	/** Refresh interval in ms. Defaults to 5s. Pass 0 to disable polling. */
	readonly intervalMs?: number;
	/** Render nothing when the phase is "idle"/"unknown" (default true). */
	readonly hideWhenIdle?: boolean;
}

const PHASE_STYLES: Record<ProgressIndicatorPayload["phase"], string> = {
	planning: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
	coding: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	qa: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	completed: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
	idle: "bg-slate-400/10 text-slate-500 dark:text-slate-400",
	unknown: "bg-slate-400/10 text-slate-500 dark:text-slate-400",
};

const PHASE_DOTS: Record<ProgressIndicatorPayload["phase"], string> = {
	planning: "●",
	coding: "●",
	qa: "●",
	completed: "✓",
	idle: "○",
	unknown: "?",
};

/** Live-updating sub-status pill for a Kanban card.
 *
 * Polls `/api/progress-indicator/?spec_dir=...` on a timer. Renders
 * nothing when the phase is "idle" / "unknown" (unless ``hideWhenIdle``
 * is false), so cards in `backlog`/`queue` don't get a misleading badge.
 */
export function ProgressIndicatorBadge({
	specDir,
	intervalMs = 5000,
	hideWhenIdle = true,
}: ProgressIndicatorBadgeProps) {
	const [snapshot, setSnapshot] = useState<ProgressIndicatorPayload | null>(
		null,
	);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();

		const tick = async () => {
			const res = await fetchProgressIndicator(specDir, controller.signal);
			if (cancelled) return;
			if (res.ok) {
				setSnapshot(res.data.indicator);
			}
			// On error: keep the previous snapshot displayed silently.
		};

		void tick();
		const handle =
			intervalMs > 0
				? globalThis.setInterval(() => void tick(), intervalMs)
				: null;

		return () => {
			cancelled = true;
			controller.abort();
			if (handle !== null) globalThis.clearInterval(handle);
		};
	}, [specDir, intervalMs]);

	if (snapshot === null) return null;
	if (
		hideWhenIdle &&
		(snapshot.phase === "idle" || snapshot.phase === "unknown")
	) {
		return null;
	}

	const styleClass = PHASE_STYLES[snapshot.phase] ?? PHASE_STYLES.unknown;
	const dot = PHASE_DOTS[snapshot.phase] ?? PHASE_DOTS.unknown;

	return (
		<Badge className={`text-[10px] gap-1 ${styleClass}`} title={snapshot.label}>
			<span aria-hidden>{dot}</span>
			<span>{snapshot.label}</span>
		</Badge>
	);
}
