import type { AuthMethod, ProfileUsageSummary } from "@shared/types/agent";
import {
	Eye,
	EyeOff,
	Key,
	Loader2,
	LogIn,
	MoreHorizontal,
	Settings,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { GUIDE_ANCHORS } from "../guided-tour/anchors";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

interface CleanProviderCardProps {
	provider: {
		id: string;
		name: string;
		category: string;
		description?: string;
		isConfigured: boolean;
		isWorking?: boolean;
		lastTested?: string;
		usageCount?: number;
		isPremium?: boolean;
		icon?: React.ReactNode;
		// Real data fields
		realUsageData?: ProfileUsageSummary;
		realApiKeyInfo?: {
			hasKey: boolean;
			keyPreview?: string;
			provider?: string;
			isOAuth?: boolean;
			authMethod?: AuthMethod;
		};
	};
	onConfigure?: (providerId: string) => void;
	onTest?: (providerId: string) => void;
	onToggle?: (providerId: string, enabled: boolean) => void;
	onRemove?: (providerId: string) => void;
	className?: string;
	isAutoSwitchingOpen?: boolean; // Nouvelle prop pour détecter l'état de l'auto-switching
	isTesting?: boolean; // Nouvelle prop pour l'état de test
}

// Icônes officielles exactes du ProviderSelector - respectent déjà les couleurs du thème
const providerIcons: Record<string, React.ReactNode> = {
	// Anthropic — logo officiel (lettre A stylisée)
	anthropic: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Anthropic"
		>
			<title>Anthropic</title>
			<path
				d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.674 20H0L6.57 3.52zm4.132 9.959L8.453 7.687 6.205 13.479h4.496z"
				fill="#CC785C"
			/>
		</svg>
	),
	claude: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Claude"
		>
			<title>Claude</title>
			<path
				d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.674 20H0L6.57 3.52zm4.132 9.959L8.453 7.687 6.205 13.479h4.496z"
				fill="#CC785C"
			/>
		</svg>
	),
	// OpenAI — logo officiel amélioré avec couleur verte fixe pour maximum de visibilité
	openai: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="OpenAI"
		>
			<title>OpenAI</title>
			<path
				d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0L3.86 14.026a4.505 4.505 0 0 1-1.52-6.13zm16.597 3.855l-5.843-3.369 2.02-1.168a.076.076 0 0 1 .071 0l4.957 2.812a4.496 4.496 0 0 1-.692 8.115v-5.678a.795.795 0 0 0-.513-.712zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.956-2.817a4.5 4.5 0 0 1 6.683 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.397.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"
				fill="#10A37F"
			/>
		</svg>
	),
	// Ollama — logo officiel (llama vectorisé simplifié) — currentColor pour s'adapter au thème
	ollama: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 100 100"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Ollama"
		>
			<title>Ollama</title>
			<circle cx="36" cy="32" r="10" fill="currentColor" />
			<circle cx="64" cy="32" r="10" fill="currentColor" />
			<ellipse cx="50" cy="62" rx="22" ry="18" fill="currentColor" />
			<rect x="29" y="74" width="10" height="18" rx="5" fill="currentColor" />
			<rect x="61" y="74" width="10" height="18" rx="5" fill="currentColor" />
		</svg>
	),
	// Google Gemini — logo officiel (étoile 4 branches dégradée)
	google: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Google Gemini"
		>
			<title>Google Gemini</title>
			<defs>
				<linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stopColor="#4285F4" />
					<stop offset="50%" stopColor="#9B72CB" />
					<stop offset="100%" stopColor="#D96570" />
				</linearGradient>
			</defs>
			<path
				d="M12 2C12 2 13.5 8.5 18 12C13.5 15.5 12 22 12 22C12 22 10.5 15.5 6 12C10.5 8.5 12 2 12 2Z"
				fill="url(#gemini-grad)"
			/>
		</svg>
	),
	// Mistral AI — logo officiel (blocs géométriques empilés)
	mistral: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Mistral AI"
		>
			<title>Mistral AI</title>
			<rect x="2" y="2" width="6" height="6" fill="#F7521E" />
			<rect x="10" y="2" width="6" height="6" fill="#F7521E" />
			<rect x="18" y="2" width="4" height="6" fill="#F7521E" />
		</svg>
	),
	// DeepSeek — logo officiel (œil stylisé bleu)
	deepseek: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="DeepSeek"
		>
			<title>DeepSeek</title>
			<path
				d="M22.433 9.257c-.173-.08-.537.03-.686.08-.122.03-.275.08-.428.152a9.16 9.16 0 0 0-.62-.833c-.02-.021-.04-.05-.061-.07a9.993 9.993 0 0 0-2.16-1.87A9.675 9.675 0 0 0 12.047 5c-2.627 0-5.05.985-6.847 2.607A9.7 9.7 0 0 0 2.07 14.9a9.695 9.695 0 0 0 9.692 8.594c4.68 0 8.617-3.335 9.49-7.772.061-.304-.02-.487-.183-.567-.163-.08-.396.01-.52.304a8.476 8.476 0 0 1-8.237 5.53A8.467 8.467 0 0 1 3.82 13.5a8.463 8.463 0 0 1 8.463-8.463c2.16 0 4.14.812 5.63 2.14.366.325.701.68 1.006 1.058-.437.212-.843.507-1.168.893-.61.73-.864 1.703-.7 2.637.122.71.477 1.329.995 1.773.518.446 1.168.69 1.849.69.254 0 .508-.03.752-.09.752-.192 1.34-.71 1.614-1.401.213-.548.213-1.137.01-1.642-.193-.497-.57-.894-1.078-1.126l-.002-.002z"
				fill="#4D6BFE"
			/>
		</svg>
	),
	// Meta — logo officiel (ruban infini stylisé bleu/violet)
	meta: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Meta"
		>
			<title>Meta</title>
			<defs>
				<linearGradient id="meta-grad" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stopColor="#0082FB" />
					<stop offset="100%" stopColor="#A33BC2" />
				</linearGradient>
			</defs>
			<path
				d="M2.002 12.87c0 1.356.3 2.394.694 3.053.511.853 1.27 1.302 2.145 1.302 1.03 0 1.972-.254 3.794-2.73l1.698-2.326.005-.007 1.466-2.007c1.01-1.38 2.178-2.943 3.72-2.943 1.334 0 2.59.776 3.566 2.24.865 1.3 1.302 2.948 1.302 4.64 0 1.01-.2 1.77-.538 2.337-.328.548-.956 1.095-2.013 1.095v-2.17c.906 0 1.13-.832 1.13-1.308 0-1.283-.298-2.72-.959-3.718-.488-.74-1.121-1.17-1.787-1.17-.727 0-1.343.485-2.098 1.534l-1.505 2.059-.008.011-.44.602.019.025 1.364 1.875c.99 1.359 1.563 2.044 2.176 2.044.338 0 .685-.12.957-.367l.018-.016.946 1.784-.017.015c-.65.579-1.452.817-2.212.817-.936 0-1.747-.364-2.435-1.09a14.82 14.82 0 0 1-.605-.74l-.86-1.18-.009-.013-1.155 1.575C8.697 16.76 7.608 17.21 6.5 17.21c-1.32 0-2.396-.52-3.143-1.51-.693-.93-1.04-2.198-1.04-3.66l2.685-.17z"
				fill="url(#meta-grad)"
			/>
		</svg>
	),
	// AWS — logo officiel (smile + flèche)
	aws: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="AWS"
		>
			<title>AWS</title>
			<path
				d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.383-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.030-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296z"
				fill="#FF9900"
			/>
			<path
				d="M21.422 16.956c-2.597 1.923-6.37 2.942-9.613 2.942-4.549 0-8.647-1.683-11.742-4.48-.243-.22-.025-.52.267-.349 3.342 1.947 7.47 3.12 11.733 3.12 2.877 0 6.037-.597 8.95-1.836.439-.187.808.287.405.603z"
				fill="#FF9900"
			/>
		</svg>
	),
	// GitHub Copilot — logo officiel (octocat stylisé)
	copilot: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="GitHub Copilot"
		>
			<title>GitHub Copilot</title>
			<path
				d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
				fill="#333333"
			/>
		</svg>
	),
	// Windsurf — logo Codeium (onde stylisée)
	windsurf: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Windsurf"
		>
			<title>Windsurf</title>
			<path
				d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"
				fill="#00D4AA"
			/>
		</svg>
	),
	// Cursor — logo (flèche de curseur stylisée)
	cursor: (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Cursor"
		>
			<title>Cursor</title>
			<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" fill="#000000" />
		</svg>
	),
	// Azure OpenAI — logo combiné
	"azure-openai": (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Azure OpenAI"
		>
			<title>Azure OpenAI</title>
			<circle cx="8" cy="8" r="6" fill="#0078D4" />
			<path
				d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494z"
				fill="#0078D4"
			/>
		</svg>
	),
};

