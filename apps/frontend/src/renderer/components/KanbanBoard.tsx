import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	type DraggableAttributes,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
	arrayMove,
	horizontalListSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	Archive,
	Ban,
	CheckCheck,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	ChevronsRight,
	Eye,
	GitPullRequest,
	GripVertical,
	Inbox,
	ListPlus,
	Loader2,
	Lock,
	Plus,
	RefreshCw,
	Settings,
	Trash2,
	Unlock,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TASK_STATUS_COLUMNS,
	TASK_STATUS_LABELS,
} from "../../shared/constants";
import type { Task, TaskOrderState, TaskStatus } from "../../shared/types";
import type {
	AzureDevOpsWorkItem,
	JiraWorkItem,
} from "../../shared/types/integrations";
import { parseAcceptanceCriteriaText } from "../../shared/utils/acceptance-criteria";
// Import logos
import AzureDevOpsLogo from "../assets/logos/azure-devops.svg";
import JiraLogo from "../assets/logos/jira.svg";
import { useViewState } from "../contexts/ViewStateContext";
import { useToast } from "../hooks/use-toast";
import {
	compareTasksBySort,
	taskMatchesFilters,
} from "../lib/kanban-filter";
import { cn } from "../lib/utils";
import { openAppEmulatorDialog } from "../stores/app-emulator-store";
import {
	COLLAPSED_COLUMN_WIDTH,
	DEFAULT_COLUMN_WIDTH,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	useKanbanSettingsStore,
} from "../stores/kanban-settings-store";
import { useKanbanFilterStore } from "../stores/kanban-filter-store";
import {
	useProjectEnvStore,
} from "../stores/project-env-store";
import {
	updateProjectSettings,
	useProjectStore,
} from "../stores/project-store";
import {
	archiveTasks,
	createTask,
	deleteTasks,
	forceCompleteTask,
	persistTaskStatus,
	restoreTask,
	useTaskStore,
} from "../stores/task-store";
import { AzureDevOpsSidePanel } from "./azure-devops-import/AzureDevOpsSidePanel";
import type { ImportableWorkItem } from "./azure-devops-import/ImportConfirmDialog";
import { ImportConfirmDialog } from "./azure-devops-import/ImportConfirmDialog";
import { BulkPRDialog } from "./BulkPRDialog";
import { JiraSidePanel } from "./jira-import/JiraSidePanel";
import { KanbanToolbar } from "./kanban/KanbanToolbar";
import { PRFilesModal } from "./PRFilesModal";
import { QueueSettingsModal } from "./QueueSettingsModal";
import { SortableTaskCard } from "./SortableTaskCard";
import { AppSettingsDialog } from "./settings/AppSettings";
import { TaskCard } from "./TaskCard";
import { TaskEditDialog } from "./TaskEditDialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogOverlay,
	AlertDialogPortal,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { WorktreeCleanupDialog } from "./WorktreeCleanupDialog";

// Type guard for valid drop column targets - preserves literal type from TASK_STATUS_COLUMNS
const VALID_DROP_COLUMNS = new Set<string>(TASK_STATUS_COLUMNS);
function isValidDropColumn(
	id: string,
): id is (typeof TASK_STATUS_COLUMNS)[number] {
	return VALID_DROP_COLUMNS.has(id);
}

// Columns where external work items (Azure DevOps / Jira) can be dropped
const IMPORT_ALLOWED_COLUMNS = new Set<string>([
	"backlog",
	"queue",
	"in_progress",
]);

// Valid target columns for bulk drag (multi-selection). Mirrors the action bar rules.
const VALID_BULK_TRANSITIONS: Record<
	(typeof TASK_STATUS_COLUMNS)[number],
	(typeof TASK_STATUS_COLUMNS)[number][]
> = {
	backlog: ["queue", "in_progress"],
	queue: ["backlog", "in_progress"],
	in_progress: ["queue", "ai_review"],
	ai_review: ["in_progress", "human_review"],
	human_review: ["ai_review", "done"],
	// build_failed is CI-driven: tasks land there when the pipeline goes red;
	// from there the user can only send them back to work manually.
	build_failed: ["queue", "in_progress"],
	done: [],
};

/**
 * Get the visual column for a task status.
 * pr_created tasks are displayed in the 'done' column, so we map them accordingly.
 * error tasks are displayed in the 'human_review' column (errors need human attention).
 * This is used to compare visual positions during drag-and-drop operations.
 */
function getVisualColumn(
	status: TaskStatus,
): (typeof TASK_STATUS_COLUMNS)[number] {
	if (status === "pr_created") return "done";
	if (status === "error") return "human_review";
	return status;
}

interface KanbanBoardProps {
	readonly tasks: Task[];
	readonly onTaskClick: (task: Task) => void;
	readonly onNewTaskClick?: () => void;
	readonly onRefresh?: () => void;
	readonly isRefreshing?: boolean;
	readonly onWorkItemsImported?: (
		workItems: AzureDevOpsWorkItem[],
		targetStatus: TaskStatus,
	) => void;
	readonly onOpenJiraSettings?: () => void;
	readonly onOpenAzureDevOpsSettings?: () => void;
}

interface DroppableColumnProps {
	status: TaskStatus;
	tasks: Task[];
	onTaskClick: (task: Task) => void;
	onStatusChange: (taskId: string, newStatus: TaskStatus) => unknown;
	isOver: boolean;
	isImportForbidden?: boolean;
	onAddClick?: () => void;
	onArchiveAll?: () => void;
	onQueueSettings?: () => void;
	onQueueAll?: () => void;
	maxParallelTasks?: number;
	archivedCount?: number;
	showArchived?: boolean;
	onToggleArchived?: () => void;
	// Selection props for human_review column
	selectedTaskIds?: Set<string>;
	onSelectAll?: () => void;
	onDeselectAll?: () => void;
	onToggleSelect?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onDuplicateTask?: (taskId: string) => void;
	onViewPRFiles?: (prUrl: string, taskId: string) => void;
	onPreviewApp?: (taskId: string) => void;
	// Collapse props
	isCollapsed?: boolean;
	onToggleCollapsed?: () => void;
	// Resize props
	columnWidth?: number;
	isResizing?: boolean;
	onResizeStart?: (startX: number) => void;
	onResizeEnd?: () => void;
	// Lock props
	isLocked?: boolean;
	onToggleLocked?: () => void;
	// Column drag handle props (for column reordering)
	dragHandleProps?: {
		listeners: SyntheticListenerMap | undefined;
		attributes: DraggableAttributes;
	};
}

/**
 * Compare two tasks arrays for meaningful changes.
 * Returns true if tasks are equivalent (should skip re-render).
 */
function tasksAreEquivalent(prevTasks: Task[], nextTasks: Task[]): boolean {
	if (prevTasks.length !== nextTasks.length) return false;
	if (prevTasks === nextTasks) return true;

	// Compare by ID and fields that affect rendering
	for (let i = 0; i < prevTasks.length; i++) {
		const prev = prevTasks[i];
		const next = nextTasks[i];
		if (
			prev.id !== next.id ||
			prev.status !== next.status ||
			prev.executionProgress?.phase !== next.executionProgress?.phase ||
			prev.updatedAt !== next.updatedAt
		) {
			return false;
		}
	}
	return true;
}

/**
 * Custom comparator for DroppableColumn memo.
 */
function droppableColumnPropsAreEqual(
	prevProps: DroppableColumnProps,
	nextProps: DroppableColumnProps,
): boolean {
	// Quick checks first
	if (prevProps.status !== nextProps.status) return false;
	if (prevProps.isOver !== nextProps.isOver) return false;
	if (prevProps.isImportForbidden !== nextProps.isImportForbidden) return false;
	if (prevProps.onTaskClick !== nextProps.onTaskClick) return false;
	if (prevProps.onStatusChange !== nextProps.onStatusChange) return false;
	if (prevProps.onAddClick !== nextProps.onAddClick) return false;
	if (prevProps.onArchiveAll !== nextProps.onArchiveAll) return false;
	if (prevProps.onQueueSettings !== nextProps.onQueueSettings) return false;
	if (prevProps.onQueueAll !== nextProps.onQueueAll) return false;
	if (prevProps.maxParallelTasks !== nextProps.maxParallelTasks) return false;
	if (prevProps.archivedCount !== nextProps.archivedCount) return false;
	if (prevProps.showArchived !== nextProps.showArchived) return false;
	if (prevProps.onToggleArchived !== nextProps.onToggleArchived) return false;
	if (prevProps.onSelectAll !== nextProps.onSelectAll) return false;
	if (prevProps.onDeselectAll !== nextProps.onDeselectAll) return false;
	if (prevProps.onToggleSelect !== nextProps.onToggleSelect) return false;
	if (prevProps.isCollapsed !== nextProps.isCollapsed) return false;
	if (prevProps.columnWidth !== nextProps.columnWidth) return false;
	if (prevProps.isResizing !== nextProps.isResizing) return false;
	if (prevProps.onResizeStart !== nextProps.onResizeStart) return false;
	if (prevProps.onResizeEnd !== nextProps.onResizeEnd) return false;
	if (prevProps.isLocked !== nextProps.isLocked) return false;
	if (prevProps.onToggleLocked !== nextProps.onToggleLocked) return false;
	if (prevProps.onViewPRFiles !== nextProps.onViewPRFiles) return false;
	if (prevProps.onPreviewApp !== nextProps.onPreviewApp) return false;
	if (prevProps.dragHandleProps !== nextProps.dragHandleProps) return false;

	// Compare selection props
	const prevSelected = prevProps.selectedTaskIds;
	const nextSelected = nextProps.selectedTaskIds;
	if (prevSelected !== nextSelected) {
		if (!prevSelected || !nextSelected) return false;
		if (prevSelected.size !== nextSelected.size) return false;
		for (const id of prevSelected) {
			if (!nextSelected.has(id)) return false;
		}
	}

	// Deep compare tasks
	const tasksEqual = tasksAreEquivalent(prevProps.tasks, nextProps.tasks);

	// Only log when re-rendering (reduces noise)
	if (globalThis.DEBUG && !tasksEqual) {
		// noop
	}

	return tasksEqual;
}

// Empty state content for each column
const getEmptyStateContent = (
	status: TaskStatus,
	t: (key: string) => string,
): { icon: React.ReactNode; message: string; subtext?: string } => {
	switch (status) {
		case "backlog":
			return {
				icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyBacklog"),
				subtext: t("kanban.emptyBacklogHint"),
			};
		case "queue":
			return {
				icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyQueue"),
				subtext: t("kanban.emptyQueueHint"),
			};
		case "in_progress":
			return {
				icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyInProgress"),
				subtext: t("kanban.emptyInProgressHint"),
			};
		case "ai_review":
			return {
				icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyAiReview"),
				subtext: t("kanban.emptyAiReviewHint"),
			};
		case "human_review":
			return {
				icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyHumanReview"),
				subtext: t("kanban.emptyHumanReviewHint"),
			};
		case "build_failed":
			return {
				icon: <CheckCircle2 className="h-6 w-6 text-success/50" />,
				message: t("kanban.emptyBuildFailed"),
				subtext: t("kanban.emptyBuildFailedHint"),
			};
		case "done":
			return {
				icon: <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyDone"),
				subtext: t("kanban.emptyDoneHint"),
			};
		default:
			return {
				icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyDefault"),
			};
	}
};

