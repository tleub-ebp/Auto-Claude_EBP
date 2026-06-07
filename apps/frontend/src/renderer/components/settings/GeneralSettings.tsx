import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_FEATURE_MODELS,
	DEFAULT_FEATURE_THINKING,
	FEATURE_LABELS,
	getModelsForProvider,
	providerSupportsThinking,
	THINKING_LEVELS,
} from "../../../shared/constants";
import type {
	AppSettings,
	FeatureModelConfig,
	ThinkingLevel,
	ToolDetectionResult,
} from "../../../shared/types";
import { useProviderContext } from "../ProviderContext";
import { ProviderSelector } from "../ProviderSelector";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { AgentProfileSettings } from "./AgentProfileSettings";
import { CustomProviderConfig } from "./CustomProviderConfig";
import { SettingsSection } from "./SettingsSection";

interface GeneralSettingsProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
	readonly section: "agent" | "paths";
	readonly onOpenAccountsSettings?: () => void;
}

/**
 * Helper component to display auto-detected CLI tool information
 */
interface ToolDetectionDisplayProps {
	readonly info: ToolDetectionResult | null;
	readonly isLoading: boolean;
	readonly t: (key: string) => string;
}

function ToolDetectionDisplay({
	info,
	isLoading,
	t,
}: ToolDetectionDisplayProps) {
	if (isLoading) {
		return (
			<div className="text-xs text-muted-foreground mt-1">Detecting...</div>
		);
	}

	if (!info?.found) {
		return (
			<div className="text-xs text-muted-foreground mt-1">
				{t("general.notDetected")}
			</div>
		);
	}

	const getSourceLabel = (source: ToolDetectionResult["source"]): string => {
		const sourceMap: Record<ToolDetectionResult["source"], string> = {
			"user-config": t("general.sourceUserConfig"),
			venv: t("general.sourceVenv"),
			homebrew: t("general.sourceHomebrew"),
			nvm: t("general.sourceNvm"),
			"system-path": t("general.sourceSystemPath"),
			bundled: t("general.sourceBundled"),
			fallback: t("general.sourceFallback"),
		};
		return sourceMap[source] || source;
	};

	return (
		<div className="text-xs text-muted-foreground mt-1 space-y-0.5">
			<div>
				<span className="font-medium">{t("general.detectedPath")}:</span>{" "}
				<code className="bg-muted px-1 py-0.5 rounded">{info.path}</code>
			</div>
			{info.version && (
				<div>
					<span className="font-medium">{t("general.detectedVersion")}:</span>{" "}
					{info.version}
				</div>
			)}
			<div>
				<span className="font-medium">{t("general.detectedSource")}:</span>{" "}
				{getSourceLabel(info.source)}
			</div>
		</div>
	);
}

/**
 * General settings component for agent configuration and paths
 */
