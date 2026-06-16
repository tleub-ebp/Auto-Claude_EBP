import type { ClaudeInstallationInfo } from "@shared/types";
import {
	AlertTriangle,
	Check,
	Download,
	ExternalLink,
	FolderOpen,
	Loader2,
	RefreshCw,
	Terminal,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCliStatus } from "@/contexts/CliStatusContext";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useTerminalStore } from "@/stores/terminal-store";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ClaudeCodeStatusBadgeProps {
	readonly className?: string;
	readonly onNavigateToTerminals?: () => void; // Ajout de la prop pour la navigation
	// Mode replié de la sidebar : affiche uniquement l'icône pour éviter le débordement
	readonly isCollapsed?: boolean;
}

// biome-ignore lint/correctness/noUnusedVariables: variable kept for clarity
type StatusType = "loading" | "installed" | "outdated" | "not-found" | "error";

// Check interval for version updates
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Delay before re-checking version after install/update
const VERSION_RECHECK_DELAY_MS = 5000;

/**
 * Claude Code CLI status badge for the sidebar.
 * Shows installation status and provides quick access to install/update.
 */
export function ClaudeCodeStatusBadge({
	className,
	onNavigateToTerminals,
	isCollapsed = false,
}: ClaudeCodeStatusBadgeProps) {
	const { t } = useTranslation(["common", "navigation"]);
	const { data, refreshClaude } = useCliStatus();
	const { claude } = data;

	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const activeProjectId = useProjectStore((state) => state.activeProjectId);
	const currentProject = projects.find((p) => p.id === (activeProjectId || selectedProjectId));
	const projectPath = currentProject?.path || ".";
	const addExternalTerminal = useTerminalStore(
		(state) => state.addExternalTerminal,
	);

	const [isOpen, setIsOpen] = useState(false);
	const [isInstalling, setIsInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);

	// Version rollback state
	const [availableVersions, setAvailableVersions] = useState<string[]>([]);
	const [isLoadingVersions, setIsLoadingVersions] = useState(false);
	const [versionsError, setVersionsError] = useState<string | null>(null);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const [showRollbackWarning, setShowRollbackWarning] = useState(false);

	// CLI path selection state
	const [installations, setInstallations] = useState<ClaudeInstallationInfo[]>(
		[],
	);
	const [isLoadingInstallations, setIsLoadingInstallations] = useState(false);
	const [installationsError, setInstallationsError] = useState<string | null>(
		null,
	);
	const [selectedInstallation, setSelectedInstallation] = useState<
		string | null
	>(null);
	const [showPathChangeWarning, setShowPathChangeWarning] = useState(false);

	// Use data from context
	const status = claude.status;
	const versionInfo = claude.versionInfo;
	const lastChecked = claude.lastChecked;

	// Check Claude Code version
	const checkVersion = useCallback(async () => {
		try {
			if (!globalThis.electronAPI?.checkClaudeCodeVersion) {
				return;
			}

			const result = await globalThis.electronAPI.checkClaudeCodeVersion();

			if (result.success && result.data) {
				// Version checking is handled by the context
				// No need to set local state since we use context data
			}
		} catch (err) {
			console.error("Failed to check Claude Code version:", err);
		}
	}, []);

	// Fetch available versions
	const fetchVersions = useCallback(async () => {
		if (!globalThis.electronAPI?.getClaudeCodeVersions) {
			return;
		}

		setIsLoadingVersions(true);
		setVersionsError(null);

		try {
			const result = await globalThis.electronAPI.getClaudeCodeVersions();
			if (result.success && result.data) {
				setAvailableVersions(result.data.versions);
			} else {
				setVersionsError(result.error || "Failed to load versions");
			}
		} catch (err) {
			console.error("Failed to fetch versions:", err);
			setVersionsError("Failed to load versions");
		} finally {
			setIsLoadingVersions(false);
		}
	}, []);

	// Fetch CLI installations
	const fetchInstallations = useCallback(async () => {
		if (!globalThis.electronAPI?.getClaudeCodeInstallations) {
			return;
		}

		setIsLoadingInstallations(true);
		setInstallationsError(null);

		try {
			const result = await globalThis.electronAPI.getClaudeCodeInstallations();
			if (result.success && result.data) {
				setInstallations(result.data.installations);
			} else {
				setInstallationsError(result.error || "Failed to load installations");
			}
		} catch (err) {
			console.error("Failed to fetch installations:", err);
			setInstallationsError("Failed to load installations");
		} finally {
			setIsLoadingInstallations(false);
		}
	}, []);

	// Initial check and periodic re-check
	useEffect(() => {
		checkVersion();

		// Set up periodic check
		const interval = setInterval(() => {
			checkVersion();
		}, CHECK_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [checkVersion]);

	// Fetch versions when popover opens and Claude is installed
	useEffect(() => {
		if (isOpen && versionInfo?.installed && availableVersions.length === 0) {
			fetchVersions();
		}
	}, [isOpen, versionInfo?.installed, availableVersions.length, fetchVersions]);

	// Fetch installations when popover opens
	useEffect(() => {
		if (isOpen && installations.length === 0) {
			fetchInstallations();
		}
	}, [isOpen, installations.length, fetchInstallations]);

	// Helper: open an internal terminal with a command and navigate to the terminals page
	const openInternalTerminal = async (
		label: string,
		command: string,
	) => {
		if (!globalThis.electronAPI?.createTerminal) return false;

		const terminalId = `cli-action-${Date.now()}`;

		// `projectPath` may point at a folder the user has since deleted. Fall
		// back to `.` (which the main process resolves to the user's home dir)
		// so a missing project doesn't block global CLI actions.
		const safeCwd =
			projectPath && projectPath !== "." ? projectPath : ".";

		// 1. Create PTY in main process first
		const terminalResult = await globalThis.electronAPI.createTerminal({
			id: terminalId,
			cwd: safeCwd,
			cols: 80,
			rows: 25,
			projectPath: safeCwd,
		});

		if (!terminalResult.success) {
			console.error("Failed to create terminal:", terminalResult.error);
			return false;
		}

		// 2. Add to terminal store so it appears in the grid
		addExternalTerminal(terminalId, label, projectPath, projectPath);

		// 3. Close popover and navigate to the terminals page (force bypasses nav guard)
		setIsOpen(false);
		onNavigateToTerminals?.();

		// 4. Send the command to the PTY (the PTY is already running in main process)
		await new Promise((resolve) => setTimeout(resolve, 500));
		globalThis.electronAPI.sendTerminalInput(terminalId, command);
		return true;
	};

	// Perform the actual install/update.
	//
	// Strategy: try the silent-update path first (`claude install --force latest`
	// run in the background via IPC). It works whenever Claude is already
	// installed — which is the overwhelming majority case for the Update button.
	// If silent install isn't available (fresh install) or the renderer hasn't
	// exposed the IPC, fall back to opening an internal terminal.
	const performInstall = async () => {
		setIsInstalling(true);
		setInstallError(null);
		try {
			const silentApi = globalThis.electronAPI?.installClaudeCodeSilent;
			if (silentApi) {
				const result = await silentApi();
				if (result.success) {
					await refreshClaude();
					setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS);
					return;
				}
				// Only fall through to terminal mode for the explicit "needs a
				// terminal" sentinel (fresh install). Any other error is shown
				// to the user without launching a doomed terminal flow.
				if (!result.error?.startsWith("silent_install_unavailable")) {
					setInstallError(
						result.error ||
							t("navigation:claudeCode.installFailed", "Installation failed"),
					);
					return;
				}
			}

			const label =
				status === "outdated" ? "Claude Code Update" : "Claude Code Install";
			const command = "claude install --force latest\n";

			const opened = await openInternalTerminal(label, command);
			if (!opened) {
				setInstallError(
					t(
						"navigation:claudeCode.terminalUnavailable",
						"Could not open a terminal. Try installing Claude Code from a terminal manually.",
					),
				);
				return;
			}

			// Re-check repeatedly to catch when install completes
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS);
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS * 3);
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS * 6);
		} catch (err) {
			console.error("Failed to install Claude Code:", err);
			setInstallError(
				err instanceof Error
					? err.message
					: t("navigation:claudeCode.installFailed", "Installation failed"),
			);
		} finally {
			setIsInstalling(false);
		}
	};

	// Perform version rollback/switch
	const performVersionSwitch = async () => {
		if (!selectedVersion) return;

		setIsInstalling(true);
		setShowRollbackWarning(false);
		setInstallError(null);

		try {
			const label = `Claude Code ${selectedVersion}`;
			const command = `claude install --force ${selectedVersion}\n`;

			const opened = await openInternalTerminal(label, command);
			if (!opened) {
				setInstallError(
					t(
						"navigation:claudeCode.terminalUnavailable",
						"Could not open a terminal. Try installing Claude Code from a terminal manually.",
					),
				);
				return;
			}

			// Re-check repeatedly to catch when install completes
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS);
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS * 3);
			setTimeout(() => refreshClaude(), VERSION_RECHECK_DELAY_MS * 6);
		} catch (err) {
			console.error("Failed to switch Claude Code version:", err);
			setInstallError(
				err instanceof Error
					? err.message
					: t(
							"navigation:claudeCode.versionSwitchFailed",
							"Failed to switch version",
						),
			);
		} finally {
			setIsInstalling(false);
			setSelectedVersion(null);
		}
	};

	// Perform CLI path switch
	const performPathSwitch = async () => {
		if (!selectedInstallation) return;

		setIsInstalling(true);
		setShowPathChangeWarning(false);
		setInstallError(null);

		try {
			if (!globalThis.electronAPI?.setClaudeCodeActivePath) {
				setInstallError("Path switching not available");
				return;
			}

			const result =
				await globalThis.electronAPI.setClaudeCodeActivePath(
					selectedInstallation,
				);

			if (result.success) {
				setTimeout(() => {
					refreshClaude();
					fetchInstallations();
				}, VERSION_RECHECK_DELAY_MS);
			} else {
				setInstallError(result.error || "Failed to switch CLI path");
			}
		} catch (err) {
			console.error("Failed to switch Claude CLI path:", err);
			setInstallError(
				err instanceof Error ? err.message : "Failed to switch CLI path",
			);
		} finally {
			setIsInstalling(false);
			setSelectedInstallation(null);
		}
	};

	// Handle install/update button click. The silent path runs `claude install
	// --force latest` in the background and does NOT close existing sessions,
	// so no confirmation dialog is needed. If the silent path is unavailable
	// (fresh install) performInstall falls back to a terminal on its own.
	const handleInstall = () => {
		performInstall();
	};

	// Handle installation selection
	const handleInstallationSelect = (cliPath: string) => {
		// Don't do anything if it's the currently active installation
		const installation = installations.find((i) => i.path === cliPath);
		if (installation?.isActive) {
			return;
		}
		setInstallError(null);
		setSelectedInstallation(cliPath);
		setShowPathChangeWarning(true);
	};

	// Normalize version string by removing 'v' prefix for comparison
	const normalizeVersion = (v: string) => v.replace(/^v/, "");

	// Handle version selection
	const handleVersionSelect = (version: string) => {
		// Don't do anything if it's the currently installed version (normalize both for comparison)
		const normalizedSelected = normalizeVersion(version);
		const normalizedInstalled = versionInfo?.installed
			? normalizeVersion(versionInfo.installed)
			: "";
		if (normalizedSelected === normalizedInstalled) {
			return;
		}
		setInstallError(null);
		setSelectedVersion(version);
		setShowRollbackWarning(true);
	};

	// Get status indicator color
	const getStatusColor = () => {
		switch (status) {
			case "installed":
				return "bg-green-500";
			case "outdated":
				return "bg-yellow-500";
			case "not-found":
			case "error":
				return "bg-destructive";
			default:
				return "bg-muted-foreground";
		}
	};

	// Get status icon
	const getStatusIcon = () => {
		switch (status) {
			case "loading":
				return <Loader2 className="h-3 w-3 animate-spin" />;
			case "installed":
				return <Check className="h-3 w-3" />;
			case "outdated":
				return <AlertTriangle className="h-3 w-3" />;
			case "not-found":
				return <X className="h-3 w-3" />;
			case "error":
				return <AlertTriangle className="h-3 w-3" />;
		}
	};

	// Get tooltip text
	const getTooltipText = () => {
		switch (status) {
			case "loading":
				return t("navigation:claudeCode.checking", "Checking Claude Code...");
			case "installed":
				return t("navigation:claudeCode.upToDate", "Claude Code is up to date");
			case "outdated":
				return t(
					"navigation:claudeCode.updateAvailable",
					"Claude Code update available",
				);
			case "not-found":
				return t(
					"navigation:claudeCode.notInstalled",
					"Claude Code not installed",
				);
			case "error":
				return t("navigation:claudeCode.error", "Error checking Claude Code");
		}
	};

	// Get version select placeholder text
	const getVersionSelectPlaceholder = () => {
		if (isLoadingVersions) {
			return t("navigation:claudeCode.loadingVersions", "Loading versions...");
		}
		if (versionsError) {
			return t(
				"navigation:claudeCode.failedToLoadVersions",
				"Failed to load versions",
			);
		}
		return t("navigation:claudeCode.selectVersion", "Select version");
	};

	// Get installation select placeholder text
	const getInstallationSelectPlaceholder = () => {
		if (isLoadingInstallations) {
			return t(
				"navigation:claudeCode.loadingInstallations",
				"Loading installations...",
			);
		}
		if (installationsError) {
			return t(
				"navigation:claudeCode.failedToLoadInstallations",
				"Failed to load installations",
			);
		}
		return t("navigation:claudeCode.selectInstallation", "Select installation");
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size={isCollapsed ? "icon" : "sm"}
							className={cn(
								isCollapsed
									? "justify-center"
									: "w-full justify-start gap-2 text-xs",
								status === "not-found" || status === "error"
									? "text-destructive"
									: "",
								status === "outdated"
									? "text-yellow-600 dark:text-yellow-500"
									: "",
								className,
							)}
						>
							<div className="relative">
								<Terminal className="h-4 w-4" />
								<span
									className={cn(
										"absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full",
										getStatusColor(),
									)}
								/>
							</div>
							{!isCollapsed && (
								<>
									<span className="truncate">
										Claude Code
										{versionInfo?.installed &&
										versionInfo.installed !== "unknown"
											? ` (${versionInfo.installed})`
											: ""}
									</span>
									{status === "outdated" && (
										<span className="ml-auto text-[10px] bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded">
											{t("common:update", "Update")}
										</span>
									)}
									{(status === "not-found" || status === "error") && (
										<span className="ml-auto text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">
											{t("common:install", "Install")}
										</span>
									)}
								</>
							)}
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="right">{getTooltipText()}</TooltipContent>
			</Tooltip>

			<PopoverContent side="right" align="end" className="w-72">
				<div className="space-y-3">
					{/* Header avec ProviderSelector */}
					<div className="flex items-center gap-2 justify-between">
						<div className="flex items-center gap-2">
							<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
								<Terminal className="h-4 w-4 text-primary" />
							</div>
							<div>
								<h4 className="text-sm font-medium">Claude Code CLI</h4>
								<p className="text-xs text-muted-foreground flex items-center gap-1">
									{getStatusIcon()}
									{status === "installed" &&
										t("navigation:claudeCode.installed", "Installed")}
									{status === "outdated" &&
										t("navigation:claudeCode.outdated", "Update available")}
									{status === "not-found" &&
										t("navigation:claudeCode.missing", "Not installed")}
									{status === "loading" &&
										t("navigation:claudeCode.checking", "Checking...")}
									{status === "error" &&
										t("navigation:claudeCode.error", "Error")}
								</p>
							</div>
						</div>
					</div>

					{/* Version info */}
					{versionInfo && status !== "loading" && (
						<div className="text-xs space-y-1 p-2 bg-muted rounded-md">
							{versionInfo.installed && (
								<div className="flex justify-between">
									<span className="text-muted-foreground">
										{t("navigation:claudeCode.current", "Current")}:
									</span>
									<span className="font-mono">{versionInfo.installed}</span>
								</div>
							)}
							{versionInfo.latest && versionInfo.latest !== "unknown" && (
								<div className="flex justify-between">
									<span className="text-muted-foreground">
										{t("navigation:claudeCode.latest", "Latest")}:
									</span>
									<span className="font-mono">{versionInfo.latest}</span>
								</div>
							)}
							{versionInfo.path && (
								<div className="flex justify-between items-center gap-2">
									<span className="text-muted-foreground flex items-center gap-1">
										<FolderOpen className="h-3 w-3" />
										{t("navigation:claudeCode.path", "Path")}:
									</span>
									<span
										className="font-mono text-[10px] truncate max-w-[140px]"
										title={versionInfo.path}
									>
										{versionInfo.path}
									</span>
								</div>
							)}
							{lastChecked && (
								<div className="flex justify-between text-muted-foreground">
									<span>
										{t("navigation:claudeCode.lastChecked", "Last checked")}:
									</span>
									<span>{lastChecked.toLocaleTimeString()}</span>
								</div>
							)}
						</div>
					)}

					{/* Actions */}
					<div className="flex gap-2">
						{(status === "not-found" ||
							status === "outdated" ||
							status === "error") && (
							<Button
								size="sm"
								className="flex-1 gap-1"
								onClick={handleInstall}
								disabled={isInstalling}
							>
								{isInstalling ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : (
									<Download className="h-3 w-3" />
								)}
								{status === "outdated"
									? t("common:update", "Update")
									: t("common:install", "Install")}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							className="gap-1"
							onClick={() => refreshClaude()}
							disabled={status === "loading"}
						>
							<RefreshCw
								className={cn(
									"h-3 w-3",
									status === "loading" && "animate-spin",
								)}
							/>
							{t("common:refresh", "Refresh")}
						</Button>
					</div>

					{/* Install/Update error display */}
					{installError && (
						<div className="text-xs p-2 bg-destructive/10 text-destructive rounded-md flex items-center gap-2">
							<AlertTriangle className="h-3 w-3 shrink-0" />
							<span>{installError}</span>
						</div>
					)}

					{/* Version selector - only show when Claude is installed */}
					{versionInfo?.installed && (
						<div className="space-y-1.5">
							<p className="text-xs text-muted-foreground">
								{t("navigation:claudeCode.switchVersion", "Switch Version")}
							</p>
							<Select
								value={selectedVersion || ""}
								onValueChange={handleVersionSelect}
								disabled={isLoadingVersions || isInstalling}
							>
								<SelectTrigger
									className="h-8 text-xs"
									id="claude-version-select"
								>
									<SelectValue placeholder={getVersionSelectPlaceholder()} />
								</SelectTrigger>
								<SelectContent>
									{availableVersions.map((version) => {
										const isCurrentVersion =
											normalizeVersion(version) ===
											normalizeVersion(versionInfo.installed || "");
										return (
											<SelectItem
												key={version}
												value={version}
												className="text-xs"
												disabled={isCurrentVersion}
											>
												<span className="font-mono">{version}</span>
												{isCurrentVersion && (
													<span className="ml-2 text-muted-foreground">
														(
														{t(
															"navigation:claudeCode.currentVersion",
															"Current",
														)}
														)
													</span>
												)}
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* CLI Installation selector - show when multiple installations are found */}
					{installations.length > 1 && (
						<div className="space-y-1.5">
							{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
							<label className="text-xs text-muted-foreground">
								{t(
									"navigation:claudeCode.switchInstallation",
									"Switch Installation",
								)}
							</label>
							<Select
								value={selectedInstallation || ""}
								onValueChange={handleInstallationSelect}
								disabled={isLoadingInstallations || isInstalling}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue
										placeholder={getInstallationSelectPlaceholder()}
									/>
								</SelectTrigger>
								<SelectContent>
									{installations.map((installation) => (
										<SelectItem
											key={installation.path}
											value={installation.path}
											className="text-xs"
											disabled={installation.isActive}
										>
											<div className="flex flex-col">
												<span
													className="font-mono text-[10px] truncate max-w-[180px]"
													title={installation.path}
												>
													{/* Split on both path separators for cross-platform compatibility */}
													{installation.path
														.split(/[/\\]/)
														.slice(-2)
														.join("/") || installation.path}
												</span>
												<span className="text-muted-foreground text-[9px]">
													{installation.version
														? `v${installation.version}`
														: t(
																"navigation:claudeCode.versionUnknown",
																"version unknown",
															)}{" "}
													({installation.source})
													{installation.isActive &&
														` - ${t("navigation:claudeCode.activeInstallation", "Active")}`}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Changelog link */}
					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() =>
							globalThis.electronAPI?.openExternal?.(
								"https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
							)
						}
						aria-label={t(
							"navigation:claudeCode.viewChangelogAriaLabel",
							"View Claude Code Changelog (opens in new window)",
						)}
					>
						{t(
							"navigation:claudeCode.viewChangelog",
							"View Claude Code Changelog",
						)}
						<ExternalLink className="h-3 w-3" aria-hidden="true" />
					</Button>
				</div>
			</PopoverContent>

			{/* Version rollback warning dialog */}
			<AlertDialog
				open={showRollbackWarning}
				onOpenChange={setShowRollbackWarning}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t(
								"navigation:claudeCode.rollbackWarningTitle",
								"Switch to version {{version}}?",
								{
									version: selectedVersion,
								},
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								"navigation:claudeCode.rollbackWarningDescription",
								"Switching versions will close all running Claude Code sessions. Any unsaved work in those sessions may be lost. Make sure to save your work before proceeding.",
							)}
							<span className="block mt-2 font-semibold text-foreground">
								{t(
									"navigation:claudeCode.rollbackWarningTerminalNote",
									"A terminal window will open to run the installation command. Please wait for the installation to complete before continuing.",
								)}
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => setSelectedVersion(null)}>
							{t("common:cancel", "Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={performVersionSwitch}>
							{t(
								"navigation:claudeCode.switchAnyway",
								"Open Terminal & Switch",
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Path change warning dialog */}
			<AlertDialog
				open={showPathChangeWarning}
				onOpenChange={setShowPathChangeWarning}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t(
								"navigation:claudeCode.pathChangeWarningTitle",
								"Switch CLI installation?",
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								"navigation:claudeCode.pathChangeWarningDescription",
								"Switching CLI installations will use a different Claude Code binary. Any running sessions will continue using the previous installation until restarted.",
							)}
							<span className="block mt-2 font-mono text-xs break-all">
								{selectedInstallation}
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => setSelectedInstallation(null)}>
							{t("common:cancel", "Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={performPathSwitch}>
							{t("navigation:claudeCode.switchInstallationConfirm", "Switch")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Popover>
	);
}
