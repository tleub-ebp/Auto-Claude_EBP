import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	GitBranch,
	Globe,
	KeyRound,
	Loader2,
	Lock,
	RefreshCw,
	User,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	GitBranchDetail,
	GitHubSyncStatus,
	ProjectEnvConfig,
	ProjectSettings,
} from "../../../../shared/types";
import { buildBranchOptions } from "../../../lib/branch-utils";
import { GUIDE_ANCHORS } from "../../guided-tour/anchors";
import { GitHubOAuthFlow } from "../../project-settings/GitHubOAuthFlow";
import { PasswordInput } from "../../project-settings/PasswordInput";
import { Button } from "../../ui/button";
import { Combobox } from "../../ui/combobox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";

// Debug logging — disabled (kept as a no-op so call sites stay valid).
function debugLog(_message: string, _data?: unknown) {}

interface GitHubRepo {
	fullName: string;
	description: string | null;
	isPrivate: boolean;
}

interface GitHubIntegrationProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
	readonly showGitHubToken: boolean;
	readonly setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
	readonly gitHubConnectionStatus: GitHubSyncStatus | null;
	readonly isCheckingGitHub: boolean;
	readonly projectPath?: string; // Project path for fetching git branches
	// Project settings for mainBranch (used by kanban tasks and terminal worktrees)
	readonly settings?: ProjectSettings;
	readonly setSettings?: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

/**
 * GitHub integration settings component.
 * Manages GitHub token (manual or OAuth), repository configuration, and connection status.
 */
