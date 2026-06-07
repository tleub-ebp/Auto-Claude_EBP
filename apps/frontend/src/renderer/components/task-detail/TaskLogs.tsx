import {
	AlertTriangle,
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
	Terminal,
	Wrench,
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
	buildThinkingMetadataUpdate,
	LOG_PHASE_TO_CONFIG_PHASE,
} from "../../../shared/utils/task-thinking";
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
}

const PHASE_ORDER: TaskLogPhase[] = ["planning", "coding", "validation"];

const PHASE_LABELS: Record<TaskLogPhase, string> = {
	planning: "Planning",
	coding: "Coding",
	validation: "Validation",
};

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

// Helper to get model and thinking info for a log phase
function getPhaseConfig(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
): { model: string; thinking: string; thinkingValue: ThinkingLevel } | null {
	if (!metadata) return null;

	const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];

	// Auto profile with per-phase config
	if (
		metadata.isAutoProfile &&
		metadata.phaseModels &&
		metadata.phaseThinking
	) {
		const model = metadata.phaseModels[configPhase];
		const thinking = metadata.phaseThinking[configPhase];
		return {
			model: MODEL_SHORT_LABELS[model] || model,
			thinking: THINKING_SHORT_LABELS[thinking] || thinking,
			thinkingValue: thinking,
		};
	}

	// Non-auto profile with single model/thinking
	if (metadata.model && metadata.thinkingLevel) {
		return {
			model: MODEL_SHORT_LABELS[metadata.model] || metadata.model,
			thinking:
				THINKING_SHORT_LABELS[metadata.thinkingLevel] || metadata.thinkingLevel,
			thinkingValue: metadata.thinkingLevel,
		};
	}

	return null;
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
}: TaskLogsProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [savingPhase, setSavingPhase] = useState<TaskLogPhase | null>(null);

	// Persist a per-phase thinking-effort change. For Auto-profile tasks this
	// updates only the targeted phase; for single-model tasks it updates the
	// shared thinking level. The change applies when that phase next runs.
	const handleThinkingChange = useCallback(
		async (logPhase: TaskLogPhase, level: ThinkingLevel) => {
			setSavingPhase(logPhase);
			try {
				const metadata = buildThinkingMetadataUpdate(
					task.metadata,
					logPhase,
					level,
				);
				const ok = await persistUpdateTask(task.id, { metadata });
				if (!ok) throw new Error("update failed");
				toast({
					title: t("tasks:logs.thinking.updatedTitle", "Réflexion mise à jour"),
					description: t(
						"tasks:logs.thinking.updatedDesc",
						"Le niveau de réflexion sera appliqué au démarrage de cette phase.",
					),
				});
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
		[task.id, task.metadata, toast, t],
	);

	// Refs to each rendered phase section so we can detect which phase is
	// currently scrolled to the top of the viewport.
	const phaseRefs = useRef<Partial<Record<TaskLogPhase, HTMLDivElement | null>>>(
		{},
	);

	// Determine which phase section currently sits at the top of the scroll
	// container and notify the parent so the sticky phase bar can follow.
	const computeVisiblePhase = useCallback(() => {
		const container = logsContainerRef.current;
		if (!container || !onVisiblePhaseChange) return;

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
		onVisiblePhaseChange(current);
	}, [logsContainerRef, onVisiblePhaseChange]);

	const handleScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			onLogsScroll(e);
			computeVisiblePhase();
		},
		[onLogsScroll, computeVisiblePhase],
	);

	// Recompute when logs content changes (new entries, expand/collapse, load).
	// These deps trigger DOM layout changes even though computeVisiblePhase
	// reads layout via refs rather than these values directly.
	// biome-ignore lint/correctness/useExhaustiveDependencies: layout-driven recompute
	useEffect(() => {
		computeVisiblePhase();
	}, [computeVisiblePhase, phaseLogs, expandedPhases, isLoadingLogs]);

	return (
		<div
			ref={logsContainerRef}
			className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
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
									phaseConfig={getPhaseConfig(task.metadata, phase)}
									onThinkingChange={handleThinkingChange}
									isSavingThinking={savingPhase === phase}
								/>
							</div>
						))}
						<div ref={logsEndRef} />
					</>
				) : task.logs && task.logs.length > 0 ? (
					// Fallback to legacy raw logs if no phase logs exist
					<pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
						{task.logs.join("")}
						<div ref={logsEndRef} />
					</pre>
				) : (
					<div className="text-center text-sm text-muted-foreground py-8">
						<Terminal className="mx-auto mb-2 h-8 w-8 opacity-50" />
						<p>No logs yet</p>
						<p className="text-xs mt-1">
							Logs will appear here when the task runs
						</p>
					</div>
				)}
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
		thinking: string;
		thinkingValue: ThinkingLevel;
	} | null;
	onThinkingChange?: (phase: TaskLogPhase, level: ThinkingLevel) => void;
	isSavingThinking?: boolean;
}

