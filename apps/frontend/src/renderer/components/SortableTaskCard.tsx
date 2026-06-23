import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus } from "../../shared/types";
import {
	formatAgingDuration,
	getTaskAgingHours,
	getTaskAgingLevel,
} from "../lib/kanban-aging";
import { cn } from "../lib/utils";
import { TaskCard } from "./TaskCard";

interface SortableTaskCardProps {
	task: Task;
	onClick: () => void;
	onStatusChange?: (newStatus: TaskStatus) => unknown;
	onDelete?: () => void;
	onDuplicate?: () => void;
	onViewPRFiles?: (prUrl: string, taskId: string) => void;
	onPreviewApp?: () => void;
	// Optional selection props for multi-selection in Human Review column
	isSelectable?: boolean;
	isSelected?: boolean;
	onToggleSelect?: () => void;
}

// Custom comparator - only re-render when task or onClick actually changed
function sortableTaskCardPropsAreEqual(
	prevProps: SortableTaskCardProps,
	nextProps: SortableTaskCardProps,
): boolean {
	// TaskCard has its own memo, so we just need to check reference equality
	// for the task object and onClick handler
	return (
		prevProps.task === nextProps.task &&
		prevProps.onClick === nextProps.onClick &&
		prevProps.onStatusChange === nextProps.onStatusChange &&
		prevProps.isSelectable === nextProps.isSelectable &&
		prevProps.isSelected === nextProps.isSelected &&
		prevProps.onToggleSelect === nextProps.onToggleSelect &&
		prevProps.onDelete === nextProps.onDelete &&
		prevProps.onDuplicate === nextProps.onDuplicate &&
		prevProps.onViewPRFiles === nextProps.onViewPRFiles &&
		prevProps.onPreviewApp === nextProps.onPreviewApp
	);
}

export const SortableTaskCard = memo(function SortableTaskCard({
	task,
	onClick,
	onStatusChange,
	onDelete,
	onDuplicate,
	onViewPRFiles,
	onPreviewApp,
	isSelectable,
	isSelected,
	onToggleSelect,
}: SortableTaskCardProps) {
	const { t } = useTranslation(["tasks"]);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
		isOver,
	} = useSortable({ id: task.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		// Prevent z-index stacking issues during drag
		zIndex: isDragging ? 50 : undefined,
	};

	// Aging heat: a left accent flags cards that have idled too long in an
	// actionable column. Hidden while dragging to keep the overlay clean.
	const agingLevel = isDragging ? "none" : getTaskAgingLevel(task);
	const agingLabel =
		agingLevel === "none"
			? undefined
			: t("kanban.aging.idleFor", {
					duration: formatAgingDuration(getTaskAgingHours(task)),
				});

	// Memoize onClick to prevent unnecessary TaskCard re-renders
	const handleClick = useCallback(() => {
		onClick();
	}, [onClick]);

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"relative touch-none transition-all duration-200",
				isDragging && "dragging-placeholder opacity-40 scale-[0.98]",
				isOver &&
					!isDragging &&
					"ring-2 ring-primary/30 ring-offset-2 ring-offset-background rounded-xl",
			)}
			{...attributes}
			{...listeners}
		>
			{agingLevel !== "none" && (
				<span
					role="img"
					title={agingLabel}
					aria-label={agingLabel}
					className={cn(
						"pointer-events-none absolute left-0 top-2 bottom-2 z-10 w-1 rounded-full",
						agingLevel === "stuck"
							? "bg-destructive/80"
							: "bg-amber-500/70",
					)}
				/>
			)}
			<TaskCard
				task={task}
				onClick={handleClick}
				onStatusChange={onStatusChange}
				isSelectable={isSelectable}
				isSelected={isSelected}
				onToggleSelect={onToggleSelect}
				onDelete={onDelete}
				onDuplicate={onDuplicate}
				onViewPRFiles={onViewPRFiles}
				onPreviewApp={onPreviewApp}
			/>
		</div>
	);
}, sortableTaskCardPropsAreEqual);
