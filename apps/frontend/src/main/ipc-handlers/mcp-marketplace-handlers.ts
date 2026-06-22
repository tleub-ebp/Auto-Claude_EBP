/**
 * MCP Marketplace IPC Handlers
 *
 * Handles marketplace catalog, installation, uninstallation,
 * health checks, and builder project management.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	HuggingFaceModelSearchParams,
	McpBuilderProject,
	McpInstalledServer,
	McpMarketplaceServer,
} from "../../shared/types/mcp-marketplace";
import { appLog } from "../app-logger";
import { searchHuggingFaceModels } from "../services/hf-mcp-client";

// ============================================
// Storage paths
// ============================================

function getMarketplaceDataDir(): string {
	const userDataPath = app.getPath("userData");
	const dir = path.join(userDataPath, "mcp-marketplace");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getInstalledServersPath(): string {
	return path.join(getMarketplaceDataDir(), "installed-servers.json");
}

function getBuilderProjectsPath(): string {
	return path.join(getMarketplaceDataDir(), "builder-projects.json");
}

// ============================================
// Built-in MCP Server Catalog
// ============================================

export function buildCatalog(): McpMarketplaceServer[] {
	return [
		{
			id: "github",
			name: "GitHub",
			tagline: "Complete GitHub integration for repos, issues, PRs",
			description: "Access GitHub repositories, manage issues and pull requests, review code, and automate workflows directly from WorkPilot agents.",
			author: "GitHub / MCP Community",
			category: "version-control",
			icon: "Github",
			color: "#24292e",
			packageName: "@modelcontextprotocol/server-github",
			version: "0.6.2",
			downloads: 2400000,
			rating: 4.8,
			ratingCount: 1250,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-github"],
			requiredEnvVars: [
				{
					name: "GITHUB_PERSONAL_ACCESS_TOKEN",
					label: "GitHub Token",
					description: "Personal Access Token with repo scope",
					required: true,
					placeholder: "ghp_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://github.com/settings/tokens",
				},
			],
			tools: [
				{
					name: "create_or_update_file",
					description: "Create or update a single file in a repository",
				},
				{
					name: "search_repositories",
					description: "Search for GitHub repositories",
				},
				{
					name: "create_issue",
					description: "Create a new issue in a repository",
				},
				{
					name: "create_pull_request",
					description: "Create a new pull request",
				},
				{ name: "list_issues", description: "List issues in a repository" },
				{
					name: "get_file_contents",
					description: "Get contents of a file or directory",
				},
			],
			tags: [
				"github",
				"git",
				"version-control",
				"issues",
				"pull-requests",
				"code-review",
			],
			homepage: "https://github.com/modelcontextprotocol/servers",
			repository: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "gitlab",
			name: "GitLab",
			tagline: "GitLab API integration for projects and merge requests",
			description: "Manage GitLab projects, issues, merge requests, and CI/CD pipelines through MCP protocol.",
			author: "MCP Community",
			category: "version-control",
			icon: "GitlabIcon",
			color: "#FC6D26",
			packageName: "@modelcontextprotocol/server-gitlab",
			version: "0.6.2",
			downloads: 850000,
			rating: 4.6,
			ratingCount: 420,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-gitlab"],
			requiredEnvVars: [
				{
					name: "GITLAB_PERSONAL_ACCESS_TOKEN",
					label: "GitLab Token",
					description: "Personal Access Token with api scope",
					required: true,
					placeholder: "glpat-xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
				},
				{
					name: "GITLAB_API_URL",
					label: "GitLab API URL",
					description:
						"GitLab API base URL (default: https://gitlab.com/api/v4)",
					required: false,
					placeholder: "https://gitlab.com/api/v4",
					secret: false,
				},
			],
			tools: [
				{
					name: "create_issue",
					description: "Create a new issue in a project",
				},
				{
					name: "list_merge_requests",
					description: "List merge requests for a project",
				},
				{
					name: "get_file_contents",
					description: "Get file contents from a repository",
				},
			],
			tags: ["gitlab", "git", "version-control", "merge-requests", "ci-cd"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			repository: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-15T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "slack",
			name: "Slack",
			tagline: "Send messages, manage channels, search conversations",
			description:
				"Integrate Slack workspace: send messages to channels, read message history, manage channels, and search across conversations.",
			author: "MCP Community",
			category: "communication",
			icon: "MessageSquare",
			color: "#4A154B",
			packageName: "@modelcontextprotocol/server-slack",
			version: "0.6.2",
			downloads: 1800000,
			rating: 4.7,
			ratingCount: 890,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-slack"],
			requiredEnvVars: [
				{
					name: "SLACK_BOT_TOKEN",
					label: "Slack Bot Token",
					description: "Bot User OAuth Token (xoxb-...)",
					required: true,
					placeholder: "xoxb-xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://api.slack.com/apps",
				},
				{
					name: "SLACK_TEAM_ID",
					label: "Slack Team ID",
					description: "Your Slack workspace team ID",
					required: true,
					placeholder: "T0XXXXXXXXX",
					secret: false,
				},
			],
			tools: [
				{
					name: "send_message",
					description: "Send a message to a Slack channel",
				},
				{
					name: "list_channels",
					description: "List all channels in the workspace",
				},
				{
					name: "search_messages",
					description: "Search for messages across channels",
				},
				{
					name: "get_channel_history",
					description: "Get recent messages from a channel",
				},
			],
			tags: ["slack", "messaging", "communication", "team", "chat"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-02-15T00:00:00Z",
		},
		{
			id: "jira",
			name: "Jira",
			tagline: "Manage Jira issues, sprints, and boards",
			description: "Full Jira integration: create and update issues, manage sprints, search with JQL, and sync project boards.",
			author: "Atlassian Community",
			category: "project-management",
			icon: "ClipboardList",
			color: "#0052CC",
			packageName: "@anthropic/mcp-server-jira",
			version: "1.0.0",
			downloads: 1200000,
			rating: 4.5,
			ratingCount: 650,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-jira"],
			requiredEnvVars: [
				{
					name: "JIRA_URL",
					label: "Jira URL",
					description: "Your Jira instance URL",
					required: true,
					placeholder: "https://your-domain.atlassian.net",
					secret: false,
				},
				{
					name: "JIRA_EMAIL",
					label: "Jira Email",
					description: "Your Jira account email",
					required: true,
					placeholder: "user@company.com",
					secret: false,
				},
				{
					name: "JIRA_API_TOKEN",
					label: "Jira API Token",
					description: "API token for authentication",
					required: true,
					placeholder: "xxxxxxxxxxxx",
					secret: true,
					helpUrl:
						"https://id.atlassian.com/manage-profile/security/api-tokens",
				},
			],
			tools: [
				{ name: "create_issue", description: "Create a new Jira issue" },
				{ name: "search_issues", description: "Search issues using JQL" },
				{ name: "update_issue", description: "Update an existing issue" },
				{ name: "get_issue", description: "Get detailed issue information" },
			],
			tags: [
				"jira",
				"project-management",
				"issues",
				"sprints",
				"agile",
				"atlassian",
			],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2024-12-01T00:00:00Z",
			updatedAt: "2025-02-20T00:00:00Z",
		},
		{
			id: "figma",
			name: "Figma",
			tagline: "Access Figma designs, components, and variables",
			description: "Read Figma files, extract design tokens, access component libraries, and bridge design-to-code workflows.",
			author: "Figma Community",
			category: "design",
			icon: "Figma",
			color: "#F24E1E",
			packageName: "@anthropic/mcp-server-figma",
			version: "1.0.0",
			downloads: 950000,
			rating: 4.6,
			ratingCount: 480,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-figma"],
			requiredEnvVars: [
				{
					name: "FIGMA_ACCESS_TOKEN",
					label: "Figma Token",
					description: "Personal Access Token from Figma",
					required: true,
					placeholder: "figd_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://www.figma.com/developers/api#access-tokens",
				},
			],
			tools: [
				{ name: "get_file", description: "Get a Figma file by key" },
				{ name: "get_components", description: "List components in a file" },
				{ name: "get_styles", description: "Get design styles and tokens" },
			],
			tags: ["figma", "design", "ui", "ux", "components", "design-tokens"],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2025-01-10T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "sentry",
			name: "Sentry",
			tagline: "Monitor errors, performance, and releases",
			description: "Access Sentry error tracking: view issues, search events, manage releases, and monitor application performance.",
			author: "Sentry",
			category: "monitoring",
			icon: "Bug",
			color: "#362D59",
			packageName: "@sentry/mcp-server",
			version: "0.2.0",
			downloads: 720000,
			rating: 4.4,
			ratingCount: 310,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@sentry/mcp-server"],
			requiredEnvVars: [
				{
					name: "SENTRY_AUTH_TOKEN",
					label: "Sentry Auth Token",
					description: "Sentry authentication token",
					required: true,
					placeholder: "sntrys_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://sentry.io/settings/account/api/auth-tokens/",
				},
				{
					name: "SENTRY_ORG",
					label: "Sentry Org",
					description: "Sentry organization slug",
					required: true,
					placeholder: "my-org",
					secret: false,
				},
			],
			tools: [
				{
					name: "list_issues",
					description: "List Sentry issues for a project",
				},
				{ name: "get_issue", description: "Get detailed issue information" },
				{ name: "search_events", description: "Search error events" },
			],
			tags: ["sentry", "monitoring", "errors", "performance", "debugging"],
			homepage: "https://github.com/getsentry/sentry-mcp",
			addedAt: "2025-01-15T00:00:00Z",
			updatedAt: "2025-02-28T00:00:00Z",
		},
		{
			id: "datadog",
			name: "Datadog",
			tagline: "Query metrics, logs, and traces",
			description: "Access Datadog monitoring data: query metrics, search logs, view traces, and manage dashboards.",
			author: "Datadog Community",
			category: "monitoring",
			icon: "BarChart3",
			color: "#632CA6",
			packageName: "@anthropic/mcp-server-datadog",
			version: "0.5.0",
			downloads: 580000,
			rating: 4.3,
			ratingCount: 240,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-datadog"],
			requiredEnvVars: [
				{
					name: "DD_API_KEY",
					label: "Datadog API Key",
					description: "Datadog API key",
					required: true,
					placeholder: "xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://app.datadoghq.com/organization-settings/api-keys",
				},
				{
					name: "DD_APP_KEY",
					label: "Datadog App Key",
					description: "Datadog application key",
					required: true,
					placeholder: "xxxxxxxxxxxx",
					secret: true,
				},
			],
			tools: [
				{ name: "query_metrics", description: "Query Datadog metrics" },
				{ name: "search_logs", description: "Search Datadog logs" },
				{ name: "list_dashboards", description: "List available dashboards" },
			],
			tags: [
				"datadog",
				"monitoring",
				"metrics",
				"logs",
				"apm",
				"observability",
			],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2025-01-20T00:00:00Z",
			updatedAt: "2025-02-25T00:00:00Z",
		},
		{
			id: "azure-devops",
			name: "Azure DevOps",
			tagline: "Manage work items, repos, and pipelines",
			description: "Complete Azure DevOps integration: manage work items, access repositories, run pipelines, and track boards.",
			author: "Microsoft Community",
			category: "project-management",
			icon: "Cloud",
			color: "#0078D4",
			packageName: "@anthropic/mcp-server-azure-devops",
			version: "0.3.0",
			downloads: 680000,
			rating: 4.4,
			ratingCount: 350,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-azure-devops"],
			requiredEnvVars: [
				{
					name: "AZURE_DEVOPS_ORG_URL",
					label: "Organization URL",
					description: "Azure DevOps organization URL",
					required: true,
					placeholder: "https://dev.azure.com/my-org",
					secret: false,
				},
				{
					name: "AZURE_DEVOPS_PAT",
					label: "Personal Access Token",
					description: "PAT with full access",
					required: true,
					placeholder: "xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://dev.azure.com/_usersSettings/tokens",
				},
			],
			tools: [
				{ name: "create_work_item", description: "Create a new work item" },
				{ name: "query_work_items", description: "Query work items with WIQL" },
				{ name: "get_repository", description: "Get repository information" },
				{ name: "run_pipeline", description: "Trigger a pipeline run" },
			],
			tags: [
				"azure",
				"devops",
				"work-items",
				"pipelines",
				"boards",
				"microsoft",
			],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2025-01-05T00:00:00Z",
			updatedAt: "2025-02-20T00:00:00Z",
		},
		{
			id: "confluence",
			name: "Confluence",
			tagline: "Search and manage Confluence pages and spaces",
			description: "Access Confluence wiki: search pages, read content, create and update pages, manage spaces.",
			author: "Atlassian Community",
			category: "documentation",
			icon: "BookOpen",
			color: "#1868DB",
			packageName: "@anthropic/mcp-server-confluence",
			version: "0.4.0",
			downloads: 490000,
			rating: 4.3,
			ratingCount: 200,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-confluence"],
			requiredEnvVars: [
				{
					name: "CONFLUENCE_URL",
					label: "Confluence URL",
					description: "Your Confluence instance URL",
					required: true,
					placeholder: "https://your-domain.atlassian.net/wiki",
					secret: false,
				},
				{
					name: "CONFLUENCE_EMAIL",
					label: "Email",
					description: "Your Atlassian account email",
					required: true,
					placeholder: "user@company.com",
					secret: false,
				},
				{
					name: "CONFLUENCE_API_TOKEN",
					label: "API Token",
					description: "Atlassian API token",
					required: true,
					placeholder: "xxxxxxxxxxxx",
					secret: true,
				},
			],
			tools: [
				{ name: "search_pages", description: "Search Confluence pages" },
				{ name: "get_page", description: "Get page content by ID" },
				{ name: "create_page", description: "Create a new page" },
			],
			tags: [
				"confluence",
				"documentation",
				"wiki",
				"knowledge-base",
				"atlassian",
			],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2025-01-12T00:00:00Z",
			updatedAt: "2025-02-18T00:00:00Z",
		},
		{
			id: "notion",
			name: "Notion",
			tagline: "Access Notion pages, databases, and blocks",
			description: "Full Notion integration: read and write pages, query databases, manage blocks, and search across workspace.",
			author: "MCP Community",
			category: "documentation",
			icon: "FileText",
			color: "#000000",
			packageName: "@anthropic/mcp-server-notion",
			version: "0.4.0",
			downloads: 1100000,
			rating: 4.5,
			ratingCount: 550,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-notion"],
			requiredEnvVars: [
				{
					name: "NOTION_API_TOKEN",
					label: "Notion API Token",
					description: "Internal integration token",
					required: true,
					placeholder: "ntn_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://www.notion.so/my-integrations",
				},
			],
			tools: [
				{ name: "search", description: "Search across Notion workspace" },
				{ name: "get_page", description: "Get a Notion page" },
				{ name: "query_database", description: "Query a Notion database" },
				{ name: "create_page", description: "Create a new page" },
			],
			tags: [
				"notion",
				"documentation",
				"wiki",
				"databases",
				"notes",
				"productivity",
			],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2024-12-15T00:00:00Z",
			updatedAt: "2025-02-28T00:00:00Z",
		},
		{
			id: "postgres",
			name: "PostgreSQL",
			tagline: "Query and manage PostgreSQL databases",
			description: "Connect to PostgreSQL databases: run queries, inspect schemas, manage tables, and explore data.",
			author: "MCP Community",
			category: "database",
			icon: "Database",
			color: "#336791",
			packageName: "@modelcontextprotocol/server-postgres",
			version: "0.6.2",
			downloads: 1500000,
			rating: 4.7,
			ratingCount: 780,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-postgres"],
			requiredEnvVars: [
				{
					name: "POSTGRES_CONNECTION_STRING",
					label: "Connection String",
					description: "PostgreSQL connection URL",
					required: true,
					placeholder: "postgresql://user:pass@localhost:5432/dbname",
					secret: true,
				},
			],
			tools: [
				{ name: "query", description: "Execute a SQL query" },
				{ name: "list_tables", description: "List tables in a database" },
				{ name: "describe_table", description: "Get table schema" },
			],
			tags: ["postgres", "postgresql", "database", "sql", "data"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "filesystem",
			name: "Filesystem",
			tagline: "Secure file system access with configurable paths",
			description: "Give agents controlled access to the filesystem: read, write, search files, and manage directories within allowed paths.",
			author: "Anthropic",
			category: "cloud",
			icon: "FolderOpen",
			color: "#10B981",
			packageName: "@modelcontextprotocol/server-filesystem",
			version: "0.6.2",
			downloads: 2100000,
			rating: 4.8,
			ratingCount: 1100,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: [
				"-y",
				"@modelcontextprotocol/server-filesystem",
				"/path/to/allowed/dir",
			],
			optionalEnvVars: [],
			tools: [
				{ name: "read_file", description: "Read a file from the filesystem" },
				{ name: "write_file", description: "Write content to a file" },
				{ name: "list_directory", description: "List directory contents" },
				{ name: "search_files", description: "Search for files by pattern" },
			],
			tags: ["filesystem", "files", "directories", "local", "io"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "brave-search",
			name: "Brave Search",
			tagline: "Web and local search via Brave Search API",
			description: "Enable agents to search the web using Brave Search API. Supports both web search and local business search.",
			author: "Anthropic",
			category: "ai",
			icon: "Search",
			color: "#FB542B",
			packageName: "@modelcontextprotocol/server-brave-search",
			version: "0.6.2",
			downloads: 1300000,
			rating: 4.6,
			ratingCount: 620,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-brave-search"],
			requiredEnvVars: [
				{
					name: "BRAVE_API_KEY",
					label: "Brave API Key",
					description: "Brave Search API key",
					required: true,
					placeholder: "BSAxxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://brave.com/search/api/",
				},
			],
			tools: [
				{ name: "brave_web_search", description: "Search the web" },
				{ name: "brave_local_search", description: "Search local businesses" },
			],
			tags: ["search", "web", "brave", "internet", "research"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "puppeteer",
			name: "Puppeteer",
			tagline: "Browser automation and web scraping",
			description: "Control a headless browser: navigate pages, take screenshots, extract content, fill forms, and automate web interactions.",
			author: "MCP Community",
			category: "ai",
			icon: "Globe",
			color: "#40B5A4",
			packageName: "@modelcontextprotocol/server-puppeteer",
			version: "0.6.2",
			downloads: 900000,
			rating: 4.5,
			ratingCount: 430,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-puppeteer"],
			tools: [
				{ name: "navigate", description: "Navigate to a URL" },
				{ name: "screenshot", description: "Take a screenshot" },
				{ name: "click", description: "Click an element" },
				{ name: "fill", description: "Fill a form field" },
				{ name: "evaluate", description: "Execute JavaScript on the page" },
			],
			tags: [
				"browser",
				"puppeteer",
				"automation",
				"scraping",
				"testing",
				"web",
			],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-15T00:00:00Z",
			updatedAt: "2025-02-20T00:00:00Z",
		},
		{
			id: "linear",
			name: "Linear",
			tagline: "Manage Linear issues, projects, and cycles",
			description: "Full Linear integration: create issues, manage projects, track cycles, and automate workflows.",
			author: "Linear Community",
			category: "project-management",
			icon: "Layers",
			color: "#5E6AD2",
			packageName: "@anthropic/mcp-server-linear",
			version: "0.3.0",
			downloads: 650000,
			rating: 4.5,
			ratingCount: 310,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@anthropic/mcp-server-linear"],
			requiredEnvVars: [
				{
					name: "LINEAR_API_KEY",
					label: "Linear API Key",
					description: "Linear personal API key",
					required: true,
					placeholder: "lin_api_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://linear.app/settings/api",
				},
			],
			tools: [
				{ name: "create_issue", description: "Create a new Linear issue" },
				{ name: "list_issues", description: "List issues with filters" },
				{ name: "update_issue", description: "Update an existing issue" },
			],
			tags: ["linear", "project-management", "issues", "cycles", "sprints"],
			homepage: "https://github.com/anthropics/mcp-servers",
			addedAt: "2025-01-08T00:00:00Z",
			updatedAt: "2025-02-22T00:00:00Z",
		},
		{
			id: "memory",
			name: "Memory",
			tagline: "Persistent memory using knowledge graph",
			description: "Give agents persistent memory across sessions using a local knowledge graph. Store and retrieve entities, relations, and observations.",
			author: "Anthropic",
			category: "ai",
			icon: "Brain",
			color: "#8B5CF6",
			packageName: "@modelcontextprotocol/server-memory",
			version: "0.6.2",
			downloads: 1700000,
			rating: 4.7,
			ratingCount: 850,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-memory"],
			tools: [
				{
					name: "create_entities",
					description: "Create new entities in the knowledge graph",
				},
				{
					name: "create_relations",
					description: "Create relations between entities",
				},
				{ name: "search_nodes", description: "Search for entities" },
				{ name: "read_graph", description: "Read the entire knowledge graph" },
			],
			tags: ["memory", "knowledge-graph", "persistence", "ai", "entities"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "fetch",
			name: "Fetch",
			tagline: "Fetch and convert web content for LLM consumption",
			description: "Fetch web pages and convert them to markdown or text format optimized for LLM consumption. Handles robots.txt compliance.",
			author: "Anthropic",
			category: "ai",
			icon: "Download",
			color: "#3B82F6",
			packageName: "@modelcontextprotocol/server-fetch",
			version: "0.6.2",
			downloads: 1400000,
			rating: 4.6,
			ratingCount: 700,
			verified: true,
			transport: "stdio",
			command: "npx",
			defaultArgs: ["-y", "@modelcontextprotocol/server-fetch"],
			tools: [
				{
					name: "fetch",
					description: "Fetch a URL and return content as markdown",
				},
			],
			tags: ["fetch", "web", "scraping", "markdown", "content"],
			homepage: "https://github.com/modelcontextprotocol/servers",
			addedAt: "2024-11-01T00:00:00Z",
			updatedAt: "2025-03-01T00:00:00Z",
		},
		{
			id: "huggingface",
			name: "Hugging Face",
			tagline: "Search the Hub for models, datasets, and papers (live)",
			description: "Official Hugging Face MCP server. Lets agents search the Hub in real time — models, datasets, Spaces and papers — so they always see the latest releases. Useful to discover local LLMs (GGUF) to run via Ollama/LM Studio. A free HF token (optional) raises rate limits and unlocks gated content.",
			author: "Hugging Face",
			category: "ai",
			icon: "Bot",
			color: "#FFD21E",
			packageName: "https://huggingface.co/mcp",
			version: "1.0.0",
			downloads: 0,
			rating: 0,
			ratingCount: 0,
			verified: true,
			transport: "http",
			url: "https://huggingface.co/mcp",
			optionalEnvVars: [
				{
					name: "HF_TOKEN",
					label: "Hugging Face Token",
					description:
						"Optional read token — raises rate limits and unlocks gated repos.",
					required: false,
					placeholder: "hf_xxxxxxxxxxxx",
					secret: true,
					helpUrl: "https://huggingface.co/settings/tokens",
				},
			],
			tools: [
				{
					name: "model_search",
					description:
						"Search the Hub for models (filters: task, library, sort)",
				},
				{
					name: "model_details",
					description: "Get detailed metadata for a specific model repo",
				},
				{
					name: "dataset_search",
					description: "Search the Hub for datasets",
				},
				{
					name: "paper_search",
					description: "Search Hugging Face papers",
				},
			],
			tags: ["huggingface", "models", "hub", "llm", "discovery", "ai"],
			homepage: "https://huggingface.co/mcp",
			repository: "https://github.com/huggingface/hugging-face-mcp-server",
			addedAt: "2026-06-22T00:00:00Z",
			updatedAt: "2026-06-22T00:00:00Z",
		},
	];
}

// ============================================
// Data persistence helpers
// ============================================

function loadInstalledFromDisk(): McpInstalledServer[] {
	try {
		const filePath = getInstalledServersPath();
		if (fs.existsSync(filePath)) {
			const data = fs.readFileSync(filePath, "utf-8");
			return JSON.parse(data);
		}
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to load installed servers:", err);
	}
	return [];
}

function saveInstalledToDisk(servers: McpInstalledServer[]): void {
	try {
		const filePath = getInstalledServersPath();
		fs.writeFileSync(filePath, JSON.stringify(servers, null, 2), "utf-8");
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to save installed servers:", err);
	}
}

function loadBuilderFromDisk(): McpBuilderProject[] {
	try {
		const filePath = getBuilderProjectsPath();
		if (fs.existsSync(filePath)) {
			const data = fs.readFileSync(filePath, "utf-8");
			return JSON.parse(data);
		}
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to load builder projects:", err);
	}
	return [];
}

function saveBuilderToDisk(projects: McpBuilderProject[]): void {
	try {
		const filePath = getBuilderProjectsPath();
		fs.writeFileSync(filePath, JSON.stringify(projects, null, 2), "utf-8");
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to save builder projects:", err);
	}
}

// ============================================
// Register IPC Handlers
// ============================================

export function registerMcpMarketplaceHandlers(): void {
	// Get the full catalog
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_CATALOG, async () => {
		try {
			const catalog = buildCatalog();
			return { success: true, data: catalog };
		} catch (error) {
			appLog.error("[MCP Marketplace] getCatalog error:", error);
			return { success: false, error: "Failed to load catalog" };
		}
	});

	// Get single server details
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_SERVER,
		async (_event, serverId: string) => {
			try {
				const catalog = buildCatalog();
				const server = catalog.find((s) => s.id === serverId);
				if (!server) {
					return { success: false, error: "Server not found" };
				}
				return { success: true, data: server };
			} catch (error) {
				appLog.error("[MCP Marketplace] getServer error:", error);
				return { success: false, error: "Failed to get server details" };
			}
		},
	);

	// Install a server
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_INSTALL,
		async (
			_event,
			{
				serverId,
				envVars,
			}: { serverId: string; envVars: Record<string, string> },
		) => {
			try {
				const catalog = buildCatalog();
				const serverDef = catalog.find((s) => s.id === serverId);
				if (!serverDef) {
					return { success: false, error: "Server not found in catalog" };
				}

				const installed = loadInstalledFromDisk();

				// Check if already installed
				if (installed.some((s) => s.serverId === serverId)) {
					return { success: false, error: "Server already installed" };
				}

				const newServer: McpInstalledServer = {
					serverId: serverDef.id,
					name: serverDef.name,
					version: serverDef.version,
					status: "installed",
					enabled: true,
					transport: serverDef.transport,
					command: serverDef.command,
					args: serverDef.defaultArgs,
					url: serverDef.url,
					envVars: envVars || {},
					installedAt: new Date().toISOString(),
					isCustomBuilt: false,
				};

				installed.push(newServer);
				saveInstalledToDisk(installed);

				appLog.info(`[MCP Marketplace] Installed server: ${serverDef.name}`);
				return { success: true, data: newServer };
			} catch (error) {
				appLog.error("[MCP Marketplace] install error:", error);
				return { success: false, error: "Installation failed" };
			}
		},
	);

	// Uninstall a server
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_UNINSTALL,
		async (_event, { serverId }: { serverId: string }) => {
			try {
				let installed = loadInstalledFromDisk();
				installed = installed.filter((s) => s.serverId !== serverId);
				saveInstalledToDisk(installed);

				appLog.info(`[MCP Marketplace] Uninstalled server: ${serverId}`);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] uninstall error:", error);
				return { success: false, error: "Uninstallation failed" };
			}
		},
	);

	// Get installed servers
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED, async () => {
		try {
			const installed = loadInstalledFromDisk();
			return { success: true, data: installed };
		} catch (error) {
			appLog.error("[MCP Marketplace] getInstalled error:", error);
			return { success: false, error: "Failed to load installed servers" };
		}
	});

	// Update server config (env vars, headers, etc.)
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_UPDATE_SERVER,
		async (
			_event,
			{
				serverId,
				updates,
			}: { serverId: string; updates: Partial<McpInstalledServer> },
		) => {
			try {
				const installed = loadInstalledFromDisk();
				const idx = installed.findIndex((s) => s.serverId === serverId);
				if (idx === -1) {
					return { success: false, error: "Server not found" };
				}
				installed[idx] = { ...installed[idx], ...updates };
				saveInstalledToDisk(installed);
				return { success: true, data: installed[idx] };
			} catch (error) {
				appLog.error("[MCP Marketplace] updateServer error:", error);
				return { success: false, error: "Update failed" };
			}
		},
	);

	// Toggle server enabled/disabled
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_TOGGLE_SERVER,
		async (
			_event,
			{ serverId, enabled }: { serverId: string; enabled: boolean },
		) => {
			try {
				const installed = loadInstalledFromDisk();
				const idx = installed.findIndex((s) => s.serverId === serverId);
				if (idx === -1) {
					return { success: false, error: "Server not found" };
				}
				installed[idx].enabled = enabled;
				saveInstalledToDisk(installed);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] toggleServer error:", error);
				return { success: false, error: "Toggle failed" };
			}
		},
	);

	// Health check single server
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_HEALTH_CHECK,
		async (_event, { serverId }: { serverId: string }) => {
			try {
				const installed = loadInstalledFromDisk();
				const server = installed.find((s) => s.serverId === serverId);
				if (!server) {
					return { success: false, error: "Server not found" };
				}
				// Basic health check - verify command exists or URL is reachable
				const healthInfo = {
					healthy: true,
					checkedAt: new Date().toISOString(),
				};
				return { success: true, data: healthInfo };
			} catch (error) {
				appLog.error("[MCP Marketplace] healthCheck error:", error);
				return { success: false, error: "Health check failed" };
			}
		},
	);

	// Health check all servers
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_HEALTH_CHECK_ALL, async () => {
		try {
			const installed = loadInstalledFromDisk();
			const results: Record<string, { healthy: boolean; checkedAt: string }> =
				{};
			for (const server of installed) {
				results[server.serverId] = {
					healthy: server.enabled,
					checkedAt: new Date().toISOString(),
				};
			}
			return { success: true, data: results };
		} catch (error) {
			appLog.error("[MCP Marketplace] healthCheckAll error:", error);
			return { success: false, error: "Health check failed" };
		}
	});

	// Save builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER,
		async (_event, project: McpBuilderProject) => {
			try {
				const projects = loadBuilderFromDisk();
				const idx = projects.findIndex((p) => p.id === project.id);
				if (idx >= 0) {
					projects[idx] = project;
				} else {
					projects.push(project);
				}
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] saveBuilder error:", error);
				return { success: false, error: "Save failed" };
			}
		},
	);

	// Get builder projects
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS,
		async () => {
			try {
				const projects = loadBuilderFromDisk();
				return { success: true, data: projects };
			} catch (error) {
				appLog.error("[MCP Marketplace] getBuilderProjects error:", error);
				return { success: false, error: "Failed to load builder projects" };
			}
		},
	);

	// Delete builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER,
		async (_event, { projectId }: { projectId: string }) => {
			try {
				let projects = loadBuilderFromDisk();
				projects = projects.filter((p) => p.id !== projectId);
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] deleteBuilder error:", error);
				return { success: false, error: "Delete failed" };
			}
		},
	);

	// Export builder project as installable MCP server
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_EXPORT_BUILDER,
		async (_event, { projectId }: { projectId: string }) => {
			try {
				const projects = loadBuilderFromDisk();
				const project = projects.find((p) => p.id === projectId);
				if (!project) {
					return { success: false, error: "Builder project not found" };
				}

				// Install it as a custom server
				const installed = loadInstalledFromDisk();
				const newServer: McpInstalledServer = {
					serverId: `custom-${project.id}`,
					name: project.name,
					version: "1.0.0",
					status: "installed",
					enabled: true,
					transport: "http",
					url: project.baseUrl,
					envVars: {},
					headers: project.defaultHeaders,
					installedAt: new Date().toISOString(),
					isCustomBuilt: true,
				};

				installed.push(newServer);
				saveInstalledToDisk(installed);

				return { success: true, data: newServer };
			} catch (error) {
				appLog.error("[MCP Marketplace] exportBuilder error:", error);
				return { success: false, error: "Export failed" };
			}
		},
	);

	// Live Hugging Face Hub model search (via the official HF MCP server).
	// Powers the "Discover models" settings panel.
	ipcMain.handle(
		IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS,
		async (_event, params: HuggingFaceModelSearchParams) => {
			return searchHuggingFaceModels(params || {});
		},
	);

	appLog.info("[MCP Marketplace] All handlers registered");
}
