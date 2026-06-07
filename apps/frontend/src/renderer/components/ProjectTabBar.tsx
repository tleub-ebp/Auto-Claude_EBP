import type { Project, UsageSnapshot } from "@shared/types";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { AuthStatusIndicator } from "./AuthStatusIndicator";
import { useProviderContext } from "./ProviderContext";
import { SortableProjectTab } from "./SortableProjectTab";
import { UsageIndicator } from "./UsageIndicator";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ProjectTabBarProps {
	readonly projects: Project[];
	readonly activeProjectId: string | null;
	readonly onProjectSelect: (projectId: string) => void;
	readonly onProjectClose: (projectId: string) => void;
	readonly onAddProject: () => void;
	readonly onProjectRename?: (projectId: string, name: string) => void;
	readonly className?: string;
	readonly onSettingsClick?: () => void;
}

export function ProjectTabBar({
	projects,
	activeProjectId,
	onProjectSelect,
	onProjectClose,
	onAddProject,
	onProjectRename,
	className,
	onSettingsClick,
}: ProjectTabBarProps) {
	const { t } = useTranslation("common");
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);
	const { selectedProvider } = useProviderContext();
	const missingPaths = useProjectStore((state) => state.missingPaths);
	const repathProjectAction = useProjectStore((state) => state.repathProject);

	// Open native directory picker and re-point the project at the chosen folder.
	// Silently no-ops on cancel; on failure the missing-path indicator stays so
	// the user can retry.
	const handleRepathProject = useCallback(
		async (projectId: string) => {
			try {
				const newPath = await globalThis.electronAPI?.selectDirectory?.();
				if (!newPath) return;
				await repathProjectAction(projectId, newPath);
			} catch (err) {
				console.error("[ProjectTabBar] repath failed:", err);
			}
		},
		[repathProjectAction],
	);

	// State for usage warning
	const [usage, setUsage] = useState<UsageSnapshot | null>(null);
	const [isLoadingUsage, setIsLoadingUsage] = useState(true);

	// Check scroll position
	const checkScrollPosition = () => {
		const container = scrollContainerRef.current;
		if (!container) return;

		setCanScrollLeft(container.scrollLeft > 0);
		setCanScrollRight(
			container.scrollLeft < container.scrollWidth - container.clientWidth,
		);
	};

	// Scroll tabs
	const scrollTabs = (direction: "left" | "right") => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const scrollAmount = 200; // pixels
		container.scrollBy({
			left: direction === "left" ? -scrollAmount : scrollAmount,
			behavior: "smooth",
		});
	};

	// Auto-scroll to active tab
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container || !activeProjectId) return;

		const activeTab = container.querySelector(
			`[data-project-id="${activeProjectId}"]`,
		);
		if (activeTab) {
			activeTab.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
				inline: "center",
			});
		}
	}, [activeProjectId]);

	// Check scroll on mount and resize
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		checkScrollPosition();
		container.addEventListener("scroll", checkScrollPosition);
		globalThis.addEventListener("resize", checkScrollPosition);

		return () => {
			container.removeEventListener("scroll", checkScrollPosition);
			globalThis.removeEventListener("resize", checkScrollPosition);
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [checkScrollPosition]);

	// Keyboard shortcuts for tab navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Skip if in input fields
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement ||
				(e.target as HTMLElement)?.isContentEditable
			) {
				return;
			}

			const isMod = e.metaKey || e.ctrlKey;
			if (!isMod) return;

			// Cmd/Ctrl + 1-9: Switch to tab N
			if (e.key >= "1" && e.key <= "9") {
				e.preventDefault();
				const index = Number.parseInt(e.key, 10) - 1;
				if (index < projects.length) {
					onProjectSelect(projects[index].id);
				}
				return;
			}

			// Cmd/Ctrl + Tab: Next tab
			// Cmd/Ctrl + Shift + Tab: Previous tab
			if (e.key === "Tab") {
				e.preventDefault();
				const currentIndex = projects.findIndex(
					(p) => p.id === activeProjectId,
				);
				if (currentIndex === -1 || projects.length === 0) return;

				const nextIndex = e.shiftKey
					? (currentIndex - 1 + projects.length) % projects.length
					: (currentIndex + 1) % projects.length;
				onProjectSelect(projects[nextIndex].id);
				return;
			}

			// Cmd/Ctrl + W: Close current tab
			if (e.key === "w" && activeProjectId) {
				e.preventDefault();
				onProjectClose(activeProjectId);
			}
		};

		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [projects, activeProjectId, onProjectSelect, onProjectClose]);

	// Fetch usage data for warning badge — scoped to selected provider
	useEffect(() => {
		// Clear stale data when provider changes
		setUsage(null);
		setIsLoadingUsage(true);

		if (!selectedProvider) return;

		const fetchUsage = async () => {
			try {
				const result =
					await globalThis.electronAPI.requestUsageUpdate(selectedProvider);
				if (result.success && result.data) {
					// Only accept data matching current provider
					if (
						!result.data.providerName ||
						result.data.providerName === selectedProvider
					) {
						setUsage(result.data);
					}
				}
			} catch (error) {
				console.error("Failed to fetch usage snapshot:", error);
				setUsage(null);
			} finally {
				setIsLoadingUsage(false);
			}
		};

		fetchUsage();

		// Subscribe to live usage updates — only accept matching provider
		const unsubscribe = globalThis.electronAPI.onUsageUpdated(
			(snapshot: UsageSnapshot) => {
				if (snapshot.providerName !== selectedProvider) return;
				setUsage(snapshot);
				setIsLoadingUsage(false);
			},
		);

		return () => {
			unsubscribe();
		};
	}, [selectedProvider]);

	return (
		<div
			className={cn(
				"flex items-center border-b border-border bg-background",
				className,
			)}
		>
			{/* Left scroll button */}
			{canScrollLeft && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0"
							onClick={() => scrollTabs("left")}
							aria-label="Défiler vers la gauche"
						>
							<ChevronLeft className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Défiler vers la gauche</p>
					</TooltipContent>
				</Tooltip>
			)}

			{/* Scrollable tab container */}
			<div
				ref={scrollContainerRef}
				className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
				style={{ scrollBehavior: "smooth" }}
			>
				{projects.map((project, index) => {
					const isActiveTab = activeProjectId === project.id;
					return (
						<SortableProjectTab
							key={project.id}
							project={project}
							isActive={isActiveTab}
							canClose={true}
							tabIndex={index}
							onSelect={() => onProjectSelect(project.id)}
							onClose={(e) => {
								e.stopPropagation();
								onProjectClose(project.id);
							}}
							onRename={onProjectRename}
							isMissing={missingPaths.has(project.id)}
							onRepath={handleRepathProject}
							// Pass control props only for the active tab
							onSettingsClick={isActiveTab ? onSettingsClick : undefined}
						/>
					);
				})}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0"
							onClick={onAddProject}
							aria-label={t("projectTab.addProjectAriaLabel")}
						>
							<Plus className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("projectTab.addProjectTooltip")}</p>
					</TooltipContent>
				</Tooltip>
			</div>

			{/* Right scroll button */}
			{canScrollRight && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0"
							onClick={() => scrollTabs("right")}
							aria-label="Défiler vers la droite"
						>
							<ChevronRight className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Défiler vers la droite</p>
					</TooltipContent>
				</Tooltip>
			)}

			<div className="flex items-center gap-2 px-4 py-1 shrink-0">
				<AuthStatusIndicator />
				<UsageIndicator />
				{/* Usage Warning Badge (shown when usage >= 90%) */}
				{usage &&
					!isLoadingUsage &&
					(usage.sessionPercent >= 90 || (usage.weeklyPercent >= 0 && usage.weeklyPercent >= 90)) && (
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-red-500/10 text-red-500 border-red-500/20">
									<AlertTriangle className="h-3.5 w-3.5 motion-safe:animate-pulse" />
								</div>
							</TooltipTrigger>
							<TooltipContent side="bottom" className="text-xs max-w-xs">
								<div className="space-y-1">
									<div className="flex items-center justify-between gap-4">
										<span className="text-muted-foreground font-medium">
											{t("common:usage.usageAlert")}
										</span>
										<span className="font-semibold text-red-500">
											{Math.round(
												Math.max(usage.sessionPercent, Math.max(usage.weeklyPercent, 0)),
											)}
											%
										</span>
									</div>
									<div className="h-px bg-border" />
									<div className="text-[10px] text-muted-foreground">
										{t("common:usage.accountExceedsThreshold")}
									</div>
								</div>
							</TooltipContent>
						</Tooltip>
					)}
			</div>
		</div>
	);
}
