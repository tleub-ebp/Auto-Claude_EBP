/**
 * Credential Manager - Service centralisé de gestion des credentials
 *
 * Gère tous les types d'authentification (OAuth, API Key) pour tous les providers
 * Fournit une interface unifiée pour le frontend via IPC
 */

import { EventEmitter } from "node:events";
import type { ProfilesFile } from "../../shared/types/profile";
import { detectProvider } from "../../shared/utils/provider-detection";
import { readSettingsFile, writeSettingsFile } from "../settings-utils";
import { loadProfilesFile, saveProfilesFile } from "../utils/profile-manager";

export interface CredentialConfig {
	provider: string;
	type: "oauth" | "api_key";
	credentials: {
		// OAuth tokens
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: number;

		// API Key
		apiKey?: string;
		baseUrl?: string;

		// Métadonnées
		profileId?: string;
		profileName?: string;
	};
	isActive: boolean;
	lastValidated?: number;
}

export interface UsageData {
	provider: string;
	profileId?: string;
	profileName?: string;
	usage: {
		sessionPercent?: number;
		weeklyPercent?: number;
		sessionUsageValue?: number;
		weeklyUsageValue?: number;
		sessionResetTimestamp?: number;
		weeklyResetTimestamp?: number;
		needsReauthentication?: boolean;
	};
	timestamp: number;
}

/**
 * Credential Manager - Gestion centralisée des credentials et usage
 */
export class CredentialManager extends EventEmitter {
	private profiles: ProfilesFile | null = null;
	private activeCredential: CredentialConfig | null = null;
	private readonly usageData: Map<string, UsageData> = new Map();

	/**
	 * Initialisation du service
	 */
	public async initialize(): Promise<void> {
		try {
			await this.cleanupTestProfiles();
			await this.loadProfiles();
			this.setupEventHandlers();
		} catch (error) {
			console.error("[CredentialManager] Failed to initialize:", error);
		}
	}

	/**
	 * Remove fake/test profiles from profiles.json that were created by ensureTestProfiles.
	 * These profiles have placeholder or test-* API keys that cause real API calls to fail.
	 */
	private async cleanupTestProfiles(): Promise<void> {
		try {
			const profilesFile = await loadProfilesFile();
			const before = profilesFile.profiles.length;
			profilesFile.profiles = profilesFile.profiles.filter((p) => {
				const key = p.apiKey || "";
				const isFake =
					key.includes("placeholder") ||
					key.startsWith("test-") ||
					(key.startsWith("sk-ant-test") && key.length < 20) ||
					key.length < 20;
				if (isFake) {
					// noop
				}
				return !isFake;
			});
			if (profilesFile.profiles.length < before) {
				await saveProfilesFile(profilesFile);
			}
		} catch {
			// Non-critical — skip cleanup
		}
	}

	/**
	 * Charger les profils depuis profiles.json
	 */
	private async loadProfiles(): Promise<void> {
		this.profiles = await loadProfilesFile();

		// Déterminer le credential actif basé sur le profil actif
		if (this.profiles?.activeProfileId) {
			const activeProfile = this.profiles.profiles.find(
				(p) => p.id === this.profiles?.activeProfileId,
			);
			if (activeProfile) {
				this.activeCredential = {
					provider: this.detectProviderFromUrl(activeProfile.baseUrl),
					type: "api_key",
					credentials: {
						apiKey: activeProfile.apiKey,
						baseUrl: activeProfile.baseUrl,
						profileId: activeProfile.id,
						profileName: activeProfile.name,
					},
					isActive: true,
					lastValidated: Date.now(),
				};
				return;
			}
		}

		// No active API profile — check settings.json for a previously selected provider
		// or a saved Windsurf API key (globalWindsurfApiKey).
		// This ensures the provider selection survives app restarts for SSO/enterprise users.
		try {
			const settings = readSettingsFile();
			const savedProvider = settings?.selectedProvider as string | undefined;
			const windsurfKey = (
				settings?.globalWindsurfApiKey as string | undefined
			)?.trim();

			if (
				savedProvider &&
				savedProvider !== "anthropic" &&
				savedProvider !== "claude"
			) {
				this.activeCredential = {
					provider: savedProvider,
					type:
						windsurfKey && savedProvider === "windsurf" ? "api_key" : "oauth",
					credentials:
						windsurfKey && savedProvider === "windsurf"
							? { apiKey: windsurfKey }
							: {},
					isActive: true,
					lastValidated: Date.now(),
				};
			} else if (windsurfKey && !savedProvider) {
				this.activeCredential = {
					provider: "windsurf",
					type: "api_key",
					credentials: { apiKey: windsurfKey },
					isActive: true,
					lastValidated: Date.now(),
				};
			}
		} catch {
			// settings file not available — no restoration needed
		}
	}

	/**
	 * Détecter le provider depuis l'URL de base
	 */
	private detectProviderFromUrl(baseUrl: string): string {
		const detected = detectProvider(baseUrl);
		return detected === "unknown" ? "custom" : detected;
	}

	/**
	 * Configurer les gestionnaires d'événements
	 */
	private setupEventHandlers(): void {
		// Écouter les changements de profils
		this.on("profile:changed", async () => {
			await this.loadProfiles();
			this.emit("credential:updated", this.getActiveCredential());
		});

		// Écouter les mises à jour d'usage
		this.on("usage:updated", (data: UsageData) => {
			this.usageData.set(data.provider, data);
			this.emit("usage:changed", data);
		});
	}

	/**
	 * Obtenir le credential actif
	 */
	getActiveCredential(): CredentialConfig | null {
		return this.activeCredential;
	}

	/**
	 * Définir le provider actif (switch OAuth/API Key)
	 */
	async setActiveProvider(
		provider: string,
		type: "oauth" | "api_key",
		profileId?: string,
	): Promise<void> {
		try {
			if (type === "api_key" && profileId) {
				// Mode API Key - utiliser le profil spécifié
				if (!this.profiles) await this.loadProfiles();

				const profile = this.profiles?.profiles.find((p) => p.id === profileId);
				if (!profile) {
					throw new Error(`Profile ${profileId} not found`);
				}

				// Mettre à jour le profil actif dans profiles.json
				if (this.profiles) {
					this.profiles.activeProfileId = profileId;
					await saveProfilesFile(this.profiles);
				}

				// Mettre à jour le credential actif
				this.activeCredential = {
					provider,
					type: "api_key",
					credentials: {
						apiKey: profile.apiKey,
						baseUrl: profile.baseUrl,
						profileId: profile.id,
						profileName: profile.name,
					},
					isActive: true,
					lastValidated: Date.now(),
				};
			} else if (type === "oauth") {
				// Mode OAuth - désactiver le profil actif
				if (!this.profiles) await this.loadProfiles();

				if (this.profiles) {
					this.profiles.activeProfileId = null;
					await saveProfilesFile(this.profiles);
				}

				this.activeCredential = {
					provider,
					type: "oauth",
					credentials: {
						// Les tokens OAuth seront gérés par le système OAuth existant
					},
					isActive: true,
					lastValidated: Date.now(),
				};
			}

			// Persist selected provider to settings.json so it survives app restarts.
			// This is critical for SSO/enterprise users (e.g., Windsurf) who don't have
			// an API profile in profiles.json — without this, the provider selection is lost.
			try {
				const settings = readSettingsFile() || {};
				settings.selectedProvider = provider;
				writeSettingsFile(settings);
			} catch (e) {
				console.warn(
					"[CredentialManager] Failed to persist selectedProvider to settings.json:",
					e,
				);
			}

			this.emit("credential:updated", this.activeCredential);
			this.emit("provider:switched", { provider, type });
		} catch (error) {
			console.error(
				"[CredentialManager] Failed to set active provider:",
				error,
			);
			throw error;
		}
	}

	/**
	 * Mettre à jour les données d'usage pour un provider
	 */
	updateUsageData(provider: string, usageData: Partial<UsageData>): void {
		const existingData = this.usageData.get(provider);
		const updatedData: UsageData = {
			provider,
			usage: {},
			timestamp: Date.now(),
			...existingData,
			...usageData,
		};

		this.usageData.set(provider, updatedData);
		this.emit("usage:updated", updatedData);
	}

	/**
	 * Obtenir les données d'usage pour un provider
	 */
	getUsageData(provider: string): UsageData | null {
		return this.usageData.get(provider) || null;
	}

