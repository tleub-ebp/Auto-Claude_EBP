import {
	AlertCircle,
	CheckCircle2,
	ExternalLink,
	ImageIcon,
	Loader2,
	RefreshCw,
	Shield,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, Task, VisualProofRun } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useTaskStore } from "../../stores/task-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

interface TaskVisualProofProps {
	task: Task;
}

interface ScreenshotImagePayload {
	base64: string;
	mimeType: string;
}

function getScreenshotKey(screenshot: VisualProofRun["screenshots"][number]): string {
	return `${screenshot.relativePath}-${screenshot.capturedAt}`;
}

function isScreenshotImageResult(
	value: unknown,
): value is IPCResult<ScreenshotImagePayload> {
	if (!value || typeof value !== "object" || !("success" in value)) return false;
	const result = value as IPCResult<Partial<ScreenshotImagePayload>>;
	if (!result.success || !result.data) return true;
	return (
		typeof result.data.base64 === "string" &&
		typeof result.data.mimeType === "string"
	);
}

function getScreenshotSource(
	screenshot: VisualProofRun["screenshots"][number],
	localSources: Record<string, string>,
): string | null {
	return screenshot.url ?? localSources[getScreenshotKey(screenshot)] ?? null;
}

function getStatusVariant(
	status: VisualProofRun["status"],
): "success" | "destructive" | "warning" | "muted" {
	switch (status) {
		case "passed":
			return "success";
		case "failed":
			return "destructive";
		case "pending":
			return "warning";
		case "skipped":
			return "muted";
	}
}

