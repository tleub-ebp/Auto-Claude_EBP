import { useTranslation } from "react-i18next";
import type {
	AutoBuildVersionInfo,
	AzureDevOpsSyncStatus,
	GitHubSyncStatus,
	GitLabSyncStatus,
	LinearSyncStatus,
	Project,
	ProjectEnvConfig,
	ProjectSettings as ProjectSettingsType,
} from "../../../../shared/types";
import { GeneralSettings } from "../../project-settings/GeneralSettings";
import { SecuritySettings } from "../../project-settings/SecuritySettings";
import { InitializationGuard } from "../common/InitializationGuard";
import { AzureDevOpsIntegration } from "../integrations/AzureDevOpsIntegration";
import { ChannelNotificationsIntegration } from "../integrations/ChannelNotificationsIntegration";
import { CICDPipelineIntegration } from "../integrations/CICDPipelineIntegration";
import { GitHubIntegration } from "../integrations/GitHubIntegration";
import { GitLabIntegration } from "../integrations/GitLabIntegration";
import { JiraIntegration } from "../integrations/JiraIntegration";
import { LinearIntegration } from "../integrations/LinearIntegration";
import type { ProjectSettingsSection } from "../ProjectSettingsContent";
import { SettingsSection } from "../SettingsSection";

interface SectionRouterProps {
	activeSection: ProjectSettingsSection;
	project: Project;
	settings: ProjectSettingsType;
	setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
	versionInfo: AutoBuildVersionInfo | null;
	isCheckingVersion: boolean;
	isUpdating: boolean;
	envConfig: ProjectEnvConfig | null;
	isLoadingEnv: boolean;
	envError: string | null;
	updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
	showLinearKey: boolean;
	setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
	showOpenAIKey: boolean;
	setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;
	showGitHubToken: boolean;
	setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
	gitHubConnectionStatus: GitHubSyncStatus | null;
	isCheckingGitHub: boolean;
	showGitLabToken: boolean;
	setShowGitLabToken: React.Dispatch<React.SetStateAction<boolean>>;
	gitLabConnectionStatus: GitLabSyncStatus | null;
	isCheckingGitLab: boolean;
	linearConnectionStatus: LinearSyncStatus | null;
	isCheckingLinear: boolean;
	showAzureDevOpsToken: boolean;
	setShowAzureDevOpsToken: React.Dispatch<React.SetStateAction<boolean>>;
	azureDevOpsConnectionStatus: AzureDevOpsSyncStatus | null;
	isCheckingAzureDevOps: boolean;
	handleInitialize: () => Promise<void>;
	onOpenLinearImport: () => void;
	onOpenAzureDevOpsImport: () => void;
}

/**
 * Routes to the appropriate settings section based on activeSection.
 * Handles initialization guards and section-specific configurations.
 */
