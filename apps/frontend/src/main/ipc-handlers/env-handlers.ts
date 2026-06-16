import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_APP_SETTINGS, IPC_CHANNELS } from "../../shared/constants";
import type {
	AppSettings,
	ClaudeAuthResult,
	IPCResult,
	ProjectEnvConfig,
} from "../../shared/types";
import { debugError } from "../../shared/utils/debug-logger";
import {
	getClaudeCliInvocation,
	getClaudeCliInvocationAsync,
} from "../claude-cli-utils";
import { app, type BrowserWindow, ipcMain } from "../electron-utils";
import { getSpawnCommand, getSpawnOptions } from "../env-utils";
import { projectStore } from "../project-store";
import { parseEnvFile } from "./utils";

// GitLab environment variable keys
const GITLAB_ENV_KEYS = {
	ENABLED: "GITLAB_ENABLED",
	TOKEN: "GITLAB_TOKEN",
	INSTANCE_URL: "GITLAB_INSTANCE_URL",
	PROJECT: "GITLAB_PROJECT",
	AUTO_SYNC: "GITLAB_AUTO_SYNC",
} as const;

// Azure DevOps environment variable keys
const AZURE_DEVOPS_ENV_KEYS = {
	ENABLED: "AZURE_DEVOPS_ENABLED",
	PAT: "AZURE_DEVOPS_PAT",
	ORG_URL: "AZURE_DEVOPS_ORG_URL",
	PROJECT: "AZURE_DEVOPS_PROJECT",
	REPOSITORY: "AZURE_DEVOPS_REPOSITORY",
	AUTO_SYNC: "AZURE_DEVOPS_AUTO_SYNC",
} as const;

// Jira environment variable keys
const JIRA_ENV_KEYS = {
	ENABLED: "JIRA_ENABLED",
	INSTANCE_URL: "JIRA_INSTANCE_URL",
	EMAIL: "JIRA_EMAIL",
	API_TOKEN: "JIRA_API_TOKEN",
	PROJECT_KEY: "JIRA_PROJECT_KEY",
	AUTO_SYNC: "JIRA_AUTO_SYNC",
} as const;

// Microsoft Teams environment variable keys
const TEAMS_ENV_KEYS = {
	ENABLED: "TEAMS_NOTIFICATIONS_ENABLED",
	WEBHOOK_URL: "TEAMS_WEBHOOK_URL",
} as const;

// Slack notification environment variable keys
const SLACK_ENV_KEYS = {
	ENABLED: "SLACK_NOTIFICATIONS_ENABLED",
	WEBHOOK_URL: "SLACK_WEBHOOK_URL",
} as const;

// Discord notification environment variable keys
const DISCORD_ENV_KEYS = {
	ENABLED: "DISCORD_NOTIFICATIONS_ENABLED",
	WEBHOOK_URL: "DISCORD_WEBHOOK_URL",
} as const;

// Google Chat notification environment variable keys
const GOOGLE_CHAT_ENV_KEYS = {
	ENABLED: "GOOGLE_CHAT_NOTIFICATIONS_ENABLED",
	WEBHOOK_URL: "GOOGLE_CHAT_WEBHOOK_URL",
} as const;

// Generic webhook notification environment variable keys
const NOTIFY_WEBHOOK_ENV_KEYS = {
	ENABLED: "NOTIFY_WEBHOOK_ENABLED",
	WEBHOOK_URL: "NOTIFY_WEBHOOK_URL",
} as const;

// CI/CD pipeline loop environment variable keys (« Build rouge »)
// Read by ci-pipeline-service.ts / ci-pipeline-providers.ts. Azure DevOps,
// GitHub and GitLab credentials are reused from their own sections above.
const CICD_ENV_KEYS = {
	PROVIDER: "CICD_PROVIDER",
	AUTO_FIX: "CICD_AUTO_FIX",
	POLL_SECONDS: "CICD_POLL_SECONDS",
	JENKINS_URL: "CICD_JENKINS_URL",
	JENKINS_JOB: "CICD_JENKINS_JOB",
	JENKINS_USER: "CICD_JENKINS_USER",
	JENKINS_TOKEN: "CICD_JENKINS_TOKEN",
} as const;

/**
 * Helper to generate .env line (DRY)
 * Uses explicit undefined/null check instead of truthiness to avoid
 * commenting out values that are empty strings (e.g., from cleared inputs).
 */
function envLine(
	vars: Record<string, string>,
	key: string,
	defaultVal: string = "",
): string {
	return vars[key] != null && vars[key] !== ""
		? `${key}=${vars[key]}`
		: `# ${key}=${defaultVal}`;
}

type ResolvedClaudeCliInvocation =
	| { command: string; env: Record<string, string> }
	| { error: string };

function _resolveClaudeCliInvocation(): ResolvedClaudeCliInvocation {
	try {
		const invocation = getClaudeCliInvocation();
		if (!invocation?.command) {
			throw new Error("Claude CLI path not resolved");
		}
		return { command: invocation.command, env: invocation.env };
	} catch (error) {
		debugError("[IPC] Failed to resolve Claude CLI path:", error);
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to resolve Claude CLI path",
		};
	}
}

/**
 * Async version of resolveClaudeCliInvocation - non-blocking for main process
 */
async function resolveClaudeCliInvocationAsync(): Promise<ResolvedClaudeCliInvocation> {
	try {
		const invocation = await getClaudeCliInvocationAsync();
		if (!invocation?.command) {
			throw new Error("Claude CLI path not resolved");
		}
		return { command: invocation.command, env: invocation.env };
	} catch (error) {
		debugError("[IPC] Failed to resolve Claude CLI path:", error);
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to resolve Claude CLI path",
		};
	}
}

/**
 * Register all env-related IPC handlers
 */