	/**
	 * Tester un provider (incluant les cas spéciaux comme Copilot)
	 */
	async testProvider(
		provider: string,
	): Promise<{ success: boolean; message: string; details?: unknown }> {
		try {
			// Cas spécial pour Copilot - utilise GitHub CLI auth
			if (provider === "copilot") {
				const { exec } = require("node:child_process");
				const { promisify } = require("node:util");
				const execAsync = promisify(exec);

				try {
					// Tester si GitHub CLI est installé
					const { stdout: version } = await execAsync("gh --version", {
						timeout: 5000,
					});

					// gh auth status outputs to stderr on Windows, so capture both
					try {
						const { stdout: authStdout, stderr: authStderr } = await execAsync(
							"gh auth status 2>&1",
							{ timeout: 5000 },
						);
						const authOutput = (authStdout || "") + (authStderr || "");
						const isAuthenticated =
							authOutput.includes("Logged in to") ||
							authOutput.includes("Token:");

						if (isAuthenticated) {
							return {
								success: true,
								message: "GitHub Copilot authentication (CLI-based)",
								details: {
									method: "GitHub CLI",
									version: version.trim(),
									status: "Authenticated",
								},
							};
						} else {
							return {
								success: false,
								message: "GitHub CLI not authenticated. Run: gh auth login",
							};
						}
						// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					} catch (authError: any) {
						// gh auth status exits with code 1 when not authenticated — check stderr
						const output =
							(authError?.stdout || "") + (authError?.stderr || "");
						if (output.includes("Logged in to") || output.includes("Token:")) {
							return {
								success: true,
								message: "GitHub Copilot authentication (CLI-based)",
								details: {
									method: "GitHub CLI",
									version: version.trim(),
									status: "Authenticated",
								},
							};
						}
						return {
							success: false,
							message: "GitHub CLI not authenticated. Run: gh auth login",
						};
					}
				} catch (error) {
					console.warn(
						"GitHub CLI check failed:",
						error instanceof Error ? error.message : error,
					);
					return {
						success: false,
						message:
							"GitHub CLI not available. Install GitHub CLI and run: gh auth login",
					};
				}
			}

			// Cas spécial pour Anthropic - utilise OAuth
			if (provider === "anthropic" || provider === "claude") {
				// Vérifier si un profil OAuth est disponible
				const claudeProfilesResult = await this.checkClaudeOAuthStatus();

				if (claudeProfilesResult.isAuthenticated) {
					return {
						success: true,
						message: "Anthropic OAuth authentication active",
						details: {
							method: "OAuth",
							profile: claudeProfilesResult.profileName,
						},
					};
				} else {
					return {
						success: false,
						message:
							"Anthropic not authenticated. Please sign in with Claude Code or OAuth.",
					};
				}
			}

			// Cas spécial pour OpenAI — vérifie OAuth Codex CLI en plus de l'API key
			if (provider === "openai") {
				const codexResult = await this.checkOpenAICodexOAuthStatus();
				if (codexResult.isAuthenticated) {
					return {
						success: true,
						message: "OpenAI Codex CLI authentication active",
						details: {
							method: "OAuth (Codex CLI)",
							profile: codexResult.profileName,
						},
					};
				}
				// Fall through to standard API key check below
			}

			// Cas spécial pour Windsurf — uses SSO token or service key stored in settings or detected locally
			if (provider === "windsurf") {
				return await this.testWindsurfProvider();
			}

			// Cas spécial pour le LLM local (Ollama / LM Studio / llama.cpp / vLLM):
			// aucune clé API requise — on sonde la connectivité du serveur local au
			// lieu d'exiger une clé (sinon "Provider not configured" à tort).
			if (provider === "ollama" || provider === "local" || provider === "lmstudio") {
				let raw = "";
				try {
					const settings = readSettingsFile();
					// biome-ignore lint/suspicious/noExplicitAny: settings shape is loose
					const s = settings as any;
					raw = (s?.globalOllamaApiUrl || s?.globalOllamaBaseUrl || "") as string;
				} catch {
					/* settings unavailable — fall back to default below */
				}
				let root = (raw.trim() || "http://localhost:11434").replace(/\/+$/, "");
				root = root
					.replace(/\/v1\/chat\/completions$/, "")
					.replace(/\/chat\/completions$/, "")
					.replace(/\/v1$/, "");
				// Probe the OpenAI-compatible endpoint first (LM Studio, vLLM,
				// llama.cpp, Ollama >= /v1), then Ollama's native /api/tags.
				for (const apiPath of ["/v1/models", "/api/tags"]) {
					try {
						const resp = await fetch(`${root}${apiPath}`, {
							method: "GET",
							signal: AbortSignal.timeout(5000),
						});
						if (resp.ok) {
							return {
								success: true,
								message: `Serveur LLM local accessible (${root})`,
								details: { baseUrl: root, endpoint: apiPath },
							};
						}
					} catch {
						/* try the next path */
					}
				}
				return {
					success: false,
					message: `Serveur LLM local injoignable à ${root}. Vérifie qu'Ollama/LM Studio tourne et que l'URL est correcte.`,
				};
			}

			// Pour les autres providers (openai, mistral, google, deepseek, grok, ollama, etc.)
			// Source 1: Chercher un profil API dans profiles.json (Custom Endpoints)
			let apiKey: string | undefined;
			let baseUrl: string | undefined;
			let profileName: string | undefined;
			let _source = "";

			try {
				const profilesFile = await loadProfilesFile();
				const apiProfile = profilesFile.profiles.find((p) => {
					return detectProvider(p.baseUrl) === provider;
				});
				if (
					apiProfile?.apiKey &&
					!apiProfile.apiKey.includes("placeholder") &&
					!apiProfile.apiKey.startsWith("test-") &&
					apiProfile.apiKey.length >= 20
				) {
					apiKey = apiProfile.apiKey;
					baseUrl = apiProfile.baseUrl;
					profileName = apiProfile.name;
					_source = `API profile (${profileName || "unnamed"})`;
				}
			} catch {
				// profiles.json not available
			}

			// Source 2: Chercher dans settings.json (clés API globales)
			// Try multiple possible settings keys for each provider
			if (!apiKey) {
				try {
					const settings = readSettingsFile();
					const globalKeyOptions: Record<string, string[]> = {
						openai: ["globalOpenAIApiKey"],
						google: ["globalGoogleDeepMindApiKey", "globalGoogleApiKey"],
						gemini: ["globalGoogleApiKey", "globalGoogleDeepMindApiKey"],
						mistral: ["globalMistralApiKey"],
						deepseek: ["globalDeepSeekApiKey"],
						grok: ["globalGrokApiKey"],
						meta: ["globalMetaApiKey"],
						aws: ["globalAWSApiKey"],
						cursor: ["globalCursorApiKey"],
					};
					const settingsKeys = globalKeyOptions[provider] || [];
					if (settings) {
						for (const settingsKey of settingsKeys) {
							// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
							const globalKey = (settings as any)[settingsKey] as
								| string
								| undefined;
							if (globalKey?.trim()) {
								apiKey = globalKey.trim();
								profileName = provider;
								_source = `global settings (${settingsKey})`;
								break;
							}
						}
					}
				} catch {
					// settings file not available
				}
			}

			// Source 3: Vérifier le activeCredential
			if (
				!apiKey &&
				this.activeCredential?.provider === provider &&
				this.activeCredential.credentials.apiKey
			) {
				apiKey = this.activeCredential.credentials.apiKey;
				baseUrl = this.activeCredential.credentials.baseUrl;
				profileName = this.activeCredential.credentials.profileName;
				_source = "active credential";
			}

			if (!apiKey) {
				return {
					success: false,
					message: `Provider ${provider} not configured. Add an API key in Custom Endpoints or provider settings.`,
				};
			}

			// Debug: log which source provided the key (mask most of the key for security)
			const _maskedKey =
				apiKey.length > 8 ? `${apiKey.substring(0, 8)}...` : "***";

			// Tester la connexion avec le endpoint approprié pour chaque provider
			try {
				const testResult = await this.testApiKeyConnection(
					provider,
					apiKey,
					baseUrl,
				);
				if (testResult.success) {
					return {
						success: true,
						message: `${provider} connection successful`,
						details: {
							method: "API Key",
							profileName: profileName || provider,
							...testResult.details,
						},
					};
				} else {
					return testResult;
				}
			} catch (testError) {
				return {
					success: false,
					message:
						testError instanceof Error
							? testError.message
							: `${provider} connection test failed`,
				};
			}
		} catch (error) {
			console.error(`[CredentialManager] Test failed for ${provider}:`, error);
			return {
				success: false,
				message: error instanceof Error ? error.message : "Test failed",
			};
		}
	}