export function TaskVisualProof({ task }: TaskVisualProofProps) {
	const { t } = useTranslation(["tasks"]);
	const [proof, setProof] = useState<VisualProofRun | undefined>(
		task.metadata?.visualProof,
	);
	const [isRunning, setIsRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [imageLoadError, setImageLoadError] = useState<string | null>(null);
	const [localScreenshotSources, setLocalScreenshotSources] = useState<
		Record<string, string>
	>({});
	const isMountedRef = useRef(true);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		setProof(task.metadata?.visualProof);
		setError(null);
		setImageLoadError(null);
		setLocalScreenshotSources({});
	}, [task.metadata?.visualProof]);

	// Keep the spinner in sync with the main process: a run started earlier (e.g.
	// before this tab was reopened) keeps spinning, and the button stays disabled
	// so the emulator/desktop app is never relaunched while a run is in flight.
	useEffect(() => {
		const api = globalThis.electronAPI;
		let cancelled = false;
		if (typeof api?.getVisualProofStatus === "function") {
			void api
				.getVisualProofStatus(task.id)
				.then((result) => {
					if (!cancelled && result.success && result.data) {
						setIsRunning(result.data.running);
					}
				})
				.catch(() => {
					// Best-effort: the running broadcast still keeps the tab in sync.
				});
		}
		const unsubscribe =
			typeof api?.onVisualProofRunning === "function"
				? api.onVisualProofRunning((taskId, running) => {
						if (taskId === task.id) setIsRunning(running);
					})
				: undefined;
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [task.id]);

	useEffect(() => {
		const localScreenshots =
			proof?.screenshots.filter((screenshot) => !screenshot.url) ?? [];
		setLocalScreenshotSources({});
		setImageLoadError(null);
		if (localScreenshots.length === 0) return;

		let cancelled = false;
		const loadLocalScreenshots = async () => {
			const nextSources: Record<string, string> = {};
			let firstError: string | null = null;

			for (const screenshot of localScreenshots) {
				try {
					const result = await globalThis.electronAPI.invoke(
						IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
						screenshot.absolutePath,
					);
					if (!isScreenshotImageResult(result)) {
						firstError ??= t("tasks:visualProof.imageLoadFailed");
						continue;
					}
					if (!result.success || !result.data) {
						firstError ??= result.error ?? t("tasks:visualProof.imageLoadFailed");
						continue;
					}
					nextSources[getScreenshotKey(screenshot)] =
						`data:${result.data.mimeType};base64,${result.data.base64}`;
				} catch (err) {
					firstError ??=
						err instanceof Error
							? err.message
							: t("tasks:visualProof.imageLoadFailed");
				}
			}

			if (!cancelled) {
				setLocalScreenshotSources(nextSources);
				setImageLoadError(firstError);
			}
		};

		void loadLocalScreenshots();
		return () => {
			cancelled = true;
		};
	}, [proof?.screenshots, t]);

	const latestScreenshot = useMemo(
		() => proof?.screenshots[0],
		[proof?.screenshots],
	);
	const commentUrl = proof?.commentUrl;
	const capturedUrl = proof?.appUrl;

	const handleRunVisualProof = async () => {
		setIsRunning(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI.runVisualProof(task.id);
			if (!result.success || !result.data) {
				throw new Error(result.error || t("tasks:visualProof.runFailed"));
			}
			if (!isMountedRef.current) return;
			setProof(result.data);
			useTaskStore.getState().updateTask(task.id, {
				metadata: { ...task.metadata, visualProof: result.data },
			});
		} catch (err) {
			if (isMountedRef.current) {
				setError(
					err instanceof Error ? err.message : t("tasks:visualProof.runFailed"),
				);
			}
		} finally {
			// The running broadcast is the source of truth; only touch local state
			// while still mounted to avoid a post-unmount React warning.
			if (isMountedRef.current) setIsRunning(false);
		}
	};

	if (!proof) {
		return (
			<div className="h-full flex items-center justify-center p-8">
				<div className="max-w-md text-center space-y-4">
					<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
						<ImageIcon className="h-6 w-6 text-muted-foreground" />
					</div>
					<div>
						<h3 className="text-base font-semibold">
							{t("tasks:visualProof.emptyTitle")}
						</h3>
						<p className="mt-2 text-sm text-muted-foreground">
							{t("tasks:visualProof.emptyDescription")}
						</p>
					</div>
					<Button
						type="button"
						onClick={handleRunVisualProof}
						disabled={isRunning}
						className="gap-2"
					>
						{isRunning ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<RefreshCw className="h-4 w-4" />
						)}
						{t("tasks:visualProof.run")}
					</Button>
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</div>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-5 space-y-5">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold">
								{t("tasks:visualProof.title")}
							</h3>
							<Badge variant={getStatusVariant(proof.status)}>
								{t(`tasks:visualProof.status.${proof.status}`)}
							</Badge>
							{proof.isolated !== undefined && (
								<Badge variant={proof.isolated ? "info" : "outline"}>
									<Shield className="mr-1 h-3 w-3" />
									{proof.isolated
										? t("tasks:visualProof.isolated")
										: t("tasks:visualProof.local")}
								</Badge>
							)}
						</div>
						<p className="text-sm text-muted-foreground">
							{proof.providerDetails || t("tasks:visualProof.defaultDetails")}
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						{commentUrl && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => globalThis.electronAPI.openExternal(commentUrl)}
							>
								<ExternalLink className="mr-2 h-4 w-4" />
								{t("tasks:visualProof.openComment")}
							</Button>
						)}
						{proof.prUrl && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => globalThis.electronAPI.openExternal(proof.prUrl)}
							>
								<ExternalLink className="mr-2 h-4 w-4" />
								{t("tasks:visualProof.openPr")}
							</Button>
						)}
						<Button
							type="button"
							variant="default"
							size="sm"
							onClick={handleRunVisualProof}
							disabled={isRunning}
						>
							{isRunning ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="mr-2 h-4 w-4" />
							)}
							{t("tasks:visualProof.retry")}
						</Button>
					</div>
				</div>

				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<ProofMetric
						label={t("tasks:visualProof.provider")}
						value={proof.provider ?? "-"}
					/>
					<ProofMetric
						label={t("tasks:visualProof.target")}
						value={proof.targetKind ?? "-"}
					/>
					<ProofMetric
						label={t("tasks:visualProof.framework")}
						value={proof.framework ?? "-"}
					/>
					<ProofMetric
						label={t("tasks:visualProof.completedAt")}
						value={
							proof.completedAt
								? new Date(proof.completedAt).toLocaleString()
								: "-"
						}
					/>
				</div>

				{proof.error && (
					<div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2">
						<AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
						<span>{proof.error}</span>
					</div>
				)}

				{latestScreenshot ? (
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<h4 className="text-sm font-medium">
								{t("tasks:visualProof.screenshots", {
									count: proof.screenshots.length,
								})}
							</h4>
							{capturedUrl && (
								<Button
									type="button"
									variant="link"
									size="sm"
									className="h-auto p-0"
									onClick={() => globalThis.electronAPI.openExternal(capturedUrl)}
								>
									{t("tasks:visualProof.openCapturedUrl")}
								</Button>
							)}
						</div>
						<div className="grid gap-4">
							{proof.screenshots.map((screenshot) => {
								const source = getScreenshotSource(
									screenshot,
									localScreenshotSources,
								);
								return (
									<figure
										key={getScreenshotKey(screenshot)}
										className="overflow-hidden rounded-lg border border-border bg-background"
									>
										{source ? (
											<img
												src={source}
												alt={screenshot.label}
												className="max-h-[560px] w-full object-contain bg-black/20"
											/>
										) : (
											<div className="flex min-h-64 items-center justify-center bg-black/20 text-sm text-muted-foreground">
												{t("tasks:visualProof.loadingScreenshot")}
											</div>
										)}
										<figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
											<span className="font-medium text-foreground">
												{screenshot.label}
											</span>
											<span>
												{screenshot.width} × {screenshot.height} ·{" "}
												{new Date(screenshot.capturedAt).toLocaleString()}
											</span>
										</figcaption>
									</figure>
								);
							})}
						</div>
					</div>
				) : (
					<div
						className={cn(
							"rounded-lg border border-dashed border-border p-8 text-center",
							"text-sm text-muted-foreground",
						)}
					>
						<ImageIcon className="mx-auto mb-3 h-8 w-8 opacity-50" />
						<p>{t("tasks:visualProof.noScreenshots")}</p>
					</div>
				)}

				{proof.status === "passed" && (
					<div className="flex items-center gap-2 text-sm text-success">
						<CheckCircle2 className="h-4 w-4" />
						<span>{t("tasks:visualProof.passedHint")}</span>
					</div>
				)}
				{imageLoadError && (
					<p className="text-sm text-destructive">{imageLoadError}</p>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</div>
		</ScrollArea>
	);
}

function ProofMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-border bg-background/60 p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 truncate text-sm font-medium">{value}</p>
		</div>
	);
}
