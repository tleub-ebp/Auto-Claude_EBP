import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	Layers,
	Loader2,
	XCircle,
} from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EXECUTION_PHASE_LABELS } from "../../shared/constants";
import type { Task } from "../../shared/types";
import {
	type CompactedStatus,
	compactSessionHistory,
} from "../lib/session-compaction";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

interface SessionCompactionBadgeProps {
	task: Task;
}

const STATUS_DOT: Record<CompactedStatus, { className: string; pulse?: boolean }> =
	{
		completed: { className: "bg-success" },
		failed: { className: "bg-destructive" },
		in_progress: { className: "bg-info", pulse: true },
		pending: { className: "bg-muted-foreground/40" },
	};

function StatusIcon({ status }: { status: CompactedStatus }) {
	switch (status) {
		case "completed":
			return <CheckCircle2 className="h-3 w-3 text-success shrink-0" />;
		case "failed":
			return <XCircle className="h-3 w-3 text-destructive shrink-0" />;
		case "in_progress":
			return <Loader2 className="h-3 w-3 text-info shrink-0 animate-spin" />;
		default:
			return (
				<span className="h-3 w-3 shrink-0 rounded-full border border-muted-foreground/30" />
			);
	}
}

/**
 * Compaction affordance for long-running tasks. Renders nothing until a task has
 * enough phases to be worth compacting; otherwise a pill that opens the
 * structured handoff (progress, the steps that matter, and the last failure).
 */
export const SessionCompactionBadge = memo(
	({ task }: SessionCompactionBadgeProps) => {
		const { t } = useTranslation(["tasks", "common"]);
		const [open, setOpen] = useState(false);

		const handoff = compactSessionHistory(task);
		if (!handoff) return null;

		const currentPhase = task.executionProgress?.phase;
		const { completionPercent, totalPhases, criticalPhases, lastFailure } =
			handoff;

		return (
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						onClick={(e) => e.stopPropagation()}
						title={t("labels.sessionCompactionHint", { count: totalPhases })}
						className={cn(
							"group inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
							"border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
							lastFailure && "border-destructive/30 text-destructive/90",
						)}
					>
						<Layers className="h-3 w-3" />
						<span>{t("labels.compactedPhases", { count: totalPhases })}</span>
						{/* Mini progress meter */}
						<span className="relative h-1 w-8 overflow-hidden rounded-full bg-muted-foreground/20">
							<span
								className={cn(
									"absolute inset-y-0 left-0 rounded-full",
									lastFailure ? "bg-destructive/70" : "bg-success/80",
								)}
								style={{ width: `${completionPercent}%` }}
							/>
						</span>
						<span className="tabular-nums">{completionPercent}%</span>
						<ChevronDown className="h-3 w-3 opacity-50 transition-transform group-data-[state=open]:rotate-180" />
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-80 p-0 overflow-hidden"
					onClick={(e) => e.stopPropagation()}
				>
					{/* Header */}
					<div className="bg-linear-to-br from-primary/10 to-transparent px-4 py-3 border-b border-border/60">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Layers className="h-4 w-4 text-primary" />
								<span className="text-sm font-semibold">
									{t("labels.sessionCompaction")}
								</span>
							</div>
							<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums">
								{handoff.completedPhases}/{totalPhases}
							</span>
						</div>
						<p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
							{handoff.contextSummary}
						</p>
						{/* Progress bar */}
						<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
							<div
								className={cn(
									"h-full rounded-full transition-all",
									lastFailure ? "bg-destructive/70" : "bg-success/80",
								)}
								style={{ width: `${completionPercent}%` }}
							/>
						</div>
					</div>

					{/* Critical phases */}
					<div className="px-2 py-2">
						<p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
							{t("labels.criticalPhases")} · {criticalPhases.length}/
							{totalPhases}
						</p>
						<div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
							{criticalPhases.map((phase) => (
								<div
									key={phase.index}
									className={cn(
										"flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60",
										phase.critical && phase.status === "failed" && "bg-destructive/5",
									)}
								>
									<StatusIcon status={phase.status} />
									<span className="min-w-6 text-right tabular-nums text-muted-foreground">
										{phase.index}
									</span>
									<div className="min-w-0 flex-1">
										<span className="block truncate text-foreground">
											{phase.title}
										</span>
										{phase.failureReason && (
											<span className="mt-0.5 block truncate font-mono text-[10px] text-destructive/80">
												{phase.failureReason}
											</span>
										)}
									</div>
									{phase.critical && (
										<span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/80" />
									)}
								</div>
							))}
						</div>
					</div>

					{/* Footer: current phase / last failure */}
					{(currentPhase || lastFailure) && (
						<div className="border-t border-border/60 px-4 py-2 text-[10px]">
							{lastFailure ? (
								<div className="flex items-center gap-1.5 text-destructive">
									<AlertTriangle className="h-3 w-3" />
									<span className="font-medium">
										{t("labels.lastError")}:
									</span>
									<span className="truncate text-muted-foreground">
										#{lastFailure.index} {lastFailure.title}
									</span>
								</div>
							) : currentPhase ? (
								<div className="flex items-center gap-1.5 text-muted-foreground">
									<span
										className={cn(
											"h-1.5 w-1.5 rounded-full",
											STATUS_DOT.in_progress.className,
											"animate-pulse",
										)}
									/>
									<span className="font-medium text-foreground">
										{t("labels.currentPhase")}:
									</span>
									<span>
										{EXECUTION_PHASE_LABELS[currentPhase] || currentPhase}
									</span>
								</div>
							) : null}
						</div>
					)}
				</PopoverContent>
			</Popover>
		);
	},
);

SessionCompactionBadge.displayName = "SessionCompactionBadge";