function PhaseLogSection({
	phase,
	phaseLog,
	isExpanded,
	onToggle,
	isTaskStuck,
	phaseConfig,
	onThinkingChange,
	isSavingThinking,
}: PhaseLogSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const Icon = PHASE_ICONS[phase];
	const logOrder = useSettingsStore((s) => s.settings.logOrder);
	const status = phaseLog?.status || "pending";
	const hasEntries = (phaseLog?.entries.length || 0) > 0;

	// Memoize sorted entries to avoid re-calculating on every render
	// Entries are naturally in chronological order (oldest first from append())
	const displayedEntries = useMemo(() => {
		const entries = phaseLog?.entries || [];
		return logOrder === "reverse-chronological"
			? [...entries].reverse()
			: entries;
	}, [phaseLog?.entries, logOrder]);

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
							Interrupted
						</Badge>
					);
				}
				return (
					<Badge
						variant="outline"
						className="text-xs bg-info/10 text-info border-info/30 flex items-center gap-1"
					>
						<Loader2 className="h-3 w-3 animate-spin" />
						Running
					</Badge>
				);
			case "completed":
				return (
					<Badge
						variant="outline"
						className="text-xs bg-success/10 text-success border-success/30 flex items-center gap-1"
					>
						<CheckCircle2 className="h-3 w-3" />
						Complete
					</Badge>
				);
			case "failed":
				return (
					<Badge
						variant="outline"
						className="text-xs bg-destructive/10 text-destructive border-destructive/30 flex items-center gap-1"
					>
						<XCircle className="h-3 w-3" />
						Failed
					</Badge>
				);
			default:
				return (
					<Badge variant="secondary" className="text-xs text-muted-foreground">
						Pending
					</Badge>
				);
		}
	};

	const isInterrupted = isTaskStuck && status === "active";

	return (
		<Collapsible open={isExpanded} onOpenChange={onToggle}>
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
						<span className="font-medium text-sm">{PHASE_LABELS[phase]}</span>
						{hasEntries && (
							<span className="text-xs text-muted-foreground">
								({phaseLog?.entries.length} entries)
							</span>
						)}
					</button>
				</CollapsibleTrigger>
				<div className="flex items-center gap-2">
					{/* Model and thinking level indicator */}
					{phaseConfig && (
						<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
							<div
								className="flex items-center gap-0.5"
								title={`Model: ${phaseConfig.model}`}
							>
								<Cpu className="h-3 w-3" />
								<span>{phaseConfig.model}</span>
							</div>
							<span className="text-muted-foreground/50">|</span>
							{onThinkingChange ? (
								<Select
									value={phaseConfig.thinkingValue}
									onValueChange={(value) =>
										onThinkingChange(phase, value as ThinkingLevel)
									}
									disabled={isSavingThinking}
								>
									<SelectTrigger
										className="h-5 gap-1 border-0 bg-transparent px-1 py-0 text-[10px] text-muted-foreground hover:text-foreground focus:ring-0 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3"
										aria-label={t(
											"tasks:logs.thinking.selectAria",
											"Niveau de réflexion pour cette phase",
										)}
										title={t(
											"tasks:logs.thinking.selectTooltip",
											"Changer le niveau de réflexion pour cette phase",
										)}
									>
										{isSavingThinking ? (
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
						<p className="text-xs text-muted-foreground italic">No logs yet</p>
					) : (
						displayedEntries.map((entry) => (
							<LogEntry
								key={`${entry.timestamp}-${entry.type}-${entry.content}`}
								entry={entry}
							/>
						))
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

// Log Entry Component
interface LogEntryProps {
	entry: TaskLogEntry;
}

function LogEntry({ entry }: LogEntryProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const hasDetail = Boolean(entry.detail);

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
							title={entry.tool_input}
						>
							{entry.tool_input}
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
									<span>Hide output</span>
								</>
							) : (
								<>
									<ChevronRight className="h-2.5 w-2.5" />
									<span>Show output</span>
								</>
							)}
						</button>
					)}
				</div>
				{hasDetail && isExpanded && (
					<div className="mt-1.5 ml-4 p-2 bg-secondary/30 rounded-md border border-border/50 overflow-x-auto">
						<pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
							{entry.detail}
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
					<span className="break-words flex-1">{entry.content}</span>
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
							{entry.detail}
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
				<span className="break-words flex-1">{entry.content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	if (entry.type === "info") {
		return (
			<div className="flex items-start gap-2 text-xs text-info bg-info/10 rounded-md px-2 py-1">
				<Info className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{entry.content}</span>
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
					{entry.content}
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
						{entry.detail}
					</pre>
				</div>
			)}
		</div>
	);
}
