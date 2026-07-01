import type { TFunction } from "i18next";
import {
	AlertCircle,
	CheckCircle2,
	Eye,
	EyeOff,
	Import,
	Loader2,
	Radio,
	RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AzureDevOpsRepository,
	AzureDevOpsSyncStatus,
	ProjectEnvConfig,
} from "../../../../shared/types";
import { cn } from "../../../lib/utils";
import { GUIDE_ANCHORS } from "../../guided-tour/anchors";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";

interface AzureDevOpsIntegrationProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
	readonly showAzureDevOpsPat: boolean;
	readonly setShowAzureDevOpsPat: React.Dispatch<React.SetStateAction<boolean>>;
	readonly azureDevOpsConnectionStatus: AzureDevOpsSyncStatus | null;
	readonly isCheckingAzureDevOps: boolean;
	readonly onOpenAzureDevOpsImport: () => void;
	readonly projectId: string;
}

interface RepositorySelectProps {
	readonly projectId: string;
	readonly value: string | undefined;
	readonly onChange: (value: string) => void;
	readonly disabled?: boolean;
	readonly t: TFunction;
}

function RepositorySelect({
	projectId,
	value,
	onChange,
	disabled,
	t,
}: RepositorySelectProps) {
	const [repositories, setRepositories] = useState<AzureDevOpsRepository[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchRepositories = async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result =
				await globalThis.electronAPI.listAzureDevOpsRepositories(projectId);
			if (result.success && result.data) {
				setRepositories(result.data);
			} else {
				setError(result.error || t("azureDevOps.repositoryError"));
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("azureDevOps.repositoryError"),
			);
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		fetchRepositories();
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [fetchRepositories]);

	// Auto-detect and select repository on first load
	useEffect(() => {
		const autoDetectRepository = async () => {
			if (value) {
				return;
			}

			const result =
				await globalThis.electronAPI.detectAzureDevOpsRepository(projectId);

			if (result.success && result.data?.repository) {
				onChange(result.data.repository);
			}
		};

		autoDetectRepository();
	}, [projectId, value, onChange]);

	if (error) {
		return (
			<div className="space-y-2">
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
					<p className="text-xs text-destructive">{error}</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={fetchRepositories}
					disabled={isLoading}
					className="gap-2"
				>
					<RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
					{t("azureDevOps.repositoryRefresh")}
				</Button>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				{t("azureDevOps.repositoryLoading")}
			</div>
		);
	}

	return (
		<Select value={value || ""} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger>
				<SelectValue placeholder={t("azureDevOps.repositoryPlaceholder")} />
			</SelectTrigger>
			<SelectContent>
				{repositories.map((repo) => (
					<SelectItem key={repo.id} value={repo.name}>
						{repo.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Azure DevOps integration settings component.
 * Manages Azure DevOps PAT, organization URL, repository configuration,
 * connection status, and import functionality.
 */
export function AzureDevOpsIntegration({
	envConfig,
	updateEnvConfig,
	showAzureDevOpsPat,
	setShowAzureDevOpsPat,
	azureDevOpsConnectionStatus,
	isCheckingAzureDevOps,
	onOpenAzureDevOpsImport,
	projectId,
}: AzureDevOpsIntegrationProps) {
	const { t } = useTranslation("settings");

	if (!envConfig) return null;

	// Helper function to extract organization from Azure DevOps URL
	const getOrganizationFromUrl = (url: string): string | null => {
		if (!url) return null;

		try {
			const urlObj = new URL(url);
			const hostname = urlObj.hostname;

			// Handle different Azure DevOps URL formats
			if (hostname === "dev.azure.com") {
				// Format: https://dev.azure.com/organization/
				const pathParts = urlObj.pathname.split("/");
				return pathParts.find((part, index) => index === 1 && part) || null;
			} else if (hostname.endsWith(".visualstudio.com")) {
				// Format: https://organization.visualstudio.com/
				return hostname.replace(".visualstudio.com", "");
			}
		} catch (error) {
			console.error("Invalid Azure DevOps URL:", error);
		}

		return null;
	};

	// Generate the correct PAT link with organization
	const patLink = (() => {
		const organization = getOrganizationFromUrl(
			envConfig.azureDevOpsOrgUrl || "",
		);
		if (organization) {
			return `https://dev.azure.com/${organization}/_usersSettings/tokens`;
		}
		return "https://dev.azure.com/_usersettings/tokens";
	})();

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label className="font-normal text-foreground">
						{t("azureDevOps.enableSyncLabel")}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t("azureDevOps.enableSyncDescription")}
					</p>
				</div>
				<Switch
					data-guide={GUIDE_ANCHORS.azureDevOps.enable}
					checked={envConfig.azureDevOpsEnabled}
					onCheckedChange={(checked) =>
						updateEnvConfig({ azureDevOpsEnabled: checked })
					}
				/>
			</div>

			{envConfig.azureDevOpsEnabled && (
				<>
					{/* Organization URL */}
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("azureDevOps.orgUrlLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("azureDevOps.orgUrlDescription")}
						</p>
						<Input
							data-guide={GUIDE_ANCHORS.azureDevOps.orgUrl}
							type="url"
							placeholder={t("azureDevOps.orgUrlPlaceholder")}
							value={envConfig.azureDevOpsOrgUrl || ""}
							onChange={(e) =>
								updateEnvConfig({ azureDevOpsOrgUrl: e.target.value })
							}
						/>
					</div>

					{/* Personal Access Token */}
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("azureDevOps.patLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("azureDevOps.patDescriptionPrefix")}{" "}
							<a
								href={patLink}
								target="_blank"
								rel="noopener noreferrer"
								className="text-info hover:underline"
							>
								{t("azureDevOps.patLinkLabel")}
							</a>
							. {t("azureDevOps.patDescriptionSuffix")}
						</p>
						<div className="relative">
							<Input
								data-guide={GUIDE_ANCHORS.azureDevOps.pat}
								type={showAzureDevOpsPat ? "text" : "password"}
								placeholder={t("azureDevOps.patPlaceholder")}
								value={envConfig.azureDevOpsPat || ""}
								onChange={(e) =>
									updateEnvConfig({ azureDevOpsPat: e.target.value })
								}
								className={cn(
									"pr-20",
									isCheckingAzureDevOps && "border-primary/50 bg-primary/5",
								)}
							/>
							<div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
								{isCheckingAzureDevOps && (
									<Loader2 className="h-4 w-4 animate-spin text-primary" />
								)}
								{!isCheckingAzureDevOps &&
									azureDevOpsConnectionStatus?.connected && (
										<CheckCircle2 className="h-4 w-4 text-success" />
									)}
								{!isCheckingAzureDevOps &&
									(azureDevOpsConnectionStatus?.connected === false ||
										!azureDevOpsConnectionStatus) && (
										<AlertCircle className="h-4 w-4 text-destructive" />
									)}
								<button
									type="button"
									onClick={() => setShowAzureDevOpsPat(!showAzureDevOpsPat)}
									className="text-muted-foreground hover:text-foreground"
								>
									{showAzureDevOpsPat ? (
										<EyeOff className="h-4 w-4" />
									) : (
										<Eye className="h-4 w-4" />
									)}
								</button>
							</div>
						</div>
					</div>

					{/* Repository */}
					<div
						className="space-y-2"
						data-guide={GUIDE_ANCHORS.azureDevOps.repository}
					>
						<Label className="text-sm font-medium text-foreground">
							{t("azureDevOps.repositoryLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("azureDevOps.repositoryDescription")}
						</p>
						<RepositorySelect
							projectId={projectId}
							value={envConfig.azureDevOpsRepository}
							onChange={(value) =>
								updateEnvConfig({ azureDevOpsRepository: value })
							}
							t={t}
						/>
					</div>

					{/* Connection Status */}
					{envConfig.azureDevOpsPat && envConfig.azureDevOpsOrgUrl && (
						<ConnectionStatus
							isChecking={isCheckingAzureDevOps}
							connectionStatus={azureDevOpsConnectionStatus}
							t={t}
						/>
					)}

					{/* Import Prompt */}
					{azureDevOpsConnectionStatus?.connected && (
						<ImportTasksPrompt
							onOpenAzureDevOpsImport={onOpenAzureDevOpsImport}
							t={t}
						/>
					)}

					<Separator />

					{/* Auto-Sync Toggle */}
					<AutoSyncToggle
						enabled={envConfig.azureDevOpsAutoSync || false}
						onToggle={(checked) =>
							updateEnvConfig({ azureDevOpsAutoSync: checked })
						}
						t={t}
					/>

					{envConfig.azureDevOpsAutoSync && <AutoSyncInfo t={t} />}
				</>
			)}
		</div>
	);
}

interface ConnectionStatusProps {
	readonly isChecking: boolean;
	readonly connectionStatus: AzureDevOpsSyncStatus | null;
	readonly t: TFunction;
}

function ConnectionStatus({
	isChecking,
	connectionStatus,
	t,
}: ConnectionStatusProps) {
	let statusText: string;

	if (isChecking) {
		statusText = t("azureDevOps.connectionChecking");
	} else if (connectionStatus?.connected) {
		if (connectionStatus.projectName) {
			statusText = t("azureDevOps.connectionConnectedProject", {
				projectName: connectionStatus.projectName,
			});
		} else {
			statusText = t("azureDevOps.connectionConnected");
		}
	} else {
		statusText =
			connectionStatus?.error || t("azureDevOps.connectionNotConnected");
	}

	let statusIcon: React.ReactNode;

	if (isChecking) {
		statusIcon = (
			<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
		);
	} else if (connectionStatus?.connected) {
		statusIcon = <CheckCircle2 className="h-4 w-4 text-success" />;
	} else {
		statusIcon = <AlertCircle className="h-4 w-4 text-warning" />;
	}

	return (
		<div className="rounded-lg border border-border bg-muted/30 p-3">
			<div className="flex items-center justify-between">
				<div>
					<p className="text-sm font-medium text-foreground">
						{t("azureDevOps.connectionStatusTitle")}
					</p>
					<p className="text-xs text-muted-foreground">{statusText}</p>
					{connectionStatus?.connected &&
						connectionStatus.workItemCount !== undefined && (
							<p className="text-xs text-muted-foreground mt-1">
								{t("azureDevOps.connectionWorkItemCount", {
									count: connectionStatus.workItemCount,
								})}
							</p>
						)}
				</div>
				{statusIcon}
			</div>
		</div>
	);
}

interface ImportTasksPromptProps {
	readonly onOpenAzureDevOpsImport: () => void;
	readonly t: TFunction;
}

function ImportTasksPrompt({
	onOpenAzureDevOpsImport,
	t,
}: ImportTasksPromptProps) {
	return (
		<div className="rounded-lg border border-info/30 bg-info/5 p-4">
			<div className="flex items-start gap-3">
				<Radio className="h-4 w-4 text-info mt-1 shrink-0" />
				<div className="flex-1">
					<p className="text-sm font-medium text-foreground mb-2">
						{t("azureDevOps.importPromptTitle")}
					</p>
					<p className="text-xs text-muted-foreground mb-3">
						{t("azureDevOps.importPromptDescription")}
					</p>
					<Button
						size="sm"
						variant="default"
						onClick={onOpenAzureDevOpsImport}
						className="gap-2"
					>
						<Import className="h-4 w-4" />
						{t("azureDevOps.importPromptButton")}
					</Button>
				</div>
			</div>
		</div>
	);
}

interface AutoSyncToggleProps {
	readonly enabled: boolean;
	readonly onToggle: (checked: boolean) => void;
	readonly t: TFunction;
}

function AutoSyncToggle({ enabled, onToggle, t }: AutoSyncToggleProps) {
	return (
		<div className="flex items-center justify-between">
			<div className="space-y-0.5">
				<Label className="font-normal text-foreground">
					{t("azureDevOps.autoSyncLabel")}
				</Label>
				<p className="text-xs text-muted-foreground">
					{t("azureDevOps.autoSyncDescription")}
				</p>
			</div>
			<Switch checked={enabled} onCheckedChange={onToggle} />
		</div>
	);
}

interface AutoSyncInfoProps {
	readonly t: TFunction;
}

function AutoSyncInfo({ t }: AutoSyncInfoProps) {
	return (
		<div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
			<p className="text-xs text-muted-foreground">
				<strong className="text-warning">
					{t("azureDevOps.autoSyncNoteLabel")}
				</strong>{" "}
				{t("azureDevOps.autoSyncNoteDescription")}
			</p>
		</div>
	);
}
