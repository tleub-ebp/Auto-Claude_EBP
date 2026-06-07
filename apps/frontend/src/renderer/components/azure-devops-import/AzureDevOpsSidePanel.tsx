/**
 * Azure DevOps Side Panel Component
 * Provides a sliding panel for importing Azure DevOps work items with drag & drop
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
	AzureDevOpsSyncStatus,
	AzureDevOpsWorkItem,
} from "../../../shared/types/integrations";
import { rendererLog } from "../../services/renderer-logger";
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

interface AzureDevOpsSidePanelProps {
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onWorkItemsImported?: (
		workItems: AzureDevOpsWorkItem[],
		targetStatus: TaskStatus,
	) => void;
	readonly onOpenSettings?: () => void;
}

interface AzureDevOpsFilters {
	workItemType: string;
	state: string;
	assignedTo: string;
}

export function AzureDevOpsSidePanel({
	projectId,
	open,
	onOpenChange,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	onWorkItemsImported,
	onOpenSettings,
}: AzureDevOpsSidePanelProps) {
	const { t } = useTranslation("settings");
	const [workItems, setWorkItems] = useState<AzureDevOpsWorkItem[]>([]);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const [repository, setRepository] = useState<string | null>(null);
	const [isSearchingRemote, setIsSearchingRemote] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);

	// Gérer la fermeture par clic en dehors du panel
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
	const [filters, setFilters] = useState<AzureDevOpsFilters>({
		workItemType: "all",
		state: "all",
		assignedTo: "all",
	});

	const [isLoadingItems, setIsLoadingItems] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [syncStatus, setSyncStatus] = useState<AzureDevOpsSyncStatus | null>(
		null,
	);
	const [draggedIds, setDraggedIds] = useState<Set<number>>(new Set());
	const dragImageRef = useRef<HTMLDivElement | null>(null);
	const [panelWidth, setPanelWidth] = useState(384); // w-96 = 384px
	const [isResizing, setIsResizing] = useState(false);
	const [isCollapsed, setIsCollapsed] = useState(false);
	const [lastCacheTime, setLastCacheTime] = useState<number>(0);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const resizeStartX = useRef(0);
	const resizeStartWidth = useRef(0);

	// Load saved panel width on component mount
	useEffect(() => {
		const loadSavedPanelWidth = () => {
			try {
				const savedWidth = localStorage.getItem(
					`azure-devops-panel-width-${projectId}`,
				);
				if (savedWidth) {
					const width = Number.parseInt(savedWidth, 10);
					if (!Number.isNaN(width) && width >= 320 && width <= 800) {
						setPanelWidth(width);
						setIsCollapsed(width <= 320);
					}
				}
			} catch (error) {
				rendererLog.azure.debug(
					"[AzureDevOps] Failed to load saved panel width:",
					error,
				);
			}
		};

		if (projectId) {
			loadSavedPanelWidth();
		}
	}, [projectId]);

	// Save panel width when it changes (but not when collapsed)
	useEffect(() => {
		if (projectId && !isCollapsed) {
			try {
				localStorage.setItem(
					`azure-devops-panel-width-${projectId}`,
					panelWidth.toString(),
				);
			} catch (error) {
				rendererLog.azure.debug(
					"[AzureDevOps] Failed to save panel width:",
					error,
				);
			}
		}
	}, [panelWidth, projectId, isCollapsed]);

	const loadConnectionStatus = async () => {
		try {
			const result =
				await globalThis.electronAPI.checkAzureDevOpsConnection(projectId);
			if (result.success) {
				setSyncStatus(result.data ?? null);
				if (result.data?.connected) {
					// Clear error when connection is successful
					setError(null);
					// Best-effort: detect the repository name to show in the title
					// (only once — the value is stable for a given project).
					if (!repository) {
						try {
							const repoResult =
								await globalThis.electronAPI.detectAzureDevOpsRepository(
									projectId,
								);
							if (repoResult.success) {
								setRepository(repoResult.data?.repository ?? null);
							}
						} catch (repoErr) {
							rendererLog.azure.debug(
								"[AzureDevOps] Failed to detect repository for title:",
								repoErr,
							);
						}
					}
				} else {
					setError(
						result.data?.error || t("azureDevOpsImport.errorNotConfigured"),
					);
				}
			} else {
				setError(
					result.error || t("azureDevOpsImport.errorCheckConnectionFailed"),
				);
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: t("azureDevOpsImport.errorUnknown"),
			);
		}
	};

	const loadWorkItems = async (forceRefresh = false) => {
		// Don't load if not forcing refresh and we have recent cache
		if (!forceRefresh && lastCacheTime) {
			const now = Date.now();
			const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
			if (now - lastCacheTime < CACHE_DURATION) {
				rendererLog.azure.debug(
					"[AzureDevOps] Using recent cache, skipping load",
				);
				return;
			}
		}

		setIsLoadingItems(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI.getAzureDevOpsWorkItems(
				projectId,
				undefined, // Use default project from config
				undefined, // No type restriction — returns all work item types (incl. custom, e.g. RSD)
				1000, // Max items
			);

			if (result.success) {
				const workItems = result.data || [];
				setWorkItems(workItems);

				// Save to cache
				try {
					const cacheKey = `azure-devops-workitems-cache-${projectId}`;
					const cacheTimeKey = `azure-devops-workitems-cache-time-${projectId}`;
					const now = Date.now();

					localStorage.setItem(cacheKey, JSON.stringify(workItems));
					localStorage.setItem(cacheTimeKey, now.toString());
					setLastCacheTime(now);

					rendererLog.azure.debug(
						"[AzureDevOps] Work items cached successfully",
					);
				} catch (cacheError) {
					rendererLog.azure.debug(
						"[AzureDevOps] Failed to cache work items:",
						cacheError,
					);
				}
			} else {
				setError(
					result.error || t("azureDevOpsImport.errorLoadWorkItemsFailed"),
				);
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: t("azureDevOpsImport.errorUnknown"),
			);
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
			try {
				const cacheKey = `azure-devops-workitems-cache-${projectId}`;
				const cacheTimeKey = `azure-devops-workitems-cache-time-${projectId}`;

				const cachedData = localStorage.getItem(cacheKey);
				const cachedTime = localStorage.getItem(cacheTimeKey);

				if (cachedData && cachedTime) {
					const cacheTime = Number.parseInt(cachedTime, 10);
					const now = Date.now();
					const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

					// Use cache if it's less than 5 minutes old
					if (now - cacheTime < CACHE_DURATION) {
						const workItems = JSON.parse(cachedData);
						setWorkItems(workItems);
						setLastCacheTime(cacheTime);
						rendererLog.azure.debug("[AzureDevOps] Using cached work items");
						return;
					}
				}
			} catch (error) {
				rendererLog.azure.debug(
					"[AzureDevOps] Failed to load cached work items:",
					error,
				);
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
			const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

			// Only refresh if cache is older than 5 minutes or doesn't exist
			if (!lastCacheTime || now - lastCacheTime > CACHE_DURATION) {
				loadWorkItems();
			} else {
				rendererLog.azure.debug(
					"[AzureDevOps] Using recent cache, skipping refresh",
				);
			}
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [open, syncStatus?.connected, lastCacheTime, loadWorkItems]);

	const handleRefresh = () => {
		setSelectedIds(new Set());
		setSearchQuery("");
		setFilters({
			workItemType: "all",
			state: "all",
			assignedTo: "all",
		});

		// Force refresh bypassing cache
		setIsRefreshing(true);
		loadWorkItems(true).finally(() => {
			setIsRefreshing(false);
		});
	};

	// Filter work items
	const filteredItems = useMemo(() => {
		return workItems.filter((item) => {
			// Search filter
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				const matchesSearch =
					item.title.toLowerCase().includes(query) ||
					item.id.toString().includes(query) ||
					item.description?.toLowerCase().includes(query);
				if (!matchesSearch) return false;
			}

			// Work item type filter
			if (
				filters.workItemType !== "all" &&
				item.workItemType !== filters.workItemType
			) {
				return false;
			}

			// State filter
			if (filters.state !== "all" && item.state !== filters.state) {
				return false;
			}

			return true;
		});
	}, [workItems, searchQuery, filters]);

	// When the user searches a specific numeric work item ID that is not in the
	// loaded backlog window, fetch it directly from Azure DevOps. This makes any
	// work item findable by ID — including custom types (e.g. RSD) and items
	// outside the (capped) backlog list.
	useEffect(() => {
		const trimmed = searchQuery.trim();
		if (!/^\d+$/.test(trimmed) || !syncStatus?.connected) return;
		const id = Number.parseInt(trimmed, 10);
		if (Number.isNaN(id) || workItems.some((item) => item.id === id)) return;

		let cancelled = false;
		const handle = setTimeout(async () => {
			setIsSearchingRemote(true);
			try {
				const result = await globalThis.electronAPI.getAzureDevOpsWorkItem(
					projectId,
					id,
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
			} catch (err) {
				if (!cancelled) {
					rendererLog.azure.debug(
						"[AzureDevOps] Direct work item lookup failed:",
						err,
					);
				}
			} finally {
				if (!cancelled) setIsSearchingRemote(false);
			}
		}, 400);

		return () => {
			cancelled = true;
			clearTimeout(handle);
			setIsSearchingRemote(false);
		};
	}, [searchQuery, workItems, projectId, syncStatus?.connected]);

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
		(id: number) => {
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
			); // Min 320px, Max 800px
			setPanelWidth(newWidth);

			// Update collapsed state based on width
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
			// Restore saved width or default to 384px
			let restoredWidth = 384; // default width
			try {
				const savedWidth = localStorage.getItem(
					`azure-devops-panel-width-${projectId}`,
				);
				if (savedWidth) {
					const width = Number.parseInt(savedWidth, 10);
					if (!Number.isNaN(width) && width >= 320 && width <= 800) {
						restoredWidth = width;
					}
				}
			} catch (error) {
				rendererLog.azure.debug(
					"[AzureDevOps] Failed to load saved panel width for restore:",
					error,
				);
			}

			setPanelWidth(restoredWidth);
			setIsCollapsed(false);
		} else {
			// Save current width before collapsing
			try {
				localStorage.setItem(
					`azure-devops-panel-width-${projectId}`,
					panelWidth.toString(),
				);
			} catch (error) {
				rendererLog.azure.debug(
					"[AzureDevOps] Failed to save panel width before collapse:",
					error,
				);
			}

			setPanelWidth(320); // Collapse to minimum width
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

	// Drag handlers
	const handleDragStart = useCallback(
		(e: React.DragEvent, workItemIds: number[]) => {
			const itemsToDrag = workItemIds
				.map((id) => workItems.find((item) => item.id === id))
				.filter((item): item is AzureDevOpsWorkItem => item !== undefined);

			const dragData = {
				type: "azure-devops-workitems",
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

			// Marquer le panel comme étant en cours de drag
			const panelElement = panelRef.current;
			if (panelElement) {
				panelElement.dataset.dragging = "true";
			}

			// Also dispatch custom event for better compatibility
			const customEvent = new CustomEvent("azure-devops-drag-start", {
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
		if (dragImageRef.current?.parentNode) {
			dragImageRef.current.remove();
			dragImageRef.current = null;
		}

		// Nettoyer l'attribut data-dragging
		const panelElement = panelRef.current;
		if (panelElement) {
			delete panelElement.dataset.dragging;
		}

		// Dispatch custom event for KanbanBoard to detect
		const customEvent = new CustomEvent("azure-devops-drag-end", {
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
			if (parsed.type === "azure-devops-workitems") {
				// This is our data - let it fall through to the kanban underneath
				// We don't handle the drop here, the kanban will handle it
				return;
			}
		} catch (error) {
			// Invalid JSON data, ignore and let it fall through
			rendererLog.azure.debug("[AzureDevOps] Invalid drag data format:", error);
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
			case "user story":
				return "bg-green-500/10 text-green-500 border-green-500/20";
			case "feature":
				return "bg-purple-500/10 text-purple-500 border-purple-500/20";
			case "epic":
				return "bg-orange-500/10 text-orange-500 border-orange-500/20";
			default:
				return "bg-gray-500/10 text-gray-500 border-gray-500/20";
		}
	};

	const selectedWorkItems = workItems.filter((item) =>
		selectedIds.has(item.id),
	);

	// Get refresh icon classes based on state
	const getRefreshIconClasses = (): string => {
		if (isRefreshing) {
			return "animate-spin text-primary";
		}
		if (isLoadingItems) {
			return "animate-spin";
		}
		return "";
	};

	// Prefer the repository name in the title, falling back to the Azure
	// DevOps project name, then to the generic label.
	const titleContext = repository ?? syncStatus?.projectName ?? null;
	const panelTitle = titleContext
		? t("azureDevOpsImport.titleWithRepository", { repository: titleContext })
		: t("azureDevOpsImport.title");

	if (!open) return null;

	return (
		<>
			{/* Panel seulement - pas de conteneur qui bloque l'écran */}
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone for work items */}
			<section
				ref={panelRef}
				className="fixed right-0 top-0 h-full bg-background border-l border-border shadow-2xl flex flex-col z-300"
				style={{ width: `${panelWidth}px` }}
				data-side-panel="azure-devops"
				onDragOver={handlePanelDragOver}
				onDrop={handlePanelDrop}
				aria-label={t("azureDevOpsImport.sidePanelAriaLabel")}
			>
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-border">
					<div className="flex items-center gap-2">
						<Download className="h-5 w-5 text-primary" />
						<h2 className="text-lg font-semibold">{panelTitle}</h2>
					</div>
					<div className="flex items-center gap-1">
						{/* Collapse button */}
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
				{syncStatus?.projectName && (
					<div className="px-4 py-2 bg-muted/50 border-b border-border">
						<p className="text-sm text-foreground/70">
							<strong>{t("azureDevOpsImport.projectLabel")}</strong>{" "}
							{syncStatus.projectName}
						</p>
						{/* Repository info - display if available */}
						{workItems.length > 0 && workItems[0]?.repository && (
							<p className="text-sm text-foreground/70 mt-1">
								<strong>Repository:</strong> {workItems[0].repository}
							</p>
						)}
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
								{t("settings:azureDevOpsImport.configureButton")}
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
								placeholder={t("azureDevOpsImport.searchPlaceholder")}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-10"
							/>
						</div>

						{/* Filters */}
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label className="text-xs text-foreground/70 mb-1 block">
									{t("azureDevOpsImport.filterTypeLabel")}
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
										<SelectItem value="all">
											{t("azureDevOpsImport.filterTypeAll")}
										</SelectItem>
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
									{t("azureDevOpsImport.filterStateLabel")}
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
										<SelectItem value="all">
											{t("azureDevOpsImport.filterStateAll")}
										</SelectItem>
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
										{t("azureDevOpsImport.selectionCount", {
											selected: selectedIds.size,
											total: filteredItems.length,
										})}
									</span>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={handleRefresh}
									disabled={isLoadingItems || isRefreshing}
									title={
										isRefreshing
											? "Rafraîchissement forcé..."
											: "Rafraîchir (contourne le cache)"
									}
								>
									<RefreshCw className={`h-4 w-4 ${getRefreshIconClasses()}`} />
								</Button>
							</div>
						)}
					</div>
				)}

				{/* Work Items List */}
				<ScrollArea className="flex-1">
					{isLoadingItems && (
						<div className="flex items-center justify-center py-12">
							<RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
						</div>
					)}

					{!isLoadingItems && filteredItems.length === 0 && (
						<div className="text-center py-12 text-muted-foreground px-4">
							{isSearchingRemote ? (
								<div className="flex items-center justify-center gap-2">
									<RefreshCw className="h-4 w-4 animate-spin" />
									<span>{t("azureDevOpsImport.searchingById")}</span>
								</div>
							) : (
								<>
									<p>{t("azureDevOpsImport.emptyTitle")}</p>
									{(searchQuery ||
										filters.workItemType !== "all" ||
										filters.state !== "all") && (
										<p className="text-sm mt-2">
											{t("azureDevOpsImport.emptySubtitle")}
										</p>
									)}
								</>
							)}
						</div>
					)}

					{!isLoadingItems && filteredItems.length > 0 && (
						<div className="p-4 space-y-2">
							{filteredItems.map((item) => (
								// biome-ignore lint/a11y/noLabelWithoutControl: Radix Checkbox renders a hidden input
								// biome-ignore lint/a11y/noNoninteractiveElementInteractions: label is draggable work item
								<label
									key={item.id}
									className={cn(
										"flex items-start gap-3 p-3 rounded-md border transition-all cursor-pointer w-full text-left",
										"hover:bg-muted/50",
										"select-none",
										selectedIds.has(item.id) &&
											"bg-primary/10 border-primary/30 cursor-grab",
										draggedIds.has(item.id) &&
											"cursor-grabbing opacity-70 ring-2 ring-primary ring-offset-1 ring-offset-background rounded-md shadow-md",
										"bg-transparent border-none",
									)}
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
									<div className="flex items-center justify-center">
										<Checkbox
											checked={selectedIds.has(item.id)}
											onCheckedChange={() => toggleItem(item.id)}
											aria-label={t("azureDevOpsImport.toggleSelection", {
												id: item.id,
											})}
										/>
									</div>

									{selectedIds.has(item.id) && (
										<GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
									)}

									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className="font-mono text-xs text-muted-foreground select-none">
												#{item.id}
											</span>
											<Badge
												variant="outline"
												className={cn(
													getTypeColor(item.workItemType),
													"select-none",
												)}
											>
												{item.workItemType}
											</Badge>
											<Badge variant="outline" className="select-none">
												{item.state}
											</Badge>
											{item.priority !== undefined && (
												<Badge variant="outline" className="select-none">
													P{item.priority}
												</Badge>
											)}
											{item.repository && (
												<Badge
													variant="secondary"
													className="text-xs select-none"
												>
													?? {item.repository}
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
										{item.tags.length > 0 && (
											<div className="flex flex-wrap gap-1 mt-2">
												{item.tags.slice(0, 3).map((tag) => (
													<Badge
														key={`${item.id}-${tag}`}
														variant="secondary"
														className="text-xs select-none"
													>
														{tag}
													</Badge>
												))}
												{item.tags.length > 3 && (
													<Badge
														variant="secondary"
														className="text-xs select-none"
													>
														+{item.tags.length - 3}
													</Badge>
												)}
											</div>
										)}
									</div>
								</label>
							))}
						</div>
					)}
				</ScrollArea>

				{/* Footer */}
				{selectedWorkItems.length > 0 && (
					<div className="p-4 border-t border-border space-y-3">
						<div className="flex items-center gap-2 text-sm text-foreground/70">
							<Download className="h-4 w-4" />
							<span>{t("azureDevOpsImport.dragInstructions")}</span>
						</div>

						<div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
							{t("azureDevOpsImport.selectedItems", {
								count: selectedWorkItems.length,
							})}
							<div className="mt-1 space-y-1">
								{selectedWorkItems.slice(0, 3).map((item) => (
									<div key={item.id} className="flex items-center gap-2">
										<span className="font-mono">#{item.id}</span>
										<span className="truncate">{item.title}</span>
									</div>
								))}
								{selectedWorkItems.length > 3 && (
									<div>
										+{selectedWorkItems.length - 3}{" "}
										{t("azureDevOpsImport.moreItems")}
									</div>
								)}
							</div>
						</div>
					</div>
				)}

				{/* Resize handle */}
				<button
					type="button"
					className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 transition-colors border-0 bg-transparent p-0"
					onMouseDown={handleResizeStart}
					title="Redimensionner"
					aria-label={t("azureDevOpsImport.resizeHandleAriaLabel")}
				>
					{/* Wider invisible hit area for easier grabbing */}
					<span className="absolute inset-y-0 -left-2 -right-2" />
				</button>
			</section>
		</>
	);
}
