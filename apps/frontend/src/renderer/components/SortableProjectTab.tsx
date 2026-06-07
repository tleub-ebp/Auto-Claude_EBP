import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, FolderSearch, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "../../shared/types";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface SortableProjectTabProps {
	readonly project: Project;
	readonly isActive: boolean;
	readonly canClose: boolean;
	readonly tabIndex: number;
	readonly onSelect: () => void;
	readonly onClose: (e: React.MouseEvent) => void;
	readonly onRename?: (projectId: string, name: string) => void;
	/** True when the on-disk project folder no longer exists. */
	readonly isMissing?: boolean;
	/** Called when the user picks a new folder to re-point the project at. */
	readonly onRepath?: (projectId: string) => void;
	// Optional control props for active tab
	readonly onSettingsClick?: () => void;
}

// Detect if running on macOS for keyboard shortcut display
// Detect if running on macOS for keyboard shortcut display
const isMac = ((): boolean => {
	if (typeof navigator === "undefined") return false;
	// Modern: User-Agent Client Hints (preferred)
	if ("userAgentData" in navigator && navigator.userAgentData) {
		const { platform } = navigator.userAgentData;
		if (platform) return platform.toUpperCase().includes("MAC");
	}
	// Fallback: userAgent string (platform is deprecated)
	return navigator.userAgent.toUpperCase().includes("MAC");
})();
const modKey = isMac ? "⌘" : "Ctrl+";

