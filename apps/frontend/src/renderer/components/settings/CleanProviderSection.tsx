import { getProvider as getRegistryProvider } from "@shared/services/providerRegistry";
import { ProviderService } from "@shared/services/providerService";
import { detectProvider } from "@shared/utils/provider-detection";
import type {
	AuthMethod,
	ProfileUsageSummary,
	UsageSnapshot,
} from "@shared/types/agent";
import type { AppSettings } from "@shared/types/settings";
import {
	type CanonicalProvider,
	getStaticProviders,
} from "@shared/utils/providers";
import { Activity, AlertCircle, Info, Loader2, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import {
	saveSettings as saveSettingsToDisk,
	useSettingsStore,
} from "@/stores/settings-store";
import { useProviderContext } from "../ProviderContext";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { CleanProviderGrid } from "./CleanProviderGrid";
import { GlobalAutoSwitching } from "./GlobalAutoSwitching";
import { getAllConnectors } from "./multiconnector/utils";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import { SettingsSection } from "./SettingsSection";

interface Provider {
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
}

interface CleanProviderSectionProps {
	settings: AppSettings & Record<string, unknown>;
	onSettingsChange: (settings: AppSettings & Record<string, unknown>) => void;
	isOpen: boolean;
}

const providerCategories: Record<string, string> = {
	anthropic: "independent",
	claude: "independent",
	openai: "openai",
	ollama: "independent",
	gemini: "google",
	google: "google",
	"meta-llama": "meta",
	meta: "meta",
	mistral: "independent",
	deepseek: "independent",
	grok: "independent",
	windsurf: "independent",
	cursor: "independent",
	copilot: "independent",
	aws: "microsoft",
	"azure-openai": "microsoft",
};

// Determine the auth method for a provider using providerRegistry as source of truth
// Extracted outside the component to keep a stable reference and avoid infinite re-renders.
const getProviderAuthMethod = (providerId: string): AuthMethod => {
	const registryProvider = getRegistryProvider(providerId);
	if (registryProvider) {
		if (registryProvider.requiresCLI) return "cli";
		if (registryProvider.requiresOAuth && !registryProvider.requiresApiKey)
			return "oauth";
		if (
			!registryProvider.requiresApiKey &&
			!registryProvider.requiresOAuth &&
			!registryProvider.requiresCLI
		)
			return "local";
	}
	return "api-key";
};

export function CleanProviderSection({
	settings: _propsSettings,
	onSettingsChange: propsOnSettingsChange,
	isOpen,
}: Readonly<CleanProviderSectionProps>) {
	const { t } = useTranslation("settings");
	const { t: tCommon } = useTranslation("common");
	const { toast } = useToast();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [testingProviders, setTestingProviders] = useState<Set<string>>(
		new Set(),
	);
	const [autoSwitchingOpen, setAutoSwitchingOpen] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState<Provider | null>(
		null,
	);
	const [configDialogOpen, setConfigDialogOpen] = useState(false);
	const [providersState, setProvidersState] = useState<Provider[]>([]);

	// Real data states
	const [profileUsageData, setProfileUsageData] = useState<
		Map<string, ProfileUsageSummary>
	>(new Map());
	const [providerTestResults, setProviderTestResults] = useState<
		Map<string, { date: string; success: boolean }>
	>(new Map());
	const [credentialUsageData, setCredentialUsageData] = useState<
		Map<
			string,
			{
				usage: {
					sessionPercent?: number;
					weeklyPercent?: number;
					needsReauthentication?: boolean;
				};
				profileId?: string;
				profileName?: string;
			}
		>
	>(new Map());

	// Use store directly for real-time updates (like ProviderSelector)
	const {
		profiles,
		settings: storeSettings,
		updateSettings,
	} = useSettingsStore();
	const { setSelectedProvider: setContextProvider } = useProviderContext();

	// Create a unified settings object and onSettingsChange that updates both props and store
	const settings = storeSettings;
	const onSettingsChange = async (newSettings: AppSettings & Record<string, unknown>) => {
		// Update props for backward compatibility
		propsOnSettingsChange(newSettings);
		// Update store for real-time sync across components
		updateSettings(newSettings);
		// Persist to disk so settings survive app restart
		await saveSettingsToDisk(newSettings);
	};

	// Load real data when section is opened (runs once when panel opens)
	// eslint-disable-next-line react-hooks/exhaustive-deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	useEffect(() => {
		if (isOpen) {
			loadConnectors();
			loadProfileUsageData();
			loadProviderTestResults();
			loadCredentialManagerUsageData();
		}
	}, [isOpen]);

	// Subscribe to live usage updates so the card refreshes without reopening settings
	// eslint-disable-next-line react-hooks/exhaustive-deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	useEffect(() => {
		if (!isOpen) return;

		// onUsageUpdated fires after each poll with the freshest snapshot for the active profile.
		// We use it as the primary source because it reflects currentUsage directly, avoiding
		// the stale-cache issue where getAllProfilesUsage returns 0% when cache pre-dates the poll.
		const unsubscribeUsage =
			globalThis.electronAPI?.onUsageUpdated?.(handleUsageUpdated);

		const unsubscribeAllProfiles =
			globalThis.electronAPI?.onAllProfilesUsageUpdated?.(
				handleAllProfilesUsageUpdated,
			);

		return () => {
			unsubscribeUsage?.();
			unsubscribeAllProfiles?.();
		};
	}, [isOpen]);

	// Extracted callback handlers to reduce nesting
	const handleUsageUpdated = (snapshot: UsageSnapshot) => {
		if (!snapshot?.profileId) return;
		const summary: ProfileUsageSummary = {
			profileId: snapshot.profileId,
			profileName: snapshot.profileName,
			profileEmail: snapshot.profileEmail,
			sessionPercent: snapshot.sessionPercent,
			weeklyPercent: snapshot.weeklyPercent,
			sessionResetTimestamp: snapshot.sessionResetTimestamp,
			weeklyResetTimestamp: snapshot.weeklyResetTimestamp,
			isAuthenticated: true,
			// If a fresh snapshot came back with real usage data, the user is not blocked
			isRateLimited: false,
			availabilityScore:
				100 - Math.max(snapshot.sessionPercent, snapshot.weeklyPercent),
			isActive: true,
			needsReauthentication: snapshot.needsReauthentication,
		};
		setProfileUsageData((prev) =>
			new Map(prev).set(snapshot.profileId, summary),
		);
	};

	const handleAllProfilesUsageUpdated = (allProfilesUsage: { allProfiles: ProfileUsageSummary[] }) => {
		setProfileUsageData((prev) => {
			const next = new Map(prev);
			allProfilesUsage.allProfiles.forEach((profile: ProfileUsageSummary) => {
				// The active profile is always handled by onUsageUpdated which has fresher data.
				// getAllProfilesUsage uses a TTL cache that can lag behind the live poll by 1+ minute,
				// so we must not let it overwrite the real-time data we already have.
				if (profile.isActive) return;
				next.set(profile.profileId, profile);
			});
			return next;
		});
	};

	// Load connectors
	const loadConnectors = async () => {
		setIsLoading(true);
		setError(null);
		try {
			await getAllConnectors();
		} catch (err) {
			console.error("Failed to load connectors:", err);
			setError(t("sections.accounts.providers.loadError"));
		} finally {
			setIsLoading(false);
		}
	};

	// Load profile usage data (Claude OAuth profiles)
	const loadProfileUsageData = async () => {
		try {
			const result =
				await globalThis.electronAPI.requestAllProfilesUsage?.(true);
			if (result?.success && result.data) {
				const usageMap = new Map<string, ProfileUsageSummary>();
				result.data.allProfiles.forEach((profile: ProfileUsageSummary) => {
					usageMap.set(profile.profileId, profile);
				});
				setProfileUsageData(usageMap);
			}
		} catch (err) {
			console.warn(
				"[CleanProviderSection] Failed to load profile usage data:",
				err,
			);
		}
		// Trigger a fresh REAL API fetch AFTER the initial (potentially stale) data is set.
		// Passing 'anthropic' forces getUsageForProvider() which makes a real OAuth API call,
		// unlike requestUsageUpdate() with no args which only returns the cached currentUsage.
		// The result is emitted as usage-updated → handleUsageUpdated overwrites stale data.
		// Also fetch Copilot Premium Requests so the card shows real consumption.
		const providersWithLiveUsage = ["anthropic", "copilot"] as const;
		await Promise.all(
			providersWithLiveUsage.map(async (provider) => {
				try {
					const freshResult =
						await globalThis.electronAPI?.requestUsageUpdate?.(provider);
					const freshSnapshot = freshResult?.data ?? null;
					if (freshResult?.success && freshSnapshot) {
						handleUsageUpdated(freshSnapshot);
					}
				} catch (err) {
					console.warn(
						`[CleanProviderSection] Failed to fetch fresh usage for ${provider}:`,
						err,
					);
				}
			}),
		);
	};

	// Load usage data from CredentialManager (Windsurf, etc.)
	const loadCredentialManagerUsageData = async () => {
		try {
			if (!globalThis.electronAPI?.invoke) return;
			// Trigger on-demand fetch for windsurf
			globalThis.electronAPI.invoke("usage:getData", "windsurf").catch(() => {
				/* noop */
			});
			// Get all cached usage data
			const allUsage = (await globalThis.electronAPI.invoke(
				"usage:getAllData",
			)) as Record<
				string,
				{
					provider: string;
					profileId?: string;
					profileName?: string;
					usage: {
						sessionPercent?: number;
						weeklyPercent?: number;
						needsReauthentication?: boolean;
					};
					timestamp: number;
				}
			>;
			if (allUsage) {
				const usageMap = new Map<
					string,
					{
						usage: {
							sessionPercent?: number;
							weeklyPercent?: number;
							needsReauthentication?: boolean;
						};
						profileId?: string;
						profileName?: string;
					}
				>();
				Object.entries(allUsage).forEach(([provider, data]) => {
					usageMap.set(provider, {
						usage: data.usage,
						profileId: data.profileId,
						profileName: data.profileName,
					});
				});
				setCredentialUsageData(usageMap);
			}
		} catch (err) {
			console.warn(
				"[CleanProviderSection] Failed to load credential usage data:",
				err,
			);
		}
	};

	// Silently test all configured providers that have never been tested
	const autoTestConfiguredProviders = async (
		providerList: { id: string; isConfigured: boolean }[],
	) => {
		const untested = providerList.filter(
			(p) => p.isConfigured && !providerTestResults.has(p.id),
		);
		for (const provider of untested) {
			try {
				const currentProfiles = useSettingsStore.getState().profiles;
				ProviderService.setProfiles(currentProfiles);
				const result = await ProviderService.testProvider(provider.id);
				const testResult = {
					date: new Date().toISOString(),
					success: result.success,
				};
				setProviderTestResults((prev) =>
					new Map(prev).set(provider.id, testResult),
				);
				const currentSettings = useSettingsStore.getState().settings;
				onSettingsChange({
					...currentSettings,
					[`testResult_${provider.id}`]: testResult,
				});
				if (result.success) {
					setProviderStatus((prev) => ({ ...prev, [provider.id]: true }));
				}
			} catch {
				// Silent failure — don't block loading
			}
		}
	};

	// Load provider test results from settings or backend
	const loadProviderTestResults = async () => {
		try {
			// For now, we'll simulate loading test results
			// In a real implementation, this would load from a backend API or settings
			const testResults = new Map<string, { date: string; success: boolean }>();

			// Check if we have any recent test results in settings
			Object.keys(settings).forEach((key) => {
				if (key.startsWith("testResult_")) {
					const providerId = key.replace("testResult_", "");
					const result = (settings as AppSettings & Record<string, unknown>)[key] as { date?: string; success?: boolean };
					if (result?.date) {
						testResults.set(providerId, {
							date: result.date,
							success: result.success || false,
						});
					}
				}
			});

			setProviderTestResults(testResults);
		} catch (err) {
			console.warn(
				"[CleanProviderSection] Failed to load provider test results:",
				err,
			);
		}
	};

	// Helper function to detect provider from URL (uses hostname-safe parsing)
	const detectProviderFromUrl = (url: string): string => {
		return detectProvider(url);
	};

	// Helper function to get API key field for provider
	const getProviderApiKeyField = useCallback((providerId: string): string | null => {
		const apiKeyMap: Record<string, string> = {
			openai: "globalOpenAIApiKey",
			gemini: "globalGoogleApiKey",
			google: "globalGoogleDeepMindApiKey",
			meta: "globalMetaApiKey",
			"meta-llama": "globalMetaLlamaApiKey",
			mistral: "globalMistralApiKey",
			deepseek: "globalDeepSeekApiKey",
			grok: "globalGrokApiKey",
			windsurf: "globalWindsurfApiKey",
			cursor: "globalCursorApiKey",
			aws: "globalAWSApiKey",
			"azure-openai": "globalOpenAIApiKey",
		};
		return apiKeyMap[providerId] || null;
	}, []);

	// Utiliser la même logique que ProviderSelector pour déterminer le statut
	const [staticProviders, setStaticProviders] = useState<CanonicalProvider[]>(
		[],
	);
	const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>(
		{},
	);

	// Get API key info for a provider
	// biome-ignore lint/correctness/useExhaustiveDependencies: detectProviderFromUrl and getProviderApiKeyField are pure helpers
	const getApiKeyInfo = useCallback(
		(
			providerId: string,
		): {
			hasKey: boolean;
			keyPreview?: string;
			provider?: string;
			isOAuth?: boolean;
			authMethod?: AuthMethod;
		} => {
			// Determine auth method from registry
			const authMethod = getProviderAuthMethod(providerId);
			const isOAuthOrCLI = authMethod === "cli" || authMethod === "oauth";

			const isGoogleApisHost = (urlString?: string): boolean => {
				if (!urlString) return false;
				try {
					const hostname = new URL(urlString).hostname.toLowerCase();
					return (
						hostname === "googleapis.com" || hostname.endsWith(".googleapis.com")
					);
				} catch {
					return false;
				}
			};

			// Special handling for OAuth providers like Windsurf that don't need profiles
			if (isOAuthOrCLI && providerId === "windsurf") {
				// Check if Windsurf OAuth token is available via backend status
				const isConfigured = providerStatus[providerId] || false;
				if (isConfigured) {
					return {
						hasKey: true,
						keyPreview: undefined,
						provider: "Windsurf OAuth",
						isOAuth: true,
						authMethod: "oauth",
					};
				}
			}

			// Check profiles for API keys
			const profile = profiles.find((p) => {
				if (!p.baseUrl) return false;
				const detectedProvider = detectProviderFromUrl(p.baseUrl);
				return (
					detectedProvider === providerId ||
					(providerId === "claude" && detectedProvider === "anthropic") ||
					(providerId === "gemini" && isGoogleApisHost(p.baseUrl)) ||
					(providerId === "google" && isGoogleApisHost(p.baseUrl))
				);
			});

			if (profile?.apiKey) {
				return {
					hasKey: true,
					keyPreview: profile.apiKey,
					provider: profile.name,
					isOAuth: false,
					authMethod: "api-key",
				};
			}

			// Check settings for API keys (for providers like OpenAI, etc.)
			const apiKeyField = getProviderApiKeyField(providerId);
			if (apiKeyField && (settings as AppSettings & Record<string, unknown>)[apiKeyField]) {
				return {
					hasKey: true,
					keyPreview: (settings as AppSettings & Record<string, unknown>)[apiKeyField] as string,
					isOAuth: false,
					authMethod: "api-key",
				};
			}

			// For other OAuth/CLI providers, check if they are configured (even without API key)
			if (isOAuthOrCLI && profile) {
				return {
					hasKey: true,
					keyPreview: undefined,
					provider: profile.name,
					isOAuth: true,
					authMethod,
				};
			}

			// For local providers (e.g. Ollama), mark as configured without a key
			if (authMethod === "local") {
				return {
					hasKey: true,
					keyPreview: undefined,
					isOAuth: false,
					authMethod: "local",
				};
			}

			// Fallback: if the provider is active but no API key was found,
			// detect the real auth method from the registry and provider status.
			if (providerStatus[providerId]) {
				// CLI providers (e.g. Copilot via gh CLI) are configured without a key/profile
				const registryProvider = getRegistryProvider(providerId);
				if (registryProvider?.requiresCLI) {
					return { hasKey: true, isOAuth: false, authMethod: "cli" };
				}
				// Anthropic/OpenAI: active without an API key → user is authenticated via OAuth
				if (registryProvider?.requiresOAuth) {
					return {
						hasKey: true,
						isOAuth: true,
						authMethod: "oauth",
					};
				}
			}

			return { hasKey: false, authMethod };
		},
		[profiles, settings, providerStatus],
	);

	// Charger les providers de manière asynchrone
	// eslint-disable-next-line react-hooks/exhaustive-deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	useEffect(() => {
		loadProviders();
	}, []);

	// Extracted functions to reduce nesting
	const enrichSettingsWithOAuth = async (baseSettings: AppSettings & Record<string, unknown>) => {
		const enrichedSettings = { ...baseSettings };

		// Enrich with Claude OAuth status
		try {
			if (globalThis.electronAPI?.checkClaudeOAuth) {
				const oauthResult = await globalThis.electronAPI.checkClaudeOAuth();
				if (oauthResult.isAuthenticated) {
					enrichedSettings.globalClaudeOAuthToken =
						oauthResult.profileName || "oauth-authenticated";
				}
			}
		} catch {
			// IPC not available
		}

		// Enrich with OpenAI Codex CLI OAuth status
		try {
			if (globalThis.electronAPI?.checkOpenAICodexOAuth) {
				const oauthResult =
					await globalThis.electronAPI.checkOpenAICodexOAuth();
				if (oauthResult.isAuthenticated) {
					enrichedSettings.globalOpenAICodexOAuthToken =
						oauthResult.profileName || "codex-authenticated";
				}
			}
		} catch {
			// IPC not available
		}

		return enrichedSettings;
	};

	const loadProviders = async () => {
		try {
			const enrichedSettings = await enrichSettingsWithOAuth(settings as AppSettings & Record<string, unknown>);
			const result = await getStaticProviders(profiles, enrichedSettings);
			setStaticProviders(result.providers);
			setProviderStatus(result.status);
		} catch (error) {
			console.error("Failed to load providers:", error);
		}
	};

	// Transformer les providers statiques en providers pour la grille avec mémorisation
	const providers = useMemo(() => {
		return staticProviders.map((provider) => {
			// Get real usage data from Claude OAuth profiles
			let profileUsage: ProfileUsageSummary | undefined;
			if (provider.name === "anthropic" || provider.name === "claude") {
				// requestAllProfilesUsage only returns Claude/Anthropic profiles — use the active one
				profileUsage =
					Array.from(profileUsageData.values()).find((p) => p.isActive) ??
					Array.from(profileUsageData.values())[0];
			} else {
				profileUsage = Array.from(profileUsageData.values()).find(
					(profile) =>
						profile.profileName
							?.toLowerCase()
							.includes(provider.name.toLowerCase()) ||
						profile.profileId.includes(provider.name),
				);
			}

			// Get usage data from CredentialManager (Windsurf, etc.) as fallback
			const credUsage = credentialUsageData.get(provider.name);
			const usageData: ProfileUsageSummary | undefined =
				profileUsage ??
				(credUsage
					? {
							profileId: credUsage.profileId || provider.name,
							profileName: credUsage.profileName || provider.label,
							sessionPercent: credUsage.usage.sessionPercent ?? 0,
							weeklyPercent: credUsage.usage.weeklyPercent ?? 0,
							isAuthenticated: true,
							isRateLimited: false,
							availabilityScore: 100,
							isActive: true,
							needsReauthentication: credUsage.usage.needsReauthentication,
						}
					: undefined);

			// Get test result for this provider
			const testResult = providerTestResults.get(provider.name);

			// Get API key info for this provider
			const apiKeyInfo = getApiKeyInfo(provider.name);
			// The toggle persists into `settings.disabledAutoSwitchProviders`
			// (see handleToggle). Reading from the same source keeps the
			// switch in sync after re-renders for every provider — including
			// OAuth ones like Copilot / Claude that have no apiKeyField.
			const disabledProviders =
				(settings as AppSettings & Record<string, unknown>)
					.disabledAutoSwitchProviders as string[] | undefined;
			const isEnabled = !(disabledProviders?.includes(provider.name) ?? false);

			const mappedProvider = {
				id: provider.name,
				name: provider.label,
				category: providerCategories[provider.name] || "independent",
				description:
					t(`sections.accounts.providers.${provider.name}`) ||
					provider.description,
				isConfigured: providerStatus[provider.name] || false,
				isWorking: providerStatus[provider.name] && isEnabled,
				// Use real data instead of dummy data
				lastTested: testResult?.date,
				usageCount: usageData?.sessionPercent
					? Math.round(usageData.sessionPercent)
					: undefined,
				isPremium: ["anthropic", "claude", "openai", "gemini"].includes(
					provider.name,
				),
				// Add real data fields
				realUsageData: usageData,
				realApiKeyInfo: apiKeyInfo,
			};

			return mappedProvider;
		});
	}, [
		staticProviders,
		providerStatus,
		profileUsageData,
		credentialUsageData,
		providerTestResults,
		t,
		getApiKeyInfo,
		settings,
	]);

	// Synchronize providersState with providers (avoid infinite loop)
	useEffect(() => {
		setProvidersState(providers);
	}, [providers]);

	// Auto-test configured providers that have never been tested (runs after providers load)
	useEffect(() => {
		if (isOpen && providers.length > 0) {
			autoTestConfiguredProviders(providers);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [isOpen, providers.length, autoTestConfiguredProviders, providers]);

	const handleProviderActivated = async (providerId: string) => {
		// 1. Update ProviderContext so UI components (UsageIndicator, etc.) reflect the new provider
		setContextProvider(providerId);
		// 2. Persist to localStorage so ProviderSelector restores it on next mount
		localStorage.setItem("selectedProvider", providerId);
		// 3. Notify backend so SELECTED_LLM_PROVIDER is set for agent processes
		try {
			if (globalThis.electronAPI?.selectProvider) {
				await globalThis.electronAPI.selectProvider(providerId);
			}
		} catch (err) {
			console.error(
				"[CleanProviderSection] Failed to select provider on backend:",
				err,
			);
		}
		// 4. Dispatch event so other components (e.g. UsageIndicator) react immediately
		globalThis.dispatchEvent(
			new CustomEvent("providerChanged", {
				detail: { provider: providerId, timestamp: Date.now() },
			}),
		);
	};

	const handleConfigure = (providerId: string) => {
		const provider = providers.find((p) => p.id === providerId);
		if (provider) {
			setSelectedProvider(provider);
			setConfigDialogOpen(true);
		}
	};

	const handleTest = async (providerId: string) => {
		setTestingProviders((prev) => new Set(prev).add(providerId));

		try {
			const result = await testProvider(providerId);
			await processTestResult(providerId, result);
		} catch (err) {
			handleTestError(providerId, err);
		} finally {
			setTestingProviders((prev) => {
				const newSet = new Set(prev);
				newSet.delete(providerId);
				return newSet;
			});
		}
	};

	// Extracted helper functions to reduce nesting
	const testProvider = async (providerId: string) => {
		const currentProfiles = getCurrentProfiles();
		ProviderService.setProfiles(currentProfiles);
		return await ProviderService.testProvider(providerId);
	};

	const processTestResult = async (providerId: string, result: { success?: boolean }) => {
		const testResult = {
			date: new Date().toISOString(),
			success: result.success ?? false,
		};

		// Update provider test results
		setProviderTestResults((prev) => new Map(prev).set(providerId, testResult));

		// Save to settings for persistence
		onSettingsChange({
			...settings,
			[`testResult_${providerId}`]: testResult,
		});

		if (result.success) {
			await handleTestSuccess(providerId, result);
		} else {
			handleTestFailure(providerId, result);
		}
	};

	const handleTestSuccess = async (providerId: string, result: { success?: boolean; details?: { modelCount?: number; model?: string; error?: string } }) => {
		setProviderStatus((prev) => ({
			...prev,
			[providerId]: true,
		}));

		let description = t(
			"sections.accounts.providerCard.testSuccessDescription",
			{
				providerName: providerId,
			},
		);

		if (result.details) {
			if (result.details.modelCount) {
				description += ` (${t("sections.accounts.providerCard.testDetails.modelsAvailable", { count: result.details.modelCount })})`;
			} else if (result.details.model) {
				description += ` (${t("sections.accounts.providerCard.testDetails.modelUsed", { model: result.details.model })})`;
			}
		}

		toast({
			title: t("sections.accounts.providerCard.testSuccess"),
			description,
		});
	};

	const handleTestFailure = (providerId: string, result: { success?: boolean; error?: string; message?: string; details?: { error?: string } }) => {
		toast({
			variant: "destructive",
			title: t("sections.accounts.providerCard.testError"),
			description: t("sections.accounts.providerCard.testErrorDescription", {
				providerName: providerId,
				error: result.message,
			}),
		});

		console.error("Test failed:", providerId, result.message);
	};

	const handleTestError = (providerId: string, err: unknown) => {
		console.error("Test error:", err);

		toast({
			variant: "destructive",
			title: t("sections.accounts.providerCard.testError"),
			description: t("sections.accounts.providerCard.testErrorDescription", {
				providerName: providerId,
				error: t("sections.accounts.providerCard.errors.unknownError"),
			}),
		});
	};

	// Récupérer les profiles actuels pour le test
	const getCurrentProfiles = () => {
		const { profiles } = useSettingsStore.getState();
		return profiles;
	};

	const handleToggle = async (providerId: string, enabled: boolean) => {
		try {
			// Get the current provider configuration
			const currentConfig =
				(await ProviderService.getUserProviderConfig(providerId)) || {};

			// Update the enabled status in the configuration
			const updatedConfig = {
				...currentConfig,
				enabled: enabled,
				lastUpdated: new Date().toISOString(),
			};

			// Save the updated configuration
			await ProviderService.saveUserProviderConfig(providerId, updatedConfig);

			// Update the local providers state to reflect the change
			setProvidersState((prevProviders: Provider[]) =>
				prevProviders.map((provider: Provider) =>
					provider.id === providerId
						? { ...provider, isWorking: !!enabled }
						: provider,
				),
			);

			// Update disabledAutoSwitchProviders setting
			// Note: providerPriorityOrder is now managed solely by ClaudeProfileManager
			const updatedSettings = { ...settings };
			const currentDisabled = updatedSettings.disabledAutoSwitchProviders || [];
			if (enabled) {
				// Enable provider: remove from disabled list
				updatedSettings.disabledAutoSwitchProviders = currentDisabled.filter(
					(id: string) => id !== providerId,
				);
			} else if (!currentDisabled.includes(providerId)) {
				// Disable provider: add to disabled list if not already there
				updatedSettings.disabledAutoSwitchProviders = [
					...currentDisabled,
					providerId,
				];
			}

			// Single atomic settings update
			onSettingsChange(updatedSettings);

			// Show toast notification
			toast({
				title: enabled
					? t("sections.accounts.providerToggle.enabled")
					: t("sections.accounts.providerToggle.disabled"),
				description: t("sections.accounts.providerToggle.description", {
					providerId: providerId,
					action: enabled
						? tCommon("actions.enabled")
						: tCommon("actions.disabled"),
				}),
			});
		} catch (error) {
			console.error("Failed to toggle provider:", error);
			toast({
				variant: "destructive",
				title: t("sections.accounts.providerToggle.error"),
				description: t("sections.accounts.providerToggle.errorDescription", {
					providerId: providerId,
					action: enabled
						? tCommon("actions.enable")
						: tCommon("actions.disable"),
				}),
			});
		}
	};

	const handleRemove = () => {
		// Pour l'instant, on ne fait rien car on utilise les profiles
		// Remove provider
	};

	const handleRefresh = () => {
		globalThis.location.reload();
	};

	if (isLoading) {
		return (
			<SettingsSection
				title={t("accounts.multiConnector.title")}
				description={t("accounts.multiConnector.description")}
			>
				<div className="flex flex-col items-center justify-center py-16 space-y-4">
					<Loader2 className="w-6 h-6 animate-spin text-gray-400" />
					<span className="text-sm text-gray-600">
						{t("accounts.multiConnector.loadingProviders")}
					</span>
				</div>
			</SettingsSection>
		);
	}

	if (error) {
		return (
			<SettingsSection
				title={t("accounts.multiConnector.title")}
				description={t("accounts.multiConnector.description")}
			>
				<div className="space-y-4">
					<Alert className="border-red-200 bg-red-50">
						<AlertCircle className="h-4 w-4 text-red-600" />
						<AlertDescription className="text-red-700">
							{error}
						</AlertDescription>
					</Alert>
					<Button onClick={handleRefresh} variant="outline" size="sm">
						{t("common.retry")}
					</Button>
				</div>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection
			title={t("settings:accounts.multiConnector.title")}
			description={t("settings:accounts.multiConnector.description")}
		>
			<div className="space-y-6">
				{error && (
					<div className="mb-6 p-4 bg-red-50/50 border border-red-100 rounded-lg">
						<div className="flex items-center gap-2">
							<AlertCircle className="w-4 h-4 text-red-500" />
							<span className="text-sm text-red-700">{error}</span>
						</div>
					</div>
				)}

				<div className="flex gap-6">
					{/* Colonne de gauche - Providers (prend toute la largeur si auto-switching fermé) */}
					<div className={autoSwitchingOpen ? "flex-2" : "flex-1"}>
						{/* Alertes simples */}
						{providersState.filter((p) => p.isConfigured).length === 0 && (
							<Alert>
								<Info className="h-4 w-4" />
								<AlertDescription>
									{t("sections.accounts.alerts.noProviders")}
								</AlertDescription>
							</Alert>
						)}

						{providersState.some((p) => p.isWorking === false) && (
							<Alert variant="destructive">
								<AlertCircle className="h-4 w-4" />
								<AlertDescription>
									{t("sections.accounts.alerts.providerErrors", {
										count: providersState.filter((p) => p.isWorking === false)
											.length,
									})}
								</AlertDescription>
							</Alert>
						)}

						{/* Grille de providers */}
						<CleanProviderGrid
							providers={providersState}
							onConfigure={handleConfigure}
							onTest={handleTest}
							onToggle={handleToggle}
							onRemove={handleRemove}
							isLoading={isLoading}
							isAutoSwitchingOpen={autoSwitchingOpen}
							testingProviders={testingProviders}
							settings={settings}
							onSettingsChange={onSettingsChange}
						/>
					</div>

					{/* Auto-switching settings - tiroir compact */}
					<div
						className={`${autoSwitchingOpen ? "flex-1" : "w-auto"} transition-all duration-300 sticky top-0 self-start`}
					>
						{autoSwitchingOpen ? (
							/* Contenu de l'auto-switching dans un tiroir */
							<div className="border rounded-lg p-4 space-y-4">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<Activity className="w-4 h-4" />
										<h3 className="font-medium text-sm">
											{t("sections.accounts.autoSwitching.title")}
										</h3>
									</div>
									<Button
										onClick={() => setAutoSwitchingOpen(false)}
										variant="ghost"
										size="sm"
										className="h-6 w-6 p-0"
									>
										<X className="w-4 h-4" />
									</Button>
								</div>

								<div className="space-y-4">
									<GlobalAutoSwitching
										isOpen={true}
										settings={settings}
										onSettingsChange={(newSettings: AppSettings) => onSettingsChange(newSettings as AppSettings & Record<string, unknown>)}
										providerStatus={providerStatus}
									/>
								</div>
							</div>
						) : (
							/* Bouton compact pour ouvrir */
							<Button
								onClick={() => setAutoSwitchingOpen(true)}
								variant="outline"
								size="sm"
								className="h-8 px-3"
							>
								<Activity className="w-4 h-4 mr-2" />
								{t("sections.accounts.autoSwitching.title")}
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Dialog de configuration - centré */}
			<Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
				<DialogContent className="max-w-[650px]">
					<ProviderConfigDialog
						isOpen={configDialogOpen}
						onOpenChange={setConfigDialogOpen}
						provider={selectedProvider}
						settings={settings}
						onSettingsChange={onSettingsChange}
						onTest={handleTest}
						useSheet={true}
						onProviderActivated={handleProviderActivated}
					/>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}
