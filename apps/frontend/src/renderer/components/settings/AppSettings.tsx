import {
	Activity,
	Bell,
	Bot,
	Bug,
	CalendarClock,
	ChevronRight,
	Cloud,
	Code,
	Database,
	FolderOpen,
	Globe,
	Loader2,
	MessageSquare,
	Monitor,
	Package,
	Palette,
	Save,
	Settings,
	Settings2,
	Shield,
	ShieldAlert,
	Sparkles,
	Terminal,
	Users,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@shared/types/settings";
import type { UseProjectSettingsReturn } from "@/components/project-settings";
import { TerminalFontSettings } from "@/components/settings/terminal-font-settings";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { Button } from "../ui/button";
import {
	FullScreenDialog,
	FullScreenDialogBody,
	FullScreenDialogContent,
	FullScreenDialogDescription,
	FullScreenDialogFooter,
	FullScreenDialogHeader,
	FullScreenDialogTitle,
} from "../ui/full-screen-dialog";
import { AdvancedSettings } from "./AdvancedSettings";
import { AnomalyDetectionSettings } from "./AnomalyDetectionSettings";
import { CleanProviderSection } from "./CleanProviderSection";
import { ContinuousAISettings } from "./ContinuousAISettings";
import { DebugSettings } from "./DebugSettings";
import { DevToolsSettings } from "./DevToolsSettings";
import { DisplaySettings } from "./DisplaySettings";
import { GeneralSettings } from "./GeneralSettings";
import { useSettings } from "./hooks/useSettings";
import { LanguageSettings } from "./LanguageSettings";
import { ProjectSettingsContent } from "./ProjectSettingsContent";
import { GuardrailsSettings } from "./GuardrailsSettings";
import { SandboxSettings } from "./SandboxSettings";
import { SchedulerSettings } from "./SchedulerSettings";
import { SwarmModeSettings } from "./SwarmModeSettings";
import { ThemeSettings } from "./ThemeSettings";

// GitLab icon component (lucide-react doesn't have one)
function GitLabIcon({ className }: { readonly className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-label="GitLab"
		>
			<title>GitLab</title>
			<path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z" />
		</svg>
	);
}

// Jira icon component (lucide-react doesn't include one)
function JiraIcon({ className }: { readonly className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-label="Jira"
		>
			<title>Jira</title>
			<path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84h-9.63zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72a4.35 4.35 0 0 0 4.34 4.34v-9.57a.84.84 0 0 0-.84-.84H2z" />
		</svg>
	);
}

interface AppSettingsDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly initialSection?: AppSection;
	readonly initialProjectSection?: ProjectSettingsSection;
	readonly initialProjectId?: string;
	readonly onRerunWizard?: () => void;
}

// Types de sections thématiques
export type AppSection =
	// Projet (priorité 1)
	| "project"
	// Intégrations & Connexions (priorité 2)
	| "integrations"
	| "accounts"
	// Interface & Apparence
	| "appearance"
	| "display"
	| "language"
	| "terminal-fonts"
	// Développement & Outils
	| "devtools"
	| "paths"
	| "agent"
	// Sécurité & Performance
	| "sandbox"
	| "guardrails"
	| "anomaly-detection"
	| "memory"
	// Système & Maintenance
	| "updates"
	| "notifications"
	| "debug"
	| "scheduler"
	| "swarm-mode"
	| "continuous-ai";

export type ProjectSettingsSection =
	| "general"
	| "azure-devops"
	| "jira"
	| "github"
	| "gitlab"
	| "linear"
	| "teams"
	| "memory";

export type SettingsTheme =
	| "project" // Projet
	| "integrations" // Intégrations & Connexions
	| "interface" // Interface & Apparence
	| "development" // Développement & Outils
	| "security" // Sécurité & Performance
	| "system"; // Système & Maintenance