	/**
	 * Tester le provider Windsurf (SSO token ou service key)
	 * Checks globalWindsurfApiKey in settings, API profiles, and local IDE detection.
	 */
	private async testWindsurfProvider(): Promise<{
		success: boolean;
		message: string;
		details?: unknown;
	}> {
		try {
			let serviceKey: string | undefined;
			let source = "";

			// Source 1: Check API profiles (profiles.json)
			try {
				const profilesFile = await loadProfilesFile();
				const windsurfProfile = profilesFile.profiles.find((p) => {
					return detectProvider(p.baseUrl) === "windsurf";
				});
				if (windsurfProfile?.apiKey) {
					serviceKey = windsurfProfile.apiKey;
					source = "API profile";
				}
			} catch {
				// profiles.json not available
			}

			// Source 2: Fallback to global settings (globalWindsurfApiKey)
			if (!serviceKey) {
				try {
					const settings = readSettingsFile();
					const globalKey = settings?.globalWindsurfApiKey as
						| string
						| undefined;
					if (globalKey?.trim()) {
						serviceKey = globalKey.trim();
						source = "global settings";
					}
				} catch {
					// Settings file not available
				}
			}

			// Source 3: Try auto-detecting from local Windsurf IDE
			if (!serviceKey) {
				try {
					const detected = await detectWindsurfLocalToken();
					if (detected.success && detected.apiKey) {
						serviceKey = detected.apiKey;
						source = "local IDE detection";
					}
				} catch {
					// Detection failed
				}
			}

			if (!serviceKey) {
				return {
					success: false,
					message:
						"No Windsurf token found. Configure via SSO or provide an API key.",
				};
			}

			// Determine auth method based on token format
			const isJWT = serviceKey.startsWith("eyJ");

			// Strategy 1: service_key in body (team/enterprise keys — skip for JWT)
			let resp: Response | null = null;
			if (!isJWT) {
				resp = await fetch(
					"https://server.codeium.com/api/v1/GetTeamCreditBalance",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ service_key: serviceKey }),
						signal: AbortSignal.timeout(10000),
					},
				);
				if (resp.ok) {
					return {
						success: true,
						message: "Windsurf connection successful",
						details: { method: "Service Key", source, authType: "api_key" },
					};
				}
			}

			// Strategy 2: Bearer header (works for personal sk-ws- keys and SSO/JWT tokens)
			// Also retry on 400 (bad request) — GetTeamCreditBalance returns 400 for personal sk-ws- keys
			if (!resp?.ok) {
				resp = await fetch(
					"https://server.codeium.com/api/v1/GetTeamCreditBalance",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${serviceKey}`,
						},
						body: "{}",
						signal: AbortSignal.timeout(10000),
					},
				);
				if (resp.ok) {
					return {
						success: true,
						message: "Windsurf connection successful",
						details: { method: "Bearer", source, authType: "api_key" },
					};
				}
			}

			// Strategy 3: GetUser endpoint (SSO fallback — works for personal tokens)
			try {
				const userResp = await fetch(
					"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetUser",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${serviceKey}`,
						},
						body: "{}",
						signal: AbortSignal.timeout(10000),
					},
				);
				if (userResp.ok) {
					return {
						success: true,
						message: "Windsurf connection successful",
						details: { method: "SSO/OAuth", source, authType: "sso" },
					};
				}
			} catch {
				// GetUser network error — fall through to local IDE detection
			}

			// All remote API attempts failed (any 4xx/5xx).
			// For personal sk-ws- keys, these team/enterprise endpoints may always return 4xx.
			// Trust the local IDE state.vscdb as the source of truth instead.
			if (source !== "local IDE detection") {
				try {
					const detected = await detectWindsurfLocalToken();
					if (detected.success && detected.apiKey) {
						return {
							success: true,
							message: "Windsurf token verified from local IDE",
							details: {
								method: "local IDE",
								source: "local IDE detection",
								authType: "sso",
							},
						};
					}
				} catch (e) {
					console.warn(
						"[CredentialManager] Windsurf local IDE detection failed:",
						e,
					);
				}
			}

			// Token found in local IDE — trust it even if API validation failed
			if (source === "local IDE detection") {
				return {
					success: true,
					message: "Windsurf token verified from local IDE",
					details: { method: "local IDE", source, authType: "sso" },
				};
			}

			return {
				success: false,
				message:
					"Windsurf token not found in local IDE. Please open Windsurf IDE and sign in.",
			};
		} catch (error) {
			console.error("[CredentialManager] Windsurf test failed:", error);
			return {
				success: false,
				message:
					error instanceof Error ? error.message : "Windsurf test failed",
			};
		}
	}

	/**
	 * Tester la connexion API pour un provider donné avec une clé API
	 * Utilise les endpoints spécifiques à chaque provider pour valider la connexion.
	 */
	private async testApiKeyConnection(
		provider: string,
		apiKey: string,
		baseUrl?: string,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	): Promise<{ success: boolean; message: string; details?: any }> {
		try {
			let response: Response;
			const timeout = AbortSignal.timeout(10000);

			switch (provider) {
				case "openai":
					response = await fetch(
						`${baseUrl || "https://api.openai.com"}/v1/models`,
						{
							headers: { Authorization: `Bearer ${apiKey}` },
							signal: timeout,
						},
					);
					break;

				case "google":
				case "gemini":
					response = await fetch(
						`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
						{ signal: timeout },
					);
					break;

				case "mistral":
					response = await fetch(
						`${baseUrl || "https://api.mistral.ai"}/v1/models`,
						{
							headers: { Authorization: `Bearer ${apiKey}` },
							signal: timeout,
						},
					);
					break;

				case "deepseek":
					response = await fetch(
						`${baseUrl || "https://api.deepseek.com"}/v1/models`,
						{
							headers: { Authorization: `Bearer ${apiKey}` },
							signal: timeout,
						},
					);
					break;

				case "grok":
					response = await fetch("https://api.x.ai/v1/models", {
						headers: { Authorization: `Bearer ${apiKey}` },
						signal: timeout,
					});
					break;

				case "ollama":
					response = await fetch(
						`${baseUrl || "http://localhost:11434"}/api/tags`,
						{
							signal: timeout,
						},
					);
					break;

				default:
					// Pour les providers inconnus, vérifier simplement que la clé existe
					if (apiKey && apiKey.trim() !== "") {
						return {
							success: true,
							message: `${provider} API key configured`,
							details: { method: "API Key (not validated)" },
						};
					}
					return {
						success: false,
						message: `${provider} has no API key configured`,
					};
			}

			if (response.ok) {
				const data = await response.json().catch(() => ({}));
				return {
					success: true,
					message: `${provider} connection successful`,
					details: {
						status: response.status,
						modelCount: data.data?.length || data.models?.length || undefined,
					},
				};
			} else {
				return {
					success: false,
					message: `${provider} API returned HTTP ${response.status}: ${response.statusText}`,
				};
			}
		} catch (error) {
			return {
				success: false,
				message:
					error instanceof Error
						? error.message
						: `${provider} connection test failed`,
			};
		}
	}

	/**
	 * Vérifier le statut OAuth Claude
	 * Checks multiple sources:
	 *   0. App's Claude Profile Manager (hasValidAuth) — checks ~/.claude-profiles/{name}
	 *   1. Claude CLI config (Windows: %APPDATA%\claude, Unix: ~/.config/claude)
	 *   2. App's own profiles.json for Anthropic API profiles
	 *   3. Global settings for globalAnthropicApiKey
	 */
	private async checkClaudeOAuthStatus(): Promise<{
		isAuthenticated: boolean;
		profileName?: string;
	}> {
		try {
			// Source 0: Check app's Claude Profile Manager (primary source)
			// This checks ~/.claude-profiles/{profileId}/.credentials.json and Keychain
			try {
				const {
					getClaudeProfileManager,
				} = require("../claude-profile-manager");
				const profileManager = getClaudeProfileManager();
				if (profileManager) {
					const activeProfile = profileManager.getActiveProfile();
					if (activeProfile && profileManager.hasValidAuth(activeProfile.id)) {
						return {
							isAuthenticated: true,
							profileName:
								activeProfile.email || activeProfile.name || "Claude OAuth",
						};
					}
					// Also check all profiles, not just active
					const allProfiles = profileManager.getProfiles?.() || [];
					for (const profile of allProfiles) {
						if (profileManager.hasValidAuth(profile.id)) {
							return {
								isAuthenticated: true,
								profileName: profile.email || profile.name || "Claude OAuth",
							};
						}
					}
				}
			} catch {
				// Profile manager not initialized yet
			}

			const fs = require("node:fs").promises;
			const path = require("node:path");
			const os = require("node:os");

			// Source 1: Check Claude CLI profiles — try multiple paths (Windows + Unix)
			const candidatePaths = [
				// Windows: %APPDATA%\claude\profiles.json
				process.env.APPDATA
					? path.join(process.env.APPDATA, "claude", "profiles.json")
					: null,
				// Unix/macOS: ~/.config/claude/profiles.json
				path.join(os.homedir(), ".config", "claude", "profiles.json"),
				// Also check Claude Code config
				process.env.APPDATA
					? path.join(process.env.APPDATA, "claude-code", "profiles.json")
					: null,
				path.join(os.homedir(), ".config", "claude-code", "profiles.json"),
			].filter(Boolean) as string[];

			for (const configPath of candidatePaths) {
				try {
					const profilesData = await fs.readFile(configPath, "utf-8");
					const profiles = JSON.parse(profilesData);

					if (profiles.profiles && Array.isArray(profiles.profiles)) {
						const oauthProfile = profiles.profiles.find(
							(profile: { isAuthenticated?: boolean }) =>
								profile.isAuthenticated === true,
						);

						if (oauthProfile) {
							return {
								isAuthenticated: true,
								profileName: oauthProfile.name,
							};
						}
					}
				} catch {
					// This path doesn't exist, try next
				}
			}

			// Source 2: Check app's own profiles.json for Anthropic API profile
			try {
				const profilesFile = await loadProfilesFile();
				const anthropicProfile = profilesFile.profiles.find((p) => {
					const detected = detectProvider(p.baseUrl);
					return detected === "anthropic";
				});
				if (
					anthropicProfile?.apiKey &&
					!anthropicProfile.apiKey.includes("placeholder") &&
					!anthropicProfile.apiKey.startsWith("test-") &&
					anthropicProfile.apiKey.length >= 20
				) {
					return {
						isAuthenticated: true,
						profileName: anthropicProfile.name || "Anthropic (API Key)",
					};
				}
			} catch {
				// profiles.json not available
			}

			// Source 3: Check global settings for globalAnthropicApiKey
			try {
				const settings = readSettingsFile();
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const anthropicKey = (settings as any)?.globalAnthropicApiKey as
					| string
					| undefined;
				if (anthropicKey?.trim()) {
					return {
						isAuthenticated: true,
						profileName: "Anthropic (API Key)",
					};
				}
			} catch {
				// settings not available
			}

			return { isAuthenticated: false };
		} catch (error) {
			console.warn(
				"[CredentialManager] Failed to check Claude OAuth status:",
				error,
			);
			return { isAuthenticated: false };
		}
	}

	/**
	 * Public wrapper for checkClaudeOAuthStatus — used by IPC handlers
	 */
	public async checkClaudeOAuthStatusPublic(): Promise<{
		isAuthenticated: boolean;
		profileName?: string;
	}> {
		return this.checkClaudeOAuthStatus();
	}

	private async checkOpenAICodexOAuthStatus(): Promise<{
		isAuthenticated: boolean;
		profileName?: string;
	}> {
		try {
			const fs = require("node:fs").promises;
			const path = require("node:path");
			const os = require("node:os");

			// Source 1: Check Codex CLI config files
			const candidatePaths = [
				// Windows: %APPDATA%\codex\auth.json
				process.env.APPDATA
					? path.join(process.env.APPDATA, "codex", "auth.json")
					: null,
				// Unix/macOS: ~/.config/codex/auth.json
				path.join(os.homedir(), ".config", "codex", "auth.json"),
				// Also check ~/.codex/auth.json (alternative location)
				path.join(os.homedir(), ".codex", "auth.json"),
				// OpenAI CLI config: ~/.openai/auth.json
				process.env.APPDATA
					? path.join(process.env.APPDATA, "openai", "auth.json")
					: null,
				path.join(os.homedir(), ".config", "openai", "auth.json"),
				path.join(os.homedir(), ".openai", "auth.json"),
			].filter(Boolean) as string[];

			for (const configPath of candidatePaths) {
				try {
					const authData = await fs.readFile(configPath, "utf-8");
					const auth = JSON.parse(authData);

					// Codex CLI stores tokens in a nested `tokens` object:
					//   { auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
					const tokens = auth.tokens || {};
					const hasAccessToken = !!(tokens.access_token || auth.access_token);
					const hasRefreshToken = !!(
						tokens.refresh_token || auth.refresh_token
					);
					const hasApiKey = !!(
						auth.OPENAI_API_KEY?.trim() || auth.api_key?.trim()
					);
					const hasAnyAuth = hasAccessToken || hasRefreshToken || hasApiKey;

					if (hasAnyAuth) {
						// Try to extract email from id_token JWT payload
						let profileName = auth.email || auth.user || "OpenAI Codex CLI";
						try {
							const idToken = tokens.id_token || auth.id_token;
							if (idToken) {
								const parts = idToken.split(".");
								if (parts.length >= 2) {
									// Base64url decode the payload
									let payload = parts[1]
										.replaceAll("-", "+")
										.replaceAll("_", "/");
									while (payload.length % 4) payload += "=";
									const decoded = Buffer.from(payload, "base64").toString(
										"utf-8",
									);
									const claims = JSON.parse(decoded);
									if (claims.email) {
										profileName = claims.email;
									}
								}
							}
						} catch {
							// JWT decode failed, use fallback name
						}
						return {
							isAuthenticated: true,
							profileName,
						};
					}
				} catch (error) {
					// This path doesn't exist, try next
					// Silently ignore ENOENT errors - missing config files are expected
					if (
						error instanceof Error &&
						"code" in error &&
						error.code !== "ENOENT"
					) {
						// Non-ENOENT errors are intentionally ignored here
						// as we fall back to other credential sources
					}
				}
			} // Added missing closing brace here

			// Source 2: Check app's own profiles.json for OpenAI API profile
			try {
				const profilesFile = await loadProfilesFile();
				const openaiProfile = profilesFile.profiles.find((p) => {
					const detected = detectProvider(p.baseUrl);
					return detected === "openai";
				});
				if (
					openaiProfile?.apiKey &&
					!openaiProfile.apiKey.includes("placeholder") &&
					!openaiProfile.apiKey.startsWith("test-") &&
					openaiProfile.apiKey.length >= 20
				) {
					return {
						isAuthenticated: true,
						profileName: openaiProfile.name || "OpenAI (API Key)",
					};
				}
			} catch (error) {
				console.warn(
					"[CredentialManager] Failed to check profiles.json:",
					error,
				);
			}

			// Source 3: Check global settings for globalOpenAIApiKey
			try {
				const settings = readSettingsFile();
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const openaiKey = (settings as any)?.globalOpenAIApiKey as
					| string
					| undefined;
				if (openaiKey?.trim()) {
					return {
						isAuthenticated: true,
						profileName: "OpenAI (API Key)",
					};
				}

				// Source 4: Also check for Codex OAuth token in settings
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				const codexOAuthToken = (settings as any)
					?.globalOpenAICodexOAuthToken as string | undefined;
				if (codexOAuthToken?.trim()) {
					return {
						isAuthenticated: true,
						profileName: codexOAuthToken,
					};
				}
			} catch (error) {
				console.warn("[CredentialManager] Failed to check settings:", error);
			}
			return { isAuthenticated: false };
		} catch (error) {
			console.warn(
				"[CredentialManager] Failed to check OpenAI Codex OAuth status:",
				error,
			);
			return { isAuthenticated: false };
		}
	}

	/**
	 * Public wrapper for checkOpenAICodexOAuthStatus — used by IPC handlers
	 */
	public async checkOpenAICodexOAuthStatusPublic(): Promise<{
		isAuthenticated: boolean;
		profileName?: string;
	}> {
		return this.checkOpenAICodexOAuthStatus();
	}

	/**
	 * Fetch usage data for Windsurf/Codeium provider.
	 * Uses POST to GetTeamCreditBalance with service key.
	 * Checks two sources for the service key:
	 *   1. API profiles (profiles.json) — Custom Endpoints
	 *   2. Global settings (settings.json) — Provider Accounts (globalWindsurfApiKey)
	 * Stores the result in the usageData cache and returns it.
	 */
	async fetchWindsurfUsage(): Promise<UsageData | null> {
		try {
			let serviceKey: string | undefined;
			let profileId = "windsurf-global";
			let profileName = "Windsurf (Codeium)";

			// Source 1: Check API profiles (profiles.json)
			const profilesFile = await loadProfilesFile();
			const windsurfProfile = profilesFile.profiles.find((p) => {
				return detectProvider(p.baseUrl) === "windsurf";
			});

			if (windsurfProfile?.apiKey) {
				serviceKey = windsurfProfile.apiKey;
				profileId = windsurfProfile.id;
				profileName = windsurfProfile.name;
			}

			// Source 2: Fallback to global settings (globalWindsurfApiKey)
			if (!serviceKey) {
				try {
					const settings = readSettingsFile();
					const globalKey = settings?.globalWindsurfApiKey as
						| string
						| undefined;
					if (globalKey?.trim()) {
						serviceKey = globalKey.trim();
					}
				} catch {
					// Settings file not available
				}
			}

			// Source 3: Auto-detect from local Windsurf IDE (SSO enterprise users)
			if (!serviceKey) {
				try {
					const detected = await detectWindsurfLocalToken();
					if (detected.success && detected.apiKey) {
						serviceKey = detected.apiKey;
						profileName = detected.userName
							? `Windsurf (${detected.userName})`
							: "Windsurf (SSO)";
						profileId = "windsurf-sso";
					}
				} catch {
					// Detection failed
				}
			}

			if (!serviceKey) {
				return null;
			}

			const isJWT = serviceKey.startsWith("eyJ");

			// Strategy 1: service_key in body (standard for team service keys — skip for JWT)
			let resp: Response | null = null;
			if (!isJWT) {
				resp = await fetch(
					"https://server.codeium.com/api/v1/GetTeamCreditBalance",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ service_key: serviceKey }),
						signal: AbortSignal.timeout(10000),
					},
				);
			}

			// Strategy 2: Bearer header (works for both service keys and SSO/JWT tokens)
			if (!resp || resp.status === 401) {
				resp = await fetch(
					"https://server.codeium.com/api/v1/GetTeamCreditBalance",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${serviceKey}`,
						},
						body: "{}",
						signal: AbortSignal.timeout(10000),
					},
				);
			}

			if (!resp.ok) {
				// Strategy 3: For SSO, try GetTeamInfo
				if (isJWT) {
					try {
						const teamResp = await fetch(
							"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetTeamInfo",
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${serviceKey}`,
								},
								body: "{}",
								signal: AbortSignal.timeout(10000),
							},
						);
						if (teamResp.ok) {
							const teamData = await teamResp.json();
							if (
								teamData &&
								(teamData.promptCreditsPerSeat ||
									teamData.addOnCreditsUsed ||
									teamData.numSeats)
							) {
								// Normalize teamData the same way as credit balance response
								const tPCS = teamData.promptCreditsPerSeat ?? 0;
								const tNS = teamData.numSeats ?? 1;
								const tACA = teamData.addOnCreditsAvailable ?? 0;
								const tACU = teamData.addOnCreditsUsed ?? 0;
								const tSeatTotal = tPCS * tNS;
								const tTotal = tSeatTotal + tACA + tACU;
								const tUsed = tACU;
								let tPct = 0;
								if (tTotal > 0) tPct = Math.round((tUsed / tTotal) * 100);
								const usageResult: UsageData = {
									provider: "windsurf",
									profileId,
									profileName,
									usage: {
										sessionPercent: tPct,
										weeklyPercent: 0,
										needsReauthentication: false,
									},
									timestamp: Date.now(),
								};
								this.usageData.set("windsurf", usageResult);
								this.emit("usage:updated", usageResult);
								return usageResult;
							}
						}
					} catch {
						// GetTeamInfo failed
					}
				}
				console.error(
					"[CredentialManager] Windsurf credits API returned error:",
					resp.status,
					resp.statusText,
				);
				// Return a connected-but-no-usage snapshot to prevent Anthropic fallback
				const fallbackResult: UsageData = {
					provider: "windsurf",
					profileId,
					profileName,
					usage: {
						sessionPercent: 0,
						weeklyPercent: 0,
						needsReauthentication: false,
					},
					timestamp: Date.now(),
				};
				this.usageData.set("windsurf", fallbackResult);
				return fallbackResult;
			}

			const data = await resp.json();

			// Normalize Codeium response to UsageData format
			const promptCreditsPerSeat = data.promptCreditsPerSeat ?? 0;
			const numSeats = data.numSeats ?? 1;
			const addOnCreditsAvailable = data.addOnCreditsAvailable ?? 0;
			const addOnCreditsUsed = data.addOnCreditsUsed ?? 0;

			const seatCreditsTotal = promptCreditsPerSeat * numSeats;
			const totalCredits =
				seatCreditsTotal + addOnCreditsAvailable + addOnCreditsUsed;
			const usedCredits = addOnCreditsUsed;

			let sessionPercent = 0;
			if (totalCredits > 0) {
				sessionPercent = Math.round((usedCredits / totalCredits) * 100);
			}

			// Billing cycle progress
			let weeklyPercent = 0;
			const billingStart = data.billingCycleStart
				? new Date(data.billingCycleStart).getTime()
				: 0;
			const billingEnd = data.billingCycleEnd
				? new Date(data.billingCycleEnd).getTime()
				: 0;
			const now = Date.now();
			if (billingEnd > billingStart && now >= billingStart) {
				const cycleDuration = billingEnd - billingStart;
				const elapsed = Math.min(now - billingStart, cycleDuration);
				weeklyPercent = Math.round((elapsed / cycleDuration) * 100);
			}

			const usageResult: UsageData = {
				provider: "windsurf",
				profileId,
				profileName,
				usage: {
					sessionPercent,
					weeklyPercent,
					sessionResetTimestamp: billingEnd || undefined,
					weeklyResetTimestamp: billingEnd || undefined,
					needsReauthentication: false,
				},
				timestamp: Date.now(),
			};

			// Cache it in the usageData Map
			this.usageData.set("windsurf", usageResult);
			this.emit("usage:updated", usageResult);

			return usageResult;
		} catch (error) {
			console.error("[CredentialManager] Windsurf usage fetch failed:", error);
			return null;
		}
	}

	/**
	 * Obtenir toutes les données d'usage
	 */
	getAllUsageData(): Map<string, UsageData> {
		return new Map(this.usageData);
	}

	/**
	 * Valider les credentials actifs
	 */
	async validateActiveCredentials(): Promise<boolean> {
		if (!this.activeCredential) return false;

		try {
			if (this.activeCredential.type === "api_key") {
				const provider = this.activeCredential.provider;
				// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
				const apiKey = this.activeCredential.credentials.apiKey!;
				const baseUrl = this.activeCredential.credentials.baseUrl || "";
				let response: Response;

				switch (provider) {
					case "anthropic":
					case "claude":
						response = await fetch(
							`${baseUrl || "https://api.anthropic.com"}/v1/models`,
							{
								headers: {
									"x-api-key": apiKey,
									"anthropic-version": "2023-06-01",
								},
							},
						);
						break;

					case "openai":
						response = await fetch(
							`${baseUrl || "https://api.openai.com"}/v1/models`,
							{
								headers: { Authorization: `Bearer ${apiKey}` },
							},
						);
						break;

					case "google":
						response = await fetch(
							`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
						);
						break;

					case "mistral":
						response = await fetch(
							`${baseUrl || "https://api.mistral.ai"}/v1/models`,
							{
								headers: { Authorization: `Bearer ${apiKey}` },
							},
						);
						break;

					case "deepseek":
						response = await fetch(
							`${baseUrl || "https://api.deepseek.com"}/v1/models`,
							{
								headers: { Authorization: `Bearer ${apiKey}` },
							},
						);
						break;

					case "grok":
						response = await fetch("https://api.x.ai/v1/models", {
							headers: { Authorization: `Bearer ${apiKey}` },
						});
						break;

					case "ollama":
						response = await fetch(
							`${baseUrl || "http://localhost:11434"}/api/tags`,
						);
						break;

					default:
						// Pour les providers inconnus, on considère valide si la clé existe
						if (apiKey && apiKey.trim() !== "") {
							this.activeCredential.lastValidated = Date.now();
							return true;
						}
						return false;
				}

				const isValid = response.ok;
				if (isValid) {
					this.activeCredential.lastValidated = Date.now();
				}

				return isValid;
			} else if (this.activeCredential.type === "oauth") {
				return true;
			}
		} catch (error) {
			console.error("[CredentialManager] Credential validation failed:", error);
			return false;
		}

		return false;
	}

	/**
	 * Obtenir les variables d'environnement pour le processus Python
	 */
	getEnvironmentVariables(): Record<string, string> {
		const env: Record<string, string> = {};

		// Priority check: if the user explicitly selected a non-Claude provider in settings,
		// always inject SELECTED_LLM_PROVIDER — even when a Claude API profile is active in
		// profiles.json. Without this, loadProfiles() sets activeCredential to the Claude
		// profile (type: 'api_key') and returns early, so the Copilot/Windsurf selection in
		// settings.json is never reflected in the subprocess environment.
		try {
			const settings = readSettingsFile();
			const selectedProvider = (
				settings?.selectedProvider as string | undefined
			)?.toLowerCase();
			const nonClaudeProviders = [
				"copilot",
				"openai",
				"google",
				"ollama",
				"meta",
				"mistral",
				"deepseek",
				"grok",
				"aws",
				"custom",
			];
			if (selectedProvider && nonClaudeProviders.includes(selectedProvider)) {
				// The active credential from profiles.json may be a Claude profile —
				// still force SELECTED_LLM_PROVIDER so the backend routes to the right client.
				env.SELECTED_LLM_PROVIDER = selectedProvider;

				// For Copilot: auth is via `gh auth token` CLI — no extra env vars needed.
				if (selectedProvider === "copilot") {
					return Object.fromEntries(
						Object.entries(env).filter(([_, value]) => value.trim() !== ""),
					);
				}

				// For other API-key providers: inject the global API key from settings.json.
				// The activeCredential may be type:'oauth' (set by PROVIDER_SELECT handler)
				// which bypasses the switch statement below — so we must inject the key here.
				// Source priority: profiles.json → globalXxxApiKey in settings.json
				const globalKeyMap: Record<string, string[]> = {
					openai: ["globalOpenAIApiKey"],
					google: ["globalGoogleDeepMindApiKey", "globalGoogleApiKey"],
					gemini: ["globalGoogleApiKey", "globalGoogleDeepMindApiKey"],
					mistral: ["globalMistralApiKey"],
					deepseek: ["globalDeepSeekApiKey"],
					grok: ["globalGrokApiKey"],
					meta: ["globalMetaApiKey"],
					aws: ["globalAWSApiKey"],
				};
				const envVarMap: Record<string, string> = {
					openai: "OPENAI_API_KEY",
					google: "GOOGLE_API_KEY",
					gemini: "GOOGLE_API_KEY",
					mistral: "MISTRAL_API_KEY",
					deepseek: "DEEPSEEK_API_KEY",
					grok: "GROK_API_KEY",
					meta: "META_API_KEY",
					aws: "AWS_ACCESS_KEY_ID",
				};
				const baseUrlMap: Record<string, string> = {
					openai: "OPENAI_BASE_URL",
					mistral: "MISTRAL_BASE_URL",
					deepseek: "DEEPSEEK_BASE_URL",
					meta: "META_BASE_URL",
					aws: "AWS_BEDROCK_ENDPOINT",
				};

				// Check profiles.json first (most specific), then global settings
				let apiKey = "";
				let baseUrl = "";
				try {
					const profiles = this.profiles;
					const profile = profiles?.profiles.find((p) => {
						try {
							return (
								(p as unknown as Record<string, unknown>).provider ===
									selectedProvider ||
								p.baseUrl?.toLowerCase().includes(selectedProvider)
							);
						} catch {
							return false;
						}
					});
					if (profile?.apiKey) {
						apiKey = profile.apiKey;
						baseUrl = profile?.baseUrl ?? "";
					}
				} catch {
					/* profiles.json not available */
				}

				if (!apiKey) {
					for (const key of globalKeyMap[selectedProvider] ?? []) {
						// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
						const val = (settings as any)?.[key] as string | undefined;
						if (val?.trim()) {
							apiKey = val.trim();
							break;
						}
					}
				}

				// Note: Codex CLI OAuth tokens are NOT used as fallback — they require
				// specific OpenAI scopes that the ChatGPT OAuth flow does not grant.
				// Users must provide a real API key (sk-...) from platform.openai.com.

				const envVar = envVarMap[selectedProvider];
				if (envVar && apiKey) env[envVar] = apiKey;
				const baseUrlVar = baseUrlMap[selectedProvider];
				if (baseUrlVar && baseUrl) env[baseUrlVar] = baseUrl;

				// Ollama / local LLM: inject base URL if configured.
				// The provider form, detection and service all persist this under
				// `globalOllamaApiUrl` — read that first (the legacy
				// `globalOllamaBaseUrl` key was never written anywhere). Without this
				// the configured URL never reached the backend, so LM Studio (1234)
				// and custom Ollama ports silently fell back to the default.
				if (selectedProvider === "ollama") {
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					const s = settings as any;
					const ollamaUrl = (s?.globalOllamaApiUrl ?? s?.globalOllamaBaseUrl) as
						| string
						| undefined;
					if (ollamaUrl?.trim()) env.OLLAMA_BASE_URL = ollamaUrl.trim();
				}

				return Object.fromEntries(
					Object.entries(env).filter(([_, value]) => value.trim() !== ""),
				);
			}
		} catch {
			// settings file not available
		}

		// For Windsurf SSO enterprise users: even without an api_key credential,
		// we must inject SELECTED_LLM_PROVIDER so the backend uses WindsurfAgentClient
		// instead of silently falling back to Claude SDK.
		// The backend's windsurf_proxy/auth.py will auto-detect the SSO token from
		// the local Windsurf IDE's state.vscdb database.
		if (this.activeCredential?.provider === "windsurf") {
			env.SELECTED_LLM_PROVIDER = "windsurf";

			if (this.activeCredential.type === "api_key") {
				const apiKey = this.activeCredential.credentials.apiKey || "";
				const baseUrl = this.activeCredential.credentials.baseUrl || "";
				if (apiKey) env.WINDSURF_API_KEY = apiKey;
				if (baseUrl) env.WINDSURF_BASE_URL = baseUrl;
			}
			// For SSO/OAuth type: no WINDSURF_API_KEY needed — backend discovers it
			// from the running Windsurf IDE via state.vscdb

			// Filtrer les valeurs vides
			return Object.fromEntries(
				Object.entries(env).filter(([_, value]) => value.trim() !== ""),
			);
		}

		// OAuth providers (Copilot, Windsurf SSO without key, custom OAuth, etc.)
		// When the active credential is OAuth type with an explicit non-Claude provider,
		// signal the provider to the backend via SELECTED_LLM_PROVIDER.
		// This ensures providers like Copilot (which use external CLI auth like `gh`)
		// are correctly routed instead of silently falling back to Claude.
		if (this.activeCredential?.type !== "api_key") {
			const oauthProvider = this.activeCredential?.provider;
			if (
				oauthProvider &&
				oauthProvider !== "claude" &&
				oauthProvider !== "anthropic"
			) {
				// Non-Claude OAuth provider: signal provider name so backend routes correctly.
				// Auth is handled externally (e.g., `gh auth` for Copilot, SSO for Windsurf).
				env.SELECTED_LLM_PROVIDER = oauthProvider;
				return Object.fromEntries(
					Object.entries(env).filter(([_, value]) => value.trim() !== ""),
				);
			}

			// No explicit non-Claude provider — check for globalWindsurfApiKey fallback.
			// This handles SSO/enterprise Windsurf users who configured a key in settings
			// but have no explicit activeCredential (e.g., legacy configuration).
			try {
				const settings = readSettingsFile();
				const windsurfKey = settings?.globalWindsurfApiKey as
					| string
					| undefined;
				const explicitProvider = settings?.selectedProvider as
					| string
					| undefined;
				// Do NOT inject windsurf if the user explicitly chose Claude Code or Anthropic.
				// The globalWindsurfApiKey may exist from a previous configuration but should
				// not override the user's current provider choice.
				const userChoseClaudeExplicitly =
					explicitProvider === "claude" || explicitProvider === "anthropic";
				if (windsurfKey?.trim() && !userChoseClaudeExplicitly) {
					env.SELECTED_LLM_PROVIDER = "windsurf";
					env.WINDSURF_API_KEY = windsurfKey.trim();
					return Object.fromEntries(
						Object.entries(env).filter(([_, value]) => value.trim() !== ""),
					);
				}
			} catch {
				// settings file not available
			}
			return {};
		}

		const provider = this.activeCredential.provider;
		const apiKey = this.activeCredential.credentials.apiKey || "";
		const baseUrl = this.activeCredential.credentials.baseUrl || "";

		switch (provider) {
			case "anthropic":
			case "claude":
				env.ANTHROPIC_API_KEY = apiKey;
				env.ANTHROPIC_AUTH_TOKEN = apiKey;
				if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
				break;

			case "openai":
				env.OPENAI_API_KEY = apiKey;
				if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
				break;

			case "google":
				env.GOOGLE_API_KEY = apiKey;
				break;

			case "mistral":
				env.MISTRAL_API_KEY = apiKey;
				if (baseUrl) env.MISTRAL_BASE_URL = baseUrl;
				break;

			case "deepseek":
				env.DEEPSEEK_API_KEY = apiKey;
				if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
				break;

			case "grok":
				env.GROK_API_KEY = apiKey;
				break;

			case "meta":
				env.META_API_KEY = apiKey;
				if (baseUrl) env.META_BASE_URL = baseUrl;
				break;

			case "aws":
				env.AWS_ACCESS_KEY_ID = apiKey;
				if (baseUrl) env.AWS_BEDROCK_ENDPOINT = baseUrl;
				break;

			case "ollama":
				if (baseUrl) env.OLLAMA_BASE_URL = baseUrl;
				break;

			case "windsurf":
				env.WINDSURF_API_KEY = apiKey;
				if (baseUrl) env.WINDSURF_BASE_URL = baseUrl;
				break;

			case "cursor":
				env.CURSOR_API_KEY = apiKey;
				if (baseUrl) env.CURSOR_BASE_URL = baseUrl;
				break;

			default:
				env.LLM_API_KEY = apiKey;
				if (baseUrl) env.LLM_BASE_URL = baseUrl;
				break;
		}

		// Toujours exporter le provider sélectionné pour que le backend sache lequel utiliser
		env.SELECTED_LLM_PROVIDER = provider;

		// Filtrer les valeurs vides
		return Object.fromEntries(
			Object.entries(env).filter(([_, value]) => value.trim() !== ""),
		);
	}

	/**
	 * Nettoyage des ressources
	 */
	cleanup(): void {
		this.removeAllListeners();
		this.usageData.clear();
		this.profiles = null;
		this.activeCredential = null;
	}
}

