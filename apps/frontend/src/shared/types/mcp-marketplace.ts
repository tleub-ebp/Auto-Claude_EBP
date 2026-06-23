/**
 * MCP Marketplace Types
 *
 * Types for the MCP Marketplace feature — the universal integration ecosystem.
 * Supports catalog browsing, one-click install, and no-code MCP server building.
 */

/** MCP server categories for marketplace organization */
export type McpCategory =
	| "communication"
	| "project-management"
	| "design"
	| "monitoring"
	| "version-control"
	| "documentation"
	| "database"
	| "cloud"
	| "security"
	| "analytics"
	| "ai"
	| "custom";

/** Installation status of an MCP server */
export type McpInstallStatus =
	| "not_installed"
	| "installing"
	| "installed"
	| "update_available"
	| "error";

/** MCP server transport type */
export type McpTransportType = "stdio" | "http" | "sse";

/**
 * A server entry in the MCP Marketplace catalog.
 */
export interface McpMarketplaceServer {
	/** Unique server identifier (e.g., 'slack', 'jira', 'github') */
	id: string;
	/** Display name */
	name: string;
	/** Short tagline */
	tagline: string;
	/** Full description (markdown supported) */
	description: string;
	/** Publisher / author name */
	author: string;
	/** Category for filtering */
	category: McpCategory;
	/** Icon name (lucide icon key) or URL */
	icon: string;
	/** Brand color (hex) */
	color: string;
	/** NPM package name or GitHub URL */
	packageName: string;
	/** Current version */
	version: string;
	/** Weekly download count (for popularity sorting) */
	downloads: number;
	/** Average rating (0-5) */
	rating: number;
	/** Number of ratings */
	ratingCount: number;
	/** Is this server verified / official */
	verified: boolean;
	/** Transport type */
	transport: McpTransportType;
	/** Command to run (for stdio) */
	command?: string;
	/** Default args */
	defaultArgs?: string[];
	/** URL endpoint (for http/sse) */
	url?: string;
	/** Required environment variables (e.g., API keys) */
	requiredEnvVars?: McpEnvVar[];
	/** Optional environment variables */
	optionalEnvVars?: McpEnvVar[];
	/** List of tools provided by this server */
	tools: McpToolInfo[];
	/** Tags for search */
	tags: string[];
	/** Homepage URL */
	homepage?: string;
	/** Repository URL */
	repository?: string;
	/** Date added to marketplace */
	addedAt: string;
	/** Last updated date */
	updatedAt: string;
}

/** Environment variable required by an MCP server */
export interface McpEnvVar {
	/** Variable name (e.g., SLACK_BOT_TOKEN) */
	name: string;
	/** Human-readable label */
	label: string;
	/** Description / help text */
	description: string;
	/** Is this variable required? */
	required: boolean;
	/** Placeholder value */
	placeholder?: string;
	/** Is this a secret (password-masked)? */
	secret: boolean;
	/** Link to obtain the value (e.g., API key creation page) */
	helpUrl?: string;
}

/** Info about a tool provided by an MCP server */
export interface McpToolInfo {
	/** Tool name */
	name: string;
	/** Tool description */
	description: string;
}

/**
 * An installed MCP server instance.
 */
export interface McpInstalledServer {
	/** References the marketplace server ID */
	serverId: string;
	/** Display name (can be customized) */
	name: string;
	/** Installed version */
	version: string;
	/** Installation status */
	status: McpInstallStatus;
	/** Whether the server is currently enabled */
	enabled: boolean;
	/** Transport type */
	transport: McpTransportType;
	/** Command to run */
	command?: string;
	/** Arguments */
	args?: string[];
	/** URL endpoint */
	url?: string;
	/** Configured environment variables (values stored securely) */
	envVars: Record<string, string>;
	/** Custom headers (for HTTP servers) */
	headers?: Record<string, string>;
	/** Date installed */
	installedAt: string;
	/** Last health check result */
	lastHealthCheck?: McpServerHealthInfo;
	/** Is this a custom-built server (from the builder)? */
	isCustomBuilt: boolean;
}