export function GitHubIntegration({
	envConfig,
	updateEnvConfig,
	showGitHubToken: _showGitHubToken,
	setShowGitHubToken: _setShowGitHubToken,
	gitHubConnectionStatus,
	isCheckingGitHub,
	projectPath,
	settings,
	setSettings,
}: GitHubIntegrationProps) {
	const { t } = useTranslation(["settings", "common"]);
	const [authMode, setAuthMode] = useState<
		"manual" | "oauth" | "oauth-success"
	>("manual");
	const [oauthUsername, setOauthUsername] = useState<string | null>(null);
	const [repos, setRepos] = useState<GitHubRepo[]>([]);
	const [isLoadingRepos, setIsLoadingRepos] = useState(false);
	const [reposError, setReposError] = useState<string | null>(null);

	// Branch selection state - now uses GitBranchDetail for local/remote distinction
	const [branches, setBranches] = useState<GitBranchDetail[]>([]);
	const [isLoadingBranches, setIsLoadingBranches] = useState(false);
	const [branchesError, setBranchesError] = useState<string | null>(null);

	debugLog("Render - authMode:", authMode);
	debugLog("Render - projectPath:", projectPath);
	debugLog(
		"Render - envConfig:",
		envConfig
			? {
					githubEnabled: envConfig.githubEnabled,
					hasToken: !!envConfig.githubToken,
					defaultBranch: envConfig.defaultBranch,
				}
			: null,
	);

	// Fetch repos when entering oauth-success mode
	// eslint-disable-next-line react-hooks/exhaustive-deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	useEffect(() => {
		if (authMode === "oauth-success") {
			fetchUserRepos();
		}
	}, [authMode]);

	// Fetch branches when GitHub is enabled and project path is available
	// eslint-disable-next-line react-hooks/exhaustive-deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	useEffect(() => {
		debugLog(
			`useEffect[branches] - githubEnabled: ${envConfig?.githubEnabled}, projectPath: ${projectPath}`,
		);
		if (envConfig?.githubEnabled && projectPath) {
			debugLog("useEffect[branches] - Triggering fetchBranches");
			fetchBranches();
		} else {
			debugLog(
				"useEffect[branches] - Skipping fetchBranches (conditions not met)",
			);
		}
	}, [envConfig?.githubEnabled, projectPath]);

	/**
	 * Handler for branch selection changes.
	 * Updates BOTH project.settings.mainBranch (for Electron app) and envConfig.defaultBranch (for CLI backward compatibility).
	 */
	const handleBranchChange = (branch: string) => {
		debugLog("handleBranchChange: Updating branch to:", branch);

		// Update project settings (primary source for Electron app)
		if (setSettings) {
			setSettings((prev) => ({ ...prev, mainBranch: branch }));
			debugLog("handleBranchChange: Updated settings.mainBranch");
		}

		// Also update envConfig for CLI backward compatibility
		updateEnvConfig({ defaultBranch: branch });
		debugLog("handleBranchChange: Updated envConfig.defaultBranch");
	};

	const fetchBranches = async () => {
		if (!projectPath) {
			debugLog("fetchBranches: No projectPath, skipping");
			return;
		}

		debugLog("fetchBranches: Starting with projectPath:", projectPath);
		setIsLoadingBranches(true);
		setBranchesError(null);

		try {
			debugLog("fetchBranches: Calling getGitBranchesWithInfo...");
			const result =
				await globalThis.electronAPI.getGitBranchesWithInfo(projectPath);
			debugLog("fetchBranches: getGitBranchesWithInfo result:", {
				success: result.success,
				dataType: typeof result.data,
				dataLength: Array.isArray(result.data) ? result.data.length : "N/A",
				error: result.error,
			});

			// result.data is the GitBranchDetail[] array
			if (result.success && result.data) {
				setBranches(result.data);
				debugLog("fetchBranches: Loaded branches:", result.data.length);

				// Auto-detect default branch if not set in project settings
				// Priority: settings.mainBranch > envConfig.defaultBranch > auto-detect
				if (!settings?.mainBranch && !envConfig?.defaultBranch) {
					debugLog("fetchBranches: No branch set, auto-detecting...");
					const detectResult =
						await globalThis.electronAPI.detectMainBranch(projectPath);
					debugLog("fetchBranches: detectMainBranch result:", detectResult);
					if (detectResult.success && detectResult.data) {
						debugLog(
							"fetchBranches: Auto-detected default branch:",
							detectResult.data,
						);
						handleBranchChange(detectResult.data);
					}
				}
			} else {
				debugLog("fetchBranches: Failed -", result.error || "No data returned");
				setBranchesError(result.error || t("projectSections.github.failedToLoadBranches"));
			}
		} catch (err) {
			debugLog("fetchBranches: Exception:", err);
			setBranchesError(
				err instanceof Error ? err.message : t("projectSections.github.failedToLoadBranches"),
			);
		} finally {
			setIsLoadingBranches(false);
		}
	};

	const fetchUserRepos = async () => {
		debugLog("Fetching user repositories...");
		setIsLoadingRepos(true);
		setReposError(null);

		try {
			const result = await globalThis.electronAPI.listGitHubUserRepos();
			debugLog("listGitHubUserRepos result:", result);

			if (result.success && result.data?.repos) {
				setRepos(result.data.repos);
				debugLog("Loaded repos:", result.data.repos.length);
			} else {
				setReposError(result.error || t("projectSections.github.failedToLoadRepositories"));
			}
		} catch (err) {
			debugLog("Error fetching repos:", err);
			setReposError(
				err instanceof Error ? err.message : t("projectSections.github.failedToLoadRepositories"),
			);
		} finally {
			setIsLoadingRepos(false);
		}
	};

	// Build branch options for Combobox using shared utility
	// Must be called before early return to satisfy React hooks rules
	const branchOptions = useMemo(() => {
		return buildBranchOptions(branches, {
			t,
			includeAutoDetect: {
				value: "",
				label: t("settings:integrations.github.defaultBranch.autoDetect"),
			},
		});
	}, [branches, t]);

	if (!envConfig) {
		debugLog("No envConfig, returning null");
		return null;
	}

	const handleOAuthSuccess = (token: string, username?: string) => {
		debugLog("handleOAuthSuccess called with token length:", token.length);
		debugLog("OAuth username:", username);

		// Update the token and auth method
		updateEnvConfig({ githubToken: token, githubAuthMethod: "oauth" });

		// Show success state with username
		setOauthUsername(username || null);
		setAuthMode("oauth-success");
	};

	const handleSwitchToManual = () => {
		setAuthMode("manual");
		setOauthUsername(null);
	};

	const handleSwitchToOAuth = () => {
		setAuthMode("oauth");
	};

	const handleSelectRepo = (repoFullName: string) => {
		debugLog("Selected repo:", repoFullName);
		updateEnvConfig({ githubRepo: repoFullName });
	};

	// Selected branch for Combobox value
	const selectedBranch = settings?.mainBranch || envConfig?.defaultBranch || "";

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label className="font-normal text-foreground">
						{t("projectSections.github.enableGitHubIssues", { ns: "settings" })}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t(
							"projectSections.github.syncIssuesFromGitHubAndCreateTasksAutomatically",
							{ ns: "settings" },
						)}
					</p>
				</div>
				<Switch
					data-guide={GUIDE_ANCHORS.github.enable}
					checked={envConfig.githubEnabled}
					onCheckedChange={(checked) =>
						updateEnvConfig({ githubEnabled: checked })
					}
				/>
			</div>

			{envConfig.githubEnabled && (
				<>
					{/* OAuth Success State */}
					{authMode === "oauth-success" && (
						<div className="space-y-4">
							<div className="rounded-lg border border-success/30 bg-success/10 p-4">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3">
										<CheckCircle2 className="h-5 w-5 text-success" />
										<div>
											<p className="text-sm font-medium text-success">
												{t("projectSections.github.connectedViaCLI", {
													ns: "settings",
												})}
											</p>
											{oauthUsername && (
												<p className="text-xs text-success/80 flex items-center gap-1 mt-0.5">
													<User className="h-3 w-3" />
													{t("projectSections.github.authenticatedAs", {
														ns: "settings",
														username: oauthUsername,
													})}
												</p>
											)}
										</div>
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={handleSwitchToManual}
										className="text-xs"
									>
										{t("projectSections.github.useDifferentToken", {
											ns: "settings",
										})}
									</Button>
								</div>
							</div>

							{/* Repository Dropdown */}
							<RepositoryDropdown
								repos={repos}
								selectedRepo={envConfig.githubRepo || ""}
								isLoading={isLoadingRepos}
								error={reposError}
								onSelect={handleSelectRepo}
								onRefresh={fetchUserRepos}
								onManualEntry={() => setAuthMode("manual")}
							/>
						</div>
					)}

					{/* OAuth Flow */}
					{authMode === "oauth" && (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<Label className="text-sm font-medium text-foreground">
									{t("projectSections.github.githubAuthentication")}
								</Label>
								<Button
									variant="ghost"
									size="sm"
									onClick={handleSwitchToManual}
								>
									{t("projectSections.github.useManualToken")}
								</Button>
							</div>
							<GitHubOAuthFlow
								onSuccess={handleOAuthSuccess}
								onCancel={handleSwitchToManual}
							/>
						</div>
					)}

					{/* Manual Token Entry */}
					{authMode === "manual" && (
						<>
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label className="text-sm font-medium text-foreground">
										{t("projectSections.github.patLabel")}
									</Label>
									<Button
										variant="outline"
										size="sm"
										onClick={handleSwitchToOAuth}
										className="gap-2"
									>
										<KeyRound className="h-3 w-3" />
										{t("projectSections.github.useOAuthInstead")}
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.github.patHelpBefore")}{" "}
									<code className="px-1 bg-muted rounded">repo</code>{" "}
									{t("projectSections.github.patHelpAfter")}{" "}
									<a
										href="https://github.com/settings/tokens/new?scopes=repo&description=Auto-Build-UI"
										target="_blank"
										rel="noopener noreferrer"
										className="text-info hover:underline"
									>
										{t("projectSections.github.githubSettingsLink")}
									</a>
								</p>
								<PasswordInput
									data-guide={GUIDE_ANCHORS.github.token}
									value={envConfig.githubToken || ""}
									onChange={(value) => updateEnvConfig({ githubToken: value })}
									placeholder="ghp_xxxxxxxx or github_pat_xxxxxxxx"
								/>
							</div>

							<RepositoryInput
								value={envConfig.githubRepo || ""}
								onChange={(value) => updateEnvConfig({ githubRepo: value })}
							/>
						</>
					)}

					{envConfig.githubToken && envConfig.githubRepo && (
						<ConnectionStatus
							isChecking={isCheckingGitHub}
							connectionStatus={gitHubConnectionStatus}
						/>
					)}

					{gitHubConnectionStatus?.connected && <IssuesAvailableInfo />}

					<Separator />

					{/* Default Branch Selector */}
					{projectPath && (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<div className="flex items-center gap-2">
										<GitBranch className="h-4 w-4 text-info" />
										<Label className="text-sm font-medium text-foreground">
											{t("settings:integrations.github.defaultBranch.label")}
										</Label>
									</div>
									<p className="text-xs text-muted-foreground pl-6">
										{t(
											"settings:integrations.github.defaultBranch.description",
										)}
									</p>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={fetchBranches}
									disabled={isLoadingBranches}
									className="h-7 px-2"
								>
									<RefreshCw
										className={`h-3 w-3 ${isLoadingBranches ? "animate-spin" : ""}`}
									/>
								</Button>
							</div>

							{branchesError && (
								<div className="flex items-center gap-2 text-xs text-destructive pl-6">
									<AlertCircle className="h-3 w-3" />
									{branchesError}
								</div>
							)}

							<div className="pl-6">
								<Combobox
									options={branchOptions}
									value={selectedBranch}
									onValueChange={handleBranchChange}
									placeholder={t(
										"settings:integrations.github.defaultBranch.autoDetect",
									)}
									searchPlaceholder={t(
										"settings:integrations.github.defaultBranch.searchPlaceholder",
									)}
									emptyMessage={t(
										"settings:integrations.github.defaultBranch.noBranchesFound",
									)}
									disabled={isLoadingBranches}
									className="w-full"
								/>
							</div>

							{selectedBranch && (
								<p className="text-xs text-muted-foreground pl-6">
									{t(
										"settings:integrations.github.defaultBranch.selectedBranchHelp",
										{ branch: selectedBranch },
									)}
								</p>
							)}
						</div>
					)}

					<Separator />

					<AutoSyncToggle
						enabled={envConfig.githubAutoSync || false}
						onToggle={(checked) => updateEnvConfig({ githubAutoSync: checked })}
					/>
				</>
			)}
		</div>
	);
}

