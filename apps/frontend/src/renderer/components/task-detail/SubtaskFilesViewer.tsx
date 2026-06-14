import {
	AlignJustify,
	ChevronDown,
	Code2,
	Columns2,
	File,
	FileCode,
	FileJson,
	FileText,
	Folder,
	FolderOpen,
	Loader2,
	Package,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorktreeDiffFile } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DiffViewer, type DiffViewMode } from "../ui/diff-viewer";
import { ScrollArea } from "../ui/scroll-area";

interface SubtaskFilesViewerProps {
	files: string[];
	subtaskTitle: string;
	taskId?: string;
	onClose: () => void;
}

interface FileTreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children?: FileTreeNode[];
	diff?: WorktreeDiffFile;
}

type DiffStatus = WorktreeDiffFile["status"];

/** Normalise un chemin (slashes unix, sans préfixe ./) pour comparaison. */
function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Associe chaque fichier de la sous-tâche à son diff de worktree.
 * Correspondance exacte (chemin normalisé) puis repli sur le suffixe le plus
 * long pour gérer les chemins relatifs vs absolus.
 */
export function matchDiffFile(
	filePath: string,
	diffByPath: Map<string, WorktreeDiffFile>,
): WorktreeDiffFile | undefined {
	const normalized = normalizePath(filePath);
	const exact = diffByPath.get(normalized);
	if (exact) return exact;

	for (const [diffPath, diff] of diffByPath) {
		if (diffPath.endsWith(normalized) || normalized.endsWith(diffPath)) {
			return diff;
		}
	}
	return undefined;
}

function getFileIcon(path: string, isFolder: boolean) {
	if (isFolder) return null;

	const ext = path.split(".").pop()?.toLowerCase();
	const iconClass = "h-4 w-4";

	switch (ext) {
		case "json":
			return <FileJson className={cn(iconClass, "text-amber-500")} />;
		case "ts":
		case "tsx":
			return <FileCode className={cn(iconClass, "text-blue-500")} />;
		case "js":
		case "jsx":
			return <FileCode className={cn(iconClass, "text-yellow-500")} />;
		case "css":
		case "scss":
			return <FileCode className={cn(iconClass, "text-pink-500")} />;
		case "md":
			return <FileText className={cn(iconClass, "text-slate-500")} />;
		case "html":
			return <FileCode className={cn(iconClass, "text-orange-500")} />;
		case "py":
			return <FileCode className={cn(iconClass, "text-green-500")} />;
		case "xml":
		case "yaml":
		case "yml":
		case "resx":
			return <FileCode className={cn(iconClass, "text-purple-500")} />;
		default:
			return <File className={cn(iconClass, "text-muted-foreground")} />;
	}
}

const STATUS_DOT: Record<DiffStatus, string> = {
	added: "bg-emerald-500",
	modified: "bg-sky-500",
	deleted: "bg-rose-500",
	renamed: "bg-amber-500",
};

