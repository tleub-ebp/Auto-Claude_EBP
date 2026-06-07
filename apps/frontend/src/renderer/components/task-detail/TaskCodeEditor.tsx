import {
	ChevronDown,
	ChevronRight,
	Copy,
	File,
	FileX,
	Folder,
	FolderOpen,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Subtask } from "../../../shared/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../ui/tooltip";

interface FileNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: FileNode[];
	content?: string;
}

interface TaskCodeEditorProps {
	readonly subtask: Subtask;
	readonly onUpdate?: (subtask: Subtask) => Promise<void>;
}

function buildFileTree(files: string[]): FileNode[] {
	const root: FileNode[] = [];

	for (const filePath of files) {
		const parts = filePath.replaceAll("\\", "/").split("/");
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
				});
			} else {
				let folder = current.find((n) => n.isFolder && n.name === name);
				if (!folder) {
					folder = {
						name,
						path: partPath,
						isFolder: true,
						children: [],
					};
					current.push(folder);
				}
				current = folder.children;
			}
		}
	}

	// Sort recursively
	function processNode(nodes: FileNode[]): void {
		for (const node of nodes) {
			if (node.isFolder) {
				processNode(node.children);
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

function FileTreeNode({
	node,
	depth,
	onFileClick,
	onDelete,
}: {
	readonly node: FileNode;
	readonly depth: number;
	readonly onFileClick?: (path: string) => void;
	readonly onDelete?: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	if (node.isFolder) {
		return (
			<>
				<div
					className="flex items-center justify-between p-1.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer select-none"
					style={{ paddingLeft: depth * 16 + 8 }}
					onClick={() => setExpanded(!expanded)}
				>
					<div className="flex items-center gap-1.5 min-w-0 flex-1">
						{expanded ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0" />
						)}
						{expanded ? (
							<FolderOpen className="h-4 w-4 shrink-0 text-amber-400" />
						) : (
							<Folder className="h-4 w-4 shrink-0 text-amber-400" />
						)}
						<span className="text-sm font-medium truncate">{node.name}</span>
					</div>
				</div>
				{expanded &&
					node.children.map((child) => (
						<FileTreeNode
							key={child.path}
							node={child}
							depth={depth + 1}
							onFileClick={onFileClick}
							onDelete={onDelete}
						/>
					))}
			</>
		);
	}

	return (
		<div
			className="flex items-center justify-between p-1.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer select-none group"
			style={{ paddingLeft: depth * 16 + 8 }}
			onClick={() => onFileClick?.(node.path)}
		>
			<div className="flex items-center gap-1.5 min-w-0 flex-1">
				<File className="h-4 w-4 shrink-0 text-blue-400" />
				<span className="text-sm truncate">{node.name}</span>
			</div>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={(e) => {
							e.stopPropagation();
							onDelete?.(node.path);
						}}
					>
						<Trash2 className="h-3.5 w-3.5 text-destructive" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Delete file</TooltipContent>
			</Tooltip>
		</div>
	);
}

export function TaskCodeEditor({
	subtask,
	onUpdate,
}: TaskCodeEditorProps) {
	const { t } = useTranslation(["tasks"]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [editedFiles, setEditedFiles] = useState<Map<string, string>>(
		new Map(),
	);
	const [deletedFiles, setDeletedFiles] = useState<Set<string>>(new Set());
	const [hasChanges, setHasChanges] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const fileTree = buildFileTree(
		subtask.files.filter((f) => !deletedFiles.has(f)),
	);

	const handleFileDelete = useCallback((path: string) => {
		setDeletedFiles((prev) => {
			const next = new Set(prev);
			next.add(path);
			return next;
		});
		setEditedFiles((prev) => {
			const next = new Map(prev);
			next.delete(path);
			return next;
		});
		setSelectedFile(null);
		setHasChanges(true);
	}, []);

	const handleContentChange = useCallback((content: string) => {
		if (selectedFile) {
			setEditedFiles((prev) => {
				const next = new Map(prev);
				next.set(selectedFile, content);
				return next;
			});
			setHasChanges(true);
		}
	}, [selectedFile]);

	const handleSave = async () => {
		if (!onUpdate) return;

		setIsSaving(true);
		try {
			const updatedSubtask: Subtask = {
				...subtask,
				files: subtask.files.filter((f) => !deletedFiles.has(f)),
			};

			await onUpdate(updatedSubtask);
			setEditedFiles(new Map());
			setDeletedFiles(new Set());
			setHasChanges(false);
			setSelectedFile(null);
		} catch (error) {
			console.error("Failed to save changes:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const currentFileContent = selectedFile
		? editedFiles.get(selectedFile) || ""
		: "";

	return (
		<div className="flex gap-4 h-full">
			{/* File tree sidebar */}
			<div className="w-64 border-r border-border">
				<ScrollArea className="h-full">
					<div className="p-2 space-y-1">
						{fileTree.length === 0 ? (
							<p className="text-xs text-muted-foreground p-2">
								No files in this subtask
							</p>
						) : (
							fileTree.map((node) => (
								<FileTreeNode
									key={node.path}
									node={node}
									depth={0}
									onFileClick={setSelectedFile}
									onDelete={handleFileDelete}
								/>
							))
						)}
					</div>
				</ScrollArea>
			</div>

			{/* Editor panel */}
			<div className="flex-1 flex flex-col">
				{selectedFile ? (
					<>
						<div className="p-3 border-b border-border bg-muted/50">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<File className="h-4 w-4 text-blue-400" />
									<span className="text-sm font-mono">{selectedFile}</span>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setSelectedFile(null)}
									className="h-6"
								>
									Close
								</Button>
							</div>
						</div>
						<div className="flex-1 flex flex-col">
							<Textarea
								value={currentFileContent}
								onChange={(e) => handleContentChange(e.target.value)}
								placeholder="File content..."
								className="flex-1 rounded-none border-0 font-mono text-xs resize-none"
							/>
						</div>
					</>
				) : (
					<div className="flex-1 flex items-center justify-center text-muted-foreground">
						<p>Select a file to edit</p>
					</div>
				)}

				{/* Footer with save button */}
				{hasChanges && (
					<div className="p-3 border-t border-border bg-muted/30 flex items-center justify-between">
						<p className="text-xs text-muted-foreground">
							{deletedFiles.size > 0 && `${deletedFiles.size} file(s) deleted`}
							{deletedFiles.size > 0 && editedFiles.size > 0 && " • "}
							{editedFiles.size > 0 && `${editedFiles.size} file(s) modified`}
						</p>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setEditedFiles(new Map());
									setDeletedFiles(new Set());
									setHasChanges(false);
									setSelectedFile(null);
								}}
								disabled={isSaving}
							>
								Cancel
							</Button>
							<Button
								variant="default"
								size="sm"
								onClick={handleSave}
								disabled={isSaving}
							>
								{isSaving ? "Saving..." : "Save Changes"}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