interface RepositoryDropdownProps {
	readonly repos: GitHubRepo[];
	readonly selectedRepo: string;
	readonly isLoading: boolean;
	readonly error: string | null;
	readonly onSelect: (repoFullName: string) => void;
	readonly onRefresh: () => void;
	readonly onManualEntry: () => void;
}

function RepositoryDropdown({
	repos,
	selectedRepo,
	isLoading,
	error,
	onSelect,
	onRefresh,
	onManualEntry,
}: RepositoryDropdownProps) {
	const { t } = useTranslation("settings");
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");

	const filteredRepos = repos.filter(
		(repo) =>
			repo.fullName.toLowerCase().includes(filter.toLowerCase()) ||
			repo.description?.toLowerCase().includes(filter.toLowerCase()),
	);

	const selectedRepoData = repos.find((r) => r.fullName === selectedRepo);

	// Extract the repo icon logic to avoid nested ternary
	const repoIcon = selectedRepoData?.isPrivate ? (
		<Lock className="h-3 w-3 text-muted-foreground" />
	) : (
		<Globe className="h-3 w-3 text-muted-foreground" />
	);

	// Extract the button content logic to improve readability
	let buttonContent: React.ReactNode;

	if (isLoading) {
		buttonContent = (
			<span className="flex items-center gap-2 text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				{t("projectSections.github.loadingRepositories")}
			</span>
		);
	} else if (selectedRepo) {
		buttonContent = (
			<span className="flex items-center gap-2">
				{repoIcon}
				{selectedRepo}
			</span>
		);
	} else {
		buttonContent = (
			<span className="text-muted-foreground">
				{t("projectSections.github.selectRepository")}
			</span>
		);
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="text-sm font-medium text-foreground">
					{t("projectSections.github.repository")}
				</Label>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={onRefresh}
						disabled={isLoading}
						className="h-7 px-2"
					>
						<RefreshCw
							className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`}
						/>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onManualEntry}
						className="h-7 text-xs"
					>
						{t("projectSections.github.enterManually")}
					</Button>
				</div>
			</div>

			{error && (
				<div className="flex items-center gap-2 text-xs text-destructive">
					<AlertCircle className="h-3 w-3" />
					{error}
				</div>
			)}

			<div className="relative">
				<button
					type="button"
					onClick={() => setIsOpen(!isOpen)}
					disabled={isLoading}
					className="w-full flex items-center justify-between px-3 py-2 text-sm border border-input rounded-md bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
				>
					{buttonContent}
					<ChevronDown
						className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
					/>
				</button>

				{isOpen && !isLoading && (
					<div className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-64 overflow-hidden">
						{/* Search filter */}
						<div className="p-2 border-b border-border">
							<Input
								placeholder={t("projectSections.github.searchRepositories")}
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								className="h-8 text-sm"
								autoFocus
							/>
						</div>

						{/* Repository list */}
						<div className="max-h-48 overflow-y-auto">
							{filteredRepos.length === 0 ? (
								<div className="px-3 py-4 text-sm text-muted-foreground text-center">
									{filter
										? t("projectSections.github.noMatchingRepositories")
										: t("projectSections.github.noRepositoriesFound")}
								</div>
							) : (
								filteredRepos.map((repo) => (
									<button
										key={repo.fullName}
										type="button"
										onClick={() => {
											onSelect(repo.fullName);
											setIsOpen(false);
											setFilter("");
										}}
										className={`w-full px-3 py-2 text-left hover:bg-accent flex items-start gap-2 ${
											repo.fullName === selectedRepo ? "bg-accent" : ""
										}`}
									>
										{repo.isPrivate ? (
											<Lock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
										) : (
											<Globe className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
										)}
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium truncate">
												{repo.fullName}
											</p>
											{repo.description && (
												<p className="text-xs text-muted-foreground truncate">
													{repo.description}
												</p>
											)}
										</div>
									</button>
								))
							)}
						</div>
					</div>
				)}
			</div>

			{selectedRepo && (
				<p className="text-xs text-muted-foreground">
					{t("projectSections.github.selectedLabel")}:{" "}
					<code className="px-1 bg-muted rounded">{selectedRepo}</code>
				</p>
			)}
		</div>
	);
}

interface RepositoryInputProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
}

function RepositoryInput({ value, onChange }: RepositoryInputProps) {
	const { t } = useTranslation("settings");

	return (
		<div className="space-y-2">
			<Label className="text-sm font-medium text-foreground">
				{t("projectSections.github.repository")}
			</Label>
			<p className="text-xs text-muted-foreground">
				{t("projectSections.github.repositoryFormatPrefix")}{" "}
				<code className="px-1 bg-muted rounded">owner/repo</code>{" "}
				{t("projectSections.github.repositoryFormatExample")}
			</p>
			<Input
				data-guide={GUIDE_ANCHORS.github.repo}
				placeholder={t("projectSections.github.repositoryPlaceholder")}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

interface ConnectionStatusProps {
	readonly isChecking: boolean;
	readonly connectionStatus: GitHubSyncStatus | null;
}

function ConnectionStatus({
	isChecking,
	connectionStatus,
}: ConnectionStatusProps) {
	const { t } = useTranslation("settings");

	// Extract the status icon logic to improve readability
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

	// Extract the status text logic to improve readability
	let statusText: string;

	if (isChecking) {
		statusText = t("projectSections.github.checkingConnection");
	} else if (connectionStatus?.connected) {
		statusText = t("projectSections.github.connectedToGitHub");
	} else {
		statusText = t("projectSections.github.notConnectedToGitHub");
	}

	return (
		<div className="rounded-lg border border-border bg-muted/30 p-3">
			<div className="flex items-center justify-between">
				<div>
					<p className="text-sm font-medium text-foreground">
						{t("projectSections.github.connectionStatus", { ns: "settings" })}
					</p>
					<p className="text-xs text-muted-foreground">{statusText}</p>
					{connectionStatus?.repoFullName && (
						<p className="text-xs text-muted-foreground mt-1">
							{t("projectSections.github.repository")}:{" "}
							<span className="font-mono">{connectionStatus.repoFullName}</span>
						</p>
					)}
					{connectionStatus?.repoDescription && (
						<p className="text-xs text-muted-foreground mt-1">
							{connectionStatus.repoDescription}
						</p>
					)}
				</div>
				{statusIcon}
			</div>
		</div>
	);
}

function IssuesAvailableInfo() {
	const { t } = useTranslation("settings");

	return (
		<div className="rounded-lg border border-info/30 bg-info/5 p-3">
			<div className="flex items-start gap-3">
				<Globe className="h-5 w-5 text-info mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-foreground">
						{t("projectSections.github.issuesAvailable")}
					</p>
					<p className="text-xs text-muted-foreground mt-1">
						{t("projectSections.github.issuesAvailableDescription")}
					</p>
				</div>
			</div>
		</div>
	);
}

interface AutoSyncToggleProps {
	readonly enabled: boolean;
	readonly onToggle: (checked: boolean) => void;
}

function AutoSyncToggle({ enabled, onToggle }: AutoSyncToggleProps) {
	const { t } = useTranslation("settings");

	return (
		<div className="flex items-center justify-between">
			<div className="space-y-0.5">
				<div className="flex items-center gap-2">
					<RefreshCw className="h-4 w-4 text-info" />
					<Label className="font-normal text-foreground">
						{t("projectSections.github.autoSyncOnLoad")}
					</Label>
				</div>
				<p className="text-xs text-muted-foreground pl-6">
					{t("projectSections.github.autoSyncDescription")}
				</p>
			</div>
			<Switch checked={enabled} onCheckedChange={onToggle} />
		</div>
	);
}
