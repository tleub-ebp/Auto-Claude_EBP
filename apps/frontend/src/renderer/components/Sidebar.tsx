// React

// Types
import type { GitStatus, Project } from "@shared/types";
// Drag and drop (dnd-kit)
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
// Icons
import {
	Accessibility,
	AlertTriangle,
	BarChart3,
	Bug,
	BookOpen,
	BookOpenCheck,
	Box,
	Brain,
	Building2,
	Calendar,
	Camera,
	CheckCircle,
	ChevronRight,
	Code,
	Coins,
	Database,
	Download,
	FileCode2,
	FileEdit,
	FileJson,
	FileText,
	Gauge,
	GitBranch,
	GitFork,
	GitMerge,
	GitPullRequest,
	Globe,
	HeartPulse,
	HelpCircle,
	History,
	Layers,
	LayoutGrid,
	Leaf,
	Lightbulb,
	Map as MapIcon,
	MessageSquare,
	Mic,
	Monitor,
	PanelLeft,
	PanelLeftClose,
	Plus,
	Puzzle,
	RefreshCcw,
	Rocket,
	RotateCcw,
	Search,
	Settings,
	Shield,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Star,
	Store,
	Swords,
	Target,
	Terminal,
	TestTube,
	Trophy,
	UserCheck,
	Users,
	Wand2,
	WandSparkles,
	WifiOff,
	Wrench,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// i18n
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui";
// Utils
import { cn } from "@/lib/utils";
import { openAppEmulatorDialog } from "@/stores/app-emulator-store";
import { openArenaDialog } from "@/stores/arena-store";
import { openCodePlaygroundDialog } from "@/stores/code-playground-store";
import { openConflictPredictorDialog } from "@/stores/conflict-predictor-store";
import { openContextAwareSnippetsDialog } from "@/stores/context-aware-snippets-store";
import { openDependencySentinelDialog } from "@/stores/dependency-sentinel-store";
import { openLearningLoopDialog } from "@/stores/learning-loop-store";
import { useNaturalLanguageGitStore } from "@/stores/natural-language-git-store";
import {
	clearProjectEnvConfig,
	loadProjectEnvConfig,
	useProjectEnvStore,
} from "@/stores/project-env-store";
// Stores
import { useProjectStore } from "@/stores/project-store";
import { openPromptOptimizerDialog } from "@/stores/prompt-optimizer-store";
import { saveSettings, useSettingsStore } from "@/stores/settings-store";
import { openTestGenerationDialog } from "@/stores/test-generation-store";
import { openVoiceControlDialog } from "@/stores/voice-control-store";
// Modals & Components
import { AddProjectModal } from "./AddProjectModal";
import { AzureDevOpsSetupModal } from "./AzureDevOpsSetupModal";
import { AppEmulatorDialog } from "./app-emulator/AppEmulatorDialog";
import { ArenaDialog } from "./arena/ArenaDialog";
import { ClaudeCodeStatusBadge } from "./ClaudeCodeStatusBadge";
import { CodexCliStatusBadge } from "./CodexCliStatusBadge";
import { CopilotCliStatusBadge } from "./CopilotCliStatusBadge";
import { CodePlaygroundDialog } from "./code-playground/CodePlaygroundDialog";
import { ConflictPredictorDialog } from "./conflict-predictor/ConflictPredictorDialog";
import { ContextAwareSnippetsDialog } from "./context-aware-snippets/ContextAwareSnippetsDialog";
import { DependencySentinelDialog } from "./dependency-sentinel/DependencySentinelDialog";
import { GitHubSetupModal } from "./GitHubSetupModal";
import { GitSetupModal } from "./GitSetupModal";
import { LearningLoopDialog } from "./learning-loop/LearningLoopDialog";
import { NaturalLanguageGitDialog } from "./natural-language-git/NaturalLanguageGitDialog";
import { PromptOptimizerDialog } from "./prompt-optimizer/PromptOptimizerDialog";
import { RateLimitIndicator } from "./RateLimitIndicator";
import { TestGenerationDialog } from "./test-generation/TestGenerationDialog";
import { UpdateBanner } from "./UpdateBanner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui";
// UI
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";
import {
	decodeSortableId,
	encodeSortableId,
	FavoritesDropZone,
	FavoritesDropZoneEmpty,
	SortableWrapper,
	type SortableKind,
} from "./sidebar/sortable-primitives";
import { useSidebarPrefs } from "./sidebar/use-sidebar-prefs";
import { VoiceControlDialog } from "./voice-control/VoiceControlDialog";

export type SidebarView =
	| "kanban"
	| "terminals"
	| "roadmap"
	| "context"
	| "ideation"
	| "github-issues"
	| "gitlab-issues"
	| "github-prs"
	| "gitlab-merge-requests"
	| "changelog"
	| "insights"
	| "worktrees"
	| "agent-tools"
	| "migration"
	| "visual-to-code"
	| "dashboard"
	| "analytics"
	| "code-review"
	| "refactoring"
	| "documentation"
	| "cost-estimator"
	| "session-history"
	| "voice-control"
	| "test-generation"
	| "prompt-optimizer"
	| "code-playground"
	| "dependency-sentinel"
	| "natural-language-git"
	| "conflict-predictor"
	| "context-aware-snippets"
	| "app-emulator"
	| "learning-loop"
	| "mcp-marketplace"
	| "mission-control"
	| "agent-replay"
	| "pixel-office"
	| "self-healing"
	| "browser-agent"
	| "pair-programming"
	| "pipeline-generator"
	| "plugin-marketplace"
	| "arena-mode"
	| "api-explorer"
	| "sandbox"
	| "regression-guardian"
	| "injection-guard"
	| "api-watcher"
	| "accessibility-agent"
	| "i18n-agent"
	| "onboarding-agent"
	| "onboarding-guide"
	| "flaky-tests"
	| "doc-drift"
	| "compliance"
	| "git-surgeon"
	| "release-coordinator"
	| "carbon-profiler"
	| "consensus-arbiter"
	| "notebook-agent"
	| "spec-refinement"
	| "agent-coach"
	| "bounty-board"
	| "tech-debt"
	| "agent-debugger"
	| "team-bot"
	| "blast-radius"
	| "guardrails"
	| "env-snapshot"
	| "offline-mode"
	| "phase35-hub";

interface SidebarProps {
	readonly onSettingsClick: () => void;
	readonly onNewTaskClick: () => void;
	readonly activeView?: SidebarView;
	readonly onViewChange?: (view: SidebarView, force?: boolean) => void;
}

interface NavItem {
	id: SidebarView;
	labelKey: string;
	icon: React.ElementType;
	shortcut?: string;
	subGroup?: string; // i18n key for visual sub-group header within a group
}

interface NavGroup {
	id: string;
	labelKey: string;
	icon: React.ElementType;
	items: NavItem[];
	defaultExpanded?: boolean;
}

// Navigation groups organized by user intent
const navGroups: NavGroup[] = [
	{
		id: "workspace",
		labelKey: "navigation:groups.workspace",
		icon: Target,
		items: [
			{
				id: "kanban",
				labelKey: "navigation:items.kanban",
				icon: LayoutGrid,
				shortcut: "WK",
			},
			{
				id: "dashboard",
				labelKey: "navigation:items.dashboard",
				icon: BarChart3,
				shortcut: "WD",
			},
			{
				id: "mission-control",
				labelKey: "navigation:items.missionControl",
				icon: Rocket,
				shortcut: "WM",
			},
			{
				id: "session-history",
				labelKey: "navigation:items.sessionHistory",
				icon: History,
				shortcut: "WS",
			},
			{
				id: "phase35-hub",
				labelKey: "navigation:items.phase35Hub",
				icon: Sparkles,
				shortcut: "WA",
			},
		],
		defaultExpanded: true,
	},
	{
		id: "agents",
		labelKey: "navigation:groups.agents",
		icon: Rocket,
		items: [
			{
				id: "terminals",
				labelKey: "navigation:items.terminals",
				icon: Terminal,
				shortcut: "TM",
			},
			{
				id: "pixel-office",
				labelKey: "navigation:items.pixelOffice",
				icon: Building2,
				shortcut: "PO",
			},
			{
				id: "agent-replay",
				labelKey: "navigation:items.agentReplay",
				icon: RotateCcw,
				shortcut: "AR",
			},
			{
				id: "agent-debugger",
				labelKey: "navigation:items.agentDebugger",
				icon: Bug,
				shortcut: "AG",
			},
			{
				id: "self-healing",
				labelKey: "navigation:items.selfHealing",
				icon: HeartPulse,
				shortcut: "SE",
			},
			{
				id: "arena-mode",
				labelKey: "navigation:items.arenaMode",
				icon: Swords,
				shortcut: "AM",
			},
			{
				id: "bounty-board",
				labelKey: "navigation:items.bountyBoard",
				icon: Trophy,
				shortcut: "BB",
			},
			{
				id: "consensus-arbiter",
				labelKey: "navigation:items.consensusArbiter",
				icon: Users,
				shortcut: "CA",
			},
			{
				id: "agent-coach",
				labelKey: "navigation:items.agentCoach",
				icon: UserCheck,
				shortcut: "AC",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "development",
		labelKey: "navigation:groups.development",
		icon: Code,
		items: [
			{
				id: "pair-programming",
				labelKey: "navigation:items.pairProgramming",
				icon: Users,
				shortcut: "PP",
			},
			{
				id: "code-review",
				labelKey: "navigation:items.codeReview",
				icon: FileCode2,
				shortcut: "CR",
			},
			{
				id: "refactoring",
				labelKey: "navigation:items.refactoring",
				icon: Wand2,
				shortcut: "RF",
			},
			{
				id: "test-generation",
				labelKey: "navigation:items.testGeneration",
				icon: TestTube,
				shortcut: "TG",
			},
			{
				id: "code-playground",
				labelKey: "navigation:items.codePlayground",
				icon: Zap,
				shortcut: "CP",
			},
			{
				id: "visual-to-code",
				labelKey: "navigation:items.visualToCode",
				icon: WandSparkles,
				shortcut: "VC",
			},
			{
				id: "documentation",
				labelKey: "navigation:items.documentation",
				icon: BookOpenCheck,
				shortcut: "DC",
			},
			{
				id: "onboarding-guide",
				labelKey: "navigation:items.onboardingGuide",
				icon: BookOpen,
				shortcut: "OG",
			},
			{
				id: "flaky-tests",
				labelKey: "navigation:items.flakyTests",
				icon: AlertTriangle,
				shortcut: "FT",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "explore",
		labelKey: "navigation:groups.explore",
		icon: Sparkles,
		items: [
			{
				id: "insights",
				labelKey: "navigation:items.insights",
				icon: Sparkles,
				shortcut: "IN",
			},
			{
				id: "context",
				labelKey: "navigation:items.context",
				icon: BookOpen,
				shortcut: "CT",
			},
			{
				id: "ideation",
				labelKey: "navigation:items.ideation",
				icon: Lightbulb,
				shortcut: "ID",
			},
			{
				id: "learning-loop",
				labelKey: "navigation:items.learningLoop",
				icon: Brain,
				shortcut: "LL",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "git-integrations",
		labelKey: "navigation:groups.gitIntegrations",
		icon: GitFork,
		items: [
			{
				id: "worktrees",
				labelKey: "navigation:items.worktrees",
				icon: GitBranch,
				shortcut: "WT",
			},
			{
				id: "natural-language-git",
				labelKey: "navigation:items.naturalLanguageGit",
				icon: GitBranch,
				shortcut: "NG",
			},
			{
				id: "conflict-predictor",
				labelKey: "navigation:items.conflictPredictor",
				icon: GitMerge,
				shortcut: "CF",
			},
			{
				id: "git-surgeon",
				labelKey: "navigation:items.gitSurgeon",
				icon: GitBranch,
				shortcut: "GU",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "planning",
		labelKey: "navigation:groups.planning",
		icon: BarChart3,
		items: [
			{
				id: "roadmap",
				labelKey: "navigation:items.roadmap",
				icon: MapIcon,
				shortcut: "RM",
			},
			{
				id: "analytics",
				labelKey: "navigation:items.analytics",
				icon: Database,
				shortcut: "AN",
			},
			{
				id: "cost-estimator",
				labelKey: "navigation:items.costEstimator",
				icon: Coins,
				shortcut: "CE",
			},
			{
				id: "changelog",
				labelKey: "navigation:items.changelog",
				icon: FileText,
				shortcut: "CL",
			},
			{
				id: "release-coordinator",
				labelKey: "navigation:items.releaseCoordinator",
				icon: Calendar,
				shortcut: "RC",
			},
			{
				id: "carbon-profiler",
				labelKey: "navigation:items.carbonProfiler",
				icon: Leaf,
				shortcut: "CB",
			},
			{
				id: "tech-debt",
				labelKey: "navigation:items.techDebt",
				icon: Gauge,
				shortcut: "TD",
			},
			{
				id: "env-snapshot",
				labelKey: "navigation:items.envSnapshot",
				icon: Camera,
				shortcut: "ES",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "toolbox",
		labelKey: "navigation:groups.toolbox",
		icon: Wrench,
		items: [
			// Extensions
			{
				id: "agent-tools",
				labelKey: "navigation:items.agentTools",
				icon: Wrench,
				shortcut: "AT",
				subGroup: "navigation:subGroups.extensions",
			},
			{
				id: "mcp-marketplace",
				labelKey: "navigation:items.mcpMarketplace",
				icon: Store,
				shortcut: "MK",
				subGroup: "navigation:subGroups.extensions",
			},
			{
				id: "plugin-marketplace",
				labelKey: "navigation:items.pluginMarketplace",
				icon: Puzzle,
				shortcut: "PM",
				subGroup: "navigation:subGroups.extensions",
			},
			// Code Quality & Testing
			{
				id: "regression-guardian",
				labelKey: "navigation:items.regressionGuardian",
				icon: ShieldAlert,
				shortcut: "RG",
				subGroup: "navigation:subGroups.codeQuality",
			},
			{
				id: "injection-guard",
				labelKey: "navigation:items.injectionGuard",
				icon: ShieldCheck,
				shortcut: "IG",
				subGroup: "navigation:subGroups.codeQuality",
			},
			{
				id: "compliance",
				labelKey: "navigation:items.compliance",
				icon: CheckCircle,
				shortcut: "CO",
				subGroup: "navigation:subGroups.codeQuality",
			},
			{
				id: "dependency-sentinel",
				labelKey: "navigation:items.dependencySentinel",
				icon: Shield,
				shortcut: "DS",
				subGroup: "navigation:subGroups.codeQuality",
			},
			{
				id: "blast-radius",
				labelKey: "navigation:items.blastRadius",
				icon: Target,
				shortcut: "BR",
				subGroup: "navigation:subGroups.codeQuality",
			},
			{
				id: "guardrails",
				labelKey: "navigation:items.guardrails",
				icon: Shield,
				shortcut: "GR",
				subGroup: "navigation:subGroups.codeQuality",
			},
			// Documentation & Spec
			{
				id: "onboarding-agent",
				labelKey: "navigation:items.onboardingAgent",
				icon: BookOpen,
				shortcut: "OA",
				subGroup: "navigation:subGroups.documentation",
			},
			{
				id: "doc-drift",
				labelKey: "navigation:items.docDrift",
				icon: FileText,
				shortcut: "DD",
				subGroup: "navigation:subGroups.documentation",
			},
			{
				id: "spec-refinement",
				labelKey: "navigation:items.specRefinement",
				icon: FileEdit,
				shortcut: "SR",
				subGroup: "navigation:subGroups.documentation",
			},
			// Accessibility & i18n
			{
				id: "accessibility-agent",
				labelKey: "navigation:items.accessibilityAgent",
				icon: Accessibility,
				shortcut: "AY",
				subGroup: "navigation:subGroups.accessibility",
			},
			{
				id: "i18n-agent",
				labelKey: "navigation:items.i18nAgent",
				icon: Globe,
				shortcut: "II",
				subGroup: "navigation:subGroups.accessibility",
			},
			// API & Data
			{
				id: "api-explorer",
				labelKey: "navigation:items.apiExplorer",
				icon: Globe,
				shortcut: "AE",
				subGroup: "navigation:subGroups.api",
			},
			{
				id: "api-watcher",
				labelKey: "navigation:items.apiWatcher",
				icon: FileJson,
				shortcut: "AW",
				subGroup: "navigation:subGroups.api",
			},
			{
				id: "sandbox",
				labelKey: "navigation:items.sandbox",
				icon: Box,
				shortcut: "SB",
				subGroup: "navigation:subGroups.api",
			},
			{
				id: "notebook-agent",
				labelKey: "navigation:items.notebookAgent",
				icon: FileCode2,
				shortcut: "NB",
				subGroup: "navigation:subGroups.api",
			},
			// Automation
			{
				id: "app-emulator",
				labelKey: "navigation:items.appEmulator",
				icon: Monitor,
				shortcut: "AP",
				subGroup: "navigation:subGroups.automation",
			},
			{
				id: "browser-agent",
				labelKey: "navigation:items.browserAgent",
				icon: Globe,
				shortcut: "BW",
				subGroup: "navigation:subGroups.automation",
			},
			{
				id: "pipeline-generator",
				labelKey: "navigation:items.pipelineGenerator",
				icon: Layers,
				shortcut: "PG",
				subGroup: "navigation:subGroups.automation",
			},
			{
				id: "team-bot",
				labelKey: "navigation:items.teamBot",
				icon: MessageSquare,
				shortcut: "TT",
				subGroup: "navigation:subGroups.automation",
			},
			// Utilities
			{
				id: "voice-control",
				labelKey: "navigation:items.voiceControl",
				icon: Mic,
				shortcut: "VO",
				subGroup: "navigation:subGroups.utilities",
			},
			{
				id: "migration",
				labelKey: "navigation:items.migration",
				icon: Download,
				shortcut: "MG",
				subGroup: "navigation:subGroups.utilities",
			},
			{
				id: "prompt-optimizer",
				labelKey: "navigation:items.promptOptimizer",
				icon: WandSparkles,
				shortcut: "PT",
				subGroup: "navigation:subGroups.utilities",
			},
			{
				id: "context-aware-snippets",
				labelKey: "navigation:items.contextAwareSnippets",
				icon: Code,
				shortcut: "CS",
				subGroup: "navigation:subGroups.utilities",
			},
			{
				id: "offline-mode",
				labelKey: "navigation:items.offlineMode",
				icon: WifiOff,
				shortcut: "OF",
				subGroup: "navigation:subGroups.utilities",
			},
		],
		defaultExpanded: false,
	},
];

// GitHub nav items shown when GitHub is enabled
const githubNavItems: NavItem[] = [
	{
		id: "github-issues",
		labelKey: "navigation:items.githubIssues",
		icon: Globe,
		shortcut: "GI",
	},
	{
		id: "github-prs",
		labelKey: "navigation:items.githubPRs",
		icon: GitPullRequest,
		shortcut: "GP",
	},
];

// GitLab nav items shown when GitLab is enabled
const gitlabNavItems: NavItem[] = [
	{
		id: "gitlab-issues",
		labelKey: "navigation:items.gitlabIssues",
		icon: Globe,
		shortcut: "LI",
	},
	{
		id: "gitlab-merge-requests",
		labelKey: "navigation:items.gitlabMRs",
		icon: GitMerge,
		shortcut: "LM",
	},
];

export function Sidebar({
	onSettingsClick,
	onNewTaskClick,
	activeView = "kanban",
	onViewChange,
}: SidebarProps) {
	const { t } = useTranslation(["navigation", "dialogs", "common"]);
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const settings = useSettingsStore((state) => state.settings);

	const [showAddProjectModal, setShowAddProjectModal] = useState(false);
	const [showGitSetupModal, setShowGitSetupModal] = useState(false);
	const gitSetupSkippedForProjectRef = useRef<string | null>(null);
	const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
	const [_pendingProject, setPendingProject] = useState<Project | null>(null);
	const {
		prefs: sidebarPrefs,
		toggleItemPin,
		toggleGroupPin,
		reorderGroups,
		reorderItems,
		toggleGroupExpanded,
		setFavoritesExpanded,
		clearAllFavorites,
		reset: resetSidebarPrefs,
		mergeOrder,
	} = useSidebarPrefs();
	const expandedGroups = useMemo(
		() => new Set(sidebarPrefs.expandedGroups),
		[sidebarPrefs.expandedGroups],
	);
	const pinnedItemsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedItems),
		[sidebarPrefs.pinnedItems],
	);
	const pinnedGroupsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedGroups),
		[sidebarPrefs.pinnedGroups],
	);
	const [activeDragId, setActiveDragId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const shortcutBufferRef = useRef<string>("");
	const shortcutBufferTimeRef = useRef<number>(0);

	const [showGitHubSetup, setShowGitHubSetup] = useState(false);
	const [gitHubSetupProject, setGitHubSetupProject] = useState<Project | null>(
		null,
	);
	const [showAzureDevOpsSetup, setShowAzureDevOpsSetup] = useState(false);
	const [azureDevOpsSetupProject, setAzureDevOpsSetupProject] =
		useState<Project | null>(null);

	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Sidebar collapsed state from settings
	const isCollapsed = settings.sidebarCollapsed ?? false;

	// Sidebar resizable width
	const SIDEBAR_MIN_WIDTH = 200;
	const SIDEBAR_MAX_WIDTH = 480;
	const SIDEBAR_DEFAULT_WIDTH = 256;
	const SIDEBAR_COLLAPSED_WIDTH = 64;

	const sidebarWidth = settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
	const [isResizing, setIsResizing] = useState(false);
	const [resizeWidth, setResizeWidth] = useState(sidebarWidth);
	const resizingRef = useRef(false);

	// Sync resizeWidth when settings change externally
	useEffect(() => {
		if (!resizingRef.current) {
			setResizeWidth(settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH);
		}
	}, [settings.sidebarWidth]);

	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			resizingRef.current = true;
			setIsResizing(true);
			const startX = e.clientX;
			const startWidth = resizeWidth;

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const newWidth = Math.min(
					SIDEBAR_MAX_WIDTH,
					Math.max(
						SIDEBAR_MIN_WIDTH,
						startWidth + (moveEvent.clientX - startX),
					),
				);
				setResizeWidth(newWidth);
			};

			const handleMouseUp = () => {
				resizingRef.current = false;
				setIsResizing(false);
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
				// Persist final width
				setResizeWidth((prev) => {
					saveSettings({ sidebarWidth: prev });
					return prev;
				});
			};

			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[resizeWidth],
	);

	const toggleSidebar = () => {
		saveSettings({ sidebarCollapsed: !isCollapsed });
	};

	// CLI panel expanded state persisted in settings (default: true)
	const isCliPanelExpanded = settings.cliPanelExpanded ?? true;
	const setIsCliPanelExpanded = (value: boolean) =>
		saveSettings({ cliPanelExpanded: value });

	// Subscribe to project-env-store for reactive GitHub/GitLab tab visibility
	const githubEnabled = useProjectEnvStore(
		(state) => state.envConfig?.githubEnabled ?? false,
	);
	const gitlabEnabled = useProjectEnvStore(
		(state) => state.envConfig?.gitlabEnabled ?? false,
	);

	// Track the last loaded project ID to avoid redundant loads
	const lastLoadedProjectIdRef = useRef<string | null>(null);

	// Compute visible nav groups based on GitHub/GitLab enabled state from store,
	// then apply the user's custom group + per-group item ordering from sidebarPrefs.
	// Order merging is permissive: unknown ids in prefs are dropped, new ids fall
	// through to their default code position — so shipping new menu items doesn't
	// require a settings migration.
	const visibleNavGroups = useMemo(() => {
		const groups = navGroups.map((g) => ({ ...g, items: [...g.items] }));

		const integrationGroup = groups.find((g) => g.id === "git-integrations");
		if (integrationGroup) {
			if (githubEnabled) {
				integrationGroup.items.push(...githubNavItems);
			}
			if (gitlabEnabled) {
				integrationGroup.items.push(...gitlabNavItems);
			}
		}

		// Apply custom group order
		const actualGroupIds = groups.map((g) => g.id);
		const orderedGroupIds = mergeOrder(sidebarPrefs.groupOrder, actualGroupIds);
		const byId = new Map(groups.map((g) => [g.id, g]));
		const orderedGroups = orderedGroupIds
			.map((id) => byId.get(id))
			.filter((g): g is NavGroup => Boolean(g));

		// Apply custom per-group item order
		return orderedGroups.map((group) => {
			const actualItemIds = group.items.map((i) => i.id);
			const preferredOrder = sidebarPrefs.itemOrder[group.id] ?? [];
			const orderedItemIds = mergeOrder(preferredOrder, actualItemIds);
			const itemById = new Map(group.items.map((i) => [i.id, i]));
			const items = orderedItemIds
				.map((id) => itemById.get(id as SidebarView))
				.filter((i): i is NavItem => Boolean(i));
			return { ...group, items };
		});
	}, [
		githubEnabled,
		gitlabEnabled,
		sidebarPrefs.groupOrder,
		sidebarPrefs.itemOrder,
		mergeOrder,
	]);

	// Build the synthetic "Favorites" group from pinned items and pinned groups.
	// Pinned groups contribute all their items; pinned standalone items are added
	// in their pin order. Dedup preserves pin order so "first pinned, first shown".
	const favoritesGroup = useMemo<NavGroup | null>(() => {
		const allItems = visibleNavGroups.flatMap((g) => g.items);
		const itemById = new Map(allItems.map((i) => [i.id, i]));

		const collected: NavItem[] = [];
		const seen = new Set<string>();

		for (const groupId of sidebarPrefs.pinnedGroups) {
			const group = visibleNavGroups.find((g) => g.id === groupId);
			if (!group) continue;
			for (const item of group.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				collected.push(item);
			}
		}
		for (const itemId of sidebarPrefs.pinnedItems) {
			if (seen.has(itemId)) continue;
			const item = itemById.get(itemId as SidebarView);
			if (!item) continue;
			seen.add(item.id);
			collected.push(item);
		}

		if (collected.length === 0) return null;

		return {
			id: "__favorites__",
			labelKey: "navigation:groups.favorites",
			icon: Star,
			items: collected,
			defaultExpanded: true,
		};
	}, [
		visibleNavGroups,
		sidebarPrefs.pinnedGroups,
		sidebarPrefs.pinnedItems,
	]);

	// Get all visible items for keyboard shortcuts
	const visibleNavItems = useMemo(() => {
		return visibleNavGroups.flatMap((group) => group.items);
	}, [visibleNavGroups]);

	// Filter nav groups based on search query
	const filteredNavGroups = useMemo(() => {
		if (!searchQuery.trim()) return visibleNavGroups;
		const query = searchQuery.toLowerCase().trim();
		return visibleNavGroups
			.map((group) => ({
				...group,
				items: group.items.filter((item) =>
					t(item.labelKey).toLowerCase().includes(query),
				),
			}))
			.filter((group) => group.items.length > 0);
	}, [visibleNavGroups, searchQuery, t]);

	// Load envConfig when project changes to ensure store is populated
	useEffect(() => {
		// Track whether this effect is still current (for race condition handling)
		let isCurrent = true;

		const initializeEnvConfig = async () => {
			if (selectedProject?.id && selectedProject?.autoBuildPath) {
				// Only reload if the project ID differs from what we last loaded
				if (selectedProject.id !== lastLoadedProjectIdRef.current) {
					lastLoadedProjectIdRef.current = selectedProject.id;
					await loadProjectEnvConfig(selectedProject.id);
					// Check if this effect was cancelled while loading
					if (!isCurrent) return;
				}
			} else {
				// Clear the store if no project is selected or has no autoBuildPath
				lastLoadedProjectIdRef.current = null;
				clearProjectEnvConfig();
			}
		};
		initializeEnvConfig();

		// Cleanup function to mark this effect as stale
		return () => {
			isCurrent = false;
		};
	}, [selectedProject?.id, selectedProject?.autoBuildPath]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't trigger shortcuts when typing in inputs
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement ||
				e.target instanceof HTMLSelectElement ||
				(e.target as HTMLElement)?.isContentEditable
			) {
				return;
			}

			// Only handle shortcuts when a project is selected
			if (!selectedProjectId) return;

			// Check for modifier keys - we want plain key presses only
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			// "/" opens and focuses the search input when sidebar is expanded
			if (e.key === "/" && !isCollapsed) {
				e.preventDefault();
				setIsSearchOpen(true);
				requestAnimationFrame(() => searchInputRef.current?.focus());
				return;
			}

			// Ignore non-letter keys for 2-char shortcuts
			if (!/^[A-Za-z]$/.test(e.key)) return;

			const key = e.key.toUpperCase();
			const now = Date.now();
			const SHORTCUT_WINDOW_MS = 1000;

			const prefix = shortcutBufferRef.current;
			const prefixAge = now - shortcutBufferTimeRef.current;

			// If a recent prefix exists, try to match the full 2-char combo
			if (prefix && prefixAge <= SHORTCUT_WINDOW_MS) {
				const combo = prefix + key;
				const matched = visibleNavItems.find((item) => item.shortcut === combo);
				shortcutBufferRef.current = "";
				shortcutBufferTimeRef.current = 0;
				if (matched) {
					e.preventDefault();
					onViewChange?.(matched.id);
					return;
				}
				// Fall through to treat current key as a new prefix
			}

			// Check if this letter is a known prefix (first letter of any shortcut)
			const isPrefix = visibleNavItems.some(
				(item) => item.shortcut?.length === 2 && item.shortcut.startsWith(key),
			);
			if (isPrefix) {
				e.preventDefault();
				shortcutBufferRef.current = key;
				shortcutBufferTimeRef.current = now;
				return;
			}

			// Legacy single-char shortcut support (none remain, but kept defensively)
			const matchedItem = visibleNavItems.find((item) => item.shortcut === key);
			if (matchedItem) {
				e.preventDefault();
				onViewChange?.(matchedItem.id);
			}
		};

		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [selectedProjectId, onViewChange, visibleNavItems, isCollapsed]);

	// Check git status when a project changes
	useEffect(() => {
		// Reset the skip flag when the project changes so the modal shows for new projects
		gitSetupSkippedForProjectRef.current = null;

		const checkGit = async () => {
			if (selectedProject) {
				try {
					const result = await globalThis.electronAPI.checkGitStatus(
						selectedProject.path,
					);
					if (result.success && result.data) {
						setGitStatus(result.data);
						// Show git setup modal if a project is not a git repo or has no commits,
						// but only if the user hasn't explicitly dismissed it for this project yet
						if (
							(!result.data.isGitRepo || !result.data.hasCommits) &&
							gitSetupSkippedForProjectRef.current !== selectedProject.id
						) {
							setShowGitSetupModal(true);
						}
					}
				} catch (error) {
					console.error("Failed to check git status:", error);
				}
			} else {
				setGitStatus(null);
			}
		};
		checkGit();
	}, [selectedProject]);

	const inferProviderFromRemote = (
		provider: "github" | "azure_devops" | "unknown",
		remoteUrl?: string,
	) => {
		if (provider !== "unknown" || !remoteUrl) return provider;
		if (/github\.com[:/]/i.test(remoteUrl)) return "github";
		if (
			/dev\.azure\.com|visualstudio\.com|ssh\.dev\.azure\.com/i.test(remoteUrl)
		)
			return "azure_devops";
		return "unknown";
	};

	const handleProjectAdded = async (project: Project, needsInit: boolean) => {
		if (needsInit) {
			setPendingProject(project);
			return;
		}

		try {
			const envResult = await globalThis.electronAPI.getProjectEnv(project.id);
			const envConfig = envResult.success ? envResult.data : null;
			const hasProvider = !!(
				envConfig?.githubEnabled || envConfig?.azureDevOpsEnabled
			);
			if (!hasProvider) {
				const detectionResult = await globalThis.electronAPI.detectRepoProvider(
					project.path,
				);
				const rawProvider = detectionResult.success
					? (detectionResult.data?.provider ?? "unknown")
					: "unknown";
				const provider = inferProviderFromRemote(
					rawProvider,
					detectionResult.data?.remoteUrl,
				);

				setShowGitHubSetup(false);
				setGitHubSetupProject(null);
				setShowAzureDevOpsSetup(false);
				setAzureDevOpsSetupProject(null);

				if (provider === "github") {
					setGitHubSetupProject(project);
					setShowGitHubSetup(true);
					return;
				}

				if (provider === "azure_devops") {
					setAzureDevOpsSetupProject(project);
					setShowAzureDevOpsSetup(true);
					return;
				}
			}
		} catch {
			setShowGitHubSetup(false);
			setGitHubSetupProject(null);
			setShowAzureDevOpsSetup(false);
			setAzureDevOpsSetupProject(null);
		}
	};

	const handleGitInitialized = async () => {
		// Refresh git status after initialization
		if (selectedProject) {
			try {
				const result = await globalThis.electronAPI.checkGitStatus(
					selectedProject.path,
				);
				if (result.success && result.data) {
					setGitStatus(result.data);
				}
			} catch (error) {
				console.error("Failed to refresh git status:", error);
			}
		}
	};

	const handleGitHubSetupComplete = async (settings: {
		githubToken: string;
		githubRepo: string;
		mainBranch: string;
		githubAuthMethod?: "oauth" | "pat";
	}) => {
		if (!gitHubSetupProject) return;

		try {
			await globalThis.electronAPI.updateProjectEnv(gitHubSetupProject.id, {
				githubEnabled: true,
				githubToken: settings.githubToken,
				githubRepo: settings.githubRepo,
				githubAuthMethod: settings.githubAuthMethod,
				azureDevOpsEnabled: false,
			});

			await globalThis.electronAPI.updateProjectSettings(
				gitHubSetupProject.id,
				{
					mainBranch: settings.mainBranch,
				},
			);
		} catch (error) {
			console.error("Failed to save GitHub settings:", error);
		}

		setShowGitHubSetup(false);
		setGitHubSetupProject(null);
	};

	const handleGitHubSetupSkip = () => {
		setShowGitHubSetup(false);
		setGitHubSetupProject(null);
	};

	const handleAzureDevOpsSetupComplete = async () => {
		setShowAzureDevOpsSetup(false);
		setAzureDevOpsSetupProject(null);
	};

	const handleAzureDevOpsSetupSkip = () => {
		setShowAzureDevOpsSetup(false);
		setAzureDevOpsSetupProject(null);
	};

	const handleNavClick = (view: SidebarView) => {
		// Clear search when navigating
		setSearchQuery("");
		setIsSearchOpen(false);

		// Handle AI Tools that open dialogs instead of changing view
		if (view === "test-generation") {
			openTestGenerationDialog();
			return;
		}
		if (view === "prompt-optimizer") {
			openPromptOptimizerDialog();
			return;
		}
		if (view === "context-aware-snippets") {
			openContextAwareSnippetsDialog();
			return;
		}
		if (view === "code-playground") {
			openCodePlaygroundDialog();
			return;
		}
		if (view === "conflict-predictor") {
			openConflictPredictorDialog();
			return;
		}
		if (view === "dependency-sentinel") {
			openDependencySentinelDialog();
			return;
		}
		if (view === "natural-language-git") {
			useNaturalLanguageGitStore.getState().openDialog();
			return;
		}
		if (view === "voice-control") {
			openVoiceControlDialog();
			return;
		}
		if (view === "app-emulator") {
			openAppEmulatorDialog();
			return;
		}
		if (view === "learning-loop") {
			openLearningLoopDialog();
			return;
		}
		if (view === "arena-mode") {
			openArenaDialog();
			return;
		}

		// Handle regular view changes
		onViewChange?.(view);
	};

	const toggleGroupExpansion = (groupId: string) => {
		toggleGroupExpanded(groupId);
	};

	// Require 6px of pointer movement before starting a drag so regular clicks on
	// menu items (the most common interaction by far) never get swallowed by dnd-kit.
	const dndSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	interface SortableInfo {
		kind: SortableKind;
		id: string;
	}

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);

	// Helper function to handle dropping on favorites
	const handleFavoritesDrop = useCallback((activeInfo: SortableInfo, _overInfo: SortableInfo) => {
		if (activeInfo.kind === "item" && !pinnedItemsSet.has(activeInfo.id)) {
			toggleItemPin(activeInfo.id);
			return true;
		}
		if (activeInfo.kind === "group" && !pinnedGroupsSet.has(activeInfo.id)) {
			toggleGroupPin(activeInfo.id);
			return true;
		}
		return false;
	}, [pinnedItemsSet, pinnedGroupsSet, toggleItemPin, toggleGroupPin]);

	// Helper function to handle group reordering
	const handleGroupReorder = useCallback((activeInfo: SortableInfo, overInfo: SortableInfo) => {
		if (activeInfo.id === overInfo.id) return true;
		const actualOrder = visibleNavGroups.map((g) => g.id);
		reorderGroups(activeInfo.id, overInfo.id, actualOrder);
		return true;
	}, [visibleNavGroups, reorderGroups]);

	// Helper function to handle item reordering within groups
	const handleItemReorder = useCallback((activeInfo: SortableInfo, overInfo: SortableInfo) => {
		if (activeInfo.id === overInfo.id) return true;
		const group = visibleNavGroups.find(
			(g) =>
				g.items.some((i) => i.id === activeInfo.id) &&
				g.items.some((i) => i.id === overInfo.id),
		);
		if (!group) return false;
		const actualOrder = group.items.map((i) => i.id);
		reorderItems(group.id, activeInfo.id, overInfo.id, actualOrder);
		return true;
	}, [visibleNavGroups, reorderItems]);

	// Drag-end router. A drop's effect depends on the decoded "kind" of both
	// active and over ids — group-onto-group reorders, item-onto-item reorders
	// within the same group (cross-group drops are ignored to keep the mental
	// model simple), and dropping an item onto the favorites zone pins it.
	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveDragId(null);
			const { active, over } = event;
			if (!over) return;

			const activeInfo = decodeSortableId(String(active.id));
			const overInfo = decodeSortableId(String(over.id));
			if (!activeInfo || !overInfo) return;

			// Dropped on the favorites drop zone -> pin the item/group
			if (overInfo.kind === "fav-group" || over.id === "__fav_drop__") {
				handleFavoritesDrop(activeInfo, overInfo);
				return;
			}

			// Reorder groups (same kind, both "group")
			if (activeInfo.kind === "group" && overInfo.kind === "group") {
				handleGroupReorder(activeInfo, overInfo);
				return;
			}

			// Reorder items within the same group
			if (activeInfo.kind === "item" && overInfo.kind === "item") {
				handleItemReorder(activeInfo, overInfo);
			}
		},
		[
			handleFavoritesDrop,
			handleGroupReorder,
			handleItemReorder,
		],
	);

	const renderNavItem = (
		item: NavItem,
		isSubItem = false,
		context: "default" | "favorites" = "default",
	) => {
		const isActive = activeView === item.id;
		const Icon = item.icon;
		const isPinned = pinnedItemsSet.has(item.id);

		// Determine CSS classes based on collapsed state and sub-item status
		const getLayoutClasses = () => {
			if (isCollapsed) {
				return "justify-center px-2 py-2";
			}
			if (isSubItem) {
				return "gap-3 px-3 py-1.5 ml-6";
			}
			return "gap-3 px-3 py-2";
		};

		// Pin star lives OUTSIDE the nav button (nested <button> is invalid HTML).
		// It is an absolute overlay so the nav button keeps the full row width;
		// it only appears on hover/focus, fading the kbd shortcut underneath.
		// right-2 (8px) + the 7px inset of the items box = 15px from the sidebar
		// inner edge — must match the group pin star (right-[15px]) so all stars align.
		const starButton = !isCollapsed && context !== "favorites" ? (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					toggleItemPin(item.id);
				}}
				aria-label={
					isPinned
						? t("navigation:actions.unpin")
						: t("navigation:actions.pin")
				}
				aria-pressed={isPinned}
				className={cn(
					"absolute right-2 top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"hover:bg-accent/60 hover:scale-110",
					"opacity-0 group-hover/nav-item:opacity-100 focus-visible:opacity-100",
					isPinned
						? "text-amber-400"
						: "text-muted-foreground/40 hover:text-amber-400",
				)}
			>
				<Star
					className={cn("h-3.5 w-3.5", isPinned && "fill-amber-400")}
				/>
			</button>
		) : null;

		const button = (
			<div
				key={item.id}
				className="group/nav-item relative flex items-center"
			>
				<button
					type="button"
					onClick={() => handleNavClick(item.id)}
					disabled={!selectedProjectId}
					aria-keyshortcuts={item.shortcut}
					className={cn(
						"flex w-full min-w-0 items-center rounded-lg text-sm transition-all duration-200",
						"hover:bg-accent hover:text-accent-foreground",
						"disabled:pointer-events-none disabled:opacity-50",
						isActive && "bg-accent text-accent-foreground",
						isPinned &&
							!isActive &&
							context !== "favorites" &&
							"ring-1 ring-inset ring-amber-400/20 shadow-[inset_0_0_12px_-6px_rgba(251,191,36,0.25)]",
						getLayoutClasses(),
					)}
				>
					<Icon className="h-4 w-4 shrink-0" />
					{!isCollapsed && (
						<>
							<span className="flex-1 text-left truncate">
								{t(item.labelKey)}
							</span>
							{item.shortcut && (
								<kbd
									className={cn(
										"pointer-events-none hidden h-5 select-none items-center gap-1 rounded-md border border-border bg-secondary px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:flex",
										"transition-opacity duration-200",
										context !== "favorites" &&
											"group-hover/nav-item:opacity-0",
									)}
								>
									{item.shortcut}
								</kbd>
							)}
						</>
					)}
				</button>
				{starButton}
			</div>
		);

		// Wrap in tooltip when collapsed
		if (isCollapsed) {
			return (
				<Tooltip key={item.id}>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent side="right">
						<span>{t(item.labelKey)}</span>
						{item.shortcut && (
							<kbd className="ml-2 rounded border border-border bg-secondary px-1 font-mono text-[10px]">
								{item.shortcut}
							</kbd>
						)}
					</TooltipContent>
				</Tooltip>
			);
		}

		return button;
	};

	const groupItemsBySubGroup = (items: NavItem[]) => {
		const subGroups: { key: string; items: NavItem[] }[] = [];
		for (const item of items) {
			const key = item.subGroup ?? "";
			const last = subGroups.at(-1);
			if (last?.key === key) {
				last.items.push(item);
			} else {
				subGroups.push({ key, items: [item] });
			}
		}
		return subGroups;
	};

	const renderTooltipSubGroupItem = (item: NavItem) => {
		const isActive = activeView === item.id;
		return (
			<button
				key={item.id}
				type="button"
				onClick={() => handleNavClick(item.id)}
				disabled={!selectedProjectId}
				aria-keyshortcuts={item.shortcut}
				className={cn(
					"w-full flex items-center gap-2 text-xs p-1 rounded text-left",
					"hover:bg-accent hover:text-accent-foreground",
					"disabled:pointer-events-none disabled:opacity-50",
					isActive && "bg-accent text-accent-foreground",
				)}
			>
				<item.icon className="h-3 w-3 shrink-0" />
				<span className="flex-1 truncate">{t(item.labelKey)}</span>
				{item.shortcut && (
					<kbd className="rounded border border-border bg-secondary px-1 font-mono text-[9px]">
						{item.shortcut}
					</kbd>
				)}
			</button>
		);
	};

	const renderTooltipItems = (items: NavItem[]) => {
		const hasSubGroups = items.some((item) => item.subGroup);

		if (!hasSubGroups) {
			return items.map(renderTooltipSubGroupItem);
		}

		const subGroups = groupItemsBySubGroup(items);
		return subGroups.map((sg, sgIndex) => (
			<div
				key={sg.key}
				className={cn(
					"rounded bg-white/4 border border-white/8 px-1 py-1",
					sgIndex > 0 && "mt-1",
				)}
			>
				{sg.key && (
					<div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pb-0.5">
						{t(sg.key)}
					</div>
				)}
				{sg.items.map(renderTooltipSubGroupItem)}
			</div>
		));
	};

	const renderExpandedSubGroupItem = (
		item: NavItem,
		delay: number,
		context: "default" | "favorites" = "default",
	) => {
		// Items inside the favorites group are mirrors of the originals — they are
		// not independently sortable, so we skip the SortableWrapper there. This
		// keeps dnd-kit ids unique (only "item:<id>" exists, not "fav-item:<id>").
		if (context === "favorites") {
			return (
				<div
					key={item.id}
					className="animate-in slide-in-from-left-2 duration-200 ease-out"
					style={{ animationDelay: `${delay}ms` }}
				>
					{renderNavItem(item, true, context)}
				</div>
			);
		}
		return (
			<SortableWrapper
				key={item.id}
				sortableId={encodeSortableId("item", item.id)}
			>
				{({ setNodeRef, style, isDragging, dragHandle }) => (
					<div
						ref={setNodeRef}
						style={{ ...style, animationDelay: `${delay}ms` }}
						className={cn(
							"relative group animate-in slide-in-from-left-2 duration-200 ease-out",
							isDragging &&
								"ring-1 ring-primary/50 rounded-lg bg-background/80 backdrop-blur",
						)}
					>
						<div className="absolute left-3 top-1/2 -translate-y-1/2 z-10">
							{dragHandle}
						</div>
						{renderNavItem(item, true, context)}
					</div>
				)}
			</SortableWrapper>
		);
	};

	// Helper function to render sub-group items with proper indexing
	const renderSubGroupItems = (items: NavItem[], context: "default" | "favorites") => {
		let itemIndex = 0;
		return items.map((item) => {
			const delay = itemIndex * 50;
			itemIndex++;
			return renderExpandedSubGroupItem(item, delay, context);
		});
	};

	// Helper function to render sub-groups
	const renderSubGroups = (items: NavItem[], context: "default" | "favorites") => {
		const subGroups = groupItemsBySubGroup(items);
		return subGroups.map((sg, sgIndex) => (
			<div
				key={sg.key}
				className={cn(
					"rounded-lg overflow-hidden bg-white/4 border border-white/8 px-1.5 py-1.5",
					sgIndex > 0 && "mt-2",
				)}
			>
				{sg.key && (
					<div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
						{t(sg.key)}
					</div>
				)}
				<div className="space-y-0.5">
					{renderSubGroupItems(sg.items, context)}
				</div>
			</div>
		));
	};

	const renderExpandedItems = (
		items: NavItem[],
		context: "default" | "favorites" = "default",
	) => {
		const hasSubGroups = items.some((item) => item.subGroup);
		const sortableIds = items.map((i) => encodeSortableId("item", i.id));

		const content = hasSubGroups ? (
			renderSubGroups(items, context)
		) : (
			<div className="rounded-lg overflow-hidden bg-white/4 border border-white/8 px-1.5 py-1.5 space-y-0.5">
				{items.map((item, index) =>
					renderExpandedSubGroupItem(item, index * 50, context),
				)}
			</div>
		);

		if (context === "favorites") return content;
		return (
			<SortableContext
				items={sortableIds}
				strategy={verticalListSortingStrategy}
			>
				{content}
			</SortableContext>
		);
	};

	// Helper function to determine if a group is expanded
	const getGroupExpandedState = (group: NavGroup, isFavorites: boolean): boolean => {
		if (searchQuery.trim()) {
			return true;
		}
		if (isFavorites) {
			return sidebarPrefs.favoritesExpanded;
		}
		return expandedGroups.has(group.id);
	};

	// Helper function to get icon container className
	const getIconContainerClassName = (isFavorites: boolean, hasActiveItem: boolean): string => {
		if (isFavorites) {
			return "bg-amber-400/10 text-amber-400";
		}
		if (hasActiveItem) {
			return "bg-primary/10 text-primary";
		}
		return "text-muted-foreground";
	};

	// Helper function to render collapsed group
	const renderCollapsedGroup = (group: NavGroup, hasActiveItem: boolean) => {
		const GroupIcon = group.icon;
		const isFavorites = group.id === "__favorites__";
		
		return (
			<Tooltip key={group.id}>
				<TooltipTrigger asChild>
					<div className="flex flex-col items-center gap-1 py-2">
						<div
							className={cn(
								"flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 hover:scale-105",
								hasActiveItem
									? "bg-accent text-accent-foreground shadow-sm"
									: "hover:bg-accent hover:text-accent-foreground",
								isFavorites && "ring-1 ring-amber-400/40",
							)}
						>
							<GroupIcon
								className={cn(
									"h-4 w-4",
									isFavorites && "fill-amber-400 text-amber-400",
								)}
							/>
						</div>
					</div>
				</TooltipTrigger>
				<TooltipContent side="right" className="max-w-xs">
					<div className="space-y-2">
						<p className="font-medium text-sm">{t(group.labelKey)}</p>
						<div className="space-y-1">{renderTooltipItems(group.items)}</div>
					</div>
				</TooltipContent>
			</Tooltip>
		);
	};

	const renderNavGroup = (
		group: NavGroup,
		context: "default" | "favorites" = "default",
	) => {
		const isFavorites = group.id === "__favorites__";
		const isExpanded = getGroupExpandedState(group, isFavorites);
		const hasActiveItem = group.items.some((item) => activeView === item.id);
		const isPinned = pinnedGroupsSet.has(group.id);

		if (isCollapsed) {
			// In collapsed mode, show group icon with tooltip containing all items
			return renderCollapsedGroup(group, hasActiveItem);
		}

		// Helper function to render the pin button
	const renderPinButton = (group: NavGroup, isPinned: boolean, context: "default" | "favorites") => {
		const isFavorites = group.id === "__favorites__";
		
		if (context === "favorites" || isFavorites) {
			return null;
		}

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					toggleGroupPin(group.id);
				}}
				aria-label={
					isPinned
						? t("navigation:actions.unpinGroup")
						: t("navigation:actions.pinGroup")
				}
				aria-pressed={isPinned}
				className={cn(
					// right-[15px] = the item star's right-2 (8px) + the 7px inset
					// (border + px-1.5) of the items box, so group and item stars align.
					"absolute right-[15px] top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"hover:bg-accent/60 hover:scale-110",
					"opacity-0 group-hover/group-header:opacity-100 focus-visible:opacity-100",
					isPinned
						? "text-amber-400"
						: "text-muted-foreground/40 hover:text-amber-400",
				)}
			>
				<Star
					className={cn("h-3.5 w-3.5", isPinned && "fill-amber-400")}
				/>
			</button>
		);
	};

	// Helper function to render the clear favorites button
	const renderClearFavoritesButton = (isFavorites: boolean) => {
		if (!isFavorites) {
			return null;
		}

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					clearAllFavorites();
				}}
				aria-label={t("navigation:actions.clearAllFavorites")}
				title={t("navigation:actions.clearAllFavorites")}
				className={cn(
					// The favorites card adds a 5px inset (border + p-1), so right-[10px]
					// lands at the same 15px-from-sidebar-edge line as the other stars.
					"absolute right-[10px] top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"opacity-0 group-hover/group-header:opacity-100 focus-visible:opacity-100",
					"text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 hover:scale-110",
				)}
			>
				<X className="h-3.5 w-3.5" />
			</button>
		);
	};

	// Helper function to render the main group button
	const renderGroupButton = (group: NavGroup, isExpanded: boolean, hasActiveItem: boolean) => {
		const isFavorites = group.id === "__favorites__";
		const GroupIcon = group.icon;
		
		const toggleExpand = () => {
			if (isFavorites) {
				setFavoritesExpanded(!isExpanded);
			} else {
				toggleGroupExpansion(group.id);
			}
		};

		return (
			<button
				type="button"
				onClick={toggleExpand}
				className={cn(
					"flex w-full min-w-0 items-center rounded-lg text-sm transition-all duration-200 hover:scale-[1.02]",
					"hover:bg-accent hover:text-accent-foreground hover:shadow-sm",
					hasActiveItem && "bg-accent/50 text-accent-foreground shadow-sm",
					"gap-3 px-3 py-2.5",
				)}
			>
				<div
					className={cn(
						"flex items-center justify-center w-8 h-8 rounded-md transition-colors shrink-0",
						getIconContainerClassName(isFavorites, hasActiveItem),
					)}
				>
					<GroupIcon
						className={cn(
							"h-4 w-4",
							isFavorites && "fill-amber-400 text-amber-400",
						)}
					/>
				</div>
				<span className="flex-1 text-left font-medium truncate">
					{t(group.labelKey)}
				</span>
				<div
					className={cn(
						"flex items-center gap-1 shrink-0",
						// Fades out under the pin star (or favorites X) on header hover.
						"transition-opacity duration-200 group-hover/group-header:opacity-0",
					)}
				>
					<span
						className={cn(
							"text-xs px-1.5 py-0.5 rounded-full",
							isFavorites
								? "text-amber-400 bg-amber-400/10"
								: "text-muted-foreground bg-muted",
						)}
					>
						{group.items.length}
					</span>
					<ChevronRight
						className={cn(
							"h-4 w-4 shrink-0 transition-transform duration-300 text-muted-foreground",
							isExpanded && "rotate-90",
						)}
					/>
				</div>
			</button>
		);
	};

		return (
			<div
				key={group.id}
				className={cn(
					"space-y-1",
					isFavorites &&
						"rounded-lg bg-linear-to-b from-amber-400/5 to-transparent border border-amber-400/20 p-1",
				)}
			>
				<div className="group/group-header relative flex items-center">
					{renderGroupButton(group, isExpanded, hasActiveItem)}
					{renderPinButton(group, isPinned, context)}
					{renderClearFavoritesButton(isFavorites)}
				</div>

				{isExpanded && (
					<div className="space-y-1 animate-in slide-in-from-top-2 duration-300 ease-out">
						{renderExpandedItems(group.items, context)}
					</div>
				)}
			</div>
		);
	};

	return (
		<TooltipProvider>
			<div
				className={cn(
					"relative flex h-full flex-col bg-sidebar border-r border-border",
					!isResizing && "transition-all duration-300",
				)}
				style={{ width: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : resizeWidth }}
			>
				{/* Header with drag area - extra top padding for macOS traffic lights */}
				<div
					className={cn(
						"electron-drag flex h-14 items-center pt-6 transition-all duration-300",
						isCollapsed ? "justify-center px-2" : "px-4",
					)}
				>
					{isCollapsed ? (
						<div className="electron-no-drag flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
							W
						</div>
					) : (
						<span className="electron-no-drag text-lg font-bold text-primary">
							WorkPilot AI
						</span>
					)}
				</div>

				{/* Toggle + Search row */}
				<div
					className={cn(
						"flex items-center py-2 transition-all duration-300",
						isCollapsed ? "justify-center px-2" : "justify-end gap-1 px-3",
					)}
				>
					{/* Search button / inline input â€” only when expanded */}
					{!isCollapsed && (
						<div
							className={cn(
								"flex items-center overflow-hidden rounded-md transition-all duration-300 ease-in-out",
								isSearchOpen
									? "flex-1 bg-muted/50 border border-border"
									: "flex-none",
							)}
						>
							{isSearchOpen ? (
								<div className="relative flex items-center w-full">
									<Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
									<input
										ref={searchInputRef}
										type="text"
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") {
												setSearchQuery("");
												setIsSearchOpen(false);
											}
										}}
										onBlur={() => {
											if (!searchQuery.trim()) {
												setIsSearchOpen(false);
											}
										}}
										placeholder={t("search.placeholder")}
										className="w-full bg-transparent pl-7 pr-7 py-1 text-sm placeholder:text-muted-foreground/60 focus:outline-none"
									/>
									{searchQuery && (
										<button
											type="button"
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												setSearchQuery("");
												searchInputRef.current?.focus();
											}}
											className="absolute right-1.5 text-muted-foreground hover:text-foreground transition-colors"
											aria-label={t("search.clear")}
										>
											<X className="h-3.5 w-3.5" />
										</button>
									)}
								</div>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="h-7 w-7 shrink-0"
											onClick={() => {
												setIsSearchOpen(true);
												requestAnimationFrame(() =>
													searchInputRef.current?.focus(),
												);
											}}
											aria-label={t("search.placeholder")}
										>
											<Search className="h-4 w-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("search.placeholder")}
										<kbd className="ml-2 rounded border border-border bg-secondary px-1 font-mono text-[10px]">
											/
										</kbd>
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 shrink-0"
								onClick={toggleSidebar}
								aria-label={
									isCollapsed
										? t("actions.expandSidebar")
										: t("actions.collapseSidebar")
								}
							>
								{isCollapsed ? (
									<PanelLeft className="h-4 w-4" />
								) : (
									<PanelLeftClose className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{isCollapsed
								? t("actions.expandSidebar")
								: t("actions.collapseSidebar")}
						</TooltipContent>
					</Tooltip>
				</div>

				<Separator />

				{/* Navigation */}
				<ScrollArea className="flex-1">
					<div
						className={cn(
							"py-4 transition-all duration-300",
							isCollapsed ? "px-2" : "px-3",
						)}
					>
						{/* Navigation Groups with DnD */}
						<DndContext
							sensors={dndSensors}
							collisionDetection={closestCenter}
							onDragStart={handleDragStart}
							onDragEnd={handleDragEnd}
							onDragCancel={() => setActiveDragId(null)}
						>
							<div className="space-y-2">
								{favoritesGroup && !searchQuery.trim() && (
									<FavoritesDropZone
										isDragging={Boolean(activeDragId)}
										active={Boolean(
											activeDragId &&
												decodeSortableId(activeDragId)?.kind !== "fav-group",
										)}
									>
										{renderNavGroup(favoritesGroup, "favorites")}
									</FavoritesDropZone>
								)}
								{!favoritesGroup &&
									!searchQuery.trim() &&
									!isCollapsed &&
									Boolean(activeDragId) && (
										<FavoritesDropZoneEmpty
											label={t("navigation:favorites.dropHint")}
										/>
									)}
								<SortableContext
									items={filteredNavGroups.map((g) =>
										encodeSortableId("group", g.id),
									)}
									strategy={verticalListSortingStrategy}
								>
									{filteredNavGroups.map((group) => (
										<SortableWrapper
											key={group.id}
											sortableId={encodeSortableId("group", group.id)}
											disabled={Boolean(searchQuery.trim()) || isCollapsed}
										>
											{({ setNodeRef, style, isDragging, dragHandle }) => (
												<div
													ref={setNodeRef}
													style={style}
													className={cn(
														"relative group",
														isDragging &&
															"ring-1 ring-primary/50 rounded-lg bg-background/80 backdrop-blur",
													)}
												>
													{!isCollapsed && !searchQuery.trim() && (
														<div className="absolute -left-0.5 top-4 z-10">
															{dragHandle}
														</div>
													)}
													{renderNavGroup(group)}
												</div>
											)}
										</SortableWrapper>
									))}
								</SortableContext>
								{!isCollapsed &&
									searchQuery.trim() &&
									filteredNavGroups.length === 0 && (
										<p className="px-3 py-4 text-sm text-center text-muted-foreground">
											{t("search.noResults")}
										</p>
									)}
								{!isCollapsed &&
									!searchQuery.trim() &&
									(sidebarPrefs.pinnedItems.length > 0 ||
										sidebarPrefs.pinnedGroups.length > 0 ||
										sidebarPrefs.groupOrder.length > 0 ||
										Object.keys(sidebarPrefs.itemOrder).length > 0) && (
										<button
											type="button"
											onClick={resetSidebarPrefs}
											className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
										>
											<RefreshCcw className="h-3 w-3" />
											{t("navigation:actions.resetLayout")}
										</button>
									)}
							</div>
							<DragOverlay dropAnimation={null}>
								{activeDragId ? (
									<div className="rounded-lg bg-accent/80 backdrop-blur border border-primary/40 shadow-2xl px-3 py-2 text-sm">
										{(() => {
											const info = decodeSortableId(activeDragId);
											if (!info) return null;
											if (info.kind === "group") {
												const g = visibleNavGroups.find(
													(x) => x.id === info.id,
												);
												return g ? t(g.labelKey) : null;
											}
											const item = visibleNavGroups
												.flatMap((x) => x.items)
												.find((x) => x.id === info.id);
											return item ? t(item.labelKey) : null;
										})()}
									</div>
								) : null}
							</DragOverlay>
						</DndContext>
					</div>
				</ScrollArea>

				<Separator />

				{/* Rate Limit Indicator - shows when Claude is rate limited */}
				<RateLimitIndicator />

				{/* Update Banner - shows when app update is available */}
				<UpdateBanner />

				{/* Bottom section with CLI/Settings collapsible panel and New Task */}
				<div
					className={cn(
						"space-y-3 transition-all duration-300",
						isCollapsed ? "p-2" : "p-4",
					)}
				>
					{/* CLI/Settings Panel */}
					<Collapsible
						open={isCliPanelExpanded}
						onOpenChange={setIsCliPanelExpanded}
						className={isCollapsed ? "flex flex-col" : undefined}
					>
						<CollapsibleTrigger asChild>
							<Button
								variant="ghost"
								size={isCollapsed ? "icon" : "sm"}
								className={
									isCollapsed
										? "self-center"
										: "w-full h-8 justify-start gap-2 text-xs font-medium"
								}
							>
								<Wrench className="h-4 w-4" />
								{!isCollapsed && (
									<>
										<span>{t("common:actions.cliTools")}</span>
										<ChevronRight
											className={cn(
												"h-3 w-3 ml-auto transition-transform duration-200",
												isCliPanelExpanded && "rotate-90",
											)}
										/>
									</>
								)}
							</Button>
						</CollapsibleTrigger>

						<CollapsibleContent className="mt-2 space-y-2">
							{/* CLI Tools — compact grouped badges */}
							<div className="rounded-lg bg-white/4 border border-white/8 p-2 space-y-0.5 overflow-hidden">
								<ClaudeCodeStatusBadge
									onNavigateToTerminals={() => onViewChange?.("terminals", true)}
									isCollapsed={isCollapsed}
								/>
								<CopilotCliStatusBadge
									onNavigateToTerminals={() => onViewChange?.("terminals", true)}
									isCollapsed={isCollapsed}
								/>
								<CodexCliStatusBadge
									onNavigateToTerminals={() => onViewChange?.("terminals", true)}
									isCollapsed={isCollapsed}
								/>
							</div>
						</CollapsibleContent>
					</Collapsible>

					{/* Settings and Help row — always visible, outside the CLI collapsible */}
					<div
						className={cn(
							"flex items-center rounded-lg bg-white/4 border border-white/8 p-1.5",
							isCollapsed ? "flex-col gap-1" : "gap-2",
						)}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size={isCollapsed ? "icon" : "sm"}
									className={
										isCollapsed ? "" : "flex-1 justify-start gap-2"
									}
									onClick={onSettingsClick}
								>
									<Settings className="h-4 w-4" />
									{!isCollapsed && t("actions.settings")}
								</Button>
							</TooltipTrigger>
							<TooltipContent side={isCollapsed ? "right" : "top"}>
								{t("tooltips.settings")}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									onClick={() =>
										globalThis.open(
											"https://github.com/tleub-ebp/WorkPilot-AI/issues",
											"_blank",
										)
									}
									aria-label={t("tooltips.help")}
								>
									<HelpCircle className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side={isCollapsed ? "right" : "top"}>
								{t("tooltips.help")}
							</TooltipContent>
						</Tooltip>
					</div>

					{/* New Task button */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className="w-full"
								size={isCollapsed ? "icon" : "default"}
								onClick={onNewTaskClick}
								disabled={!selectedProjectId || !selectedProject?.autoBuildPath}
							>
								<Plus className={isCollapsed ? "h-4 w-4" : "mr-2 h-4 w-4"} />
								{!isCollapsed && t("actions.newTask")}
							</Button>
						</TooltipTrigger>
						{isCollapsed && (
							<TooltipContent side="right">
								{t("actions.newTask")}
							</TooltipContent>
						)}
					</Tooltip>
					{!isCollapsed &&
						selectedProject &&
						!selectedProject.autoBuildPath && (
							<p className="mt-2 text-xs text-muted-foreground text-center">
								{t("messages.initializeToCreateTasks")}
							</p>
						)}
				</div>

				{/* Resize handle */}
				{!isCollapsed && (
					// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize handle — mouse drag interaction
					<div
						onMouseDown={handleResizeStart}
						className={cn(
							"absolute top-0 right-0 w-1 h-full cursor-col-resize z-50 transition-colors",
							"hover:bg-primary/40",
							isResizing && "bg-primary/60",
						)}
					/>
				)}
			</div>

			{/* Add Project Modal */}
			<AddProjectModal
				open={showAddProjectModal}
				onOpenChange={setShowAddProjectModal}
				onProjectAdded={handleProjectAdded}
			/>

			{/* Azure DevOps Setup Modal - configure Azure DevOps */}
			{azureDevOpsSetupProject && (
				<AzureDevOpsSetupModal
					open={showAzureDevOpsSetup}
					onOpenChange={setShowAzureDevOpsSetup}
					project={azureDevOpsSetupProject}
					onComplete={handleAzureDevOpsSetupComplete}
					onSkip={handleAzureDevOpsSetupSkip}
				/>
			)}

			{/* GitHub Setup Modal - configure GitHub */}
			{gitHubSetupProject && !showAzureDevOpsSetup && (
				<GitHubSetupModal
					open={showGitHubSetup}
					onOpenChange={setShowGitHubSetup}
					project={gitHubSetupProject}
					onComplete={handleGitHubSetupComplete}
					onSkip={handleGitHubSetupSkip}
				/>
			)}

			{/* Git Setup Modal */}
			<GitSetupModal
				open={showGitSetupModal}
				onOpenChange={(open) => {
					if (!open && selectedProject) {
						// Mark this project as skipped so the modal doesn't reopen due to async re-checks
						gitSetupSkippedForProjectRef.current = selectedProject.id;
					}
					setShowGitSetupModal(open);
				}}
				project={selectedProject || null}
				gitStatus={gitStatus}
				onGitInitialized={handleGitInitialized}
			/>

			{/* AI Tools Dialogs */}
			<TestGenerationDialog />
			<PromptOptimizerDialog />
			<ContextAwareSnippetsDialog />
			<CodePlaygroundDialog />
			<ConflictPredictorDialog />
			<DependencySentinelDialog />
			<NaturalLanguageGitDialog />
			<VoiceControlDialog
				onExecuteCommand={(result) => {
					if (result.action === "navigate" && result.parameters?.destination) {
						onViewChange?.(result.parameters.destination as SidebarView);
					}
				}}
			/>
			<AppEmulatorDialog />
			<LearningLoopDialog />

			<ArenaDialog />
		</TooltipProvider>
	);
}
