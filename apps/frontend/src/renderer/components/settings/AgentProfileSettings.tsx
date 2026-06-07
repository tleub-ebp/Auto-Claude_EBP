import {
	Brain,
	Check,
	ChevronDown,
	ChevronUp,
	RotateCcw,
	Scale,
	Server,
	Settings2,
	Sparkles,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AVAILABLE_MODELS,
	DEFAULT_AGENT_PROFILES,
	DEFAULT_PHASE_MODELS,
	DEFAULT_PHASE_THINKING,
	getDefaultModelForProvider,
	providerSupportsThinking,
	THINKING_LEVELS,
} from "../../../shared/constants";
import type {
	AgentProfile,
	PhaseModelConfig,
	PhaseThinkingConfig,
	ThinkingLevel,
} from "../../../shared/types/settings";
import {
	type CatalogModel,
	useProviderModelCatalog,
} from "../../hooks/useProviderModelCatalog";
import { cn } from "../../lib/utils";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { ModelCatalogStatus } from "../ModelCatalogStatus";
import { useProviderContext } from "../ProviderContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { SettingsSection } from "./SettingsSection";

/**
 * Icon mapping for agent profile icons
 */
const iconMap: Record<string, React.ElementType> = {
	Brain,
	Scale,
	Zap,
	Sparkles,
	Settings2,
	Server,
};

const PHASE_KEYS: Array<keyof PhaseModelConfig> = [
	"spec",
	"planning",
	"coding",
	"qa",
];

/**
 * Builds per-provider default phase models using the flagship model of the provider.
 */
function buildDefaultPhaseModelsForProvider(
	provider: string,
): PhaseModelConfig {
	// For Claude/Anthropic keep the curated Claude defaults
	if (provider === "anthropic" || provider === "claude" || !provider) {
		return DEFAULT_PHASE_MODELS;
	}
	const flagship = getDefaultModelForProvider(provider);
	return { spec: flagship, planning: flagship, coding: flagship, qa: flagship };
}

/**
 * Agent Profile Settings component – provider-aware
 *
 * When the active provider is Claude/Anthropic, the component behaves exactly
 * as before (preset profiles + extended thinking).  For any other provider it
 * shows the available models for that provider and hides the thinking-level
 * selector (replaced with a simple model picker per phase).
 */
