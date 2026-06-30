import { AlertCircle, CheckCircle, Globe, Key, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { VisuallyHidden } from "../ui/visually-hidden";
import { ApiKeyConfigContent } from "./ApiKeyConfigContent";
import { DialogFooterActions } from "./DialogFooterActions";
import { GitHubCopilotConfig } from "./GitHubCopilotConfig";
import { OAuthAuthContent } from "./OAuthAuthContent";
import { getProviderFields, type ProviderConfig } from "./providerConfig";
import { useProviderAuth } from "./useProviderAuth";

interface ProviderConfigDialogProps {
	readonly isOpen: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly provider: {
		readonly id: string;
		readonly name: string;
		readonly description?: string;
		readonly isConfigured: boolean;
	} | null;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly settings: any;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly onSettingsChange: (settings: any) => void;
	readonly onTest?: (providerId: string) => Promise<void>;
	readonly useSheet?: boolean;
	readonly onProviderActivated?: (providerId: string) => void;
}

type ActiveTab = "api" | "oauth" | "github-copilot";

export function ProviderConfigDialog({
	isOpen,
	onOpenChange,
	provider,
	settings,
	onSettingsChange,
	onTest,
	useSheet = false,
	onProviderActivated,
}: ProviderConfigDialogProps) {
	const { t } = useTranslation("settings");
	const { toast } = useToast();

	// Confirmation visible après sauvegarde — sans ce retour, le dialogue se
	// ferme en silence et l'utilisateur a l'impression que "rien ne se passe".
	const notifySaved = useCallback(
		(providerName: string, model?: string) => {
			toast({
				title: t("sections.accounts.providerConfig.savedTitle", {
					defaultValue: "Fournisseur enregistré",
				}),
				description:
					model && model.trim()
						? `${providerName} enregistré (modèle : ${model.trim()}) et défini comme fournisseur actif.`
						: `${providerName} enregistré et défini comme fournisseur actif.`,
			});
		},
		[toast, t],
	);

	// Mémoriser providerFields pour éviter les recréations infinies
	const providerFields: Record<string, ProviderConfig> = useMemo(
		() => getProviderFields(t),
		[t],
	);
	const [formData, setFormData] = useState<Record<string, string>>({});
	const [isTesting, setIsTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		success: boolean;
		message: string;
	} | null>(null);
	const [_isTestPending, setIsTestPending] = useState(false);
	const [activeTab, setActiveTab] = useState<ActiveTab>("api");
	const [showApiKey, setShowApiKey] = useState(false);

	const {
		isAuthenticating,
		authTerminal,
		windsurfSsoToken,
		windsurfAccountInfo,
		handleOAuthAuth,
		handleAuthTerminalClose,
		handleAuthTerminalSuccess,
		handleAuthTerminalError,
		handleWindsurfDetect,
		handleWindsurfSave,
		loadWindsurfAccountInfo,
		setWindsurfAccountInfo,
	} = useProviderAuth();

	// Auto-check Codex CLI authentication status when terminal is active
	// Polls the actual ~/.codex/auth.json file via IPC instead of matching terminal output
	useEffect(() => {
		if (
			provider?.id === "openai" &&
			activeTab === "oauth" &&
			authTerminal?.terminalId?.startsWith("auth-codex-") &&
			isAuthenticating
		) {
			let checkCount = 0;
			const maxChecks = 120; // Maximum 120 checks (2 minutes — user needs time to complete OAuth in browser)

			const checkInterval = setInterval(async () => {
				checkCount++;

				// Only log every 10th attempt to reduce noise
				if (checkCount % 10 === 1) {
					// noop
				}

				try {
					const result =
						await globalThis.electronAPI?.checkOpenAICodexOAuth?.();

					if (result?.isAuthenticated) {
						clearInterval(checkInterval);

						const profileLabel = result.profileName || "Codex CLI";
						setTestResult({
							success: true,
							message: `Authentification Codex CLI active (${profileLabel})`,
						});
						setIsTestPending(false);

						// Auto-save: persist the OAuth token to settings so provider shows as configured
						const newSettings = { ...settings };
						newSettings.globalOpenAICodexOAuthToken = profileLabel;
						onSettingsChange(newSettings);
						onProviderActivated?.(provider.id);

						// Close the terminal after a brief success display
						setTimeout(() => {
							handleAuthTerminalClose();
						}, 1500);
					} else if (checkCount >= maxChecks) {
						clearInterval(checkInterval);
						console.warn(
							"[ProviderConfigDialog] Codex OAuth check timeout after maximum attempts",
						);
						setTestResult({
							success: false,
							message:
								"Authentification Codex CLI timeout. Veuillez réessayer.",
						});
						setIsTestPending(false);
						handleAuthTerminalClose();
					}
				} catch (error) {
					console.error(
						"[ProviderConfigDialog] Error checking Codex OAuth status:",
						error,
					);
					if (checkCount >= maxChecks) {
						clearInterval(checkInterval);
						setTestResult({
							success: false,
							message:
								"Erreur lors de la vérification de l'authentification Codex CLI.",
						});
						setIsTestPending(false);
						handleAuthTerminalClose();
					}
				}
			}, 1000); // Check every second

			return () => clearInterval(checkInterval);
		}
	}, [
		provider?.id,
		activeTab,
		authTerminal?.terminalId,
		isAuthenticating,
		settings,
		onSettingsChange,
		onProviderActivated,
		handleAuthTerminalClose,
	]);

	const providerConfig = provider ? providerFields[provider.id] : null;
	const supportsOAuth = ["anthropic", "claude", "windsurf", "openai"].includes(
		provider?.id || "",
	);
	const supportsGitHubCopilot = provider?.id === "copilot";

	const getOAuthTabLabel = (): string => {
		if (provider?.id === "windsurf") return "SSO";
		if (provider?.id === "openai") return "OAuth / Codex";
		return "OAuth";
	};

	const getOAuthDescription = (): string => {
		if (provider?.id === "windsurf") {
			return t("sections.accounts.providerConfig.windsurfAuth.description");
		}
		if (provider?.id === "openai") {
			return t("sections.accounts.providerConfig.openaiAuth.codexCliAuth");
		}
		return t("sections.accounts.providerConfig.windsurfAuth.claudeCodeAuth");
	};

	const getDefaultActiveTab = useCallback(
		(providerId: string, hasOAuthSupport: boolean): ActiveTab => {
			if (providerId === "copilot") return "github-copilot";
			if (providerId === "windsurf") return "api"; // Windsurf defaults to API key tab, SSO is secondary
			if (providerId === "openai") return "api"; // OpenAI defaults to API key tab, Codex CLI is secondary
			if (hasOAuthSupport) return "oauth";
			return "api";
		},
		[],
	);

	const initializeFormData = useCallback(
		(
			config: ProviderConfig,
			currentSettings: Record<string, unknown>,
		): Record<string, string> => {
			const initialData: Record<string, string> = {};

			if (config.apiKey && currentSettings[config.apiKey]) {
				initialData.apiKey = currentSettings[config.apiKey] as string;
			}
			if (config.apiUrl && currentSettings[config.apiUrl]) {
				initialData.apiUrl = currentSettings[config.apiUrl] as string;
			}
			if (config.model && currentSettings[config.model]) {
				initialData.model = currentSettings[config.model] as string;
			}

			return initialData;
		},
		[],
	);

	useEffect(() => {
		if (!provider || !providerConfig || !isOpen) return;

		const initialData = initializeFormData(providerConfig, settings);
		setFormData(initialData);
		setTestResult(null);
		setWindsurfAccountInfo(null);
		setActiveTab(getDefaultActiveTab(provider.id, supportsOAuth));

		// Auto-load Windsurf account info when dialog opens
		if (provider.id === "windsurf") {
			loadWindsurfAccountInfo();
		}
	}, [
		provider,
		providerConfig,
		settings,
		isOpen,
		supportsOAuth,
		getDefaultActiveTab,
		initializeFormData,
		loadWindsurfAccountInfo,
		setWindsurfAccountInfo,
	]);

	const handleSave = async () => {
		if (!provider || !providerConfig) return;

		const newSettings = { ...settings };

		// For Anthropic/Claude on OAuth tab: persist OAuth state instead of API keys
		if (
			(provider.id === "anthropic" || provider.id === "claude") &&
			activeTab === "oauth"
		) {
			// Always persist OAuth token if auth succeeded (testResult) or if already set in settings
			if (testResult?.success) {
				newSettings.globalClaudeOAuthToken =
					testResult.message || "oauth-authenticated";
			} else if (!newSettings.globalClaudeOAuthToken) {
				// Check IPC as fallback — the auth terminal may have written credentials to disk
				// but the settings object doesn't reflect it yet
				try {
					const result = await globalThis.electronAPI?.checkClaudeOAuth?.();
					if (result?.isAuthenticated) {
						newSettings.globalClaudeOAuthToken =
							result.profileName || "oauth-authenticated";
					}
				} catch {
					// IPC not available
				}
			}
			onSettingsChange(newSettings);
			onProviderActivated?.(provider.id);
			onOpenChange(false);
			return;
		}

		// For OpenAI on OAuth tab: persist Codex CLI OAuth state instead of API keys
		if (provider.id === "openai" && activeTab === "oauth") {
			if (testResult?.success) {
				newSettings.globalOpenAICodexOAuthToken =
					testResult.message || "codex-authenticated";
			} else if (!newSettings.globalOpenAICodexOAuthToken) {
				try {
					const result =
						await globalThis.electronAPI?.checkOpenAICodexOAuth?.();
					if (result?.isAuthenticated) {
						newSettings.globalOpenAICodexOAuthToken =
							result.profileName || "codex-authenticated";
					}
				} catch {
					// IPC not available
				}
			}
			onSettingsChange(newSettings);
			onProviderActivated?.(provider.id);
			onOpenChange(false);
			return;
		}

		// For GitHub Copilot on github-copilot tab: auth is managed by GitHubCopilotConfig
		// but we must still notify the backend so SELECTED_LLM_PROVIDER is injected for
		// agent subprocesses. Without this, settings.json.selectedProvider stays null and
		// the provider silently falls back to Claude.
		if (provider.id === "copilot" && activeTab === "github-copilot") {
			onSettingsChange(newSettings);
			onProviderActivated?.(provider.id);
			onOpenChange(false);
			return;
		}

		if (providerConfig.apiKey) {
			newSettings[providerConfig.apiKey] = formData.apiKey || "";
			newSettings[`${providerConfig.apiKey}Enabled`] = !!formData.apiKey;
		}
		if (providerConfig.apiUrl) {
			newSettings[providerConfig.apiUrl] = formData.apiUrl || "";
		}
		if (providerConfig.model) {
			newSettings[providerConfig.model] = formData.model || "";
		}

		onSettingsChange(newSettings);
		onProviderActivated?.(provider.id);
		notifySaved(provider.name, formData.model);
		onOpenChange(false);
	};

	const handleTest = async () => {
		if (!provider) return;

		setIsTesting(true);
		setTestResult(null);

		try {
			// On OAuth tab for Anthropic/Claude: check OAuth status directly via IPC
			if (
				activeTab === "oauth" &&
				(provider.id === "anthropic" || provider.id === "claude")
			) {
				const result = await globalThis.electronAPI?.checkClaudeOAuth?.();
				if (result?.isAuthenticated) {
					setTestResult({
						success: true,
						message: result.profileName
							? `Authentification OAuth active (${result.profileName})`
							: "Authentification OAuth active",
					});
				} else {
					setTestResult({
						success: false,
						message:
							"Aucune authentification OAuth détectée. Veuillez vous connecter d'abord.",
					});
				}
				return;
			}

			// On OAuth tab for OpenAI: check Codex CLI OAuth status via IPC
			if (activeTab === "oauth" && provider.id === "openai") {
				try {
					const result =
						await globalThis.electronAPI?.checkOpenAICodexOAuth?.();

					if (result?.isAuthenticated) {
						setTestResult({
							success: true,
							message: result.profileName
								? `Authentification Codex CLI active (${result.profileName})`
								: "Authentification Codex CLI active",
						});
					} else {
						// Check if there's an active Codex authentication terminal
						const hasActiveCodexTerminal =
							authTerminal?.terminalId?.startsWith("auth-codex-");
						const isAuthenticatingCodex =
							hasActiveCodexTerminal && isAuthenticating;

						if (isAuthenticatingCodex) {
							setTestResult({
								success: false,
								message:
									"Authentification Codex CLI en cours... Veuillez patienter.",
							});
							setIsTestPending(true);
						} else {
							setTestResult({
								success: false,
								message:
									"Aucune authentification Codex CLI détectée. Veuillez vous connecter d'abord.",
							});
						}
					}
				} catch (error) {
					console.error(
						"[ProviderConfigDialog] Error checking Codex OAuth:",
						error,
					);
					setTestResult({
						success: false,
						message:
							"Erreur lors de la vérification de l'authentification Codex CLI.",
					});
				}
				return;
			}

			// Standard test via parent handler
			if (!onTest) return;
			await onTest(provider.id);
			setTestResult({
				success: true,
				message: t("sections.accounts.providerCard.testSuccess"),
			});
		} catch (error) {
			setTestResult({
				success: false,
				message:
					error instanceof Error
						? error.message
						: t("sections.accounts.providerCard.testErrorDescription", {
								error: "Échec de la connexion. Vérifiez vos paramètres.",
							}),
			});
		} finally {
			setIsTesting(false);
		}
	};

	const handleDelete = () => {
		if (!provider || !providerConfig) return;

		if (
			confirm(
				t("sections.accounts.providerCard.deleteConfirm", {
					providerName: provider.name,
				}),
			)
		) {
			const newSettings = { ...settings };

			if (providerConfig.apiKey) {
				newSettings[providerConfig.apiKey] = "";
				newSettings[`${providerConfig.apiKey}Enabled`] = false;
			}
			if (providerConfig.apiUrl) {
				newSettings[providerConfig.apiUrl] = "";
			}
			if (providerConfig.model) {
				newSettings[providerConfig.model] = "";
			}

			// Also clear OAuth token for Anthropic/Claude
			if (provider.id === "anthropic" || provider.id === "claude") {
				newSettings.globalClaudeOAuthToken = "";
			}

			// Also clear OAuth token for OpenAI Codex CLI
			if (provider.id === "openai") {
				newSettings.globalOpenAICodexOAuthToken = "";
			}

			onSettingsChange(newSettings);
			onOpenChange(false);
		}
	};

	if (!provider || !providerConfig) return null;

	const content = (
		<>
			<DialogHeader>
				<div className="flex items-center gap-3">
					<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
						{providerConfig.icon}
					</div>
					<div>
						<DialogTitle className="text-lg">{provider.name}</DialogTitle>
						<DialogDescription className="text-sm">
							{providerConfig.description}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			{supportsOAuth || supportsGitHubCopilot ? (
				<Tabs
					value={activeTab}
					onValueChange={(value) =>
						setActiveTab(value as "api" | "oauth" | "github-copilot")
					}
				>
					<TabsList className="w-full justify-start">
						<TabsTrigger value="api" className="flex items-center gap-2">
							<Key className="w-4 h-4" />
							{t("sections.accounts.form.apiKey")}
						</TabsTrigger>
						{supportsOAuth && (
							<TabsTrigger value="oauth" className="flex items-center gap-2">
								<Users className="w-4 h-4" />
								{getOAuthTabLabel()}
							</TabsTrigger>
						)}
						{supportsGitHubCopilot && (
							<TabsTrigger
								value="github-copilot"
								className="flex items-center gap-2"
							>
								<Globe className="w-4 h-4" />
								OAuth GitHub Copilot
							</TabsTrigger>
						)}
					</TabsList>

					<TabsContent value="api" className="space-y-6 py-4">
						<ApiKeyConfigContent
							providerConfig={providerConfig}
							providerId={provider.id}
							formData={formData}
							showApiKey={showApiKey}
							testResult={testResult}
							t={t}
							onFormDataChange={setFormData}
							onToggleShowApiKey={() => setShowApiKey(!showApiKey)}
						/>
					</TabsContent>

					<TabsContent value="oauth" className="space-y-6 py-4">
						<div className="space-y-4">
							<div className="rounded-lg bg-muted/30 border border-border p-4">
								<p className="text-sm text-muted-foreground mb-4">
									{getOAuthDescription()}
								</p>

								<OAuthAuthContent
									providerId={provider.id}
									providerName={provider.name}
									isAuthenticating={isAuthenticating}
									authTerminal={authTerminal}
									windsurfAccountInfo={windsurfAccountInfo}
									windsurfSsoToken={windsurfSsoToken}
									testResult={testResult}
									t={t}
									onOAuthAuth={() =>
										handleOAuthAuth(provider.id, provider.name)
									}
									onAuthTerminalClose={handleAuthTerminalClose}
									onAuthTerminalSuccess={(email) =>
										handleAuthTerminalSuccess(
											email,
											onSettingsChange,
											settings,
											provider.id,
										)
									}
									onAuthTerminalError={handleAuthTerminalError}
									onWindsurfDetect={async () => {
										const result = await handleWindsurfDetect();
										setTestResult(result);
									}}
									onWindsurfSave={() =>
										handleWindsurfSave(
											windsurfSsoToken,
											providerConfig,
											onSettingsChange,
											settings,
											onProviderActivated,
											provider.id,
											onOpenChange,
										)
									}
								/>

								{testResult && (
									<div className="mt-4">
										<div
											className={cn(
												"p-3 rounded-lg border",
												testResult.success
													? "border-green-200 bg-green-50 text-green-800"
													: "border-red-200 bg-red-50 text-red-800",
											)}
										>
											<div className="flex items-center gap-2">
												{testResult.success ? (
													<CheckCircle className="h-4 w-4" />
												) : (
													<AlertCircle className="h-4 w-4" />
												)}
												<span className="text-sm">{testResult.message}</span>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
					</TabsContent>

					{supportsGitHubCopilot && (
						<TabsContent value="github-copilot" className="py-4">
							<GitHubCopilotConfig />
						</TabsContent>
					)}
				</Tabs>
			) : (
				<ApiKeyConfigContent
					providerConfig={providerConfig}
					providerId={provider.id}
					formData={formData}
					showApiKey={showApiKey}
					testResult={testResult}
					t={t}
					onFormDataChange={setFormData}
					onToggleShowApiKey={() => setShowApiKey(!showApiKey)}
				/>
			)}

		</>
	);

	const footer = (
		<DialogFooter className="flex shrink-0 gap-2 border-t border-border/40 pt-3">
			<DialogFooterActions
				provider={provider}
				activeTab={activeTab}
				isTesting={isTesting}
				formData={formData}
				onTest={handleTest}
				onSave={handleSave}
				onDelete={handleDelete}
				onOpenChange={onOpenChange}
			/>
		</DialogFooter>
	);

	// Si on est dans un Sheet, retourner juste le contenu sans le Dialog.
	// The parent DialogContent is a bounded flex column (h-full, min-h-0,
	// overflow-hidden), so make the body the only scrollable region and keep the
	// footer as a flex sibling below it — Tester / Enregistrer then stay visible
	// at the bottom no matter how long the model list is.
	if (useSheet) {
		return (
			<div className="flex max-h-[93vh] flex-col">
				<div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
					{content}
				</div>
				{footer}
			</div>
		);
	}

	// Sinon, retourner le Dialog complet
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[860px]">
				{/* Hidden titles for accessibility */}
				<VisuallyHidden>
					<DialogTitle>{provider?.name}</DialogTitle>
					<DialogDescription>{providerConfig?.description}</DialogDescription>
				</VisuallyHidden>
				{content}
				{footer}
			</DialogContent>
		</Dialog>
	);
}
