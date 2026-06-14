import {
	ChevronDown,
	ChevronRight,
	Eye,
	FileCode,
	Folder,
	FolderOpen,
	Plus,
	Save,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../../hooks/use-toast";
import type { WorktreeDiff, WorktreeDiffFile } from "../../../../shared/types";
import { cn } from "../../../lib/utils";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { CodeEditor } from "../../ui/code-editor";
import { DiffViewer } from "../../ui/diff-viewer";
import { Input } from "../../ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { Checkbox } from "../../ui/checkbox";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../ui/tooltip";

// ── Tree data structure ──────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: TreeNode[];
	file?: WorktreeDiffFile;
	additions: number;
	deletions: number;
}

function buildFileTree(files: WorktreeDiffFile[]): TreeNode[] {
	const root: TreeNode[] = [];

	for (const file of files) {
		const parts = file.path.replaceAll("\\", "/").split("/");
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const name = parts[i];
			const isLast = i === parts.length - 1;
			const partPath = parts.slice(0, i + 1).join("/");

			if (isLast) {
				current.push({
					name,
					path: partPath,
					isFolder: false,
					children: [],
					file,
					additions: file.additions,
					deletions: file.deletions,
				});
			} else {
				let folder = current.find((n) => n.isFolder && n.name === name);
				if (!folder) {
					folder = {
						name,
						path: partPath,
						isFolder: true,
						children: [],
						additions: 0,
						deletions: 0,
					};
					current.push(folder);
				}
				current = folder.children;
			}
		}
	}

	// Aggregate counts and sort recursively
	function processNode(nodes: TreeNode[]): void {
		for (const node of nodes) {
			if (node.isFolder) {
				processNode(node.children);
				node.additions = node.children.reduce((s, c) => s + c.additions, 0);
				node.deletions = node.children.reduce((s, c) => s + c.deletions, 0);
			}
		}
		nodes.sort((a, b) => {
			if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	processNode(root);
	return root;
}

// ── Tree node component ──────────────────────────────────────────────

function FileTreeNode({
	node,
	depth,
	defaultExpanded,
	expandSignal,
	t,
	onFileClick,
	onEditFile,
	canEdit,
	selectedPaths,
	onToggleSelect,
	canSelect,
}: {
	readonly node: TreeNode;
	readonly depth: number;
	readonly defaultExpanded: boolean;
	readonly expandSignal?: { version: number; value: boolean };
	readonly t: (key: string) => string;
	readonly onFileClick?: (file: WorktreeDiffFile) => void;
	readonly onEditFile?: (file: WorktreeDiffFile) => void;
	readonly canEdit?: boolean;
	readonly selectedPaths?: Set<string>;
	readonly onToggleSelect?: (path: string) => void;
	readonly canSelect?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const signalVersionRef = useRef(0);

	useEffect(() => {
		if (expandSignal && expandSignal.version !== signalVersionRef.current) {
			signalVersionRef.current = expandSignal.version;
			setExpanded(expandSignal.value);
		}
	}, [expandSignal]);

	const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

	if (node.isFolder) {
		return (
			<>
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: collapsible folder row */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: collapsible folder row */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled elsewhere */}
				<div
					className="flex items-center justify-between p-1.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer select-none"
					style={{ paddingLeft: depth * 16 + 8 }}
					onClick={toggleExpanded}
				>
					<div className="flex items-center gap-1.5 min-w-0 flex-1">
						{expanded ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						)}
						{expanded ? (
							<FolderOpen className="h-4 w-4 shrink-0 text-amber-400" />
						) : (
							<Folder className="h-4 w-4 shrink-0 text-amber-400" />
						)}
						<span className="text-sm font-medium truncate">{node.name}</span>
					</div>
					<div className="flex items-center gap-2 shrink-0 ml-2">
						<span className="text-xs text-success">+{node.additions}</span>
						<span className="text-xs text-destructive">-{node.deletions}</span>
					</div>
				</div>
				{expanded &&
					node.children.map((child) => (
						<FileTreeNode
							key={child.path}
							node={child}
							depth={depth + 1}
							defaultExpanded={false}
							expandSignal={expandSignal}
							t={t}
							onFileClick={onFileClick}
							onEditFile={onEditFile}
							canEdit={canEdit}
							selectedPaths={selectedPaths}
							onToggleSelect={onToggleSelect}
							canSelect={canSelect}
						/>
					))}
			</>
		);
	}

	// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
	const file = node.file!;
	const isSelected = selectedPaths?.has(file.path) ?? false;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events handled elsewhere
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: selectable file row
		<div
			className="flex items-center justify-between p-1.5 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
			style={{ paddingLeft: depth * 16 + 8 }}
		>
			<div
				className="flex items-center gap-1.5 min-w-0 flex-1"
				onClick={() => canSelect || onFileClick?.(file)}
			>
				{canSelect && (
					<Checkbox
						checked={isSelected}
						onCheckedChange={() => onToggleSelect?.(file.path)}
						onClick={(e) => e.stopPropagation()}
					/>
				)}
				{!canSelect && <span className="w-4 shrink-0" />}
				<FileCode
					className={cn(
						"h-4 w-4 shrink-0",
						file.status === "added" && "text-success",
						file.status === "deleted" && "text-destructive",
						file.status === "modified" && "text-info",
						file.status === "renamed" && "text-warning",
					)}
				/>
				<span className="text-sm font-mono truncate">{node.name}</span>
			</div>
			<div className="flex items-center gap-2 shrink-0 ml-2">
				<Badge
					variant="secondary"
					className={cn(
						"text-xs",
						file.status === "added" && "bg-success/10 text-success",
						file.status === "deleted" && "bg-destructive/10 text-destructive",
						file.status === "modified" && "bg-info/10 text-info",
						file.status === "renamed" && "bg-warning/10 text-warning",
					)}
				>
					{t(`taskReview:diff.status.${file.status}`)}
				</Badge>
				<span className="text-xs text-success">+{file.additions}</span>
				<span className="text-xs text-destructive">-{file.deletions}</span>
				{canEdit && file.status !== "deleted" && (
					<Button
						size="sm"
						variant="ghost"
						className={
							selectedPaths && selectedPaths.size > 0 ? "invisible" : ""
						}
						onClick={(e) => {
							e.stopPropagation();
							onEditFile?.(file);
						}}
					>
						{t("taskReview:diff.edit")}
					</Button>
				)}
			</div>
		</div>
	);
}

