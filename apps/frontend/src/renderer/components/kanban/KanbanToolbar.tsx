import {
	ArrowDownNarrowWide,
	ArrowUpNarrowWide,
	Bookmark,
	Check,
	Plus,
	SlidersHorizontal,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TASK_CATEGORY_COLORS,
	TASK_CATEGORY_LABELS,
	TASK_PRIORITY_COLORS,
	TASK_PRIORITY_LABELS,
} from "../../../shared/constants";
import type { TaskCategory, TaskPriority } from "../../../shared/types";
import {
	activeFilterCount,
	hasActiveFilters,
	type TaskSortField,
	TASK_SOURCES,
	type TaskSource,
} from "../../lib/kanban-filter";
import { cn } from "../../lib/utils";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { QuickCommandBar } from "./QuickCommandBar";

const CATEGORY_OPTIONS = Object.keys(TASK_CATEGORY_LABELS) as TaskCategory[];
const PRIORITY_OPTIONS = Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[];
const SORT_FIELDS: TaskSortField[] = [
	"manual",
	"priority",
	"created",
	"updated",
	"title",
];

interface FilterChipProps {
	label: string;
	active: boolean;
	onToggle: () => void;
	/** Tailwind classes applied when active — usually a color triplet. */
	activeClassName?: string;
}

/**
 * Toggleable pill. Muted when off, color-filled when on — far more scannable
 * than a column of checkboxes and lets a whole dimension fit on two rows.
 */
function FilterChip({ label, active, onToggle, activeClassName }: FilterChipProps) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={active}
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-all",
				active
					? cn(
							"shadow-sm",
							activeClassName ??
								"bg-primary/10 text-primary border-primary/40",
						)
					: "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
		>
			{active && <Check className="h-3 w-3 shrink-0" />}
			<span className="truncate">{label}</span>
		</button>
	);
}

interface FilterSectionProps {
	title: string;
	activeCount?: number;
	children: React.ReactNode;
}

function FilterSection({ title, activeCount, children }: FilterSectionProps) {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1.5 px-0.5">
				<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					{title}
				</span>
				{activeCount ? (
					<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[9px] font-bold text-primary tabular-nums">
						{activeCount}
					</span>
				) : null}
			</div>
			<div className="flex flex-wrap gap-1.5">{children}</div>
		</div>
	);
}

interface KanbanToolbarProps {
	projectPath?: string;
}

/**
 * Unified board toolbar: search, a single filter+sort panel (colored chips), and
 * the quick-command bar — grouped with vertical separators so each affordance
 * reads as its own zone rather than a flat row of mystery buttons.
 */