// Configuration des thèmes de paramètres avec leurs sections
const createSettingsThemes = (t: {
	(key: string): string;
	(key: string, fallback: string): string;
	(key: string, options: Record<string, unknown>): string;
}): Record<
	SettingsTheme,
	{
		title: string;
		icon: React.ElementType;
		color: string;
		sections: Array<{
			id: string;
			icon: React.ElementType;
			label: string;
			type: "app" | "project";
		}>;
		description: string;
		priority: number;
	}
> => ({
	project: {
		title: "Projet",
		icon: Settings2,
		color: "text-blue-600",
		sections: [
			{ id: "general", icon: Settings2, label: "Général", type: "project" },
		],
		description: "Configuration du projet actuel",
		priority: 1,
	},
	integrations: {
		title: "Intégrations & Connexions",
		icon: Users,
		color: "text-purple-600",
		sections: [
			{ id: "accounts", icon: Users, label: "Comptes IA", type: "app" },
			{
				id: "memory",
				icon: Database,
				label: t("projectSections.memory.title"),
				type: "project",
			},
			{
				id: "azure-devops",
				icon: Cloud,
				label: "Azure DevOps",
				type: "project",
			},
			{ id: "jira", icon: JiraIcon, label: "Jira", type: "project" },
			{ id: "github", icon: Globe, label: "GitHub", type: "project" },
			{ id: "gitlab", icon: GitLabIcon, label: "GitLab", type: "project" },
			{ id: "linear", icon: Zap, label: "Linear", type: "project" },
			{
				id: "teams",
				icon: MessageSquare,
				label: "Microsoft Teams",
				type: "project",
			},
		],
		description: "Comptes IA et intégrations externes",
		priority: 2,
	},
	interface: {
		title: "Interface & Apparence",
		icon: Palette,
		color: "text-pink-600",
		sections: [
			{ id: "appearance", icon: Palette, label: "Apparence", type: "app" },
			{ id: "display", icon: Monitor, label: "Affichage", type: "app" },
			{ id: "language", icon: Globe, label: "Langue", type: "app" },
			{
				id: "terminal-fonts",
				icon: Terminal,
				label: "Polices terminal",
				type: "app",
			},
		],
		description: "Personnalisation de l'interface",
		priority: 3,
	},
	development: {
		title: "Développement & Outils",
		icon: Code,
		color: "text-green-600",
		sections: [
			{
				id: "devtools",
				icon: Code,
				label: "Outils de développement",
				type: "app",
			},
			{ id: "paths", icon: FolderOpen, label: t("sections.paths.title"), type: "app" },
			{ id: "agent", icon: Bot, label: "Agent", type: "app" },
			{
				id: "swarm-mode",
				icon: Zap,
				label: t("swarm:title", "Swarm Mode"),
				type: "app",
			},
			{
				id: "continuous-ai",
				icon: Activity,
				label: t("continuousAI:title", "Continuous AI"),
				type: "app",
			},
		],
		description: "Outils de développement et configuration",
		priority: 4,
	},
	security: {
		title: "Sécurité & Performance",
		icon: Shield,
		color: "text-orange-600",
		sections: [
			{
				id: "sandbox",
				icon: Shield,
				label: t("sections.sandbox.title"),
				type: "app",
			},
			{
				id: "guardrails",
				icon: Shield,
				label: t("guardrails.title", "Agent Guardrails"),
				type: "app",
			},
			{
				id: "anomaly-detection",
				icon: ShieldAlert,
				label: t("sections.anomaly-detection.title"),
				type: "app",
			},
		],
		description: "Sécurité et performance du système",
		priority: 5,
	},
	system: {
		title: "Système & Maintenance",
		icon: Package,
		color: "text-gray-600",
		sections: [
			{ id: "updates", icon: Package, label: "Mises à jour", type: "app" },
			{ id: "notifications", icon: Bell, label: "Notifications", type: "app" },
			{ id: "debug", icon: Bug, label: "Debug", type: "app" },
			{
				id: "scheduler",
				icon: CalendarClock,
				label: "Planification",
				type: "app",
			},
		],
		description: "Maintenance et système",
		priority: 6,
	},
});

