import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
	type Timeline,
	type TimelineEntry,
	fetchTimeline,
} from "../../lib/agent-tools-api";

export interface TimelineDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly projectDir: string;
	readonly correlationId: string;
}

const PHASE_COLORS: Record<string, string> = {
	planning: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
	coding: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	qa: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	documentation: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
	system: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

const KIND_ICONS: Record<string, string> = {
	agent_invoked: "▶",
	agent_completed: "✓",
	agent_failed: "✗",
	agent_paused: "⏸",
	decision_made: "◆",
	policy_violated: "⚠",
	system_event: "·",
};

function formatDelta(seconds: number): string {
	if (seconds < 1) return "0s";
	if (seconds < 60) return `+${seconds.toFixed(1)}s`;
	if (seconds < 3600) return `+${(seconds / 60).toFixed(1)}m`;
	return `+${(seconds / 3600).toFixed(1)}h`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

function EntryRow({ entry }: { readonly entry: TimelineEntry }) {
	const [expanded, setExpanded] = useState(false);
	const hasPayload = Object.keys(entry.payload).length > 0;
	const phaseClass = PHASE_COLORS[entry.phase] ?? PHASE_COLORS.system;
	const icon = KIND_ICONS[entry.kind] ?? "·";

	return (
		<div className="border-l-2 border-muted pl-3 py-2 hover:bg-muted/30 transition-colors">
			<div className="flex items-start gap-2">
				<span className="text-sm font-mono w-4 shrink-0">{icon}</span>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<Badge className={`text-[10px] ${phaseClass}`}>
							{entry.actor}
						</Badge>
						<span className="text-xs text-muted-foreground font-mono">
							{entry.kind}
						</span>
						{entry.delta_seconds > 0 && (
							<span className="text-[10px] text-muted-foreground">
								{formatDelta(entry.delta_seconds)}
							</span>
						)}
					</div>
					<div className="text-sm mt-0.5">{entry.summary}</div>
					{hasPayload && (
						<button
							type="button"
							className="text-[10px] text-muted-foreground hover:text-foreground mt-1 cursor-pointer bg-transparent border-none p-0"
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? "▾ Hide payload" : "▸ Show payload"}
						</button>
					)}
					{expanded && hasPayload && (
						<pre className="mt-1 text-[10px] bg-muted/50 p-2 rounded overflow-x-auto">
							{JSON.stringify(entry.payload, null, 2)}
						</pre>
					)}
				</div>
				<span className="text-[10px] text-muted-foreground shrink-0 font-mono">
					#{entry.sequence}
				</span>
			</div>
		</div>
	);
}

export function TimelineDialog({
	open,
	onOpenChange,
	projectDir,
	correlationId,
}: TimelineDialogProps) {
	const [timeline, setTimeline] = useState<Timeline | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setTimeline(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchTimeline(projectDir, correlationId, { signal: controller.signal })
			.then((res) => {
				if (res.ok) setTimeline(res.data.timeline);
				else if (res.error !== "aborted") setError(res.error);
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, projectDir, correlationId]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Agent timeline</DialogTitle>
					<DialogDescription>
						Every audit-trail event for spec{" "}
						<code className="text-xs">{correlationId}</code>, in causal order.
						Click an event to inspect its payload.
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						Loading timeline…
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{timeline && (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2 text-xs">
							<Badge variant="outline">
								{timeline.entry_count} event{timeline.entry_count !== 1 ? "s" : ""}
							</Badge>
							<Badge variant="outline">
								duration: {formatDuration(timeline.duration_seconds)}
							</Badge>
							{timeline.integrity.intact ? (
								<Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
									chain intact
								</Badge>
							) : (
								<Badge className="bg-red-500/15 text-red-700 dark:text-red-300">
									⚠ chain broken: {timeline.integrity.reason}
								</Badge>
							)}
							{Object.entries(timeline.phase_counts).map(([phase, count]) => (
								<Badge key={phase} className={PHASE_COLORS[phase] ?? PHASE_COLORS.system}>
									{phase}: {count}
								</Badge>
							))}
						</div>

						{timeline.entries.length === 0 ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								No events recorded yet for this spec. Events will appear once
								an agent runs against it.
							</div>
						) : (
							<ScrollArea className="h-96 rounded-md border">
								<div className="divide-y">
									{timeline.entries.map((entry) => (
										<EntryRow key={entry.event_hash || entry.sequence} entry={entry} />
									))}
								</div>
							</ScrollArea>
						)}
					</div>
				)}

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)}>Close</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