const DroppableColumn = memo(function DroppableColumn({
	status,
	tasks,
	onTaskClick,
	onStatusChange,
	isOver,
	isImportForbidden,
	onAddClick,
	onArchiveAll,
	onQueueSettings,
	onQueueAll,
	maxParallelTasks,
	archivedCount,
	showArchived,
	onToggleArchived,
	selectedTaskIds,
	onSelectAll,
	onDeselectAll,
	onToggleSelect,
	onDeleteTask,
	onDuplicateTask,
	onViewPRFiles,
	onPreviewApp,
	isCollapsed,
	onToggleCollapsed,
	columnWidth,
	isResizing,
	onResizeStart,
	onResizeEnd,
	isLocked,
	onToggleLocked,
	dragHandleProps,
}: DroppableColumnProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const { setNodeRef } = useDroppable({
		id: status,
	});

	// Calculate selection state for this column
	const taskCount = tasks.length;
	const columnSelectedCount = tasks.filter((t) =>
		selectedTaskIds?.has(t.id),
	).length;
	const isAllSelected = taskCount > 0 && columnSelectedCount === taskCount;
	const isSomeSelected =
		columnSelectedCount > 0 && columnSelectedCount < taskCount;

	// Determine checkbox checked state: true (all), 'indeterminate' (some), false (none)
	let selectAllCheckedState: boolean | "indeterminate";

	if (isAllSelected) {
		selectAllCheckedState = true;
	} else if (isSomeSelected) {
		selectAllCheckedState = "indeterminate";
	} else {
		selectAllCheckedState = false;
	}

	// Handle select all checkbox change
	const handleSelectAllChange = useCallback(() => {
		if (isAllSelected) {
			onDeselectAll?.();
		} else {
			onSelectAll?.();
		}
	}, [isAllSelected, onSelectAll, onDeselectAll]);

	// Memoize taskIds to prevent SortableContext from re-rendering unnecessarily
	const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

	// Create stable onClick handlers for each task to prevent unnecessary re-renders
	const onClickHandlers = useMemo(() => {
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onTaskClick(task));
		});
		return handlers;
	}, [tasks, onTaskClick]);

	// Create stable onStatusChange handlers for each task
	const onStatusChangeHandlers = useMemo(() => {
		const handlers = new Map<string, (newStatus: TaskStatus) => unknown>();
		tasks.forEach((task) => {
			handlers.set(task.id, (newStatus: TaskStatus) =>
				onStatusChange(task.id, newStatus),
			);
		});
		return handlers;
	}, [tasks, onStatusChange]);

	// Create stable onToggleSelect handlers for each task (for bulk selection)
	const onToggleSelectHandlers = useMemo(() => {
		if (!onToggleSelect) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onToggleSelect(task.id));
		});
		return handlers;
	}, [tasks, onToggleSelect]);

	// Create stable onDelete handlers for each task
	const onDeleteHandlers = useMemo(() => {
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onDeleteTask?.(task.id));
		});
		return handlers;
	}, [tasks, onDeleteTask]);

	// Create stable onDuplicate handlers for each task
	const onDuplicateHandlers = useMemo(() => {
		if (!onDuplicateTask) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onDuplicateTask(task.id));
		});
		return handlers;
	}, [tasks, onDuplicateTask]);

	// Create stable onViewPRFiles handlers for each task
	const onViewPRFilesHandlers = useMemo(() => {
		if (!onViewPRFiles) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => {
				if (task.metadata?.prUrl) {
					onViewPRFiles(task.metadata.prUrl, task.id);
				}
			});
		});
		return handlers;
	}, [tasks, onViewPRFiles]);

	// Create stable onPreviewApp handlers for each task
	const onPreviewAppHandlers = useMemo(() => {
		if (!onPreviewApp) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onPreviewApp(task.id));
		});
		return handlers;
	}, [tasks, onPreviewApp]);

	// Memoize task card elements to prevent recreation on every render
	const taskCards = useMemo(() => {
		if (tasks.length === 0) return null;
		const isSelectable = !!onToggleSelectHandlers;
		return tasks.map((task) => (
			<SortableTaskCard
				key={task.id}
				task={task}
				// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
				onClick={onClickHandlers.get(task.id)!}
				onStatusChange={onStatusChangeHandlers.get(task.id)}
				isSelectable={isSelectable}
				isSelected={isSelectable ? selectedTaskIds?.has(task.id) : undefined}
				onToggleSelect={onToggleSelectHandlers?.get(task.id)}
				onDelete={onDeleteHandlers.get(task.id)}
				onDuplicate={onDuplicateHandlers?.get(task.id)}
				onViewPRFiles={onViewPRFilesHandlers?.get(task.id)}
				onPreviewApp={onPreviewAppHandlers?.get(task.id)}
			/>
		));
	}, [
		tasks,
		onClickHandlers,
		onStatusChangeHandlers,
		onToggleSelectHandlers,
		onDeleteHandlers,
		onDuplicateHandlers,
		onViewPRFilesHandlers,
		onPreviewAppHandlers,
		selectedTaskIds,
	]);

	const getColumnBorderColor = (): string => {
		switch (status) {
			case "backlog":
				return "column-backlog";
			case "queue":
				return "column-queue";
			case "in_progress":
				return "column-in-progress";
			case "ai_review":
				return "column-ai-review";
			case "human_review":
				return "column-human-review";
			case "done":
				return "column-done";
			default:
				return "border-t-muted-foreground/30";
		}
	};

	const emptyState = getEmptyStateContent(status, t);

	// Collapsed state: show narrow vertical strip with rotated title and task count
	if (isCollapsed) {
		return (
			<div
				ref={setNodeRef}
				className={cn(
					"relative flex flex-col rounded-xl border border-white/5 bg-linear-to-b from-secondary/30 to-transparent backdrop-blur-sm transition-all duration-200",
					getColumnBorderColor(),
					"border-t-2",
					isOver && "drop-zone-highlight",
					isImportForbidden && "border-destructive/60",
				)}
				style={{
					width: COLLAPSED_COLUMN_WIDTH,
					minWidth: COLLAPSED_COLUMN_WIDTH,
					maxWidth: COLLAPSED_COLUMN_WIDTH,
				}}
				data-column-status={status}
			>
				{isImportForbidden && (
					<div className="absolute inset-0 rounded-xl bg-destructive/15 flex items-center justify-center z-10 pointer-events-none">
						<Ban className="h-6 w-6 text-destructive/70" />
					</div>
				)}
				{/* Expand button at top */}
				<div className="flex justify-center p-2 border-b border-white/5">
					<Tooltip delayDuration={200}>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
								onClick={onToggleCollapsed}
								aria-label={t("kanban.expandColumn")}
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{t("kanban.expandColumn")}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Rotated title and task count */}
				<div className="flex-1 flex flex-col items-center justify-center">
					<div
						className="flex items-center gap-2 whitespace-nowrap"
						style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
					>
						<span className="column-count-badge">{tasks.length}</span>
						<h2 className="font-semibold text-sm text-foreground">
							{t(TASK_STATUS_LABELS[status])}
						</h2>
					</div>
				</div>

				{/* Task list */}
				<div className="flex-1 min-h-0">
					<ScrollArea className="h-full px-3 pb-3 pt-2">
						<SortableContext
							items={taskIds}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-3 min-h-0">
								{tasks.length === 0 ? (
									<div
										className={cn(
											"empty-column-dropzone flex flex-col items-center justify-center py-6",
											isOver && "active",
										)}
									>
										{isOver ? (
											<>
												<div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
													<Plus className="h-4 w-4 text-primary" />
												</div>
												<span className="text-sm font-medium text-primary">
													{t("kanban.dropHere")}
												</span>
											</>
										) : (
											<>
												{emptyState.icon}
												<span className="mt-2 text-sm font-medium text-muted-foreground/70">
													{emptyState.message}
												</span>
												{emptyState.subtext && (
													<span className="mt-0.5 text-xs text-muted-foreground/50">
														{emptyState.subtext}
													</span>
												)}
											</>
										)}
									</div>
								) : (
									taskCards
								)}
							</div>
						</SortableContext>
					</ScrollArea>
				</div>
			</div>
		);
	}

	return (
		<div
			className="relative flex shrink-0 h-full"
			style={{
				width: columnWidth || DEFAULT_COLUMN_WIDTH,
				minWidth: MIN_COLUMN_WIDTH,
				maxWidth: MAX_COLUMN_WIDTH,
			}}
		>
			<div
				ref={setNodeRef}
				className={cn(
					"relative flex flex-1 flex-col rounded-xl border border-white/5 bg-linear-to-b from-secondary/30 to-transparent backdrop-blur-sm transition-all duration-200",
					getColumnBorderColor(),
					"border-t-2",
					isOver && "drop-zone-highlight",
					isImportForbidden && "border-destructive/60",
				)}
				data-column-status={status}
			>
				{isImportForbidden && (
					<div className="absolute inset-0 rounded-xl bg-destructive/15 flex items-center justify-center z-10 pointer-events-none">
						<Ban className="h-10 w-10 text-destructive/70" />
					</div>
				)}
				{/* Column header - enhanced styling */}
				<div className="flex items-center justify-between p-4 border-b border-white/5">
					<div className="flex items-center gap-2.5">
						{/* Column drag handle for reordering */}
						{dragHandleProps && (
							<Tooltip delayDuration={400}>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="h-6 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors touch-none"
										{...dragHandleProps.listeners}
										{...dragHandleProps.attributes}
										aria-label={t("kanban.dragColumn")}
									>
										<GripVertical className="h-4 w-4" />
									</button>
								</TooltipTrigger>
								<TooltipContent>{t("kanban.dragColumn")}</TooltipContent>
							</Tooltip>
						)}
						{/* Collapse button */}
						{onToggleCollapsed && (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-6 w-6 hover:bg-muted-foreground/10 hover:text-muted-foreground transition-colors"
										onClick={onToggleCollapsed}
										aria-label={t("kanban.collapseColumn")}
									>
										<ChevronLeft className="h-3.5 w-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("kanban.collapseColumn")}</TooltipContent>
							</Tooltip>
						)}
						{/* Select All checkbox for column */}
						{onSelectAll && onDeselectAll && (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<div className="flex items-center">
										<Checkbox
											checked={selectAllCheckedState}
											onCheckedChange={handleSelectAllChange}
											disabled={taskCount === 0}
											aria-label={
												isAllSelected
													? t("kanban.deselectAll")
													: t("kanban.selectAll")
											}
											className="h-4 w-4"
										/>
									</div>
								</TooltipTrigger>
								<TooltipContent>
									{isAllSelected
										? t("kanban.deselectAll")
										: t("kanban.selectAll")}
								</TooltipContent>
							</Tooltip>
						)}
						<h2 className="font-semibold text-sm text-foreground">
							{t(TASK_STATUS_LABELS[status])}
						</h2>
						{status === "in_progress" && maxParallelTasks ? (
							<span
								className={cn(
									"column-count-badge",
									tasks.length >= maxParallelTasks &&
										"bg-warning/20 text-warning border-warning/30",
								)}
							>
								{tasks.length}/{maxParallelTasks}
							</span>
						) : (
							<span className="column-count-badge">{tasks.length}</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						{/* Lock toggle button - available for all columns */}
						{onToggleLocked && (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className={cn(
											"h-7 w-7 transition-colors",
											isLocked
												? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
												: "hover:bg-muted-foreground/10 hover:text-muted-foreground",
										)}
										onClick={onToggleLocked}
										aria-pressed={isLocked}
										aria-label={
											isLocked
												? t("kanban.unlockColumn")
												: t("kanban.lockColumn")
										}
									>
										{isLocked ? (
											<Lock className="h-3.5 w-3.5" />
										) : (
											<Unlock className="h-3.5 w-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">
									{isLocked ? t("kanban.unlockColumn") : t("kanban.lockColumn")}
								</TooltipContent>
							</Tooltip>
						)}
						{status === "backlog" && (
							<>
								{onQueueAll && tasks.length > 0 && (
									<Button
										variant="ghost"
										size="icon"
										className="h-7 w-7 hover:bg-cyan-500/10 hover:text-cyan-400 transition-colors"
										onClick={onQueueAll}
										title={t("queue.queueAll")}
									>
										<ListPlus className="h-4 w-4" />
									</Button>
								)}
								{onAddClick && (
									<Tooltip delayDuration={200}>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
												onClick={onAddClick}
												aria-label={t("kanban.addTaskAriaLabel")}
											>
												<Plus className="h-4 w-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="left">
											{t("kanban.addTaskAriaLabel")}
										</TooltipContent>
									</Tooltip>
								)}
							</>
						)}
						{status === "queue" && onQueueSettings && (
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 hover:bg-cyan-500/10 hover:text-cyan-400 transition-colors"
								onClick={onQueueSettings}
								title={t("kanban.queueSettings")}
							>
								<Settings className="h-4 w-4" />
							</Button>
						)}
						{status === "done" &&
							onArchiveAll &&
							tasks.length > 0 &&
							!showArchived && (
								<Button
									variant="ghost"
									size="icon"
									className="h-7 w-7 hover:bg-muted-foreground/10 hover:text-muted-foreground transition-colors"
									onClick={onArchiveAll}
									aria-label={t("tooltips.archiveAllDone")}
								>
									<Archive className="h-4 w-4" />
								</Button>
							)}
						{status === "done" &&
							archivedCount !== undefined &&
							archivedCount > 0 &&
							onToggleArchived && (
								<Tooltip delayDuration={200}>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className={cn(
												"h-7 w-7 transition-colors relative",
												showArchived
													? "text-primary bg-primary/10 hover:bg-primary/20"
													: "hover:bg-muted-foreground/10 hover:text-muted-foreground",
											)}
											onClick={onToggleArchived}
											aria-pressed={showArchived}
											aria-label={t(
												"common:accessibility.toggleShowArchivedAriaLabel",
											)}
										>
											<Archive className="h-4 w-4" />
											<span className="absolute -top-1 -right-1 text-[10px] font-medium bg-muted rounded-full min-w-[14px] h-[14px] flex items-center justify-center">
												{archivedCount}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{showArchived
											? t("common:projectTab.hideArchived")
											: t("common:projectTab.showArchived")}
									</TooltipContent>
								</Tooltip>
							)}
					</div>
				</div>

				{/* Task list */}
				<div className="flex-1 min-h-0">
					<ScrollArea className="h-full px-3 pb-3 pt-2">
						<SortableContext
							items={taskIds}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-3 min-h-0">
								{tasks.length === 0 ? (
									<div
										className={cn(
											"empty-column-dropzone flex flex-col items-center justify-center py-6",
											isOver && "active",
										)}
									>
										{isOver ? (
											<>
												<div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
													<Plus className="h-4 w-4 text-primary" />
												</div>
												<span className="text-sm font-medium text-primary">
													{t("kanban.dropHere")}
												</span>
											</>
										) : (
											<>
												{emptyState.icon}
												<span className="mt-2 text-sm font-medium text-muted-foreground/70">
													{emptyState.message}
												</span>
												{emptyState.subtext && (
													<span className="mt-0.5 text-xs text-muted-foreground/50">
														{emptyState.subtext}
													</span>
												)}
											</>
										)}
									</div>
								) : (
									taskCards
								)}
							</div>
						</SortableContext>
					</ScrollArea>
				</div>
			</div>

			{/* Resize handle on right edge */}
			{onResizeStart && onResizeEnd && (
				// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
				// biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize handle — drag interaction
				<div
					className={cn(
						"absolute right-0 top-0 bottom-0 w-1 touch-none z-10",
						"transition-colors duration-150",
						isLocked
							? "cursor-not-allowed bg-transparent"
							: "cursor-col-resize hover:bg-primary/40",
						isResizing && !isLocked && "bg-primary/60",
					)}
					onMouseDown={(e) => {
						e.preventDefault();
						// Don't start resize if column is locked
						if (isLocked) return;
						onResizeStart(e.clientX);
					}}
					onTouchStart={(e) => {
						e.preventDefault();
						// Don't start resize if column is locked
						if (isLocked) return;
						if (e.touches.length > 0) {
							onResizeStart(e.touches[0].clientX);
						}
					}}
					title={isLocked ? t("kanban.columnLocked") : undefined}
				>
					{/* Wider invisible hit area for easier grabbing */}
					<div className="absolute inset-y-0 -left-1 -right-1" />
				</div>
			)}
		</div>
	);
}, droppableColumnPropsAreEqual);

// ============================================
// SortableColumnWrapper — enables column drag-to-reorder
// ============================================

interface SortableColumnWrapperProps
	extends Omit<
		React.ComponentProps<typeof DroppableColumn>,
		"dragHandleProps"
	> {
	sortableId: string;
}

function SortableColumnWrapper({
	sortableId,
	...columnProps
}: SortableColumnWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 50 : undefined,
		position: "relative",
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(isDragging && "opacity-50")}
		>
			<DroppableColumn
				{...columnProps}
				dragHandleProps={{ listeners, attributes }}
			/>
		</div>
	);
}