/**
 * Main application settings dialog container
 * Coordinates app and project settings sections
 */
export function AppSettingsDialog(props: AppSettingsDialogProps) {
	const {
		open,
		onOpenChange,
		initialSection,
		initialProjectSection,
		initialProjectId,
		onRerunWizard,
	} = props;
	const { t } = useTranslation(["settings", "swarm", "continuousAI"]);
	const {
		settings,
		setSettings,
		isSaving,
		error,
		saveSettings,
		revertTheme,
		commitTheme,
	} = useSettings();
	const [version, setVersion] = useState<string>("");

	// Create dynamic settings themes with translations
	const SETTINGS_THEMES = createSettingsThemes(t);

	// Project state (déclaré avant tout usage)
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const selectProject = useProjectStore((state) => state.selectProject);
	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Track which top-level section is active
	const [activeTopLevel, setActiveTopLevel] = useState<"app" | "project">(
		"app",
	);
	const [appSection, setAppSection] = useState<AppSection>(
		initialSection || "appearance",
	);
	const [projectSection, setProjectSection] =
		useState<ProjectSettingsSection>("general");
	const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(false);
	const [collapsedThemes, setCollapsedThemes] = useState<Set<SettingsTheme>>(
		new Set(),
	);

	// Function to navigate to accounts section
	const handleOpenAccountsSettings = () => {
		setActiveTopLevel("app");
		setAppSection("accounts");
	};

	// Listen for cross-component navigation requests (fired by descendants like
	// project-settings/GeneralSettings to jump to the global "Agent" section).
	useEffect(() => {
		if (!open) return;
		const handler = (event: Event) => {
			const target = (event as CustomEvent<{ section?: AppSection }>).detail
				?.section;
			if (!target) return;
			setActiveTopLevel("app");
			setAppSection(target);
		};
		window.addEventListener("app-settings:navigate", handler);
		return () => window.removeEventListener("app-settings:navigate", handler);
	}, [open]);

	// Function to toggle theme collapse
	const toggleThemeCollapse = (themeKey: SettingsTheme) => {
		setCollapsedThemes((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(themeKey)) {
				newSet.delete(themeKey);
			} else {
				newSet.add(themeKey);
			}
			return newSet;
		});
	};

	// Navigate to the initial section when dialog opens with a specific section
	useEffect(() => {
		if (open) {
			if (initialProjectSection) {
				setActiveTopLevel("project");
				setProjectSection(initialProjectSection);
			} else if (initialSection) {
				setActiveTopLevel("app");
				setAppSection(initialSection);
			}
		}
	}, [open, initialSection, initialProjectSection]);

	// Synchronise la section projet dès qu'un projet est sélectionné et que le dialog s'ouvre
	useEffect(() => {
		if (open && selectedProject && initialProjectSection) {
			setActiveTopLevel("project");
			setProjectSection(initialProjectSection);
		}
	}, [open, selectedProject, initialProjectSection]);

	// Synchronisation du projet sélectionné avec initialProjectId
	useEffect(() => {
		if (initialProjectId && initialProjectId !== selectedProjectId) {
			selectProject(initialProjectId);
		}
	}, [initialProjectId, selectedProjectId, selectProject]);

	// Project settings hook state (lifted from child)
	const [projectSettingsHook, setProjectSettingsHook] =
		useState<UseProjectSettingsReturn | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);

	// Load app version on mount
	useEffect(() => {
		globalThis.electronAPI.getAppVersion().then(setVersion);
	}, []);

	// Memoize the callback to avoid infinite loops
	const handleProjectHookReady = useCallback(
		(hook: UseProjectSettingsReturn | null) => {
			setProjectSettingsHook(hook);
			if (hook) {
				setProjectError(hook.error || hook.envError || null);
			} else {
				setProjectError(null);
			}
		},
		[],
	);

	const handleSave = async () => {
		// Save app settings first
		const appSaveSuccess = await saveSettings();

		// If on project section with a project selected, save project settings too
		if (
			activeTopLevel === "project" &&
			selectedProject &&
			projectSettingsHook
		) {
			await projectSettingsHook.handleSave(() => {
				/* noop */
			});
			// Check for project errors
			if (projectSettingsHook.error || projectSettingsHook.envError) {
				setProjectError(
					projectSettingsHook.error || projectSettingsHook.envError,
				);
				return; // Don't close dialog on error
			}
		}

		if (appSaveSuccess) {
			// Commit the theme so future cancels won't revert to old values
			commitTheme();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		// onOpenChange handler will revert theme changes
		onOpenChange(false);
	};

	const renderAppSection = () => {
		switch (appSection) {
			case "appearance":
				return (
					<ThemeSettings settings={settings} onSettingsChange={setSettings} />
				);
			case "display":
				return (
					<DisplaySettings settings={settings} onSettingsChange={setSettings} />
				);
			case "language":
				return (
					<LanguageSettings
						settings={settings}
						onSettingsChange={setSettings}
					/>
				);
			case "devtools":
				return (
					<DevToolsSettings
						settings={settings}
						onSettingsChange={setSettings}
					/>
				);
			case "terminal-fonts":
				return <TerminalFontSettings />;
			case "agent":
				return (
					<GeneralSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="agent"
						onOpenAccountsSettings={handleOpenAccountsSettings}
					/>
				);
			case "paths":
				return (
					<GeneralSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="paths"
						onOpenAccountsSettings={handleOpenAccountsSettings}
					/>
				);
			case "accounts":
				return (
					<CleanProviderSection
						settings={settings as AppSettings & Record<string, unknown>}
						onSettingsChange={setSettings}
						isOpen={open}
					/>
				);
			case "updates":
				return (
					<AdvancedSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="updates"
						version={version}
					/>
				);
			case "notifications":
				return (
					<AdvancedSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="notifications"
						version={version}
					/>
				);
			case "debug":
				return <DebugSettings />;
			case "sandbox":
				return <SandboxSettings />;
			case "guardrails":
				return <GuardrailsSettings />;
			case "anomaly-detection":
				return <AnomalyDetectionSettings />;
			case "scheduler":
				return <SchedulerSettings />;
			case "swarm-mode":
				return <SwarmModeSettings />;
			case "continuous-ai":
				return <ContinuousAISettings />;
			default:
				return null;
		}
	};

	const renderContent = () => {
		if (activeTopLevel === "app") {
			return renderAppSection();
		}
		if (!selectedProject) {
			return (
				<div style={{ color: "red", padding: "1em" }}>
					Projet non trouvé: {selectedProjectId}
				</div>
			);
		}
		return (
			<ProjectSettingsContent
				project={selectedProject}
				activeSection={projectSection}
				isOpen={open}
				onHookReady={handleProjectHookReady}
			/>
		);
	};

	// Correction : on force le dialog à s'ouvrir si forceDialogOpen est true
	const dialogOpen = typeof open === "boolean" ? open : false;

	return (
		<FullScreenDialog
			open={dialogOpen}
			onOpenChange={(newOpen) => {
				if (!newOpen) {
					revertTheme();
				}
				onOpenChange(newOpen);
			}}
		>
			<FullScreenDialogContent>
				<FullScreenDialogHeader>
					<FullScreenDialogTitle className="flex items-center gap-3">
						<Settings className="h-6 w-6" />
						{t("title")}
					</FullScreenDialogTitle>
					<FullScreenDialogDescription>
						{t("tabs.app")} & {t("tabs.project")}
					</FullScreenDialogDescription>
				</FullScreenDialogHeader>
				<FullScreenDialogBody>
					<div className="flex h-full">
						{/* Navigation sidebar */}
						<nav
							className={cn(
								"border-r border-border bg-muted/30 transition-all duration-300",
								isNavigationCollapsed ? "w-16 p-2" : "w-80 p-4",
							)}
						>
							<ScrollArea className="h-full">
								<div className="space-y-4">
									{/* Toggle button */}
									<button
										type="button"
										onClick={() =>
											setIsNavigationCollapsed(!isNavigationCollapsed)
										}
										className={cn(
											"w-full flex items-center justify-center p-2 rounded-lg transition-all",
											"hover:bg-accent/50 text-muted-foreground hover:text-foreground",
										)}
									>
										<ChevronRight
											className={cn(
												"h-4 w-4 transition-transform duration-300",
												isNavigationCollapsed ? "rotate-0" : "rotate-180",
											)}
										/>
									</button>

									{/* Thematic Navigation */}
									{Object.entries(SETTINGS_THEMES)
										.sort(([, a], [, b]) => a.priority - b.priority)
										.map(([themeKey, theme]) => {
											const Icon = theme.icon;
											const isThemeActive = theme.sections.some((section) => {
												if (section.type === "app") {
													return (
														activeTopLevel === "app" &&
														appSection === section.id
													);
												} else {
													return (
														activeTopLevel === "project" &&
														projectSection === section.id
													);
												}
											});

											return (
												<div key={themeKey} className="space-y-1">
													{/* Theme Header */}
													{isNavigationCollapsed ? (
														<button
															type="button"
															onClick={() => {
																if (theme.sections.length === 1) {
																	const section = theme.sections[0];
																	if (section.type === "app") {
																		setActiveTopLevel("app");
																		setAppSection(section.id as AppSection);
																	} else {
																		setActiveTopLevel("project");
																		setProjectSection(
																			section.id as ProjectSettingsSection,
																		);
																	}
																} else {
																	// Si plusieurs sections, on pourrait développer ou afficher un menu
																	// Pour l'instant, on navigue vers la première section
																	const firstSection = theme.sections[0];
																	if (firstSection.type === "app") {
																		setActiveTopLevel("app");
																		setAppSection(
																			firstSection.id as AppSection,
																		);
																	} else {
																		setActiveTopLevel("project");
																		setProjectSection(
																			firstSection.id as ProjectSettingsSection,
																		);
																	}
																}
															}}
															className={cn(
																"w-full flex flex-col items-center justify-center p-2 rounded-lg transition-all",
																isThemeActive
																	? "bg-accent text-accent-foreground"
																	: "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
															)}
															title={theme.title}
														>
															<Icon className={cn("h-5 w-5", theme.color)} />
														</button>
													) : (
														<div className="px-3 py-2">
															<button
																type="button"
																onClick={() =>
																	toggleThemeCollapse(themeKey as SettingsTheme)
																}
																className={cn(
																	"w-full flex items-center justify-between text-sm font-medium transition-all",
																	isThemeActive
																		? "text-foreground"
																		: "text-muted-foreground",
																	"hover:text-foreground",
																)}
															>
																<div className="flex items-center gap-2">
																	<Icon
																		className={cn("h-4 w-4", theme.color)}
																	/>
																	{theme.title}
																</div>
																<ChevronRight
																	className={cn(
																		"h-3 w-3 transition-transform duration-200",
																		collapsedThemes.has(
																			themeKey as SettingsTheme,
																		)
																			? "rotate-0"
																			: "rotate-90",
																	)}
																/>
															</button>
															<div className="text-xs text-muted-foreground mt-1">
																{theme.description}
															</div>
														</div>
													)}

													{/* Theme Sections - seulement si non replié ET thème non replié */}
													{!isNavigationCollapsed &&
														!collapsedThemes.has(themeKey as SettingsTheme) && (
															<div className="space-y-1 ml-2">
																{theme.sections.map((section) => {
																	const SectionIcon = section.icon;
																	const isActive =
																		section.type === "app"
																			? activeTopLevel === "app" &&
																				appSection === section.id
																			: activeTopLevel === "project" &&
																				projectSection === section.id;

																	const isDisabled =
																		section.type === "project" &&
																		!selectedProjectId;

																	let activeOrDisabledClassName: string;
																	if (isActive) {
																		activeOrDisabledClassName =
																			"bg-accent text-accent-foreground";
																	} else if (isDisabled) {
																		activeOrDisabledClassName =
																			"opacity-50 cursor-not-allowed text-muted-foreground";
																	} else {
																		activeOrDisabledClassName =
																			"hover:bg-accent/50 text-muted-foreground hover:text-foreground";
																	}

																	const buttonClassName = cn(
																		"w-full flex items-center gap-3 p-2 rounded-md text-left transition-all",
																		activeOrDisabledClassName,
																	);

																	return (
																		<button
																			type="button"
																			key={section.id}
																			onClick={() => {
																				if (section.type === "app") {
																					setActiveTopLevel("app");
																					setAppSection(
																						section.id as AppSection,
																					);
																				} else {
																					setActiveTopLevel("project");
																					setProjectSection(
																						section.id as ProjectSettingsSection,
																					);
																				}
																			}}
																			disabled={isDisabled}
																			className={buttonClassName}
																		>
																			<SectionIcon className="h-4 w-4 shrink-0" />
																			<div className="min-w-0">
																				<div className="font-medium text-xs">
																					{section.label}
																				</div>
																			</div>
																		</button>
																	);
																})}
															</div>
														)}
												</div>
											);
										})}

									{/* Re-run Wizard button - seulement si non replié */}
									{!isNavigationCollapsed && onRerunWizard && (
										<div className="pt-4 border-t border-border">
											<button
												type="button"
												onClick={() => {
													onOpenChange(false);
													onRerunWizard();
												}}
												className={cn(
													"w-full flex items-start gap-3 p-3 rounded-lg text-left transition-all",
													"border border-dashed border-muted-foreground/30",
													"hover:bg-accent/50 text-muted-foreground hover:text-foreground",
												)}
											>
												<Sparkles className="h-5 w-5 mt-0.5 shrink-0" />
												<div className="min-w-0">
													<div className="font-medium text-sm">
														{t("actions.rerunWizard")}
													</div>
													<div className="text-xs text-muted-foreground truncate">
														{t("actions.rerunWizardDescription")}
													</div>
												</div>
											</button>
										</div>
									)}
								</div>
							</ScrollArea>
						</nav>

						{/* Main content */}
						<div className="flex-1 overflow-hidden">
							<ScrollArea className="h-full">
								<div
									className={cn(
										appSection === "accounts" ? "p-8" : "p-8 max-w-2xl",
									)}
								>
									{renderContent()}
								</div>
							</ScrollArea>
						</div>
					</div>
				</FullScreenDialogBody>

				<FullScreenDialogFooter>
					{(error || projectError) && (
						<div className="flex-1 rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-2 text-sm text-destructive">
							{error || projectError}
						</div>
					)}
					<Button variant="outline" onClick={handleCancel}>
						{t("common:buttons.cancel", "Cancel")}
					</Button>
					<Button
						onClick={handleSave}
						disabled={
							isSaving ||
							(activeTopLevel === "project" && projectSettingsHook?.isSaving)
						}
					>
						{isSaving ||
						(activeTopLevel === "project" && projectSettingsHook?.isSaving) ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("common:buttons.saving", "Saving...")}
							</>
						) : (
							<>
								<Save className="mr-2 h-4 w-4" />
								{t("actions.save")}
							</>
						)}
					</Button>
				</FullScreenDialogFooter>
			</FullScreenDialogContent>
		</FullScreenDialog>
	);
}