export function CleanProviderCard({
	provider,
	onConfigure,
	onTest,
	onToggle,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	onRemove,
	className,
	isAutoSwitchingOpen = false,
	isTesting = false,
}: Readonly<CleanProviderCardProps>) {
	const { t, i18n } = useTranslation("settings");
	const [isExpanded, setIsExpanded] = useState(false);
	const [showApiKey, setShowApiKey] = useState(false);

	// Safe callback handlers with null checks
	const handleConfigure = () => {
		if (onConfigure) {
			onConfigure(provider.id);
		}
	};

	const handleTest = () => {
		if (onTest) {
			onTest(provider.id);
		}
	};

	const handleToggle = (enabled: boolean) => {
		if (onToggle) {
			onToggle(provider.id, enabled);
		}
	};

	const ProviderIcon = providerIcons[provider.id] || (
		<div className="w-4 h-4 bg-gray-400 rounded" />
	);

	// An account whose token can no longer be auto-refreshed (revoked/expired
	// refresh token). Takes visual priority over the generic "active" state so
	// the card never shows "OAuth connected" and "re-auth required" at once.
	const needsReauth = provider.realUsageData?.needsReauthentication === true;

	const getStatusColor = () => {
		if (!provider.isConfigured) return "text-muted-foreground";
		if (needsReauth) return "text-amber-600 dark:text-amber-500";
		if (provider.isWorking === false) return "text-destructive";
		return "text-foreground";
	};

	const getStatusText = () => {
		if (!provider.isConfigured) {
			return t("sections.accounts.providerCard.status.notConfigured");
		}

		if (needsReauth) {
			return t("sections.accounts.providerCard.needsReauth");
		}

		if (provider.isWorking === false) {
			return t("sections.accounts.providerCard.status.error");
		}

		return t("sections.accounts.providerCard.status.active");
	};

	const getCompactStatusText = () => {
		if (!provider.isConfigured) return "NC"; // Non Configuré
		if (needsReauth) return "RE-AUTH"; // Token révoqué/expiré
		if (provider.isWorking === false) return "ERR"; // Erreur
		return "OK"; // Actif
	};

	const renderUsageSection = () => {
		if (provider.realUsageData) {
			return (
				<div className="flex items-center justify-between text-xs text-gray-500">
					<span>{t("sections.accounts.providerCard.usage")}</span>
					<div className="text-right">
						<div className="font-medium text-gray-700">
							{provider.realUsageData.sessionPercent !== null
								? `${Math.round(provider.realUsageData.sessionPercent)}%`
								: "N/A"}
						</div>
						{Boolean(provider.realUsageData.weeklyPercent) && (
							<div className="text-gray-400 text-[10px]">
								{t("sections.accounts.providerCard.week")}:{" "}
								{Math.round(provider.realUsageData.weeklyPercent)}%
							</div>
						)}
					</div>
				</div>
			);
		}

		if (provider.usageCount) {
			return (
				<div className="flex items-center justify-between text-xs text-gray-500">
					<span>{t("sections.accounts.providerCard.usageThisMonth")}</span>
					<span className="font-medium text-gray-700">
						{provider.usageCount}
					</span>
				</div>
			);
		}

		return (
			<div className="flex items-center justify-between text-xs text-gray-400">
				<span>{t("sections.accounts.providerCard.usage")}</span>
				<span className="italic">
					{t("sections.accounts.providerCard.notAvailable")}
				</span>
			</div>
		);
	};

	const getAuthMethodText = () => {
		const authMethod = provider.realApiKeyInfo?.authMethod;

		if (authMethod === "cli") {
			return t("sections.accounts.providerCard.authCli");
		}

		if (authMethod === "oauth") {
			return t("sections.accounts.providerCard.authOauth");
		}

		if (authMethod === "local") {
			return t("sections.accounts.providerCard.authLocal");
		}

		return t("sections.accounts.providerCard.apiKey");
	};

	const renderAuthStatus = () => {
		// Re-auth required takes priority over the credential/OAuth badge: the
		// token exists but is revoked/expired, so showing "OAuth connected" here
		// would contradict the status. Offer a one-click reconnect instead.
		if (needsReauth) {
			return (
				<div className="flex items-center gap-2 min-w-0">
					<span className="px-2 py-1 rounded text-xs font-medium text-amber-700 dark:text-amber-500 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 truncate">
						{t("sections.accounts.providerCard.needsReauth")}
					</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleConfigure}
						className="h-6 px-2 text-xs shrink-0 text-amber-700 dark:text-amber-500 hover:bg-amber-100/60 dark:hover:bg-amber-500/15"
					>
						<LogIn className="w-3 h-3 mr-1" />
						{t("common:usage.reauthToastAction")}
					</Button>
				</div>
			);
		}

		if (!provider.realApiKeyInfo?.hasKey) {
			return (
				<span className="text-gray-400 italic">
					{t("sections.accounts.providerCard.notConfigured")}
				</span>
			);
		}

		const authMethod = provider.realApiKeyInfo?.authMethod;

		if (authMethod === "cli") {
			return (
				<div className="px-2 py-1 bg-blue-50 rounded text-xs font-medium text-blue-700 border border-blue-200">
					{t("sections.accounts.providerCard.cliAuthenticated")}
				</div>
			);
		}

		if (authMethod === "oauth") {
			return (
				<div className="px-2 py-1 bg-green-50 rounded text-xs font-medium text-green-700 border border-green-200">
					{t("sections.accounts.providerCard.oauthConnected")}
				</div>
			);
		}

		if (authMethod === "local") {
			return (
				<div className="px-2 py-1 bg-purple-50 rounded text-xs font-medium text-purple-700 border border-purple-200">
					{t("sections.accounts.providerCard.localRunning")}
				</div>
			);
		}

		// Default case: API key with show/hide functionality
		return (
			<>
				<code className="px-2 py-1 bg-gray-50 rounded text-xs font-mono text-gray-600 break-all min-w-0 flex-1 select-all cursor-text">
					{showApiKey && provider.realApiKeyInfo.keyPreview
						? provider.realApiKeyInfo.keyPreview
						: provider.realApiKeyInfo.keyPreview
							? `${provider.realApiKeyInfo.keyPreview.substring(0, 8)} ${"•".repeat(Math.min(provider.realApiKeyInfo.keyPreview.length - 8, 24))}`
							: "••••••••••••••••••••••••••••••••"}
				</code>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowApiKey(!showApiKey)}
					className="h-5 w-5 p-0 shrink-0"
				>
					{showApiKey ? (
						<EyeOff className="w-3 h-3" />
					) : (
						<Eye className="w-3 h-3" />
					)}
				</Button>
			</>
		);
	};

	return (
		<div
			className={cn(
				"border rounded-lg p-4 space-y-3 transition-colors",
				!provider.isConfigured && "border-border bg-muted/30",
				provider.isWorking === false &&
					"border-destructive/50 bg-destructive/5",
				provider.isConfigured &&
					provider.isWorking !== false &&
					"border-border bg-background",
				className,
			)}
		>
			{/* Header principal */}
			<div className="flex items-start gap-3">
				{/* Icône minimaliste */}
				<div className="flex items-center justify-center w-8 h-8 rounded bg-muted shrink-0">
					{ProviderIcon}
				</div>

				{/* Informations */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<h3 className="font-medium text-sm truncate">{provider.name}</h3>
						{provider.isPremium && (
							<div className="w-3 h-3 bg-primary/20 rounded-full flex items-center justify-center shrink-0">
								<span className="text-xs text-primary">★</span>
							</div>
						)}
					</div>
					{provider.description && (
						<p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
							{provider.description}
						</p>
					)}
				</div>

				{/* Statut compact */}
				<div className="flex items-center gap-2 min-w-0">
					<div
						className={cn(
							"flex items-center gap-1.5 text-xs min-w-0",
							getStatusColor(),
						)}
					>
						<div
							className={cn(
								"w-1.5 h-1.5 rounded-full shrink-0",
								!provider.isConfigured && "bg-muted-foreground",
								provider.isConfigured &&
									needsReauth &&
									"bg-amber-500 motion-safe:animate-pulse",
								provider.isConfigured &&
									!needsReauth &&
									provider.isWorking === false &&
									"bg-destructive",
								provider.isConfigured &&
									!needsReauth &&
									provider.isWorking !== false &&
									"bg-green-500",
							)}
						/>
						<span
							className={
								isAutoSwitchingOpen ? "truncate max-w-[60px]" : "truncate"
							}
						>
							{isAutoSwitchingOpen ? getCompactStatusText() : getStatusText()}
						</span>
					</div>

					{/* Toggle switch discret */}
					{provider.isConfigured && (
						<Switch
							checked={provider.isWorking !== false}
							onCheckedChange={(checked) => handleToggle(checked)}
							className="shrink-0"
						/>
					)}
				</div>
			</div>

			{/* Actions principales */}
			<div className="flex items-center justify-between pt-2 border-t border-gray-100">
				<div className="flex items-center gap-2">
					{provider.isConfigured ? (
						<>
							<Button
								onClick={handleTest}
								variant="ghost"
								size="sm"
								className="h-7 px-3 text-xs"
								disabled={isTesting}
							>
								{isTesting ? (
									<>
										<Loader2 className="w-3 h-3 mr-1 animate-spin" />
										Test...
									</>
								) : (
									t("sections.accounts.providerCard.test")
								)}
							</Button>
							<Button
								onClick={handleConfigure}
								variant="ghost"
								size="sm"
								className="h-7 px-3 text-xs"
							>
								<Settings className="w-3 h-3 mr-1" />
								{t("sections.accounts.providerCard.edit")}
							</Button>
						</>
					) : (
						<Button
							data-guide={GUIDE_ANCHORS.providers.configure}
							onClick={handleConfigure}
							variant="outline"
							size="sm"
							className="h-7 px-3 text-xs"
						>
							<Key className="w-3 h-3 mr-1" />
							{t("sections.accounts.providerCard.configure")}
						</Button>
					)}
				</div>

				{/* Bouton d'expansion minimaliste */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setIsExpanded(!isExpanded)}
					className="h-7 w-7 p-0"
				>
					<MoreHorizontal className="w-4 h-4" />
				</Button>
			</div>

			{/* Détails étendus */}
			{isExpanded && provider.isConfigured && (
				<div className="pt-2 border-t border-gray-100 space-y-2">
					{/* Authentication method */}
					<div className="flex items-center justify-between text-xs">
						<span className="text-gray-500 shrink-0">
							{getAuthMethodText()}
						</span>
						<div className="flex items-center gap-2 min-w-0 flex-1 max-w-[60%]">
							{renderAuthStatus()}
						</div>
					</div>

					{/* Dernier test */}
					{provider.lastTested ? (
						<div className="flex items-center justify-between text-xs text-gray-500">
							<span>{t("sections.accounts.providerCard.lastTest")}</span>
							<span>
								{new Date(provider.lastTested).toLocaleDateString(
									i18n.language === "fr" ? "fr-FR" : "en-US",
									{
										day: "2-digit",
										month: "2-digit",
										year: "numeric",
										hour: "2-digit",
										minute: "2-digit",
										second: "2-digit",
									},
								)}
							</span>
						</div>
					) : (
						<div className="flex items-center justify-between text-xs text-gray-400">
							<span>{t("sections.accounts.providerCard.lastTest")}</span>
							<span className="italic">
								{t("sections.accounts.providerCard.neverTested")}
							</span>
						</div>
					)}

					{/* Utilisations */}
					{renderUsageSection()}

					{/* Provider source */}
					{provider.realApiKeyInfo?.provider && (
						<div className="flex items-center justify-between text-xs text-gray-500">
							<span>{t("sections.accounts.providerCard.source")}</span>
							<span className="text-gray-600">
								{provider.realApiKeyInfo.provider}
							</span>
						</div>
					)}

					{/* Statut du provider */}
					{provider.realUsageData?.isRateLimited && (
						<div className="flex items-center justify-between text-xs text-orange-600">
							<span>{t("sections.accounts.providerCard.statusLabel")}</span>
							<span className="font-medium">
								{t("sections.accounts.providerCard.rateLimited")}
							</span>
						</div>
					)}
					{/* Re-auth state is surfaced in the header status + auth row above
					    (with a reconnect action), so it is intentionally not repeated here. */}
				</div>
			)}
		</div>
	);
}