export function KanbanBoard({
	tasks,
	onTaskClick,
	onNewTaskClick,
	onRefresh,
	isRefreshing,
	onWorkItemsImported: _onWorkItemsImported,
	onOpenJiraSettings,
	onOpenAzureDevOpsSettings,
}: KanbanBoardProps) {
	const { t } = useTranslation(["tasks", "dialogs", "common"]);
	const { toast } = useToast();
	const [activeTask, setActiveTask] = useState<Task | null>(null);
	const [overColumnId, setOverColumnId] = useState<string | null>(null);
	const { showArchived, toggleShowArchived } = useViewState();

	// Project store for queue settings
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const activeProjectId = useProjectStore((state) => state.activeProjectId);

	// Project environment store for Azure DevOps configuration.
	const envConfig = useProjectEnvStore((state) => state.envConfig);

	// Kanban settings store for column preferences (collapse state, width, lock state, order)
	const columnPreferences = useKanbanSettingsStore(
		(state) => state.columnPreferences,
	);
	const columnOrder = useKanbanSettingsStore((state) => state.columnOrder);
	const loadKanbanPreferences = useKanbanSettingsStore(
		(state) => state.loadPreferences,
	);
	const saveKanbanPreferences = useKanbanSettingsStore(
		(state) => state.savePreferences,
	);
	const toggleColumnCollapsed = useKanbanSettingsStore(
		(state) => state.toggleColumnCollapsed,
	);
	const setColumnCollapsed = useKanbanSettingsStore(
		(state) => state.setColumnCollapsed,
	);
	const setColumnWidth = useKanbanSettingsStore(
		(state) => state.setColumnWidth,
	);
	const toggleColumnLocked = useKanbanSettingsStore(
		(state) => state.toggleColumnLocked,
	);
	const setColumnOrder = useKanbanSettingsStore(
		(state) => state.setColumnOrder,
	);

	// Column drag state
	const [isDraggingColumn, setIsDraggingColumn] = useState(false);

	// Column resize state
	const [resizingColumn, setResizingColumn] = useState<
		(typeof TASK_STATUS_COLUMNS)[number] | null
	>(null);
	const resizeStartX = useRef<number>(0);
	const resizeStartWidth = useRef<number>(0);
	// Capture projectId at resize start to avoid stale closure if project changes during resize
	const resizeProjectIdRef = useRef<string | null>(null);

	// Get projectId from active tab (activeProjectId), fallback to selectedProjectId for backward compatibility
	const projectId = activeProjectId || selectedProjectId;
	const project = projectId
		? projects.find((p) => p.id === projectId)
		: undefined;
	const maxParallelTasks = project?.settings?.maxParallelTasks ?? 3;

	// Kanban filter/sort state (search, source/category/priority filters, sort).
	// Persisted per project in the kanban-filter-store.
	const kanbanFilters = useKanbanFilterStore((state) => state.filters);
	const kanbanSort = useKanbanFilterStore((state) => state.sort);
	const loadKanbanFilters = useKanbanFilterStore(
		(state) => state.loadForProject,
	);

	// Load the persisted filter/sort preferences whenever the active project changes.
	useEffect(() => {
		if (projectId) {
			loadKanbanFilters(projectId);
		}
	}, [projectId, loadKanbanFilters]);

	// Check Azure DevOps connection status when enabled or credentials change.
	useEffect(() => {
		if (
			activeProjectId &&
			envConfig?.azureDevOpsEnabled
		) {
			globalThis.electronAPI
				.checkAzureDevOpsConnection(activeProjectId)
				.then((result) => {
					setAzureDevOpsConnected(
						result.success && result.data?.connected === true,
					);
					setAzureDevOpsProjectName(result.data?.projectName || null);
				})
				.catch(() => {
					setAzureDevOpsConnected(null);
					setAzureDevOpsProjectName(null);
				});
		} else {
			setAzureDevOpsConnected(null);
			setAzureDevOpsProjectName(null);
		}
	}, [activeProjectId, envConfig?.azureDevOpsEnabled]);

	// Check Jira connection status when enabled.
	useEffect(() => {
		if (
			activeProjectId &&
			envConfig?.jiraEnabled
		) {
			globalThis.electronAPI
				.checkJiraConnection(activeProjectId)
				.then((result) => {
					setJiraConnected(result.success && result.data?.connected === true);
				})
				.catch(() => {
					setJiraConnected(false);
				});
		} else {
			setJiraConnected(null);
		}
	}, [activeProjectId, envConfig?.jiraEnabled]);

	// Queue settings modal state
	const [showQueueSettings, setShowQueueSettings] = useState(false);
	// Store projectId when modal opens to prevent modal from disappearing if tasks change
	const queueSettingsProjectIdRef = useRef<string | null>(null);

	// Queue processing lock to prevent race conditions
	const isProcessingQueueRef = useRef(false);

	// Track tasks manually moved to queue to prevent auto-promotion back
	const manuallyQueuedTaskIdsRef = useRef<Set<string>>(new Set());

	// Selection state for bulk actions (Human Review column)
	const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
		new Set(),
	);

	// True when the currently dragged task is part of a multi-selection
	const [isDraggingBulkSelected, setIsDraggingBulkSelected] = useState(false);

	// Bulk PR dialog state
	const [bulkPRDialogOpen, setBulkPRDialogOpen] = useState(false);

	// Bulk "mark as done" confirmation dialog state (human_review → done)
	const [bulkMarkDoneConfirmOpen, setBulkMarkDoneConfirmOpen] = useState(false);

	// Delete confirmation dialog state
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// Single task delete confirmation dialog state
	const [singleDeleteConfirm, setSingleDeleteConfirm] = useState<{
		open: boolean;
		taskId: string | null;
		taskTitle: string;
	}>({
		open: false,
		taskId: null,
		taskTitle: "",
	});

	// Source task for the "duplicate" dialog (edit fields before creating the copy)
	const [duplicateSource, setDuplicateSource] = useState<Task | null>(null);

	// Store recently deleted tasks for undo functionality
	const [_recentlyDeletedTasks, setRecentlyDeletedTasks] = useState<
		Map<string, Task>
	>(new Map());

	// Worktree cleanup dialog state
	const [worktreeCleanupDialog, setWorktreeCleanupDialog] = useState<{
		open: boolean;
		taskId: string | null;
		taskTitle: string;
		worktreePath?: string;
		isProcessing: boolean;
		error?: string;
	}>({
		open: false,
		taskId: null,
		taskTitle: "",
		worktreePath: undefined,
		isProcessing: false,
		error: undefined,
	});

	// Azure DevOps import panel state
	const [azureDevOpsPanelOpen, setAzureDevOpsPanelOpen] = useState(false);
	const [azureDevOpsConnected, setAzureDevOpsConnected] = useState<
		boolean | null
	>(null);
	const [_azureDevOpsProjectName, setAzureDevOpsProjectName] = useState<
		string | null
	>(null);

	// Jira import panel state
	const [jiraPanelOpen, setJiraPanelOpen] = useState(false);
	const [jiraConnected, setJiraConnected] = useState<boolean | null>(null);

	// Azure DevOps drag state
	const [isDraggingAzureDevOps, setIsDraggingAzureDevOps] = useState(false);
	const [_draggedAzureDevOpsItems, setDraggedAzureDevOpsItems] = useState<
		AzureDevOpsWorkItem[]
	>([]);

	// Import confirm dialog state (shown after dropping work items from Azure DevOps / Jira)
	const [importConfirmDialog, setImportConfirmDialog] = useState<{
		open: boolean;
		workItems: ImportableWorkItem[];
		targetColumn: TaskStatus | null;
		isImporting: boolean;
		source: "azure-devops" | "jira" | null;
	}>({
		open: false,
		workItems: [],
		targetColumn: null,
		isImporting: false,
		source: null,
	});

	// PR Files Modal state
	const [prFilesModalOpen, setPrFilesModalOpen] = useState(false);
	const [selectedPRUrl, setSelectedPRUrl] = useState<string>("");
	const [selectedTaskId, setSelectedTaskId] = useState<string>("");

	// Calculate collapsed column count for "Expand All" button
	const collapsedColumnCount = useMemo(() => {
		if (!columnPreferences) return 0;
		return TASK_STATUS_COLUMNS.filter(
			(status) => columnPreferences[status]?.isCollapsed,
		).length;
	}, [columnPreferences]);

	// Filter tasks based on archive status
	const filteredTasks = useMemo(() => {
		// Archive gate first, then the user-selected search/source/category/priority
		// filters from the filter bar.
		const base = showArchived
			? tasks
			: tasks.filter((t) => !t.metadata?.archivedAt);
		return base.filter((t) => taskMatchesFilters(t, kanbanFilters));
	}, [tasks, showArchived, kanbanFilters]);

	// Calculate archived count for Done column button
	const archivedCount = useMemo(
		() => tasks.filter((t) => t.metadata?.archivedAt).length,
		[tasks],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 8, // 8px movement required before drag starts
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	// Get task order from store for custom ordering
	const taskOrder = useTaskStore((state) => state.taskOrder);

	const tasksByStatus = useMemo(() => {
		// Note: pr_created tasks are shown in the 'done' column since they're essentially complete
		// Note: error tasks are shown in the 'human_review' column since they need human attention
		const grouped: Record<(typeof TASK_STATUS_COLUMNS)[number], Task[]> = {
			backlog: [],
			queue: [],
			in_progress: [],
			ai_review: [],
			human_review: [],
			build_failed: [],
			done: [],
		};

		filteredTasks.forEach((task) => {
			// Map pr_created tasks to the done column, error tasks to human_review
			const targetColumn = getVisualColumn(task.status);
			if (grouped[targetColumn]) {
				grouped[targetColumn].push(task);
			}
		});

		// When an explicit sort field is chosen from the filter bar, it takes
		// precedence over the manual drag-and-drop order for every column.
		const useExplicitSort = kanbanSort.field !== "manual";

		// Sort tasks within each column
		Object.keys(grouped).forEach((status) => {
			const statusKey = status as (typeof TASK_STATUS_COLUMNS)[number];
			const columnTasks = grouped[statusKey];
			const columnOrder = taskOrder?.[statusKey];

			if (useExplicitSort) {
				grouped[statusKey] = [...columnTasks].sort((a, b) =>
					compareTasksBySort(a, b, kanbanSort),
				);
			} else if (columnOrder && columnOrder.length > 0) {
				// Custom order exists: sort by order index
				// 1. Create a set of current task IDs for fast lookup (filters stale IDs)
				const currentTaskIds = new Set(columnTasks.map((t) => t.id));

				// 2. Create valid order by filtering out stale IDs
				const validOrder = columnOrder.filter((id) => currentTaskIds.has(id));
				const validOrderSet = new Set(validOrder);

				// 3. Find new tasks not in order (prepend at top)
				const newTasks = columnTasks.filter((t) => !validOrderSet.has(t.id));
				// Sort new tasks by createdAt (newest first)
				newTasks.sort((a, b) => {
					const dateA = new Date(a.createdAt).getTime();
					const dateB = new Date(b.createdAt).getTime();
					return dateB - dateA;
				});

				// 4. Sort ordered tasks by their index in validOrder
				// Pre-compute index map for O(n) sorting instead of O(n²) with indexOf
				const indexMap = new Map(validOrder.map((id, idx) => [id, idx]));
				const orderedTasks = columnTasks
					.filter((t) => validOrderSet.has(t.id))
					.sort(
						(a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0),
					);

				// 5. Prepend new tasks at top, then ordered tasks
				grouped[statusKey] = [...newTasks, ...orderedTasks];
			} else {
				// No custom order: fallback to createdAt sort (newest first)
				grouped[statusKey].sort((a, b) => {
					const dateA = new Date(a.createdAt).getTime();
					const dateB = new Date(b.createdAt).getTime();
					return dateB - dateA;
				});
			}
		});

		return grouped;
	}, [filteredTasks, taskOrder, kanbanSort]);

	// Prune stale IDs when tasks are deleted or filtered out
	useEffect(() => {
		const allTaskIds = new Set(filteredTasks.map((t) => t.id));
		setSelectedTaskIds((prev) => {
			const filtered = new Set([...prev].filter((id) => allTaskIds.has(id)));
			return filtered.size === prev.size ? prev : filtered;
		});
	}, [filteredTasks]);

	// Selection callbacks for bulk actions (all columns)
	const toggleTaskSelection = useCallback((taskId: string) => {
		setSelectedTaskIds((prev) => {
			const next = new Set(prev);
			if (next.has(taskId)) {
				next.delete(taskId);
			} else {
				next.add(taskId);
			}
			return next;
		});
	}, []);

	const selectAllTasks = useCallback(
		(columnStatus?: (typeof TASK_STATUS_COLUMNS)[number]) => {
			if (columnStatus) {
				// Select all in specific column
				const columnTasks = tasksByStatus[columnStatus] || [];
				const columnIds = new Set(columnTasks.map((t: Task) => t.id));
				setSelectedTaskIds((prev) => new Set<string>([...prev, ...columnIds]));
			} else {
				// Select all across all columns
				const allIds = new Set(filteredTasks.map((t) => t.id));
				setSelectedTaskIds(allIds);
			}
		},
		[tasksByStatus, filteredTasks],
	);

	const deselectAllTasks = useCallback(() => {
		setSelectedTaskIds(new Set());
	}, []);

	// Get selected task objects for bulk actions
	const selectedTasks = useMemo(() => {
		return filteredTasks.filter((task) => selectedTaskIds.has(task.id));
	}, [filteredTasks, selectedTaskIds]);

	// Determine which visual column all selected tasks belong to (null = mixed selection)
	const selectedColumnStatus = useMemo<
		(typeof TASK_STATUS_COLUMNS)[number] | null
	>(() => {
		if (selectedTaskIds.size === 0) return null;
		const columns = new Set(
			selectedTasks.map((t) => getVisualColumn(t.status)),
		);
		return columns.size === 1 ? [...columns][0] : null;
	}, [selectedTasks, selectedTaskIds.size]);

	// Handle opening the bulk PR dialog
	const handleOpenBulkPRDialog = useCallback(() => {
		if (selectedTaskIds.size > 0) {
			setBulkPRDialogOpen(true);
		}
	}, [selectedTaskIds.size]);

	// Handle opening the delete confirmation dialog
	const handleOpenDeleteConfirm = useCallback(() => {
		setDeleteConfirmOpen(true);
	}, []);

	// Handle confirmed bulk delete
	const handleConfirmDelete = useCallback(async () => {
		if (selectedTaskIds.size === 0) return;

		setIsDeleting(true);
		const taskIdsToDelete = Array.from(selectedTaskIds);

		const result = await deleteTasks(taskIdsToDelete);

		setIsDeleting(false);
		setDeleteConfirmOpen(false);

		if (result.success) {
			toast({
				title: t("kanban.deleteSuccess", { count: taskIdsToDelete.length }),
				variant: "default",
			});
			deselectAllTasks();
		} else {
			toast({
				title: t("kanban.deleteError"),
				description: result.error,
				variant: "destructive",
			});
			// Still clear selection for successfully deleted tasks
			if (result.failedIds) {
				const remainingIds = new Set(result.failedIds);
				setSelectedTaskIds(remainingIds);
			}
		}
	}, [selectedTaskIds, deselectAllTasks, toast, t]);

	// Handle bulk move of all selected tasks to a target status
	const handleBulkMove = useCallback(
		async (targetStatus: TaskStatus) => {
			if (selectedTaskIds.size === 0) return;
			const taskIds = Array.from(selectedTaskIds);
			let failedCount = 0;
			for (const taskId of taskIds) {
				const result = await persistTaskStatus(taskId, targetStatus);
				if (!result.success) failedCount++;
			}
			if (failedCount === 0) {
				toast({
					title: t("kanban.bulkMoveSuccess", { count: taskIds.length }),
				});
				deselectAllTasks();
			} else {
				toast({
					title: t("kanban.bulkMoveError", {
						failed: failedCount,
						total: taskIds.length,
					}),
					variant: "destructive",
				});
			}
		},
		[selectedTaskIds, deselectAllTasks, toast, t],
	);

	// Open BulkPRDialog after user confirms "mark as done" for human_review tasks
	const handleBulkMarkDoneConfirm = useCallback(() => {
		setBulkMarkDoneConfirmOpen(false);
		setBulkPRDialogOpen(true);
	}, []);

	// Handle bulk PR dialog completion - clear selection
	const handleBulkPRComplete = useCallback(() => {
		/* intentionally empty */
	}, []);

	// Handle viewing PR files
	const handleViewPRFiles = useCallback((prUrl: string, taskId: string) => {
		setSelectedPRUrl(prUrl);
		setSelectedTaskId(taskId);
		setPrFilesModalOpen(true);
	}, []);

	// Handle app preview for done tasks
	const handlePreviewApp = useCallback((taskId: string) => {
		openAppEmulatorDialog(taskId);
	}, []);

	const handleArchiveAll = useCallback(async () => {
		// Use the current projectId (from active tab) to ensure we archive the correct project's tasks
		if (!projectId) {
			console.error("[KanbanBoard] No projectId found");
			return;
		}

		const doneTaskIds = tasksByStatus.done.map((t) => t.id);
		if (doneTaskIds.length === 0) return;

		const result = await archiveTasks(projectId, doneTaskIds);
		if (!result.success) {
			console.error("[KanbanBoard] Failed to archive tasks:", result.error);
		}
	}, [tasksByStatus.done, projectId]);

	const handleDeleteTask = useCallback(async (taskId: string) => {
		// Get the task information for the confirmation dialog
		const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
		const taskTitle = task?.title || "Untitled";

		// Open confirmation dialog instead of deleting directly
		setSingleDeleteConfirm({
			open: true,
			taskId,
			taskTitle,
		});
	}, []);

	// Open the duplicate dialog pre-filled with the source task so the user can
	// edit the fields before the copy is actually created.
	const handleDuplicateTask = useCallback((taskId: string) => {
		const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
		if (task) setDuplicateSource(task);
	}, []);

	const handleDuplicateCreated = useCallback(() => {
		toast({
			title: t("kanban.duplicateSuccess"),
			variant: "default",
		});
		setDuplicateSource(null);
	}, [toast, t]);

	// Handle undo delete
	const handleUndoDelete = useCallback(
		async (taskId: string) => {
			try {
				const result = await restoreTask(taskId);

				if (result.success) {
					// Remove from recently deleted tasks (for UI state consistency)
					setRecentlyDeletedTasks((prev) => {
						const newMap = new Map(prev);
						newMap.delete(taskId);
						return newMap;
					});

					toast({
						title: t("kanban.restoreSuccess"),
						variant: "default",
					});
				} else {
					toast({
						title: t("kanban.restoreError"),
						description: result.error,
						variant: "destructive",
					});
				}
			} catch (error) {
				toast({
					title: t("kanban.restoreError"),
					description: error instanceof Error ? error.message : "Unknown error",
					variant: "destructive",
				});
			}
		},
		[toast, t],
	);

	// Handle confirmed single task delete
	const handleConfirmSingleDelete = useCallback(async () => {
		if (!singleDeleteConfirm.taskId) return;
		const deletedTaskId = singleDeleteConfirm.taskId;

		// Get the full task data before deletion for potential undo
		const taskToDelete = useTaskStore
			.getState()
			.tasks.find((t) => t.id === deletedTaskId);

		const result = await deleteTasks([deletedTaskId]);

		// Close the dialog
		setSingleDeleteConfirm({
			open: false,
			taskId: null,
			taskTitle: "",
		});

		if (result.success && taskToDelete) {
			// Store the deleted task for undo functionality
			setRecentlyDeletedTasks((prev) =>
				new Map(prev).set(deletedTaskId, taskToDelete),
			);

			toast({
				title: t("kanban.deleteSuccessSingle", {
					title: singleDeleteConfirm.taskTitle,
				}),
				action: (
					<button
						type="button"
						// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
						onClick={() => handleUndoDelete(singleDeleteConfirm.taskId!)}
						className="px-2 py-1 text-sm bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors"
					>
						{t("kanban.undo")}
					</button>
				),
				variant: "default",
			});
		} else {
			toast({
				title: t("kanban.deleteError"),
				description: result.error,
				variant: "destructive",
			});
			// Still clear selection for successfully deleted tasks
			if (result.failedIds) {
				const remainingIds = new Set(result.failedIds);
				setSelectedTaskIds(remainingIds);
			}
		}
	}, [
		singleDeleteConfirm.taskId,
		singleDeleteConfirm.taskTitle,
		toast,
		t,
		handleUndoDelete,
	]);

	/**
	 * Handle import confirmation from the ImportConfirmDialog.
	 * Creates tasks from the pending work items with the requireReviewBeforeCoding flag.
	 * Supports both Azure DevOps and Jira work items via the `source` field.
	 */
	const handleImportConfirm = useCallback(
		async (requireReviewBeforeCoding: boolean) => {
			const { workItems, targetColumn, source } = importConfirmDialog;
			if (!workItems.length || !targetColumn || !projectId) return;

			setImportConfirmDialog((prev) => ({ ...prev, isImporting: true }));

			let successCount = 0;
			let _errorCount = 0;
			let firstImportedTitle = "";

			for (const workItem of workItems) {
				try {
					const metadata: Record<string, unknown> = {
						sourceType: "imported",
					};

					if (source === "jira") {
						// Jira-specific metadata
						const jiraItem = workItem as unknown as JiraWorkItem;
						metadata.jiraIdentifier = jiraItem.id;
						metadata.jiraUrl = jiraItem.url;
						metadata.jiraState = jiraItem.state;
						metadata.jiraType = jiraItem.workItemType;
						metadata.importSource = "jira";

						const jiraAc = parseAcceptanceCriteriaText(
							jiraItem.acceptanceCriteria,
						);
						if (jiraAc.length > 0) {
							metadata.acceptanceCriteria = jiraAc;
						}

						const jiraPriority = jiraItem.priority?.toLowerCase();
						if (jiraPriority === "highest" || jiraPriority === "critical") {
							metadata.priority = "urgent";
						} else if (jiraPriority === "high") {
							metadata.priority = "high";
						} else if (jiraPriority === "medium") {
							metadata.priority = "medium";
						} else {
							metadata.priority = "low";
						}

						if (jiraItem.workItemType?.toLowerCase() === "bug") {
							metadata.category = "bug_fix";
						} else if (jiraItem.workItemType?.toLowerCase() === "story") {
							metadata.category = "feature";
						} else if (jiraItem.workItemType?.toLowerCase() === "task") {
							metadata.category = "feature";
						} else {
							metadata.category = "documentation";
						}
					} else {
						// Azure DevOps metadata (default)
						const adoItem = workItem as unknown as AzureDevOpsWorkItem;
						metadata.azureDevOpsIdentifier = adoItem.id.toString();
						metadata.azureDevOpsUrl = adoItem.url;
						metadata.azureDevOpsState = adoItem.state;
						metadata.azureDevOpsType = adoItem.workItemType;
						metadata.importSource = "azure-devops";

						const adoAc = parseAcceptanceCriteriaText(
							adoItem.acceptanceCriteria,
						);
						if (adoAc.length > 0) {
							metadata.acceptanceCriteria = adoAc;
						}

						if (adoItem.priority === 1) {
							metadata.priority = "urgent";
						} else if (adoItem.priority === 2) {
							metadata.priority = "high";
						} else if (adoItem.priority === 3) {
							metadata.priority = "medium";
						} else {
							metadata.priority = "low";
						}

						if (adoItem.workItemType === "Bug") {
							metadata.category = "bug_fix";
						} else if (adoItem.workItemType === "User Story") {
							metadata.category = "feature";
						} else if (adoItem.workItemType === "Task") {
							metadata.category = "feature";
						} else {
							metadata.category = "documentation";
						}
					}

					if (requireReviewBeforeCoding) {
						metadata.requireReviewBeforeCoding = true;
					}

					// task.description = raw description from the tracker; the
					// AcceptanceCriteriaSection component renders metadata.acceptanceCriteria
					// in its own UI block. Concatenating them here would double the
					// criteria the user sees (once in description, once in the AC list).
					const result = await createTask(
						projectId,
						workItem.title,
						workItem.description || "",
						metadata,
					);

					if (result) {
						if (successCount === 0) firstImportedTitle = workItem.title;
						successCount++;

						const statusResult = await persistTaskStatus(
							result.id,
							targetColumn,
						);
						if (!statusResult.success) {
							console.error(
								"[Import] Task created but status update failed:",
								result.id,
								statusResult.error,
							);
						}
					} else {
						_errorCount++;
						console.error(
							"[Import] Failed to persist task from work item:",
							workItem.id,
						);
					}
				} catch (error) {
					_errorCount++;
					console.error(
						"[Import] Failed to create task from work item:",
						workItem.id,
						error,
					);
				}
			}

			// Refresh tasks to show newly imported ones
			if (successCount > 0) {
				try {
					if (onRefresh) {
						onRefresh();
					} else if (projectId) {
						await globalThis.electronAPI.getTasks(projectId, {
							forceRefresh: true,
						});
					}
				} catch (error) {
					console.error(
						"[Import] Failed to refresh tasks after import:",
						error,
					);
				}
			}

			// Close dialog
			setImportConfirmDialog({
				open: false,
				workItems: [],
				targetColumn: null,
				isImporting: false,
				source: null,
			});

			// Show toast
			if (successCount > 0) {
				toast({
					title:
						successCount === 1
							? t("settings:azureDevOpsImport.importSuccessSingle", {
									title: firstImportedTitle,
								})
							: t("settings:azureDevOpsImport.importSuccess", {
									count: successCount,
								}),
					variant: "default",
				});
			} else {
				toast({
					title: t("settings:azureDevOpsImport.errorImportFailed"),
					variant: "destructive",
				});
			}
		},
		[importConfirmDialog, projectId, onRefresh, toast, t],
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			const { active } = event;

			// Check if this is an Azure DevOps work item drag
			if (active.id.toString().startsWith("azure-devops-")) {
				// This is handled by native drag events, not dnd-kit
				return;
			}

			// Check if this is a column drag
			if (active.id.toString().startsWith("col-")) {
				setIsDraggingColumn(true);
				return;
			}

			const task = useTaskStore
				.getState()
				.tasks.find((t) => t.id === active.id);
			if (task) {
				setActiveTask(task);
				// Track if this drag involves a multi-selection (for bulk drop validation)
				setIsDraggingBulkSelected(
					selectedTaskIds.has(task.id) && selectedTaskIds.size > 1,
				);
			}
		},
		[selectedTaskIds],
	);

	const handleDragOver = useCallback((event: DragOverEvent) => {
		const { active, over } = event;

		// Ignore column drags — no task drop highlighting needed
		if (active.id.toString().startsWith("col-")) return;

		if (!over) {
			setOverColumnId(null);
			return;
		}

		const overId = over.id as string;

		// Check if over a column
		if (isValidDropColumn(overId)) {
			setOverColumnId(overId);
			return;
		}

		// Check if over a task - get its column
		const overTask = useTaskStore.getState().tasks.find((t) => t.id === overId);
		if (overTask) {
			setOverColumnId(overTask.status);
		}
	}, []);

	/**
	 * Handle status change with worktree cleanup dialog support
	 * Consolidated handler that accepts an optional task object for the dialog title
	 */
	const handleStatusChange = useCallback(
		async (taskId: string, newStatus: TaskStatus, providedTask?: Task) => {
			const task =
				providedTask ||
				useTaskStore.getState().tasks.find((t) => t.id === taskId);
			const result = await persistTaskStatus(taskId, newStatus);

			if (!result.success) {
				if (result.worktreeExists) {
					// Show the worktree cleanup dialog
					setWorktreeCleanupDialog({
						open: true,
						taskId: taskId,
						taskTitle: task?.title || t("tasks:untitled"),
						worktreePath: result.worktreePath,
						isProcessing: false,
						error: undefined,
					});
				} else {
					// Show error toast for other failures
					toast({
						title: t("common:errors.operationFailed"),
						description: result.error || t("common:errors.unknownError"),
						variant: "destructive",
					});
				}
			}
		},
		[toast, t],
	);

	/**
	 * Handle worktree cleanup confirmation
	 */
	const handleWorktreeCleanupConfirm = useCallback(async () => {
		if (!worktreeCleanupDialog.taskId) return;

		setWorktreeCleanupDialog((prev) => ({
			...prev,
			isProcessing: true,
			error: undefined,
		}));

		const result = await forceCompleteTask(worktreeCleanupDialog.taskId);

		if (result.success) {
			setWorktreeCleanupDialog({
				open: false,
				taskId: null,
				taskTitle: "",
				worktreePath: undefined,
				isProcessing: false,
				error: undefined,
			});
		} else {
			// Keep dialog open with error state for retry - show actual error if available
			setWorktreeCleanupDialog((prev) => ({
				...prev,
				isProcessing: false,
				error: result.error || t("dialogs:worktreeCleanup.errorDescription"),
			}));
		}
	}, [worktreeCleanupDialog.taskId, t]);

	/**
	 * Automatically move tasks from Queue to In Progress to fill available capacity
	 * Promotes multiple tasks if needed (e.g., after bulk queue)
	 */
	const processQueue = useCallback(async () => {
		// Prevent concurrent executions to avoid race conditions
		if (isProcessingQueueRef.current) {
			return;
		}

		isProcessingQueueRef.current = true;

		try {
			// Track tasks we've already attempted to promote (to avoid infinite retries)
			const attemptedTaskIds = new Set<string>();
			let consecutiveFailures = 0;
			const MAX_CONSECUTIVE_FAILURES = 10; // Safety limit to prevent infinite loop

			// Loop until capacity is full or queue is empty
			while (true) {
				// Get CURRENT state from store to ensure accuracy
				const currentTasks = useTaskStore.getState().tasks;
				const inProgressCount = currentTasks.filter(
					(t) => t.status === "in_progress" && !t.metadata?.archivedAt,
				).length;
				const queuedTasks = currentTasks.filter(
					(t) =>
						t.status === "queue" &&
						!t.metadata?.archivedAt &&
						!attemptedTaskIds.has(t.id) &&
						!manuallyQueuedTaskIdsRef.current.has(t.id),
				);

				// Stop if no capacity, no queued tasks, or too many consecutive failures
				if (inProgressCount >= maxParallelTasks || queuedTasks.length === 0) {
					break;
				}

				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
					console.warn(
						`[Queue] Stopping queue processing after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
					);
					break;
				}

				// Get the oldest task in queue (FIFO ordering)
				const nextTask = [...queuedTasks].sort((a: Task, b: Task) => {
					const dateA = new Date(a.createdAt).getTime();
					const dateB = new Date(b.createdAt).getTime();
					return dateA - dateB; // Ascending order (oldest first)
				})[0];
				const result = await persistTaskStatus(nextTask.id, "in_progress");

				if (result.success) {
					// Reset consecutive failures on success
					consecutiveFailures = 0;
				} else {
					// If promotion failed, log error, mark as attempted, and skip to next task
					console.error(
						`[Queue] Failed to promote task ${nextTask.id} to In Progress:`,
						result.error,
					);
					attemptedTaskIds.add(nextTask.id);
					consecutiveFailures++;
				}
			}

			// Log if we had failed tasks
			if (attemptedTaskIds.size > 0) {
				console.warn(
					`[Queue] Skipped ${attemptedTaskIds.size} task(s) that failed to promote`,
				);
			}
		} finally {
			isProcessingQueueRef.current = false;
		}
	}, [maxParallelTasks]);

	/**
	 * Move all backlog tasks to queue
	 */
	const handleQueueAll = useCallback(async () => {
		const backlogTasks = tasksByStatus.backlog;
		if (backlogTasks.length === 0) return;

		let movedCount = 0;
		for (const task of backlogTasks) {
			const result = await persistTaskStatus(task.id, "queue");
			if (result.success) {
				movedCount++;
			} else {
				console.error(
					`[Queue] Failed to move task ${task.id} to queue:`,
					result.error,
				);
			}
		}

		// Auto-promote queued tasks to fill available capacity
		await processQueue();

		toast({
			title: t("queue.queueAllSuccess", { count: movedCount }),
			variant: "default",
		});
	}, [tasksByStatus.backlog, processQueue, toast, t]);

	/**
	 * Save queue settings (maxParallelTasks)
	 *
	 * Uses the stored ref value to ensure the save works even if tasks
	 * change while the modal is open.
	 */
	const handleSaveQueueSettings = useCallback(
		async (maxParallel: number) => {
			const savedProjectId = queueSettingsProjectIdRef.current || projectId;
			if (!savedProjectId) return;

			const success = await updateProjectSettings(savedProjectId, {
				maxParallelTasks: maxParallel,
			});
			if (success) {
				toast({
					title: t("queue.settings.saved"),
					variant: "default",
				});
			} else {
				toast({
					title: t("queue.settings.saveFailed"),
					description: t("queue.settings.retry"),
					variant: "destructive",
				});
			}
		},
		[projectId, toast, t],
	);

	// External drag detection (Azure DevOps + Jira) using native drag events
	useEffect(() => {
		const handleDragOver = (event: DragEvent) => {
			event.preventDefault();

			// Check if dragging external work items (Azure DevOps or Jira)
			const data = event.dataTransfer?.getData("application/json");

			if (data) {
				try {
					const parsed = JSON.parse(data);
					if (
						parsed.type === "azure-devops-workitems" ||
						parsed.type === "jira-workitems"
					) {
						setIsDraggingAzureDevOps(true);
						setDraggedAzureDevOpsItems(parsed.workItems || []);

						// Auto-scroll functionality
						const kanbanContainer = document.querySelector(
							".overflow-x-auto.overflow-y-hidden",
						);
						if (kanbanContainer) {
							const containerRect = kanbanContainer.getBoundingClientRect();
							const scrollThreshold = 50; // pixels from edge
							const scrollSpeed = 10; // pixels per frame

							const mouseX = event.clientX;

							// Check if mouse is near left edge
							if (mouseX <= containerRect.left + scrollThreshold) {
								kanbanContainer.scrollBy({
									left: -scrollSpeed,
									behavior: "auto",
								});
							}
							// Check if mouse is near right edge
							else if (mouseX >= containerRect.right - scrollThreshold) {
								kanbanContainer.scrollBy({
									left: scrollSpeed,
									behavior: "auto",
								});
							}
						}

						// Find the column we're over
						const target = event.target as HTMLElement;
						const columnElement = target.closest(
							"[data-column-status]",
						) as HTMLElement;

						if (columnElement) {
							const columnStatus = columnElement.dataset.columnStatus;
							if (columnStatus && isValidDropColumn(columnStatus)) {
								setOverColumnId(columnStatus);
								if (event.dataTransfer) {
									event.dataTransfer.dropEffect = IMPORT_ALLOWED_COLUMNS.has(
										columnStatus,
									)
										? "copy"
										: "none";
								}
							} else {
								setOverColumnId(null);
							}
						}
					}
				} catch (error) {
					console.error("[Import] Error parsing drag data:", error);
				}
			}
		};

		/**
		 * Find the target column element from a drop event using coordinate-based detection
		 * with DOM traversal fallback.
		 */
		const findTargetColumn = (event: DragEvent): HTMLElement | null => {
			const target = event.target as HTMLElement;
			const mouseX = event.clientX;
			const mouseY = event.clientY;

			// Method 1: Coordinate-based detection (most reliable for drag & drop)
			const allColumns = document.querySelectorAll("[data-column-status]");

			for (const column of allColumns) {
				const rect = column.getBoundingClientRect();
				const buffer = 5;
				if (
					mouseX >= rect.left - buffer &&
					mouseX <= rect.right + buffer &&
					mouseY >= rect.top - buffer &&
					mouseY <= rect.bottom + buffer
				) {
					return column as HTMLElement;
				}
			}

			// Method 2: Fallback to DOM traversal
			const fromClosest = target.closest("[data-column-status]");
			if (fromClosest) return fromClosest as HTMLElement;

			let currentElement = target.parentElement;
			while (currentElement) {
				if (currentElement.dataset.columnStatus !== undefined) {
					return currentElement;
				}
				currentElement = currentElement.parentElement;
			}

			return null;
		};

		const handleDrop = async (event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const data = event.dataTransfer?.getData("application/json");
			if (!data) return;

			try {
				const parsed = JSON.parse(data);

				const isAdo =
					parsed.type === "azure-devops-workitems" &&
					parsed.workItems?.length > 0;
				const isJira =
					parsed.type === "jira-workitems" && parsed.workItems?.length > 0;

				if (isAdo || isJira) {
					const columnElement = findTargetColumn(event) as HTMLElement;

					if (columnElement) {
						const columnStatus = columnElement.dataset.columnStatus;

						if (
							columnStatus &&
							isValidDropColumn(columnStatus) &&
							IMPORT_ALLOWED_COLUMNS.has(columnStatus)
						) {
							// Show the import confirmation dialog
							setImportConfirmDialog({
								open: true,
								workItems: parsed.workItems,
								targetColumn: columnStatus,
								isImporting: false,
								source: isJira ? "jira" : "azure-devops",
							});
						}
					}
				}
			} catch (error) {
				console.error("[Import] Failed to handle drop:", error);
				toast({
					title: t("settings:azureDevOpsImport.importError"),
					description:
						error instanceof Error
							? error.message
							: t("common:errors.unknownError"),
					variant: "destructive",
				});
			} finally {
				setIsDraggingAzureDevOps(false);
				setDraggedAzureDevOpsItems([]);
				setOverColumnId(null);
			}
		};

		const handleDragEnd = () => {
			setIsDraggingAzureDevOps(false);
			setDraggedAzureDevOpsItems([]);
			setOverColumnId(null);
		};

		// Add global event listeners
		document.addEventListener("dragover", handleDragOver);
		document.addEventListener("drop", handleDrop);
		document.addEventListener("dragend", handleDragEnd);

		return () => {
			document.removeEventListener("dragover", handleDragOver);
			document.removeEventListener("drop", handleDrop);
			document.removeEventListener("dragend", handleDragEnd);
		};
	}, [toast, t]);

	// Simple Jira drag highlighting using custom events
	useEffect(() => {
		let isExternalDragging = false;

		const handleExternalDragStart = (event: Event) => {
			const customEvent = event as CustomEvent;
			isExternalDragging = true;
			setIsDraggingAzureDevOps(true);
			setDraggedAzureDevOpsItems(customEvent.detail.workItems || []);
		};

		const handleDragOver = (event: DragEvent) => {
			if (!isExternalDragging) return;

			event.preventDefault();

			const mouseX = event.clientX;
			const mouseY = event.clientY;
			const allColumns = document.querySelectorAll("[data-column-status]");

			// Auto-scroll functionality
			const kanbanContainer = document.querySelector(
				".overflow-x-auto.overflow-y-hidden",
			);
			if (kanbanContainer) {
				const containerRect = kanbanContainer.getBoundingClientRect();
				const scrollThreshold = 50; // pixels from edge
				const scrollSpeed = 10; // pixels per frame

				// Check if mouse is near left edge
				if (mouseX <= containerRect.left + scrollThreshold) {
					kanbanContainer.scrollBy({
						left: -scrollSpeed,
						behavior: "auto",
					});
				}
				// Check if mouse is near right edge
				else if (mouseX >= containerRect.right - scrollThreshold) {
					kanbanContainer.scrollBy({
						left: scrollSpeed,
						behavior: "auto",
					});
				}
			}

			let foundColumn = false;
			for (const column of allColumns) {
				const rect = column.getBoundingClientRect();
				const buffer = 20;
				if (
					mouseX >= rect.left - buffer &&
					mouseX <= rect.right + buffer &&
					mouseY >= rect.top - buffer &&
					mouseY <= rect.bottom + buffer
				) {
					const columnStatus = (column as HTMLElement).dataset.columnStatus;
					if (columnStatus && isValidDropColumn(columnStatus)) {
						setOverColumnId(columnStatus);
						if (event.dataTransfer) {
							event.dataTransfer.dropEffect = IMPORT_ALLOWED_COLUMNS.has(
								columnStatus,
							)
								? "copy"
								: "none";
						}
						foundColumn = true;
					}
					break;
				}
			}

			if (!foundColumn) {
				setOverColumnId(null);
			}
		};

		const handleExternalDragEnd = () => {
			isExternalDragging = false;
			setIsDraggingAzureDevOps(false);
			setDraggedAzureDevOpsItems([]);
			setOverColumnId(null);
		};

		document.addEventListener("jira-drag-start", handleExternalDragStart);
		document.addEventListener(
			"azure-devops-drag-start",
			handleExternalDragStart,
		);
		document.addEventListener("dragover", handleDragOver);
		document.addEventListener("jira-drag-end", handleExternalDragEnd);
		document.addEventListener("azure-devops-drag-end", handleExternalDragEnd);

		return () => {
			document.removeEventListener("jira-drag-start", handleExternalDragStart);
			document.removeEventListener(
				"azure-devops-drag-start",
				handleExternalDragStart,
			);
			document.removeEventListener("dragover", handleDragOver);
			document.removeEventListener("jira-drag-end", handleExternalDragEnd);
			document.removeEventListener(
				"azure-devops-drag-end",
				handleExternalDragEnd,
			);
		};
	}, []);

	// Register task status change listener for queue auto-promotion
	// This ensures processQueue() is called whenever a task leaves in_progress
	useEffect(() => {
		const unregister = useTaskStore
			.getState()
			.registerTaskStatusChangeListener((_taskId, oldStatus, newStatus) => {
				// When a task leaves in_progress (e.g., goes to human_review), process the queue
				if (oldStatus === "in_progress" && newStatus !== "in_progress") {
					processQueue();
				}
			});

		// Cleanup: unregister listener when component unmounts
		return unregister;
	}, [processQueue]);

	// Get task order actions from store
	const reorderTasksInColumn = useTaskStore(
		(state) => state.reorderTasksInColumn,
	);
	const moveTaskToColumnTop = useTaskStore(
		(state) => state.moveTaskToColumnTop,
	);
	const saveTaskOrderToStorage = useTaskStore((state) => state.saveTaskOrder);
	const loadTaskOrder = useTaskStore((state) => state.loadTaskOrder);
	const setTaskOrder = useTaskStore((state) => state.setTaskOrder);

	const saveTaskOrder = useCallback(
		(projectIdToSave: string) => {
			const success = saveTaskOrderToStorage(projectIdToSave);
			if (!success) {
				toast({
					title: t("kanban.orderSaveFailedTitle"),
					description: t("kanban.orderSaveFailedDescription"),
					variant: "destructive",
				});
			}
			return success;
		},
		[saveTaskOrderToStorage, toast, t],
	);

	// Load task order on mount and when project changes
	useEffect(() => {
		if (projectId) {
			loadTaskOrder(projectId);
		}
	}, [projectId, loadTaskOrder]);

	// Load kanban column preferences on mount and when project changes
	useEffect(() => {
		if (projectId) {
			loadKanbanPreferences(projectId);
		}
	}, [projectId, loadKanbanPreferences]);

	// Create a callback to toggle collapsed state and save to storage
	const handleToggleColumnCollapsed = useCallback(
		(status: (typeof TASK_STATUS_COLUMNS)[number]) => {
			// Capture projectId at function start to avoid stale closure in setTimeout
			const currentProjectId = projectId;
			toggleColumnCollapsed(status);
			// Save preferences after toggling
			if (currentProjectId) {
				// Use setTimeout to ensure state is updated before saving
				setTimeout(() => {
					saveKanbanPreferences(currentProjectId);
				}, 0);
			}
		},
		[toggleColumnCollapsed, saveKanbanPreferences, projectId],
	);

	// Create a callback to expand all collapsed columns and save to storage
	const handleExpandAll = useCallback(() => {
		// Capture projectId at function start to avoid stale closure in setTimeout
		const currentProjectId = projectId;
		// Expand all collapsed columns
		for (const status of TASK_STATUS_COLUMNS) {
			if (columnPreferences?.[status]?.isCollapsed) {
				setColumnCollapsed(status, false);
			}
		}
		// Save preferences after expanding
		if (currentProjectId) {
			setTimeout(() => {
				saveKanbanPreferences(currentProjectId);
			}, 0);
		}
	}, [columnPreferences, setColumnCollapsed, saveKanbanPreferences, projectId]);

	// Create a callback to toggle locked state and save to storage
	const handleToggleColumnLocked = useCallback(
		(status: (typeof TASK_STATUS_COLUMNS)[number]) => {
			// Capture projectId at function start to avoid stale closure in setTimeout
			const currentProjectId = projectId;
			toggleColumnLocked(status);
			// Save preferences after toggling
			if (currentProjectId) {
				// Use setTimeout to ensure state is updated before saving
				setTimeout(() => {
					saveKanbanPreferences(currentProjectId);
				}, 0);
			}
		},
		[toggleColumnLocked, saveKanbanPreferences, projectId],
	);

	// Resize handlers for column width adjustment
	const handleResizeStart = useCallback(
		(status: (typeof TASK_STATUS_COLUMNS)[number], startX: number) => {
			const currentWidth =
				columnPreferences?.[status]?.width ?? DEFAULT_COLUMN_WIDTH;
			resizeStartX.current = startX;
			resizeStartWidth.current = currentWidth;
			// Capture projectId at resize start to ensure we save to the correct project
			resizeProjectIdRef.current = projectId ?? null;
			setResizingColumn(status);
		},
		[columnPreferences, projectId],
	);

	const handleResizeMove = useCallback(
		(clientX: number) => {
			if (!resizingColumn) return;

			const deltaX = clientX - resizeStartX.current;
			const newWidth = Math.max(
				MIN_COLUMN_WIDTH,
				Math.min(MAX_COLUMN_WIDTH, resizeStartWidth.current + deltaX),
			);
			setColumnWidth(resizingColumn, newWidth);
		},
		[resizingColumn, setColumnWidth],
	);

	const handleResizeEnd = useCallback(() => {
		// Use the projectId captured at resize start to avoid saving to wrong project
		const savedProjectId = resizeProjectIdRef.current;
		if (resizingColumn && savedProjectId) {
			saveKanbanPreferences(savedProjectId);
		}
		setResizingColumn(null);
		resizeProjectIdRef.current = null;
	}, [resizingColumn, saveKanbanPreferences]);

	// Document-level event listeners for resize dragging
	useEffect(() => {
		if (!resizingColumn) return;

		const handleMouseMove = (e: MouseEvent) => {
			handleResizeMove(e.clientX);
		};

		const handleMouseUp = () => {
			handleResizeEnd();
		};

		const handleTouchMove = (e: TouchEvent) => {
			if (e.touches.length === 0) return;
			handleResizeMove(e.touches[0].clientX);
		};

		const handleTouchEnd = () => {
			handleResizeEnd();
		};

		// Prevent text selection and set resize cursor during drag
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		document.addEventListener("touchmove", handleTouchMove, { passive: false });
		document.addEventListener("touchend", handleTouchEnd);

		return () => {
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.removeEventListener("touchmove", handleTouchMove);
			document.removeEventListener("touchend", handleTouchEnd);
		};
	}, [resizingColumn, handleResizeMove, handleResizeEnd]);

	// Clean up stale task IDs from order when tasks change (e.g., after deletion)
	// This ensures the persisted order doesn't contain IDs for deleted tasks
	useEffect(() => {
		if (!projectId || !taskOrder) return;

		// Build a set of current task IDs for fast lookup
		const currentTaskIds = new Set(tasks.map((t) => t.id));

		// Check each column for stale IDs
		let hasStaleIds = false;
		const cleanedOrder: typeof taskOrder = {
			backlog: [],
			queue: [],
			in_progress: [],
			ai_review: [],
			human_review: [],
			build_failed: [],
			done: [],
			pr_created: [],
			error: [],
		};

		for (const status of Object.keys(taskOrder) as Array<
			keyof typeof taskOrder
		>) {
			const columnOrder = taskOrder[status] || [];
			const cleanedColumnOrder = columnOrder.filter((id) =>
				currentTaskIds.has(id),
			);

			cleanedOrder[status] = cleanedColumnOrder;

			// Check if any IDs were removed
			if (cleanedColumnOrder.length !== columnOrder.length) {
				hasStaleIds = true;
			}
		}

		// If stale IDs were found, update the order and persist
		if (hasStaleIds) {
			setTaskOrder(cleanedOrder);
			saveTaskOrder(projectId);
		}
	}, [tasks, taskOrder, projectId, setTaskOrder, saveTaskOrder]);

	const handleDragEnd = useCallback(
		async (event: DragEndEvent) => {
			const { active, over } = event;
			setActiveTask(null);
			setOverColumnId(null);
			setIsDraggingBulkSelected(false);
			setIsDraggingColumn(false);

			if (!over) return;

			const activeTaskId = active.id as string;
			const overId = over.id as string;

			// Handle column reordering
			if (activeTaskId.startsWith("col-") && overId.startsWith("col-")) {
				const activeStatus = activeTaskId.slice(
					4,
				) as (typeof TASK_STATUS_COLUMNS)[number];
				const overStatus = overId.slice(
					4,
				) as (typeof TASK_STATUS_COLUMNS)[number];
				if (activeStatus !== overStatus) {
					const currentOrder = useKanbanSettingsStore.getState().columnOrder;
					const oldIndex = currentOrder.indexOf(activeStatus);
					const newIndex = currentOrder.indexOf(overStatus);
					if (oldIndex !== -1 && newIndex !== -1) {
						const newOrder = arrayMove([...currentOrder], oldIndex, newIndex);
						setColumnOrder(newOrder, projectId ?? undefined);
					}
				}
				return;
			}

			// Determine target status
			let newStatus: TaskStatus | null = null;
			let oldStatus: TaskStatus | null = null;

			// Get the task being dragged (read from store to avoid stale closure)
			const task = useTaskStore
				.getState()
				.tasks.find((t) => t.id === activeTaskId);
			if (!task) return;
			oldStatus = task.status;

			// Check if dropped on a column
			if (isValidDropColumn(overId)) {
				newStatus = overId;
			} else {
				// Check if dropped on another task - move to that task's column
				const overTask = useTaskStore
					.getState()
					.tasks.find((t) => t.id === overId);
				if (overTask) {
					const task = useTaskStore
						.getState()
						.tasks.find((t) => t.id === activeTaskId);
					if (!task) return;

					// Compare visual columns
					const taskVisualColumn = getVisualColumn(task.status);
					const overTaskVisualColumn = getVisualColumn(overTask.status);

					// Same visual column: reorder within column
					if (taskVisualColumn === overTaskVisualColumn) {
						// Ensure both tasks are in the order array before reordering
						// This handles tasks that existed before ordering was enabled
						const currentColumnOrder = taskOrder?.[taskVisualColumn] ?? [];
						const activeInOrder = currentColumnOrder.includes(activeTaskId);
						const overInOrder = currentColumnOrder.includes(overId);

						if (!activeInOrder || !overInOrder) {
							// Sync the current visual order to the stored order
							const visualOrder = tasksByStatus[taskVisualColumn].map(
								(t) => t.id,
							);
							setTaskOrder({
								...taskOrder,
								[taskVisualColumn]: visualOrder,
							} as TaskOrderState);
						}

						// Reorder tasks within the same column using the visual column key
						reorderTasksInColumn(taskVisualColumn, activeTaskId, overId);

						if (projectId) {
							saveTaskOrder(projectId);
						}
						return;
					}

					// Different visual column: move to that task's column (status change)
					// Use the visual column key for ordering to ensure consistency
					newStatus = overTask.status;
					moveTaskToColumnTop(
						activeTaskId,
						overTaskVisualColumn,
						taskVisualColumn,
					);

					// Persist task order
					if (projectId) {
						saveTaskOrder(projectId);
					}
				}
			}

			if (!newStatus || newStatus === oldStatus) return;

			// ============================================
			// BULK DRAG: Move all selected tasks together
			// ============================================
			const isDraggedTaskInSelection =
				selectedTaskIds.has(activeTaskId) && selectedTaskIds.size > 1;
			if (isDraggedTaskInSelection) {
				const targetVisualColumn = getVisualColumn(newStatus);

				// Mixed selection: abort with warning
				if (selectedColumnStatus === null) {
					toast({
						title: t("kanban.mixedColumnWarning"),
						variant: "destructive",
					});
					return;
				}

				// Invalid transition: abort with toast
				if (
					!VALID_BULK_TRANSITIONS[selectedColumnStatus].includes(
						targetVisualColumn,
					)
				) {
					toast({
						title: t("kanban.invalidBulkTransition"),
						variant: "destructive",
					});
					return;
				}

				// human_review → done requires confirmation before opening BulkPRDialog
				if (
					selectedColumnStatus === "human_review" &&
					targetVisualColumn === "done"
				) {
					setBulkMarkDoneConfirmOpen(true);
					return;
				}

				// Valid transition: move all selected tasks
				await handleBulkMove(newStatus);
				return;
			}

			// ============================================
			// QUEUE SYSTEM: Enforce parallel task limit
			// ============================================
			if (newStatus === "in_progress") {
				// Get CURRENT state from store directly to avoid stale prop/memo issues during rapid dragging
				const currentTasks = useTaskStore.getState().tasks;
				const inProgressCount = currentTasks.filter(
					(t) => t.status === "in_progress" && !t.metadata?.archivedAt,
				).length;

				// If limit reached, move to queue instead
				if (inProgressCount >= maxParallelTasks) {
					// Only bypass the capacity check if coming from queue AND queue is NOT being processed
					// This prevents race condition where both auto-promotion and manual drag exceed the limit
					const isAutoPromotionInProgress =
						oldStatus === "queue" && isProcessingQueueRef.current;

					if (!isAutoPromotionInProgress) {
						newStatus = "queue";
					}
				}
			}

			// Mark task as manually queued to prevent auto-promotion back
			if (newStatus === "queue" && oldStatus === "in_progress") {
				manuallyQueuedTaskIdsRef.current.add(activeTaskId);
			}

			// Persist status change to file and update local state
			// Use handleStatusChange to properly handle worktree cleanup dialog
			await handleStatusChange(activeTaskId, newStatus, task);

			// Update task order for the new column - add task to top of new column
			const oldVisualColumn = getVisualColumn(oldStatus);
			const newVisualColumn = getVisualColumn(newStatus);

			if (oldVisualColumn !== newVisualColumn) {
				moveTaskToColumnTop(activeTaskId, newVisualColumn, oldVisualColumn);

				// Persist task order
				if (projectId) {
					saveTaskOrder(projectId);
				}
			}

			// ================================================
			// QUEUE SYSTEM: Auto-process queue when slot opens
			// ================================================
			if (oldStatus === "in_progress" && newStatus !== "in_progress") {
				// A task left In Progress - check if we can promote from queue
				await processQueue();
				// Clear manually queued protection after queue processing completes
				manuallyQueuedTaskIdsRef.current.delete(activeTaskId);
			}
		},
		[
			taskOrder,
			tasksByStatus,
			setTaskOrder,
			reorderTasksInColumn,
			moveTaskToColumnTop,
			saveTaskOrder,
			projectId,
			maxParallelTasks,
			handleStatusChange,
			processQueue,
			selectedTaskIds,
			selectedColumnStatus,
			handleBulkMove,
			toast,
			t,
			setColumnOrder,
		],
	);

	// Ajout ou correction de la déclaration de l'état pour la boîte de dialogue de paramètres projet
	// Ajout d'un compteur pour forcer le remount d'AppSettingsDialog
	const [settingsDialogKey, _setSettingsDialogKey] = useState(0);
	const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
	const [settingsDialogProjectId, _setSettingsDialogProjectId] = useState<
		string | undefined
	>(undefined);

	return (
		<div className="flex h-full flex-col">
			{/* Kanban header avec bouton paramètres projet */}
			<div className="flex items-center justify-between px-2 pt-4 pb-2">
				<div className="flex items-center gap-2">
					{onRefresh && (
						<Button
							variant="ghost"
							size="sm"
							onClick={onRefresh}
							disabled={isRefreshing}
							className="gap-2 text-muted-foreground hover:text-foreground"
						>
							<RefreshCw
								className={cn("h-4 w-4", isRefreshing && "animate-spin")}
							/>
							{isRefreshing
								? t("common:buttons.refreshing")
								: t("tasks:refreshTasks")}
						</Button>
					)}
					{/* Expand All button - appears when 3+ columns are collapsed */}
					{collapsedColumnCount >= 3 && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleExpandAll}
							className="gap-2 text-muted-foreground hover:text-foreground"
						>
							<ChevronsRight className="h-4 w-4" />
							{t("tasks:kanban.expandAll")}
						</Button>
					)}
					{/* Unified toolbar: search, filters, sort, and quick commands */}
					<KanbanToolbar projectPath={project?.path} />
				</div>
				<div className="flex items-center gap-2">
					{activeProjectId &&
						envConfig?.azureDevOpsEnabled && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								// If not configured at all (no PAT/org URL), redirect to settings
								if (
									!envConfig?.azureDevOpsPat &&
									!envConfig?.azureDevOpsOrgUrl &&
									onOpenAzureDevOpsSettings
								) {
									onOpenAzureDevOpsSettings();
								} else {
									setAzureDevOpsPanelOpen(true);
								}
							}}
							className="gap-2 text-muted-foreground hover:text-foreground"
							title={
								azureDevOpsConnected === false
									? t("tasks:kanban.azureDevOpsNotConnected")
									: "Import Azure DevOps Issues"
							}
						>
							<img
								src={AzureDevOpsLogo}
								alt="Azure DevOps"
								className="h-4 w-4"
							/>
							{envConfig?.azureDevOpsRepository || "Azure DevOps"}
							{azureDevOpsConnected === true && (
								<span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
							)}
							{azureDevOpsConnected === false && (
								<span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
							)}
						</Button>
					)}
					{activeProjectId &&
						envConfig?.jiraEnabled && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								// If not configured at all (no instance URL/token), redirect to settings
								if (
									!envConfig?.jiraInstanceUrl &&
									!envConfig?.jiraApiToken &&
									onOpenJiraSettings
								) {
									onOpenJiraSettings();
								} else {
									setJiraPanelOpen(true);
								}
							}}
							className="gap-2 text-muted-foreground hover:text-foreground"
							title={
								jiraConnected === false
									? t("tasks:kanban.jiraNotConnected")
									: "Import Jira Issues"
							}
						>
							<img src={JiraLogo} alt="Jira" className="h-4 w-4" />
							{envConfig?.jiraProjectKey || "Jira"}
							{jiraConnected === true && (
								<span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
							)}
							{jiraConnected === false && (
								<span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
							)}
						</Button>
					)}
				</div>
			</div>
			{/* Kanban columns */}
			<DndContext
				sensors={sensors}
				collisionDetection={closestCorners}
				onDragStart={handleDragStart}
				onDragOver={handleDragOver}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={columnOrder.map((s) => `col-${s}`)}
					strategy={horizontalListSortingStrategy}
				>
					<div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden min-h-0 p-2">
						{columnOrder.map((status) => (
							<SortableColumnWrapper
								key={status}
								sortableId={`col-${status}`}
								status={status}
								tasks={tasksByStatus[status]}
								onTaskClick={onTaskClick}
								onStatusChange={handleStatusChange}
								isOver={
									!isDraggingColumn &&
									overColumnId === status &&
									(!isDraggingAzureDevOps ||
										IMPORT_ALLOWED_COLUMNS.has(status)) &&
									(!isDraggingBulkSelected ||
										selectedColumnStatus === null ||
										VALID_BULK_TRANSITIONS[selectedColumnStatus].includes(
											status,
										))
								}
								isImportForbidden={
									!isDraggingColumn &&
									((isDraggingAzureDevOps &&
										overColumnId === status &&
										!IMPORT_ALLOWED_COLUMNS.has(status)) ||
										(isDraggingBulkSelected &&
											overColumnId === status &&
											selectedColumnStatus !== null &&
											!VALID_BULK_TRANSITIONS[selectedColumnStatus].includes(
												status,
											)))
								}
								onAddClick={status === "backlog" ? onNewTaskClick : undefined}
								onQueueAll={status === "backlog" ? handleQueueAll : undefined}
								onQueueSettings={
									status === "queue"
										? () => {
												if (!projectId) return;
												queueSettingsProjectIdRef.current = projectId;
												setShowQueueSettings(true);
											}
										: undefined
								}
								onArchiveAll={status === "done" ? handleArchiveAll : undefined}
								maxParallelTasks={
									status === "in_progress" ? maxParallelTasks : undefined
								}
								archivedCount={status === "done" ? archivedCount : undefined}
								showArchived={status === "done" ? showArchived : undefined}
								onToggleArchived={
									status === "done" ? toggleShowArchived : undefined
								}
								selectedTaskIds={selectedTaskIds}
								onSelectAll={() => selectAllTasks(status)}
								onDeselectAll={deselectAllTasks}
								onToggleSelect={toggleTaskSelection}
								onDeleteTask={handleDeleteTask}
								onDuplicateTask={handleDuplicateTask}
								onViewPRFiles={handleViewPRFiles}
								onPreviewApp={handlePreviewApp}
								isCollapsed={columnPreferences?.[status]?.isCollapsed}
								onToggleCollapsed={() => handleToggleColumnCollapsed(status)}
								columnWidth={columnPreferences?.[status]?.width}
								isResizing={resizingColumn === status}
								onResizeStart={(startX) => handleResizeStart(status, startX)}
								onResizeEnd={handleResizeEnd}
								isLocked={columnPreferences?.[status]?.isLocked}
								onToggleLocked={() => handleToggleColumnLocked(status)}
							/>
						))}
					</div>
				</SortableContext>

				{/* Drag overlay - enhanced visual feedback */}
				<DragOverlay>
					{activeTask ? (
						<div className="drag-overlay-card relative">
							<TaskCard
								task={activeTask}
								onClick={() => {
									/* noop */
								}}
							/>
							{isDraggingBulkSelected && (
								<div className="absolute -top-2 -right-2 flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-bold shadow-lg border-2 border-background">
									{selectedTaskIds.size}
								</div>
							)}
						</div>
					) : null}
				</DragOverlay>
			</DndContext>

			{selectedTaskIds.size > 0 && (
				<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
					<div className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border bg-card shadow-lg backdrop-blur-sm">
						<span className="text-sm font-medium text-foreground">
							{t("kanban.selectedCountOther", { count: selectedTaskIds.size })}
						</span>
						<div className="w-px h-5 bg-border" />

						{/* Context-sensitive move actions based on selected column */}
						{selectedColumnStatus === null ? (
							<span className="text-xs text-muted-foreground flex items-center gap-1.5">
								<Ban className="h-3.5 w-3.5" />
								{t("kanban.mixedColumnWarning")}
							</span>
						) : selectedColumnStatus === "backlog" ? (
							<>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("queue")}
								>
									<ChevronRight className="h-4 w-4" />
									{t("columns.queue")}
								</Button>
								<Button
									variant="default"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("in_progress")}
								>
									<ChevronsRight className="h-4 w-4" />
									{t("columns.in_progress")}
								</Button>
							</>
						) : selectedColumnStatus === "queue" ? (
							<>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("backlog")}
								>
									<ChevronLeft className="h-4 w-4" />
									{t("columns.backlog")}
								</Button>
								<Button
									variant="default"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("in_progress")}
								>
									<ChevronsRight className="h-4 w-4" />
									{t("columns.in_progress")}
								</Button>
							</>
						) : selectedColumnStatus === "in_progress" ? (
							<>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("queue")}
								>
									<ChevronLeft className="h-4 w-4" />
									{t("columns.queue")}
								</Button>
								<Button
									variant="default"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("ai_review")}
								>
									<ChevronsRight className="h-4 w-4" />
									{t("columns.ai_review")}
								</Button>
							</>
						) : selectedColumnStatus === "ai_review" ? (
							<>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("in_progress")}
								>
									<ChevronLeft className="h-4 w-4" />
									{t("columns.in_progress")}
								</Button>
								<Button
									variant="default"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("human_review")}
								>
									<ChevronsRight className="h-4 w-4" />
									{t("columns.human_review")}
								</Button>
							</>
						) : selectedColumnStatus === "human_review" ? (
							<>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									onClick={() => handleBulkMove("ai_review")}
								>
									<ChevronLeft className="h-4 w-4" />
									{t("columns.ai_review")}
								</Button>
								<Button
									variant="default"
									size="sm"
									className="gap-2"
									onClick={() => setBulkMarkDoneConfirmOpen(true)}
								>
									<CheckCheck className="h-4 w-4" />
									{t("kanban.markAsDone")}
								</Button>
							</>
						) : selectedColumnStatus === "done" ? (
							<Button
								variant="default"
								size="sm"
								className="gap-2"
								onClick={handleOpenBulkPRDialog}
							>
								<GitPullRequest className="h-4 w-4" />
								{t("kanban.createPRs")}
							</Button>
						) : null}

						<div className="w-px h-5 bg-border" />
						<Button
							variant="ghost"
							size="sm"
							className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
							onClick={handleOpenDeleteConfirm}
						>
							<Trash2 className="h-4 w-4" />
							{t("kanban.deleteSelected")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="gap-2 text-muted-foreground hover:text-foreground"
							onClick={deselectAllTasks}
						>
							<X className="h-4 w-4" />
							{t("kanban.clearSelection")}
						</Button>
					</div>
				</div>
			)}

			{/* Bulk "mark as done" confirmation dialog (human_review → done + PR creation) */}
			<AlertDialog
				open={bulkMarkDoneConfirmOpen}
				onOpenChange={setBulkMarkDoneConfirmOpen}
			>
				<AlertDialogPortal>
					<AlertDialogOverlay className="bg-black/60 backdrop-blur-md" />
					<AlertDialogContent className="fixed left-[50%] top-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] border-0 bg-linear-to-br from-slate-900/95 to-slate-800/95 backdrop-blur-xl shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] duration-300">
						<div className="absolute inset-0 rounded-2xl bg-linear-to-r from-emerald-500/20 via-green-500/20 to-emerald-500/20 p-px">
							<div className="h-full w-full rounded-2xl bg-slate-900/95" />
						</div>
						<div className="relative z-10 p-8">
							<AlertDialogHeader className="text-center space-y-4">
								<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-linear-to-br from-emerald-500/20 to-emerald-600/30 p-px">
									<div className="flex h-full w-full items-center justify-center rounded-full bg-slate-900/90">
										<CheckCheck className="h-8 w-8 text-emerald-400" />
									</div>
								</div>
								<AlertDialogTitle className="text-2xl font-bold text-white">
									{t("kanban.markAsDoneConfirmTitle")}
								</AlertDialogTitle>
								<AlertDialogDescription className="text-base text-slate-300 leading-relaxed">
									{t("kanban.markAsDoneConfirmDescription", {
										count: selectedTaskIds.size,
									})}
								</AlertDialogDescription>
							</AlertDialogHeader>

							{/* Task list preview */}
							<div className="mt-6 space-y-3">
								<div className="flex items-center justify-between">
									<span className="text-sm font-semibold text-slate-200">
										{t("kanban.tasksToComplete")}
									</span>
									<span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-300">
										{selectedTaskIds.size}{" "}
										{selectedTaskIds.size === 1 ? "tâche" : "tâches"}
									</span>
								</div>
								<ScrollArea className="h-32 rounded-xl border border-slate-700/50 bg-slate-800/50 p-3 backdrop-blur-sm">
									<div className="space-y-2">
										{selectedTasks.map((task) => (
											<div
												key={task.id}
												className="group flex items-center gap-3 rounded-lg bg-slate-700/30 px-3 py-2.5 text-sm transition-all hover:bg-slate-700/50"
											>
												<div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600/30 text-xs font-medium text-emerald-300">
													{selectedTasks.indexOf(task) + 1}
												</div>
												<span className="flex-1 truncate text-slate-200">
													{task.title}
												</span>
												<CheckCheck className="h-4 w-4 text-emerald-400/60 opacity-0 transition-opacity group-hover:opacity-100" />
											</div>
										))}
									</div>
								</ScrollArea>
							</div>

							{/* Info message */}
							<div className="mt-6 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 backdrop-blur-sm">
								<div className="flex items-start gap-3">
									<div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
										<GitPullRequest className="h-3 w-3 text-emerald-400" />
									</div>
									<p className="text-sm font-medium text-emerald-300 leading-relaxed">
										{t("kanban.markAsDoneConfirmInfo")}
									</p>
								</div>
							</div>

							<AlertDialogFooter className="mt-8 gap-3">
								<AlertDialogCancel className="flex-1 rounded-xl border border-slate-600/50 bg-slate-700/50 text-slate-200 backdrop-blur-sm transition-all hover:bg-slate-700/70 hover:border-slate-500/50 hover:text-white">
									{t("common:buttons.cancel")}
								</AlertDialogCancel>
								<AlertDialogAction
									onClick={handleBulkMarkDoneConfirm}
									className="flex-1 rounded-xl border-0 bg-linear-to-r from-emerald-500 to-emerald-600 text-white font-semibold shadow-lg transition-all hover:from-emerald-600 hover:to-emerald-700 hover:shadow-emerald-500/25 hover:shadow-xl"
								>
									<CheckCheck className="h-4 w-4 mr-2" />
									{t("kanban.markAsDoneConfirmButton")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</div>
					</AlertDialogContent>
				</AlertDialogPortal>
			</AlertDialog>

			{/* Delete confirmation dialog */}
			<AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
				<AlertDialogPortal>
					<AlertDialogOverlay className="bg-black/60 backdrop-blur-md" />
					<AlertDialogContent className="fixed left-[50%] top-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] border-0 bg-linear-to-br from-slate-900/95 to-slate-800/95 backdrop-blur-xl shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] duration-300">
						<div className="absolute inset-0 rounded-2xl bg-linear-to-r from-red-500/20 via-orange-500/20 to-red-500/20 p-px">
							<div className="h-full w-full rounded-2xl bg-slate-900/95" />
						</div>
						<div className="relative z-10 p-8">
							<AlertDialogHeader className="text-center space-y-4">
								{/* Icon with animated background */}
								<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-linear-to-br from-red-500/20 to-red-600/30 p-px">
									<div className="flex h-full w-full items-center justify-center rounded-full bg-slate-900/90">
										<Trash2 className="h-8 w-8 text-red-400" />
									</div>
								</div>

								<AlertDialogTitle className="text-2xl font-bold text-white">
									{t("kanban.deleteConfirmTitle")}
								</AlertDialogTitle>

								<AlertDialogDescription className="text-base text-slate-300 leading-relaxed">
									{t("kanban.deleteConfirmDescription")}
								</AlertDialogDescription>
							</AlertDialogHeader>

							{/* Enhanced Task List Preview */}
							<div className="mt-6 space-y-3">
								<div className="flex items-center justify-between">
									{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
									<label className="text-sm font-semibold text-slate-200">
										{t("kanban.tasksToDelete")}
									</label>
									<span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-medium text-red-300">
										{selectedTaskIds.size}{" "}
										{selectedTaskIds.size === 1 ? "tâche" : "tâches"}
									</span>
								</div>
								<ScrollArea className="h-32 rounded-xl border border-slate-700/50 bg-slate-800/50 p-3 backdrop-blur-sm">
									<div className="space-y-2">
										{selectedTasks.map((task, idx) => (
											<div
												key={task.id}
												className="group flex items-center gap-3 rounded-lg bg-slate-700/30 px-3 py-2.5 text-sm transition-all hover:bg-slate-700/50"
											>
												<div className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-600/50 text-xs font-medium text-slate-300">
													{idx + 1}
												</div>
												<span className="flex-1 truncate text-slate-200">
													{task.title}
												</span>
												<Trash2 className="h-4 w-4 text-red-400/60 opacity-0 transition-opacity group-hover:opacity-100" />
											</div>
										))}
									</div>
								</ScrollArea>
							</div>

							{/* Enhanced Warning message */}
							<div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/5 p-4 backdrop-blur-sm">
								<div className="flex items-start gap-3">
									<div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/20">
										<span className="text-xs font-bold text-red-400">!</span>
									</div>
									<p className="text-sm font-medium text-red-300 leading-relaxed">
										{t("kanban.deleteWarning")}
									</p>
								</div>
							</div>

							<AlertDialogFooter className="mt-8 gap-3">
								<AlertDialogCancel
									disabled={isDeleting}
									className="flex-1 rounded-xl border border-slate-600/50 bg-slate-700/50 text-slate-200 backdrop-blur-sm transition-all hover:bg-slate-700/70 hover:border-slate-500/50 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
								>
									{t("common:buttons.cancel")}
								</AlertDialogCancel>
								<AlertDialogAction
									onClick={handleConfirmDelete}
									disabled={isDeleting}
									className="flex-1 rounded-xl border-0 bg-linear-to-r from-red-500 to-red-600 text-white font-semibold shadow-lg transition-all hover:from-red-600 hover:to-red-700 hover:shadow-red-500/25 hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
								>
									{isDeleting ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("common:buttons.deleting")}
										</>
									) : (
										<>
											<Trash2 className="h-4 w-4 mr-2" />
											{t("kanban.deleteConfirmButton", {
												count: selectedTaskIds.size,
											})}
										</>
									)}
								</AlertDialogAction>
							</AlertDialogFooter>
						</div>
					</AlertDialogContent>
				</AlertDialogPortal>
			</AlertDialog>

			{/* Duplicate task dialog — edit fields before creating the copy */}
			{duplicateSource && (
				<TaskEditDialog
					mode="duplicate"
					task={duplicateSource}
					open={!!duplicateSource}
					onOpenChange={(open) => {
						if (!open) setDuplicateSource(null);
					}}
					onCreated={handleDuplicateCreated}
				/>
			)}

			{/* Single task delete confirmation dialog */}
			<AlertDialog
				open={singleDeleteConfirm.open}
				onOpenChange={(open) =>
					setSingleDeleteConfirm((prev) => ({ ...prev, open }))
				}
			>
				<AlertDialogContent className="sm:max-w-[425px]">
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2 text-destructive">
							<Trash2 className="h-5 w-5" />
							{t("tasks:confirmDelete.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("tasks:confirmDelete.description", {
								title: singleDeleteConfirm.taskTitle,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>

					{/* Warning message */}
					<div className="text-sm text-destructive space-y-2 mt-4">
						<p>{t("tasks:confirmDelete.irreversibleAction")}</p>
						<p>{t("tasks:confirmDelete.warning")}</p>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel>
							{t("tasks:confirmDelete.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmSingleDelete}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{t("tasks:confirmDelete.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Worktree cleanup confirmation dialog */}
			<WorktreeCleanupDialog
				open={worktreeCleanupDialog.open}
				taskTitle={worktreeCleanupDialog.taskTitle}
				worktreePath={worktreeCleanupDialog.worktreePath}
				isProcessing={worktreeCleanupDialog.isProcessing}
				error={worktreeCleanupDialog.error}
				onOpenChange={(open) => {
					if (!open && !worktreeCleanupDialog.isProcessing) {
						setWorktreeCleanupDialog((prev) => ({
							...prev,
							open: false,
							error: undefined,
						}));
					}
				}}
				onConfirm={handleWorktreeCleanupConfirm}
			/>

			{/* Queue Settings Modal */}
			{(queueSettingsProjectIdRef.current || projectId) && (
				<QueueSettingsModal
					open={showQueueSettings}
					onOpenChange={(open) => {
						setShowQueueSettings(open);
						if (!open) {
							queueSettingsProjectIdRef.current = null;
						}
					}}
					currentMaxParallel={maxParallelTasks}
					onSave={handleSaveQueueSettings}
				/>
			)}

			<BulkPRDialog
				open={bulkPRDialogOpen}
				tasks={selectedTasks}
				onOpenChange={setBulkPRDialogOpen}
				onComplete={handleBulkPRComplete}
			/>

			{/* Boîte de dialogue paramètres projet (AppSettingsDialog) */}
			{project && settingsDialogProjectId && (
				<AppSettingsDialog
					key={settingsDialogKey + settingsDialogProjectId}
					open={!!isProjectSettingsOpen}
					onOpenChange={setIsProjectSettingsOpen}
					initialProjectSection="general"
					initialProjectId={settingsDialogProjectId}
				/>
			)}

			{/* Azure DevOps Import Panel */}
			{projectId && (
				<AzureDevOpsSidePanel
					open={azureDevOpsPanelOpen}
					onOpenChange={setAzureDevOpsPanelOpen}
					projectId={projectId}
					onOpenSettings={onOpenAzureDevOpsSettings}
					onWorkItemsImported={async (workItems, targetStatus) => {
						// Show the import confirmation dialog
						setImportConfirmDialog({
							open: true,
							workItems,
							targetColumn: targetStatus,
							isImporting: false,
							source: "azure-devops",
						});
					}}
				/>
			)}

			{/* Jira Import Panel */}
			{projectId && (
				<JiraSidePanel
					open={jiraPanelOpen}
					onOpenChange={setJiraPanelOpen}
					projectId={projectId}
					onOpenSettings={onOpenJiraSettings}
					onWorkItemsImported={async (workItems, targetStatus) => {
						// Show the import confirmation dialog
						setImportConfirmDialog({
							open: true,
							workItems,
							targetColumn: targetStatus,
							isImporting: false,
							source: "jira",
						});
					}}
				/>
			)}

			{/* Import Confirmation Dialog (Azure DevOps / Jira drag & drop) */}
			<ImportConfirmDialog
				open={importConfirmDialog.open}
				onOpenChange={(open) => {
					if (!open) {
						setImportConfirmDialog({
							open: false,
							workItems: [],
							targetColumn: null,
							isImporting: false,
							source: null,
						});
					}
				}}
				workItems={importConfirmDialog.workItems}
				targetColumn={importConfirmDialog.targetColumn}
				isImporting={importConfirmDialog.isImporting}
				onConfirm={handleImportConfirm}
				onCancel={() => {
					// Close the side panel when user cancels the import dialog
					setAzureDevOpsPanelOpen(false);
					setJiraPanelOpen(false);
				}}
			/>

			{/* PR Files Modal */}
			<PRFilesModal
				open={prFilesModalOpen}
				onOpenChange={setPrFilesModalOpen}
				prUrl={selectedPRUrl}
				taskId={selectedTaskId}
			/>
		</div>
	);
}
