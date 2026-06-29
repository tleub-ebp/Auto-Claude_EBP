import {
	AlertTriangle,
	ArrowDown,
	ArrowLeftRight,
	ArrowUp,
	Brain,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Columns2,
	Cpu,
	FileCode,
	FileText,
	FlaskConical,
	FolderSearch,
	Info,
	Loader2,
	Pencil,
	Search,
	Server,
	Terminal,
	Wrench,
	X,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Task,
	TaskLogEntry,
	TaskLogPhase,
	TaskLogs,
	TaskMetadata,
	TaskPhaseLog,
} from "../../../shared/types";
import type { ThinkingLevel } from "../../../shared/types/settings";
import { cn } from "../../lib/utils";
import { useToast } from "../../hooks/use-toast";
import { persistUpdateTask } from "../../stores/task-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
	getCanonicalModelKey,
	THINKING_LEVELS,
} from "../../../shared/constants/models";
import {
	buildModelMetadataUpdate,
	buildModelSelectOptions,
	buildProviderMetadataUpdate,
	buildThinkingMetadataUpdate,
	LOG_PHASE_TO_CONFIG_PHASE,
	type PhaseDefaults,
	resolvePhaseDefaults,
} from "../../../shared/utils/task-thinking";
import { getStaticProviders } from "../../../shared/utils/providers";
import { entryMatchesQuery } from "../../../shared/utils/task-logs-search";
import {
	groupEntriesByModel,
	mergeGroupsByModel,
	type ModelLogGroup,
} from "../../../shared/utils/task-logs-by-model";
import { debugError } from "../../../shared/utils/debug-logger";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { useDownloadStore } from "../../stores/download-store";
import { Badge } from "../ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { TaskPhaseBar } from "./TaskPhaseBar";
import { buildPhaseSubSteps } from "./task-log-substep";

interface TaskLogsProps {
	task: Task;
	phaseLogs: TaskLogs | null;
	/** Physical per-LLM log files (one per provider/model). A phase shows ONLY
	 * the selected model's file when present, instead of the shared feed. */
	perLlmLogs?: { provider: string; model: string; logs: TaskLogs }[];
	isLoadingLogs: boolean;
	expandedPhases: Set<TaskLogPhase>;
	isStuck: boolean;
	logsEndRef: React.RefObject<HTMLDivElement | null>;
	logsContainerRef: React.RefObject<HTMLDivElement | null>;
	onLogsScroll: (e: React.UIEvent<HTMLDivElement>) => void;
	onTogglePhase: (phase: TaskLogPhase) => void;
	onVisiblePhaseChange?: (phase: TaskLogPhase | null) => void;
	/** Phase currently visible at the top of the viewport (scroll-driven). */
	currentPhase?: TaskLogPhase | null;
	/** Live activity label surfaced in the phase bar. */
	currentActivity?: string | null;
}

const PHASE_ORDER: TaskLogPhase[] = ["planning", "coding", "validation"];

/**
 * Render `text`, wrapping every (case-insensitive) occurrence of `query` in a
 * <mark> so search hits stand out. Falls back to the raw text when there is no
 * query or no match, so non-searching renders stay allocation-free.
 */
