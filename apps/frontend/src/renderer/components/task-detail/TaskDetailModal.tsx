import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect } from "react";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	FlaskConical,
	GitMerge,
	GitPullRequest,
	Loader2,
	Pencil,
	Play,
	RotateCcw,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants";
import type {
	Task,
	TaskMetadata,
	WorktreeCreatePROptions,
} from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { calculateProgress, cn, extractTextFromHtml } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import {
	deleteTask,
	persistUpdateTask,
	recoverStuckTask,
	startTask,
	stopTask,
	submitReview,
	updatePlanSubtasks,
	useTaskStore,
} from "../../stores/task-store";
import { StreamingSessionButton } from "../streaming/StreamingSessionButton";
import { TaskEditDialog } from "../TaskEditDialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DialogMaximizeButton,
	useDialogMaximize,
} from "../ui/dialog-maximize";
import { Progress } from "../ui/progress";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../ui/tooltip";
import { useTaskDetail } from "./hooks/useTaskDetail";
import { TaskFiles } from "./TaskFiles";
import { TaskLogs } from "./TaskLogs";
import { TaskPauseControls } from "./TaskPauseControls";
import { TaskPhaseBar } from "./TaskPhaseBar";
import { pauseTask, resumeTask } from "../../stores/task-store";
import { TaskMetadata as TaskMetadataComponent } from "./TaskMetadata";
import { TaskReview } from "./TaskReview";
import { TaskSubtasks } from "./TaskSubtasks";
import { TaskVisualProof } from "./TaskVisualProof";
import { TaskWarnings } from "./TaskWarnings";
import { SyncFromBranchDialog } from "./task-review/SyncFromBranchDialog";
import { TaskEmulator } from "./TaskEmulator";

interface TaskDetailModalProps {
	readonly open: boolean;
	readonly task: Task | null;
	readonly onOpenChange: (open: boolean) => void;
	/** Navigue vers la tâche précédente dans l'ordre du Kanban. */
	readonly onNavigatePrevious?: () => void;
	/** Navigue vers la tâche suivante dans l'ordre du Kanban. */
	readonly onNavigateNext?: () => void;
	/** Indique s'il existe une tâche précédente. */
	readonly hasPrevious?: boolean;
	/** Indique s'il existe une tâche suivante. */
	readonly hasNext?: boolean;
}

/**
 * Strip HTML tags from a task title before rendering it in the modal header.
 *
 * Some imported tasks (Azure DevOps, Jira) carry their description into the
 * `title` field as raw HTML, e.g. `<div><span><b>Description:</b><br></span></div>…`.
 * React renders that verbatim — tags included — because JSX escapes strings.
 * For the title we don't want to honour the HTML structure (it would dominate
 * the header), just extract the human-readable text and let it `truncate`.
 *
 * If the title doesn't look like HTML we return it unchanged so the common
 * case stays a cheap pass-through.
 */
function cleanTitleForDisplay(title: string): string {
	if (!title) return "";
	const trimmed = title.trim();
	if (!trimmed.startsWith("<")) return title;
	const text = extractTextFromHtml(title);
	return text || title;
}

/**
 * Empêche la popin de se fermer lorsque l'utilisateur interagit avec les
 * chevrons de navigation. Ces boutons sont rendus dans le Portal mais hors
 * du `Content`, donc Radix les considère comme « extérieurs » et déclenche la
 * fermeture (pointerdown, focus ou interaction). On annule cette fermeture
 * quand la cible appartient à un élément marqué `data-task-nav`.
 */
function preventCloseOnTaskNav(
	event: { detail: { originalEvent: Event }; preventDefault: () => void },
): void {
	const target = event.detail.originalEvent.target as HTMLElement | null;
	if (target?.closest("[data-task-nav]")) {
		event.preventDefault();
	}
}


const renderTaskStatusBadges = (
	task: Task,
	state: ReturnType<typeof import("./hooks/useTaskDetail").useTaskDetail>,
	t: (key: string) => string,
	getStatusBadgeVariant: (
		status: string,
		isStuck: boolean,
	) =>
		| "success"
		| "destructive"
		| "warning"
		| "default"
		| "purple"
		| "info"
		| "secondary"
		| "outline"
		| "muted"
		| null
		| undefined,
) => {
	if (state.isStuck) {
		return (
			<Badge
				variant="warning"
				className="text-xs flex items-center gap-1 animate-pulse"
			>
				<AlertTriangle className="h-3 w-3" />
				Stuck
			</Badge>
		);
	}

	if (state.isIncomplete) {
		return (
			<Badge variant="warning" className="text-xs flex items-center gap-1">
				<AlertTriangle className="h-3 w-3" />
				Incomplete
			</Badge>
		);
	}

	return (
		<>
			<Badge
				variant={getStatusBadgeVariant(task.status, state.isStuck)}
				className={cn(
					"text-xs",
					task.status === "in_progress" && !state.isStuck && "status-running",
				)}
			>
				{t(TASK_STATUS_LABELS[task.status])}
			</Badge>
			{task.status === "human_review" && task.reviewReason && (
				<Badge
					variant={getReviewReasonBadgeVariant(task.reviewReason)}
					className="text-xs"
				>
					{getReviewReasonBadgeText(task.reviewReason, t)}
				</Badge>
			)}
		</>
	);
};