export function KanbanToolbar({ projectPath }: KanbanToolbarProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const filters = useKanbanFilterStore((s) => s.filters);
	const sort = useKanbanFilterStore((s) => s.sort);
	const setSearch = useKanbanFilterStore((s) => s.setSearch);
	const toggleSource = useKanbanFilterStore((s) => s.toggleSource);
	const toggleCategory = useKanbanFilterStore((s) => s.toggleCategory);
	const togglePriority = useKanbanFilterStore((s) => s.togglePriority);
	const setSortField = useKanbanFilterStore((s) => s.setSortField);
	const toggleSortDirection = useKanbanFilterStore((s) => s.toggleSortDirection);
	const clearFilters = useKanbanFilterStore((s) => s.clearFilters);
	const savedViews = useKanbanFilterStore((s) => s.savedViews);
	const saveCurrentView = useKanbanFilterStore((s) => s.saveCurrentView);
	const applyView = useKanbanFilterStore((s) => s.applyView);
	const deleteView = useKanbanFilterStore((s) => s.deleteView);
	const [viewName, setViewName] = useState("");

	const count = activeFilterCount(filters);
	const filtersActive = hasActiveFilters(filters);

	const commitSaveView = () => {
		if (!viewName.trim()) return;
		saveCurrentView(viewName);
		setViewName("");
	};

	const sourceLabel = (source: TaskSource): string =>
		t(`kanban.filter.sources.${source}`);
	const sortFieldLabel = (field: TaskSortField): string =>
		t(`kanban.sort.fields.${field}`);

	return (
		<div className="flex items-center gap-2 flex-wrap">
			{/* Search */}
			<div className="relative">
				<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
				<Input
					value={filters.search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t("kanban.filter.searchPlaceholder")}
					aria-label={t("kanban.filter.searchPlaceholder")}
					className="h-8 w-52 rounded-full pl-8 pr-7 text-sm bg-muted/40 border-transparent hover:bg-muted/60 focus-visible:bg-background transition-colors"
				/>
				{filters.search.length > 0 && (
					<button
						type="button"
						onClick={() => setSearch("")}
						aria-label={t("kanban.filter.clearSearch")}
						className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</div>

			<Separator orientation="vertical" className="h-5" />

			{/* Filter + Sort panel */}
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							"h-8 gap-2 rounded-full text-muted-foreground hover:text-foreground transition-colors",
							filtersActive &&
								"text-primary hover:text-primary bg-primary/10 hover:bg-primary/15",
						)}
						title={t("kanban.filter.title")}
					>
						<SlidersHorizontal className="h-4 w-4" />
						{t("kanban.filter.button")}
						{count > 0 && (
							<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground tabular-nums">
								{count}
							</span>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-[22rem] p-0 overflow-hidden">
					{/* Header */}
					<div className="flex items-center justify-between border-b border-border/60 bg-linear-to-br from-primary/5 to-transparent px-4 py-2.5">
						<div className="flex items-center gap-2">
							<SlidersHorizontal className="h-4 w-4 text-primary" />
							<h3 className="text-sm font-semibold">
								{t("kanban.filter.title")}
							</h3>
						</div>
						{filtersActive && (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
								onClick={clearFilters}
							>
								<X className="h-3 w-3" />
								{t("kanban.filter.clear")}
							</Button>
						)}
					</div>

					<div className="space-y-4 p-4">
						{/* Priority — short and high-value, so first */}
						<FilterSection
							title={t("kanban.filter.priorityLabel")}
							activeCount={filters.priorities.length}
						>
							{PRIORITY_OPTIONS.map((priority) => (
								<FilterChip
									key={priority}
									label={TASK_PRIORITY_LABELS[priority]}
									active={filters.priorities.includes(priority)}
									activeClassName={TASK_PRIORITY_COLORS[priority]}
									onToggle={() => togglePriority(priority)}
								/>
							))}
						</FilterSection>

						{/* Category */}
						<FilterSection
							title={t("kanban.filter.categoryLabel")}
							activeCount={filters.categories.length}
						>
							{CATEGORY_OPTIONS.map((category) => (
								<FilterChip
									key={category}
									label={TASK_CATEGORY_LABELS[category]}
									active={filters.categories.includes(category)}
									activeClassName={TASK_CATEGORY_COLORS[category]}
									onToggle={() => toggleCategory(category)}
								/>
							))}
						</FilterSection>

						{/* Source */}
						<FilterSection
							title={t("kanban.filter.sourceLabel")}
							activeCount={filters.sources.length}
						>
							{TASK_SOURCES.map((source) => (
								<FilterChip
									key={source}
									label={sourceLabel(source)}
									active={filters.sources.includes(source)}
									onToggle={() => toggleSource(source)}
								/>
							))}
						</FilterSection>

						<Separator />

						{/* Sort */}
						<FilterSection title={t("kanban.sort.title")}>
							<div className="flex w-full items-center gap-1.5">
								<div className="flex flex-1 flex-wrap gap-1.5">
									{SORT_FIELDS.map((field) => (
										<FilterChip
											key={field}
											label={sortFieldLabel(field)}
											active={sort.field === field}
											onToggle={() => setSortField(field)}
										/>
									))}
								</div>
								{sort.field !== "manual" && (
									<Button
										variant="outline"
										size="icon"
										className="h-7 w-7 shrink-0"
										onClick={toggleSortDirection}
										title={
											sort.direction === "asc"
												? t("kanban.sort.ascending")
												: t("kanban.sort.descending")
										}
									>
										{sort.direction === "asc" ? (
											<ArrowUpNarrowWide className="h-3.5 w-3.5" />
										) : (
											<ArrowDownNarrowWide className="h-3.5 w-3.5" />
										)}
									</Button>
								)}
							</div>
						</FilterSection>
					</div>
				</PopoverContent>
			</Popover>

			<Separator orientation="vertical" className="h-5" />

			{/* Saved views: named filter+sort presets */}
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-8 gap-2 rounded-full text-muted-foreground hover:text-foreground transition-colors"
						title={t("kanban.views.title")}
					>
						<Bookmark className="h-4 w-4" />
						{t("kanban.views.button")}
						{savedViews.length > 0 && (
							<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-bold leading-none tabular-nums">
								{savedViews.length}
							</span>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-72 p-0 overflow-hidden">
					<div className="flex items-center gap-2 border-b border-border/60 bg-linear-to-br from-primary/5 to-transparent px-4 py-2.5">
						<Bookmark className="h-4 w-4 text-primary" />
						<h3 className="text-sm font-semibold">
							{t("kanban.views.title")}
						</h3>
					</div>
					<div className="space-y-3 p-3">
						{savedViews.length === 0 ? (
							<p className="px-0.5 text-xs text-muted-foreground">
								{t("kanban.views.empty")}
							</p>
						) : (
							<div className="space-y-1">
								{savedViews.map((view) => (
									<div
										key={view.id}
										className="group flex items-center gap-1"
									>
										<button
											type="button"
											onClick={() => applyView(view.id)}
											className="flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors"
										>
											{view.name}
										</button>
										<Button
											variant="ghost"
											size="icon"
											className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
											onClick={() => deleteView(view.id)}
											aria-label={t("kanban.views.delete")}
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}
						<Separator />
						<div className="flex items-center gap-2">
							<Input
								value={viewName}
								onChange={(e) => setViewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitSaveView();
								}}
								placeholder={t("kanban.views.namePlaceholder")}
								aria-label={t("kanban.views.save")}
								className="h-8"
							/>
							<Button
								size="icon"
								className="h-8 w-8 shrink-0"
								disabled={!viewName.trim()}
								onClick={commitSaveView}
								aria-label={t("kanban.views.save")}
							>
								<Plus className="h-4 w-4" />
							</Button>
						</div>
					</div>
				</PopoverContent>
			</Popover>

			<Separator orientation="vertical" className="h-5" />

			{/* Quick Commands */}
			<QuickCommandBar
				projectPath={projectPath}
				className="h-8"
				variant="compact"
			/>
		</div>
	);
}