export function registerEnvHandlers(
	_getMainWindow: () => BrowserWindow | null,
): void {
	// ============================================
	// Environment Configuration Operations
	// ============================================

	// Get settings file path
	const settingsPath = path.join(app.getPath("userData"), "settings.json");

	/**
	 * Generate .env file content from config
	 */
	const generateEnvContent = (
		config: Partial<ProjectEnvConfig>,
		existingContent?: string,
	): string => {
		// Parse existing content to preserve comments and structure
		const existingVars = existingContent ? parseEnvFile(existingContent) : {};

		// Update with new values
		if (config.claudeOAuthToken !== undefined) {
			existingVars.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOAuthToken;
		}
		if (config.autoBuildModel !== undefined) {
			existingVars.AUTO_BUILD_MODEL = config.autoBuildModel;
		}
		if (config.linearEnabled !== undefined) {
			existingVars.LINEAR_ENABLED = config.linearEnabled ? "true" : "false";
		}
		// Guard: don't overwrite existing non-empty values with empty strings
		if (
			config.linearApiKey !== undefined &&
			(config.linearApiKey || !existingVars.LINEAR_API_KEY)
		) {
			existingVars.LINEAR_API_KEY = config.linearApiKey;
		}
		if (
			config.linearTeamId !== undefined &&
			(config.linearTeamId || !existingVars.LINEAR_TEAM_ID)
		) {
			existingVars.LINEAR_TEAM_ID = config.linearTeamId;
		}
		if (
			config.linearProjectId !== undefined &&
			(config.linearProjectId || !existingVars.LINEAR_PROJECT_ID)
		) {
			existingVars.LINEAR_PROJECT_ID = config.linearProjectId;
		}
		if (config.linearRealtimeSync !== undefined) {
			existingVars.LINEAR_REALTIME_SYNC = config.linearRealtimeSync
				? "true"
				: "false";
		}
		// GitHub Integration
		if (config.githubEnabled !== undefined) {
			existingVars.GITHUB_ENABLED = config.githubEnabled ? "true" : "false";
		}
		// Guard: don't overwrite existing non-empty values with empty strings
		if (
			config.githubToken !== undefined &&
			(config.githubToken || !existingVars.GITHUB_TOKEN)
		) {
			existingVars.GITHUB_TOKEN = config.githubToken;
		}
		if (
			config.githubRepo !== undefined &&
			(config.githubRepo || !existingVars.GITHUB_REPO)
		) {
			existingVars.GITHUB_REPO = config.githubRepo;
		}
		if (config.githubAutoSync !== undefined) {
			existingVars.GITHUB_AUTO_SYNC = config.githubAutoSync ? "true" : "false";
		}
		// GitLab Integration
		// Guard: don't overwrite existing non-empty values with empty strings
		if (config.gitlabEnabled !== undefined) {
			existingVars[GITLAB_ENV_KEYS.ENABLED] = config.gitlabEnabled
				? "true"
				: "false";
		}
		if (
			config.gitlabToken !== undefined &&
			(config.gitlabToken || !existingVars[GITLAB_ENV_KEYS.TOKEN])
		) {
			existingVars[GITLAB_ENV_KEYS.TOKEN] = config.gitlabToken;
		}
		if (
			config.gitlabInstanceUrl !== undefined &&
			(config.gitlabInstanceUrl || !existingVars[GITLAB_ENV_KEYS.INSTANCE_URL])
		) {
			existingVars[GITLAB_ENV_KEYS.INSTANCE_URL] = config.gitlabInstanceUrl;
		}
		if (
			config.gitlabProject !== undefined &&
			(config.gitlabProject || !existingVars[GITLAB_ENV_KEYS.PROJECT])
		) {
			existingVars[GITLAB_ENV_KEYS.PROJECT] = config.gitlabProject;
		}
		if (config.gitlabAutoSync !== undefined) {
			existingVars[GITLAB_ENV_KEYS.AUTO_SYNC] = config.gitlabAutoSync
				? "true"
				: "false";
		}

		// Azure DevOps Integration
		// Guard: don't overwrite existing non-empty values with empty strings.
		// This prevents data loss when partial configs are sent (e.g., from auto-detection).
		if (config.azureDevOpsEnabled !== undefined) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] = config.azureDevOpsEnabled
				? "true"
				: "false";
			// Enable auto-sync by default when Azure DevOps is enabled
			if (
				config.azureDevOpsEnabled &&
				config.azureDevOpsAutoSync === undefined
			) {
				existingVars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC] = "true";
			}
		}
		if (
			config.azureDevOpsPat !== undefined &&
			(config.azureDevOpsPat || !existingVars[AZURE_DEVOPS_ENV_KEYS.PAT])
		) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.PAT] = config.azureDevOpsPat;
		}
		if (
			config.azureDevOpsOrgUrl !== undefined &&
			(config.azureDevOpsOrgUrl || !existingVars[AZURE_DEVOPS_ENV_KEYS.ORG_URL])
		) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.ORG_URL] = config.azureDevOpsOrgUrl;
		}
		if (
			config.azureDevOpsProject !== undefined &&
			(config.azureDevOpsProject ||
				!existingVars[AZURE_DEVOPS_ENV_KEYS.PROJECT])
		) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.PROJECT] = config.azureDevOpsProject;
		}
		if (
			config.azureDevOpsRepository !== undefined &&
			(config.azureDevOpsRepository ||
				!existingVars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY])
		) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY] =
				config.azureDevOpsRepository;
		}
		if (config.azureDevOpsAutoSync !== undefined) {
			existingVars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC] = config.azureDevOpsAutoSync
				? "true"
				: "false";
		}

		// Jira Integration
		// Guard: don't overwrite existing non-empty values with empty strings
		if (config.jiraEnabled !== undefined) {
			existingVars[JIRA_ENV_KEYS.ENABLED] = config.jiraEnabled
				? "true"
				: "false";
		}
		if (
			config.jiraInstanceUrl !== undefined &&
			(config.jiraInstanceUrl || !existingVars[JIRA_ENV_KEYS.INSTANCE_URL])
		) {
			existingVars[JIRA_ENV_KEYS.INSTANCE_URL] = config.jiraInstanceUrl;
		}
		if (
			config.jiraEmail !== undefined &&
			(config.jiraEmail || !existingVars[JIRA_ENV_KEYS.EMAIL])
		) {
			existingVars[JIRA_ENV_KEYS.EMAIL] = config.jiraEmail;
		}
		if (
			config.jiraApiToken !== undefined &&
			(config.jiraApiToken || !existingVars[JIRA_ENV_KEYS.API_TOKEN])
		) {
			existingVars[JIRA_ENV_KEYS.API_TOKEN] = config.jiraApiToken;
		}
		if (
			config.jiraProjectKey !== undefined &&
			(config.jiraProjectKey || !existingVars[JIRA_ENV_KEYS.PROJECT_KEY])
		) {
			existingVars[JIRA_ENV_KEYS.PROJECT_KEY] = config.jiraProjectKey;
		}
		if (config.jiraAutoSync !== undefined) {
			existingVars[JIRA_ENV_KEYS.AUTO_SYNC] = config.jiraAutoSync
				? "true"
				: "false";
		}
		// CI/CD pipeline loop (« Build rouge »)
		if (config.cicdProvider !== undefined) {
			existingVars[CICD_ENV_KEYS.PROVIDER] = config.cicdProvider;
		}
		if (config.cicdAutoFix !== undefined) {
			existingVars[CICD_ENV_KEYS.AUTO_FIX] = config.cicdAutoFix
				? "true"
				: "false";
		}
		if (config.cicdPollSeconds !== undefined) {
			existingVars[CICD_ENV_KEYS.POLL_SECONDS] = config.cicdPollSeconds
				? String(config.cicdPollSeconds)
				: "";
		}
		if (
			config.cicdJenkinsUrl !== undefined &&
			(config.cicdJenkinsUrl || !existingVars[CICD_ENV_KEYS.JENKINS_URL])
		) {
			existingVars[CICD_ENV_KEYS.JENKINS_URL] = config.cicdJenkinsUrl;
		}
		if (
			config.cicdJenkinsJob !== undefined &&
			(config.cicdJenkinsJob || !existingVars[CICD_ENV_KEYS.JENKINS_JOB])
		) {
			existingVars[CICD_ENV_KEYS.JENKINS_JOB] = config.cicdJenkinsJob;
		}
		if (config.cicdJenkinsUser !== undefined) {
			existingVars[CICD_ENV_KEYS.JENKINS_USER] = config.cicdJenkinsUser;
		}
		// Guard: don't overwrite an existing token with an empty string
		if (
			config.cicdJenkinsToken !== undefined &&
			(config.cicdJenkinsToken || !existingVars[CICD_ENV_KEYS.JENKINS_TOKEN])
		) {
			existingVars[CICD_ENV_KEYS.JENKINS_TOKEN] = config.cicdJenkinsToken;
		}
		// Channel Notifications (Teams / Slack / Discord / Google Chat / webhook)
		// Guard: don't overwrite existing non-empty webhook URLs with empty strings
		if (config.teamsNotificationsEnabled !== undefined) {
			existingVars[TEAMS_ENV_KEYS.ENABLED] = config.teamsNotificationsEnabled
				? "true"
				: "false";
		}
		if (
			config.teamsWebhookUrl !== undefined &&
			(config.teamsWebhookUrl || !existingVars[TEAMS_ENV_KEYS.WEBHOOK_URL])
		) {
			existingVars[TEAMS_ENV_KEYS.WEBHOOK_URL] = config.teamsWebhookUrl;
		}
		if (config.slackNotificationsEnabled !== undefined) {
			existingVars[SLACK_ENV_KEYS.ENABLED] = config.slackNotificationsEnabled
				? "true"
				: "false";
		}
		if (
			config.slackWebhookUrl !== undefined &&
			(config.slackWebhookUrl || !existingVars[SLACK_ENV_KEYS.WEBHOOK_URL])
		) {
			existingVars[SLACK_ENV_KEYS.WEBHOOK_URL] = config.slackWebhookUrl;
		}
		if (config.discordNotificationsEnabled !== undefined) {
			existingVars[DISCORD_ENV_KEYS.ENABLED] = config.discordNotificationsEnabled
				? "true"
				: "false";
		}
		if (
			config.discordWebhookUrl !== undefined &&
			(config.discordWebhookUrl || !existingVars[DISCORD_ENV_KEYS.WEBHOOK_URL])
		) {
			existingVars[DISCORD_ENV_KEYS.WEBHOOK_URL] = config.discordWebhookUrl;
		}
		if (config.googleChatNotificationsEnabled !== undefined) {
			existingVars[GOOGLE_CHAT_ENV_KEYS.ENABLED] =
				config.googleChatNotificationsEnabled ? "true" : "false";
		}
		if (
			config.googleChatWebhookUrl !== undefined &&
			(config.googleChatWebhookUrl ||
				!existingVars[GOOGLE_CHAT_ENV_KEYS.WEBHOOK_URL])
		) {
			existingVars[GOOGLE_CHAT_ENV_KEYS.WEBHOOK_URL] =
				config.googleChatWebhookUrl;
		}
		if (config.notifyWebhookEnabled !== undefined) {
			existingVars[NOTIFY_WEBHOOK_ENV_KEYS.ENABLED] = config.notifyWebhookEnabled
				? "true"
				: "false";
		}
		if (
			config.notifyWebhookUrl !== undefined &&
			(config.notifyWebhookUrl ||
				!existingVars[NOTIFY_WEBHOOK_ENV_KEYS.WEBHOOK_URL])
		) {
			existingVars[NOTIFY_WEBHOOK_ENV_KEYS.WEBHOOK_URL] = config.notifyWebhookUrl;
		}
		// Git/Worktree Settings
		if (config.defaultBranch !== undefined) {
			existingVars.DEFAULT_BRANCH = config.defaultBranch;
		}
		if (config.graphitiEnabled !== undefined) {
			existingVars.GRAPHITI_ENABLED = config.graphitiEnabled ? "true" : "false";
		}
		// Memory Provider Configuration
		if (config.graphitiProviderConfig) {
			const pc = config.graphitiProviderConfig;
			if (pc.embeddingProvider)
				existingVars.GRAPHITI_EMBEDDER_PROVIDER = pc.embeddingProvider;
			// graphiti-core needs an LLM to ingest episodes (entity extraction).
			// Derive it from the embedding provider; for Ollama this keeps the
			// whole memory stack local.
			if (pc.embeddingProvider === "ollama" && pc.ollamaLlmModel) {
				existingVars.GRAPHITI_LLM_PROVIDER = "ollama";
				existingVars.OLLAMA_LLM_MODEL = pc.ollamaLlmModel;
			} else if (pc.embeddingProvider === "openai" && pc.openaiApiKey) {
				existingVars.GRAPHITI_LLM_PROVIDER = "openai";
			} else if (pc.embeddingProvider === "google" && pc.googleApiKey) {
				existingVars.GRAPHITI_LLM_PROVIDER = "google";
			} else if (pc.embeddingProvider === "openrouter" && pc.openrouterApiKey) {
				existingVars.GRAPHITI_LLM_PROVIDER = "openrouter";
			}
			// OpenAI Embeddings
			if (pc.openaiApiKey) existingVars.OPENAI_API_KEY = pc.openaiApiKey;
			if (pc.openaiEmbeddingModel)
				existingVars.OPENAI_EMBEDDING_MODEL = pc.openaiEmbeddingModel;
			// Azure OpenAI Embeddings
			if (pc.azureOpenaiApiKey)
				existingVars.AZURE_OPENAI_API_KEY = pc.azureOpenaiApiKey;
			if (pc.azureOpenaiBaseUrl)
				existingVars.AZURE_OPENAI_BASE_URL = pc.azureOpenaiBaseUrl;
			if (pc.azureOpenaiEmbeddingDeployment)
				existingVars.AZURE_OPENAI_EMBEDDING_DEPLOYMENT =
					pc.azureOpenaiEmbeddingDeployment;
			// Voyage Embeddings
			if (pc.voyageApiKey) existingVars.VOYAGE_API_KEY = pc.voyageApiKey;
			if (pc.voyageEmbeddingModel)
				existingVars.VOYAGE_EMBEDDING_MODEL = pc.voyageEmbeddingModel;
			// Google Embeddings
			if (pc.googleApiKey) existingVars.GOOGLE_API_KEY = pc.googleApiKey;
			if (pc.googleEmbeddingModel)
				existingVars.GOOGLE_EMBEDDING_MODEL = pc.googleEmbeddingModel;
			// Ollama Embeddings
			if (pc.ollamaBaseUrl) existingVars.OLLAMA_BASE_URL = pc.ollamaBaseUrl;
			if (pc.ollamaEmbeddingModel)
				existingVars.OLLAMA_EMBEDDING_MODEL = pc.ollamaEmbeddingModel;
			if (pc.ollamaEmbeddingDim)
				existingVars.OLLAMA_EMBEDDING_DIM = String(pc.ollamaEmbeddingDim);
			// LadybugDB (embedded database)
			if (pc.dbPath) existingVars.GRAPHITI_DB_PATH = pc.dbPath;
			if (pc.database) existingVars.GRAPHITI_DATABASE = pc.database;
		}
		// Legacy fields (still supported)
		if (config.openaiApiKey !== undefined) {
			existingVars.OPENAI_API_KEY = config.openaiApiKey;
		}
		if (config.graphitiDatabase !== undefined) {
			existingVars.GRAPHITI_DATABASE = config.graphitiDatabase;
		}
		if (config.graphitiDbPath !== undefined) {
			existingVars.GRAPHITI_DB_PATH = config.graphitiDbPath;
		}
		if (config.enableFancyUi !== undefined) {
			existingVars.ENABLE_FANCY_UI = config.enableFancyUi ? "true" : "false";
		}

		// MCP Server Configuration
		if (config.mcpServers) {
			if (config.mcpServers.context7Enabled !== undefined) {
				existingVars.CONTEXT7_ENABLED = config.mcpServers.context7Enabled
					? "true"
					: "false";
			}
			if (config.mcpServers.linearMcpEnabled !== undefined) {
				existingVars.LINEAR_MCP_ENABLED = config.mcpServers.linearMcpEnabled
					? "true"
					: "false";
			}
			if (config.mcpServers.electronEnabled !== undefined) {
				existingVars.ELECTRON_MCP_ENABLED = config.mcpServers.electronEnabled
					? "true"
					: "false";
			}
			if (config.mcpServers.puppeteerEnabled !== undefined) {
				existingVars.PUPPETEER_MCP_ENABLED = config.mcpServers.puppeteerEnabled
					? "true"
					: "false";
			}
			if (config.mcpServers.chromeDevtoolsEnabled !== undefined) {
				existingVars.CHROME_DEVTOOLS_MCP_ENABLED = config.mcpServers
					.chromeDevtoolsEnabled
					? "true"
					: "false";
			}
			// Note: graphitiEnabled is already handled via GRAPHITI_ENABLED above
		}

		// Per-agent MCP overrides (add/remove MCPs from specific agents)
		if (config.agentMcpOverrides) {
			// First, clear any existing AGENT_MCP_* entries
			Object.keys(existingVars).forEach((key) => {
				if (key.startsWith("AGENT_MCP_")) {
					delete existingVars[key];
				}
			});

			// Add new overrides
			Object.entries(config.agentMcpOverrides).forEach(
				([agentId, override]) => {
					if (override.add && override.add.length > 0) {
						existingVars[`AGENT_MCP_${agentId}_ADD`] = override.add.join(",");
					}
					if (override.remove && override.remove.length > 0) {
						existingVars[`AGENT_MCP_${agentId}_REMOVE`] =
							override.remove.join(",");
					}
				},
			);
		}

		// Custom MCP servers (user-defined)
		if (config.customMcpServers !== undefined) {
			if (config.customMcpServers.length > 0) {
				existingVars.CUSTOM_MCP_SERVERS = JSON.stringify(
					config.customMcpServers,
				);
			} else {
				delete existingVars.CUSTOM_MCP_SERVERS;
			}
		}

		// Generate content with sections
		const content = `# WorkPilot AI Framework Environment Variables
# Managed by WorkPilot AI UI

# Claude Code OAuth Token (REQUIRED)
CLAUDE_CODE_OAUTH_TOKEN=${existingVars.CLAUDE_CODE_OAUTH_TOKEN || ""}

# Model override (OPTIONAL)
${existingVars.AUTO_BUILD_MODEL ? `AUTO_BUILD_MODEL=${existingVars.AUTO_BUILD_MODEL}` : "# AUTO_BUILD_MODEL=claude-opus-4-5-20251101"}

# =============================================================================
# LINEAR INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars.LINEAR_ENABLED ? `LINEAR_ENABLED=${existingVars.LINEAR_ENABLED}` : "# LINEAR_ENABLED=false"}
${existingVars.LINEAR_API_KEY ? `LINEAR_API_KEY=${existingVars.LINEAR_API_KEY}` : "# LINEAR_API_KEY="}
${existingVars.LINEAR_TEAM_ID ? `LINEAR_TEAM_ID=${existingVars.LINEAR_TEAM_ID}` : "# LINEAR_TEAM_ID="}
${existingVars.LINEAR_PROJECT_ID ? `LINEAR_PROJECT_ID=${existingVars.LINEAR_PROJECT_ID}` : "# LINEAR_PROJECT_ID="}
${existingVars.LINEAR_REALTIME_SYNC ? `LINEAR_REALTIME_SYNC=${existingVars.LINEAR_REALTIME_SYNC}` : "# LINEAR_REALTIME_SYNC=false"}

# =============================================================================
# GITHUB INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars.GITHUB_ENABLED ? `GITHUB_ENABLED=${existingVars.GITHUB_ENABLED}` : "# GITHUB_ENABLED=false"}
${existingVars.GITHUB_TOKEN ? `GITHUB_TOKEN=${existingVars.GITHUB_TOKEN}` : "# GITHUB_TOKEN="}
${existingVars.GITHUB_REPO ? `GITHUB_REPO=${existingVars.GITHUB_REPO}` : "# GITHUB_REPO=owner/repo"}
${existingVars.GITHUB_AUTO_SYNC ? `GITHUB_AUTO_SYNC=${existingVars.GITHUB_AUTO_SYNC}` : "# GITHUB_AUTO_SYNC=false"}

# =============================================================================
# GITLAB INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[GITLAB_ENV_KEYS.ENABLED] ? `${GITLAB_ENV_KEYS.ENABLED}=${existingVars[GITLAB_ENV_KEYS.ENABLED]}` : `# ${GITLAB_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, GITLAB_ENV_KEYS.INSTANCE_URL, "https://gitlab.com")}
${envLine(existingVars, GITLAB_ENV_KEYS.TOKEN)}
${envLine(existingVars, GITLAB_ENV_KEYS.PROJECT, "group/project")}
${envLine(existingVars, GITLAB_ENV_KEYS.AUTO_SYNC, "false")}


