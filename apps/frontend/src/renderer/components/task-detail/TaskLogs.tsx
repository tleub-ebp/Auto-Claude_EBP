import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	Brain,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
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
import { THINKING_LEVELS } from "../../../shared/constants/models";
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
import { debugError } from "../../../shared/utils/debug-logger";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
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

	const modelValue =
		metadata.phaseModels?.[configPhase] || defaults.phaseModels[configPhase];
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
				buildProviderMetadataUpdate(
					task.metadata,
					logPhase,
					provider,
					phaseDefaults,
				),
				t("tasks:logs.provider.updatedTitle", "Fournisseur mis à jour"),
				t(
					"tasks:logs.provider.updatedDesc",
					"Le fournisseur sera appliqué au démarrage de cette phase.",
				),
			),
		[persistPhaseMetadata, task.metadata, phaseDefaults, t],
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
									ref={(el) => {
										phaseRefs.current[phase] = el;
									}}
								>
									<PhaseLogSection
										phase={phase}
										phaseLog={phaseLogs.phases[phase]}
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
}

function PhaseLogSection({
	phase,
	phaseLog,
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
}: PhaseLogSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const Icon = PHASE_ICONS[phase];
	const logOrder = useSettingsStore((s) => s.settings.logOrder);
	const status = phaseLog?.status || "pending";
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

	// Memoize sorted+filtered entries to avoid re-calculating on every render.
	// Entries are naturally in chronological order (oldest first from append());
	// when a search is active we keep only the matching ones.
	const displayedEntries = useMemo(() => {
		let entries = phaseLog?.entries || [];
		if (isSearching) {
			entries = entries.filter((e) => entryMatchesQuery(e, searchQuery));
		}
		return logOrder === "reverse-chronological"
			? [...entries].reverse()
			: entries;
	}, [phaseLog?.entries, logOrder, isSearching, searchQuery]);

	const hasEntries = displayedEntries.length > 0;

	// Local providers expose a static catalog of pullable models; flag it so the
	// model dropdown can mark which entries are actually installed vs downloadable.
	const isLocalProvider = ((phaseConfig?.provider ?? "") as string)
		.toLowerCase()
		.match(/^(ollama|local|lmstudio)$/) != null;

	// Table « entrée → libellé de sous-étape » pour cette phase : bornes
	// structurées (nouveaux logs) ou repli sur les anciens logs (sous-tâche pour
	// le codage, session QA numérotée pour la validation). Cf. buildPhaseSubSteps.
	const subStepLabels = useMemo(
		() =>
			buildPhaseSubSteps(phaseLog?.entries || [], phase, {
				subtaskTitles,
				formatQaPass: (n) =>
					t("tasks:execution.labels.qaPass", "QA — vérification {{n}}", { n }),
			}),
		[phaseLog?.entries, phase, subtaskTitles, t],
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
	if (isSearching && displayedEntries.length === 0) return null;

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
								({displayedEntries.length}{" "}
								{t(
									displayedEntries.length === 1
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
									onValueChange={(value) => onModelChange(phase, value)}
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
										{modelOptions.map((m) => (
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
						displayedEntries.map((entry) => {
							const key = `${entry.timestamp}-${entry.type}-${entry.content.slice(0, 80)}`;
							// Les bornes de sous-étape (« Starting phase N: NOM ») sont
							// marquées pour que TaskLogs puisse suivre la sous-étape courante
							// au défilement.
							const subStepLabel = subStepLabels.get(entry) ?? null;
							if (subStepLabel) {
								return (
									<div key={key} data-substep={subStepLabel} data-substep-phase={phase}>
										<LogEntry entry={entry} query={searchQuery} />
									</div>
								);
							}
							return <LogEntry key={key} entry={entry} query={searchQuery} />;
						})
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
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