export function GeneralSettings({
	settings,
	onSettingsChange,
	section,
	onOpenAccountsSettings,
}: GeneralSettingsProps) {
	const { t } = useTranslation("settings");
	const [toolsInfo, setToolsInfo] = useState<{
		python: ToolDetectionResult;
		git: ToolDetectionResult;
		gh: ToolDetectionResult;
		glab: ToolDetectionResult;
		claude: ToolDetectionResult;
	} | null>(null);
	const [isLoadingTools, setIsLoadingTools] = useState(false);

	// Refs to avoid re-running the detection effect when settings/onSettingsChange
	// identities change. The effect should only run on mount or when `section` changes.
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const onSettingsChangeRef = useRef(onSettingsChange);
	onSettingsChangeRef.current = onSettingsChange;

	// Stable per-field updater. Reads the latest settings via ref so the callback
	// identity stays stable across renders, avoiding re-renders of memoized inputs.
	const updateField = useCallback(
		<K extends keyof AppSettings>(field: K, value: AppSettings[K]) => {
			onSettingsChangeRef.current({ ...settingsRef.current, [field]: value });
		},
		[],
	);

	// Fetch CLI tools detection info when component mounts (paths section only)
	useEffect(() => {
		if (section !== "paths") return;
		let cancelled = false;
		setIsLoadingTools(true);
		globalThis.electronAPI
			.getCliToolsInfo()
			.then(
				(result: {
					success: boolean;
					data?: {
						python: ToolDetectionResult;
						git: ToolDetectionResult;
						gh: ToolDetectionResult;
						glab: ToolDetectionResult;
						claude: ToolDetectionResult;
					};
				}) => {
					if (cancelled || !result.success || !result.data) return;
					setToolsInfo(result.data);
					// Sync claudePath with detected path only when it differs, to avoid
					// re-triggering the effect or causing unnecessary settings churn.
					const detectedPath = result.data.claude?.found
						? result.data.claude.path
						: undefined;
					if (
						detectedPath &&
						detectedPath !== settingsRef.current.claudePath
					) {
						onSettingsChangeRef.current({
							...settingsRef.current,
							claudePath: detectedPath,
						});
					}
				},
			)
			.catch((error: unknown) => {
				console.error("Failed to fetch CLI tools info:", error);
			})
			.finally(() => {
				if (!cancelled) setIsLoadingTools(false);
			});
		return () => {
			cancelled = true;
		};
	}, [section]);

	// Lit le provider actif depuis le contexte pour filtrer les modèles disponibles
	const { selectedProvider } = useProviderContext();
	const activeProvider = selectedProvider || "anthropic";
	const providerModels = getModelsForProvider(activeProvider);
	const supportsThinking = providerSupportsThinking(activeProvider);

	if (section === "agent") {
		return (
			<div className="space-y-8">
				{/* Provider Selection */}
				<SettingsSection
					title={t("general.providerSection")}
					description={t("general.providerSectionDescription")}
				>
					<ProviderSelector onOpenAccountsSettings={onOpenAccountsSettings} />
				</SettingsSection>

				{/* Agent Profile Selection */}
				<AgentProfileSettings />

				{/* Custom Provider Configuration */}
				<CustomProviderConfig />

				{/* Other Agent Settings */}
				<SettingsSection
					title={t("general.otherAgentSettings")}
					description={t("general.otherAgentSettingsDescription")}
				>
					<div className="space-y-6">
						<div className="space-y-3">
							<div className="flex items-center justify-between max-w-md">
								<div className="space-y-1">
									<Label
										htmlFor="autoNameTerminals"
										className="text-sm font-medium text-foreground"
									>
										{t("general.aiTerminalNaming")}
									</Label>
									<p className="text-sm text-muted-foreground">
										{t("general.aiTerminalNamingDescription")}
									</p>
								</div>
								<Switch
									id="autoNameTerminals"
									checked={settings.autoNameTerminals}
									onCheckedChange={(checked) =>
										onSettingsChange({
											...settings,
											autoNameTerminals: checked,
										})
									}
								/>
							</div>
						</div>

						{/* Feature Model Configuration */}
						<div className="space-y-4 pt-4 border-t border-border">
							<div className="space-y-1">
								<Label className="text-sm font-medium text-foreground">
									{t("general.featureModelSettings")}
								</Label>
								<p className="text-sm text-muted-foreground">
									{t("general.featureModelSettingsDescription")}
								</p>
							</div>

							{(
								Object.keys(FEATURE_LABELS) as Array<keyof FeatureModelConfig>
							).map((feature) => {
								const featureModels =
									settings.featureModels || DEFAULT_FEATURE_MODELS;
								const featureThinking =
									settings.featureThinking || DEFAULT_FEATURE_THINKING;

								// Valeur du modèle : si la valeur sauvegardée n'existe plus dans la liste du provider actif,
								// on utilise le premier modèle disponible comme fallback
								const currentModelValue = featureModels[feature];
								const modelExists = providerModels.some(
									(m) => m.value === currentModelValue,
								);
								const effectiveModelValue = modelExists
									? currentModelValue
									: (providerModels[0]?.value ?? "");

								// Valeur du niveau de réflexion avec fallback explicite
								const currentThinkingValue: ThinkingLevel =
									featureThinking[feature] ?? "medium";

								return (
									<div key={feature} className="space-y-2">
										<div className="flex items-center justify-between">
											<Label className="text-sm font-medium text-foreground">
												{FEATURE_LABELS[feature].label}
											</Label>
											<span className="text-xs text-muted-foreground">
												{FEATURE_LABELS[feature].description}
											</span>
										</div>
										<div
											className={`grid gap-3 max-w-md ${supportsThinking ? "grid-cols-2" : "grid-cols-1"}`}
										>
											{/* Model Select — filtré selon le provider actif */}
											<div className="space-y-1">
												<Label className="text-xs text-muted-foreground">
													{t("general.model")}
												</Label>
												<Select
													value={effectiveModelValue}
													onValueChange={(value) => {
														const newFeatureModels = {
															...featureModels,
															[feature]: value,
														};
														onSettingsChange({
															...settings,
															featureModels: newFeatureModels,
														});
													}}
												>
													<SelectTrigger className="h-9">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{providerModels.map((m) => (
															<SelectItem key={m.value} value={m.value}>
																{m.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
											{/* Thinking Level Select — masqué si le provider ne supporte pas le thinking */}
											{supportsThinking && (
												<div className="space-y-1">
													<Label className="text-xs text-muted-foreground">
														{t("general.thinkingLevel")}
													</Label>
													<Select
														value={currentThinkingValue}
														onValueChange={(value) => {
															const newFeatureThinking = {
																...featureThinking,
																[feature]: value as ThinkingLevel,
															};
															onSettingsChange({
																...settings,
																featureThinking: newFeatureThinking,
															});
														}}
													>
														<SelectTrigger className="h-9">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{THINKING_LEVELS.map((level) => (
																<SelectItem
																	key={level.value}
																	value={level.value}
																>
																	{level.label}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</SettingsSection>
			</div>
		);
	}

	// paths section
	return (
		<SettingsSection
			title={t("general.paths")}
			description={t("general.pathsDescription")}
		>
			<div className="space-y-6">
				<div className="space-y-3">
					<Label
						htmlFor="pythonPath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.pythonPath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.pythonPathDescription")}
					</p>
					<Input
						id="pythonPath"
						placeholder={t("general.pythonPathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.pythonPath || ""}
						onChange={(e) => updateField("pythonPath", e.target.value)}
					/>
					{!settings.pythonPath && (
						<ToolDetectionDisplay
							info={toolsInfo?.python || null}
							isLoading={isLoadingTools}
							t={t}
						/>
					)}
				</div>
				<div className="space-y-3">
					<Label
						htmlFor="gitPath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.gitPath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.gitPathDescription")}
					</p>
					<Input
						id="gitPath"
						placeholder={t("general.gitPathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.gitPath || ""}
						onChange={(e) => updateField("gitPath", e.target.value)}
					/>
					{!settings.gitPath && (
						<ToolDetectionDisplay
							info={toolsInfo?.git || null}
							isLoading={isLoadingTools}
							t={t}
						/>
					)}
				</div>
				<div className="space-y-3">
					<Label
						htmlFor="githubCLIPath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.githubCLIPath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.githubCLIPathDescription")}
					</p>
					<Input
						id="githubCLIPath"
						placeholder={t("general.githubCLIPathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.githubCLIPath || ""}
						onChange={(e) => updateField("githubCLIPath", e.target.value)}
					/>
					{!settings.githubCLIPath && (
						<ToolDetectionDisplay
							info={toolsInfo?.gh || null}
							isLoading={isLoadingTools}
							t={t}
						/>
					)}
				</div>
				<div className="space-y-3">
					<Label
						htmlFor="gitlabCLIPath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.gitlabCLIPath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.gitlabCLIPathDescription")}
					</p>
					<Input
						id="gitlabCLIPath"
						placeholder={t("general.gitlabCLIPathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.gitlabCLIPath || ""}
						onChange={(e) => updateField("gitlabCLIPath", e.target.value)}
					/>
					{!settings.gitlabCLIPath && (
						<ToolDetectionDisplay
							info={toolsInfo?.glab || null}
							isLoading={isLoadingTools}
							t={t}
						/>
					)}
				</div>
				<div className="space-y-3">
					<Label
						htmlFor="claudePath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.claudePath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.claudePathDescription")}
					</p>
					<Input
						id="claudePath"
						placeholder={t("general.claudePathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.claudePath || ""}
						onChange={(e) => updateField("claudePath", e.target.value)}
					/>
					{!settings.claudePath && (
						<ToolDetectionDisplay
							info={toolsInfo?.claude || null}
							isLoading={isLoadingTools}
							t={t}
						/>
					)}
				</div>
				<div className="space-y-3">
					<Label
						htmlFor="autoBuildPath"
						className="text-sm font-medium text-foreground"
					>
						{t("general.autoClaudePath")}
					</Label>
					<p className="text-sm text-muted-foreground">
						{t("general.autoClaudePathDescription")}
					</p>
					<Input
						id="autoBuildPath"
						placeholder={t("general.autoClaudePathPlaceholder")}
						className="w-full max-w-lg"
						value={settings.autoBuildPath || ""}
						onChange={(e) => updateField("autoBuildPath", e.target.value)}
					/>
				</div>
			</div>
		</SettingsSection>
	);
}