# =============================================================================
# AZURE DEVOPS INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] ? `${AZURE_DEVOPS_ENV_KEYS.ENABLED}=${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED]}` : `# ${AZURE_DEVOPS_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.ORG_URL, "https://dev.azure.com/your-org")}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.PAT)}
${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] === "true" ? `${AZURE_DEVOPS_ENV_KEYS.PROJECT}=${existingVars[AZURE_DEVOPS_ENV_KEYS.PROJECT] || ""}` : envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.PROJECT, "MyProject")}
${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] === "true" ? `${AZURE_DEVOPS_ENV_KEYS.REPOSITORY}=${existingVars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY] || ""}` : envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.REPOSITORY, "MyRepository")}
${existingVars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC] ? `${AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC}=${existingVars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC]}` : `# ${AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC}=false`}

# =============================================================================
# JIRA INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[JIRA_ENV_KEYS.ENABLED] ? `${JIRA_ENV_KEYS.ENABLED}=${existingVars[JIRA_ENV_KEYS.ENABLED]}` : `# ${JIRA_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, JIRA_ENV_KEYS.INSTANCE_URL, "https://your-domain.atlassian.net")}
${envLine(existingVars, JIRA_ENV_KEYS.EMAIL)}
${envLine(existingVars, JIRA_ENV_KEYS.API_TOKEN)}
${envLine(existingVars, JIRA_ENV_KEYS.PROJECT_KEY, "PROJ")}
${existingVars[JIRA_ENV_KEYS.AUTO_SYNC] ? `${JIRA_ENV_KEYS.AUTO_SYNC}=${existingVars[JIRA_ENV_KEYS.AUTO_SYNC]}` : `# ${JIRA_ENV_KEYS.AUTO_SYNC}=false`}

