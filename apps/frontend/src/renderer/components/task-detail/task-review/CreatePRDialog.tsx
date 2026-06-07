import { ExternalLink, GitPullRequest, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Task,
	WorktreeCreatePRResult,
	WorktreeStatus,
} from "../../../../shared/types";
import { appendImpactBlock } from "../../../../shared/utils/pr-impact-block";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";

interface CreatePRDialogProps {
	open: boolean;
	task: Task;
	worktreeStatus: WorktreeStatus | null;
	onOpenChange: (open: boolean) => void;
	onCreatePR: (options: {
		targetBranch?: string;
		title?: string;
		draft?: boolean;
		customBody?: string;
	}) => Promise<WorktreeCreatePRResult | null>;
}

/**
 * Dialog for creating a Pull Request from a worktree branch
 * Allows user to specify target branch, PR title, and draft status
 */
export function CreatePRDialog({
	open,
	task,
	worktreeStatus,
	onOpenChange,
	onCreatePR,
}: CreatePRDialogProps) {
	const { t } = useTranslation(["taskReview", "common"]);
	// L'URL de la PR est stockée dans metadata.prUrl ; on garde task.prUrl en
	// repli pour rester compatible avec d'éventuels appelants legacy.
	const existingPrUrl = task.prUrl ?? task.metadata?.prUrl;
	const hasExistingPr = Boolean(existingPrUrl);
	const [targetBranch, setTargetBranch] = useState("");
	const [prTitle, setPrTitle] = useState("");
	const [isDraft, setIsDraft] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [result, setResult] = useState<WorktreeCreatePRResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Impact analysis state
	const [impactRating, setImpactRating] = useState<string>("N/A");
	const [impactFeatures, setImpactFeatures] = useState<string>("");
	const [analyzedBody, setAnalyzedBody] = useState<string | null>(null);
	const [isAnalyzing, setIsAnalyzing] = useState(false);
	const [analysisError, setAnalysisError] = useState<string | null>(null);
	const [isRetryingProof, setIsRetryingProof] = useState(false);

	// Relance la preuve visuelle automatisée sur la PR existante.
	const handleRetryVisualProof = async () => {
		setIsRetryingProof(true);
		try {
			const response = await window.electronAPI?.runVisualProof?.(task.id);
			if (response?.success && response.data) {
				setResult((prev) =>
					prev ? { ...prev, visualProof: response.data } : prev,
				);
			}
		} finally {
			setIsRetryingProof(false);
		}
	};

	// Reset state when dialog opens
	useEffect(() => {
		if (open) {
			setTargetBranch(worktreeStatus?.baseBranch || "");
			setPrTitle(task.title);
			setIsDraft(false);
			setIsCreating(false);
			setResult(null);
			setError(null);
			setImpactRating("N/A");
			setImpactFeatures("");
			setAnalyzedBody(null);
			setAnalysisError(null);
		}
	}, [open, worktreeStatus?.baseBranch, task.title]);

	// Kick off impact analysis once when the dialog opens. The analyzer reads
	// the worktree diff and returns a suggested rating + impacted-features
	// summary plus the AI-composed PR body. The user can edit values before
	// submission; we re-build the final body from the edited values.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setIsAnalyzing(true);
		setAnalysisError(null);
		globalThis.window.electronAPI
			.analyzeWorktreeImpact(task.id, worktreeStatus?.baseBranch || undefined)
			.then((res) => {
				if (cancelled) return;
				if (res.success && res.data?.success) {
					setAnalyzedBody(res.data.body ?? "");
					setImpactRating(res.data.rating ?? "N/A");
					setImpactFeatures(res.data.features ?? "");
				} else {
					setAnalysisError(
						res.data?.error || res.error || t("taskReview:pr.impact.analysisFailed"),
					);
				}
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setAnalysisError(
					err instanceof Error
						? err.message
						: t("taskReview:pr.impact.analysisFailed"),
				);
			})
			.finally(() => {
				if (!cancelled) setIsAnalyzing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, task.id, worktreeStatus?.baseBranch, t]);

	// Frontend validation functions
	const validateBranchName = (branch: string): string | null => {
		if (!branch.trim()) return null; // Empty is OK, will use default
		// Basic git branch name rules: no spaces, .., @{, \, etc.
		if (!/^[a-zA-Z0-9/_-]+$/.test(branch)) {
			return t("taskReview:pr.errors.invalidBranchName");
		}
		return null;
	};

	const validatePRTitle = (title: string): string | null => {
		if (!title.trim()) {
			return t("taskReview:pr.errors.emptyTitle");
		}
		return null;
	};

	const handleCreatePR = async () => {
		// Frontend validation before submitting
		const branchError = validateBranchName(targetBranch);
		if (branchError) {
			setError(branchError);
			return;
		}

		const titleError = validatePRTitle(prTitle);
		if (titleError) {
			setError(titleError);
			return;
		}

		setIsCreating(true);
		setError(null);
		setResult(null);

		// If the analyzer produced a body, rebuild the final body from the
		// (possibly user-edited) rating + features and send it as customBody.
		// Otherwise let the backend auto-generate (with N/A fallback).
		let customBody: string | undefined;
		if (analyzedBody !== null) {
			const rating = impactRating.trim() || "N/A";
			const features = impactFeatures.trim() || "Non evalue";
			customBody = appendImpactBlock(analyzedBody, rating, features);
		}

		try {
			const prResult = await onCreatePR({
				targetBranch: targetBranch || undefined,
				title: prTitle || undefined,
				draft: isDraft,
				customBody,
			});

			if (prResult) {
				if (prResult.success) {
					setResult(prResult);
				} else {
					setError(prResult.error || t("taskReview:pr.errors.unknown"));
				}
			} else {
				setError(t("taskReview:pr.errors.unknown"));
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("taskReview:pr.errors.unknown"),
			);
		} finally {
			setIsCreating(false);
		}
	};

	const handleClose = () => {
		onOpenChange(false);
	};

	const handleOpenPR = () => {
		if (result?.prUrl && window.electronAPI?.openExternal) {
			window.electronAPI.openExternal(result.prUrl);
		}
	};

	const handleOpenExistingPR = () => {
		if (existingPrUrl && window.electronAPI?.openExternal) {
			window.electronAPI.openExternal(existingPrUrl);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[720px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitPullRequest className="h-5 w-5 text-primary" />
						{hasExistingPr
							? t("taskReview:pr.updateTitle")
							: t("taskReview:pr.title")}
					</DialogTitle>
					<DialogDescription>
						{hasExistingPr
							? t("taskReview:pr.updateDescription", {
									taskTitle: task.title,
								})
							: t("taskReview:pr.description", { taskTitle: task.title })}
					</DialogDescription>
				</DialogHeader>

				{/* Success State */}
				{result?.success && (
					<div className="space-y-4">
						<div className="bg-success/10 border border-success/30 rounded-lg p-4">
							<p className="text-sm text-success font-medium mb-2">
								{result.alreadyExists
									? t("taskReview:pr.success.alreadyExists")
									: t("taskReview:pr.success.created")}
							</p>
							{result.prUrl && (
								<button
									type="button"
									data-testid="pr-link-button"
									onClick={handleOpenPR}
									className="text-sm text-primary hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
								>
									{result.prUrl}
									<ExternalLink className="h-3 w-3" />
								</button>
							)}
							{result.visualProof && (
								<div className="mt-3 rounded-md border border-border bg-background/60 p-3 text-sm">
									<p className="font-medium">
										{t("taskReview:pr.visualProof.title")}:{" "}
										{t(
											`taskReview:pr.visualProof.status.${result.visualProof.status}`,
										)}
									</p>
									{result.visualProof.screenshots.length > 0 && (
										<p className="text-muted-foreground">
											{t("taskReview:pr.visualProof.screenshots", {
												count: result.visualProof.screenshots.length,
											})}
										</p>
									)}
									{result.visualProof.error && (
										<p className="text-muted-foreground">
											{result.visualProof.error}
										</p>
									)}
									{result.visualProof.commentUrl && (
										<button
											type="button"
											onClick={() => {
												const url = result.visualProof?.commentUrl;
												if (url) window.electronAPI?.openExternal?.(url);
											}}
											className="mt-2 text-xs text-primary hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
										>
											{t("taskReview:pr.visualProof.openComment")}
											<ExternalLink className="h-3 w-3" />
										</button>
									)}
									{result.visualProof.status !== "passed" && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="mt-2"
											disabled={isRetryingProof}
											onClick={handleRetryVisualProof}
										>
											{isRetryingProof && (
												<Loader2 className="h-3 w-3 animate-spin" />
											)}
											{t("taskReview:pr.visualProof.retry")}
										</Button>
									)}
								</div>
							)}
						</div>
						<DialogFooter>
							<Button onClick={handleClose}>{t("common:buttons.close")}</Button>
						</DialogFooter>
					</div>
				)}

				{/* Error State */}
				{error && !result?.success && (
					<div className="space-y-4">
						<div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4">
							<p className="text-sm text-destructive">{error}</p>
						</div>
						<DialogFooter>
							<Button variant="outline" onClick={handleClose}>
								{t("common:buttons.cancel")}
							</Button>
							<Button onClick={handleCreatePR} disabled={isCreating}>
								{t("taskReview:pr.actions.retry")}
							</Button>
						</DialogFooter>
					</div>
				)}

				{/* Form State */}
				{!result?.success && !error && (
					<div className="space-y-4">
						{/* Existing PR banner — when a PR already exists, creating
							again just pushes a new commit onto it. Make that explicit. */}
						{hasExistingPr && (
							<div className="bg-info/10 border border-info/30 rounded-lg p-3 space-y-1">
								<p className="text-sm text-info font-medium">
									{t("taskReview:pr.existingNotice")}
								</p>
								<button
									type="button"
									onClick={handleOpenExistingPR}
									className="text-xs text-primary hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer p-0 break-all text-left"
								>
									{existingPrUrl}
									<ExternalLink className="h-3 w-3 shrink-0" />
								</button>
							</div>
						)}

						{/* Branch Info */}
						<div
							className="bg-muted/50 rounded-lg p-3 text-sm"
							data-testid="pr-stats-container"
						>
							<div className="flex justify-between mb-1">
								<span className="text-muted-foreground">
									{t("taskReview:pr.labels.sourceBranch")}:
								</span>
								<span className="font-mono">
									{worktreeStatus?.branch || t("taskReview:pr.labels.unknown")}
								</span>
							</div>
							{worktreeStatus?.exists && (
								<>
									<div className="flex justify-between mb-1">
										<span className="text-muted-foreground">
											{t("taskReview:pr.labels.commits")}:
										</span>
										<span>{worktreeStatus.commitCount || 0}</span>
									</div>
									<div className="flex justify-between">
										<span className="text-muted-foreground">
											{t("taskReview:pr.labels.changes")}:
										</span>
										<span>
											<span className="text-success">
												+{worktreeStatus.additions || 0}
											</span>
											{" / "}
											<span className="text-destructive">
												-{worktreeStatus.deletions || 0}
											</span>
										</span>
									</div>
								</>
							)}
						</div>

						{/* Garde-fou : avertir l'utilisateur quand la branche du worktree
							n'a aucun commit en avance de la cible (PR vide garantie). */}
						{worktreeStatus?.exists &&
							(worktreeStatus.commitCount ?? 0) === 0 &&
							(worktreeStatus.filesChanged ?? 0) === 0 && (
								<div
									className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-warning-foreground"
									data-testid="pr-empty-warning"
									role="alert"
								>
									{t("taskReview:pr.warnings.emptyBranch", {
										base:
											worktreeStatus.baseBranch ||
											t("taskReview:pr.labels.unknown"),
										defaultValue:
											"Aucun commit à pousser : la branche est identique à « {{base}} ». La PR serait vide. Vérifiez que l'agent a bien commité ses changements ou qu'il ne s'agit pas d'une tâche dupliquée déjà fusionnée.",
									})}
								</div>
							)}

						{/* Target Branch */}
						<div className="space-y-2">
							<Label htmlFor="targetBranch">
								{t("taskReview:pr.labels.targetBranch")}
							</Label>
							<Input
								id="targetBranch"
								value={targetBranch}
								onChange={(e) => setTargetBranch(e.target.value)}
								placeholder={worktreeStatus?.baseBranch || "main"}
							/>
							<p className="text-xs text-muted-foreground">
								{t("taskReview:pr.hints.targetBranch")}
							</p>
						</div>

						{/* PR Title (optional) */}
						<div className="space-y-2">
							<Label htmlFor="prTitle">
								{t("taskReview:pr.labels.prTitle")}
							</Label>
							<Input
								id="prTitle"
								value={prTitle}
								onChange={(e) => setPrTitle(e.target.value)}
								placeholder={task.title}
							/>
							<p className="text-xs text-muted-foreground">
								{t("taskReview:pr.hints.prTitle")}
							</p>
						</div>

						{/* Impact Analysis */}
						<div className="space-y-3 border-t pt-3">
							<div className="flex items-center justify-between">
								<Label className="text-sm font-medium">
									{t("taskReview:pr.impact.title")}
								</Label>
								{isAnalyzing && (
									<span className="text-xs text-muted-foreground flex items-center gap-1">
										<Loader2 className="h-3 w-3 animate-spin" />
										{t("taskReview:pr.impact.analyzing")}
									</span>
								)}
							</div>

							{analysisError && !isAnalyzing && (
								<p className="text-xs text-muted-foreground italic">
									{t("taskReview:pr.impact.analysisFailedHint")}
								</p>
							)}

							{/* Champs renseignés automatiquement par l'IA, en lecture seule */}
							<p className="text-xs text-muted-foreground italic">
								{t("taskReview:pr.impact.aiFilledHint")}
							</p>

							<div className="space-y-2">
								<Label htmlFor="impact-rating" className="text-xs">
									{t("taskReview:pr.impact.ratingLabel")}
								</Label>
								<output
									id="impact-rating"
									aria-label={t("taskReview:pr.impact.ratingLabel")}
									className="flex h-9 w-32 items-center rounded-md border border-input bg-muted px-3 text-sm"
								>
									{isAnalyzing
										? "…"
										: impactRating === "1"
											? `1 — ${t("taskReview:pr.impact.rating1")}`
											: impactRating === "5"
												? `5 — ${t("taskReview:pr.impact.rating5")}`
												: impactRating}
								</output>
								<p className="text-xs text-muted-foreground">
									{t("taskReview:pr.impact.ratingHint")}
								</p>
							</div>

							<div className="space-y-2">
								<Label htmlFor="impact-features" className="text-xs">
									{t("taskReview:pr.impact.featuresLabel")}
								</Label>
								<Textarea
									id="impact-features"
									value={impactFeatures}
									readOnly
									placeholder={t("taskReview:pr.impact.featuresPlaceholder")}
									disabled={isAnalyzing}
									rows={2}
									className="resize-none bg-muted"
								/>
								<p className="text-xs text-muted-foreground">
									{t("taskReview:pr.impact.featuresHint")}
								</p>
							</div>
						</div>

						{/* Draft PR Checkbox */}
						<div className="flex items-center gap-2">
							<Checkbox
								id="draft-pr-checkbox"
								checked={isDraft}
								onCheckedChange={(checked) => setIsDraft(checked === true)}
							/>
							<label
								htmlFor="draft-pr-checkbox"
								className="text-sm cursor-pointer"
							>
								{t("taskReview:pr.labels.draftPR")}
							</label>
						</div>

						<DialogFooter>
							<Button
								variant="outline"
								onClick={handleClose}
								disabled={isCreating}
							>
								{t("common:buttons.cancel")}
							</Button>
							<Button
								onClick={handleCreatePR}
								disabled={
									isCreating ||
									(worktreeStatus?.exists === true &&
										(worktreeStatus.commitCount ?? 0) === 0 &&
										(worktreeStatus.filesChanged ?? 0) === 0)
								}
							>
								{isCreating ? (
									<>
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										{hasExistingPr
											? t("taskReview:pr.actions.updating")
											: t("taskReview:pr.actions.creating")}
									</>
								) : (
									<>
										<GitPullRequest className="mr-2 h-4 w-4" />
										{hasExistingPr
											? t("taskReview:pr.actions.update")
											: t("taskReview:pr.actions.create")}
									</>
								)}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