export function buildFileTree(
	files: string[],
	diffByPath: Map<string, WorktreeDiffFile>,
): FileTreeNode[] {
	// biome-ignore lint/suspicious/noExplicitAny: recursive nested map builder
	const root: Record<string, any> = {};

	for (const filePath of files) {
		const parts = normalizePath(filePath).split("/").filter(Boolean);
		// biome-ignore lint/suspicious/noExplicitAny: recursive nested map builder
		let current: Record<string, any> = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;

			if (!current[part]) {
				current[part] = {
					name: part,
					path: parts.slice(0, i + 1).join("/"),
					isFolder: !isLast,
					children: isLast ? undefined : {},
					diff: isLast ? matchDiffFile(filePath, diffByPath) : undefined,
				};
			}

			if (!isLast) {
				if (!current[part].children) {
					current[part].children = {};
				}
				current = current[part].children;
			}
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: recursive nested map builder
	const convertToArray = (obj: Record<string, any>): FileTreeNode[] => {
		return Object.values(obj).map((node) => ({
			...node,
			children: node.children ? convertToArray(node.children) : undefined,
		}));
	};

	return convertToArray(root);
}

interface FileTreeItemProps {
	node: FileTreeNode;
	level: number;
	expanded: Record<string, boolean>;
	openDiffs: Record<string, boolean>;
	lazyDiffs: Record<string, WorktreeDiffFile>;
	loadingPaths: Record<string, boolean>;
	viewMode: DiffViewMode;
	onToggle: (path: string) => void;
	onToggleDiff: (node: FileTreeNode) => void;
	t: (key: string, options?: Record<string, unknown>) => string;
}

function FileTreeItem({
	node,
	level,
	expanded,
	openDiffs,
	lazyDiffs,
	loadingPaths,
	viewMode,
	onToggle,
	onToggleDiff,
	t,
}: FileTreeItemProps) {
	const isExpanded = expanded[node.path];
	const hasChildren = node.children && node.children.length > 0;
	const isDiffOpen = openDiffs[node.path];
	// Diff effectif : priorité au diff chargé à la demande, repli sur l'agrégat.
	const diff = lazyDiffs[node.path] ?? node.diff;
	const isLoadingDiff = loadingPaths[node.path];
	// Tous les fichiers (non-dossiers) sont cliquables pour révéler leurs lignes.
	const canShowDiff = !node.isFolder;
	const hasPatch = !!diff?.patch && diff.patch.trim() !== "";

	const handleClick = () => {
		if (hasChildren) {
			onToggle(node.path);
		} else if (!node.isFolder) {
			onToggleDiff(node);
		}
	};

	return (
		<div>
			<button
				type="button"
				onClick={handleClick}
				title={
					canShowDiff
						? isDiffOpen
							? t("subtasks.filesViewer.hideDiff")
							: t("subtasks.filesViewer.viewDiff")
						: undefined
				}
				className={cn(
					"w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/60 transition-colors text-sm group",
					"text-foreground hover:text-foreground",
					isDiffOpen && "bg-secondary/40",
				)}
				style={{ paddingLeft: `${12 + level * 16}px` }}
			>
				{hasChildren || canShowDiff ? (
					<ChevronDown
						className={cn(
							"h-4 w-4 text-muted-foreground transition-transform flex-shrink-0",
							!(hasChildren ? isExpanded : isDiffOpen) && "-rotate-90",
						)}
					/>
				) : (
					<div className="h-4 w-4 flex-shrink-0" />
				)}

				{node.isFolder ? (
					isExpanded ? (
						<FolderOpen className="h-4 w-4 text-amber-500 flex-shrink-0" />
					) : (
						<Folder className="h-4 w-4 text-amber-500 flex-shrink-0" />
					)
				) : (
					getFileIcon(node.path, false)
				)}

				<span className="truncate flex-1 text-left font-medium text-xs">
					{node.name}
				</span>

				{diff && (diff.additions > 0 || diff.deletions > 0) && (
					<span className="flex items-center gap-1.5 flex-shrink-0">
						{diff.additions > 0 && (
							<span className="text-[10px] font-semibold tabular-nums text-emerald-500">
								+{diff.additions}
							</span>
						)}
						{diff.deletions > 0 && (
							<span className="text-[10px] font-semibold tabular-nums text-rose-500">
								-{diff.deletions}
							</span>
						)}
						<span
							className={cn("h-2 w-2 rounded-full", STATUS_DOT[diff.status])}
							title={t(`subtasks.filesViewer.status.${diff.status}`)}
						/>
					</span>
				)}

				{!node.isFolder && !(diff && (diff.additions > 0 || diff.deletions > 0)) && (
					<Badge
						variant="outline"
						className="text-xs h-5 px-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
					>
						{node.path.split(".").pop()}
					</Badge>
				)}
			</button>

			{/* Inline diff */}
			{canShowDiff && isDiffOpen && (
				<div
					className="my-1.5 rounded-lg border border-border/60 bg-card/40 overflow-hidden shadow-sm"
					style={{ marginLeft: `${28 + level * 16}px` }}
				>
					{isLoadingDiff ? (
						<div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							{t("subtasks.filesViewer.loading")}
						</div>
					) : hasPatch ? (
						// Full diff, GitHub-style: the whole panel scrolls vertically
						// (outer ScrollArea), each diff only scrolls horizontally for
						// long lines. No vertical cap so nothing is clipped.
						<div className="overflow-x-auto themed-scrollbar">
							<DiffViewer patch={diff?.patch} viewMode={viewMode} />
						</div>
					) : (
						<div className="px-3 py-4 text-center text-xs text-muted-foreground">
							{t("subtasks.filesViewer.noDiff")}
						</div>
					)}
				</div>
			)}

			{hasChildren && isExpanded && (
				<div>
					{node.children?.map((child) => (
						<FileTreeItem
							key={child.path}
							node={child}
							level={level + 1}
							expanded={expanded}
							openDiffs={openDiffs}
							lazyDiffs={lazyDiffs}
							loadingPaths={loadingPaths}
							viewMode={viewMode}
							onToggle={onToggle}
							onToggleDiff={onToggleDiff}
							t={t}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** Persist the unified/split choice so it sticks across files and sessions. */
const VIEW_MODE_STORAGE_KEY = "workpilot.subtaskDiff.viewMode";

function readStoredViewMode(): DiffViewMode {
	if (typeof window === "undefined") return "unified";
	return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "split"
		? "split"
		: "unified";
}

export function SubtaskFilesViewer({
	files,
	subtaskTitle,
	taskId,
	onClose,
}: SubtaskFilesViewerProps) {
	const { t } = useTranslation(["tasks"]);
	const [viewMode, setViewMode] = useState<DiffViewMode>(readStoredViewMode);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({});
	const [diffByPath, setDiffByPath] = useState<Map<string, WorktreeDiffFile>>(
		new Map(),
	);
	const [isLoading, setIsLoading] = useState(false);
	const [loadError, setLoadError] = useState(false);
	// Diffs chargés à la demande au clic sur un fichier (taskId requis).
	const [lazyDiffs, setLazyDiffs] = useState<Record<string, WorktreeDiffFile>>(
		{},
	);
	const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (!taskId) return;
		let cancelled = false;

		setIsLoading(true);
		setLoadError(false);

		window.electronAPI
			.getWorktreeDiff(taskId)
			.then((result) => {
				if (cancelled) return;
				if (result.success && result.data) {
					const map = new Map<string, WorktreeDiffFile>();
					for (const file of result.data.files) {
						map.set(normalizePath(file.path), file);
					}
					setDiffByPath(map);
				} else {
					setLoadError(true);
				}
			})
			.catch(() => {
				if (!cancelled) setLoadError(true);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [taskId]);

	const fileTree = useMemo(
		() => buildFileTree(files, diffByPath),
		[files, diffByPath],
	);

	const totals = useMemo(() => {
		let additions = 0;
		let deletions = 0;
		// Évite de compter deux fois un fichier présent dans l'agrégat ET en lazy.
		const counted = new Set<string>();
		for (const [path, diff] of Object.entries(lazyDiffs)) {
			additions += diff.additions;
			deletions += diff.deletions;
			counted.add(path);
		}
		for (const [path, diff] of diffByPath.entries()) {
			if (counted.has(path)) continue;
			additions += diff.additions;
			deletions += diff.deletions;
		}
		return { additions, deletions };
	}, [diffByPath, lazyDiffs]);

	const handleToggle = (path: string) => {
		setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
	};

	const handleViewModeChange = useCallback((mode: DiffViewMode) => {
		setViewMode(mode);
		try {
			window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
		} catch {
			/* localStorage indisponible (quota / mode privé) : choix non persisté */
		}
	}, []);

	const fetchFileDiff = useCallback(
		(node: FileTreeNode) => {
			if (!taskId) return;
			// Déjà chargé (agrégat avec patch ou lazy) ou en cours → ne pas refetch.
			const alreadyLoaded =
				lazyDiffs[node.path] !== undefined ||
				(node.diff?.patch && node.diff.patch.trim() !== "");
			if (alreadyLoaded || loadingPaths[node.path]) return;

			setLoadingPaths((prev) => ({ ...prev, [node.path]: true }));
			window.electronAPI
				.getFileDiff(taskId, node.path)
				.then((result) => {
					if (result.success && result.data) {
						const data = result.data;
						setLazyDiffs((prev) => ({ ...prev, [node.path]: data }));
					}
				})
				.catch(() => {
					/* l'UI retombe sur « no diff » */
				})
				.finally(() => {
					setLoadingPaths((prev) => {
						const next = { ...prev };
						delete next[node.path];
						return next;
					});
				});
		},
		[taskId, lazyDiffs, loadingPaths],
	);

	const handleToggleDiff = useCallback(
		(node: FileTreeNode) => {
			const willOpen = !openDiffs[node.path];
			setOpenDiffs((prev) => ({ ...prev, [node.path]: !prev[node.path] }));
			if (willOpen) {
				fetchFileDiff(node);
			}
		},
		[openDiffs, fetchFileDiff],
	);

	const handleExpandAll = () => {
		const allFolders: Record<string, boolean> = {};
		const allFiles: Record<string, boolean> = {};
		const leaves: FileTreeNode[] = [];
		const collect = (nodes: FileTreeNode[]) => {
			for (const node of nodes) {
				if (node.isFolder) {
					allFolders[node.path] = true;
					if (node.children) collect(node.children);
				} else {
					allFiles[node.path] = true;
					leaves.push(node);
				}
			}
		};
		collect(fileTree);
		setExpanded(allFolders);
		setOpenDiffs(allFiles);
		for (const leaf of leaves) {
			fetchFileDiff(leaf);
		}
	};

	const handleCollapseAll = () => {
		setExpanded({});
		setOpenDiffs({});
	};

	const fileCount = files.length;
	const folderCount = fileTree.filter((node) => node.isFolder).length;

	return (
		<div className="h-full flex flex-col bg-background border-l border-border">
			{/* Header */}
			<div className="flex-shrink-0 p-4 border-b border-border bg-gradient-to-br from-primary/5 via-transparent to-transparent">
				<div className="flex items-start justify-between gap-3 mb-3">
					<div className="flex items-center gap-3 min-w-0">
						<div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
							<Code2 className="h-5 w-5 text-primary" />
						</div>
						<div className="min-w-0">
							<h3 className="text-sm font-semibold text-foreground truncate">
								{subtaskTitle}
							</h3>
							<div className="flex items-center gap-2">
								<p className="text-xs text-muted-foreground">
									{t("subtasks.filesViewer.filesModified", {
										count: fileCount,
									})}
								</p>
								{(totals.additions > 0 || totals.deletions > 0) && (
									<span className="flex items-center gap-1.5 text-[11px] font-semibold tabular-nums">
										<span className="text-emerald-500">
											+{totals.additions}
										</span>
										<span className="text-rose-500">-{totals.deletions}</span>
									</span>
								)}
							</div>
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClose}
						className="h-8 w-8 p-0 flex-shrink-0 hover:bg-destructive/10"
					>
						<X className="h-4 w-4" />
					</Button>
				</div>

				{/* Actions */}
				{fileCount > 0 && (
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleExpandAll}
							className="text-xs h-7 flex-1"
						>
							<ChevronDown className="h-3 w-3 mr-1" />
							{t("subtasks.filesViewer.expandAll")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleCollapseAll}
							className="text-xs h-7 flex-1"
						>
							<ChevronDown className="h-3 w-3 mr-1 rotate-180" />
							{t("subtasks.filesViewer.collapseAll")}
						</Button>

						{/* Unified / side-by-side toggle (GitHub-style) */}
						<div className="flex items-center rounded-md border border-border bg-background p-0.5 flex-shrink-0">
							<button
								type="button"
								onClick={() => handleViewModeChange("unified")}
								aria-pressed={viewMode === "unified"}
								title={t("subtasks.filesViewer.viewMode.unified")}
								className={cn(
									"flex items-center justify-center h-6 w-7 rounded transition-colors",
									viewMode === "unified"
										? "bg-secondary text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<AlignJustify className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								onClick={() => handleViewModeChange("split")}
								aria-pressed={viewMode === "split"}
								title={t("subtasks.filesViewer.viewMode.split")}
								className={cn(
									"flex items-center justify-center h-6 w-7 rounded transition-colors",
									viewMode === "split"
										? "bg-secondary text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Columns2 className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				)}
			</div>

			{/* File Tree */}
			<ScrollArea className="flex-1">
				<div className="p-4">
					{isLoading ? (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<Loader2 className="h-6 w-6 mb-3 animate-spin opacity-70" />
							<span className="text-sm font-medium">
								{t("subtasks.filesViewer.loading")}
							</span>
						</div>
					) : loadError ? (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<Package className="h-8 w-8 mb-3 opacity-40" />
							<span className="text-sm font-medium">
								{t("subtasks.filesViewer.loadError")}
							</span>
						</div>
					) : fileTree.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<Package className="h-8 w-8 mb-3 opacity-40" />
							<span className="text-sm font-medium">
								{t("subtasks.filesViewer.noFiles")}
							</span>
							<span className="text-xs opacity-70 mt-1">
								{t("subtasks.filesViewer.noFilesHint")}
							</span>
						</div>
					) : (
						fileTree.map((node) => (
							<FileTreeItem
								key={node.path}
								node={node}
								level={0}
								expanded={expanded}
								openDiffs={openDiffs}
								lazyDiffs={lazyDiffs}
								loadingPaths={loadingPaths}
								viewMode={viewMode}
								onToggle={handleToggle}
								onToggleDiff={handleToggleDiff}
								t={t}
							/>
						))
					)}
				</div>
			</ScrollArea>

			{/* Stats */}
			{fileCount > 0 && (
				<div className="flex-shrink-0 p-3 border-t border-border bg-muted/30">
					<div className="grid grid-cols-4 gap-2 text-center text-xs">
						<div>
							<p className="font-semibold text-foreground">{fileCount}</p>
							<p className="text-muted-foreground">
								{t("subtasks.filesViewer.stats.files")}
							</p>
						</div>
						<div>
							<p className="font-semibold text-foreground">{folderCount}</p>
							<p className="text-muted-foreground">
								{t("subtasks.filesViewer.stats.folders")}
							</p>
						</div>
						<div>
							<p className="font-semibold text-emerald-500 tabular-nums">
								+{totals.additions}
							</p>
							<p className="text-muted-foreground">
								{t("subtasks.filesViewer.stats.additions")}
							</p>
						</div>
						<div>
							<p className="font-semibold text-rose-500 tabular-nums">
								-{totals.deletions}
							</p>
							<p className="text-muted-foreground">
								{t("subtasks.filesViewer.stats.deletions")}
							</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