const getReviewReasonBadgeText = (
	reviewReason: string,
	t: (key: string) => string,
): string => {
	switch (reviewReason) {
		case "completed":
			return t("tasks:modal.badges.completed");
		case "errors":
			return t("tasks:modal.badges.hasErrors");
		case "plan_review":
			return t("tasks:modal.badges.approvePlan");
		case "stopped":
			return t("tasks:modal.badges.stopped");
		default:
			return t("tasks:modal.badges.qaIssues");
	}
};

const getReviewReasonBadgeVariant = (
	reviewReason: string,
): "success" | "destructive" | "warning" => {
	switch (reviewReason) {
		case "completed":
			return "success";
		case "errors":
			return "destructive";
		default:
			return "warning";
	}
};

export function TaskDetailModal({
	open,
	task,
	onOpenChange,
	onNavigatePrevious,
	onNavigateNext,
	hasPrevious,
	hasNext,
}: TaskDetailModalProps) {
	// Don't render anything if no task
	if (!task) {
		return null;
	}

	return (
		<TaskDetailModalContent
			open={open}
			task={task}
			onOpenChange={onOpenChange}
			onCloseTask={() => onOpenChange(false)}
			onNavigatePrevious={onNavigatePrevious}
			onNavigateNext={onNavigateNext}
			hasPrevious={hasPrevious}
			hasNext={hasNext}
		/>
	);
}

// Feature flag for Files tab (enabled by default, can be disabled via localStorage)
const isFilesTabEnabled = () => {
	const flag = localStorage.getItem("use_files_tab");
	return flag === null || flag === "true"; // Enabled by default
};

// Custom hook for task handlers
function useTaskDetailHandlers(
	task: Task,
	state: ReturnType<typeof import("./hooks/useTaskDetail").useTaskDetail>,
	onOpenChange: (open: boolean) => void,
) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const activeProject = useProjectStore((s) => s.getActiveProject());

	const handleStartStop = async () => {
		if (state.isRunning && !state.isStuck) {
			stopTask(task.id);
			return;
		}

		if (state.isIncomplete) {
			const isValid = await state.reloadPlanForIncompleteTask();
			if (!isValid) {
				toast({
					title: "Cannot Resume Task",
					description:
						"Failed to load implementation plan. Please try again or check the task files.",
					variant: "destructive",
					duration: 5000,
				});
				return;
			}
		}

		const projectProvider = activeProject?.settings?.provider;
		const taskProvider = (task.metadata as TaskMetadata)?.provider;
		if (projectProvider && taskProvider && projectProvider !== taskProvider) {
			toast({
				title: t("tasks:providerSwitch.title"),
				description: t("tasks:providerSwitch.description", {
					from: taskProvider,
					to: projectProvider,
				}),
				duration: 4000,
			});
		}
		startTask(task.id);
	};

	const handleRecover = async () => {
		state.setIsRecovering(true);
		const result = await recoverStuckTask(task.id, { autoRestart: true });
		if (result.success) {
			state.setIsStuck(false);
			state.setHasCheckedRunning(false);
		}
		state.setIsRecovering(false);
	};

	const handleReject = async () => {
		if (!state.feedback.trim() && state.feedbackImages.length === 0) {
			return;
		}
		state.setIsSubmitting(true);
		await submitReview(task.id, false, state.feedback, state.feedbackImages);
		state.setIsSubmitting(false);
		state.setFeedback("");
		state.setFeedbackImages([]);
		// No manual reload — the file watcher will push plan updates via TASK_PROGRESS
		// when the QA subprocess writes new subtasks to implementation_plan.json
	};

	const handleDelete = async () => {
		state.setIsDeleting(true);
		state.setDeleteError(null);
		const result = await deleteTask(task.id);
		if (result.success) {
			state.setShowDeleteDialog(false);
			onOpenChange(false);
		} else {
			state.setDeleteError(result.error || "Failed to delete task");
		}
		state.setIsDeleting(false);
	};

	const handleClose = () => {
		if (state.isRunning && !state.isStuck) {
			toast({
				title: t("tasks:notifications.backgroundTaskTitle"),
				description: t("tasks:notifications.backgroundTaskDescription"),
				duration: 4000,
			});
		}
		onOpenChange(false);
	};

	const handleUpdatePlan = async (
		phases: Array<{
			name: string;
			subtasks: Array<{
				id: string;
				title?: string;
				description?: string;
				status: string;
				files?: string[];
				verification?: {
					type: string;
					run?: string;
					scenario?: string;
				};
			}>;
		}>,
	) => {
		const success = await updatePlanSubtasks(task.id, phases as Array<Record<string, unknown>>);
		if (success) {
			toast({
				title: t("tasks:plan.changesSaved"),
				duration: 3000,
			});
		} else {
			toast({
				title: t("tasks:plan.saveError"),
				variant: "destructive",
				duration: 5000,
			});
		}
	};

	const handleToggleTdd = async () => {
		const project = useProjectStore
			.getState()
			.projects.find((p) => p.id === task.projectId);
		const effective =
			(task.metadata as TaskMetadata)?.tddMode ??
			project?.settings?.tddMode ??
			false;
		const next = !effective;

		const ok = await persistUpdateTask(task.id, {
			metadata: { tddMode: next },
		});

		if (ok) {
			toast({
				title: next
					? t("tasks:tdd.enabledTitle")
					: t("tasks:tdd.disabledTitle"),
				description: next
					? t("tasks:tdd.enabledDescription")
					: t("tasks:tdd.disabledDescription"),
				duration: 3000,
			});
		} else {
			toast({
				title: t("tasks:tdd.errorTitle"),
				description: t("tasks:tdd.errorDescription"),
				variant: "destructive",
				duration: 5000,
			});
		}
	};

	return {
		handleStartStop,
		handleRecover,
		handleReject,
		handleDelete,
		handleClose,
		handleUpdatePlan,
		handleToggleTdd,
	};
}

