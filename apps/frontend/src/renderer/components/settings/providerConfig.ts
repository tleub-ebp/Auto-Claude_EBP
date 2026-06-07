import { Key, Server } from "lucide-react";
import React from "react";

export interface ProviderConfig {
	apiKey?: string;
	apiUrl?: string;
	model?: string;
	description: string;
	requiresApiKey: boolean;
	placeholder?: string;
	icon: React.ReactNode;
}

// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const getProviderFields = (t: any): Record<string, ProviderConfig> => ({
	openai: {
		apiKey: "globalOpenAIApiKey",
		apiUrl: "globalOpenAIApiBaseUrl",
		model: "globalOpenAIModel",
		description: t("sections.accounts.providers.openai"),
		requiresApiKey: true,
		placeholder: "sk-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	anthropic: {
		apiKey: "globalAnthropicApiKey",
		description: t("sections.accounts.providers.anthropic"),
		requiresApiKey: true,
		placeholder: "sk-ant...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	claude: {
		apiKey: "globalAnthropicApiKey",
		description: t("sections.accounts.providers.anthropic"),
		requiresApiKey: true,
		placeholder: "sk-ant...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	gemini: {
		apiKey: "globalGoogleDeepMindApiKey",
		description: t("sections.accounts.providers.google"),
		requiresApiKey: true,
		placeholder: "AIza...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	google: {
		apiKey: "globalGoogleDeepMindApiKey",
		description: t("sections.accounts.providers.google"),
		requiresApiKey: true,
		placeholder: "AIza...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	"meta-llama": {
		apiKey: "globalMetaApiKey",
		description: t("sections.accounts.providers.meta"),
		requiresApiKey: true,
		placeholder: "META-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	meta: {
		apiKey: "globalMetaApiKey",
		description: t("sections.accounts.providers.meta"),
		requiresApiKey: true,
		placeholder: "META-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	mistral: {
		apiKey: "globalMistralApiKey",
		description: t("sections.accounts.providers.mistral"),
		requiresApiKey: true,
		placeholder: "MISTRAL-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	deepseek: {
		apiKey: "globalDeepSeekApiKey",
		description: t("sections.accounts.providers.deepseek"),
		requiresApiKey: true,
		placeholder: "sk-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	grok: {
		apiKey: "globalGrokApiKey",
		description: t("sections.accounts.providers.grok"),
		requiresApiKey: true,
		placeholder: "xai-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	windsurf: {
		apiKey: "globalWindsurfApiKey",
		description: t("sections.accounts.providers.windsurf"),
		requiresApiKey: true,
		placeholder: "windsurf-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	cursor: {
		apiKey: "globalCursorApiKey",
		description: t("sections.accounts.providers.cursor"),
		requiresApiKey: true,
		placeholder: "crsr-...",
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
	"azure-openai": {
		apiKey: "globalAzureApiKey",
		apiUrl: "globalAzureApiBaseUrl",
		description: t("sections.accounts.providers.aws"),
		requiresApiKey: true,
		placeholder: "Azure API Key...",
		icon: React.createElement(Server, { className: "w-4 h-4" }),
	},
	ollama: {
		apiUrl: "globalOllamaApiUrl",
		model: "globalOllamaModel",
		description: t("sections.accounts.providers.ollama"),
		requiresApiKey: false,
		placeholder: "http://localhost:11434",
		icon: React.createElement(Server, { className: "w-4 h-4" }),
	},
	copilot: {
		description: t("sections.accounts.providers.copilot"),
		requiresApiKey: false,
		icon: React.createElement(Key, { className: "w-4 h-4" }),
	},
});