// ── Main dialog ──────────────────────────────────────────────────────

type ViewMode = "list" | "tree";

interface DiffViewDialogProps {
	readonly open: boolean;
	readonly worktreeDiff: WorktreeDiff | null;
	readonly onOpenChange: (open: boolean) => void;
	readonly worktreePath?: string;
	readonly onRefresh?: () => void;
}

/**
 * Dialog displaying the list of changed files with their status and line changes.
 * Supports flat list and tree view modes, switchable via a dropdown.
 * Allows editing, deleting, and adding files when worktreePath is provided.
 */
export function DiffViewDialog({
	open,
	worktreeDiff,
	onOpenChange,
	worktreePath,
	onRefresh,
}: DiffViewDialogProps) {
	const { t } = useTranslation(["taskReview"]);
	const { toast } = useToast();
	const [viewMode, setViewMode] = useState<ViewMode>("tree");
	const [expandSignal, setExpandSignal] = useState<
		{ version: number; value: boolean } | undefined
	>();
	const expandVersionRef = useRef(0);
	const [selectedFile, setSelectedFile] = useState<WorktreeDiffFile | null>(
		null,
	);
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
	const [editingFile, setEditingFile] = useState<WorktreeDiffFile | null>(null);
	const [editContent, setEditContent] = useState<string>("");
	const [isLoadingEdit, setIsLoadingEdit] = useState(false);
	const [isSavingEdit, setIsSavingEdit] = useState(false);
	const [isDeletingSelected, setIsDeletingSelected] = useState(false);
	const [showAddFile, setShowAddFile] = useState(false);
	const [newFilePath, setNewFilePath] = useState("");
	const [newFileContent, setNewFileContent] = useState("");
	const [isSavingNewFile, setIsSavingNewFile] = useState(false);

	const filteredFiles = useMemo(
		() => worktreeDiff?.files || [],
		[worktreeDiff?.files],
	);

	const tree = useMemo(
		() => (filteredFiles.length > 0 ? buildFileTree(filteredFiles) : []),
		[filteredFiles],
	);

	const hasFiles = filteredFiles.length > 0;
	const isEditMode = !!editingFile && !selectedPaths.size;

	const handleFileClick = useCallback((file: WorktreeDiffFile) => {
		setSelectedFile(file);
	}, []);

	const handleBackToList = useCallback(() => {
		setSelectedFile(null);
	}, []);

	const handleToggleSelect = useCallback((path: string) => {
		setSelectedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}, []);

	const handleSelectAll = useCallback(() => {
		if (filteredFiles.length === 0) return;
		if (selectedPaths.size === filteredFiles.length) {
			setSelectedPaths(new Set());
		} else {
			setSelectedPaths(new Set(filteredFiles.map((f) => f.path)));
		}
	}, [filteredFiles, selectedPaths.size]);

	const handleExpandAll = useCallback(() => {
		expandVersionRef.current += 1;
		setExpandSignal({ version: expandVersionRef.current, value: true });
	}, []);

	const handleCollapseAll = useCallback(() => {
		expandVersionRef.current += 1;
		setExpandSignal({ version: expandVersionRef.current, value: false });
	}, []);

	const handleEditFile = useCallback(
		async (file: WorktreeDiffFile) => {
			if (!worktreePath) {
				console.error("[DiffViewDialog] No worktreePath provided to edit file");
				return;
			}
			const api = (globalThis as any).electronAPI;
			if (!api?.worktreeReadFile) {
				console.error("[DiffViewDialog] electron.worktreeReadFile not available");
				return;
			}
			setEditingFile(file);
			setIsLoadingEdit(true);
			try {
				const result = await api.worktreeReadFile(
					worktreePath,
					file.path,
				);
				if (result.success) {
					setEditContent(result.data);
				} else {
					console.error("[DiffViewDialog] Failed to read file:", result);
				}
			} catch (error) {
				console.error("[DiffViewDialog] Error reading file:", error);
			} finally {
				setIsLoadingEdit(false);
			}
		},
		[worktreePath],
	);

	const handleSaveEdit = useCallback(async () => {
		if (!editingFile || !worktreePath || !onRefresh) {
			console.error("[DiffViewDialog] Missing required params for save:", {
				hasEditingFile: !!editingFile,
				hasWorktreePath: !!worktreePath,
				hasOnRefresh: !!onRefresh,
			});
			return;
		}

		const api = (globalThis as any).electronAPI;
		if (!api?.worktreeWriteFile) {
			console.error("[DiffViewDialog] electron.worktreeWriteFile not available");
			return;
		}

		setIsSavingEdit(true);
		try {
			const result = await api.worktreeWriteFile(
				worktreePath,
				editingFile.path,
				editContent,
			);
			if (result.success) {
				setEditingFile(null);
				setEditContent("");
				onRefresh();
			} else {
				console.error("[DiffViewDialog] Failed to save file:", result);
			}
		} catch (error) {
			console.error("[DiffViewDialog] Error saving file:", error);
		} finally {
			setIsSavingEdit(false);
		}
	}, [editingFile, worktreePath, editContent, onRefresh]);

	const handleCancelEdit = useCallback(() => {
		setEditingFile(null);
		setEditContent("");
	}, []);

	const handleDeleteSelected = useCallback(async () => {
		if (selectedPaths.size === 0 || !worktreePath || !onRefresh) {
			toast({
				title: t("taskReview:diff.error"),
				description: "Missing required information to delete files",
				variant: "destructive",
			});
			return;
		}

		const api = (globalThis as any).electronAPI;
		if (!api?.worktreeDeleteFiles) {
			toast({
				title: t("taskReview:diff.error"),
				description: "File operations not available",
				variant: "destructive",
			});
			return;
		}

		setIsDeletingSelected(true);
		try {
			const filesToDelete = Array.from(selectedPaths);
			console.log("[DiffViewDialog] Deleting files:", filesToDelete);

			const result = await api.worktreeDeleteFiles(
				worktreePath,
				filesToDelete,
			);

			console.log("[DiffViewDialog] Delete result:", result);

			if (result.success) {
				toast({
					title: "Success",
					description: `${result.data.deleted.length} file(s) discarded`,
				});
				setSelectedPaths(new Set());
				// Force refresh to update the list with filtered files
				await onRefresh();
			} else {
				toast({
					title: t("taskReview:diff.error"),
					description: `Failed to delete files: ${result.data?.failed?.join(", ") || "Unknown error"}`,
					variant: "destructive",
				});
			}
		} catch (error) {
			console.error("[DiffViewDialog] Error deleting files:", error);
			toast({
				title: t("taskReview:diff.error"),
				description: error instanceof Error ? error.message : "Unknown error",
				variant: "destructive",
			});
		} finally {
			setIsDeletingSelected(false);
		}
	}, [selectedPaths, worktreePath, onRefresh, toast, t]);

	const handleAddFile = useCallback(async () => {
		if (!newFilePath || !worktreePath || !onRefresh) {
			console.error("[DiffViewDialog] Missing required params for add file:", {
				hasNewFilePath: !!newFilePath,
				hasWorktreePath: !!worktreePath,
				hasOnRefresh: !!onRefresh,
			});
			return;
		}

		const api = (globalThis as any).electronAPI;
		if (!api?.worktreeWriteFile) {
			console.error("[DiffViewDialog] electron.worktreeWriteFile not available");
			return;
		}

		setIsSavingNewFile(true);
		try {
			const result = await api.worktreeWriteFile(
				worktreePath,
				newFilePath,
				newFileContent,
			);
			if (result.success) {
				setShowAddFile(false);
				setNewFilePath("");
				setNewFileContent("");
				onRefresh();
			} else {
				console.error("[DiffViewDialog] Failed to add file:", result);
			}
		} catch (error) {
			console.error("[DiffViewDialog] Error adding file:", error);
		} finally {
			setIsSavingNewFile(false);
		}
	}, [newFilePath, newFileContent, worktreePath, onRefresh]);

	// Helper function to render the appropriate content based on selection and view mode
	const renderContent = () => {
		// Edit mode: show textarea editor
		if (editingFile) {
			return (
				<div className="h-full flex flex-col gap-4">
					<div className="text-sm text-muted-foreground">
						{editingFile.path}
					</div>
					{isLoadingEdit ? (
						<div className="text-center py-8 text-muted-foreground">
							{t("taskReview:diff.loading")}
						</div>
					) : (
						<CodeEditor
							value={editContent}
							onChange={setEditContent}
							filename={editingFile.path}
							className="flex-1 min-h-0"
							autoFocus
						/>
					)}
				</div>
			);
		}

		// View diff mode
		if (selectedFile) {
			return (
				<div className="h-full">
					<DiffViewer
						patch={selectedFile.patch || ""}
						className="h-full max-h-[75vh] overflow-auto border rounded"
					/>
				</div>
			);
		}

		// Add file mode
		if (showAddFile) {
			return (
				<div className="h-full flex flex-col gap-4">
					<div className="space-y-2">
						<label className="text-sm font-medium">
							{t("taskReview:diff.filePath")}
						</label>
						<Input
							placeholder="src/example.ts"
							value={newFilePath}
							onChange={(e) => setNewFilePath(e.target.value)}
						/>
					</div>
					<div className="flex-1 flex flex-col gap-2">
						<label className="text-sm font-medium">
							{t("taskReview:diff.fileContent")}
						</label>
						<CodeEditor
							value={newFileContent}
							onChange={setNewFileContent}
							filename={newFilePath || undefined}
							className="flex-1 min-h-0"
						/>
					</div>
				</div>
			);
		}

		if (!hasFiles) {
			return (
				<div className="text-center py-8 text-muted-foreground">
					{t("taskReview:diff.noFiles")}
				</div>
			);
		}

		if (viewMode === "list") {
			return (
				<div className="space-y-2">
					{worktreePath && hasFiles && (
						<div className="flex items-center gap-2 p-2 pb-0">
							<Checkbox
								checked={selectedPaths.size === filteredFiles.length}
								onCheckedChange={handleSelectAll}
							/>
							<span className="text-sm font-medium">
								{t("taskReview:diff.selectAll")}
								{selectedPaths.size > 0 &&
									selectedPaths.size < filteredFiles.length &&
									` (${selectedPaths.size} selected)`}
							</span>
						</div>
					)}
					{filteredFiles.map((file, idx) => {
						const isSelected = selectedPaths.has(file.path);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events handled elsewhere
							// biome-ignore lint/a11y/noNoninteractiveElementInteractions: selectable file row
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
								key={idx}
								className="flex items-center justify-between p-2 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors"
							>
								<div
									className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer"
									onClick={() => handleFileClick(file)}
								>
									{worktreePath && (
										<Checkbox
											checked={isSelected}
											onCheckedChange={() =>
												handleToggleSelect(file.path)
											}
											onClick={(e) => e.stopPropagation()}
										/>
									)}
									{!worktreePath && <span className="w-4 shrink-0" />}
									<FileCode
										className={cn(
											"h-4 w-4 shrink-0",
											file.status === "added" && "text-success",
											file.status === "deleted" &&
												"text-destructive",
											file.status === "modified" && "text-info",
											file.status === "renamed" && "text-warning",
										)}
									/>
									<span className="text-sm font-mono truncate">
										{file.path}
									</span>
								</div>
								<div className="flex items-center gap-2 shrink-0 ml-2">
									<Badge
										variant="secondary"
										className={cn(
											"text-xs",
											file.status === "added" &&
												"bg-success/10 text-success",
											file.status === "deleted" &&
												"bg-destructive/10 text-destructive",
											file.status === "modified" &&
												"bg-info/10 text-info",
											file.status === "renamed" &&
												"bg-warning/10 text-warning",
										)}
									>
										{t(`taskReview:diff.status.${file.status}`)}
									</Badge>
									<span className="text-xs text-success">
										+{file.additions}
									</span>
									<span className="text-xs text-destructive">
										-{file.deletions}
									</span>
									{worktreePath && (
										<Button
											size="sm"
											variant="ghost"
											className={selectedPaths.size > 0 ? "invisible" : ""}
											onClick={(e) => {
												e.stopPropagation();
												handleEditFile(file);
											}}
										>
											{t("taskReview:diff.edit")}
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			);
		}

		// Tree view
		return (
			<div className="space-y-0.5">
				{tree.map((node) => (
					<FileTreeNode
						key={node.path}
						node={node}
						depth={0}
						defaultExpanded={true}
						expandSignal={expandSignal}
						t={t}
						onFileClick={handleFileClick}
						onEditFile={handleEditFile}
						canEdit={!!worktreePath}
						selectedPaths={selectedPaths}
						onToggleSelect={handleToggleSelect}
						canSelect={!!worktreePath}
					/>
				))}
			</div>
		);
	};

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-w-7xl max-h-[95vh] w-[95vw] h-[90vh] overflow-hidden flex flex-col">
				<AlertDialogHeader>
					<div className="flex items-center justify-between gap-4">
						<AlertDialogTitle className="flex items-center gap-2">
							{editingFile ? (
								<>
									<button
										type="button"
										onClick={handleCancelEdit}
										className="mr-2 p-1 hover:bg-muted rounded transition-colors"
										title={t("taskReview:diff.cancel")}
									>
										<ChevronRight className="h-4 w-4 rotate-180" />
									</button>
									<FileCode className="h-5 w-5 text-blue-400" />
									{t("taskReview:diff.editFile")}
								</>
							) : showAddFile ? (
								<>
									<button
										type="button"
										onClick={() => setShowAddFile(false)}
										className="mr-2 p-1 hover:bg-muted rounded transition-colors"
										title={t("taskReview:diff.cancel")}
									>
										<ChevronRight className="h-4 w-4 rotate-180" />
									</button>
									<Plus className="h-5 w-5 text-green-400" />
									{t("taskReview:diff.addFile")}
								</>
							) : selectedFile ? (
								<>
									<button
										type="button"
										onClick={handleBackToList}
										className="mr-2 p-1 hover:bg-muted rounded transition-colors"
										title={t("taskReview:diff.backToList")}
									>
										<ChevronRight className="h-4 w-4 rotate-180" />
									</button>
									<FileCode className="h-5 w-5 text-blue-400" />
									{selectedFile.path.split("/").pop()}
								</>
							) : (
								<>
									<Eye className="h-5 w-5 text-purple-400" />
									{t("taskReview:diff.title")}
								</>
							)}
						</AlertDialogTitle>

						{!selectedFile && !editingFile && !showAddFile && hasFiles && (
							<div className="flex items-center gap-2">
								{selectedPaths.size > 0 && (
									<span className="text-sm text-muted-foreground">
										{selectedPaths.size} {t("taskReview:diff.filesSelected")}
									</span>
								)}
								{viewMode === "tree" && selectedPaths.size === 0 && (
									<div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-secondary/30">
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={handleExpandAll}
													className="flex items-center justify-center h-7 w-7 rounded hover:bg-secondary/80 transition-colors text-muted-foreground hover:text-foreground"
													aria-label={t("taskReview:diff.expandAll")}
												>
													<FolderOpen className="h-3.5 w-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("taskReview:diff.expandAll")}
											</TooltipContent>
										</Tooltip>
										<div className="w-px h-4 bg-border" />
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={handleCollapseAll}
													className="flex items-center justify-center h-7 w-7 rounded hover:bg-secondary/80 transition-colors text-muted-foreground hover:text-foreground"
													aria-label={t("taskReview:diff.collapseAll")}
												>
													<Folder className="h-3.5 w-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("taskReview:diff.collapseAll")}
											</TooltipContent>
										</Tooltip>
									</div>
								)}
								<Select
									value={viewMode}
									onValueChange={(v) => setViewMode(v as ViewMode)}
									disabled={selectedPaths.size > 0}
								>
									<SelectTrigger className="w-[140px] h-8 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="list">
											{t("taskReview:diff.flatList")}
										</SelectItem>
										<SelectItem value="tree">
											{t("taskReview:diff.treeView")}
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						)}
					</div>
					<AlertDialogDescription>
						{editingFile
							? editingFile.path
							: showAddFile
								? t("taskReview:diff.addingNewFile")
								: selectedFile
									? `${selectedFile.path} - ${t(`taskReview:diff.status.${selectedFile.status}`)} (+${selectedFile.additions}, -${selectedFile.deletions})`
									: worktreeDiff?.summary || t("taskReview:diff.noChanges")}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="flex-1 overflow-auto min-h-0 -mx-6 px-6">
					{renderContent()}
				</div>

				{selectedPaths.size > 0 && (
					<div className="border-t pt-4 flex items-center justify-between bg-secondary/50 -mx-6 px-6 py-4 rounded-b-lg">
						<span className="text-sm font-medium">
							{selectedPaths.size} {t("taskReview:diff.filesSelected")}
						</span>
						<Button
							variant="destructive"
							size="sm"
							onClick={handleDeleteSelected}
							disabled={isDeletingSelected}
						>
							<Trash2 className="h-4 w-4 mr-2" />
							{isDeletingSelected
								? t("taskReview:diff.deleting")
								: t("taskReview:diff.deleteSelected")}
						</Button>
					</div>
				)}

				<AlertDialogFooter className="mt-4">
					{editingFile && (
						<>
							<Button
								variant="outline"
								onClick={handleCancelEdit}
								disabled={isSavingEdit}
							>
								{t("taskReview:diff.cancel")}
							</Button>
							<Button
								onClick={handleSaveEdit}
								disabled={isSavingEdit}
							>
								<Save className="h-4 w-4 mr-2" />
								{isSavingEdit
									? t("taskReview:diff.saving")
									: t("taskReview:diff.save")}
							</Button>
						</>
					)}
					{showAddFile && (
						<>
							<Button
								variant="outline"
								onClick={() => setShowAddFile(false)}
								disabled={isSavingNewFile}
							>
								{t("taskReview:diff.cancel")}
							</Button>
							<Button
								onClick={handleAddFile}
								disabled={isSavingNewFile || !newFilePath}
							>
								<Plus className="h-4 w-4 mr-2" />
								{isSavingNewFile
									? t("taskReview:diff.creating")
									: t("taskReview:diff.create")}
							</Button>
						</>
					)}
					{!editingFile && !showAddFile && (
						<>
							{worktreePath && selectedPaths.size === 0 && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowAddFile(true)}
								>
									<Plus className="h-4 w-4 mr-2" />
									{t("taskReview:diff.addFile")}
								</Button>
							)}
							<AlertDialogCancel>
								{t("taskReview:diff.close")}
							</AlertDialogCancel>
						</>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
