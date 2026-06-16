import {
	AlertTriangle,
	Check,
	Download,
	ExternalLink,
	Loader2,
	RefreshCw,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCliStatus } from "@/contexts/CliStatusContext";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface CodexCliStatusBadgeProps {
	readonly className?: string;
	readonly onNavigateToTerminals?: () => void;
	// Mode replié de la sidebar : affiche uniquement l'icône pour éviter le débordement
	readonly isCollapsed?: boolean;
}

interface CodexIconProps {
	readonly className?: string;
}

// biome-ignore lint/correctness/noUnusedVariables: variable kept for clarity
type StatusType = "loading" | "installed" | "outdated" | "not-found" | "error";

const _CHECK_INTERVAL_MS = 60 * 1000; // Re-check every 60s

/**
 * OpenAI Codex icon (simplified)
 */
function CodexIcon({ className }: CodexIconProps) {
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
				<path d="M12 2L2 7l10 5 10-5-10-5z" />
				<path d="M2 17l10 5 10-5" />
				<path d="M2 12l10 5 10-5" />
			</svg>
		</>
	);
}

/**
 * Codex CLI status badge for the sidebar.
 * Shows authentication status by checking ~/.codex/auth.json via IPC.
 */
export function CodexCliStatusBadge({
	className,
	onNavigateToTerminals: _onNavigateToTerminals,
	isCollapsed = false,
}: CodexCliStatusBadgeProps) {
	const { t } = useTranslation(["common", "navigation"]);
	const { data, refreshCodex } = useCliStatus();
	const { codex } = data;

	const [isOpen, setIsOpen] = useState(false);
	const [isUpdating, setIsUpdating] = useState(false);
	const [updateError, setUpdateError] = useState<string | null>(null);

	// Use data from context
	const status = codex.status;
	const versionInfo = codex.versionInfo;
	const lastChecked = codex.lastChecked;

	const handleRefresh = () => {
		refreshCodex();
	};

	// Run `npm install -g @openai/codex@latest` silently in the main process.
	// No terminal opened, no navigation — just a spinner on the button until npm returns.
	const performUpdate = async () => {
		setIsUpdating(true);
		setUpdateError(null);
		try {
			if (!globalThis.electronAPI?.updateCodexCli) {
				setUpdateError("Update not available");
				return;
			}

			const result = await globalThis.electronAPI.updateCodexCli();
			if (!result.success) {
				setUpdateError(result.error || "Update failed");
				return;
			}

			await refreshCodex();
			// Belt-and-suspenders: on Windows, the freshly-written `codex.cmd` can take
			// a moment to be visible to `execFile`. Refresh a second time after a short
			// delay so the sidebar picks up the new version reliably.
			setTimeout(() => refreshCodex(), 2000);
		} catch (err) {
			console.error("Failed to update Codex CLI:", err);
			setUpdateError(err instanceof Error ? err.message : "Update failed");
		} finally {
			setIsUpdating(false);
		}
	};

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

	const getStatusIcon = () => {
		switch (status) {
			case "installed":
				return <Check className="h-3 w-3" />;
			case "outdated":
				return <AlertTriangle className="h-3 w-3" />;
			case "not-found":
				return <X className="h-3 w-3" />;
			case "error":
				return <AlertTriangle className="h-3 w-3" />;
			default:
				return <Loader2 className="h-3 w-3 animate-spin" />;
		}
	};

	const getTooltipText = () => {
		switch (status) {
			case "loading":
				return t("navigation:codex.checking", "Checking Codex CLI...");
			case "installed":
				return versionInfo?.installed
					? t("navigation:codex.installedWithVersion", "Codex CLI ({{version}})", {
							version: versionInfo.installed,
						})
					: t("navigation:codex.installed", "Codex CLI installed");
			case "outdated":
				return t(
					"navigation:codex.updateAvailableWithVersion",
					"Codex CLI ({{version}}) - update available",
					{ version: versionInfo?.installed || "" },
				);
			case "not-found":
				return t("navigation:codex.notFound", "Codex CLI not found");
			case "error":
				return t("navigation:codex.error", "Codex CLI error");
			default:
				return "Codex CLI";
		}
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
								<CodexIcon className="h-4 w-4" />
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
										Codex
										{versionInfo?.installed
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

			<PopoverContent side="right" align="end" className="w-64">
				<div className="space-y-3">
					{/* Header */}
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
							<CodexIcon className="h-4 w-4 text-primary" />
						</div>
						<div>
							<h4 className="text-sm font-medium">OpenAI Codex CLI</h4>
							<p className="text-xs text-muted-foreground flex items-center gap-1">
								{getStatusIcon()}
								{status === "installed" &&
									t("navigation:codex.installedShort", "Installed")}
								{status === "outdated" &&
									t("navigation:codex.updateAvailableShort", "Update available")}
								{status === "not-found" &&
									t("navigation:codex.notInstalledShort", "Not installed")}
								{status === "loading" &&
									t("navigation:codex.checkingShort", "Checking...")}
								{status === "error" && t("common:error", "Error")}
							</p>
						</div>
					</div>

					{/* Version info */}
					{versionInfo &&
						(status === "installed" || status === "outdated") && (
							<div className="text-xs space-y-1 p-2 bg-muted rounded-md">
								{versionInfo.installed && (
									<div className="flex justify-between">
										<span className="text-muted-foreground">
											{t("navigation:codex.current", "Current")}:
										</span>
										<span className="font-mono">{versionInfo.installed}</span>
									</div>
								)}
								{versionInfo.latest && (
									<div className="flex justify-between">
										<span className="text-muted-foreground">
											{t("navigation:codex.latest", "Latest")}:
										</span>
										<span className="font-mono">{versionInfo.latest}</span>
									</div>
								)}
								{lastChecked && (
									<div className="flex justify-between text-muted-foreground">
										<span>
											{t("navigation:codex.lastChecked", "Last checked")}:
										</span>
										<span>{lastChecked.toLocaleTimeString()}</span>
									</div>
								)}
							</div>
						)}

					{/* Not installed notice */}
					{(status === "not-found" || status === "error") && (
						<div className="text-xs p-2 bg-muted/50 rounded-md text-muted-foreground">
							<p>
								{t(
									"navigation:codex.notInstalledDescription",
									"Codex CLI is not installed. Click \"Install\" to install it via pnpm in the background:",
								)}
							</p>
							<p className="mt-1 font-mono bg-muted px-1 rounded break-all">
								pnpm install -g @openai/codex@latest
							</p>
						</div>
					)}

					{isUpdating && (
						<div className="text-xs p-2 bg-muted/50 rounded-md text-muted-foreground flex items-center gap-2">
							<Loader2 className="h-3 w-3 animate-spin shrink-0" />
							<span>
								{t("navigation:codex.installing", "Installing, please wait...")}
							</span>
						</div>
					)}

					{/* Actions */}
					<div className="flex gap-2">
						{(status === "installed" ||
							status === "outdated" ||
							status === "not-found" ||
							status === "error") && (
							<Button
								size="sm"
								className="flex-1 gap-1"
								onClick={performUpdate}
								disabled={isUpdating}
							>
								{isUpdating ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : (
									<Download className="h-3 w-3" />
								)}
								{status === "not-found"
									? t("common:install", "Install")
									: t("common:update", "Update")}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							className="gap-1"
							onClick={() => {
								handleRefresh();
							}}
							disabled={status === "loading" || isUpdating}
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

					{updateError && (
						<div className="text-xs p-2 bg-destructive/10 text-destructive rounded-md flex items-center gap-2">
							<AlertTriangle className="h-3 w-3 shrink-0" />
							<span>{updateError}</span>
						</div>
					)}

					{/* Docs link */}
					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() =>
							globalThis.electronAPI?.openExternal?.(
								"https://github.com/openai/codex",
							)
						}
					>
						{t("navigation:codex.viewDocs", "View Codex CLI documentation")}
						<ExternalLink className="h-3 w-3" />
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
