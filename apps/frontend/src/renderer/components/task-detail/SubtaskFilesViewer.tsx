import {
	ChevronDown,
	Code2,
	File,
	FileCode,
	FileJson,
	FileText,
	Folder,
	FolderOpen,
	Package,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

interface SubtaskFilesViewerProps {
	files: string[];
	subtaskTitle: string;
	onClose: () => void;
}

interface FileTreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children?: FileTreeNode[];
	fileExtension?: string;
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
			return <FileCode className={cn(iconClass, "text-purple-500")} />;
		default:
			return <File className={cn(iconClass, "text-muted-foreground")} />;
	}
}

function buildFileTree(files: string[]): FileTreeNode[] {
	const root: Record<string, FileTreeNode> = {};

	for (const filePath of files) {
		const parts = filePath.split("/").filter(Boolean);
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
	onToggle: (path: string) => void;
}

function FileTreeItem({ node, level, expanded, onToggle }: FileTreeItemProps) {
	const isExpanded = expanded[node.path];
	const hasChildren = node.children && node.children.length > 0;

	return (
		<div>
			<button
				onClick={() => hasChildren && onToggle(node.path)}
				className={cn(
					"w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 transition-colors text-sm group",
					"text-foreground hover:text-foreground",
				)}
				style={{ paddingLeft: `${12 + level * 16}px` }}
			>
				{hasChildren ? (
					<ChevronDown
						className={cn(
							"h-4 w-4 text-muted-foreground transition-transform flex-shrink-0",
							!isExpanded && "-rotate-90",
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

				{!node.isFolder && (
					<Badge
						variant="outline"
						className="text-xs h-5 px-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
					>
						{node.path.split(".").pop()}
					</Badge>
				)}
			</button>

			{hasChildren && isExpanded && (
				<div>
					{node.children!.map((child) => (
						<FileTreeItem
							key={child.path}
							node={child}
							level={level + 1}
							expanded={expanded}
							onToggle={onToggle}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function SubtaskFilesViewer({
	files,
	subtaskTitle,
	onClose,
}: SubtaskFilesViewerProps) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const fileTree = useMemo(() => buildFileTree(files), [files]);

	const handleToggle = (path: string) => {
		setExpanded((prev) => ({
			...prev,
			[path]: !prev[path],
		}));
	};

	const handleExpandAll = () => {
		const allPaths: Record<string, boolean> = {};
		const collectPaths = (nodes: FileTreeNode[]) => {
			for (const node of nodes) {
				if (node.isFolder) {
					allPaths[node.path] = true;
					if (node.children) {
						collectPaths(node.children);
					}
				}
			}
		};
		collectPaths(fileTree);
		setExpanded(allPaths);
	};

	const handleCollapseAll = () => {
		setExpanded({});
	};

	const fileCount = files.length;
	const folderCount = fileTree.length;

	return (
		<div className="h-full flex flex-col bg-background border-l border-border">
			{/* Header */}
			<div className="flex-shrink-0 p-4 border-b border-border">
				<div className="flex items-start justify-between gap-3 mb-3">
					<div className="flex items-center gap-3 min-w-0">
						<div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
							<Code2 className="h-5 w-5 text-primary" />
						</div>
						<div className="min-w-0">
							<h3 className="text-sm font-semibold text-foreground truncate">
								{subtaskTitle}
							</h3>
							<p className="text-xs text-muted-foreground">
								{fileCount} file{fileCount !== 1 ? "s" : ""} modified
							</p>
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
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleExpandAll}
							className="text-xs h-7 flex-1"
						>
							<ChevronDown className="h-3 w-3 mr-1" />
							Expand all
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleCollapseAll}
							className="text-xs h-7 flex-1"
						>
							<ChevronDown className="h-3 w-3 mr-1 rotate-180" />
							Collapse all
						</Button>
					</div>
				)}
			</div>

			{/* File Tree */}
			<ScrollArea className="flex-1">
				<div className="p-4">
					{fileTree.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<Package className="h-8 w-8 mb-3 opacity-40" />
							<span className="text-sm font-medium">No files modified yet</span>
							<span className="text-xs opacity-70 mt-1">Files will appear here as changes are made</span>
						</div>
					) : (
						fileTree.map((node) => (
							<FileTreeItem
								key={node.path}
								node={node}
								level={0}
								expanded={expanded}
								onToggle={handleToggle}
							/>
						))
					)}
				</div>
			</ScrollArea>

			{/* Stats */}
			{fileCount > 0 && (
				<div className="flex-shrink-0 p-3 border-t border-border bg-muted/30">
					<div className="grid grid-cols-3 gap-2 text-center text-xs">
						<div>
							<p className="font-semibold text-foreground">{fileCount}</p>
							<p className="text-muted-foreground">Files</p>
						</div>
						<div>
							<p className="font-semibold text-foreground">{folderCount}</p>
							<p className="text-muted-foreground">Folders</p>
						</div>
						<div>
							<p className="font-semibold text-foreground">
								{Math.ceil(fileCount / 5)}
							</p>
							<p className="text-muted-foreground">Groups</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