export function AgentProfileSettings() {
	const { t } = useTranslation("settings");
	const settings = useSettingsStore((state) => state.settings);
	const { selectedProvider } = useProviderContext();

	// Effective provider: context > settings > fallback to 'anthropic'
	const provider = selectedProvider || settings.selectedProvider || "anthropic";
	const isClaude =
		provider === "anthropic" || provider === "claude" || !provider;

	const selectedProfileId = settings.selectedAgentProfile || "auto";
	const [showPhaseConfig, setShowPhaseConfig] = useState(true);
	// Per-phase custom model text (used for Ollama free-text input)
	const [customModelPerPhase, setCustomModelPerPhase] = useState<
		Record<keyof PhaseModelConfig, string>
	>({
		spec: "",
		planning: "",
		coding: "",
		qa: "",
	});

	// Models available for the current provider — live, with 24h backend cache
	// and static fallback when the provider's API is unreachable.
	const liveCatalog = useProviderModelCatalog(provider);
	const providerModels: readonly CatalogModel[] = liveCatalog.models;
	const supportsThinking = providerSupportsThinking(provider);

	// Find the selected profile (only meaningful for Claude)
	const selectedProfile = useMemo(
		() =>
			DEFAULT_AGENT_PROFILES.find((p) => p.id === selectedProfileId) ||
			DEFAULT_AGENT_PROFILES[0],
		[selectedProfileId],
	);

	// Profile phase defaults (Claude-specific presets or generic defaults)
	const profilePhaseModels = isClaude
		? selectedProfile.phaseModels || DEFAULT_PHASE_MODELS
		: buildDefaultPhaseModelsForProvider(provider);
	const profilePhaseThinking = isClaude
		? selectedProfile.phaseThinking || DEFAULT_PHASE_THINKING
		: supportsThinking
			? DEFAULT_PHASE_THINKING
			: {
					spec: "none" as ThinkingLevel,
					planning: "none" as ThinkingLevel,
					coding: "none" as ThinkingLevel,
					qa: "none" as ThinkingLevel,
				};

	// Get current phase config from settings (custom) or fall back to provider/profile defaults
	const savedProviderModels = settings.providerPhaseModels?.[provider];
	const savedProviderThinking = settings.providerPhaseThinking?.[provider];
	const currentPhaseModels: PhaseModelConfig =
		savedProviderModels ||
		(isClaude ? settings.customPhaseModels : undefined) ||
		profilePhaseModels;
	const currentPhaseThinking: PhaseThinkingConfig =
		(isClaude ? settings.customPhaseThinking : savedProviderThinking) ||
		profilePhaseThinking;

	// Reset per-phase custom model fields when provider changes
	useEffect(() => {
		setCustomModelPerPhase({ spec: "", planning: "", coding: "", qa: "" });
	}, []);

	// Auto-initialize provider defaults when switching to a new provider
	useEffect(() => {
		if (!isClaude && !savedProviderModels && provider) {
			// Initialize with default models for the new provider
			const defaultModels = buildDefaultPhaseModelsForProvider(provider);
			const defaultThinking = supportsThinking
				? DEFAULT_PHASE_THINKING
				: {
						spec: "none" as ThinkingLevel,
						planning: "none" as ThinkingLevel,
						coding: "none" as ThinkingLevel,
						qa: "none" as ThinkingLevel,
					};

			// Auto-save defaults for the new provider
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			const updates: any = {
				providerPhaseModels: {
					...(settings.providerPhaseModels || {}),
					[provider]: defaultModels,
				},
			};

			if (supportsThinking) {
				updates.providerPhaseThinking = {
					...(settings.providerPhaseThinking || {}),
					[provider]: defaultThinking,
				};
			}

			saveSettings(updates);
		}
	}, [
		provider,
		isClaude,
		supportsThinking,
		savedProviderModels,
		settings.providerPhaseModels,
		settings.providerPhaseThinking,
	]);

	/**
	 * Check if current config differs from profile defaults (Claude only)
	 */
	const hasCustomConfig = useMemo((): boolean => {
		if (!isClaude) return !!(savedProviderModels || savedProviderThinking);
		if (!settings.customPhaseModels && !settings.customPhaseThinking)
			return false;
		return PHASE_KEYS.some(
			(phase) =>
				currentPhaseModels[phase] !== profilePhaseModels[phase] ||
				currentPhaseThinking[phase] !== profilePhaseThinking[phase],
		);
	}, [
		isClaude,
		savedProviderModels,
		savedProviderThinking,
		settings.customPhaseModels,
		settings.customPhaseThinking,
		currentPhaseModels,
		currentPhaseThinking,
		profilePhaseModels,
		profilePhaseThinking,
	]);

	const handleSelectProfile = async (profileId: string) => {
		const profile = DEFAULT_AGENT_PROFILES.find((p) => p.id === profileId);
		if (!profile) return;
		await saveSettings({
			selectedAgentProfile: profileId,
			customPhaseModels: undefined,
			customPhaseThinking: undefined,
		});
	};

	const handlePhaseModelChange = async (
		phase: keyof PhaseModelConfig,
		value: string,
	) => {
		const newPhaseModels = { ...currentPhaseModels, [phase]: value };
		if (isClaude) {
			await saveSettings({ customPhaseModels: newPhaseModels });
		} else {
			const updatedProviderModels = {
				...(settings.providerPhaseModels || {}),
				[provider]: newPhaseModels,
			};
			await saveSettings({ providerPhaseModels: updatedProviderModels });
		}
	};

	const handlePhaseThinkingChange = async (
		phase: keyof PhaseThinkingConfig,
		value: ThinkingLevel,
	) => {
		const newPhaseThinking = { ...currentPhaseThinking, [phase]: value };
		if (isClaude) {
			await saveSettings({ customPhaseThinking: newPhaseThinking });
		} else {
			const updatedProviderThinking = {
				...(settings.providerPhaseThinking || {}),
				[provider]: newPhaseThinking,
			};
			await saveSettings({ providerPhaseThinking: updatedProviderThinking });
		}
	};

	const handleResetToProfileDefaults = async () => {
		if (isClaude) {
			await saveSettings({
				customPhaseModels: undefined,
				customPhaseThinking: undefined,
			});
		} else {
			const updatedProviderModels = { ...(settings.providerPhaseModels || {}) };
			delete updatedProviderModels[provider];
			const updatedProviderThinking = {
				...(settings.providerPhaseThinking || {}),
			};
			delete updatedProviderThinking[provider];
			await saveSettings({
				providerPhaseModels: updatedProviderModels,
				providerPhaseThinking: updatedProviderThinking,
			});
		}
	};

	const getModelLabel = (modelValue: string): string => {
		if (isClaude) {
			const model = AVAILABLE_MODELS.find((m) => m.value === modelValue);
			return model?.label || modelValue;
		}
		const model = providerModels.find((m) => m.value === modelValue);
		return model?.label || modelValue;
	};

	const getThinkingLabel = (thinkingValue: string): string => {
		const level = THINKING_LEVELS.find((l) => l.value === thinkingValue);
		return level?.label || thinkingValue;
	};

	/**
	 * Render a single profile card (Claude only)
	 */
	const renderProfileCard = (profile: AgentProfile) => {
		const isSelected = selectedProfileId === profile.id;
		const isCustomized = isSelected && hasCustomConfig;
		const Icon = iconMap[profile.icon || "Brain"] || Brain;

		return (
			<button
				type="button"
				key={profile.id}
				onClick={() => handleSelectProfile(profile.id)}
				className={cn(
					"relative w-full rounded-lg border p-4 text-left transition-all duration-200",
					"hover:border-primary/50 hover:shadow-sm",
					isSelected ? "border-primary bg-primary/5" : "border-border bg-card",
				)}
			>
				{isSelected && (
					<div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
						<Check className="h-3 w-3 text-primary-foreground" />
					</div>
				)}
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
							isSelected ? "bg-primary/10" : "bg-muted",
						)}
					>
						<Icon
							className={cn(
								"h-5 w-5",
								isSelected ? "text-primary" : "text-muted-foreground",
							)}
						/>
					</div>
					<div className="flex-1 min-w-0 pr-6">
						<div className="flex items-center gap-2">
							<h3 className="font-medium text-sm text-foreground">
								{profile.name}
							</h3>
							{isCustomized && (
								<span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
									{t("agentProfile.customized")}
								</span>
							)}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
							{profile.description}
						</p>
						<div className="mt-2 flex flex-wrap gap-1.5">
							<span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
								{getModelLabel(profile.model)}
							</span>
							<span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
								{getThinkingLabel(profile.thinkingLevel)}{" "}
								{t("agentProfile.thinking")}
							</span>
						</div>
					</div>
				</div>
			</button>
		);
	};

	// ---- Provider badge (non-Claude banner) ----
	const renderProviderBanner = () => {
		const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
		const flagshipModel = providerModels.find((m) => m.tier === "flagship");
		return (
			<div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center gap-3">
				<Server className="h-5 w-5 text-primary shrink-0" />
				<div className="flex-1">
					<p className="text-sm font-medium text-foreground">
						{t("agentProfile.activeProvider", { provider: providerLabel })}
					</p>
					{flagshipModel && (
						<p className="text-xs text-muted-foreground">
							{t("agentProfile.flagshipModel", { model: flagshipModel.label })}
						</p>
					)}
				</div>
				<ModelCatalogStatus catalog={liveCatalog} />
			</div>
		);
	};

	return (
		<SettingsSection
			title={t("agentProfile.title")}
			description={t("agentProfile.sectionDescription")}
		>
			<div className="space-y-4">
				{/* Description */}
				<div className="rounded-lg bg-muted/50 p-3">
					<p className="text-xs text-muted-foreground">
						{isClaude
							? t("agentProfile.profilesInfo")
							: t("agentProfile.profilesInfoProvider")}
					</p>
				</div>

				{/* Claude: preset profile cards */}
				{isClaude && (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
						{DEFAULT_AGENT_PROFILES.map(renderProfileCard)}
					</div>
				)}

				{/* Non-Claude: provider banner */}
				{!isClaude && renderProviderBanner()}

				{/* Phase Configuration */}
				<div className="mt-6 rounded-lg border border-border bg-card">
					{/* Header – Collapsible */}
					<button
						type="button"
						onClick={() => setShowPhaseConfig(!showPhaseConfig)}
						className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors rounded-t-lg"
					>
						<div>
							<h4 className="font-medium text-sm text-foreground">
								{t("agentProfile.phaseConfiguration")}
							</h4>
							<p className="text-xs text-muted-foreground mt-0.5">
								{t("agentProfile.phaseConfigurationDescription")}
							</p>
						</div>
						{showPhaseConfig ? (
							<ChevronUp className="h-4 w-4 text-muted-foreground" />
						) : (
							<ChevronDown className="h-4 w-4 text-muted-foreground" />
						)}
					</button>

					{showPhaseConfig && (
						<div className="border-t border-border p-4 space-y-4">
							{/* Reset button */}
							{hasCustomConfig && (
								<div className="flex justify-end">
									<Button
										variant="ghost"
										size="sm"
										onClick={handleResetToProfileDefaults}
										className="text-xs h-7"
									>
										<RotateCcw className="h-3 w-3 mr-1.5" />
										{isClaude
											? t("agentProfile.resetToProfileDefaults", {
													profile: selectedProfile.name,
												})
											: t("agentProfile.resetToProviderDefaults")}
									</Button>
								</div>
							)}

							{/* Phase rows */}
							<div className="space-y-4">
								{PHASE_KEYS.map((phase) => (
									<div key={phase} className="space-y-2">
										<div className="flex items-center justify-between">
											<Label className="text-sm font-medium text-foreground">
												{t(`agentProfile.phases.${phase}.label`)}
											</Label>
											<span className="text-xs text-muted-foreground">
												{t(`agentProfile.phases.${phase}.description`)}
											</span>
										</div>

										<div
											className={cn(
												"grid gap-3",
												supportsThinking ? "grid-cols-2" : "grid-cols-1",
											)}
										>
											{/* Model Select */}
											<div className="space-y-1">
												<Label className="text-xs text-muted-foreground">
													{t("agentProfile.model")}
												</Label>
												{isClaude ? (
													<Select
														value={currentPhaseModels[phase]}
														onValueChange={(value) =>
															handlePhaseModelChange(phase, value as string)
														}
													>
														<SelectTrigger className="h-9">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{AVAILABLE_MODELS.map((m) => (
																<SelectItem key={m.value} value={m.value}>
																	{m.label}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												) : (
													<Select
														value={
															currentPhaseModels[phase] === "custom"
																? "custom"
																: currentPhaseModels[phase]
														}
														onValueChange={(value) => {
															if (value === "custom") {
																// keep the field open; user types the model ID
																handlePhaseModelChange(
																	phase,
																	customModelPerPhase[phase] || "custom",
																);
															} else {
																handlePhaseModelChange(phase, value as string);
															}
														}}
													>
														<SelectTrigger className="h-9">
															<SelectValue
																placeholder={t("agentProfile.selectModel")}
															/>
														</SelectTrigger>
														<SelectContent>
															{providerModels.map((m) => (
																<SelectItem key={m.value} value={m.value}>
																	<span className="flex items-center gap-2">
																		{m.label}
																		{m.tier === "flagship" && (
																			<span className="inline-flex items-center rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
																				{t("agentProfile.tierFlagship")}
																			</span>
																		)}
																		{m.supportsThinking && (
																			<span className="inline-flex items-center rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-600 dark:text-violet-400">
																				{t("agentProfile.supportsThinking")}
																			</span>
																		)}
																	</span>
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												)}

												{/* Free-text input for Ollama custom model (per-phase) */}
												{!isClaude &&
													provider === "ollama" &&
													currentPhaseModels[phase] === "custom" && (
														<Input
															className="h-8 mt-1 text-xs"
															placeholder={t(
																"agentProfile.customModelPlaceholder",
															)}
															value={customModelPerPhase[phase]}
															onChange={(e) => {
																setCustomModelPerPhase((prev) => ({
																	...prev,
																	[phase]: e.target.value,
																}));
																handlePhaseModelChange(phase, e.target.value);
															}}
														/>
													)}
											</div>

											{/* Thinking Level Select – only when supported */}
											{supportsThinking && (
												<div className="space-y-1">
													<Label className="text-xs text-muted-foreground">
														{t("agentProfile.thinkingLevel")}
													</Label>
													<Select
														value={currentPhaseThinking[phase]}
														onValueChange={(value) =>
															handlePhaseThinkingChange(
																phase,
																value as ThinkingLevel,
															)
														}
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
								))}
							</div>

							{/* Info note */}
							<p className="text-[10px] text-muted-foreground mt-4 pt-3 border-t border-border">
								{isClaude
									? t("agentProfile.phaseConfigNote")
									: t("agentProfile.phaseConfigNoteProvider", {
											provider:
												provider.charAt(0).toUpperCase() + provider.slice(1),
										})}
							</p>
						</div>
					)}
				</div>
			</div>
		</SettingsSection>
	);
}
