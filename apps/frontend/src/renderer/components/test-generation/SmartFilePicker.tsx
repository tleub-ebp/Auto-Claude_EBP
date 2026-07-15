import type { FileNode } from "@shared/types";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	FileCode,
	Folder,
	FolderOpen,
	Loader2,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";

/** Candidate sub-folders to try, in priority order, per tab type */
const FOLDER_CANDIDATES: Record<string, string[]> = {
	unit: ["src", "lib", "app", "packages"],
	analyze: ["src", "lib", "app", "packages"],
	e2e: ["e2e", "cypress", "playwright", "tests/e2e", "__tests__/e2e"],
	tdd: ["src", "lib", "app"],
};

/** Source file extensions worth showing */
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".java",
	".cs",
	".rs",
	".cpp",
	".c",
	".h",
	".vue",
	".svelte",
	".php",
	".kt",
	".swift",
]);

function isSourceFile(name: string): boolean {
	const ext = name.slice(name.lastIndexOf("."));
	return SOURCE_EXTENSIONS.has(ext);
}

function getFileIcon(node: FileNode) {
	if (node.isDirectory) return null;
	return (
		<FileCode className="w-3.5 h-3.5 shrink-0 text-(--color-text-secondary)" />
	);
}

interface SmartFilePickerProps {
	readonly value: string;
	readonly onChange: (path: string) => void;
	readonly tabType?: "unit" | "analyze" | "e2e" | "tdd";
	readonly placeholder?: string;
}

