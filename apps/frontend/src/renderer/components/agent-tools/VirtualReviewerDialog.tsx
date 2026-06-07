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
	type VirtualReviewSummaryPayload,
	fetchVirtualReviewSummary,
	runVirtualReview,
} from "../../lib/agent-tools-api";

export interface VirtualReviewerDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly projectDir: string;
	readonly specDir: string;
	/** Called after the reviewer wrote virtual_review.md, with its absolute path. */
	readonly onReviewWritten?: (path: string) => void;
}

export function VirtualReviewerDialog({
	open,
	onOpenChange,
	projectDir,
	specDir,
	onReviewWritten,
}: VirtualReviewerDialogProps) {
	const [summary, setSummary] = useState<VirtualReviewSummaryPayload | null>(
		null,
	);
	const [enabled, setEnabled] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [writtenPath, setWrittenPath] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setSummary(null);
			setError(null);
			setWrittenPath(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchVirtualReviewSummary(specDir, projectDir, controller.signal)
			.then((res) => {
				if (res.ok) {
					setSummary(res.data.summary);
					setEnabled(res.data.enabled);
				} else if (res.error !== "aborted") {
					setError(res.error);
				}
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, projectDir, specDir]);

	const handleRun = async () => {
		setRunning(true);
		setError(null);
		const res = await runVirtualReview(specDir, projectDir);
		setRunning(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		setWrittenPath(res.data.written_to);
		onReviewWritten?.(res.data.written_to);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Virtual reviewer (advisory)</DialogTitle>
					<DialogDescription>
						<strong>Machine-generated commentary, not a human review.</strong>{" "}
						Writes <code className="text-xs">virtual_review.md</code> at the
						spec root. Never signs in your name, never opens a PR. Enable via{" "}
						<code className="text-xs">
							WORKPILOT_VIRTUAL_REVIEWER_ENABLED
						</code>
						.
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						Loading…
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{summary && (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2 text-xs">
							{enabled ? (
								<Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
									enabled
								</Badge>
							) : (
								<Badge className="bg-slate-500/15 text-slate-700 dark:text-slate-300">
									disabled (env flag off)
								</Badge>
							)}
							<Badge variant="outline">
								spec: {summary.spec_chars}ch
							</Badge>
							<Badge variant="outline">
								qa_report: {summary.qa_report_chars}ch
							</Badge>
							{summary.self_review_present && (
								<Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">
									self_review.md present
								</Badge>
							)}
							{summary.diff_truncated && (
								<Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
									diff truncated
								</Badge>
							)}
						</div>

						{summary.error && (
							<div className="text-xs text-amber-700 dark:text-amber-300">
								⚠ {summary.error}
							</div>
						)}

						{writtenPath && (
							<div className="rounded-md bg-emerald-500/10 p-3 text-sm">
								<div className="font-medium text-emerald-700 dark:text-emerald-300">
									✓ virtual_review.md written
								</div>
								<code className="text-xs text-muted-foreground break-all">
									{writtenPath}
								</code>
							</div>
						)}

						<div className="text-xs text-muted-foreground">
							The HTTP endpoint runs in stub mode (deterministic fallback). For
							a full SDK-backed review, the agent runtime needs to wire an
							in-process invokable client.
						</div>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button disabled={!enabled || running} onClick={handleRun}>
						{running ? "Running…" : "Run virtual review"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
