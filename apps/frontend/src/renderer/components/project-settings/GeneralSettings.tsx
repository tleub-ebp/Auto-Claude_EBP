import {
	AlertCircle,
	CheckCircle2,
	ChevronRight,
	Download,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { DEFAULT_AGENT_PROFILES } from "../../../shared/constants";
import type {
	AutoBuildVersionInfo,
	Project,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings-store";
import { useProviderContext } from "../ProviderContext";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

interface GeneralSettingsProps {
	readonly project: Project;
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
	readonly versionInfo: AutoBuildVersionInfo | null;
	readonly isCheckingVersion: boolean;
	readonly isUpdating: boolean;
	readonly handleInitialize: () => Promise<void>;
}

export function GeneralSettings({
	project,
	settings,
	setSettings,
	versionInfo,
	isCheckingVersion,
	isUpdating,
	handleInitialize,
}: GeneralSettingsProps) {
	const { t } = useTranslation(["settings"]);
	const { selectedProvider } = useProviderContext();
	const provider = selectedProvider || "anthropic";
	const liveCatalog = useProviderModelCatalog(provider);

	// Resolve the active agent profile + its flagship for a read-only summary.
	// The actual model picker lives in Settings → Agent (AgentProfileSettings).
	const appSettings = useSettingsStore((s) => s.settings);
	const selectedProfileId = appSettings.selectedAgentProfile || "auto";
	const selectedProfile =
		DEFAULT_AGENT_PROFILES.find((p) => p.id === selectedProfileId) ||
		DEFAULT_AGENT_PROFILES[0];
	const flagshipModel = liveCatalog.models.find(
		(m) => (m as { tier?: string }).tier === "flagship",
	);
	const flagshipLabel = flagshipModel?.label || liveCatalog.models[0]?.label;

	const handleOpenAgentSettings = () => {
		globalThis.dispatchEvent(
			new CustomEvent("app-settings:navigate", {
				detail: { section: "agent" },
			}),
		);
	};

	return (
		<>
			{/* Auto-Build Integration */}
			<section className="space-y-4">
				<h3 className="text-sm font-semibold text-foreground">
					{t("projectSections.autoBuild.title")}
				</h3>
				{project.autoBuildPath ? (
					<div className="rounded-lg border border-border bg-muted/50 p-4 space-y-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<CheckCircle2 className="h-4 w-4 text-success" />
								<span className="text-sm font-medium text-foreground">
									{t("projectSections.autoBuild.initialized")}
								</span>
							</div>
							<code className="text-xs bg-background px-2 py-1 rounded">
								{project.autoBuildPath}
							</code>
						</div>
						{isCheckingVersion ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Loader2 className="h-3 w-3 animate-spin" />
								{t("projectSections.autoBuild.checkingStatus")}
							</div>
						) : (
							versionInfo && (
								<div className="text-xs text-muted-foreground">
									{versionInfo.isInitialized
										? t("projectSections.autoBuild.initialized")
										: t("projectSections.autoBuild.notInitialized")}
								</div>
							)
						)}
					</div>
				) : (
					<div className="rounded-lg border border-border bg-muted/50 p-4">
						<div className="flex items-start gap-3">
							<AlertCircle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
							<div className="flex-1">
								<p className="text-sm font-medium text-foreground">
									{t("projectSections.autoBuild.notInitialized")}
								</p>
								<p className="text-xs text-muted-foreground mt-1">
									{t("projectSections.autoBuild.notInitializedDescription")}
								</p>
								<Button
									size="sm"
									className="mt-3"
									onClick={handleInitialize}
									disabled={isUpdating}
								>
									{isUpdating ? (
										<>
											<RefreshCw className="mr-2 h-4 w-4 animate-spin" />
											{t("projectSections.autoBuild.initializing")}
										</>
									) : (
										<>
											<Download className="mr-2 h-4 w-4" />
											{t("projectSections.autoBuild.initializeButton")}
										</>
									)}
								</Button>
							</div>
						</div>
					</div>
				)}
			</section>

			{project.autoBuildPath && (
				<>
					<Separator />

					{/* Agent Settings */}
					<section className="space-y-4">
						<h3 className="text-sm font-semibold text-foreground">
							{t("projectSections.agentConfiguration.title")}
						</h3>
						<button
							type="button"
							onClick={handleOpenAgentSettings}
							className={cn(
								"flex w-full items-center justify-between rounded-lg",
								"border border-border bg-muted/30 p-3 text-left",
								"transition-colors hover:bg-muted/50",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
						>
							<div className="space-y-0.5">
								<p className="text-sm font-medium text-foreground">
									{t("projectSections.agentConfiguration.summary", {
										defaultValue: "Profil : {{profile}} · Modèle phare : {{model}}",
										profile: selectedProfile.name,
										model: flagshipLabel || "—",
									})}
								</p>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.agentConfiguration.managedInSettings", {
										defaultValue:
											"Géré dans Paramètres → Agent. Cliquez pour modifier.",
									})}
								</p>
							</div>
							<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
						</button>
						<div className="flex items-center justify-between pt-2">
							<div className="space-y-0.5">
								<Label className="font-normal text-foreground">
									{t("projectSections.general.useClaudeMd")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.general.useClaudeMdDescription")}
								</p>
							</div>
							<Switch
								checked={settings.useClaudeMd ?? true}
								onCheckedChange={(checked) =>
									setSettings({ ...settings, useClaudeMd: checked })
								}
							/>
						</div>
						<div className="flex items-center justify-between pt-2">
							<div className="space-y-0.5">
								<Label className="font-normal text-foreground">
									{t("projectSections.general.tddMode")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.general.tddModeDescription")}
								</p>
							</div>
							<Switch
								checked={settings.tddMode ?? false}
								onCheckedChange={(checked) =>
									setSettings({ ...settings, tddMode: checked })
								}
							/>
						</div>
					</section>

					<Separator />

					{/* Notifications */}
					<section className="space-y-4">
						<h3 className="text-sm font-semibold text-foreground">
							{t("notifications.title")}
						</h3>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<Label className="font-normal text-foreground">
									{t("notifications.onTaskComplete")}
								</Label>
								<Switch
									checked={settings.notifications.onTaskComplete}
									onCheckedChange={(checked) =>
										setSettings({
											...settings,
											notifications: {
												...settings.notifications,
												onTaskComplete: checked,
											},
										})
									}
								/>
							</div>
							<div className="flex items-center justify-between">
								<Label className="font-normal text-foreground">
									{t("notifications.onTaskFailed")}
								</Label>
								<Switch
									checked={settings.notifications.onTaskFailed}
									onCheckedChange={(checked) =>
										setSettings({
											...settings,
											notifications: {
												...settings.notifications,
												onTaskFailed: checked,
											},
										})
									}
								/>
							</div>
							<div className="flex items-center justify-between">
								<Label className="font-normal text-foreground">
									{t("notifications.onReviewNeeded")}
								</Label>
								<Switch
									checked={settings.notifications.onReviewNeeded}
									onCheckedChange={(checked) =>
										setSettings({
											...settings,
											notifications: {
												...settings.notifications,
												onReviewNeeded: checked,
											},
										})
									}
								/>
							</div>
							<div className="flex items-center justify-between">
								<Label className="font-normal text-foreground">
									{t("notifications.sound")}
								</Label>
								<Switch
									checked={settings.notifications.sound}
									onCheckedChange={(checked) =>
										setSettings({
											...settings,
											notifications: {
												...settings.notifications,
												sound: checked,
											},
										})
									}
								/>
							</div>
						</div>
					</section>
				</>
			)}
		</>
	);
}
