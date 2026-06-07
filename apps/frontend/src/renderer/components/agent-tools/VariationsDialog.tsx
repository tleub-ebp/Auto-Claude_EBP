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
import { Input } from "../ui/input";
import {
	type VariationComparison,
	type VariationManifest,
	compareVariations,
	createVariations,
	listVariations,
} from "../../lib/agent-tools-api";

export interface VariationsDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly specDir: string;
	/**
	 * Called when the user picks a variation as the winner. The hosting
	 * Kanban must do the actual merge (this UI never auto-merges). Receives
	 * the variation label + its absolute path.
	 */
	readonly onPickWinner?: (label: string, path: string) => void;
}

const STATUS_BADGE: Record<string, string> = {
	approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	rejected: "bg-red-500/15 text-red-700 dark:text-red-300",
	fixes_applied: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
	unknown: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

export function VariationsDialog({
	open,
	onOpenChange,
	specDir,
	onPickWinner,
}: VariationsDialogProps) {
	const [manifest, setManifest] = useState<VariationManifest | null>(null);
	const [comparison, setComparison] = useState<VariationComparison | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [count, setCount] = useState<number>(2);
	const [creating, setCreating] = useState(false);

	const reload = async (signal?: AbortSignal) => {
		setLoading(true);
		setError(null);
		const [m, c] = await Promise.all([
			listVariations(specDir, signal),
			compareVariations(specDir, signal),
		]);
		setLoading(false);
		if (m.ok) setManifest(m.data.manifest);
		else if (m.error !== "aborted") setError(m.error);
		if (c.ok) setComparison(c.data.comparison);
	};

	useEffect(() => {
		if (!open) {
			setManifest(null);
			setComparison(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		void reload(controller.signal);
		return () => controller.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, specDir]);

	const handleCreate = async () => {
		setCreating(true);
		setError(null);
		const res = await createVariations(specDir, count);
		setCreating(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		setManifest(res.data.manifest);
		// Refresh comparison too — the new variations exist but have no
		// implementation_plan yet.
		await reload();
	};

	const winner = comparison?.suggested_winner ?? null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Parallel variations (local Arena)</DialogTitle>
					<DialogDescription>
						Build the same spec multiple times in parallel and compare results
						side-by-side. Merging is always manual — the Kanban never auto-picks
						a winner. Cap is set via{" "}
						<code className="text-xs">WORKPILOT_PARALLEL_VARIATIONS</code>.
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-4 text-center text-sm text-muted-foreground">
						Loading…
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{manifest && (
					<>
						<div className="flex items-center gap-2 rounded-md border p-3">
							<div className="flex-1">
								<div className="text-sm font-medium">Scaffold variations</div>
								<div className="text-xs text-muted-foreground">
									Creates copies of the spec under{" "}
									<code className="text-[10px]">variations/v1</code>,{" "}
									<code className="text-[10px]">v2</code>… The agent must be
									launched separately for each one.
								</div>
							</div>
							<Input
								type="number"
								min={1}
								max={5}
								value={count}
								onChange={(e) => setCount(Number(e.target.value) || 1)}
								className="w-16 h-8 text-sm"
							/>
							<Button size="sm" disabled={creating} onClick={handleCreate}>
								{creating ? "Creating…" : "Scaffold"}
							</Button>
						</div>

						{comparison && comparison.rows.length > 0 && (
							<div className="space-y-2">
								<div className="text-xs text-muted-foreground">
									{winner ? (
										<>
											Suggested winner:{" "}
											<code className="text-foreground">{winner}</code>
											{" — "}consultative only, you make the call.
										</>
									) : (
										"No clear winner yet (all tied or no QA verdict)."
									)}
								</div>
								{comparison.rows.map((row) => {
									const descriptor = manifest.variations.find(
										(v) => v.label === row.label,
									);
									const isWinner = row.label === winner;
									return (
										<div
											key={row.label}
											className={`rounded-md border p-3 ${isWinner ? "ring-2 ring-emerald-400/40" : ""}`}
										>
											<div className="flex items-center justify-between gap-2">
												<div className="flex-1">
													<div className="flex items-center gap-2">
														<span className="font-medium font-mono">
															{row.label}
														</span>
														{isWinner && (
															<Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px]">
																suggested
															</Badge>
														)}
														<Badge
															className={`text-[10px] ${STATUS_BADGE[row.qa_status] ?? STATUS_BADGE.unknown}`}
														>
															{row.qa_status}
														</Badge>
													</div>
													<div className="text-xs text-muted-foreground mt-1">
														{row.subtasks_completed}/{row.subtasks_total}{" "}
														subtasks
														{row.qa_report_chars > 0 &&
															`, qa_report ${row.qa_report_chars}ch`}
														{row.has_self_review && ", + self_review"}
													</div>
												</div>
												<Button
													size="sm"
													variant={isWinner ? "default" : "outline"}
													disabled={!descriptor}
													onClick={() =>
														descriptor &&
														onPickWinner?.(row.label, descriptor.path)
													}
												>
													Pick this one
												</Button>
											</div>
										</div>
									);
								})}
							</div>
						)}

						{manifest.variations.length === 0 && (
							<div className="text-center text-sm text-muted-foreground py-4">
								No variations scaffolded yet.
							</div>
						)}
					</>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