export function SectionRouter({
	activeSection,
	project,
	settings,
	setSettings,
	versionInfo,
	isCheckingVersion,
	isUpdating,
	envConfig,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	isLoadingEnv,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	envError,
	updateEnvConfig,
	showLinearKey,
	setShowLinearKey,
	showOpenAIKey,
	setShowOpenAIKey,
	showGitHubToken,
	setShowGitHubToken,
	gitHubConnectionStatus,
	isCheckingGitHub,
	showGitLabToken,
	setShowGitLabToken,
	gitLabConnectionStatus,
	isCheckingGitLab,
	linearConnectionStatus,
	isCheckingLinear,
	showAzureDevOpsToken,
	setShowAzureDevOpsToken,
	azureDevOpsConnectionStatus,
	isCheckingAzureDevOps,
	handleInitialize,
	onOpenLinearImport,
	onOpenAzureDevOpsImport,
}: SectionRouterProps) {
	const { t } = useTranslation("settings");

	switch (activeSection) {
		case "general":
			return (
				<SettingsSection
					title={t("projectSections.general.title")}
					description={t("projectSections.general.configureFor", {
						projectName: project.name,
					})}
				>
					<GeneralSettings
						project={project}
						settings={settings}
						setSettings={setSettings}
						versionInfo={versionInfo}
						isCheckingVersion={isCheckingVersion}
						isUpdating={isUpdating}
						handleInitialize={handleInitialize}
					/>
				</SettingsSection>
			);

		case "linear":
			return (
				<SettingsSection
					title={t("projectSections.linear.integrationTitle")}
					description={t("projectSections.linear.integrationDescription")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("projectSections.linear.integrationTitle")}
						description={t("projectSections.linear.syncDescription")}
					>
						<LinearIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
							showLinearKey={showLinearKey}
							setShowLinearKey={setShowLinearKey}
							linearConnectionStatus={linearConnectionStatus}
							isCheckingLinear={isCheckingLinear}
							onOpenLinearImport={onOpenLinearImport}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "github":
			return (
				<SettingsSection
					title={t("projectSections.github.integrationTitle")}
					description={t("projectSections.github.integrationDescription")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("projectSections.github.integrationTitle")}
						description={t("projectSections.github.syncDescription")}
					>
						<GitHubIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
							showGitHubToken={showGitHubToken}
							setShowGitHubToken={setShowGitHubToken}
							gitHubConnectionStatus={gitHubConnectionStatus}
							isCheckingGitHub={isCheckingGitHub}
							projectPath={project.path}
							settings={settings}
							setSettings={setSettings}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "gitlab":
			return (
				<SettingsSection
					title={t("projectSections.gitlab.integrationTitle")}
					description={t("projectSections.gitlab.integrationDescription")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("projectSections.gitlab.integrationTitle")}
						description={t("projectSections.gitlab.syncDescription")}
					>
						<GitLabIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
							showGitLabToken={showGitLabToken}
							setShowGitLabToken={setShowGitLabToken}
							gitLabConnectionStatus={gitLabConnectionStatus}
							isCheckingGitLab={isCheckingGitLab}
							projectPath={project.path}
							settings={settings}
							setSettings={setSettings}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "azure-devops":
			return (
				<SettingsSection
					title="Azure DevOps Integration"
					description="Configure and manage Azure DevOps work item synchronization"
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title="Azure DevOps Integration"
						description="Enable Azure DevOps integration to sync work items with your backlog"
					>
						<AzureDevOpsIntegration
							projectId={project.id}
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
							showAzureDevOpsPat={showAzureDevOpsToken}
							setShowAzureDevOpsPat={setShowAzureDevOpsToken}
							azureDevOpsConnectionStatus={azureDevOpsConnectionStatus}
							isCheckingAzureDevOps={isCheckingAzureDevOps}
							onOpenAzureDevOpsImport={onOpenAzureDevOpsImport}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "cicd":
			return (
				<SettingsSection
					title={t("cicd.title")}
					description={t("cicd.description")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("cicd.title")}
						description={t("cicd.initGuardDescription")}
					>
						<CICDPipelineIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "jira":
			return (
				<SettingsSection
					title={t("jira.title")}
					description={t("jira.description")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("jira.title")}
						description="Enable Jira integration to sync issues with your backlog"
					>
						<JiraIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
							showJiraToken={showAzureDevOpsToken}
							setShowJiraToken={setShowAzureDevOpsToken}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "teams":
			return (
				<SettingsSection
					title={t("settings:channelNotifications.title")}
					description={t("settings:channelNotifications.description")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("settings:channelNotifications.title")}
						description={t("settings:channelNotifications.initGuardDescription")}
					>
						<ChannelNotificationsIntegration
							envConfig={envConfig}
							updateEnvConfig={updateEnvConfig}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		case "memory":
			return (
				<SettingsSection
					title={t("projectSections.memory.integrationTitle")}
					description={t("projectSections.memory.integrationDescription")}
				>
					<InitializationGuard
						initialized={!!project.autoBuildPath}
						title={t("projectSections.memory.integrationTitle")}
						description={t("projectSections.memory.syncDescription")}
					>
						<SecuritySettings
							envConfig={envConfig}
							settings={settings}
							setSettings={setSettings}
							updateEnvConfig={updateEnvConfig}
							projectPath={project.path}
							showOpenAIKey={showOpenAIKey}
							setShowOpenAIKey={setShowOpenAIKey}
							expanded={true}
							onToggle={() => {
								/* noop */
							}}
						/>
					</InitializationGuard>
				</SettingsSection>
			);

		default:
			return null;
	}
}
