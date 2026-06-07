/**
 * #3.2 Cognitive Context Optimizer panel.
 *
 * Paste a prompt + a list of candidate files + a token budget → see which
 * files were included, with their relevance scores and truncation status.
 *
 * The candidate-file list is managed as a chip list, not a textarea: users
 * pick files via the native OS dialog (`electronAPI.selectFiles`) or type
 * a path manually. Each row is a separate, removable item — no parsing of
 * newline-separated paths, no silent acceptance of duplicates.
 */

import { FileText, FolderOpen, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCogContextStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";
import { TokenCostEstimate } from "./_token-cost-estimate";

const PROMPT_MAX_LEN = 4000;
const PATH_MAX_LEN = 1024;
const BUDGET_MIN = 100;
const BUDGET_MAX = 1_000_000;
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

const basename = (p: string): string => {
	const cleaned = p.replace(/[\\/]+$/, "");
	const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
	return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
};

export function CogContextPanel() {
	const { t } = useTranslation("phase35");
	const { phase, error, context, optimize } = useCogContextStore();
	const [prompt, setPrompt] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [manualPath, setManualPath] = useState("");
	const [manualError, setManualError] = useState<string | null>(null);
	const [budget, setBudget] = useState(8000);

	const isRunning = phase === "running";

	const promptError = useMemo(
		() => (prompt.trim().length === 0 ? t("cogContext.validation.promptRequired") : null),
		[prompt, t],
	);
	const filesError = useMemo(
		() => (files.length === 0 ? t("cogContext.validation.filesRequired") : null),
		[files, t],
	);
	const budgetError = useMemo(() => {
		if (!Number.isFinite(budget)) return t("common.invalidNumber");
		if (budget < BUDGET_MIN) return t("cogContext.validation.budgetTooSmall");
		if (budget > BUDGET_MAX) return t("cogContext.validation.budgetTooLarge");
		return null;
	}, [budget, t]);

	const hasError = Boolean(promptError) || Boolean(filesError) || Boolean(budgetError);

	const validateAndAdd = (path: string): string | null => {
		const trimmed = path.trim();
		if (trimmed.length === 0) return t("common.required");
		if (trimmed.length > PATH_MAX_LEN)
			return t("cogContext.validation.pathTooLong", { max: PATH_MAX_LEN });
		if (!ABSOLUTE_PATH_RE.test(trimmed))
			return t("cogContext.validation.pathNotAbsolute");
		if (files.includes(trimmed)) return t("cogContext.validation.duplicatePath");
		setFiles((prev) => [...prev, trimmed]);
		return null;
	};

	const handlePickFiles = async () => {
		try {
			const picked = await globalThis.electronAPI.selectFiles({
				multi: true,
				title: t("cogContext.addFiles"),
			});
			if (!picked || picked.length === 0) return;
			setFiles((prev) => {
				const merged = [...prev];
				for (const p of picked) {
					if (!merged.includes(p)) merged.push(p);
				}
				return merged;
			});
		} catch {
			// Picker cancellation or unavailable — leave state unchanged.
		}
	};

	const handleAddManual = () => {
		const err = validateAndAdd(manualPath);
		if (err) {
			setManualError(err);
			return;
		}
		setManualPath("");
		setManualError(null);
	};

	const handleRemove = (path: string) =>
		setFiles((prev) => prev.filter((p) => p !== path));

	const handleClearAll = () => setFiles([]);

	const handleRun = () => {
		if (hasError) return;
		optimize(prompt.trim(), files, budget);
	};

	return (
		<PanelShell
			title={t("cogContext.title")}
			subtitle={t("cogContext.subtitle")}
			error={error}
			actions={
				<Button size="sm" onClick={handleRun} disabled={isRunning || hasError}>
					{isRunning ? t("common.running") : t("cogContext.optimize")}
				</Button>
			}
		>
			<div className="space-y-3 text-sm">
				<div>
					<label htmlFor="prompt-textarea" className="block font-medium mb-1">
						{t("cogContext.prompt")}
					</label>
					<textarea
						id="prompt-textarea"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX_LEN))}
						rows={2}
						maxLength={PROMPT_MAX_LEN}
						aria-invalid={Boolean(promptError) || undefined}
						aria-describedby={promptError ? "cog-prompt-error" : undefined}
						className="w-full rounded border bg-background p-2 text-sm"
					/>
					{promptError && (
						<p id="cog-prompt-error" className="mt-1 text-xs text-destructive">
							{promptError}
						</p>
					)}
				</div>

				<div className="grid grid-cols-3 gap-3">
					<div className="col-span-2 space-y-2">
						<div className="flex items-center justify-between">
							<div className="font-medium">
								{t("cogContext.candidateFiles")}{" "}
								<span className="text-xs text-muted-foreground">
									({t("cogContext.fileCount", { count: files.length })})
								</span>
							</div>
							<div className="flex items-center gap-1">
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={handlePickFiles}
								>
									<FolderOpen className="h-3.5 w-3.5 mr-1" />
									{t("cogContext.addFiles")}
								</Button>
								{files.length > 0 && (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={handleClearAll}
										aria-label={t("cogContext.clearFiles")}
									>
										{t("cogContext.clearFiles")}
									</Button>
								)}
							</div>
						</div>

						<div
							className="rounded border bg-background"
							aria-invalid={Boolean(filesError) || undefined}
							aria-describedby={filesError ? "cog-files-error" : undefined}
						>
							{files.length === 0 ? (
								<p className="px-3 py-4 text-xs text-muted-foreground text-center">
									{t("cogContext.noFiles")}
								</p>
							) : (
								<ul className="divide-y max-h-48 overflow-auto">
									{files.map((p) => (
										<li
											key={p}
											className="flex items-center gap-2 px-2 py-1.5 text-xs"
										>
											<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											<div className="flex min-w-0 flex-1 flex-col">
												<span className="truncate font-medium">{basename(p)}</span>
												<span
													className="truncate font-mono text-[10px] text-muted-foreground"
													title={p}
												>
													{p}
												</span>
											</div>
											<button
												type="button"
												onClick={() => handleRemove(p)}
												aria-label={t("cogContext.removeFile")}
												className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
											>
												<X className="h-3.5 w-3.5" />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className="flex items-start gap-2">
							<div className="flex-1">
								<input
									value={manualPath}
									onChange={(e) => {
										setManualPath(e.target.value.slice(0, PATH_MAX_LEN));
										if (manualError) setManualError(null);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleAddManual();
										}
									}}
									maxLength={PATH_MAX_LEN}
									aria-invalid={Boolean(manualError) || undefined}
									aria-describedby={manualError ? "cog-manual-error" : undefined}
									className="w-full rounded border bg-background p-2 font-mono text-xs"
									placeholder={t("cogContext.manualPathPlaceholder")}
								/>
								{manualError && (
									<p
										id="cog-manual-error"
										className="mt-1 text-xs text-destructive"
									>
										{manualError}
									</p>
								)}
							</div>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={handleAddManual}
								disabled={manualPath.trim().length === 0}
							>
								<Plus className="h-3.5 w-3.5 mr-1" />
								{t("cogContext.add")}
							</Button>
						</div>

						{filesError && (
							<p id="cog-files-error" className="text-xs text-destructive">
								{filesError}
							</p>
						)}
					</div>

					<div>
						<label htmlFor="budget-input" className="block font-medium mb-1">
							{t("cogContext.tokenBudget")}
						</label>
						<input
							id="budget-input"
							type="number"
							min={BUDGET_MIN}
							max={BUDGET_MAX}
							step={100}
							value={budget}
							onChange={(e) => {
								const parsed = Number.parseInt(e.target.value, 10);
								setBudget(Number.isFinite(parsed) ? parsed : 0);
							}}
							aria-invalid={Boolean(budgetError) || undefined}
							aria-describedby={budgetError ? "cog-budget-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm"
						/>
						{budgetError && (
							<p id="cog-budget-error" className="mt-1 text-xs text-destructive">
								{budgetError}
							</p>
						)}
						{!budgetError && budget > 0 && (
							<TokenCostEstimate totalTokens={budget} outputRatio={0.25} />
						)}
					</div>
				</div>

				{context && (
					<div className="space-y-2">
						<div className="flex flex-wrap gap-2">
							<Badge variant="outline">
								{t("cogContext.included")}: {context.slices.length}
							</Badge>
							<Badge variant="outline">
								{t("cogContext.skipped")}: {context.files_skipped.length}
							</Badge>
							<Badge variant="outline">
								{t("cogContext.fillRatio")}:{" "}
								{((context.tokens_used / context.token_budget) * 100).toFixed(0)}%
							</Badge>
						</div>
						<table className="w-full text-sm border">
							<thead>
								<tr className="border-b bg-muted/40">
									<th className="text-left p-2">{t("cogContext.colFile")}</th>
									<th className="text-right p-2">{t("cogContext.colScore")}</th>
									<th className="text-right p-2">{t("cogContext.colTokens")}</th>
									<th className="p-2">{t("cogContext.colTruncated")}</th>
								</tr>
							</thead>
							<tbody>
								{context.slices.map((s) => (
									<tr key={s.file_path} className="border-b">
										<td className="p-2 font-mono text-xs truncate max-w-md">
											{s.file_path}
										</td>
										<td className="p-2 text-right">
											{s.relevance.score.toFixed(2)}
										</td>
										<td className="p-2 text-right">
											{s.included_tokens}/{s.full_size_tokens}
										</td>
										<td className="p-2 text-center">{s.truncated ? "✂" : ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