/** Health check info for an installed server */
export interface McpServerHealthInfo {
	/** Is the server healthy? */
	healthy: boolean;
	/** Response time in ms */
	responseTime?: number;
	/** Error message if unhealthy */
	error?: string;
	/** Timestamp of last check */
	checkedAt: string;
}

// ============================================
// MCP Builder Types (No-Code Server Creation)
// ============================================

/** A tool definition in the MCP Builder */
export interface McpBuilderTool {
	/** Unique tool ID (generated) */
	id: string;
	/** Tool name (snake_case) */
	name: string;
	/** Tool description */
	description: string;
	/** Input parameters schema */
	parameters: McpBuilderParam[];
	/** The action to perform */
	action: McpBuilderAction;
}

/** A parameter for an MCP builder tool */
export interface McpBuilderParam {
	/** Parameter name */
	name: string;
	/** Parameter type */
	type: "string" | "number" | "boolean" | "array" | "object";
	/** Description */
	description: string;
	/** Is required? */
	required: boolean;
	/** Default value */
	defaultValue?: string;
}

/** Action type for an MCP builder tool */
export type McpBuilderActionType = "http_request" | "transform" | "chain";

/** Action config for an MCP builder tool */
export interface McpBuilderAction {
	/** Action type */
	type: McpBuilderActionType;
	/** HTTP config (for http_request) */
	http?: {
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		url: string;
		headers?: Record<string, string>;
		bodyTemplate?: string;
	};
	/** Transform config (for transform type) */
	transform?: {
		template: string;
	};
	/** Chain config (references other tool IDs) */
	chain?: {
		steps: string[];
	};
}

/** Full MCP Builder project (a custom server definition) */
export interface McpBuilderProject {
	/** Unique project ID */
	id: string;
	/** Server name */
	name: string;
	/** Server description */
	description: string;
	/** Icon (lucide key) */
	icon: string;
	/** Brand color */
	color: string;
	/** Base URL for HTTP actions */
	baseUrl?: string;
	/** Default headers for HTTP actions */
	defaultHeaders?: Record<string, string>;
	/** Environment variables */
	envVars: McpEnvVar[];
	/** Tools defined in this server */
	tools: McpBuilderTool[];
	/** Date created */
	createdAt: string;
	/** Date last modified */
	updatedAt: string;
}

// ============================================
// Marketplace Store Types
// ============================================

/** Filter options for the marketplace catalog */
export interface McpMarketplaceFilters {
	search: string;
	category: McpCategory | "all";
	sortBy: "popular" | "rating" | "newest" | "name";
	showInstalledOnly: boolean;
	showVerifiedOnly: boolean;
}

/** Active tab in the marketplace */
export type McpMarketplaceTab = "catalog" | "installed" | "builder";

// ============================================
// Hugging Face Hub discovery (via the official HF MCP server)
// ============================================

/** Parameters for a live Hub model search. */
export interface HuggingFaceModelSearchParams {
	/** Free-text query (model name / keyword). */
	query?: string;
	/** Pipeline task tag, e.g. "text-generation" (default). Empty = any task. */
	task?: string;
	/** Library tag, e.g. "gguf", "transformers". */
	library?: string;
	/** Language code, e.g. "en", "fr". */
	language?: string;
	/** License id, e.g. "apache-2.0", "mit". */
	license?: string;
	/** Organization / user namespace to filter by, e.g. "meta-llama". */
	author?: string;
	/** Sort order. */
	sort?: "trending" | "downloads" | "likes" | "created" | "modified";
	/** Max results to return. */
	limit?: number;
	/** Optional HF read token (raises rate limits, unlocks gated repos). */
	token?: string;
}

/** A single model returned from the Hub. */
export interface HuggingFaceModelInfo {
	/** Repo id, e.g. "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF". */
	id: string;
	/** Lifetime downloads, when available. */
	downloads?: number;
	/** Likes, when available. */
	likes?: number;
	/** Pipeline tag, e.g. "text-generation". */
	pipelineTag?: string;
	/** Primary library, e.g. "gguf", "transformers", when available. */
	library?: string;
	/** Canonical Hub URL for the repo. */
	url: string;
}