// Separate component to use hooks only when task exists
function TaskDetailModalContent({
	open,
	task,
	onOpenChange,
	onCloseTask,
	onNavigatePrevious,
	onNavigateNext,
	hasPrevious,
	hasNext,
}: {
	readonly open: boolean;
	readonly task: Task;
	readonly onOpenChange: (open: boolean) => void;
	readonly onCloseTask?: () => void;
	readonly onNavigatePrevious?: () => void;
	readonly onNavigateNext?: () => void;
	readonly hasPrevious?: boolean;
	readonly hasNext?: boolean;
}) {
	const { t } = useTranslation(["tasks"]);
	const state = useTaskDetail({ task });
	const { maximized, toggle: toggleMaximized } = useDialogMaximize(
		"workpilot:task-detail-maximized",
	);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const allProjects = useProjectStore((s) => s.projects);
	const taskProject = allProjects.find((p) => p.id === task.projectId);
	const showFilesTab = isFilesTabEnabled();
	const progressPercent = calculateProgress(task.subtasks);
	const completedSubtasks = task.subtasks.filter(
		(s) => s.status === "completed",
	).length;
	const totalSubtasks = task.subtasks.length;

	// Activité en cours affichée dans la barre de phase : on privilégie le
	// sous-tâche actuellement traité, avec repli sur les informations de
	// progression d'exécution (message de phase, ex: « Creating implementation
	// plan... »). Indispensable pour les phases sans sous-tâches (planning).
	const currentPhaseActivity =
		task.subtasks.find((s) => s.status === "in_progress")?.title ??
		task.executionProgress?.currentSubtask ??
		task.executionProgress?.message ??
		null;

	// Extract handlers using custom hook
	const {
		handleStartStop,
		handleRecover,
		handleReject,
		handleDelete,
		handleClose,
		handleUpdatePlan,
		handleToggleTdd,
	} = useTaskDetailHandlers(task, state, onOpenChange);

	// Effective per-task TDD state: explicit task override, else project default.
	const tddEnabled =
		(task.metadata as TaskMetadata)?.tddMode ??
		taskProject?.settings?.tddMode ??
		false;
	const tddToggleDisabled = state.isRunning && !state.isStuck;

	// Navigation clavier (← / →) entre les tâches, dans l'ordre du Kanban.
	// Ignorée lorsqu'un champ est en cours d'édition ou qu'une sous-popin est ouverte.
	useEffect(() => {
		if (!open) return;
		if (!onNavigatePrevious && !onNavigateNext) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			if (event.altKey || event.ctrlKey || event.metaKey) return;

			const target = event.target as HTMLElement | null;
			if (target) {
				const tag = target.tagName;
				if (
					tag === "INPUT" ||
					tag === "TEXTAREA" ||
					tag === "SELECT" ||
					target.isContentEditable
				) {
					return;
				}
			}

			// Ne pas naviguer quand une popin secondaire est ouverte.
			if (
				state.isEditDialogOpen ||
				state.showDeleteDialog ||
				state.showSyncDialog
			) {
				return;
			}

			if (event.key === "ArrowLeft" && hasPrevious && onNavigatePrevious) {
				event.preventDefault();
				onNavigatePrevious();
			} else if (event.key === "ArrowRight" && hasNext && onNavigateNext) {
				event.preventDefault();
				onNavigateNext();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		open,
		hasPrevious,
		hasNext,
		onNavigatePrevious,
		onNavigateNext,
		state.isEditDialogOpen,
		state.showDeleteDialog,
		state.showSyncDialog,
	]);

	const handleMerge = async () => {
		state.setIsMerging(true);
		state.setWorkspaceError(null);
		try {
			const result = await globalThis.electronAPI.mergeWorktree(task.id, {
				noCommit: state.stageOnly,
			});
			if (result.success && result.data?.success) {
				if (state.stageOnly && result.data.staged) {
					state.setWorkspaceError(null);
					state.setStagedSuccess(
						result.data.message || "Changes staged in main project",
					);
					state.setStagedProjectPath(result.data.projectPath);
					state.setSuggestedCommitMessage(result.data.suggestedCommitMessage);
				} else {
					onOpenChange(false);
				}
			} else {
				state.setWorkspaceError(
					result.data?.message || result.error || "Failed to merge changes",
				);
			}
		} catch (error) {
			state.setWorkspaceError(
				error instanceof Error ? error.message : "Unknown error during merge",
			);
		} finally {
			state.setIsMerging(false);
		}
	};

	const handleDiscard = async () => {
		state.setIsDiscarding(true);
		state.setWorkspaceError(null);
		const result = await globalThis.electronAPI.discardWorktree(task.id);
		if (result.success && result.data?.success) {
			state.setShowDiscardDialog(false);
			onOpenChange(false);
		} else {
			state.setWorkspaceError(
				result.data?.message || result.error || "Failed to discard changes",
			);
		}
		state.setIsDiscarding(false);
	};

	const handleCreatePR = async (options: WorktreeCreatePROptions) => {
		state.setIsCreatingPR(true);
		try {
			const result = await globalThis.electronAPI.createWorktreePR(
				task.id,
				options,
			);
			if (result.success && result.data) {
				// Update single task in store with new status and prUrl (more efficient than reloading all tasks)
				if (
					result.data.success &&
					result.data.prUrl &&
					!result.data.alreadyExists
				) {
					useTaskStore.getState().updateTask(task.id, {
						status: "done",
						metadata: { ...task.metadata, prUrl: result.data.prUrl },
					});
				}
				return result.data;
			}
			// Propagate IPC error; let CreatePRDialog use its i18n fallback
			return {
				success: false,
				error: result.error,
				prUrl: undefined,
				alreadyExists: false,
			};
		} catch (error) {
			// Propagate actual error message; let CreatePRDialog handle i18n fallback for undefined
			return {
				success: false,
				error: error instanceof Error ? error.message : undefined,
				prUrl: undefined,
				alreadyExists: false,
			};
		} finally {
			state.setIsCreatingPR(false);
		}
	};

	// Helper function to get status badge variant
	const getStatusBadgeVariant = (status: string, isStuck: boolean) => {
		if (isStuck) return "warning";
		switch (status) {
			case "done":
				return "success";
			case "human_review":
				return "purple";
			case "in_progress":
				return "info";
			default:
				return "secondary";
		}
	};

	// Render primary action button based on state
	const renderPrimaryAction = () => {
		if (state.isStuck) {
			return (
				<Button
					variant="warning"
					onClick={handleRecover}
					disabled={state.isRecovering}
				>
					{state.isRecovering ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							{t("tasks:modal.actions.recovering")}
						</>
					) : (
						<>
							<RotateCcw className="mr-2 h-4 w-4" />
							{t("tasks:modal.actions.recoverTask")}
						</>
					)}
				</Button>
			);
		}

		if (state.isIncomplete) {
			return (
				<Button
					variant="default"
					onClick={handleStartStop}
					disabled={state.isLoadingPlan}
				>
					{state.isLoadingPlan ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							{t("tasks:modal.actions.loadingPlan")}
						</>
					) : (
						<>
							<Play className="mr-2 h-4 w-4" />
							{t("tasks:modal.actions.resumeTask")}
						</>
					)}
				</Button>
			);
		}

		if (
			task.status === "backlog" ||
			task.status === "queue" ||
			task.status === "in_progress"
		) {
			return (
				<div className="flex items-center gap-2">
					{/* Watch Live button - show when project path is available */}
					{activeProject?.path && (
						<StreamingSessionButton
							taskId={task.id}
							projectPath={activeProject.path}
						/>
					)}

					<Button
						variant={state.isRunning ? "destructive" : "default"}
						onClick={handleStartStop}
					>
						{state.isRunning ? (
							<>
								<Square className="mr-2 h-4 w-4" />
								{t("tasks:modal.actions.stopTask")}
							</>
						) : (
							<>
								<Play className="mr-2 h-4 w-4" />
								{t("tasks:modal.actions.startTask")}
							</>
						)}
					</Button>
				</div>
			);
		}

		if (task.status === "done" && task.metadata?.prUrl) {
			return (
				<div className="flex items-center gap-4">
					<div className="completion-state text-sm flex items-center gap-2 text-success">
						<CheckCircle2 className="h-5 w-5" />
						<span className="font-medium">{t("tasks:status.complete")}</span>
					</div>
					{task.metadata?.prUrl && (
						<button
							type="button"
							onClick={() => {
								if (task.metadata?.prUrl) {
									globalThis.electronAPI?.openExternal(task.metadata.prUrl);
								}
							}}
							className="completion-state text-sm flex items-center gap-2 text-info cursor-pointer hover:underline bg-transparent border-none p-0"
						>
							<GitPullRequest className="h-5 w-5" />
							<span className="font-medium">
								{t(TASK_STATUS_LABELS[task.status])}
							</span>
						</button>
					)}
				</div>
			);
		}

		if (task.status === "done") {
			return (
				<div className="completion-state text-sm flex items-center gap-2 text-success">
					<CheckCircle2 className="h-5 w-5" />
					<span className="font-medium">{t("tasks:status.complete")}</span>
				</div>
			);
		}

		return null;
	};

	return (
		<TooltipProvider delayDuration={300}>
			<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
				<DialogPrimitive.Portal>
					{/* Semi-transparent overlay - can see background content */}
					<DialogPrimitive.Overlay
						className={cn(
							"fixed inset-0 z-50 bg-black/60",
							"data-[state=open]:animate-in data-[state=closed]:animate-out",
							"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
						)}
					/>

					{/* Full-height centered modal content */}
					<DialogPrimitive.Content
						className={cn(
							"fixed left-[50%] top-4 z-50",
							"translate-x-[-50%]",
							"w-[95vw] max-w-5xl h-[calc(100vh-32px)]",
							"bg-card border border-border rounded-xl",
							"shadow-2xl overflow-hidden flex flex-col",
							"transition-[top,width,max-width,height,border-radius] ease-out",
							"data-[state=open]:animate-in data-[state=closed]:animate-out",
							"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
							"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
							"duration-200",
							// Appended last so tailwind-merge overrides the default sizing.
							maximized && "top-0 w-screen max-w-none h-screen rounded-none",
						)}
						onPointerDownOutside={preventCloseOnTaskNav}
						onFocusOutside={preventCloseOnTaskNav}
						onInteractOutside={preventCloseOnTaskNav}
					>
						{/* Header */}
						<div className="p-5 pb-4 border-b border-border shrink-0">
							<div className="flex items-start justify-between gap-4">
								<div className="flex-1 min-w-0 overflow-hidden">
									<DialogPrimitive.Title className="text-xl font-semibold leading-tight text-foreground truncate">
										{cleanTitleForDisplay(task.title)}
									</DialogPrimitive.Title>
									<DialogPrimitive.Description asChild>
										<div className="mt-2.5 flex items-center gap-2 flex-wrap">
											<Badge variant="outline" className="text-xs font-mono">
												{task.specId}
											</Badge>
											{renderTaskStatusBadges(
												task,
												state,
												t,
												getStatusBadgeVariant,
											)}
											{/* Compact progress indicator */}
											{totalSubtasks > 0 && (
												<span className="text-xs text-muted-foreground ml-1">
													{t("tasks:modal.progress.subtasks", {
														completed: completedSubtasks,
														total: totalSubtasks,
													})}
												</span>
											)}
										</div>
									</DialogPrimitive.Description>
								</div>
								<div className="flex items-center gap-1 shrink-0 electron-no-drag">
									{/* TDD override toggle — sexy emerald pill */}
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												role="switch"
												aria-checked={tddEnabled}
												aria-label={t("tasks:tdd.toggleAria")}
												onClick={handleToggleTdd}
												disabled={tddToggleDisabled}
												className={cn(
													"group mr-1 inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold tracking-wide transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50",
													tddEnabled
														? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 shadow-[0_0_14px_-3px_rgba(16,185,129,0.7)] hover:bg-emerald-500/20"
														: "border-border bg-transparent text-muted-foreground hover:border-emerald-500/30 hover:text-emerald-300/80",
												)}
											>
												<FlaskConical
													className={cn(
														"h-3.5 w-3.5 transition-transform duration-200",
														tddEnabled
															? "scale-110"
															: "group-hover:scale-110",
													)}
												/>
												<span>{t("tasks:labels.tdd")}</span>
												<span
													className={cn(
														"h-1.5 w-1.5 rounded-full transition-all duration-200",
														tddEnabled
															? "bg-emerald-400 shadow-[0_0_6px_1px_rgba(16,185,129,0.9)]"
															: "bg-muted-foreground/40",
													)}
												/>
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="max-w-[230px]">
											{tddEnabled
												? t("tasks:tdd.tooltipOn")
												: t("tasks:tdd.tooltipOff")}
										</TooltipContent>
									</Tooltip>

									{/* Sync from branch — available for any status that may have a worktree */}
									{task.status !== "done" && (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="hover:bg-primary/10 hover:text-primary transition-colors"
													onClick={() => state.setShowSyncDialog(true)}
												>
													<GitMerge className="h-4 w-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("tasks:modal.actions.syncFromBranch")}
											</TooltipContent>
										</Tooltip>
									)}
									<Button
										variant="ghost"
										size="icon"
										className="hover:bg-primary/10 hover:text-primary transition-colors"
										onClick={() => state.setIsEditDialogOpen(true)}
										disabled={state.isRunning && !state.isStuck}
									>
										<Pencil className="h-4 w-4" />
									</Button>
									<Tooltip>
										<TooltipTrigger asChild>
											<DialogMaximizeButton
												maximized={maximized}
												onToggle={toggleMaximized}
												className="h-10 w-10 hover:bg-primary/10 hover:text-primary"
												maximizeLabel={t("tasks:modal.actions.maximize")}
												restoreLabel={t("tasks:modal.actions.restore")}
											/>
										</TooltipTrigger>
										<TooltipContent side="bottom">
											{maximized
												? t("tasks:modal.actions.restore")
												: t("tasks:modal.actions.maximize")}
										</TooltipContent>
									</Tooltip>
									<DialogPrimitive.Close asChild>
										<Button
											variant="ghost"
											size="icon"
											className="hover:bg-muted transition-colors"
										>
											<X className="h-5 w-5" />
											<span className="sr-only">Close</span>
										</Button>
									</DialogPrimitive.Close>
								</div>
							</div>

							{/* Progress bar - only show when running or has progress */}
							{(state.isRunning || completedSubtasks > 0) &&
								totalSubtasks > 0 && (
									<div className="mt-3 flex items-center gap-3">
										<Progress
											value={progressPercent}
											className="h-1.5 flex-1"
										/>
										<span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
											{progressPercent}%
										</span>
									</div>
								)}

							{/* Warnings - compact inline */}
							{(state.isStuck || state.isIncomplete) && (
								<div className="mt-3">
									<TaskWarnings
										isStuck={state.isStuck}
										isIncomplete={state.isIncomplete}
										isRecovering={state.isRecovering}
										taskProgress={state.taskProgress}
										onRecover={handleRecover}
										onResume={handleStartStop}
									/>
								</div>
							)}
						</div>

						{/* Body - Single Column with Tabs */}
						<div className="flex-1 min-h-0 overflow-hidden">
							<Tabs
								value={state.activeTab}
								onValueChange={state.setActiveTab}
								className="flex flex-col h-full"
							>
								<TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent px-5 h-auto shrink-0">
									<TabsTrigger
										value="overview"
										className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
									>
										{t("tasks:modal.tabs.overview")}
									</TabsTrigger>
									<TabsTrigger
										value="subtasks"
										className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
									>
										{t("tasks:modal.tabs.subtasks", {
											count: task.subtasks.length,
										})}
									</TabsTrigger>
									<TabsTrigger
										value="logs"
										className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
									>
										{t("tasks:modal.tabs.logs")}
									</TabsTrigger>
									{showFilesTab && (
										<TabsTrigger
											value="files"
											className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
										>
											{t("tasks:files.tab")}
										</TabsTrigger>
									)}
									<TabsTrigger
										value="visualProof"
										className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
									>
										{t("tasks:visualProof.tab")}
									</TabsTrigger>
									<TabsTrigger
										value="emulator"
										className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
									>
										{t("tasks:emulator.tab")}
									</TabsTrigger>
								</TabsList>

								{/* Overview Tab */}
								<TabsContent
									value="overview"
									className="flex-1 min-h-0 overflow-hidden mt-0"
								>
									<ScrollArea className="h-full">
										<div className="p-5 space-y-5 overflow-x-hidden max-w-full">
											{/* Metadata */}
											<TaskMetadataComponent task={task} />

											{/* Human Review Section */}
											{state.needsReview && (
												<>
													<Separator />
													<TaskReview
														task={task}
														feedback={state.feedback}
														isSubmitting={state.isSubmitting}
														worktreeStatus={state.worktreeStatus}
														worktreeDiff={state.worktreeDiff}
														isLoadingWorktree={state.isLoadingWorktree}
														isMerging={state.isMerging}
														isDiscarding={state.isDiscarding}
														showDiscardDialog={state.showDiscardDialog}
														showDiffDialog={state.showDiffDialog}
														workspaceError={state.workspaceError}
														stageOnly={state.stageOnly}
														stagedSuccess={state.stagedSuccess}
														stagedProjectPath={state.stagedProjectPath}
														suggestedCommitMessage={
															state.suggestedCommitMessage
														}
														mergePreview={state.mergePreview}
														isLoadingPreview={state.isLoadingPreview}
														showConflictDialog={state.showConflictDialog}
														onFeedbackChange={state.setFeedback}
														onReject={handleReject}
														images={state.feedbackImages}
														onImagesChange={state.setFeedbackImages}
														onMerge={handleMerge}
														onDiscard={handleDiscard}
														onShowDiscardDialog={state.setShowDiscardDialog}
														onShowDiffDialog={state.setShowDiffDialog}
														onStageOnlyChange={state.setStageOnly}
														onShowConflictDialog={state.setShowConflictDialog}
														onLoadMergePreview={state.loadMergePreview}
														onClose={handleClose}
														onReviewAgain={state.handleReviewAgain}
														showPRDialog={state.showPRDialog}
														isCreatingPR={state.isCreatingPR}
														onShowPRDialog={state.setShowPRDialog}
														onCreatePR={handleCreatePR}
														onRefreshDiff={state.refreshWorktreeDiff}
													/>
												</>
											)}
										</div>
									</ScrollArea>
								</TabsContent>

								{/* Subtasks Tab */}
								<TabsContent
									value="subtasks"
									className="flex-1 min-h-0 overflow-hidden mt-0"
								>
									<TaskSubtasks task={task} onUpdatePlan={handleUpdatePlan} />
								</TabsContent>

								{/* Phase bar - only visible on Logs tab */}
								{state.activeTab === "logs" && (
									<TaskPhaseBar
										phaseLogs={state.phaseLogs}
										currentPhase={state.currentLogPhase}
										currentActivity={currentPhaseActivity}
									/>
								)}

								{/* Logs Tab */}
								<TabsContent
									value="logs"
									className="flex-1 min-h-0 overflow-hidden mt-0"
								>
									<TaskLogs
										task={task}
										phaseLogs={state.phaseLogs}
										isLoadingLogs={state.isLoadingLogs}
										expandedPhases={state.expandedPhases}
										isStuck={state.isStuck}
										logsEndRef={state.logsEndRef}
										logsContainerRef={state.logsContainerRef}
										onLogsScroll={state.handleLogsScroll}
										onTogglePhase={state.togglePhase}
										onVisiblePhaseChange={state.setCurrentLogPhase}
									/>
								</TabsContent>

								{/* Files Tab */}
								{showFilesTab && (
									<TabsContent
										value="files"
										className="flex-1 min-h-0 overflow-hidden mt-0"
									>
										<TaskFiles task={task} />
									</TabsContent>
								)}

								{/* Visual Proof Tab */}
								<TabsContent
									value="visualProof"
									className="flex-1 min-h-0 overflow-hidden mt-0"
								>
									<TaskVisualProof task={task} />
								</TabsContent>

								{/* Emulator Tab */}
								<TabsContent
									value="emulator"
									className="flex-1 min-h-0 overflow-hidden mt-0"
								>
									<TaskEmulator
										taskId={task.id}
										project={taskProject ?? activeProject}
										worktreePath={state.worktreeStatus?.worktreePath}
									/>
								</TabsContent>
							</Tabs>
						</div>

						{/* Footer */}
						<div className="border-t border-border shrink-0">
							{/* Pause/Resume Controls - shown at bottom when paused or running */}
							{(task.metadata?.paused?.enabled || (state.isRunning && !state.isStuck)) && (
								<div className="px-5 py-3 border-b border-border">
									<TaskPauseControls
										task={task}
										isPaused={task.metadata?.paused?.enabled}
										isRunning={
											task.metadata?.paused?.enabled
												? state.pauseProcessAlive !== false
												: state.isRunning
										}
										onPause={async (subtaskId) => {
											await pauseTask(task.id, subtaskId);
										}}
										onResumeSameProvider={async () => {
											await resumeTask(task.id);
											await handleStartStop();
										}}
									/>
								</div>
							)}

							{/* Action buttons */}
							<div className="flex items-center gap-3 px-5 py-3">
								<Button
									variant="ghost"
									size="sm"
									className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
									onClick={() => state.setShowDeleteDialog(true)}
									disabled={state.isRunning && !state.isStuck}
								>
									<Trash2 className="mr-2 h-4 w-4" />
									{t("tasks:modal.actions.deleteTask")}
								</Button>
								<div className="flex-1" />
								{renderPrimaryAction()}
								<Button variant="outline" onClick={handleClose}>
									{t("tasks:modal.actions.close")}
								</Button>
							</div>
						</div>
					</DialogPrimitive.Content>

					{/* Chevrons de navigation entre tâches (ordre du Kanban) */}
					{(onNavigatePrevious || onNavigateNext) && (
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										data-task-nav="previous"
										aria-label={t("tasks:modal.actions.previousTask")}
										onClick={() => hasPrevious && onNavigatePrevious?.()}
										disabled={!hasPrevious}
										className={cn(
											"group fixed top-1/2 z-50 -translate-y-1/2 pointer-events-auto",
											"left-[max(0.75rem,calc(50%-min(47.5vw,32rem)-3.25rem))]",
											"flex h-11 w-11 items-center justify-center rounded-full",
											"border border-border/60 bg-card/80 backdrop-blur-md",
											"text-muted-foreground shadow-lg shadow-black/20",
											"transition-all duration-200",
											"hover:scale-110 hover:bg-primary hover:text-primary-foreground hover:border-primary",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
											"disabled:pointer-events-none disabled:opacity-0",
											// En plein écran le modal occupe tout l'écran : on épingle le
											// chevron au bord plutôt qu'à la largeur du modal centré.
											maximized && "left-3",
										)}
									>
										<ChevronLeft className="h-5 w-5 transition-transform duration-200 group-hover:-translate-x-0.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="right">
									{t("tasks:modal.actions.previousTask")}
								</TooltipContent>
							</Tooltip>

							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										data-task-nav="next"
										aria-label={t("tasks:modal.actions.nextTask")}
										onClick={() => hasNext && onNavigateNext?.()}
										disabled={!hasNext}
										className={cn(
											"group fixed top-1/2 z-50 -translate-y-1/2 pointer-events-auto",
											"right-[max(0.75rem,calc(50%-min(47.5vw,32rem)-3.25rem))]",
											"flex h-11 w-11 items-center justify-center rounded-full",
											"border border-border/60 bg-card/80 backdrop-blur-md",
											"text-muted-foreground shadow-lg shadow-black/20",
											"transition-all duration-200",
											"hover:scale-110 hover:bg-primary hover:text-primary-foreground hover:border-primary",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
											"disabled:pointer-events-none disabled:opacity-0",
											// En plein écran le modal occupe tout l'écran : on épingle le
											// chevron au bord plutôt qu'à la largeur du modal centré.
											maximized && "right-3",
										)}
									>
										<ChevronRight className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-0.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="left">
									{t("tasks:modal.actions.nextTask")}
								</TooltipContent>
							</Tooltip>
						</>
					)}
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>

			{/* Edit Task Dialog */}
			<TaskEditDialog
				task={task}
				open={state.isEditDialogOpen}
				onOpenChange={state.setIsEditDialogOpen}
				onCloseTask={onCloseTask}
			/>

			{/* Delete Confirmation Dialog */}
			<AlertDialog
				open={state.showDeleteDialog}
				onOpenChange={state.setShowDeleteDialog}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-destructive" />
							{t("tasks:modal.delete.title")}
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="text-sm text-muted-foreground space-y-3">
								<p>
									{t("tasks:modal.delete.confirmMessagePrefix")}{" "}
									<strong>&quot;{task.title}&quot;</strong>
									{t("tasks:modal.delete.confirmMessageSuffix")}
								</p>
								<p className="text-destructive">
									{t("tasks:modal.delete.warningMessage")}
								</p>
								{state.deleteError && (
									<p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
										{state.deleteError}
									</p>
								)}
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={state.isDeleting}>
							{t("tasks:modal.delete.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								handleDelete();
							}}
							disabled={state.isDeleting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{state.isDeleting ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									{t("tasks:modal.delete.deleting")}
								</>
							) : (
								<>
									<Trash2 className="mr-2 h-4 w-4" />
									{t("tasks:modal.delete.deletePermanently")}
								</>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Sync from Branch Dialog */}
			{(taskProject?.path || activeProject?.path) && (
				<SyncFromBranchDialog
					open={state.showSyncDialog}
					task={task}
					projectPath={(taskProject?.path || activeProject?.path) as string}
					onOpenChange={state.setShowSyncDialog}
				/>
			)}
		</TooltipProvider>
	);
}