export function SmartFilePicker({
	value,
	onChange,
	tabType = "unit",
	placeholder,
}: SmartFilePickerProps) {
	const { t } = useTranslation(["testGeneration"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path ?? "";

	const [isOpen, setIsOpen] = useState(false);
	const [currentDir, setCurrentDir] = useState("");
	const [breadcrumbs, setBreadcrumbs] = useState<
		{ name: string; path: string }[]
	>([]);
	const [entries, setEntries] = useState<FileNode[]>([]);
	const [loading, setLoading] = useState(false);
	const [filter, setFilter] = useState("");
	const filterRef = useRef<HTMLInputElement>(null);

	/** Resolve the best starting directory for this tab */
	const resolveStartDir = useCallback(
		async (root: string): Promise<string> => {
			const candidates = FOLDER_CANDIDATES[tabType] ?? [];
			for (const candidate of candidates) {
				const candidatePath = `${root}/${candidate}`.replaceAll("\\", "/");
				try {
					const result =
						await globalThis.electronAPI.listDirectory(candidatePath);
					if (result.success) return candidatePath;
				} catch {
					// try next
				}
			}
			return root;
		},
		[tabType],
	);

	/** Load a directory */
	const loadDir = useCallback(async (dirPath: string) => {
		setLoading(true);
		setFilter("");
		try {
			const result = await globalThis.electronAPI.listDirectory(dirPath);
			if (result.success && result.data) {
				// Show directories + source files only
				const filtered = result.data.filter(
					(n) => n.isDirectory || isSourceFile(n.name),
				);
				setEntries(filtered);
				setCurrentDir(dirPath);
			}
		} finally {
			setLoading(false);
		}
	}, []);

	/** Open the picker and initialize at the right folder */
	const handleOpen = useCallback(async () => {
		setIsOpen(true);
		if (!currentDir && projectPath) {
			const startDir = await resolveStartDir(projectPath);
			// Build initial breadcrumbs relative to project
			const rel = startDir.replace(projectPath, "").replace(/^[/\\]+/, "");
			const crumbs: { name: string; path: string }[] = [
				{ name: activeProject?.name ?? "~", path: projectPath },
			];
			if (rel) {
				let acc = projectPath;
				for (const part of rel.split(/[/\\]/)) {
					acc = `${acc}/${part}`;
					crumbs.push({ name: part, path: acc });
				}
			}
			setBreadcrumbs(crumbs);
			await loadDir(startDir);
		}
	}, [currentDir, projectPath, resolveStartDir, loadDir, activeProject]);

	/** Navigate into a directory */
	const navigateInto = useCallback(
		async (node: FileNode) => {
			setBreadcrumbs((prev) => [...prev, { name: node.name, path: node.path }]);
			await loadDir(node.path);
		},
		[loadDir],
	);

	/** Navigate via breadcrumb */
	const navigateTo = useCallback(
		async (crumb: { name: string; path: string }, idx: number) => {
			setBreadcrumbs((prev) => prev.slice(0, idx + 1));
			await loadDir(crumb.path);
		},
		[loadDir],
	);

	/** Select a file */
	const selectFile = useCallback(
		(node: FileNode) => {
			onChange(node.path);
			setIsOpen(false);
			setFilter("");
		},
		[onChange],
	);

	/** Clear selection */
	const clearSelection = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onChange("");
		},
		[onChange],
	);

	// Focus filter when opened
	useEffect(() => {
		if (isOpen) {
			setTimeout(() => filterRef.current?.focus(), 50);
		}
	}, [isOpen]);

	const filteredEntries = filter
		? entries.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()))
		: entries;

	const displayValue = value
		? value.replace(projectPath, "").replace(/^[/\\]+/, "") || value
		: "";

	const openStateClasses =
		"border-[var(--color-accent)] bg-[var(--color-accent)]/5";
	const hasValueClasses =
		"border-[var(--color-border)] bg-[var(--color-bg-secondary)]";
	const noValueClasses =
		"border-dashed border-[var(--color-border)] bg-transparent";

	let buttonClasses: string;
	if (isOpen) {
		buttonClasses = openStateClasses;
	} else if (value) {
		buttonClasses = hasValueClasses;
	} else {
		buttonClasses = noValueClasses;
	}

	return (
		<div className="space-y-1.5">
			{/* Selected file chip / trigger.
			    Rendered as a div (not a button) because it can contain the clear
			    button, and a <button> may not nest another <button>. */}
			<div
				role="button"
				tabIndex={0}
				aria-expanded={isOpen}
				onClick={isOpen ? () => setIsOpen(false) : handleOpen}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						if (isOpen) {
							setIsOpen(false);
						} else {
							void handleOpen();
						}
					}
				}}
				className={cn(
					"w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-left transition-all duration-200 cursor-pointer",
					"hover:border-accent focus:outline-none focus:border-accent",
					buttonClasses,
				)}
			>
				{value ? (
					<>
						<FileCode className="w-4 h-4 shrink-0 text-accent" />
						<span className="flex-1 text-sm font-mono truncate text-(--color-text-primary)">
							{displayValue}
						</span>
						<button
							type="button"
							onClick={clearSelection}
							className="p-0.5 rounded hover:bg-(--color-bg-tertiary) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					</>
				) : (
					<>
						<FolderOpen className="w-4 h-4 shrink-0 text-(--color-text-secondary)" />
						<span className="flex-1 text-sm text-(--color-text-secondary)">
							{placeholder ?? t("testGeneration:filePicker.selectFile")}
						</span>
					</>
				)}
				<span className="text-(--color-text-secondary)">
					{isOpen ? (
						<ChevronUp className="w-4 h-4" />
					) : (
						<ChevronDown className="w-4 h-4" />
					)}
				</span>
			</div>

			{/* Inline file tree panel */}
			{isOpen && (
				<div className="rounded-lg border border-border bg-(--color-bg-secondary) overflow-hidden shadow-lg">
					{/* Breadcrumb */}
					<div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto scrollbar-none">
						{breadcrumbs.map((crumb, idx) => (
							<span
								key={crumb.path}
								className="flex items-center gap-1 shrink-0"
							>
								{idx > 0 && (
									<ChevronRight className="w-3 h-3 text-(--color-text-secondary)" />
								)}
								<button
									type="button"
									onClick={() => navigateTo(crumb, idx)}
									className={cn(
										"text-xs px-1.5 py-0.5 rounded transition-colors",
										idx === breadcrumbs.length - 1
											? "text-(--color-text-primary) font-medium bg-accent/10"
											: "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-tertiary)",
									)}
								>
									{crumb.name}
								</button>
							</span>
						))}
					</div>

					{/* Search filter */}
					<div className="flex items-center gap-2 px-3 py-2 border-b border-border">
						<Search className="w-3.5 h-3.5 shrink-0 text-(--color-text-secondary)" />
						<input
							ref={filterRef}
							type="text"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t("testGeneration:filePicker.filter")}
							className="flex-1 bg-transparent text-sm text-(--color-text-primary) placeholder:text-(--color-text-secondary) outline-none"
						/>
						{filter && (
							<button
								type="button"
								onClick={() => setFilter("")}
								className="text-(--color-text-secondary) hover:text-(--color-text-primary)"
							>
								<X className="w-3 h-3" />
							</button>
						)}
					</div>

					{/* File list */}
					<div className="max-h-56 overflow-y-auto">
						{loading && (
							<div className="flex items-center justify-center py-6">
								<Loader2 className="w-4 h-4 animate-spin text-(--color-text-secondary)" />
							</div>
						)}

						{!loading && filteredEntries.length === 0 && (
							<p className="text-xs text-(--color-text-secondary) text-center py-6">
								{t("testGeneration:filePicker.empty")}
							</p>
						)}

						{!loading && filteredEntries.length > 0 && (
							<ul>
								{filteredEntries.map((node) => (
									<li key={node.path}>
										<button
											type="button"
											onClick={() =>
												node.isDirectory ? navigateInto(node) : selectFile(node)
											}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
												"hover:bg-accent/10 group",
												!node.isDirectory &&
													node.path === value &&
													"bg-accent/15",
											)}
										>
											{node.isDirectory ? (
												<Folder className="w-3.5 h-3.5 shrink-0 text-accent opacity-70 group-hover:opacity-100" />
											) : (
												getFileIcon(node)
											)}
											<span
												className={cn(
													"flex-1 truncate font-mono",
													node.isDirectory
														? "text-(--color-text-primary)"
														: "text-(--color-text-secondary) group-hover:text-(--color-text-primary)",
												)}
											>
												{node.name}
											</span>
											{node.isDirectory && (
												<ChevronRight className="w-3 h-3 shrink-0 text-(--color-text-secondary) opacity-0 group-hover:opacity-100 transition-opacity" />
											)}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