// Instance singleton
export const credentialManager = new CredentialManager();

/**
 * Helper function to read a key from Windsurf's ItemTable database.
 * Returns the value as a string or null if not found/error.
 */
function readWindsurfKey(
	db: import("better-sqlite3").Database,
	key: string,
): string | null {
	try {
		const row = db
			.prepare("SELECT value FROM ItemTable WHERE key = ?")
			.get(key) as { value: string | Buffer } | undefined;
		if (!row) return null;
		const val = row.value;
		if (Buffer.isBuffer(val)) return val.toString("utf-8");
		return typeof val === "string" ? val : null;
	} catch {
		return null;
	}
}

/**
 * Detect Windsurf API key from local IDE installation.
 * Uses better-sqlite3 (pure Node.js) to read the state.vscdb SQLite database
 * stored by Windsurf IDE — no Python dependency required.
 *
 * Supports both standard accounts and SSO enterprise accounts by searching
 * multiple keys in the database:
 *   1. windsurfAuthStatus → { apiKey: "sk-ws-..." }
 *   2. codeium.windsurf-windsurf_auth → user name / email
 *   3. windsurf.authToken / codeium.apiKey → SSO enterprise fallback keys
 *
 * Supported paths:
 * - Windows: %APPDATA%/Windsurf/User/globalStorage/state.vscdb
 * - macOS: ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 * - Linux: ~/.config/Windsurf/User/globalStorage/state.vscdb
 */