export function SortableProjectTab({
	project,
	isActive,
	canClose,
	tabIndex,
	onSelect,
	onClose,
	onRename,
	isMissing = false,
	onRepath,
	onSettingsClick,
}: SortableProjectTabProps) {
	const { t } = useTranslation("common");
	const [isEditing, setIsEditing] = useState(false);
	const [isMissingPopoverOpen, setIsMissingPopoverOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const committedRef = useRef(false);

	// Build tooltip with keyboard shortcut hint (only for tabs 1-9)
	const shortcutHint = tabIndex < 9 ? `${modKey}${tabIndex + 1}` : "";
	const closeShortcut = `${modKey}W`;
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: project.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		// Prevent z-index stacking issues during drag
		zIndex: isDragging ? 50 : undefined,
	};

	const startEditing = () => {
		committedRef.current = false;
		setIsEditing(true);
		setTimeout(() => inputRef.current?.select(), 0);
	};

	const commitRename = () => {
		if (committedRef.current) return;
		committedRef.current = true;
		const trimmed = (inputRef.current?.value ?? "").trim();
		if (trimmed && trimmed !== project.name) {
			onRename?.(project.id, trimmed);
		}
		setIsEditing(false);
	};

	const cancelRename = () => {
		committedRef.current = true;
		setIsEditing(false);
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"group relative flex items-center shrink-0",
				"border-r border-border last:border-r-0",
				"touch-none transition-all duration-200",
				isDragging && "opacity-60 scale-[0.98] shadow-lg",
			)}
			data-project-id={project.id}
			{...attributes}
		>
			<Tooltip delayDuration={isEditing ? 99999 : 200}>
				<TooltipTrigger asChild>
					{isEditing ? (
						<div
							className={cn(
								"flex-1 flex items-center gap-1 sm:gap-2",
								"px-2 sm:px-3 md:px-4 py-2 sm:py-2.5",
								"text-xs sm:text-sm min-w-0",
								"border-b-2 border-transparent",
								isActive
									? "bg-accent/80 border-b-primary text-foreground shadow-sm"
									: "bg-muted/30 text-muted-foreground",
							)}
						>
							<div className="hidden sm:block w-1 h-4 shrink-0" />
							<input
								ref={inputRef}
								type="text"
								defaultValue={project.name}
								onBlur={commitRename}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										e.preventDefault();
										commitRename();
									} else if (e.key === "Escape") {
										e.preventDefault();
										cancelRename();
									}
								}}
								className="truncate font-medium bg-transparent outline-none border-b border-primary w-full min-w-0"
								aria-label={t("projectTab.renameAriaLabel")}
							/>
						</div>
					) : (
						<button
							type="button"
							className={cn(
								"flex-1 flex items-center gap-1 sm:gap-2",
								"px-2 sm:px-3 md:px-4 py-2 sm:py-2.5",
								"text-xs sm:text-sm",
								"min-w-0 truncate hover:bg-muted/50 transition-colors",
								"border-b-2 border-transparent cursor-pointer",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
								isActive && [
									"bg-accent/80 border-b-primary text-foreground shadow-sm",
									"hover:bg-accent/90",
								],
								!isActive && [
									"bg-muted/30 text-muted-foreground",
									"hover:bg-muted/50 hover:text-foreground",
								],
							)}
							onClick={onSelect}
							onDoubleClick={(e) => {
								e.stopPropagation();
								if (onRename) startEditing();
							}}
							aria-label={t("projectTab.selectTab", {
								projectName: project.name,
							})}
						>
							<div
								{...listeners}
								className={cn(
									"hidden sm:block",
									"opacity-0 group-hover:opacity-60 transition-opacity",
									"cursor-grab active:cursor-grabbing",
									"w-1 h-4 bg-muted-foreground rounded-full shrink-0",
								)}
							/>
							{isMissing && (
								<AlertTriangle
									className="h-3.5 w-3.5 shrink-0 text-destructive"
									aria-hidden
								/>
							)}
							<span
								className={cn(
									"truncate font-medium",
									isMissing && "line-through text-destructive/80",
								)}
							>
								{project.name}
							</span>
						</button>
					)}
				</TooltipTrigger>
				<TooltipContent side="bottom" className="flex flex-col items-start gap-1 max-w-xs">
					<div className="flex items-center gap-2">
						<span>{project.name}</span>
						{shortcutHint && (
							<kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border border-border font-mono">
								{shortcutHint}
							</kbd>
						)}
					</div>
					{isMissing && (
						<div className="flex items-start gap-1 text-xs text-destructive">
							<AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
							<div className="space-y-0.5">
								<div>{t("projectTab.missingPathTitle")}</div>
								<div className="font-mono opacity-80 break-all">
									{project.path}
								</div>
							</div>
						</div>
					)}
				</TooltipContent>
			</Tooltip>

			{isMissing && onRepath && (
				<Popover
					open={isMissingPopoverOpen}
					onOpenChange={setIsMissingPopoverOpen}
				>
					<Tooltip delayDuration={200}>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<button
									type="button"
									className={cn(
										"h-5 w-5 sm:h-6 sm:w-6 p-0 mr-0.5 sm:mr-1",
										"rounded shrink-0 flex items-center justify-center",
										"text-destructive hover:bg-destructive/10",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
									)}
									onClick={(e) => e.stopPropagation()}
									aria-label={t("projectTab.missingPathFix")}
								>
									<FolderSearch className="h-3.5 w-3.5" />
								</button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							<span>{t("projectTab.missingPathFix")}</span>
						</TooltipContent>
					</Tooltip>
					<PopoverContent side="bottom" align="end" className="w-72">
						<div className="space-y-3">
							<div className="flex items-start gap-2">
								<AlertTriangle className="h-4 w-4 shrink-0 text-destructive mt-0.5" aria-hidden />
								<div className="space-y-1">
									<h4 className="text-sm font-medium">
										{t("projectTab.missingPathTitle")}
									</h4>
									<p className="text-xs text-muted-foreground font-mono break-all">
										{project.path}
									</p>
								</div>
							</div>
							<p className="text-xs text-muted-foreground">
								{t("projectTab.missingPathDescription")}
							</p>
							<div className="flex gap-2">
								<Button
									size="sm"
									className="flex-1 gap-1"
									onClick={() => {
										setIsMissingPopoverOpen(false);
										onRepath(project.id);
									}}
								>
									<FolderSearch className="h-3.5 w-3.5" />
									{t("projectTab.missingPathFixAction")}
								</Button>
								{canClose && (
									<Button
										variant="outline"
										size="sm"
										onClick={(e) => {
											setIsMissingPopoverOpen(false);
											onClose(e);
										}}
									>
										{t("projectTab.missingPathRemove")}
									</Button>
								)}
							</div>
						</div>
					</PopoverContent>
				</Popover>
			)}

			{/* Active tab controls - settings and archive, always accessible */}
			{isActive && (
				<div className="flex items-center gap-0.5 mr-0.5 sm:mr-1 shrink-0">
					{/* Settings icon - responsive sizing */}
					{onSettingsClick && (
						<Tooltip delayDuration={200}>
							<TooltipTrigger asChild>
								<button
									type="button"
									className={cn(
										"h-5 w-5 sm:h-6 sm:w-6 p-0 rounded",
										"flex items-center justify-center",
										"text-muted-foreground hover:text-foreground",
										"hover:bg-muted/50 transition-colors",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
									)}
									onClick={(e) => {
										e.stopPropagation();
										onSettingsClick();
									}}
									aria-label={t("projectTab.settings")}
								>
									<Settings2 className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<span>{t("projectTab.settings")}</span>
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			)}

			{canClose && (
				<Tooltip delayDuration={200}>
					<TooltipTrigger asChild>
						<button
							type="button"
							className={cn(
								"h-5 w-5 sm:h-6 sm:w-6 p-0 mr-0.5 sm:mr-1",
								"opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
								"transition-opacity duration-200 rounded shrink-0",
								"hover:bg-destructive hover:text-destructive-foreground",
								"flex items-center justify-center",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
								isActive && "opacity-100",
							)}
							onClick={(e) => {
								onClose(e);
							}}
							aria-label={t("projectTab.closeTabAriaLabel")}
						>
							{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative, intentional  */}
							<svg
								className="h-3 w-3"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" className="flex items-center gap-2">
						<span>{t("projectTab.closeTab")}</span>
						<kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border border-border font-mono">
							{closeShortcut}
						</kbd>
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}
