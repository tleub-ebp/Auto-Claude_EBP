import { Info, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getModelsForProvider } from "../../../shared/services/providerRegistry";
import type { Task } from "../../../shared/types";
import { getStaticProviders } from "../../../shared/utils/providers";
import { debugError } from "../../../shared/utils/debug-logger";
import { useToast } from "../../hooks/use-toast";
import { useSettingsStore } from "../../stores/settings-store";
import { Button } from "../ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../ui/tooltip";

interface TaskPauseControlsProps {
	task: Task;
	/** True once the pause flag is set on disk (task.metadata.paused.enabled). */
	isPaused?: boolean;
	/** True while the backend subprocess is still alive. */
	isRunning?: boolean;
	onPause?: (subtaskId?: string) => Promise<void>;
	/** Resume keeping the current provider (clears the flag + restarts). */
	onResumeSameProvider?: () => Promise<void>;
}

interface ProviderOption {
	name: string;
	label: string;
}

export function TaskPauseControls({
	task,
	isPaused = false,
	isRunning = false,
	onPause,
	onResumeSameProvider,
}: TaskPauseControlsProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const settings = useSettingsStore((s) => s.settings);
	const profiles = useSettingsStore((s) => s.profiles);

	const [isLoading, setIsLoading] = useState(false);
	const [isResuming, setIsResuming] = useState(false);
	const [providers, setProviders] = useState<ProviderOption[]>([]);
	const [selectedProvider, setSelectedProvider] = useState(
		task.metadata?.paused?.provider || task.metadata?.provider || "anthropic",
	);
	const [selectedModel, setSelectedModel] = useState(
		task.metadata?.paused?.model || task.metadata?.model || "",
	);

	// The task has finished its current step and the process exited — only then
	// can the user actually switch and resume. While it is still running, the
	// pause is "in flight" (finishing the current step).
	const isFullyPaused = isPaused && !isRunning;

	// Build the list of configured providers (same detection as the rest of the
	// app) once the user reaches the paused-and-stopped state.
	useEffect(() => {
		if (!isFullyPaused) return;
		let cancelled = false;
		setIsLoading(true);
		getStaticProviders(profiles, settings as unknown as Record<string, unknown>)
			.then((res) => {
				if (cancelled) return;
				const configured = res.providers
					.filter((p) => res.status[p.name] === true)
					.map((p) => ({ name: p.name, label: p.label }));
				setProviders(configured);
				// If the current selection isn't configured, fall back to the first.
				// Functional update so the effect doesn't depend on selectedProvider.
				setSelectedProvider((prev) =>
					configured.length > 0 && !configured.some((p) => p.name === prev)
						? configured[0].name
						: prev,
				);
			})
			.catch((err) => {
				debugError("[TaskPauseControls] getStaticProviders failed", err);
				if (!cancelled) setProviders([]);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isFullyPaused, profiles, settings]);

	const models = useMemo(
		() => getModelsForProvider(selectedProvider),
		[selectedProvider],
	);

	// Keep the model selection valid whenever the provider changes. Recompute the
	// model list locally and use a functional update so the only dependency is
	// the provider itself.
	useEffect(() => {
		const available = getModelsForProvider(selectedProvider);
		setSelectedModel((prev) =>
			available.some((m) => m.value === prev)
				? prev
				: (available[0]?.value ?? ""),
		);
	}, [selectedProvider]);

	const handlePause = useCallback(async () => {
		setIsLoading(true);
		try {
			await onPause?.();
			toast({
				title: t("tasks:modal.actions.pauseRequestedTitle", "Pause demandée"),
				description: t(
					"tasks:modal.actions.pauseRequestedDesc",
					"La tâche s'arrêtera à la fin de l'étape en cours.",
				),
			});
		} catch (error) {
			toast({
				title: t("tasks:modal.actions.pauseFailed", "Échec de la mise en pause"),
				description: String(error),
				variant: "destructive",
			});
		} finally {
			setIsLoading(false);
		}
	}, [onPause, toast, t]);

	const handleResumeWithProvider = useCallback(async () => {
		setIsResuming(true);
		try {
			const res = await globalThis.electronAPI?.resumeTaskWithProvider?.(
				task.id,
				selectedProvider,
				selectedModel || undefined,
			);
			if (res?.success) {
				toast({
					title: t(
						"tasks:modal.actions.resumeWithProviderSuccessTitle",
						"Reprise avec {{provider}}",
						{ provider: selectedProvider },
					),
					description: t(
						"tasks:modal.actions.resumeWithProviderSuccessDesc",
						"La conversation précédente sera rejouée vers le nouveau provider.",
					),
				});
			} else {
				toast({
					title: t(
						"tasks:modal.actions.resumeWithProviderErrorTitle",
						"Échec de la reprise",
					),
					description: res?.error || "Unknown error",
					variant: "destructive",
				});
			}
		} catch (error) {
			debugError("[TaskPauseControls] resumeTaskWithProvider failed", error);
			toast({
				title: t(
					"tasks:modal.actions.resumeWithProviderErrorTitle",
					"Échec de la reprise",
				),
				description: error instanceof Error ? error.message : String(error),
				variant: "destructive",
			});
		} finally {
			setIsResuming(false);
		}
	}, [task.id, selectedProvider, selectedModel, toast, t]);

	return (
		<div className="overflow-hidden rounded-lg border bg-muted/20">
			{/* State 1 — running, not paused: slim action bar */}
			{!isPaused && (
				<div className="flex items-center gap-3 px-3.5 py-2.5">
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<RotateCcw className="h-4 w-4" />
					</div>
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<span className="truncate text-sm font-medium">
							{t("tasks:modal.actions.providerSwitch")}
						</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={t(
										"tasks:modal.actions.providerSwitchInfoAria",
										"Détails",
									)}
									className="inline-flex shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
								>
									<Info className="h-3.5 w-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{t("tasks:modal.actions.providerSwitchDesc")}
							</TooltipContent>
						</Tooltip>
					</div>
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="shrink-0">
								<Button
									variant="outline"
									size="sm"
									onClick={handlePause}
									disabled={isLoading || !isRunning}
									aria-label={t("tasks:modal.actions.pauseToSwitch")}
								>
									{isLoading ? (
										<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
									) : (
										<RotateCcw className="mr-1.5 h-3.5 w-3.5" />
									)}
									{t("tasks:modal.actions.pauseToSwitchShort", "Mettre en pause")}
								</Button>
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{isRunning
								? t("tasks:modal.actions.pauseToSwitchTooltip")
								: t("tasks:modal.actions.pauseUnavailableTooltip")}
						</TooltipContent>
					</Tooltip>
				</div>
			)}

			{/* State 2 — pause requested but the step is still finishing */}
			{isPaused && isRunning && (
				<div className="flex items-center gap-3 px-3.5 py-2.5">
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
						<Loader2 className="h-4 w-4 animate-spin" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium">
							{t("tasks:modal.actions.providerSwitch")}
						</div>
						<div className="text-xs text-muted-foreground">
							{t(
								"tasks:modal.actions.pausingInProgress",
								"Pause en cours… fin de l'étape en cours",
							)}
						</div>
					</div>
				</div>
			)}

			{/* State 3 — fully paused: choose provider + model and resume */}
			{isFullyPaused && (
				<div className="space-y-3 px-3.5 py-3">
					<div className="flex items-center gap-3">
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Pause className="h-4 w-4" />
						</div>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium">
								{t("tasks:modal.actions.providerSwitchPaused")}
							</div>
							<div className="text-xs text-muted-foreground">
								{t("tasks:modal.actions.providerSwitchPausedDesc")}
							</div>
						</div>
					</div>

					{isLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							<span>
								{t("tasks:modal.actions.loadingProviders", "Chargement…")}
							</span>
						</div>
					) : providers.length === 0 ? (
						<div className="text-xs text-muted-foreground">
							{t(
								"tasks:modal.actions.noConfiguredProviders",
								"Aucun provider configuré. Ajoutez une clé API dans les Paramètres.",
							)}
						</div>
					) : (
						<div
							className={`grid gap-2 ${
								models.length > 0 ? "grid-cols-2" : "grid-cols-1"
							}`}
						>
							<div className="space-y-1">
								<div className="text-xs font-medium text-muted-foreground">
									{t("tasks:modal.actions.chooseProvider", "Provider")}
								</div>
								<Select
									value={selectedProvider}
									onValueChange={setSelectedProvider}
								>
									<SelectTrigger className="h-8">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{providers.map((p) => (
											<SelectItem key={p.name} value={p.name}>
												{p.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{models.length > 0 && (
								<div className="space-y-1">
									<div className="text-xs font-medium text-muted-foreground">
										{t("tasks:modal.actions.chooseModel", "Modèle")}
									</div>
									<Select
										value={selectedModel}
										onValueChange={setSelectedModel}
									>
										<SelectTrigger className="h-8">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{models.map((m) => (
												<SelectItem key={m.value} value={m.value}>
													{m.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</div>
					)}

					<div className="flex items-center gap-2">
						{onResumeSameProvider && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setIsResuming(true);
									onResumeSameProvider().finally(() => setIsResuming(false));
								}}
								disabled={isResuming}
								className="flex-1"
							>
								{t(
									"tasks:modal.actions.resumeSameProvider",
									"Reprendre sans changer de LLM",
								)}
							</Button>
						)}
						<Button
							variant="default"
							size="sm"
							onClick={handleResumeWithProvider}
							disabled={isResuming || isLoading || providers.length === 0}
							className="flex-1"
						>
							{isResuming ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Play className="mr-2 h-4 w-4" />
							)}
							{t("tasks:modal.actions.resumeWithChosenLlm", "Reprendre avec ce LLM")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