function HighlightedText({
	text,
	query,
}: {
	text: string;
	query: string;
}): React.ReactNode {
	if (!query) return text;
	const lower = text.toLowerCase();
	let from = lower.indexOf(query);
	if (from === -1) return text;

	const parts: React.ReactNode[] = [];
	let cursor = 0;
	let key = 0;
	while (from !== -1) {
		if (from > cursor) parts.push(text.slice(cursor, from));
		parts.push(
			<mark
				key={key++}
				className="rounded-[2px] bg-amber-300/50 text-foreground dark:bg-amber-400/30"
			>
				{text.slice(from, from + query.length)}
			</mark>,
		);
		cursor = from + query.length;
		from = lower.indexOf(query, cursor);
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

const PHASE_ICONS: Record<TaskLogPhase, typeof Pencil> = {
	planning: Pencil,
	coding: FileCode,
	validation: FlaskConical,
};

const PHASE_COLORS: Record<TaskLogPhase, string> = {
	planning: "text-amber-500 bg-amber-500/10 border-amber-500/30",
	coding: "text-info bg-info/10 border-info/30",
	validation: "text-purple-500 bg-purple-500/10 border-purple-500/30",
};

// Map log phases to config phase keys
// Note: 'planning' log phase covers both spec creation and implementation planning
// (LOG_PHASE_TO_CONFIG_PHASE is imported from shared/utils/task-thinking)

// Short labels for models
const MODEL_SHORT_LABELS: Record<string, string> = {
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

// Short labels for thinking levels
const THINKING_SHORT_LABELS: Record<ThinkingLevel, string> = {
	none: "None",
	low: "Low",
	medium: "Med",
	high: "High",
	ultrathink: "Ultra",
};

// Helper to get model and thinking info for a log phase.
//
// Résolution par phase (du plus prioritaire au moins prioritaire) :
//   1. Override explicite sur la tâche (phaseModels/phaseThinking/phaseProviders)
//   2. Défaut configuré dans les Settings (résolu par provider effectif)
// Le provider effectif retombe sur le provider de la tâche puis sur le provider
// sélectionné dans les Settings. On renvoie donc toujours une config : les
// sélecteurs par phase affichent les défauts Settings tant qu'aucun override
// par phase n'est défini.
function getPhaseConfig(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	settings?: Parameters<typeof resolvePhaseDefaults>[0],
): {
	model: string;
	modelValue: string;
	thinking: string;
	thinkingValue: ThinkingLevel;
	provider: string;
} | null {
	if (!metadata) return null;

	const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];

	const provider =
		metadata.phaseProviders?.[configPhase] ||
		metadata.provider ||
		settings?.selectedProvider ||
		"anthropic";

	const defaults: PhaseDefaults = resolvePhaseDefaults(settings, provider);

	let modelValue =
		metadata.phaseModels?.[configPhase] || defaults.phaseModels[configPhase];
	// A local server runs ONE configured model for every phase (the backend
	// forces OLLAMA_MODEL), so a stale per-phase value (e.g. an old
	// "qwen2.5-coder") would mislabel the dropdown while runs are tagged with the
	// REAL model — breaking the per-LLM Logs filter/compare. Show the real model
	// so the labels match the entry tags.
	if (
		/^(ollama|local|lmstudio)$/i.test(provider) &&
		settings?.globalOllamaModel?.trim()
	) {
		modelValue = settings.globalOllamaModel.trim();
	}
	const thinkingValue =
		metadata.phaseThinking?.[configPhase] ||
		defaults.phaseThinking[configPhase];

	return {
		model: MODEL_SHORT_LABELS[modelValue] || modelValue,
		modelValue,
		thinking: THINKING_SHORT_LABELS[thinkingValue] || thinkingValue,
		thinkingValue,
		provider,
	};
}

// biome-ignore lint/suspicious/noRedeclare: redeclaration is intentional in this context
export function TaskLogs({
	task,
	phaseLogs,
	perLlmLogs,
	isLoadingLogs,
	expandedPhases,
	isStuck,
	logsEndRef,
	logsContainerRef,
	onLogsScroll,
	onTogglePhase,
	onVisiblePhaseChange,
	currentPhase,
	currentActivity,
}: TaskLogsProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [savingPhase, setSavingPhase] = useState<TaskLogPhase | null>(null);
	// Side-by-side comparison: when set, the panel swaps to a two-column view of
	// the given phase, pre-selecting two of its models. Cleared to return to the
	// normal stacked view.
	const [compare, setCompare] = useState<{
		phase: TaskLogPhase;
		leftKey: string;
		rightKey: string;
	} | null>(null);
	const settings = useSettingsStore((s) => s.settings);
	const profiles = useSettingsStore((s) => s.profiles);

	// Free-text search across all phase log entries. While a query is active,
	// each phase only renders its matching entries (and is force-expanded so the
	// hits are visible); phases with no match are hidden.
	const [searchQuery, setSearchQuery] = useState("");
	const normalizedQuery = searchQuery.trim().toLowerCase();
	const isSearching = normalizedQuery.length > 0;

	const matchCount = useMemo(() => {
		if (!isSearching || !phaseLogs) return 0;
		return PHASE_ORDER.reduce((acc, phase) => {
			const entries = phaseLogs.phases[phase]?.entries ?? [];
			return (
				acc + entries.filter((e) => entryMatchesQuery(e, normalizedQuery)).length
			);
		}, 0);
	}, [isSearching, phaseLogs, normalizedQuery]);

	const hasAnyLogs = Boolean(phaseLogs || (task.logs && task.logs.length > 0));

	// Table id → titre de sous-tâche, utilisée comme repli pour décrire la
	// sous-étape de la phase de codage sur les anciens logs (qui portent un
	// `subtask_id` sur leurs entrées mais aucune borne `subphase` structurée).
	const subtaskTitles = useMemo(() => {
		const map: Record<string, string> = {};
		for (const st of task.subtasks ?? []) {
			if (st.id) map[st.id] = st.title || st.id;
		}
		return map;
	}, [task.subtasks]);

	// Open the side-by-side comparison for a phase, pre-selecting its first two
	// models. Guarded so it never opens with fewer than two (the trigger is
	// hidden in that case anyway).
	const handleCompare = useCallback(
		(phase: TaskLogPhase) => {
			const models = mergeGroupsByModel(phaseLogs?.phases[phase]?.entries ?? []);
			if (models.length < 2) return;
			setCompare({ phase, leftKey: models[0].key, rightKey: models[1].key });
		},
		[phaseLogs],
	);

	// Configured providers shown in each phase's provider dropdown. Loaded once
	// (and refreshed when settings/profiles change) so adding an API key in
	// Settings surfaces the provider here without a remount.
	const [providers, setProviders] = useState<
		readonly { name: string; label: string }[]
	>([]);

	useEffect(() => {
		let cancelled = false;
		getStaticProviders(
			profiles,
			settings as unknown as Record<string, unknown>,
		)
			.then((res) => {
				if (cancelled) return;
				setProviders(
					res.providers
						.filter((p) => res.status[p.name] === true)
						.map((p) => ({ name: p.name, label: p.label })),
				);
			})
			.catch((err) => {
				debugError("[TaskLogs] getStaticProviders failed", err);
				if (!cancelled) setProviders([]);
			});
		return () => {
			cancelled = true;
		};
	}, [profiles, settings]);

	// Défauts par phase résolus depuis les Settings (provider, modèles, thinking).
	// Servent à la fois à l'affichage (valeur par défaut des sélecteurs) et à
	// l'amorçage de la config par phase lors d'une modification.
	const phaseDefaults = useMemo(
		() => resolvePhaseDefaults(settings, task.metadata?.provider),
		[settings, task.metadata?.provider],
	);

	// Persist a per-phase metadata change (thinking / model / provider). The
	// targeted phase is updated in isolation: the config is written per phase
	// (seeded from the resolved Settings defaults), so the other phases keep
	// their own values. The change applies when that phase next runs.
	const persistPhaseMetadata = useCallback(
		async (
			logPhase: TaskLogPhase,
			metadata: Partial<NonNullable<Task["metadata"]>>,
			updatedTitle: string,
			updatedDesc: string,
		) => {
			setSavingPhase(logPhase);
			try {
				const ok = await persistUpdateTask(task.id, { metadata });
				if (!ok) throw new Error("update failed");
				toast({ title: updatedTitle, description: updatedDesc });
			} catch (error) {
				toast({
					title: t("tasks:logs.thinking.updateFailed", "Échec de la mise à jour"),
					description: error instanceof Error ? error.message : String(error),
					variant: "destructive",
				});
			} finally {
				setSavingPhase(null);
			}
		},
		[task.id, toast, t],
	);

	const handleThinkingChange = useCallback(
		(logPhase: TaskLogPhase, level: ThinkingLevel) =>
			persistPhaseMetadata(
				logPhase,
				buildThinkingMetadataUpdate(task.metadata, logPhase, level, phaseDefaults),
				t("tasks:logs.thinking.updatedTitle", "Réflexion mise à jour"),
				t(
					"tasks:logs.thinking.updatedDesc",
					"Le niveau de réflexion sera appliqué au démarrage de cette phase.",
				),
			),
		[persistPhaseMetadata, task.metadata, phaseDefaults, t],
	);

	const handleModelChange = useCallback(
		(logPhase: TaskLogPhase, model: string) =>
			persistPhaseMetadata(
				logPhase,
				buildModelMetadataUpdate(task.metadata, logPhase, model, phaseDefaults),
				t("tasks:logs.model.updatedTitle", "Modèle mis à jour"),
				t(
					"tasks:logs.model.updatedDesc",
					"Le modèle sera appliqué au démarrage de cette phase.",
				),
			),
		[persistPhaseMetadata, task.metadata, phaseDefaults, t],
	);

	const handleProviderChange = useCallback(
		(logPhase: TaskLogPhase, provider: string) =>
			persistPhaseMetadata(
				logPhase,
				// Resolve defaults for the NEW provider so the phase's model is reset
				// to a model that provider can actually run (prevents `ollama:opus`).
				buildProviderMetadataUpdate(
					task.metadata,
					logPhase,
					provider,
					resolvePhaseDefaults(settings, provider),
				),
				t("tasks:logs.provider.updatedTitle", "Fournisseur mis à jour"),
				t(
					"tasks:logs.provider.updatedDesc",
					"Le fournisseur sera appliqué au démarrage de cette phase.",
				),
			),
		[persistPhaseMetadata, task.metadata, settings, t],
	);

	// Refs to each rendered phase section so we can detect which phase is
	// currently scrolled to the top of the viewport.
	const phaseRefs = useRef<Partial<Record<TaskLogPhase, HTMLDivElement | null>>>(
		{},
	);

	// Affiche les boutons flottants « remonter au début » / « descendre en bas »
	// selon la position de défilement dans le conteneur de logs.
	const [showScrollTop, setShowScrollTop] = useState(false);
	const [showScrollBottom, setShowScrollBottom] = useState(false);

	// Les boutons flottants ne sont révélés que lorsque la souris survole la
	// frame des logs, afin de ne pas encombrer le viewport au repos.
	const [isHoveringLogs, setIsHoveringLogs] = useState(false);

	// Sous-étape courante affichée dans la barre de phase, suivie en fonction du
	// défilement (dernière borne « phase N: NOM » passée sous le haut du
	// viewport). Mise à jour par computeVisiblePhase.
	const [visibleSubStep, setVisibleSubStep] = useState<string | null>(null);

	const scrollToTop = useCallback(() => {
		logsContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
	}, [logsContainerRef]);

	const scrollToBottom = useCallback(() => {
		const container = logsContainerRef.current;
		if (!container) return;
		container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
	}, [logsContainerRef]);

	// Remonte le conteneur de logs jusqu'au début de la section d'une phase.
	// On mesure l'écart entre le haut de la section et le haut du conteneur, ce
	// qui reste fiable quelles que soient les phases repliées au-dessus.
	const scrollPhaseIntoView = useCallback(
		(phase: TaskLogPhase) => {
			const el = phaseRefs.current[phase];
			const container = logsContainerRef.current;
			if (!el || !container) return;
			const delta =
				el.getBoundingClientRect().top - container.getBoundingClientRect().top;
			container.scrollTo({
				top: Math.max(0, container.scrollTop + delta - 8),
				behavior: "smooth",
			});
		},
		[logsContainerRef],
	);

	// Au clic sur la barre de phase : on déploie la phase ciblée si besoin (pour
	// révéler ses entrées) puis on remonte à son début. Le haut de l'en-tête de
	// section ne bouge pas avec sa propre expansion, le défilement reste donc
	// correct sans attendre la fin de l'animation.
	const handleScrollToPhase = useCallback(
		(phase: TaskLogPhase) => {
			if (!expandedPhases.has(phase)) onTogglePhase(phase);
			scrollPhaseIntoView(phase);
		},
		[expandedPhases, onTogglePhase, scrollPhaseIntoView],
	);

	// Raccourcis clavier quand le conteneur de logs a le focus :
	// - Home → remonter tout en haut, End → descendre tout en bas.
	// Le focus + les attributs ARIA sont posés impérativement pour garder un
	// viewport accessible sans alourdir le JSX d'attributs conflictuels.
	useEffect(() => {
		const container = logsContainerRef.current;
		if (!container) return;

		container.tabIndex = 0;
		container.setAttribute("role", "region");
		container.setAttribute("aria-label", t("tasks:logs.viewportAria"));

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Home") {
				e.preventDefault();
				scrollToTop();
			} else if (e.key === "End") {
				e.preventDefault();
				scrollToBottom();
			}
		};

		container.addEventListener("keydown", onKeyDown);
		return () => container.removeEventListener("keydown", onKeyDown);
	}, [logsContainerRef, scrollToTop, scrollToBottom, t]);

	// Determine which phase section currently sits at the top of the scroll
	// container and notify the parent so the sticky phase bar can follow.
	const computeVisiblePhase = useCallback(() => {
		const container = logsContainerRef.current;
		if (!container) return;

		const containerTop = container.getBoundingClientRect().top;
		let current: TaskLogPhase | null = null;
		for (const phase of PHASE_ORDER) {
			const el = phaseRefs.current[phase];
			if (!el) continue;
			// The last phase whose header has reached (or passed) the top edge of
			// the viewport is the one we are currently reading.
			if (el.getBoundingClientRect().top - containerTop <= 8) {
				current = phase;
			}
		}
		onVisiblePhaseChange?.(current);

		// Sous-étape pilotée par le défilement : on suit la dernière borne de
		// sous-étape passée sous le haut du viewport, restreinte à la phase
		// affichée (planification : « phase N: NOM » ; codage : sous-tâche ;
		// validation : passe QA). Les bornes proviennent des entrées marquées
		// `data-substep` (cf. getSubStepLabel).
		const activePhase =
			PHASE_ORDER.find((p) => phaseLogs?.phases[p]?.status === "active") ?? null;
		const displayPhase = current ?? activePhase;
		let subStep: string | null = null;
		if (displayPhase) {
			const headers = Array.from(
				container.querySelectorAll<HTMLElement>(
					`[data-substep][data-substep-phase="${displayPhase}"]`,
				),
			);
			for (const header of headers) {
				if (header.getBoundingClientRect().top - containerTop <= 8) {
					subStep = header.dataset.substep || null;
				}
			}
			// Avant d'avoir défilé sous la première borne, on affiche tout de même
			// la sous-étape initiale plutôt qu'un libellé vide.
			if (!subStep && headers.length > 0) {
				subStep = headers[0].dataset.substep || null;
			}
		}
		setVisibleSubStep(subStep);
	}, [logsContainerRef, onVisiblePhaseChange, phaseLogs]);

	// Met à jour la visibilité des boutons flottants selon la position : on
	// affiche « haut » dès qu'on s'éloigne du sommet et « bas » tant qu'on n'a
	// pas atteint le bas (avec une marge pour absorber les arrondis de layout).
	const updateScrollButtons = useCallback(() => {
		const el = logsContainerRef.current;
		if (!el) return;
		const distanceFromBottom =
			el.scrollHeight - el.scrollTop - el.clientHeight;
		const isScrollable = el.scrollHeight - el.clientHeight > 16;
		setShowScrollTop(el.scrollTop > 240);
		setShowScrollBottom(isScrollable && distanceFromBottom > 240);
	}, [logsContainerRef]);

	const handleScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			onLogsScroll(e);
			computeVisiblePhase();
			updateScrollButtons();
		},
		[onLogsScroll, computeVisiblePhase, updateScrollButtons],
	);

	// Recompute when logs content changes (new entries, expand/collapse, load).
	// These deps trigger DOM layout changes even though computeVisiblePhase
	// reads layout via refs rather than these values directly.
	// biome-ignore lint/correctness/useExhaustiveDependencies: layout-driven recompute
	useEffect(() => {
		computeVisiblePhase();
		updateScrollButtons();
	}, [
		computeVisiblePhase,
		updateScrollButtons,
		phaseLogs,
		expandedPhases,
		isLoadingLogs,
	]);

	// Comparison mode takes over the whole panel: a focused two-column view of one
	// phase's models, so two plans read side by side with their own scroll.
	if (compare && !isLoadingLogs && phaseLogs) {
		return (
			<div className="relative flex h-full flex-col">
				<PhaseCompareView
					phase={compare.phase}
					phaseLog={phaseLogs.phases[compare.phase] ?? null}
					initialLeftKey={compare.leftKey}
					initialRightKey={compare.rightKey}
					subtaskTitles={subtaskTitles}
					providers={providers}
					onClose={() => setCompare(null)}
				/>
			</div>
		);
	}

	return (
		<div
			className="relative flex h-full flex-col"
			onMouseEnter={() => setIsHoveringLogs(true)}
			onMouseLeave={() => setIsHoveringLogs(false)}
		>
			{/* Search bar — filters log entries across all phases */}
			{!isLoadingLogs && hasAnyLogs && (
				<div className="shrink-0 border-b border-border/50 p-2">
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder={t(
								"tasks:logs.search.placeholder",
								"Rechercher dans les logs…",
							)}
							aria-label={t(
								"tasks:logs.search.ariaLabel",
								"Rechercher dans les logs",
							)}
							className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-24 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
						/>
						{isSearching && (
							<div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
								<span className="text-[10px] tabular-nums text-muted-foreground">
									{t("tasks:logs.search.results", "{{count}} résultat(s)", {
										count: matchCount,
									})}
								</span>
								<button
									type="button"
									onClick={() => setSearchQuery("")}
									aria-label={t("tasks:logs.search.clear", "Effacer la recherche")}
									className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
								>
									<X className="h-3.5 w-3.5" />
								</button>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Barre de phase : nom de la phase, étape courante et sous-étape en
			    temps réel. Placée sous la recherche ; un clic remonte au début des
			    logs de la phase affichée. */}
			<TaskPhaseBar
				phaseLogs={phaseLogs}
				currentPhase={currentPhase}
				currentActivity={currentActivity}
				subStep={visibleSubStep}
				onStepClick={handleScrollToPhase}
			/>

			<div
				ref={logsContainerRef}
				className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent focus:outline-none"
				onScroll={handleScroll}
			>
				<div className="p-4 space-y-2">
					{isLoadingLogs ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					) : phaseLogs ? (
						<>
							{/* Phase-based collapsible logs */}
							{PHASE_ORDER.map((phase) => (
								<div
									key={phase}
									data-phase-section={phase}
									ref={(el) => {
										phaseRefs.current[phase] = el;
									}}
								>
									<PhaseLogSection
										phase={phase}
										phaseLog={phaseLogs.phases[phase]}
										perLlmLogs={perLlmLogs}
										isExpanded={expandedPhases.has(phase)}
										onToggle={() => onTogglePhase(phase)}
										isTaskStuck={isStuck}
										phaseConfig={getPhaseConfig(task.metadata, phase, settings)}
										providers={providers}
										onThinkingChange={handleThinkingChange}
										onModelChange={handleModelChange}
										onProviderChange={handleProviderChange}
										isSavingPhase={savingPhase === phase}
										searchQuery={normalizedQuery}
										subtaskTitles={subtaskTitles}
										onCompare={handleCompare}
									/>
								</div>
							))}
							{isSearching && matchCount === 0 && (
								<div className="py-8 text-center text-sm text-muted-foreground">
									<Search className="mx-auto mb-2 h-8 w-8 opacity-50" />
									<p>
										{t("tasks:logs.search.noResults", "Aucun résultat")}
									</p>
									<p className="mt-1 text-xs">
										{t(
											"tasks:logs.search.noResultsHint",
											"Aucune entrée de log ne correspond à « {{query}} ».",
											{ query: searchQuery.trim() },
										)}
									</p>
								</div>
							)}
							<div ref={logsEndRef} />
						</>
					) : task.logs && task.logs.length > 0 ? (
						// Fallback to legacy raw logs if no phase logs exist. When a search is
							// active, keep only the matching lines.
						<pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
							{isSearching ? task.logs.join("").split("\n").filter((line) => line.toLowerCase().includes(normalizedQuery)).join("\n") || t("tasks:logs.search.noResults", "Aucun résultat") : task.logs.join("")}
							<div ref={logsEndRef} />
						</pre>
					) : (
						<div className="text-center text-sm text-muted-foreground py-8">
							<Terminal className="mx-auto mb-2 h-8 w-8 opacity-50" />
							<p>{t("tasks:logs.empty.title")}</p>
							<p className="text-xs mt-1">
								{t("tasks:logs.empty.description")}
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Contrôles flottants de défilement : FAB circulaires centrés en bas
			    qui se déploient en pilule au survol pour révéler leur libellé. Le
			    bouton « haut » apparaît dès qu'on s'éloigne du sommet, le bouton
			    « bas » tant qu'on n'a pas atteint la fin des logs. */}
			<div className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center">
				<button
					type="button"
					onClick={scrollToTop}
					aria-label={t("tasks:logs.scrollToTop")}
					title={t("tasks:logs.scrollToTopHint")}
					className={cn(
						"group flex items-center overflow-hidden",
						"rounded-full border border-border/60 bg-background/80",
						"text-muted-foreground shadow-lg shadow-black/20 backdrop-blur-md",
						"transition-all duration-300 ease-out",
						"hover:border-primary/50 hover:bg-background/90 hover:text-foreground",
						"hover:shadow-primary/20",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
						showScrollTop && isHoveringLogs
							? "pointer-events-auto mx-1 max-w-none p-2.5 translate-y-0 scale-100 opacity-100"
							: "pointer-events-none mx-0 max-w-0 border-transparent p-0 translate-y-3 scale-90 opacity-0",
					)}
				>
					<ArrowUp className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:-translate-y-0.5" />
					<span className="max-w-0 overflow-hidden whitespace-nowrap text-xs font-medium opacity-0 transition-all duration-300 group-hover:ml-1.5 group-hover:max-w-[160px] group-hover:opacity-100">
						{t("tasks:logs.scrollToTop")}
					</span>
				</button>

				<button
					type="button"
					onClick={scrollToBottom}
					aria-label={t("tasks:logs.scrollToBottom")}
					title={t("tasks:logs.scrollToBottomHint")}
					className={cn(
						"group flex items-center overflow-hidden",
						"rounded-full border border-border/60 bg-background/80",
						"text-muted-foreground shadow-lg shadow-black/20 backdrop-blur-md",
						"transition-all duration-300 ease-out",
						"hover:border-primary/50 hover:bg-background/90 hover:text-foreground",
						"hover:shadow-primary/20",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
						showScrollBottom && isHoveringLogs
							? "pointer-events-auto mx-1 max-w-none p-2.5 translate-y-0 scale-100 opacity-100"
							: "pointer-events-none mx-0 max-w-0 border-transparent p-0 translate-y-3 scale-90 opacity-0",
					)}
				>
					<ArrowDown className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:translate-y-0.5" />
					<span className="max-w-0 overflow-hidden whitespace-nowrap text-xs font-medium opacity-0 transition-all duration-300 group-hover:ml-1.5 group-hover:max-w-[160px] group-hover:opacity-100">
						{t("tasks:logs.scrollToBottom")}
					</span>
				</button>
			</div>
		</div>
	);
}

// Phase Log Section Component
interface PhaseLogSectionProps {
	phase: TaskLogPhase;
	phaseLog: TaskPhaseLog | null;
	/** Physical per-LLM files; when the selected model has one, this phase shows
	 * ONLY that file's entries (no other models, no untagged/legacy noise). */
	perLlmLogs?: { provider: string; model: string; logs: TaskLogs }[];
	isExpanded: boolean;
	onToggle: () => void;
	isTaskStuck?: boolean;
	phaseConfig?: {
		model: string;
		modelValue: string;
		thinking: string;
		thinkingValue: ThinkingLevel;
		provider: string;
	} | null;
	providers?: readonly { name: string; label: string }[];
	onThinkingChange?: (phase: TaskLogPhase, level: ThinkingLevel) => void;
	onModelChange?: (phase: TaskLogPhase, model: string) => void;
	onProviderChange?: (phase: TaskLogPhase, provider: string) => void;
	isSavingPhase?: boolean;
	/** Active, already-lower-cased search query (empty = no filtering). */
	searchQuery?: string;
	/** Map id → titre de sous-tâche, pour le repli de sous-étape du codage. */
	subtaskTitles?: Record<string, string>;
	/** Open the side-by-side comparison for this phase (shown only when ≥2 models). */
	onCompare?: (phase: TaskLogPhase) => void;
}

function PhaseLogSection({
	phase,
	phaseLog,
	perLlmLogs,
	isExpanded,
	onToggle,
	isTaskStuck,
	phaseConfig,
	providers,
	onThinkingChange,
	onModelChange,
	onProviderChange,
	isSavingPhase,
	searchQuery = "",
	subtaskTitles,
	onCompare,
}: PhaseLogSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const startDownload = useDownloadStore((s) => s.startDownload);
	const completeDownload = useDownloadStore((s) => s.completeDownload);
	const failDownload = useDownloadStore((s) => s.failDownload);
	const Icon = PHASE_ICONS[phase];
	const logOrder = useSettingsStore((s) => s.settings.logOrder);

	// When the selected model has a physical per-LLM file, this phase shows ONLY
	// that file's entries — no other models, no untagged/legacy noise. Match by
	// provider + canonical model id; fall back to the shared phaseLog otherwise.
	const effectivePhaseLog = useMemo(() => {
		const selProvider = phaseConfig?.provider;
		const selKey = phaseConfig?.modelValue
			? getCanonicalModelKey(phaseConfig.modelValue)
			: undefined;
		if (!selProvider || !selKey) return phaseLog;
		const file = (perLlmLogs ?? []).find(
			(f) =>
				f.provider === selProvider &&
				getCanonicalModelKey(f.model) === selKey,
		);
		return file ? (file.logs.phases[phase] ?? null) : phaseLog;
	}, [
		perLlmLogs,
		phaseConfig?.provider,
		phaseConfig?.modelValue,
		phaseLog,
		phase,
	]);

	const status = effectivePhaseLog?.status || "pending";
	const isSearching = searchQuery.length > 0;

	// Live model catalog for the phase's currently-selected provider. The hook
	// is always called (provider may be "") so it complies with the rules of
	// hooks; an empty provider just yields the static fallback list.
	const { models: catalogModels } = useProviderModelCatalog(
		phaseConfig?.provider ?? "",
	);

	// Provider options: the configured providers, augmented with the current
	// one so a previously-saved (now unconfigured) provider stays visible.
	const providerOptions = useMemo(() => {
		const list = [...(providers ?? [])];
		const current = phaseConfig?.provider;
		if (current && !list.some((p) => p.name === current)) {
			list.unshift({ name: current, label: current });
		}
		return list;
	}, [providers, phaseConfig?.provider]);

	// Model options: catalog entries, augmented with the current model value so
	// it remains selectable even if the live catalog hasn't loaded it. The
	// dedupe-check compares by canonical identity (not raw `value`) so a model
	// persisted under an alternate spelling (e.g. dotted "claude-opus-4.8" left
	// over from another provider) collapses onto its single canonical catalog
	// entry instead of appearing twice.
	const { options: modelOptions, value: modelSelectValue } = useMemo(
		() =>
			buildModelSelectOptions(
				catalogModels,
				phaseConfig?.modelValue,
				MODEL_SHORT_LABELS,
			),
		[catalogModels, phaseConfig?.modelValue],
	);

	// Filtered entries in chronological order (oldest first from append()); when
	// a search is active we keep only the matching ones. Grouping is computed on
	// this order, then display order is applied below.
	//
	// Per-LLM view: show ONLY the entries produced by this phase's currently
	// selected (provider, model), so switching LLM shows that LLM's logs —
	// restoring them if they exist, empty if it hasn't run yet — while every
	// other model's logs stay on disk. Canonical id match so a short alias
	// ("opus") and a full id ("claude-opus-4-8") align. Legacy/un-attributed
	// logs (no tags at all) are left unfiltered so old tasks still render.
	const filteredEntries = useMemo(() => {
		// effectivePhaseLog is already the selected model's own file when one
		// exists (so it's a single model). The canonical filter below is then a
		// no-op, and only does real work on the shared-feed fallback.
		let entries = effectivePhaseLog?.entries || [];
		const selProvider = phaseConfig?.provider;
		const selModelKey = phaseConfig?.modelValue
			? getCanonicalModelKey(phaseConfig.modelValue)
			: undefined;
		const hasAttribution = entries.some((e) => e.provider || e.model);
		if (hasAttribution && selProvider && selModelKey) {
			entries = entries.filter(
				(e) =>
					e.provider === selProvider &&
					e.model != null &&
					getCanonicalModelKey(e.model) === selModelKey,
			);
		}
		return isSearching
			? entries.filter((e) => entryMatchesQuery(e, searchQuery))
			: entries;
	}, [
		effectivePhaseLog?.entries,
		isSearching,
		searchQuery,
		phaseConfig?.provider,
		phaseConfig?.modelValue,
	]);

	// One sub-section per (provider, model) so plans from different LLMs (e.g.
	// after a mid-phase model switch) can be compared side by side. In reverse-
	// chronological mode we flip both the group order and the entries within each
	// group, keeping every model's run contiguous.
	const modelGroups = useMemo(() => {
		const groups = groupEntriesByModel(filteredEntries);
		if (logOrder !== "reverse-chronological") return groups;
		return [...groups]
			.reverse()
			.map((g) => ({ ...g, entries: [...g.entries].reverse() }));
	}, [filteredEntries, logOrder]);

	const hasEntries = filteredEntries.length > 0;

	// The compare trigger only makes sense with ≥2 distinct attributed models.
	// Computed on the full (unfiltered) entries so it doesn't blink during search.
	const canCompare = useMemo(
		() => mergeGroupsByModel(phaseLog?.entries || []).length >= 2,
		[phaseLog?.entries],
	);

	// Local providers expose a static catalog of pullable models; flag it so the
	// model dropdown can mark which entries are actually installed vs downloadable.
	const isLocalProvider = ((phaseConfig?.provider ?? "") as string)
		.toLowerCase()
		.match(/^(ollama|local|lmstudio)$/) != null;

	// For local providers, surface installed models first so the user's actual
	// (downloaded) models sit at the top, above look-alike catalog suggestions.
	// Array.sort is stable, so the original order is preserved within each group.
	const sortedModelOptions = isLocalProvider
		? [...modelOptions].sort(
				(a, b) => Number(b.installed ?? false) - Number(a.installed ?? false),
			)
		: modelOptions;

	// Persist the chosen model; if it's a local model that isn't installed yet,
	// start pulling it now (progress surfaces in the global download indicator)
	// so it's ready by the time the phase runs — instead of silently 404-ing.
	const handleModelChange = (value: string) => {
		onModelChange?.(phase, value);
		if (!isLocalProvider) return;
		const opt = modelOptions.find((o) => o.value === value);
		if (!opt || opt.installed) return;
		const api = globalThis.electronAPI;
		if (!api?.pullOllamaModel) return;
		startDownload(value);
		toast({
			title: t("tasks:logs.model.downloadStartedTitle", "Downloading model"),
			description: t(
				"tasks:logs.model.downloadStartedDesc",
				"{{model}} is downloading in the background.",
				{ model: value },
			),
		});
		void (async () => {
			try {
				await api.ensureOllama?.();
				const res = await api.pullOllamaModel(value);
				if (res?.success) completeDownload(value);
				else failDownload(value, res?.error || "");
			} catch (e) {
				failDownload(value, e instanceof Error ? e.message : String(e));
			}
		})();
	};

	// Table « entrée → libellé de sous-étape » pour cette phase : bornes
	// structurées (nouveaux logs) ou repli sur les anciens logs (sous-tâche pour
	// le codage, session QA numérotée pour la validation). Cf. buildPhaseSubSteps.
	const subStepLabels = useMemo(
		() =>
			buildPhaseSubSteps(effectivePhaseLog?.entries || [], phase, {
				subtaskTitles,
				formatQaPass: (n) =>
					t("tasks:execution.labels.qaPass", "QA — vérification {{n}}", { n }),
			}),
		[effectivePhaseLog?.entries, phase, subtaskTitles, t],
	);

	const getStatusBadge = () => {
		switch (status) {
			case "active":
				if (isTaskStuck) {
					return (
						<Badge
							variant="outline"
							className="text-xs bg-warning/10 text-warning border-warning/30 flex items-center gap-1"
						>
							<AlertTriangle className="h-3 w-3" />
							{t("tasks:execution.labels.interrupted")}
						</Badge>
					);
				}
				return (
					<Badge
						variant="outline"
						className="text-xs bg-info/10 text-info border-info/30 flex items-center gap-1"
					>
						<Loader2 className="h-3 w-3 animate-spin" />
						{t("tasks:execution.phases.running")}
					</Badge>
				);
			case "completed":
				return (
					<Badge
						variant="outline"
						className="text-xs bg-success/10 text-success border-success/30 flex items-center gap-1"
					>
						<CheckCircle2 className="h-3 w-3" />
						{t("tasks:execution.phases.complete")}
					</Badge>
				);
			case "failed":
				return (
					<Badge
						variant="outline"
						className="text-xs bg-destructive/10 text-destructive border-destructive/30 flex items-center gap-1"
					>
						<XCircle className="h-3 w-3" />
						{t("tasks:execution.phases.failed")}
					</Badge>
				);
			default:
				return (
					<Badge variant="secondary" className="text-xs text-muted-foreground">
						{t("tasks:execution.phases.pending")}
					</Badge>
				);
		}
	};

	const isInterrupted = isTaskStuck && status === "active";

	// While searching, a phase with no matching entry is hidden entirely so the
	// results read as a flat, focused list. (All hooks above already ran.)
	if (isSearching && filteredEntries.length === 0) return null;

	return (
		<Collapsible open={isSearching || isExpanded} onOpenChange={onToggle}>
			<div
				className={cn(
					"w-full flex items-center justify-between p-3 rounded-lg border transition-colors",
					status === "active" && !isInterrupted && PHASE_COLORS[phase],
					isInterrupted && "border-warning/30 bg-warning/5",
					status === "completed" && "border-success/30 bg-success/5",
					status === "failed" && "border-destructive/30 bg-destructive/5",
					status === "pending" && "border-border bg-secondary/30",
				)}
			>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex items-center gap-2 flex-1 min-w-0 text-left rounded hover:bg-secondary/50 transition-colors"
					>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4 text-muted-foreground" />
						) : (
							<ChevronRight className="h-4 w-4 text-muted-foreground" />
						)}
						<Icon
							className={cn(
								"h-4 w-4",
								isInterrupted
									? "text-warning"
									: status === "active"
										? PHASE_COLORS[phase].split(" ")[0]
										: "text-muted-foreground",
							)}
						/>
						<span className="font-medium text-sm">
							{t(`tasks:execution.phases.${phase}`)}
						</span>
						{hasEntries && (
							<span className="text-xs text-muted-foreground">
								({filteredEntries.length}{" "}
								{t(
									filteredEntries.length === 1
										? "tasks:execution.labels.entry"
										: "tasks:execution.labels.entries",
								)}
								)
							</span>
						)}
					</button>
				</CollapsibleTrigger>
				<div className="flex items-center gap-2">
					{/* Provider / model / thinking selectors (per phase) */}
					{phaseConfig && (
						<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
							{/* Provider selector */}
							{onProviderChange ? (
								<Select
									value={phaseConfig.provider}
									onValueChange={(value) => onProviderChange(phase, value)}
									disabled={isSavingPhase}
								>
									<SelectTrigger
										className="h-6 w-auto shrink-0 gap-1 whitespace-nowrap border-0 bg-transparent px-1.5 py-0 text-[11px] text-muted-foreground hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>span]:line-clamp-none [&>span]:whitespace-nowrap [&>svg]:h-3.5 [&>svg]:w-3.5"
										aria-label={t(
											"tasks:logs.provider.selectAria",
											"Fournisseur pour cette phase",
										)}
										title={t(
											"tasks:logs.provider.selectTooltip",
											"Changer le fournisseur pour cette phase",
										)}
									>
										<Server className="h-3 w-3" />
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{providerOptions.map((p) => (
											<SelectItem key={p.name} value={p.name}>
												{p.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<div
									className="flex items-center gap-0.5"
									title={`Provider: ${phaseConfig.provider}`}
								>
									<Server className="h-3 w-3" />
									<span>{phaseConfig.provider}</span>
								</div>
							)}
							<span className="text-muted-foreground/50">|</span>
							{/* Model selector */}
							{onModelChange ? (
								<Select
									value={modelSelectValue}
									onValueChange={handleModelChange}
									disabled={isSavingPhase}
								>
									<SelectTrigger
										className="h-6 w-auto shrink-0 gap-1 whitespace-nowrap border-0 bg-transparent px-1.5 py-0 text-[11px] text-muted-foreground hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>span]:line-clamp-none [&>span]:whitespace-nowrap [&>svg]:h-3.5 [&>svg]:w-3.5"
										aria-label={t(
											"tasks:logs.model.selectAria",
											"Modèle pour cette phase",
										)}
										title={t(
											"tasks:logs.model.selectTooltip",
											"Changer le modèle pour cette phase",
										)}
									>
										<Cpu className="h-3 w-3" />
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{sortedModelOptions.map((m) => (
											<SelectItem key={m.value} value={m.value}>
												<span className="flex items-center gap-1.5">
													<span>{m.label}</span>
													{m.installed ? (
														<span className="text-[10px] text-success">
															{t("tasks:logs.model.installed", "✓ installed")}
														</span>
													) : isLocalProvider ? (
														<span className="text-[10px] text-muted-foreground">
															{t("tasks:logs.model.downloadable", "to download")}
														</span>
													) : null}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<div
									className="flex items-center gap-0.5"
									title={`Model: ${phaseConfig.model}`}
								>
									<Cpu className="h-3 w-3" />
									<span>{phaseConfig.model}</span>
								</div>
							)}
							<span className="text-muted-foreground/50">|</span>
							{/* Thinking-effort selector */}
							{onThinkingChange ? (
								<Select
									value={phaseConfig.thinkingValue}
									onValueChange={(value) =>
										onThinkingChange(phase, value as ThinkingLevel)
									}
									disabled={isSavingPhase}
								>
									<SelectTrigger
										className="h-6 w-auto shrink-0 gap-1 whitespace-nowrap border-0 bg-transparent px-1.5 py-0 text-[11px] text-muted-foreground hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>span]:line-clamp-none [&>span]:whitespace-nowrap [&>svg]:h-3.5 [&>svg]:w-3.5"
										aria-label={t(
											"tasks:logs.thinking.selectAria",
											"Niveau de réflexion pour cette phase",
										)}
										title={t(
											"tasks:logs.thinking.selectTooltip",
											"Changer le niveau de réflexion pour cette phase",
										)}
									>
										{isSavingPhase ? (
											<Loader2 className="h-3 w-3 animate-spin" />
										) : (
											<Brain className="h-3 w-3" />
										)}
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{THINKING_LEVELS.map((level) => (
											<SelectItem key={level.value} value={level.value}>
												{level.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<div
									className="flex items-center gap-0.5"
									title={`Thinking: ${phaseConfig.thinking}`}
								>
									<Brain className="h-3 w-3" />
									<span>{phaseConfig.thinking}</span>
								</div>
							)}
						</div>
					)}
					{/* Compare models side by side — only when the phase ran ≥2 models. */}
					{canCompare && onCompare && (
						<button
							type="button"
							onClick={() => onCompare(phase)}
							aria-label={t("tasks:logs.compare.openAria", "Comparer les modèles")}
							title={t(
								"tasks:logs.compare.openTooltip",
								"Comparer les plans des modèles côte à côte",
							)}
							className="flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
						>
							<Columns2 className="h-3 w-3" />
							<span className="hidden sm:inline">
								{t("tasks:logs.compare.button", "Comparer")}
							</span>
						</button>
					)}
					{getStatusBadge()}
				</div>
			</div>
			<CollapsibleContent>
				<div className="mt-1 ml-6 border-l-2 border-border pl-4 py-2 space-y-1">
					{!hasEntries ? (
						<p className="text-xs text-muted-foreground italic">
							{t("tasks:logs.phaseEmpty")}
						</p>
					) : (
						modelGroups.map((group, groupIdx) =>
							group.provider || group.model ? (
								<ModelLogGroupView
									key={`${group.key}-${groupIdx}`}
									group={group}
									phase={phase}
									searchQuery={searchQuery}
									subStepLabels={subStepLabels}
									providers={providers}
								/>
							) : (
								<PhaseEntryList
									key={`flat-${groupIdx}`}
									entries={group.entries}
									phase={phase}
									searchQuery={searchQuery}
									subStepLabels={subStepLabels}
								/>
							),
						)
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

// Renders a phase's log entries as a flat list, wiring the sub-step boundary
// markers (data-substep) so the phase bar can follow the current sub-step on
// scroll. Shared by the legacy/unattributed path and each per-model group.
function PhaseEntryList({
	entries,
	phase,
	searchQuery,
	subStepLabels,
}: {
	entries: TaskLogEntry[];
	phase: TaskLogPhase;
	searchQuery: string;
	subStepLabels: Map<TaskLogEntry, string>;
}) {
	return (
		<>
			{entries.map((entry) => {
				const key = `${entry.timestamp}-${entry.type}-${entry.content.slice(0, 80)}`;
				const subStepLabel = subStepLabels.get(entry) ?? null;
				if (subStepLabel) {
					return (
						<div
							key={key}
							data-substep={subStepLabel}
							data-substep-phase={phase}
						>
							<LogEntry entry={entry} query={searchQuery} />
						</div>
					);
				}
				return <LogEntry key={key} entry={entry} query={searchQuery} />;
			})}
		</>
	);
}

// Human-friendly provider names for the per-model group header. Falls back to
// the configured provider label, then to a capitalized raw id.
const PROVIDER_LABELS: Record<string, string> = {
	claude: "Claude",
	anthropic: "Anthropic",
	ollama: "Ollama",
	copilot: "Copilot",
	openai: "OpenAI",
	windsurf: "Windsurf",
	google: "Google",
	gemini: "Gemini",
	lmstudio: "LM Studio",
	local: "Local",
};

function formatProviderLabel(
	provider: string | undefined,
	providers?: readonly { name: string; label: string }[],
): string {
	if (!provider) return "";
	const key = provider.toLowerCase();
	const known = PROVIDER_LABELS[key];
	if (known) return known;
	const configured = providers?.find((p) => p.name.toLowerCase() === key);
	if (configured) return configured.label;
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// A collapsible sub-section grouping the entries produced by a single
// (provider, model) within a phase, so plans from different LLMs can be
// compared. Default-open; collapse to focus on one model's plan.
function ModelLogGroupView({
	group,
	phase,
	searchQuery,
	subStepLabels,
	providers,
}: {
	group: ModelLogGroup;
	phase: TaskLogPhase;
	searchQuery: string;
	subStepLabels: Map<TaskLogEntry, string>;
	providers?: readonly { name: string; label: string }[];
}) {
	const { t } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(true);
	const modelLabel =
		group.model || t("tasks:logs.modelGroup.unknownModel", "Unknown model");
	const providerLabel = formatProviderLabel(group.provider, providers);
	const count = group.entries.length;

	return (
		<div className="rounded-md border border-border/50 bg-secondary/20">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={t("tasks:logs.modelGroup.toggleAria", {
					model: modelLabel,
				})}
				className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-secondary/40"
			>
				{open ? (
					<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
				)}
				<Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
				{providerLabel && (
					<>
						<span className="text-[11px] font-medium text-foreground/80">
							{providerLabel}
						</span>
						<span className="text-muted-foreground/40">·</span>
					</>
				)}
				<span className="truncate text-[11px] font-medium text-foreground">
					{modelLabel}
				</span>
				<span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
					{count}{" "}
					{t(
						count === 1
							? "tasks:execution.labels.entry"
							: "tasks:execution.labels.entries",
					)}
				</span>
			</button>
			{open && (
				<div className="space-y-1 px-2 pb-2 pt-0.5">
					<PhaseEntryList
						entries={group.entries}
						phase={phase}
						searchQuery={searchQuery}
						subStepLabels={subStepLabels}
					/>
				</div>
			)}
		</div>
	);
}

// Provider · model label for a comparison group's selector and header.
function groupLabel(
	group: ModelLogGroup,
	providers: readonly { name: string; label: string }[] | undefined,
	unknownModel: string,
): string {
	const provider = formatProviderLabel(group.provider, providers);
	const model = group.model || unknownModel;
	return provider ? `${provider} · ${model}` : model;
}

// One column of the side-by-side comparison: a sticky header with a model picker
// (re-target the column on the fly) and an independently-scrollable body reusing
// the standard entry renderer.
function CompareColumn({
	side,
	group,
	models,
	selectedKey,
	onSelect,
	phase,
	subStepLabels,
	providers,
}: {
	side: "left" | "right";
	group: ModelLogGroup | undefined;
	models: ModelLogGroup[];
	selectedKey: string;
	onSelect: (key: string) => void;
	phase: TaskLogPhase;
	subStepLabels: Map<TaskLogEntry, string>;
	providers?: readonly { name: string; label: string }[];
}) {
	const { t } = useTranslation(["tasks"]);
	const unknownModel = t("tasks:logs.modelGroup.unknownModel", "Unknown model");
	const entries = group?.entries ?? [];
	// Distinct top accent per side for quick left/right orientation.
	const accent = side === "left" ? "border-info" : "border-purple-500";

	return (
		<div className={cn("flex min-w-0 flex-1 flex-col border-t-2", accent)}>
			<div className="sticky top-0 z-10 flex shrink-0 items-center gap-1.5 border-b border-border/50 bg-background/95 px-2 py-1.5 backdrop-blur">
				<Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<Select value={selectedKey} onValueChange={onSelect}>
					<SelectTrigger
						className="h-7 w-auto min-w-0 flex-1 gap-1 border-0 bg-transparent px-1 py-0 text-xs font-medium text-foreground focus:ring-0 focus:ring-offset-0 [&>span]:truncate"
						aria-label={t(
							"tasks:logs.compare.selectAria",
							"Choisir le modèle à comparer",
						)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{models.map((m) => (
							<SelectItem key={m.key} value={m.key}>
								{groupLabel(m, providers, unknownModel)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
					{entries.length}{" "}
					{t(
						entries.length === 1
							? "tasks:execution.labels.entry"
							: "tasks:execution.labels.entries",
					)}
				</span>
			</div>
			<div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent px-2 py-2">
				{entries.length === 0 ? (
					<p className="text-xs italic text-muted-foreground">
						{t("tasks:logs.phaseEmpty")}
					</p>
				) : (
					<PhaseEntryList
						entries={entries}
						phase={phase}
						searchQuery=""
						subStepLabels={subStepLabels}
					/>
				)}
			</div>
		</div>
	);
}

// Side-by-side comparison of two of a phase's models. Takes over the logs panel
// (full height); each column scrolls on its own so two plans read in parallel.
// Esc or the close button returns to the stacked view.
function PhaseCompareView({
	phase,
	phaseLog,
	initialLeftKey,
	initialRightKey,
	subtaskTitles,
	providers,
	onClose,
}: {
	phase: TaskLogPhase;
	phaseLog: TaskPhaseLog | null;
	initialLeftKey: string;
	initialRightKey: string;
	subtaskTitles?: Record<string, string>;
	providers?: readonly { name: string; label: string }[];
	onClose: () => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const [leftKey, setLeftKey] = useState(initialLeftKey);
	const [rightKey, setRightKey] = useState(initialRightKey);

	const models = useMemo(
		() => mergeGroupsByModel(phaseLog?.entries || []),
		[phaseLog?.entries],
	);
	const byKey = useMemo(() => new Map(models.map((m) => [m.key, m])), [models]);

	// Keep selections valid as logs stream in (a model could appear/disappear).
	useEffect(() => {
		if (models.length && !byKey.has(leftKey)) setLeftKey(models[0].key);
	}, [byKey, leftKey, models]);
	useEffect(() => {
		if (models.length && !byKey.has(rightKey)) {
			setRightKey((models[1] ?? models[0]).key);
		}
	}, [byKey, rightKey, models]);

	// Sub-step boundaries for the phase, keyed by entry reference (works in both
	// columns since each renders the same entry objects).
	const subStepLabels = useMemo(
		() =>
			buildPhaseSubSteps(phaseLog?.entries || [], phase, {
				subtaskTitles,
				formatQaPass: (n) =>
					t("tasks:execution.labels.qaPass", "QA — vérification {{n}}", { n }),
			}),
		[phaseLog?.entries, phase, subtaskTitles, t],
	);

	// Esc closes the comparison.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const swap = () => {
		setLeftKey(rightKey);
		setRightKey(leftKey);
	};

	const Icon = PHASE_ICONS[phase];

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary/30 px-3 py-2">
				<Columns2 className="h-4 w-4 shrink-0 text-primary" />
				<span className="text-sm font-semibold text-foreground">
					{t("tasks:logs.compare.title", "Comparaison des plans")}
				</span>
				<span className="flex items-center gap-1 text-xs text-muted-foreground">
					·
					<Icon
						className={cn("h-3.5 w-3.5", PHASE_COLORS[phase].split(" ")[0])}
					/>
					{t(`tasks:execution.phases.${phase}`)}
				</span>
				<button
					type="button"
					onClick={swap}
					aria-label={t("tasks:logs.compare.swapAria", "Inverser les colonnes")}
					title={t("tasks:logs.compare.swapAria", "Inverser les colonnes")}
					className="ml-auto flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
				>
					<ArrowLeftRight className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					onClick={onClose}
					aria-label={t("tasks:logs.compare.close", "Fermer")}
					className="flex h-7 items-center gap-1 rounded-md border border-border/60 px-2 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
					{t("tasks:logs.compare.close", "Fermer")}
				</button>
			</div>
			<div className="flex min-h-0 flex-1">
				<CompareColumn
					side="left"
					group={byKey.get(leftKey)}
					models={models}
					selectedKey={leftKey}
					onSelect={setLeftKey}
					phase={phase}
					subStepLabels={subStepLabels}
					providers={providers}
				/>
				<div className="w-px shrink-0 bg-border" />
				<CompareColumn
					side="right"
					group={byKey.get(rightKey)}
					models={models}
					selectedKey={rightKey}
					onSelect={setRightKey}
					phase={phase}
					subStepLabels={subStepLabels}
					providers={providers}
				/>
			</div>
		</div>
	);
}

// Log Entry Component
interface LogEntryProps {
	entry: TaskLogEntry;
	/** Active, already-lower-cased search query, for match highlighting. */
	query?: string;
}

function LogEntry({ entry, query = "" }: LogEntryProps) {
	const { t } = useTranslation(["tasks"]);
	const [isExpanded, setIsExpanded] = useState(false);
	const hasDetail = Boolean(entry.detail);

	// Pre-built highlighted nodes for the searchable fields, reused across the
	// per-type render branches below.
	const content = <HighlightedText text={entry.content ?? ""} query={query} />;
	const detail = entry.detail ? (
		<HighlightedText text={entry.detail} query={query} />
	) : null;
	const toolInput = entry.tool_input ? (
		<HighlightedText text={entry.tool_input} query={query} />
	) : null;

	const getToolInfo = (toolName: string) => {
		switch (toolName) {
			case "Read":
				return {
					icon: FileText,
					label: "Reading",
					color: "text-blue-500 bg-blue-500/10",
				};
			case "Glob":
				return {
					icon: FolderSearch,
					label: "Searching files",
					color: "text-amber-500 bg-amber-500/10",
				};
			case "Grep":
				return {
					icon: Search,
					label: "Searching code",
					color: "text-green-500 bg-green-500/10",
				};
			case "Edit":
				return {
					icon: Pencil,
					label: "Editing",
					color: "text-purple-500 bg-purple-500/10",
				};
			case "Write":
				return {
					icon: FileCode,
					label: "Writing",
					color: "text-cyan-500 bg-cyan-500/10",
				};
			case "Bash":
				return {
					icon: Terminal,
					label: "Running",
					color: "text-orange-500 bg-orange-500/10",
				};
			default:
				return {
					icon: Wrench,
					label: toolName,
					color: "text-muted-foreground bg-muted",
				};
		}
	};

	const formatTime = (timestamp: string) => {
		try {
			const date = new Date(timestamp);
			// Use system locale for date and time formatting
			return date.toLocaleString();
		} catch {
			return "";
		}
	};

	const SubphaseBadge = () => {
		if (!entry.subphase) return null;
		return (
			<Badge
				variant="outline"
				className="text-[9px] px-1 py-0 ml-1 text-muted-foreground border-muted-foreground/30"
			>
				{entry.subphase}
			</Badge>
		);
	};

	if (entry.type === "tool_start" && entry.tool_name) {
		const { icon: Icon, label, color } = getToolInfo(entry.tool_name);
		return (
			<div className="flex flex-col">
				<div
					className={cn(
						"flex items-start gap-2 rounded-md px-2 py-1 text-xs",
						color,
					)}
				>
					<Icon className="h-3 w-3 mt-0.5 shrink-0 animate-pulse" />
					<span className="font-medium shrink-0 mt-px">{label}</span>
					{entry.tool_input && (
						<span
							className="text-muted-foreground break-all whitespace-pre-wrap flex-1 min-w-0"
							title={entry.tool_input as string}
						>
							{toolInput}
						</span>
					)}
					<SubphaseBadge />
				</div>
			</div>
		);
	}

	if (entry.type === "tool_end" && entry.tool_name) {
		const { icon: Icon, color } = getToolInfo(entry.tool_name);
		return (
			<div className="flex flex-col">
				<div className="flex items-center gap-2">
					<div
						className={cn(
							"inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs",
							color,
							"opacity-60",
						)}
					>
						<Icon className="h-3 w-3" />
						<CheckCircle2 className="h-3 w-3 text-success" />
						<span className="text-muted-foreground">Done</span>
					</div>
					{hasDetail && (
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className={cn(
								"flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded",
								"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
								isExpanded && "bg-secondary/50",
							)}
						>
							{isExpanded ? (
								<>
									<ChevronDown className="h-2.5 w-2.5" />
									<span>{t("tasks:logs.hideOutput")}</span>
								</>
							) : (
								<>
									<ChevronRight className="h-2.5 w-2.5" />
									<span>{t("tasks:logs.showOutput")}</span>
								</>
							)}
						</button>
					)}
				</div>
				{hasDetail && isExpanded && (
					<div className="mt-1.5 ml-4 p-2 bg-secondary/30 rounded-md border border-border/50 overflow-x-auto">
						<pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
							{detail}
						</pre>
					</div>
				)}
			</div>
		);
	}

	if (entry.type === "error") {
		return (
			<div className="flex flex-col">
				<div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1">
					<XCircle className="h-3 w-3 mt-0.5 shrink-0" />
					<span className="break-words flex-1">{content}</span>
					<SubphaseBadge />
					{hasDetail && (
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className={cn(
								"flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0",
								"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
								isExpanded && "bg-secondary/50",
							)}
						>
							{isExpanded ? (
								<ChevronDown className="h-2.5 w-2.5" />
							) : (
								<ChevronRight className="h-2.5 w-2.5" />
							)}
						</button>
					)}
				</div>
				{hasDetail && isExpanded && (
					<div className="mt-1.5 ml-4 p-2 bg-destructive/5 rounded-md border border-destructive/20 overflow-x-auto">
						<pre className="text-[10px] text-destructive/80 whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
							{detail}
						</pre>
					</div>
				)}
			</div>
		);
	}

	if (entry.type === "success") {
		return (
			<div className="flex items-start gap-2 text-xs text-success bg-success/10 rounded-md px-2 py-1">
				<CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	if (entry.type === "info") {
		return (
			<div className="flex items-start gap-2 text-xs text-info bg-info/10 rounded-md px-2 py-1">
				<Info className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	// Default text entry
	return (
		<div className="flex flex-col">
			<div className="flex items-start gap-2 text-xs text-muted-foreground py-0.5">
				<span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
					{formatTime(entry.timestamp)}
				</span>
				<span className="break-words whitespace-pre-wrap flex-1">
					{content}
				</span>
				<SubphaseBadge />
				{hasDetail && (
					<button
						type="button"
						onClick={() => setIsExpanded(!isExpanded)}
						className={cn(
							"flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0",
							"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
							isExpanded && "bg-secondary/50",
						)}
					>
						{isExpanded ? (
							<>
								<ChevronDown className="h-2.5 w-2.5" />
								<span>Less</span>
							</>
						) : (
							<>
								<ChevronRight className="h-2.5 w-2.5" />
								<span>More</span>
							</>
						)}
					</button>
				)}
			</div>
			{hasDetail && isExpanded && (
				<div className="mt-1.5 ml-12 p-2 bg-secondary/30 rounded-md border border-border/50 overflow-x-auto">
					<pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
						{detail}
					</pre>
				</div>
			)}
		</div>
	);
}
