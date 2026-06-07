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
import {
	type CostEstimate,
	previewBuildCost,
} from "../../lib/agent-tools-api";

export interface CostEstimatorDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly specDir: string;
	/** Called when the user confirms the build start. Closes the dialog. */
	readonly onConfirm: () => void;
}

const CONFIDENCE_COLORS: Record<CostEstimate["confidence"], string> = {
	high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	low: "bg-red-500/15 text-red-700 dark:text-red-300",
};

const formatCost = (usd: number): string => {
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `~$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
};

const formatTokens = (n: number): string =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

export function CostEstimatorDialog({
	open,
	onOpenChange,
	specDir,
	onConfirm,
}: CostEstimatorDialogProps) {
	const [estimate, setEstimate] = useState<CostEstimate | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setEstimate(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		previewBuildCost(specDir, controller.signal)
			.then((res) => {
				if (res.ok) {
					setEstimate(res.data.estimate);
				} else if (res.error !== "aborted") {
					setError(res.error);
				}
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, specDir]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Estimated build cost</DialogTitle>
					<DialogDescription>
						Token usage and cost projection for{" "}
						<code className="text-xs">{specDir.split(/[/\\]/).pop()}</code>{" "}
						before the agent starts.
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						Estimating…
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						Estimation unavailable: {error}
					</div>
				)}

				{estimate && (
					<div className="space-y-4">
						<div className="flex items-center justify-between rounded-md border p-3">
							<div>
								<div className="text-xs text-muted-foreground">
									Total estimate
								</div>
								<div className="text-2xl font-semibold">
									{formatCost(estimate.total_cost_usd)}
								</div>
							</div>
							<Badge className={CONFIDENCE_COLORS[estimate.confidence]}>
								{estimate.confidence} confidence
							</Badge>
						</div>

						<div className="space-y-2">
							{estimate.phases.map((phase) => (
								<div
									key={phase.phase}
									className="flex items-center justify-between rounded-md border p-2 text-sm"
								>
									<div>
										<div className="font-medium capitalize">{phase.phase}</div>
										<div className="text-xs text-muted-foreground">
											{phase.provider} / {phase.model}
											{phase.iterations > 1 ? ` × ${phase.iterations}` : ""}
										</div>
									</div>
									<div className="text-right">
										<div className="font-mono">
											{formatCost(phase.estimated_cost_usd)}
										</div>
										<div className="text-xs text-muted-foreground">
											{formatTokens(phase.input_tokens)} in /{" "}
											{formatTokens(phase.output_tokens)} out
										</div>
									</div>
								</div>
							))}
						</div>

						{estimate.warnings.length > 0 && (
							<ul className="text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
								{estimate.warnings.map((w) => (
									<li key={w}>⚠ {w}</li>
								))}
							</ul>
						)}
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={loading || error !== null}
						onClick={() => {
							onConfirm();
							onOpenChange(false);
						}}
					>
						Start build
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