export async function detectWindsurfLocalToken(): Promise<{
	success: boolean;
	apiKey?: string;
	userName?: string;
	error?: string;
}> {
	try {
		const path = await import("node:path");
		const fs = await import("node:fs");
		const { isWindows, isMacOS } = await import("../platform/index");

		// Determine the state.vscdb path based on platform
		let dbPath: string;
		if (isWindows()) {
			dbPath = path.join(
				process.env.APPDATA || "",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		} else if (isMacOS()) {
			dbPath = path.join(
				process.env.HOME || "",
				"Library",
				"Application Support",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		} else {
			// Linux
			dbPath = path.join(
				process.env.HOME || "",
				".config",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		}

		if (!fs.existsSync(dbPath)) {
			return {
				success: false,
				error: "Windsurf IDE not found. Install Windsurf and sign in first.",
			};
		}

		// Use better-sqlite3 — pure Node.js, no Python dependency
		let Database: typeof import("better-sqlite3");
		try {
			Database = require("better-sqlite3");
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			return {
				success: false,
				error: `better-sqlite3 module not available: ${e.message}`,
			};
		}

		let db: import("better-sqlite3").Database;
		try {
			db = new Database(dbPath, { readonly: true, fileMustExist: true });
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			return {
				success: false,
				error: `Could not open Windsurf database: ${e.message}`,
			};
		}

		try {
			let apiKey: string | undefined;
			let userName: string | undefined;

			// Strategy 1: Standard auth — windsurfAuthStatus JSON blob with apiKey field
			const authStatusRaw = readWindsurfKey(db, "windsurfAuthStatus");
			if (authStatusRaw) {
				try {
					const authData = JSON.parse(authStatusRaw);
					if (authData.apiKey) {
						apiKey = authData.apiKey;
					}
					// SSO enterprise: the token may be stored as accessToken or token instead of apiKey
					if (!apiKey && authData.accessToken) {
						apiKey = authData.accessToken;
					}
					if (!apiKey && authData.token) {
						apiKey = authData.token;
					}
					// Extract user info from authStatus if available
					if (authData.userName) userName = authData.userName;
					if (authData.email)
						userName = userName
							? `${userName} (${authData.email})`
							: authData.email;
					if (authData.name) userName = userName || authData.name;
				} catch {
					// Not valid JSON — treat as raw token string
					if (
						authStatusRaw.startsWith("sk-") ||
						authStatusRaw.startsWith("eyJ")
					) {
						apiKey = authStatusRaw;
					}
				}
			}

			// Strategy 2: SSO enterprise fallback keys
			if (!apiKey) {
				// Try windsurf.authToken (used by some SSO enterprise setups)
				const authToken = readWindsurfKey(db, "windsurf.authToken");
				if (authToken) {
					try {
						const parsed = JSON.parse(authToken);
						apiKey =
							parsed.apiKey || parsed.accessToken || parsed.token || parsed.key;
					} catch {
						if (
							authToken.startsWith("sk-") ||
							authToken.startsWith("eyJ") ||
							authToken.length > 40
						) {
							apiKey = authToken;
						}
					}
				}
			}

			if (!apiKey) {
				// Try codeium.apiKey (direct key storage)
				const codeiumKey = readWindsurfKey(db, "codeium.apiKey");
				if (codeiumKey && codeiumKey.length > 10) {
					apiKey = codeiumKey;
				}
			}

			if (!apiKey) {
				// Try service-auth/windsurf key pattern (SSO token exchange result)
				const serviceAuth = readWindsurfKey(db, "service-auth/windsurf");
				if (serviceAuth) {
					try {
						const parsed = JSON.parse(serviceAuth);
						apiKey = parsed.apiKey || parsed.accessToken || parsed.token;
					} catch {
						if (serviceAuth.length > 40) apiKey = serviceAuth;
					}
				}
			}

			// Resolve user name from a separate key if not already found
			if (!userName) {
				const authUserRaw = readWindsurfKey(
					db,
					"codeium.windsurf-windsurf_auth",
				);
				if (authUserRaw) {
					try {
						const parsed = JSON.parse(authUserRaw);
						userName =
							parsed.name || parsed.userName || parsed.email || authUserRaw;
					} catch {
						userName = authUserRaw;
					}
				}
			}

			db.close();

			if (apiKey) {
				return { success: true, apiKey, userName: userName || undefined };
			}

			// If we found nothing, list available keys for debugging (SSO troubleshooting)
			let debugInfo = "";
			try {
				const reopenedDb = new Database(dbPath, {
					readonly: true,
					fileMustExist: true,
				});
				const rows = reopenedDb
					.prepare(
						"SELECT key FROM ItemTable WHERE key LIKE '%windsurf%' OR key LIKE '%codeium%' OR key LIKE '%auth%' ORDER BY key",
					)
					.all() as { key: string }[];
				reopenedDb.close();

				if (rows.length > 0) {
					debugInfo = ` Found ${rows.length} related keys: ${rows.map((r) => r.key).join(", ")}`;
				}
			} catch {
				/* ignore debug errors */
			}

			return {
				success: false,
				error: `No API key found in Windsurf auth data. Sign in to Windsurf IDE first.${debugInfo}`,
			};

			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (queryError: any) {
			try {
				db.close();
			} catch {
				/* ignore */
			}
			return {
				success: false,
				error: `Error querying Windsurf database: ${queryError.message}`,
			};
		}

		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	} catch (error: any) {
		return {
			success: false,
			error: error.message || "Unknown error detecting Windsurf token",
		};
	}
}

/**
 * Read cached plan info from the local Windsurf IDE database.
 *
 * The Windsurf IDE caches plan/usage data in its SQLite database (state.vscdb)
 * under the key `windsurf.settings.cachedPlanInfo`. This gives us usage data
 * without needing an API call (which requires Enterprise service keys).
 *
 * Returns the cached plan info if available, or null if Windsurf IDE is not
 * installed or the cache is not available.
 */
export interface WindsurfCachedPlanInfo {
	planName: string;
	startTimestamp: number;
	endTimestamp: number;
	/** True if the cached data is from a previous billing cycle (stale) */
	isStale?: boolean;
	usage: {
		duration: number;
		messages: number;
		flowActions: number;
		flexCredits: number;
		usedMessages: number;
		usedFlowActions: number;
		usedFlexCredits: number;
		remainingMessages: number;
		remainingFlowActions: number;
		remainingFlexCredits: number;
	};
	hasBillingWritePermissions: boolean;
	gracePeriodStatus: number;
}

/**
 * Decode a varint from a Buffer at the given position.
 * Returns [value, newPosition].
 */
function decodeVarint(buf: Buffer, pos: number): [number, number] {
	let result = 0;
	let shift = 0;
	while (pos < buf.length) {
		const b = buf[pos];
		result |= (b & 0x7f) << shift;
		pos++;
		if (!(b & 0x80)) break;
		shift += 7;
	}
	return [result, pos];
}

/**
 * Extract the current billing cycle timestamps from the userStatusProtoBinaryBase64
 * field in windsurfAuthStatus. The protobuf structure is:
 *   - root field 13 (plan info sub-message):
 *     - sub-field 2 (billing start): nested varint at field 1 — plan activation date, used for monthly cycle calculation
 *     - sub-field 3 (billing end): nested varint at field 1
 *     - sub-field 6: used messages (current cycle)
 *     - sub-field 7: used flow actions (current cycle)
 *     - sub-field 8: total messages
 *     - sub-field 9: total flow actions
 *     - sub-field 17: weekly usage window start (plain varint, epoch seconds) — used for stale detection only
 *     - sub-field 18: weekly usage window end (plain varint, epoch seconds)
 */
function extractBillingCycleFromProtobuf(protoB64: string): {
	startSeconds: number;
	endSeconds: number;
	totalMessages: number;
	totalFlowActions: number;
	usedMessages: number;
	usedFlowActions: number;
	weeklyWindowStartSeconds: number; // Field 17 - used for stale detection only
} | null {
	try {
		const data = Buffer.from(protoB64, "base64");
		let pos = 0;

		// Find field 13 in root message
		while (pos < data.length) {
			const [tag, newPos] = decodeVarint(data, pos);
			const fieldNum = tag >> 3;
			const wireType = tag & 0x7;
			pos = newPos;

			if (wireType === 0) {
				// varint — skip
				const [, p] = decodeVarint(data, pos);
				pos = p;
			} else if (wireType === 2) {
				// length-delimited
				const [length, p] = decodeVarint(data, pos);
				pos = p;
				if (fieldNum === 13) {
					// Parse the plan sub-message
					const sub = data.subarray(pos, pos + length);
					let sp = 0;
					let startSeconds = 0;
					let endSeconds = 0;
					let totalMessages = 0;
					let totalFlowActions = 0;
					let usedMessages = 0;
					let usedFlowActions = 0;
					// Fields 17/18 are plain varint timestamps. Field 17 is the current billing cycle start.
					// Field 18 is a weekly usage window end, NOT the billing cycle end.
					// We prefer field 17 over field 2 for startSeconds, but keep field 3 for endSeconds.
					let cycleStartSeconds = 0;

					while (sp < sub.length) {
						const [stag, sp2] = decodeVarint(sub, sp);
						const sfn = stag >> 3;
						const swt = stag & 0x7;
						sp = sp2;

						if (swt === 0) {
							const [sv, sp3] = decodeVarint(sub, sp);
							sp = sp3;
							if (sfn === 6) usedMessages = sv;
							if (sfn === 7) usedFlowActions = sv;
							if (sfn === 8) totalMessages = sv;
							if (sfn === 9) totalFlowActions = sv;
							if (sfn === 17) cycleStartSeconds = sv;
						} else if (swt === 2) {
							const [sl, sp3] = decodeVarint(sub, sp);
							sp = sp3;
							const sv = sub.subarray(sp, sp + sl);
							sp += sl;

							// Sub-fields 2 and 3 contain nested messages with a varint at field 1
							if ((sfn === 2 || sfn === 3) && sl > 0) {
								try {
									const [innerTag, ip2] = decodeVarint(sv, 0);
									const innerFn = innerTag >> 3;
									const innerWt = innerTag & 0x7;
									if (innerFn === 1 && innerWt === 0) {
										const [ts] = decodeVarint(sv, ip2);
										if (sfn === 2) startSeconds = ts;
										if (sfn === 3) endSeconds = ts;
									}
								} catch {
									/* skip malformed */
								}
							}
						} else if (swt === 5) {
							sp += 4;
						} else if (swt === 1) {
							sp += 8;
						} else {
							break;
						}
					}

					// Prefer field 17 (current billing cycle start) over field 2 (plan activation).
					// Field 2 can be a plan activation date that doesn't advance with each billing
					// period, causing stale detection to fail. Keep field 3 for endSeconds.
					if (cycleStartSeconds > 0 && cycleStartSeconds >= startSeconds) {
						startSeconds = cycleStartSeconds;
					}

					if (startSeconds > 0 && endSeconds > 0) {
						return {
							startSeconds,
							endSeconds,
							totalMessages,
							totalFlowActions,
							usedMessages,
							usedFlowActions,
							weeklyWindowStartSeconds: cycleStartSeconds,
						};
					}
					return null;
				}
				pos += length;
			} else if (wireType === 5) {
				pos += 4;
			} else if (wireType === 1) {
				pos += 8;
			} else {
				break;
			}
		}
		return null;
	} catch {
		return null;
	}
}

export async function readWindsurfCachedPlanInfo(): Promise<{
	success: boolean;
	planInfo?: WindsurfCachedPlanInfo;
	userName?: string;
	error?: string;
}> {
	try {
		const path = await import("node:path");
		const fs = await import("node:fs");
		const { isWindows, isMacOS } = await import("../platform/index");

		// Determine the state.vscdb path based on platform
		let dbPath: string;
		if (isWindows()) {
			dbPath = path.join(
				process.env.APPDATA || "",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		} else if (isMacOS()) {
			dbPath = path.join(
				process.env.HOME || "",
				"Library",
				"Application Support",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		} else {
			dbPath = path.join(
				process.env.HOME || "",
				".config",
				"Windsurf",
				"User",
				"globalStorage",
				"state.vscdb",
			);
		}

		if (!fs.existsSync(dbPath)) {
			return { success: false, error: "Windsurf IDE not installed" };
		}

		let Database: typeof import("better-sqlite3");
		try {
			Database = require("better-sqlite3");
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			return {
				success: false,
				error: `better-sqlite3 not available: ${e.message}`,
			};
		}

		let db: import("better-sqlite3").Database;
		try {
			db = new Database(dbPath, { readonly: true, fileMustExist: true });
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			return {
				success: false,
				error: `Could not open Windsurf database: ${e.message}`,
			};
		}

		try {
			// Read cached plan info
			const planInfoRaw = readWindsurfKey(
				db,
				"windsurf.settings.cachedPlanInfo",
			);
			if (!planInfoRaw) {
				db.close();
				return { success: false, error: "No cached plan info in Windsurf IDE" };
			}

			const planInfo = JSON.parse(planInfoRaw) as WindsurfCachedPlanInfo;

			// DO NOT use protobuf for usage counters - they contain incorrect data
			// The cache local (windsurf.settings.cachedPlanInfo) contains the correct usage data
			// that is updated by Windsurf IDE on each usage.
			// Only use protobuf for billing cycle timestamps if needed for stale detection.
			// DO NOT reset usage counters to 0 - this would erase correct usage data.
			// The cache local should only be used for metadata, not for usage counters.
			const authStatusRaw = readWindsurfKey(db, "windsurfAuthStatus");
			if (authStatusRaw) {
				try {
					const authData = JSON.parse(authStatusRaw);
					if (authData.userStatusProtoBinaryBase64) {
						const billing = extractBillingCycleFromProtobuf(
							authData.userStatusProtoBinaryBase64,
						);
						if (billing) {
							const protoStartMs = billing.startSeconds * 1000;
							// Use field 17 (weekly window start) for stale detection - it advances more frequently
							// than the monthly billing cycle, making it a reliable indicator of cycle boundaries
							const weeklyWindowStartMs = billing.weeklyWindowStartSeconds > 0
								? billing.weeklyWindowStartSeconds * 1000
								: protoStartMs;

							// The cachedPlanInfo is stale if its endTimestamp <= the weekly window start
							// (meaning it's from the previous billing cycle)
							if (planInfo.endTimestamp <= weeklyWindowStartMs) {
								// Calculate the new monthly billing cycle duration from the previous cycle
								const previousCycleDuration = planInfo.endTimestamp - planInfo.startTimestamp;
								// The new monthly cycle starts when the previous one ended (Apr 11), not the weekly window (Apr 14)
								planInfo.startTimestamp = planInfo.endTimestamp;
								// Use the calculated monthly duration, not the protobuf's weekly window
								planInfo.endTimestamp = planInfo.endTimestamp + previousCycleDuration;
								planInfo.isStale = true;

								// Update totals from protobuf if available
								if (billing.totalMessages > 0) {
									planInfo.usage.messages = billing.totalMessages;
								}
								if (billing.totalFlowActions > 0) {
									planInfo.usage.flowActions = billing.totalFlowActions;
								}

								// DO NOT reset usage counters to 0 - this would erase correct usage data
								// The cache local usage counters should be preserved as they contain the actual usage
								// Only reset if the cache local itself is completely missing or corrupted
							}
						}
					}
				} catch {
					// Failed to parse protobuf — use cached data as-is
				}
			}

			// Source 3: Read codeium.windsurf → windsurf.state.cachedUserStatus (may be fresher)
			// This is a separate protobuf snapshot stored inside a large JSON blob.
			// It can sometimes have more recent usage data than windsurfAuthStatus.
			try {
				const codeiumWindsurfRaw = readWindsurfKey(db, "codeium.windsurf");
				if (codeiumWindsurfRaw) {
					const codeiumBlob = JSON.parse(codeiumWindsurfRaw);
					const cachedUserStatusB64 =
						codeiumBlob?.["windsurf.state.cachedUserStatus"];
					if (cachedUserStatusB64 && typeof cachedUserStatusB64 === "string") {
						const billing3 =
							extractBillingCycleFromProtobuf(cachedUserStatusB64);
						if (billing3) {
							// Only use if it's from the same or newer billing cycle
							const proto3StartMs = billing3.startSeconds * 1000;
							if (proto3StartMs >= planInfo.startTimestamp) {
								// Take the max of all sources for usage counters
								if (billing3.usedMessages > planInfo.usage.usedMessages) {
									planInfo.usage.usedMessages = billing3.usedMessages;
									planInfo.usage.remainingMessages = Math.max(
										0,
										planInfo.usage.messages - billing3.usedMessages,
									);
								}
								if (billing3.usedFlowActions > planInfo.usage.usedFlowActions) {
									planInfo.usage.usedFlowActions = billing3.usedFlowActions;
									planInfo.usage.remainingFlowActions = Math.max(
										0,
										planInfo.usage.flowActions - billing3.usedFlowActions,
									);
								}
							}
						}
					}
				}
			} catch {
				// Failed to parse codeium.windsurf blob — continue with existing data
			}

			// Read user name from auth data
			let userName: string | undefined;
			const authUserRaw = readWindsurfKey(db, "codeium.windsurf-windsurf_auth");
			if (authUserRaw) {
				try {
					const parsed = JSON.parse(authUserRaw);
					userName = parsed.name || parsed.userName || parsed.email;
				} catch {
					// If it's not JSON, it's likely the user name string directly
					if (authUserRaw.length > 0 && authUserRaw.length < 200) {
						userName = authUserRaw;
					}
				}
			}

			db.close();
			return { success: true, planInfo, userName };

			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			try {
				db.close();
			} catch {
				/* ignore */
			}
			return {
				success: false,
				error: `Error reading Windsurf plan info: ${e.message}`,
			};
		}
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	} catch (error: any) {
		return {
			success: false,
			error: error.message || "Unknown error reading Windsurf plan info",
		};
	}
}