# =============================================================================
# CI/CD PIPELINE LOOP (OPTIONAL) — « Build rouge » column + auto-repair
# Provider: azure | github | gitlab | jenkins | none (empty = auto-detect).
# Azure/GitHub/GitLab credentials are reused from their sections above.
# =============================================================================
${envLine(existingVars, CICD_ENV_KEYS.PROVIDER, "azure")}
${existingVars[CICD_ENV_KEYS.AUTO_FIX] ? `${CICD_ENV_KEYS.AUTO_FIX}=${existingVars[CICD_ENV_KEYS.AUTO_FIX]}` : `# ${CICD_ENV_KEYS.AUTO_FIX}=true`}
${envLine(existingVars, CICD_ENV_KEYS.POLL_SECONDS, "60")}
${envLine(existingVars, CICD_ENV_KEYS.JENKINS_URL, "https://jenkins.example.com")}
${envLine(existingVars, CICD_ENV_KEYS.JENKINS_JOB, "my-multibranch-job")}
${envLine(existingVars, CICD_ENV_KEYS.JENKINS_USER)}
${envLine(existingVars, CICD_ENV_KEYS.JENKINS_TOKEN)}

# =============================================================================
# CHANNEL NOTIFICATIONS (OPTIONAL)
# Announce on your channels when a task is done and its PR is created.
# Each channel needs a webhook URL (Incoming Webhook / channel webhook).
# =============================================================================
# Microsoft Teams
${existingVars[TEAMS_ENV_KEYS.ENABLED] ? `${TEAMS_ENV_KEYS.ENABLED}=${existingVars[TEAMS_ENV_KEYS.ENABLED]}` : `# ${TEAMS_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, TEAMS_ENV_KEYS.WEBHOOK_URL, "https://xxx.webhook.office.com/webhookb2/...")}
# Slack
${existingVars[SLACK_ENV_KEYS.ENABLED] ? `${SLACK_ENV_KEYS.ENABLED}=${existingVars[SLACK_ENV_KEYS.ENABLED]}` : `# ${SLACK_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, SLACK_ENV_KEYS.WEBHOOK_URL, "https://hooks.slack.com/services/...")}
# Discord
${existingVars[DISCORD_ENV_KEYS.ENABLED] ? `${DISCORD_ENV_KEYS.ENABLED}=${existingVars[DISCORD_ENV_KEYS.ENABLED]}` : `# ${DISCORD_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, DISCORD_ENV_KEYS.WEBHOOK_URL, "https://discord.com/api/webhooks/...")}
# Google Chat
${existingVars[GOOGLE_CHAT_ENV_KEYS.ENABLED] ? `${GOOGLE_CHAT_ENV_KEYS.ENABLED}=${existingVars[GOOGLE_CHAT_ENV_KEYS.ENABLED]}` : `# ${GOOGLE_CHAT_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, GOOGLE_CHAT_ENV_KEYS.WEBHOOK_URL, "https://chat.googleapis.com/v1/spaces/...")}
# Generic webhook (flat JSON POST)
${existingVars[NOTIFY_WEBHOOK_ENV_KEYS.ENABLED] ? `${NOTIFY_WEBHOOK_ENV_KEYS.ENABLED}=${existingVars[NOTIFY_WEBHOOK_ENV_KEYS.ENABLED]}` : `# ${NOTIFY_WEBHOOK_ENV_KEYS.ENABLED}=false`}
${envLine(existingVars, NOTIFY_WEBHOOK_ENV_KEYS.WEBHOOK_URL, "https://example.com/webhook")}

# =============================================================================
# GIT/WORKTREE SETTINGS (OPTIONAL)
# =============================================================================
# Default base branch for worktree creation
# If not set, WorkPilot AI will auto-detect main/master, or fall back to current branch
${existingVars.DEFAULT_BRANCH ? `DEFAULT_BRANCH=${existingVars.DEFAULT_BRANCH}` : "# DEFAULT_BRANCH=main"}

# =============================================================================
# UI SETTINGS (OPTIONAL)
# =============================================================================
${existingVars.ENABLE_FANCY_UI ? `ENABLE_FANCY_UI=${existingVars.ENABLE_FANCY_UI}` : "# ENABLE_FANCY_UI=true"}

# =============================================================================
# MCP SERVER CONFIGURATION (per-project overrides)
# =============================================================================
# Context7 documentation lookup (default: enabled)
${existingVars.CONTEXT7_ENABLED ? `CONTEXT7_ENABLED=${existingVars.CONTEXT7_ENABLED}` : "# CONTEXT7_ENABLED=true"}
# Linear MCP integration (default: follows LINEAR_API_KEY)
${existingVars.LINEAR_MCP_ENABLED ? `LINEAR_MCP_ENABLED=${existingVars.LINEAR_MCP_ENABLED}` : "# LINEAR_MCP_ENABLED=true"}
# Electron desktop automation - QA agents only (default: disabled)
${existingVars.ELECTRON_MCP_ENABLED ? `ELECTRON_MCP_ENABLED=${existingVars.ELECTRON_MCP_ENABLED}` : "# ELECTRON_MCP_ENABLED=false"}
# Puppeteer browser automation - QA agents only (default: disabled)
${existingVars.PUPPETEER_MCP_ENABLED ? `PUPPETEER_MCP_ENABLED=${existingVars.PUPPETEER_MCP_ENABLED}` : "# PUPPETEER_MCP_ENABLED=false"}

# =============================================================================
# PER-AGENT MCP OVERRIDES
# Add or remove MCP servers for specific agents
# Format: AGENT_MCP_<agent_type>_ADD=server1,server2
# Format: AGENT_MCP_<agent_type>_REMOVE=server1,server2
# =============================================================================
${
	Object.entries(existingVars)
		.filter(([key]) => key.startsWith("AGENT_MCP_"))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n") || "# No per-agent overrides configured"
}

# =============================================================================
# CUSTOM MCP SERVERS
# User-defined MCP servers (command-based or HTTP-based)
# JSON format: [{"id":"...","name":"...","type":"command|http",...}]
# =============================================================================
${existingVars.CUSTOM_MCP_SERVERS ? `CUSTOM_MCP_SERVERS=${existingVars.CUSTOM_MCP_SERVERS}` : "# CUSTOM_MCP_SERVERS=[]"}

# =============================================================================
# MEMORY INTEGRATION
# Embedding providers: OpenAI, Google AI, Azure OpenAI, Ollama, Voyage
# =============================================================================
${existingVars.GRAPHITI_ENABLED ? `GRAPHITI_ENABLED=${existingVars.GRAPHITI_ENABLED}` : "# GRAPHITI_ENABLED=true"}

# Embedding Provider (for semantic search - optional, keyword search works without)
${existingVars.GRAPHITI_EMBEDDER_PROVIDER ? `GRAPHITI_EMBEDDER_PROVIDER=${existingVars.GRAPHITI_EMBEDDER_PROVIDER}` : "# GRAPHITI_EMBEDDER_PROVIDER=ollama"}

# LLM used by graphiti-core to ingest episodes (entity extraction)
${existingVars.GRAPHITI_LLM_PROVIDER ? `GRAPHITI_LLM_PROVIDER=${existingVars.GRAPHITI_LLM_PROVIDER}` : "# GRAPHITI_LLM_PROVIDER=ollama"}
${existingVars.OLLAMA_LLM_MODEL ? `OLLAMA_LLM_MODEL=${existingVars.OLLAMA_LLM_MODEL}` : "# OLLAMA_LLM_MODEL=qwen3:4b"}

# OpenAI Embeddings
${existingVars.OPENAI_API_KEY ? `OPENAI_API_KEY=${existingVars.OPENAI_API_KEY}` : "# OPENAI_API_KEY="}
${existingVars.OPENAI_EMBEDDING_MODEL ? `OPENAI_EMBEDDING_MODEL=${existingVars.OPENAI_EMBEDDING_MODEL}` : "# OPENAI_EMBEDDING_MODEL=text-embedding-3-small"}

# Azure OpenAI Embeddings
${existingVars.AZURE_OPENAI_API_KEY ? `AZURE_OPENAI_API_KEY=${existingVars.AZURE_OPENAI_API_KEY}` : "# AZURE_OPENAI_API_KEY="}
${existingVars.AZURE_OPENAI_BASE_URL ? `AZURE_OPENAI_BASE_URL=${existingVars.AZURE_OPENAI_BASE_URL}` : "# AZURE_OPENAI_BASE_URL="}
${existingVars.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ? `AZURE_OPENAI_EMBEDDING_DEPLOYMENT=${existingVars.AZURE_OPENAI_EMBEDDING_DEPLOYMENT}` : "# AZURE_OPENAI_EMBEDDING_DEPLOYMENT="}

# Voyage AI Embeddings
${existingVars.VOYAGE_API_KEY ? `VOYAGE_API_KEY=${existingVars.VOYAGE_API_KEY}` : "# VOYAGE_API_KEY="}
${existingVars.VOYAGE_EMBEDDING_MODEL ? `VOYAGE_EMBEDDING_MODEL=${existingVars.VOYAGE_EMBEDDING_MODEL}` : "# VOYAGE_EMBEDDING_MODEL=voyage-3"}

# Google AI Embeddings
${existingVars.GOOGLE_API_KEY ? `GOOGLE_API_KEY=${existingVars.GOOGLE_API_KEY}` : "# GOOGLE_API_KEY="}
${existingVars.GOOGLE_EMBEDDING_MODEL ? `GOOGLE_EMBEDDING_MODEL=${existingVars.GOOGLE_EMBEDDING_MODEL}` : "# GOOGLE_EMBEDDING_MODEL=text-embedding-004"}

# Ollama Embeddings (Local - free)
${existingVars.OLLAMA_BASE_URL ? `OLLAMA_BASE_URL=${existingVars.OLLAMA_BASE_URL}` : "# OLLAMA_BASE_URL=http://localhost:11434"}
${existingVars.OLLAMA_EMBEDDING_MODEL ? `OLLAMA_EMBEDDING_MODEL=${existingVars.OLLAMA_EMBEDDING_MODEL}` : "# OLLAMA_EMBEDDING_MODEL=embeddinggemma"}
${existingVars.OLLAMA_EMBEDDING_DIM ? `OLLAMA_EMBEDDING_DIM=${existingVars.OLLAMA_EMBEDDING_DIM}` : "# OLLAMA_EMBEDDING_DIM=768"}

# LadybugDB Database (embedded - no Docker required)
${existingVars.GRAPHITI_DATABASE ? `GRAPHITI_DATABASE=${existingVars.GRAPHITI_DATABASE}` : "# GRAPHITI_DATABASE=auto_claude_memory"}
${existingVars.GRAPHITI_DB_PATH ? `GRAPHITI_DB_PATH=${existingVars.GRAPHITI_DB_PATH}` : "# GRAPHITI_DB_PATH=~/.workpilot/memories"}
`;

		return content;
	};

	ipcMain.handle(
		IPC_CHANNELS.ENV_GET,
		async (_, projectId: string): Promise<IPCResult<ProjectEnvConfig>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			if (!project.autoBuildPath) {
				return { success: false, error: "Project not initialized" };
			}

			const envPath = path.join(project.path, project.autoBuildPath, ".env");

			// Load global settings for fallbacks
			let globalSettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
			if (existsSync(settingsPath)) {
				try {
					const content = readFileSync(settingsPath, "utf-8");
					globalSettings = { ...globalSettings, ...JSON.parse(content) };
				} catch {
					// Use defaults
				}
			}

			// Default config
			const config: ProjectEnvConfig = {
				claudeAuthStatus: "not_configured",
				linearEnabled: false,
				githubEnabled: false,
				gitlabEnabled: false,
				azureDevOpsEnabled: false,
				jiraEnabled: false,
				teamsNotificationsEnabled: false,
				graphitiEnabled: false,
				enableFancyUi: true,
				claudeTokenIsGlobal: false,
				openaiKeyIsGlobal: false,
			};

			// Parse project-specific .env if it exists
			let vars: Record<string, string> = {};
			if (existsSync(envPath)) {
				try {
					const content = readFileSync(envPath, "utf-8");
					vars = parseEnvFile(content);
				} catch {
					// Continue with empty vars
				}
			}

			// Claude OAuth Token: project-specific takes precedence, then global
			if (vars.CLAUDE_CODE_OAUTH_TOKEN) {
				config.claudeOAuthToken = vars.CLAUDE_CODE_OAUTH_TOKEN;
				config.claudeAuthStatus = "token_set";
				config.claudeTokenIsGlobal = false;
			} else if (globalSettings.globalClaudeOAuthToken) {
				config.claudeOAuthToken = globalSettings.globalClaudeOAuthToken;
				config.claudeAuthStatus = "token_set";
				config.claudeTokenIsGlobal = true;
			}

			if (vars.AUTO_BUILD_MODEL) {
				config.autoBuildModel = vars.AUTO_BUILD_MODEL;
			}

			if (vars.LINEAR_API_KEY) {
				config.linearApiKey = vars.LINEAR_API_KEY;
			}
			// Explicit LINEAR_ENABLED wins; fall back to API-key presence (legacy .env files)
			if (vars.LINEAR_ENABLED !== undefined) {
				config.linearEnabled = vars.LINEAR_ENABLED.toLowerCase() === "true";
			} else if (vars.LINEAR_API_KEY) {
				config.linearEnabled = true;
			}
			if (vars.LINEAR_TEAM_ID) {
				config.linearTeamId = vars.LINEAR_TEAM_ID;
			}
			if (vars.LINEAR_PROJECT_ID) {
				config.linearProjectId = vars.LINEAR_PROJECT_ID;
			}
			if (vars.LINEAR_REALTIME_SYNC?.toLowerCase() === "true") {
				config.linearRealtimeSync = true;
			}

			// GitHub config
			if (vars.GITHUB_TOKEN) {
				config.githubToken = vars.GITHUB_TOKEN;
			}
			// Explicit GITHUB_ENABLED wins; fall back to token presence (legacy .env files)
			if (vars.GITHUB_ENABLED !== undefined) {
				config.githubEnabled = vars.GITHUB_ENABLED.toLowerCase() === "true";
			} else if (vars.GITHUB_TOKEN) {
				config.githubEnabled = true;
			}
			if (vars.GITHUB_REPO) {
				config.githubRepo = vars.GITHUB_REPO;
			}
			if (vars.GITHUB_AUTO_SYNC?.toLowerCase() === "true") {
				config.githubAutoSync = true;
			}

			// GitLab config
			if (vars[GITLAB_ENV_KEYS.TOKEN]) {
				config.gitlabToken = vars[GITLAB_ENV_KEYS.TOKEN];
				// Enable by default if token exists and GITLAB_ENABLED is not explicitly false
				config.gitlabEnabled =
					vars[GITLAB_ENV_KEYS.ENABLED]?.toLowerCase() !== "false";
			}
			if (vars[GITLAB_ENV_KEYS.INSTANCE_URL]) {
				config.gitlabInstanceUrl = vars[GITLAB_ENV_KEYS.INSTANCE_URL];
			}
			if (vars[GITLAB_ENV_KEYS.PROJECT]) {
				config.gitlabProject = vars[GITLAB_ENV_KEYS.PROJECT];
			}
			if (vars[GITLAB_ENV_KEYS.AUTO_SYNC]?.toLowerCase() === "true") {
				config.gitlabAutoSync = true;
			}

			// Azure DevOps config
			if (vars[AZURE_DEVOPS_ENV_KEYS.PAT]) {
				config.azureDevOpsPat = vars[AZURE_DEVOPS_ENV_KEYS.PAT];
			}
			// Azure DevOps integration
			if (vars[AZURE_DEVOPS_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.azureDevOpsEnabled = true;
			}
			if (vars[AZURE_DEVOPS_ENV_KEYS.ORG_URL]) {
				config.azureDevOpsOrgUrl = vars[AZURE_DEVOPS_ENV_KEYS.ORG_URL];
			}
			if (vars[AZURE_DEVOPS_ENV_KEYS.PROJECT]) {
				config.azureDevOpsProject = vars[AZURE_DEVOPS_ENV_KEYS.PROJECT];
			}
			if (vars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY]) {
				config.azureDevOpsRepository = vars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY];
			}
			// Backward compat: if REPOSITORY is not set but PROJECT looks like a repo name
			// (contains spaces or doesn't match project name), treat it as repository
			if (!config.azureDevOpsRepository && config.azureDevOpsProject) {
				// Will be overridden once project name is auto-detected
				config.azureDevOpsRepository = config.azureDevOpsProject;
			}
			// Auto-sync defaults to true if Azure DevOps is enabled and not explicitly set
			if (vars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC] !== undefined) {
				config.azureDevOpsAutoSync =
					vars[AZURE_DEVOPS_ENV_KEYS.AUTO_SYNC]?.toLowerCase() === "true";
			} else if (config.azureDevOpsEnabled) {
				config.azureDevOpsAutoSync = true;
			}

			// Jira config
			if (vars[JIRA_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.jiraEnabled = true;
			}
			if (vars[JIRA_ENV_KEYS.INSTANCE_URL]) {
				config.jiraInstanceUrl = vars[JIRA_ENV_KEYS.INSTANCE_URL];
			}
			if (vars[JIRA_ENV_KEYS.EMAIL]) {
				config.jiraEmail = vars[JIRA_ENV_KEYS.EMAIL];
			}
			if (vars[JIRA_ENV_KEYS.API_TOKEN]) {
				config.jiraApiToken = vars[JIRA_ENV_KEYS.API_TOKEN];
			}
			if (vars[JIRA_ENV_KEYS.PROJECT_KEY]) {
				config.jiraProjectKey = vars[JIRA_ENV_KEYS.PROJECT_KEY];
			}
			if (vars[JIRA_ENV_KEYS.AUTO_SYNC]?.toLowerCase() === "true") {
				config.jiraAutoSync = true;
			}

			// CI/CD pipeline loop (« Build rouge »)
			if (vars[CICD_ENV_KEYS.PROVIDER] !== undefined) {
				config.cicdProvider = vars[
					CICD_ENV_KEYS.PROVIDER
				] as ProjectEnvConfig["cicdProvider"];
			}
			// Default true: only an explicit "false" disables the auto-repair
			config.cicdAutoFix =
				vars[CICD_ENV_KEYS.AUTO_FIX]?.toLowerCase() !== "false";
			if (vars[CICD_ENV_KEYS.POLL_SECONDS]) {
				const pollSeconds = Number.parseInt(
					vars[CICD_ENV_KEYS.POLL_SECONDS],
					10,
				);
				if (Number.isFinite(pollSeconds) && pollSeconds > 0) {
					config.cicdPollSeconds = pollSeconds;
				}
			}
			if (vars[CICD_ENV_KEYS.JENKINS_URL]) {
				config.cicdJenkinsUrl = vars[CICD_ENV_KEYS.JENKINS_URL];
			}
			if (vars[CICD_ENV_KEYS.JENKINS_JOB]) {
				config.cicdJenkinsJob = vars[CICD_ENV_KEYS.JENKINS_JOB];
			}
			if (vars[CICD_ENV_KEYS.JENKINS_USER]) {
				config.cicdJenkinsUser = vars[CICD_ENV_KEYS.JENKINS_USER];
			}
			if (vars[CICD_ENV_KEYS.JENKINS_TOKEN]) {
				config.cicdJenkinsToken = vars[CICD_ENV_KEYS.JENKINS_TOKEN];
			}

			// Channel Notifications (Teams / Slack / Discord / Google Chat / webhook)
			if (vars[TEAMS_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.teamsNotificationsEnabled = true;
			}
			if (vars[TEAMS_ENV_KEYS.WEBHOOK_URL]) {
				config.teamsWebhookUrl = vars[TEAMS_ENV_KEYS.WEBHOOK_URL];
			}
			if (vars[SLACK_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.slackNotificationsEnabled = true;
			}
			if (vars[SLACK_ENV_KEYS.WEBHOOK_URL]) {
				config.slackWebhookUrl = vars[SLACK_ENV_KEYS.WEBHOOK_URL];
			}
			if (vars[DISCORD_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.discordNotificationsEnabled = true;
			}
			if (vars[DISCORD_ENV_KEYS.WEBHOOK_URL]) {
				config.discordWebhookUrl = vars[DISCORD_ENV_KEYS.WEBHOOK_URL];
			}
			if (vars[GOOGLE_CHAT_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.googleChatNotificationsEnabled = true;
			}
			if (vars[GOOGLE_CHAT_ENV_KEYS.WEBHOOK_URL]) {
				config.googleChatWebhookUrl = vars[GOOGLE_CHAT_ENV_KEYS.WEBHOOK_URL];
			}
			if (vars[NOTIFY_WEBHOOK_ENV_KEYS.ENABLED]?.toLowerCase() === "true") {
				config.notifyWebhookEnabled = true;
			}
			if (vars[NOTIFY_WEBHOOK_ENV_KEYS.WEBHOOK_URL]) {
				config.notifyWebhookUrl = vars[NOTIFY_WEBHOOK_ENV_KEYS.WEBHOOK_URL];
			}

			// Git/Worktree config
			if (vars.DEFAULT_BRANCH) {
				config.defaultBranch = vars.DEFAULT_BRANCH;
			}

			if (vars.GRAPHITI_ENABLED?.toLowerCase() === "true") {
				config.graphitiEnabled = true;
			}

			// OpenAI API Key: project-specific takes precedence, then global
			if (vars.OPENAI_API_KEY) {
				config.openaiApiKey = vars.OPENAI_API_KEY;
				config.openaiKeyIsGlobal = false;
			} else if (globalSettings.globalOpenAIApiKey) {
				config.openaiApiKey = globalSettings.globalOpenAIApiKey;
				config.openaiKeyIsGlobal = true;
			}

			if (vars.GRAPHITI_DATABASE) {
				config.graphitiDatabase = vars.GRAPHITI_DATABASE;
			}
			if (vars.GRAPHITI_DB_PATH) {
				config.graphitiDbPath = vars.GRAPHITI_DB_PATH;
			}

			if (vars.ENABLE_FANCY_UI?.toLowerCase() === "false") {
				config.enableFancyUi = false;
			}

			// Populate graphitiProviderConfig from .env file (embeddings only - no LLM provider)
			const embeddingProvider = vars.GRAPHITI_EMBEDDER_PROVIDER;
			if (
				embeddingProvider ||
				vars.AZURE_OPENAI_API_KEY ||
				vars.VOYAGE_API_KEY ||
				vars.GOOGLE_API_KEY ||
				vars.OLLAMA_BASE_URL
			) {
				config.graphitiProviderConfig = {
					embeddingProvider:
						(embeddingProvider as
							| "openai"
							| "voyage"
							| "azure_openai"
							| "ollama"
							| "google") || "ollama",
					// OpenAI Embeddings
					openaiApiKey: vars.OPENAI_API_KEY,
					openaiEmbeddingModel: vars.OPENAI_EMBEDDING_MODEL,
					// Azure OpenAI Embeddings
					azureOpenaiApiKey: vars.AZURE_OPENAI_API_KEY,
					azureOpenaiBaseUrl: vars.AZURE_OPENAI_BASE_URL,
					azureOpenaiEmbeddingDeployment:
						vars.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
					// Voyage Embeddings
					voyageApiKey: vars.VOYAGE_API_KEY,
					voyageEmbeddingModel: vars.VOYAGE_EMBEDDING_MODEL,
					// Google Embeddings
					googleApiKey: vars.GOOGLE_API_KEY,
					googleEmbeddingModel: vars.GOOGLE_EMBEDDING_MODEL,
					// Ollama Embeddings
					ollamaBaseUrl: vars.OLLAMA_BASE_URL,
					ollamaEmbeddingModel: vars.OLLAMA_EMBEDDING_MODEL,
					ollamaEmbeddingDim: vars.OLLAMA_EMBEDDING_DIM
						? Number.parseInt(vars.OLLAMA_EMBEDDING_DIM, 10)
						: undefined,
					ollamaLlmModel: vars.OLLAMA_LLM_MODEL,
					// LadybugDB
					database: vars.GRAPHITI_DATABASE,
					dbPath: vars.GRAPHITI_DB_PATH,
				};
			}

			// MCP Server Configuration (per-project overrides)
			// Default: context7=true, linear=true (if API key set), electron/puppeteer=false
			config.mcpServers = {
				context7Enabled: vars.CONTEXT7_ENABLED?.toLowerCase() !== "false", // default true
				graphitiEnabled: config.graphitiEnabled, // follows GRAPHITI_ENABLED
				linearMcpEnabled: vars.LINEAR_MCP_ENABLED?.toLowerCase() !== "false", // default true
				electronEnabled: vars.ELECTRON_MCP_ENABLED?.toLowerCase() === "true", // default false
				puppeteerEnabled: vars.PUPPETEER_MCP_ENABLED?.toLowerCase() === "true", // default false
				chromeDevtoolsEnabled:
					vars.CHROME_DEVTOOLS_MCP_ENABLED?.toLowerCase() === "true", // default false
			};

			// Parse per-agent MCP overrides (AGENT_MCP_<agent>_ADD/REMOVE)
			const agentMcpOverrides: Record<
				string,
				{ add?: string[]; remove?: string[] }
			> = {};
			Object.entries(vars).forEach(([key, value]) => {
				if (key.startsWith("AGENT_MCP_") && key.endsWith("_ADD")) {
					const agentId = key.replace("AGENT_MCP_", "").replace("_ADD", "");
					if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
					agentMcpOverrides[agentId].add = value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				} else if (key.startsWith("AGENT_MCP_") && key.endsWith("_REMOVE")) {
					const agentId = key.replace("AGENT_MCP_", "").replace("_REMOVE", "");
					if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
					agentMcpOverrides[agentId].remove = value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				}
			});

			if (Object.keys(agentMcpOverrides).length > 0) {
				config.agentMcpOverrides = agentMcpOverrides;
			}

			// Parse custom MCP servers (user-defined)
			if (vars.CUSTOM_MCP_SERVERS) {
				try {
					config.customMcpServers = JSON.parse(vars.CUSTOM_MCP_SERVERS);
				} catch {
					// Invalid JSON, ignore
					config.customMcpServers = [];
				}
			}

			return { success: true, data: config };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ENV_UPDATE,
		async (
			_,
			projectId: string,
			config: Partial<ProjectEnvConfig>,
		): Promise<IPCResult> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// If the project hasn't been initialized yet (no .workpilot/ on disk yet),
			// bootstrap autoBuildPath so integration config set at creation time (e.g. Azure/Jira
			// from AddProjectModal) can still be persisted. The .workpilot/ directory itself is
			// created below by the mkdirSync fallback when writing the .env file.
			let autoBuildPath = project.autoBuildPath;
			if (!autoBuildPath) {
				autoBuildPath = ".workpilot";
				projectStore.updateAutoBuildPath(project.id, autoBuildPath);
			}

			const envPath = path.join(project.path, autoBuildPath, ".env");

			try {
				// Read existing content if file exists (atomic read, no TOCTOU)
				let existingContent: string | undefined;
				try {
					existingContent = readFileSync(envPath, "utf-8");
				} catch (readErr: unknown) {
					if ((readErr as NodeJS.ErrnoException).code !== "ENOENT")
						throw readErr;
					// File doesn't exist yet - existingContent stays undefined
				}

				// Generate new content
				const newContent = generateEnvContent(config, existingContent);

				// Ensure parent directory exists (handles case where .workpilot was deleted or not created)
				const envDir = path.dirname(envPath);
				if (!existsSync(envDir)) {
					mkdirSync(envDir, { recursive: true });
				}

				// Write to file
				writeFileSync(envPath, newContent, "utf-8");

				return { success: true };
			} catch (error) {
				console.error("[ENV_UPDATE] Error updating .env file:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to update .env file",
				};
			}
		},
	);

	// Helper function to check Claude CLI availability
	const checkClaudeCliAvailability = (
		claudeCmd: string,
		claudeEnv: Record<string, string>,
		projectPath: string,
	): Promise<ClaudeAuthResult> => {
		return new Promise((resolve) => {
			const proc = spawn(
				getSpawnCommand(claudeCmd),
				["--version"],
				getSpawnOptions(claudeCmd, {
					cwd: projectPath,
					env: claudeEnv,
				}),
			);

			let _stdout = "";
			let _stderr = "";

			proc.stdout?.on("data", (data: Buffer) => {
				_stdout += data.toString("utf-8");
			});

			proc.stderr?.on("data", (data: Buffer) => {
				_stderr += data.toString("utf-8");
			});

			proc.on("close", (code: number | null) => {
				if (code === 0) {
					checkClaudeAuthentication(claudeCmd, claudeEnv, projectPath, resolve);
				} else {
					resolve({
						success: false,
						authenticated: false,
						error: "Claude CLI not found. Please install it first.",
					});
				}
			});

			proc.on("error", () => {
				resolve({
					success: false,
					authenticated: false,
					error: "Claude CLI not found. Please install it first.",
				});
			});
		});
	};

	// Helper function to check Claude authentication
	const checkClaudeAuthentication = (
		claudeCmd: string,
		claudeEnv: Record<string, string>,
		projectPath: string,
		resolve: (value: ClaudeAuthResult) => void,
	): void => {
		const authCheck = spawn(
			getSpawnCommand(claudeCmd),
			["api", "--help"],
			getSpawnOptions(claudeCmd, {
				cwd: projectPath,
				env: claudeEnv,
			}),
		);

		authCheck.on("close", (authCode: number | null) => {
			resolve({
				success: true,
				authenticated: authCode === 0,
			});
		});

		authCheck.on("error", () => {
			resolve({
				success: true,
				authenticated: false,
				error: "Could not verify authentication",
			});
		});
	};

	ipcMain.handle(
		IPC_CHANNELS.ENV_CHECK_CLAUDE_AUTH,
		async (_, projectId: string): Promise<IPCResult<ClaudeAuthResult>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// Use async version to avoid blocking main process during CLI detection
			const resolved = await resolveClaudeCliInvocationAsync();
			if ("error" in resolved) {
				return { success: false, error: resolved.error };
			}
			const claudeCmd = resolved.command;
			const claudeEnv = resolved.env;

			try {
				// Check if Claude CLI is available and authenticated
				const result = await checkClaudeCliAvailability(
					claudeCmd,
					claudeEnv,
					project.path,
				);

				if (!result.success) {
					return {
						success: false,
						error: result.error || "Failed to check Claude auth",
					};
				}
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to check Claude auth",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ENV_INVOKE_CLAUDE_SETUP,
		async (_, projectId: string): Promise<IPCResult<ClaudeAuthResult>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// Use async version to avoid blocking main process during CLI detection
			const resolved = await resolveClaudeCliInvocationAsync();
			if ("error" in resolved) {
				return { success: false, error: resolved.error };
			}
			const claudeCmd = resolved.command;
			const claudeEnv = resolved.env;

			try {
				// Run claude setup-token which will open browser for OAuth
				const result = await new Promise<ClaudeAuthResult>((resolve) => {
					const proc = spawn(
						getSpawnCommand(claudeCmd),
						["setup-token"],
						getSpawnOptions(claudeCmd, {
							cwd: project.path,
							env: claudeEnv,
							stdio: "inherit", // This allows the terminal to handle the interactive auth
						}),
					);

					proc.on("close", (code: number | null) => {
						if (code === 0) {
							resolve({
								success: true,
								authenticated: true,
							});
						} else {
							resolve({
								success: false,
								authenticated: false,
								error: "Setup cancelled or failed",
							});
						}
					});

					proc.on("error", (err: Error) => {
						resolve({
							success: false,
							authenticated: false,
							error: err.message,
						});
					});
				});

				if (!result.success) {
					return {
						success: false,
						error: result.error || "Failed to invoke Claude setup",
					};
				}
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to invoke Claude setup",
				};
			}
		},
	);
}
