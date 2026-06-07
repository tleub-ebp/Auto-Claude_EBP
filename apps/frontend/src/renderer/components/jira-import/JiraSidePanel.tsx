/**
 * Jira Side Panel Component
 * Provides a sliding panel for importing Jira issues with drag & drop
 * Mirrors the Azure DevOps Side Panel functionality
 */

import {
	ChevronLeft,
	ChevronRight,
	Download,
	GripVertical,
	RefreshCw,
	Search,
	Settings,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "../../../shared/types";
import type {
	JiraSyncStatus,
	JiraWorkItem,
} from "../../../shared/types/integrations";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface JiraSidePanelProps {
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onWorkItemsImported?: (
		workItems: JiraWorkItem[],
		targetStatus: TaskStatus,
	) => void;
	readonly onOpenSettings?: () => void;
}

interface JiraFilters {
	workItemType: string;
	state: string;
}

export function JiraSidePanel({
	projectId,
	open,
	onOpenChange,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	onWorkItemsImported,
	onOpenSettings,
}: JiraSidePanelProps) {
	const { t } = useTranslation("settings");
	const [workItems, setWorkItems] = useState<JiraWorkItem[]>([]);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchingRemote, setIsSearchingRemote] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);

	// G�rer la fermeture par clic en dehors du panel
	useEffect(() => {
		if (!open) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			// Don't close if clicking inside the panel
			if (panelRef.current?.contains(target)) return;
			// Don't close if clicking inside a dialog/alert dialog (e.g., ImportConfirmDialog portal)
			const targetEl =
				target instanceof Element ? target : target.parentElement;
			if (
				targetEl?.closest(
					'[role="alertdialog"], [role="dialog"], [data-radix-portal]',
				)
			)
				return;
			onOpenChange(false);
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open, onOpenChange]);
	const [filters, setFilters] = useState<JiraFilters>({
		workItemType: "all",
		state: "all",
	});

	const [isLoadingItems, setIsLoadingItems] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [syncStatus, setSyncStatus] = useState<JiraSyncStatus | null>(null);
	const [draggedIds, setDraggedIds] = useState<Set<string>>(new Set());
	const dragImageRef = useRef<HTMLDivElement | null>(null);
	const [panelWidth, setPanelWidth] = useState(384);
	const [isResizing, setIsResizing] = useState(false);
	const [isCollapsed, setIsCollapsed] = useState(false);
	const [lastCacheTime, setLastCacheTime] = useState<number>(0);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const resizeStartX = useRef(0);
	const resizeStartWidth = useRef(0);

	// Load saved panel width on component mount
	useEffect(() => {
		const loadSavedPanelWidth = () => {
			const savedWidth = localStorage.getItem(`jira-panel-width-${projectId}`);
			if (savedWidth) {
				const width = Number.parseInt(savedWidth, 10);
				if (!Number.isNaN(width) && width >= 320 && width <= 800) {
					setPanelWidth(width);
					setIsCollapsed(width <= 320);
				}
			}
		};

		if (projectId) {
			loadSavedPanelWidth();
		}
	}, [projectId]);

	// Save panel width when it changes (but not when collapsed)
	useEffect(() => {
		if (projectId && !isCollapsed) {
			localStorage.setItem(
				`jira-panel-width-${projectId}`,
				panelWidth.toString(),
			);
		}
	}, [panelWidth, projectId, isCollapsed]);

	const loadConnectionStatus = async () => {
		try {
			const result =
				await globalThis.electronAPI.checkJiraConnection(projectId);
			if (result.success) {
				setSyncStatus(result.data ?? null);
				if (!result.data?.connected) {
					setError(result.data?.error || "Jira not configured");
				}
			} else {
				setError(result.error || "Failed to check Jira connection");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		}
	};

	const loadWorkItems = async (forceRefresh = false) => {
		if (!forceRefresh && lastCacheTime) {
			const now = Date.now();
			const CACHE_DURATION = 5 * 60 * 1000;
			if (now - lastCacheTime < CACHE_DURATION) {
				return;
			}
		}

		setIsLoadingItems(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI.getJiraIssues(projectId, 100);

			if (result.success) {
				const workItems = result.data || [];
				setWorkItems(workItems);

				// Save to cache
				const cacheKey = `jira-workitems-cache-${projectId}`;
				const cacheTimeKey = `jira-workitems-cache-time-${projectId}`;
				const now = Date.now();

				localStorage.setItem(cacheKey, JSON.stringify(workItems));
				localStorage.setItem(cacheTimeKey, now.toString());
				setLastCacheTime(now);
			} else {
				setError(result.error || "Failed to load Jira issues");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsLoadingItems(false);
		}
	};

	// Load connection status
	useEffect(() => {
		if (open) {
			loadConnectionStatus();
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [open, loadConnectionStatus]);

	// Load cached work items on component mount
	useEffect(() => {
		const loadCachedWorkItems = () => {
			const cacheKey = `jira-workitems-cache-${projectId}`;
			const cacheTimeKey = `jira-workitems-cache-time-${projectId}`;

			const cachedData = localStorage.getItem(cacheKey);
			const cachedTime = localStorage.getItem(cacheTimeKey);

			if (cachedData && cachedTime) {
				const cacheTime = Number.parseInt(cachedTime, 10);
				const now = Date.now();
				const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

				if (now - cacheTime < CACHE_DURATION) {
					const workItems = JSON.parse(cachedData);
					setWorkItems(workItems);
					setLastCacheTime(cacheTime);
					return;
				}
			}
		};

		if (projectId) {
			loadCachedWorkItems();
		}
	}, [projectId]);

	// Load work items when panel opens (with cache logic)
	useEffect(() => {
		if (open && syncStatus?.connected) {
			const now = Date.now();
			const CACHE_DURATION = 5 * 60 * 1000;

			if (!lastCacheTime || now - lastCacheTime > CACHE_DURATION) {
				loadWorkItems();
			} else {
				// noop
			}
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [open, syncStatus?.connected, lastCacheTime, loadWorkItems]);

	const handleRefresh = () => {
		setSelectedIds(new Set());
		setSearchQuery("");
		setFilters({ workItemType: "all", state: "all" });

		setIsRefreshing(true);
		loadWorkItems(true).finally(() => {
			setIsRefreshing(false);
		});
	};

	// Filter work items
	const filteredItems = useMemo(() => {
		return workItems.filter((item) => {
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				const matchesSearch =
					item.title.toLowerCase().includes(query) ||
					item.id.toLowerCase().includes(query) ||
					item.description?.toLowerCase().includes(query);
				if (!matchesSearch) return false;
			}

			if (
				filters.workItemType !== "all" &&
				item.workItemType !== filters.workItemType
			) {
				return false;
			}

			if (filters.state !== "all" && item.state !== filters.state) {
				return false;
			}

			return true;
		});
	}, [workItems, searchQuery, filters]);

	// When the user searches a specific issue key (or a bare number when a
	// project key is known) that is not in the loaded list, fetch it directly
	// from Jira. This makes any issue findable by key — including sub-tasks,
	// custom types, and issues outside the (capped) listed window.
	useEffect(() => {
		const trimmed = searchQuery.trim();
		if (!trimmed || !syncStatus?.connected) return;

		let issueKey: string | null = null;
		if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmed)) {
			issueKey = trimmed.toUpperCase();
		} else if (/^\d+$/.test(trimmed) && syncStatus?.projectKey) {
			issueKey = `${syncStatus.projectKey}-${trimmed}`;
		}
		if (!issueKey) return;
		const targetKey = issueKey;
		if (workItems.some((item) => item.id.toUpperCase() === targetKey)) return;

		let cancelled = false;
		const handle = setTimeout(async () => {
			setIsSearchingRemote(true);
			try {
				const result = await globalThis.electronAPI.getJiraIssue(
					projectId,
					targetKey,
				);
				if (cancelled) return;
				if (result.success && result.data) {
					const fetched = result.data;
					setWorkItems((prev) =>
						prev.some((item) => item.id === fetched.id)
							? prev
							: [fetched, ...prev],
					);
				}
			} catch {
				// Best-effort: ignore lookup failures (invalid key, no access…).
			} finally {
				if (!cancelled) setIsSearchingRemote(false);
			}
		}, 400);

		return () => {
			cancelled = true;
			clearTimeout(handle);
			setIsSearchingRemote(false);
		};
	}, [
		searchQuery,
		workItems,
		projectId,
		syncStatus?.connected,
		syncStatus?.projectKey,
	]);

	// Get unique values for filters
	const uniqueTypes = useMemo(() => {
		return Array.from(new Set(workItems.map((item) => item.workItemType))).sort(
			(a, b) => a.localeCompare(b),
		);
	}, [workItems]);

	const uniqueStates = useMemo(() => {
		return Array.from(new Set(workItems.map((item) => item.state))).sort(
			(a, b) => a.localeCompare(b),
		);
	}, [workItems]);

	// Selection handlers
	const toggleItem = useCallback(
		(id: string) => {
			const newSelected = new Set(selectedIds);
			if (newSelected.has(id)) {
				newSelected.delete(id);
			} else {
				newSelected.add(id);
			}
			setSelectedIds(newSelected);
		},
		[selectedIds],
	);

	const selectAll = useCallback(() => {
		setSelectedIds(new Set(filteredItems.map((item) => item.id)));
	}, [filteredItems]);

	const deselectAll = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	const isAllSelected =
		filteredItems.length > 0 && selectedIds.size === filteredItems.length;
	const isSomeSelected =
		selectedIds.size > 0 && selectedIds.size < filteredItems.length;

	// Resize handlers
	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			setIsResizing(true);
			resizeStartX.current = e.clientX;
			resizeStartWidth.current = panelWidth;
		},
		[panelWidth],
	);

	const handleResizeMove = useCallback(
		(e: MouseEvent) => {
			if (!isResizing) return;

			const deltaX = resizeStartX.current - e.clientX;
			const newWidth = Math.min(
				Math.max(resizeStartWidth.current + deltaX, 320),
				800,
			);
			setPanelWidth(newWidth);
			setIsCollapsed(newWidth <= 320);
		},
		[isResizing],
	);

	const handleResizeEnd = useCallback(() => {
		setIsResizing(false);
	}, []);

	// Toggle collapse function
	const toggleCollapse = useCallback(() => {
		if (isCollapsed) {
			let restoredWidth = 384;
			const savedWidth = localStorage.getItem(`jira-panel-width-${projectId}`);
			if (savedWidth) {
				const width = Number.parseInt(savedWidth, 10);
				if (!Number.isNaN(width) && width >= 320 && width <= 800) {
					restoredWidth = width;
				}
			}

			setPanelWidth(restoredWidth);
			setIsCollapsed(false);
		} else {
			localStorage.setItem(
				`jira-panel-width-${projectId}`,
				panelWidth.toString(),
			);

			setPanelWidth(320);
			setIsCollapsed(true);
		}
	}, [isCollapsed, projectId, panelWidth]);

	// Add global mouse event listeners for resize
	useEffect(() => {
		if (isResizing) {
			document.addEventListener("mousemove", handleResizeMove);
			document.addEventListener("mouseup", handleResizeEnd);
			return () => {
				document.removeEventListener("mousemove", handleResizeMove);
				document.removeEventListener("mouseup", handleResizeEnd);
			};
		}
	}, [isResizing, handleResizeMove, handleResizeEnd]);

	// Drag handlers - uses 'jira-workitems' type to distinguish from Azure DevOps
	const handleDragStart = useCallback(
		(e: React.DragEvent, workItemIds: string[]) => {
			const itemsToDrag = workItemIds
				.map((id) => workItems.find((item) => item.id === id))
				.filter((item): item is JiraWorkItem => item !== undefined);

			const dragData = {
				type: "jira-workitems",
				workItems: itemsToDrag,
			};
			e.dataTransfer.setData("application/json", JSON.stringify(dragData));
			e.dataTransfer.effectAllowed = "copy";
			setDraggedIds(new Set(workItemIds));

			// Créer un ghost avec liseré pour le drag image
			const sourceEl = e.currentTarget as HTMLElement;
			const clone = sourceEl.cloneNode(true) as HTMLDivElement;
			clone.style.position = "absolute";
			clone.style.top = "-1000px";
			clone.style.left = "-1000px";
			clone.style.width = `${sourceEl.offsetWidth}px`;
			clone.style.outline = "2px solid var(--primary)";
			clone.style.outlineOffset = "2px";
			clone.style.borderRadius = "8px";
			clone.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
			clone.style.opacity = "0.95";
			clone.style.backgroundColor = "var(--card)";
			document.body.appendChild(clone);
			e.dataTransfer.setDragImage(clone, clone.offsetWidth / 2, 20);
			dragImageRef.current = clone;

			// Marquer le panel comme �tant en cours de drag
			const panelElement = panelRef.current;
			if (panelElement) {
				panelElement.dataset.dragging = "true";
			}

			const customEvent = new CustomEvent("jira-drag-start", {
				detail: dragData,
				bubbles: true,
				cancelable: true,
			});
			document.dispatchEvent(customEvent);
		},
		[workItems],
	);

	const handleDragEnd = useCallback(() => {
		setDraggedIds(new Set());

		// Nettoyer le ghost du drag image
		if (dragImageRef.current) {
			dragImageRef.current.remove();
			dragImageRef.current = null;
		}

		// Nettoyer l'attribut data-dragging
		const panelElement = panelRef.current;
		if (panelElement) {
			delete panelElement.dataset.dragging;
		}

		// Dispatch custom event for KanbanBoard to detect
		const customEvent = new CustomEvent("jira-drag-end", {
			bubbles: true,
			cancelable: true,
		});
		document.dispatchEvent(customEvent);
	}, []);

	// Prevent drops on the panel itself - let them fall through to the kanban underneath
	const handlePanelDragOver = useCallback((e: React.DragEvent) => {
		// Allow drag over events to pass through to the kanban underneath
		e.preventDefault();
		e.stopPropagation();
	}, []);

	const handlePanelDrop = useCallback((e: React.DragEvent) => {
		// Prevent drops on the panel itself - let them fall through to the kanban underneath
		e.preventDefault();
		e.stopPropagation();

		// Get the drag data and check if it's our work items
		const data = e.dataTransfer.getData("application/json");
		if (!data) return;

		try {
			const parsed = JSON.parse(data);
			if (parsed.type === "jira-workitems") {
				// This is our data - let it fall through to the kanban underneath
				// We don't handle the drop here, the kanban will handle it
				return;
			}
		} catch (_error) {
			// Invalid JSON data - ignore and let it fall through
			return;
		}
	}, []);

	// Get color for work item type badge
	const getTypeColor = (type: string): string => {
		switch (type.toLowerCase()) {
			case "bug":
				return "bg-red-500/10 text-red-500 border-red-500/20";
			case "task":
				return "bg-blue-500/10 text-blue-500 border-blue-500/20";
			case "story":
				return "bg-green-500/10 text-green-500 border-green-500/20";
			case "epic":
				return "bg-orange-500/10 text-orange-500 border-orange-500/20";
			case "sub-task":
				return "bg-cyan-500/10 text-cyan-500 border-cyan-500/20";
			default:
				return "bg-gray-500/10 text-gray-500 border-gray-500/20";
		}
	};

	// Get priority badge color
	const getPriorityColor = (priority?: string): string => {
		switch (priority?.toLowerCase()) {
			case "highest":
			case "critical":
				return "bg-red-500/10 text-red-500 border-red-500/20";
			case "high":
				return "bg-orange-500/10 text-orange-500 border-orange-500/20";
			case "medium":
				return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
			case "low":
				return "bg-blue-500/10 text-blue-500 border-blue-500/20";
			case "lowest":
				return "bg-gray-500/10 text-gray-500 border-gray-500/20";
			default:
				return "bg-gray-500/10 text-gray-500 border-gray-500/20";
		}
	};

	const selectedWorkItems = workItems.filter((item) =>
		selectedIds.has(item.id),
	);

	const renderWorkItemsContent = () => {
		if (isLoadingItems) {
			return (
				<div className="flex items-center justify-center py-12">
					<RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			);
		}

		if (filteredItems.length === 0) {
			return (
				<div className="text-center py-12 text-muted-foreground px-4">
					{isSearchingRemote ? (
						<div className="flex items-center justify-center gap-2">
							<RefreshCw className="h-4 w-4 animate-spin" />
							<span>{t("jiraImport.searchingByKey")}</span>
						</div>
					) : (
						<>
							<p>No Jira issues found</p>
							{(searchQuery ||
								filters.workItemType !== "all" ||
								filters.state !== "all") && (
								<p className="text-sm mt-2">Try adjusting your filters</p>
							)}
						</>
					)}
				</div>
			);
		}

		return (
			<div className="p-4 space-y-2">
				{filteredItems.map((item) => (
					// biome-ignore lint/a11y/noStaticElementInteractions: draggable item with toggle
					// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at parent level
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: draggable Jira issue row
					<div
						key={item.id}
						className={cn(
							"flex items-start gap-3 p-3 rounded-md border transition-all cursor-pointer",
							"hover:bg-muted/50",
							"select-none", // Emp�che la s�lection de texte
							selectedIds.has(item.id) &&
								"bg-primary/10 border-primary/30 cursor-grab",
							draggedIds.has(item.id) &&
								"cursor-grabbing opacity-70 ring-2 ring-primary ring-offset-1 ring-offset-background rounded-md shadow-md",
						)}
						onClick={() => toggleItem(item.id)}
						draggable={true}
						onDragStart={(e) => {
							if (selectedIds.has(item.id)) {
								handleDragStart(e, Array.from(selectedIds));
							} else {
								handleDragStart(e, [item.id]);
							}
						}}
						onDragEnd={handleDragEnd}
					>
						<Checkbox
							checked={selectedIds.has(item.id)}
							onCheckedChange={() => toggleItem(item.id)}
							onClick={(e) => e.stopPropagation()}
						/>

						{selectedIds.has(item.id) && (
							<GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
						)}

						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-1">
								<span className="font-mono text-xs text-muted-foreground select-none">
									{item.id}
								</span>
								<Badge
									variant="outline"
									className={cn(getTypeColor(item.workItemType), "select-none")}
								>
									{item.workItemType}
								</Badge>
								<Badge variant="outline" className="select-none">
									{item.state}
								</Badge>
								{item.priority && (
									<Badge
										variant="outline"
										className={cn(
											getPriorityColor(item.priority),
											"select-none",
										)}
									>
										{item.priority}
									</Badge>
								)}
							</div>
							<h4 className="font-medium text-sm mb-1 truncate select-none">
								{item.title}
							</h4>
							{item.description && (
								<p className="text-xs text-muted-foreground line-clamp-2 select-none">
									{item.description}
								</p>
							)}
							{item.assignedTo && (
								<p className="text-xs text-muted-foreground mt-1 select-none">
									Assignee: {item.assignedTo}
								</p>
							)}
							{item.tags.length > 0 && (
								<div className="flex flex-wrap gap-1 mt-2">
									{item.tags.slice(0, 3).map((tag) => (
										<Badge
											key={tag}
											variant="secondary"
											className="text-xs select-none"
										>
											{tag}
										</Badge>
									))}
									{item.tags.length > 3 && (
										<Badge variant="secondary" className="text-xs select-none">
											+{item.tags.length - 3}
										</Badge>
									)}
								</div>
							)}
						</div>
					</div>
				))}
			</div>
		);
	};

	// Include the Jira project key in the title (the bug-tracker equivalent of
	// the Azure DevOps repository name), falling back to the generic label.
	const panelTitle = syncStatus?.projectKey
		? t("jiraImport.titleWithProject", { project: syncStatus.projectKey })
		: t("jiraImport.title");

	if (!open) return null;

	return (
		<>
			{/* Panel seulement - pas de conteneur qui bloque l'écran */}
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone for Jira items */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for Jira items */}
			<div
				ref={panelRef}
				className="fixed right-0 top-0 h-full bg-background border-l border-border shadow-2xl flex flex-col z-300"
				style={{ width: `${panelWidth}px` }}
				data-side-panel="jira"
				onDragOver={handlePanelDragOver}
				onDrop={handlePanelDrop}
			>
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-border">
					<div className="flex items-center gap-2">
						<Download className="h-5 w-5 text-primary" />
						<h2 className="text-lg font-semibold">{panelTitle}</h2>
					</div>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon"
							onClick={toggleCollapse}
							className="h-7 w-7"
							title={isCollapsed ? "Agrandir" : "Réduire"}
						>
							{isCollapsed ? (
								<ChevronLeft className="h-4 w-4" />
							) : (
								<ChevronRight className="h-4 w-4" />
							)}
						</Button>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => onOpenChange(false)}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>

				{/* Connection Info */}
				{syncStatus?.projectKey && (
					<div className="px-4 py-2 bg-muted/50 border-b border-border">
						<p className="text-sm text-foreground/70">
							<strong>Project:</strong> {syncStatus.projectKey}
							{syncStatus.instanceUrl && (
								<span className="ml-2 text-xs text-muted-foreground">
									({syncStatus.instanceUrl})
								</span>
							)}
						</p>
					</div>
				)}

				{/* Error Banner */}
				{error && (
					<div className="mx-4 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-md">
						<p className="text-sm text-red-500 mb-3">{error}</p>
						{onOpenSettings && (
							<Button
								variant="outline"
								size="sm"
								onClick={onOpenSettings}
								className="gap-2"
							>
								<Settings className="h-4 w-4" />
								{t("settings:jiraImport.configureButton")}
							</Button>
						)}
					</div>
				)}

				{/* Search and Filters */}
				{syncStatus?.connected && (
					<div className="p-4 space-y-4 border-b border-border">
						{/* Search */}
						<div className="relative">
							<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
							<Input
								placeholder="Search issues..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-10"
							/>
						</div>

						{/* Filters */}
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label className="text-xs text-foreground/70 mb-1 block">
									Type
								</Label>
								<Select
									value={filters.workItemType}
									onValueChange={(value) =>
										setFilters((prev) => ({ ...prev, workItemType: value }))
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All Types</SelectItem>
										{uniqueTypes.map((type) => (
											<SelectItem key={type} value={type}>
												{type}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div>
								<Label className="text-xs text-foreground/70 mb-1 block">
									Status
								</Label>
								<Select
									value={filters.state}
									onValueChange={(value) =>
										setFilters((prev) => ({ ...prev, state: value }))
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All Statuses</SelectItem>
										{uniqueStates.map((state) => (
											<SelectItem key={state} value={state}>
												{state}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						{/* Selection Controls */}
						{filteredItems.length > 0 && (
							<div className="flex items-center justify-between py-2">
								<div className="flex items-center gap-2">
									<Checkbox
										checked={isAllSelected}
										onCheckedChange={() => {
											if (isAllSelected) {
												deselectAll();
											} else {
												selectAll();
											}
										}}
										className={
											isSomeSelected ? "data-[state=checked]:bg-primary/50" : ""
										}
									/>
									<span className="text-sm text-foreground/70">
										{selectedIds.size} / {filteredItems.length} selected
									</span>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={handleRefresh}
									disabled={isLoadingItems || isRefreshing}
									title={
										isRefreshing ? "Refreshing..." : "Refresh (bypass cache)"
									}
								>
									{(() => {
										let refreshIconClass = "";
										if (isRefreshing) {
											refreshIconClass = "animate-spin text-primary";
										} else if (isLoadingItems) {
											refreshIconClass = "animate-spin";
										}
										return (
											<RefreshCw className={`h-4 w-4 ${refreshIconClass}`} />
										);
									})()}
								</Button>
							</div>
						)}
					</div>
				)}

				{/* Work Items List */}
				<ScrollArea className="flex-1">{renderWorkItemsContent()}</ScrollArea>

				{/* Footer */}
				{selectedWorkItems.length > 0 && (
					<div className="p-4 border-t border-border space-y-3">
						<div className="flex items-center gap-2 text-sm text-foreground/70">
							<Download className="h-4 w-4" />
							<span>Drag selected issues to a Kanban column to import</span>
						</div>

						<div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
							{t("jiraImport.selectedItems", {
								count: selectedWorkItems.length,
							})}
							<div className="mt-1 space-y-1">
								{selectedWorkItems.slice(0, 3).map((item) => (
									<div key={item.id} className="flex items-center gap-2">
										<span className="font-mono">{item.id}</span>
										<span className="truncate">{item.title}</span>
									</div>
								))}
								{selectedWorkItems.length > 3 && (
									<div>
										{t("jiraImport.moreItems", {
											count: selectedWorkItems.length - 3,
										})}
									</div>
								)}
							</div>
						</div>
					</div>
				)}

				{/* Resize handle */}
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize handle — mouse drag */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle — mouse drag */}
				<div
					className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 transition-colors"
					onMouseDown={handleResizeStart}
					title="Resize"
				>
					<div className="absolute inset-y-0 -left-2 -right-2" />
				</div>
			</div>
		</>
	);
}
