import type { CopilotInstallationInfo } from "@shared/types";
import {
	AlertTriangle,
	Check,
	Download,
	ExternalLink,
	FolderOpen,
	Loader2,
	LogIn,
	RefreshCw,
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

interface CopilotCliStatusBadgeProps {
	readonly className?: string;
	readonly onNavigateToTerminals?: () => void;
}

interface CopilotIconProps {
	readonly className?: string;
}

// biome-ignore lint/correctness/noUnusedVariables: variable kept for clarity
type StatusType =
	| "loading"
	| "installed"
	| "outdated"
	| "not-found"
	| "gh-missing"
	| "error";

const _CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_RECHECK_DELAY_MS = 5000;
const _UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check for updates every 5 minutes when outdated

/**
 * GitHub Copilot icon (simplified SVG)
 */
function CopilotIcon({ className }: CopilotIconProps) {
	return (
		<>
			{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative */}
			<svg
				className={className}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
				<path d="M8 14s1.5 2 4 2 4-2 4-2" />
				<circle cx="9" cy="10" r="1.25" fill="currentColor" stroke="none" />
				<circle cx="15" cy="10" r="1.25" fill="currentColor" stroke="none" />
			</svg>
		</>
	);
}

/**
 * Copilot CLI status badge for the sidebar.
 * Shows installation status and provides quick access to install/update/auth.
 * Mirrors ClaudeCodeStatusBadge pattern but adapted for gh copilot extension.
 */
export function CopilotCliStatusBadge({
	className,
	onNavigateToTerminals,
}: CopilotCliStatusBadgeProps) {
	const { t } = useTranslation(["common", "navigation", "settings"]);
	const { data, refreshCopilot } = useCliStatus();
	const { copilot } = data;

	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const activeProjectId = useProjectStore((state) => state.activeProjectId);
	const currentProject = projects.find((p) => p.id === (activeProjectId || selectedProjectId));
	const projectPath = currentProject?.path || ".";
	const addExternalTerminal = useTerminalStore(
		(state) => state.addExternalTerminal,
	);

	const [isOpen, setIsOpen] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [isInstalling, setIsInstalling] = useState(false);

	// CLI path selection state
	const [installations, setInstallations] = useState<CopilotInstallationInfo[]>(
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
	const status = copilot.status;
	const versionInfo = copilot.versionInfo;
	const authStatus = copilot.authStatus;
	const lastChecked = copilot.lastChecked;

	// Fetch CLI installations when popover opens
	const fetchInstallations = useCallback(async () => {
		if (!globalThis.electronAPI?.getCopilotCliInstallations) return;

		setIsLoadingInstallations(true);
		setInstallationsError(null);

		try {
			const result = await globalThis.electronAPI.getCopilotCliInstallations();
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

	// Fetch installations when popover opens
	useEffect(() => {
		if (isOpen && installations.length === 0) {
			fetchInstallations();
		}
	}, [isOpen, installations.length, fetchInstallations]);

	// Helper function for delay
	const delay = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));

	// Installation commands for GitHub Copilot CLI (gh extension, not npm)
	const COPILOT_INSTALL_COMMAND = "gh copilot install\n";
	const COPILOT_UPDATE_COMMAND = "gh copilot update\n";

	// Helper: open an internal terminal with a command and navigate to the terminals page
	const openTerminalWithCommand = async (label: string, command: string): Promise<boolean> => {
		if (!globalThis.electronAPI?.createTerminal) return false;

		const terminalId = `cli-action-${Date.now()}`;

		// 1. Create PTY in main process first
		const terminalResult = await globalThis.electronAPI.createTerminal({
			id: terminalId,
			cwd: projectPath,
			cols: 80,
			rows: 25,
			projectPath: projectPath,
		});

		if (!terminalResult.success) return false;

		// 2. Add to terminal store so it appears in the grid
		addExternalTerminal(terminalId, label, projectPath, projectPath);

		// 3. Close popover and navigate to the terminals page (force bypasses nav guard)
		setIsOpen(false);
		onNavigateToTerminals?.();

		// 4. Send the command to the PTY (the PTY is already running in main process)
		await delay(500);
		globalThis.electronAPI.sendTerminalInput(terminalId, command);
		return true;
	};

	// Perform install/update.
	//
	// Try the silent path first (`gh copilot install|update` run in the
	// background via IPC). Fall back to opening an internal terminal only if
	// the silent path is unavailable (e.g. gh missing) or fails in a way that
	// requires user interaction.
	const performInstall = async () => {
		setIsInstalling(true);
		setInstallError(null);
		try {
			const silentApi = globalThis.electronAPI?.installCopilotCliSilent;
			if (silentApi) {
				const result = await silentApi();
				if (result.success) {
					await refreshCopilot();
					setTimeout(() => refreshCopilot(), VERSION_RECHECK_DELAY_MS);
					return;
				}
				if (result.error?.startsWith("copilot_pkg_locked:")) {
					// Translatable, actionable variant of the raw EPERM/rename
					// stack trace from gh copilot update. Tells the user what
					// to actually do (close running Copilot sessions) instead
					// of dumping internal Node.js filesystem errors.
					setInstallError(
						t(
							"settings:copilot.updateLocked",
							"Mise à jour bloquée : un processus Copilot CLI utilise actuellement les fichiers à mettre à jour. Fermez les terminaux ou sessions Copilot ouverts, puis réessayez. Si le problème persiste, redémarrez WorkPilot.",
						),
					);
					return;
				}
				if (!result.error?.startsWith("gh_missing")) {
					setInstallError(result.error || "Installation failed");
					return;
				}
			}

			const isUpdate = status === "outdated";
			const label = isUpdate ? "Copilot Update" : "Copilot Install";
			const command = isUpdate ? COPILOT_UPDATE_COMMAND : COPILOT_INSTALL_COMMAND;

			const opened = await openTerminalWithCommand(label, command);
			if (!opened) {
				setInstallError("Failed to open terminal");
				return;
			}

			// Re-check version after installation to update badge color automatically
			setTimeout(() => refreshCopilot(), VERSION_RECHECK_DELAY_MS);
			setTimeout(() => refreshCopilot(), VERSION_RECHECK_DELAY_MS * 3);
		} catch (err) {
			console.error("Failed to install Copilot CLI:", err);
			setInstallError(
				err instanceof Error ? err.message : "Installation failed",
			);
		} finally {
			setIsInstalling(false);
		}
	};

	// Start gh auth login
	const startAuth = async () => {
		try {
			await openTerminalWithCommand("Copilot Auth", "gh auth login\n");
		} catch (err) {
			console.error("Failed to start Copilot auth:", err);
		}
	};

	// Perform CLI path switch
	const performPathSwitch = async () => {
		if (!selectedInstallation) return;

		setIsInstalling(true);
		setShowPathChangeWarning(false);
		setInstallError(null);

		try {
			if (!globalThis.electronAPI?.setCopilotCliActivePath) {
				setInstallError("Path switching not available");
				return;
			}

			const result = 
				await globalThis.electronAPI.setCopilotCliActivePath(
					selectedInstallation,
				);

			if (result.success) {
				setTimeout(() => {
					refreshCopilot();
					fetchInstallations();
				}, VERSION_RECHECK_DELAY_MS);
			} else {
				setInstallError(result.error || "Failed to switch CLI path");
			}
		} catch (err) {
			console.error("Failed to switch Copilot CLI path:", err);
			setInstallError(
				err instanceof Error ? err.message : "Failed to switch CLI path",
			);
		} finally {
			setIsInstalling(false);
			setSelectedInstallation(null);
		}
	};

	// Handle install button click — run silently in the background; no confirmation.
	const handleInstall = () => {
		performInstall();
	};

	// Handle installation selection
	const handleInstallationSelect = (cliPath: string) => {
		const installation = installations.find((i) => i.path === cliPath);
		if (installation?.isActive) return;
		setInstallError(null);
		setSelectedInstallation(cliPath);
		setShowPathChangeWarning(true);
	};

	// Get status indicator color
	const getStatusColor = () => {
		switch (status) {
			case "installed":
				return "bg-green-500";
			case "outdated":
				return "bg-yellow-500";
			case "not-found":
			case "gh-missing":
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
			case "gh-missing":
				return <X className="h-3 w-3" />;
			case "error":
				return <AlertTriangle className="h-3 w-3" />;
		}
	};

	// Get tooltip text
	const getTooltipText = () => {
		switch (status) {
			case "loading":
				return t("settings:copilot.checkingCopilotCli", "Checking Copilot CLI...");
			case "installed":
				return t("settings:copilot.copilotCliUpToDate", "Copilot CLI is up to date");
			case "outdated":
				return t(
					"copilot:copilotCliUpdateAvailable",
					"Copilot CLI update available",
				);
			case "not-found":
				return t(
					"copilot:copilotCliExtensionNotInstalled",
					"Copilot CLI extension not installed",
				);
			case "gh-missing":
				return t(
					"copilot:gitHubCliNotFound",
					"GitHub CLI (gh) not found — required for Copilot",
				);
			case "error":
				return t(
					"copilot:errorCheckingCopilotCli",
					"Error checking Copilot CLI",
				);
		}
	};

	// Get select placeholder text
	const getSelectPlaceholder = () => {
		if (isLoadingInstallations) {
			return t("settings:copilot.loadingInstallations", "Loading installations...");
		}
		if (installationsError) {
			return t(
				"copilot:failedToLoadInstallations",
				"Failed to load installations",
			);
		}
		return t("settings:copilot.selectInstallation", "Select installation");
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className={cn(
								"w-full justify-start gap-2 text-xs",
								status === "not-found" ||
									status === "gh-missing" ||
									status === "error"
									? "text-destructive"
									: "",
								status === "outdated"
									? "text-yellow-600 dark:text-yellow-500"
									: "",
								className,
							)}
						>
							<div className="relative">
								<CopilotIcon className="h-4 w-4" />
								<span
									className={cn(
										"absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full",
										getStatusColor(),
									)}
								/>
							</div>
							<span className="truncate">
								Copilot
								{versionInfo?.installed ? ` (${versionInfo.installed})` : ""}
							</span>
							{status === "outdated" && (
								<span className="ml-auto text-[10px] bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded">
									{t("common:update", "Update")}
								</span>
							)}
							{(status === "not-found" ||
								status === "gh-missing" ||
								status === "error") && (
								<span className="ml-auto text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">
									{status === "gh-missing"
										? "gh missing"
										: t("common:install", "Install")}
								</span>
							)}
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="right">{getTooltipText()}</TooltipContent>
			</Tooltip>

			<PopoverContent side="right" align="end" className="w-72">
				<div className="space-y-3">
					{/* Header */}
					<div className="flex items-center gap-2 justify-between">
						<div className="flex items-center gap-2">
							<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
								<CopilotIcon className="h-4 w-4 text-primary" />
							</div>
							<div>
								<h4 className="text-sm font-medium">Copilot CLI</h4>
								<p className="text-xs text-muted-foreground flex items-center gap-1">
									{getStatusIcon()}
									{status === "installed" &&
										t("settings:copilot.installed", "Installed")}
									{status === "outdated" &&
										t("settings:copilot.updateAvailable", "Update available")}
									{status === "not-found" &&
										t(
											"copilot:extensionNotInstalled",
											"Extension not installed",
										)}
									{status === "gh-missing" &&
										t("settings:copilot.gitHubCliNotFoundShort", "GitHub CLI not found")}
									{status === "loading" && t("settings:copilot.checking", "Checking...")}
									{status === "error" && t("settings:copilot.error", "Error")}
								</p>
							</div>
						</div>
					</div>

					{/* gh-missing notice */}
					{status === "gh-missing" && (
						<div className="text-xs p-2 bg-destructive/10 text-destructive rounded-md">
							<p className="font-medium">Requires GitHub CLI (gh)</p>
							<p className="mt-1 text-muted-foreground">
								Install from{" "}
								<button
									type="button"
									className="underline text-primary"
									onClick={() =>
										globalThis.electronAPI?.openExternal?.(
											"https://cli.github.com",
										)
									}
								>
									cli.github.com
								</button>
							</p>
						</div>
					)}

					{/* Version info */}
					{versionInfo && status !== "loading" && status !== "gh-missing" && (
						<div className="text-xs space-y-1 p-2 bg-muted rounded-md">
							{versionInfo.installed && (
								<div className="flex justify-between">
									<span className="text-muted-foreground">Copilot:</span>
									<span className="font-mono">{versionInfo.installed}</span>
								</div>
							)}
							{versionInfo.ghVersion && (
								<div className="flex justify-between">
									<span className="text-muted-foreground">gh CLI:</span>
									<span className="font-mono">{versionInfo.ghVersion}</span>
								</div>
							)}
							{versionInfo.path && (
								<div className="flex justify-between items-center gap-2">
									<span className="text-muted-foreground flex items-center gap-1">
										<FolderOpen className="h-3 w-3" />
										Path:
									</span>
									<span
										className="font-mono text-[10px] truncate max-w-[140px]"
										title={versionInfo.path}
									>
										{versionInfo.path}
									</span>
								</div>
							)}
							{authStatus && (
								<div className="flex justify-between">
									<span className="text-muted-foreground">Auth:</span>
									<span
										className={
											authStatus.authenticated
												? "text-green-600"
												: "text-destructive"
										}
									>
										{authStatus.authenticated
											? authStatus.username || "Authenticated"
											: "Not authenticated"}
									</span>
								</div>
							)}
							{lastChecked && (
								<div className="flex justify-between text-muted-foreground">
									<span>Last checked:</span>
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
						{authStatus &&
							!authStatus.authenticated &&
							status !== "gh-missing" && (
								<Button
									size="sm"
									variant="outline"
									className="gap-1"
									onClick={startAuth}
								>
									<LogIn className="h-3 w-3" />
									Login
								</Button>
							)}
						<Button
							variant="outline"
							size="sm"
							className="gap-1"
							onClick={() => {
								refreshCopilot();
							}}
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

					{/* Install error display */}
					{installError && (
						<div className="text-xs p-2 bg-destructive/10 text-destructive rounded-md flex items-center gap-2">
							<AlertTriangle className="h-3 w-3 shrink-0" />
							<span>{installError}</span>
						</div>
					)}

					{/* CLI Installation selector - show when multiple installations are found */}
					{installations.length > 1 && (
						<div className="space-y-1.5">
							<div className="text-xs text-muted-foreground">
								{t("settings:copilot.switchInstallation", "Switch Installation")}
							</div>
							<Select
								value={selectedInstallation || ""}
								onValueChange={handleInstallationSelect}
								disabled={isLoadingInstallations || isInstalling}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue placeholder={getSelectPlaceholder()} />
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
													{installation.path
														.split(/[/\\]/)
														.slice(-2)
														.join("/") || installation.path}
												</span>
												<span className="text-muted-foreground text-[9px]">
													{installation.version
														? `copilot v${installation.version}`
														: t("settings:copilot.versionUnknown", "version unknown")}
													{installation.ghVersion
														? ` (gh ${installation.ghVersion})`
														: ""}{" "}
													({installation.source})
													{installation.isActive &&
														` - ${t("settings:copilot.active", "Active")}`}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Docs link */}
					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() =>
							globalThis.electronAPI?.openExternal?.(
								"https://docs.github.com/en/copilot/github-copilot-in-the-cli",
							)
						}
					>
						{t("settings:copilot.viewCopilotCliDocs", "View Copilot CLI Docs")}
						<ExternalLink className="h-3 w-3" />
					</Button>
				</div>
			</PopoverContent>

			{/* Path change warning dialog */}
			<AlertDialog
				open={showPathChangeWarning}
				onOpenChange={setShowPathChangeWarning}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("settings:copilot.switchGhCliInstallation")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:copilot.switchDescription")}{" "}
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
							{t("settings:copilot.switch", "Switch")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Popover>
	);
}
