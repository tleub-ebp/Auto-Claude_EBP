/**
 * Usage Monitor - Proactive usage monitoring and account switching
 *
 * Monitors Claude account usage at configured intervals and automatically
 * switches to alternative accounts before hitting rate limits.
 *
 * Uses hybrid approach:
 * 1. Primary: Direct OAuth API (https://api.anthropic.com/api/oauth/usage)
 * 2. Fallback: CLI /usage command parsing
 */

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import type {
	AllProfilesUsage,
	ProfileUsageSummary,
	UsageSnapshot,
} from "@shared/types";
import type { APIProfile } from "@shared/types/profile";
import { frontendDebugLog } from "../../shared/utils/debug-logger";
import {
	type ApiProvider,
	getProviderLabel,
	detectProvider as sharedDetectProvider,
} from "../../shared/utils/provider-detection";
import {
	getClaudeProfileManager,
	initializeClaudeProfileManager,
} from "../claude-profile-manager";
import { loadProfilesFile } from "../services/profile";
import {
	clearKeychainCache,
	getCredentialsFromKeychain,
} from "./credential-utils";
import { getOperationRegistry } from "./operation-registry";
import { calculateProfileScore } from "./profile-scorer";
import { getProfileSelectionLock } from "./profile-selection-lock";
import { isProfileRateLimited } from "./rate-limit-manager";
import { ensureValidToken, reactiveTokenRefresh } from "./token-refresh";
import { parseUsageOutput } from "./usage-parser";
import { getVelocityTracker } from "./velocity-tracker";

/**
 * Translate usage window label keys to human-readable values for debug logging.
 * Since the main process doesn't have access to i18next, we use a simple mapping.
 *
 * @param labelKey - The translation key (e.g., "common:usage.windowWeeklyQuota")
 * @returns Human-readable label or the original key if not found
 */
function translateUsageLabel(labelKey: string | undefined): string {
	if (!labelKey) return "Unknown";
	const translations: Record<string, string> = {
		"common:usage.window5Hour": "5-hour window",
		"common:usage.window7Day": "7-day window",
		"common:usage.window5HoursQuota": "5 Hours Quota",
		"common:usage.windowMonthlyToolsQuota": "Monthly Tools Quota",
		"common:usage.windowCredits": "Credits used",
		"common:usage.windowBillingCycle": "Billing cycle",
		"common:usage.windowDailyQuota": "Daily quota",
		"common:usage.windowWeeklyQuota": "Weekly quota",
		"common:usage.windowMonthlyQuota": "Monthly quota",
		"common:usage.windowMonthlyProgress": "Monthly progress",
		"common:usage.sessionDefault": "Session",
		"common:usage.weeklyDefault": "Weekly",
	};
	return translations[labelKey] || labelKey;
}

/**
 * Create a safe fingerprint of a credential for debug logging.
 * Shows first 8 and last 4 characters, hiding the sensitive middle portion.
 * This is NOT for authentication - only for human-readable debug identification.
 *
 * @param credential - The credential (token or API key) to create a fingerprint for
 * @returns A safe fingerprint like "sk-ant-oa...xyz9" or "null" if no credential
 */
function getCredentialFingerprint(
	credential: string | null | undefined,
): string {
	if (!credential) return "null";
	if (credential.length <= 16)
		return `${credential.slice(0, 4)}...${credential.slice(-2)}`;
	return `${credential.slice(0, 8)}...${credential.slice(-4)}`;
}

/**
 * Allowed domains for usage API requests.
 * Only these domains are permitted for outbound usage monitoring requests.
 */
const ALLOWED_USAGE_API_DOMAINS: ReadonlySet<string> = new Set([
	"api.anthropic.com",
	"api.openai.com",
	"server.codeium.com", // Windsurf/Codeium usage API
	"localhost", // Allow localhost for our FastAPI backend
]);

/**
 * Provider usage endpoint configuration
 * Maps each provider to its usage monitoring endpoint path
 */
interface ProviderUsageEndpoint {
	provider: ApiProvider;
	usagePath: string;
}

const PROVIDER_USAGE_ENDPOINTS: readonly ProviderUsageEndpoint[] = [
	{
		provider: "anthropic",
		usagePath: "/api/oauth/usage", // Real Anthropic OAuth usage API (returns five_hour/seven_day utilization)
	},
	{
		provider: "openai",
		usagePath: "/v1/usage", // Updated OpenAI usage endpoint (organization/usage was deprecated)
	},
	{
		provider: "copilot",
		usagePath: "/cli/info", // Special endpoint for CLI-based providers
	},
	{
		provider: "windsurf",
		usagePath: "/api/v1/GetTeamCreditBalance", // Windsurf/Codeium credit balance API
	},
] as const;

/**
 * Get usage endpoint URL for a provider
 * Constructs full usage endpoint URL from provider baseUrl and usage path
 *
 * @param provider - The provider type
 * @param baseUrl - The API base URL (e.g., 'https://api.anthropic.com')
 * @returns Full usage endpoint URL or null if provider unknown
 *
 * @example
 * getUsageEndpoint('anthropic', 'https://api.anthropic.com')
 * // returns 'https://api.anthropic.com/api/oauth/usage'
 * getUsageEndpoint('openai', 'https://api.openai.com')
 * // returns 'https://api.openai.com/v1/usage'
 * getUsageEndpoint('unknown', 'https://example.com')
 * // returns null
 */
export function getUsageEndpoint(
	provider: ApiProvider,
	baseUrl: string,
): string | null {
	const isDebug = process.env.DEBUG === "true";

	if (isDebug) {
		console.warn(
			"[UsageMonitor:ENDPOINT_CONSTRUCTION] Constructing usage endpoint:",
			{
				provider,
				baseUrl,
			},
		);
	}

	const endpointConfig = PROVIDER_USAGE_ENDPOINTS.find(
		(e) => e.provider === provider,
	);
	if (!endpointConfig) {
		if (isDebug) {
			console.warn(
				"[UsageMonitor:ENDPOINT_CONSTRUCTION] Unknown provider - no endpoint configured:",
				{
					provider,
					availableProviders: PROVIDER_USAGE_ENDPOINTS.map((e) => e.provider),
				},
			);
		}
		return null;
	}

	if (isDebug) {
		console.warn(
			"[UsageMonitor:ENDPOINT_CONSTRUCTION] Found endpoint config for provider:",
			{
				provider,
				usagePath: endpointConfig.usagePath,
			},
		);
	}

	try {
		// Construct usage endpoint URL from baseUrl + usagePath
		const url = new URL(baseUrl);
		const originalPath = url.pathname;
		// Replace the path with the usage endpoint path
		url.pathname = endpointConfig.usagePath;

		// Note: quota/limit endpoint doesn't require query parameters
		// The model-usage and tool-usage endpoints would need time windows, but we're using quota/limit

		const finalUrl = url.toString();

		if (isDebug) {
			console.warn(
				"[UsageMonitor:ENDPOINT_CONSTRUCTION] Successfully constructed endpoint:",
				{
					provider,
					originalPath,
					newPath: endpointConfig.usagePath,
					finalUrl,
				},
			);
		}

		return finalUrl;
	} catch (error) {
		console.error(
			"[UsageMonitor] Invalid baseUrl for usage endpoint:",
			baseUrl,
		);
		if (isDebug) {
			console.warn(
				"[UsageMonitor:ENDPOINT_CONSTRUCTION] URL construction failed:",
				{
					baseUrl,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
		return null;
	}
}

/**
 * Detect API provider from baseUrl
 * Extracts domain and matches against known provider patterns
 *
 * @param baseUrl - The API base URL (e.g., 'https://api.anthropic.com')
 * @returns The detected provider type ('anthropic' | 'openai' | 'ollama' | 'ollama_local' | 'unknown')
 *
 * @example
 * detectProvider('https://api.anthropic.com') // returns 'anthropic'
 * detectProvider('https://api.openai.com') // returns 'openai'
 * detectProvider('http://localhost:11434') // returns 'ollama_local'
 * detectProvider('https://unknown.com/api') // returns 'unknown'
 */
export function detectProvider(baseUrl: string): ApiProvider {
	// Wrapper around shared detectProvider with debug logging for main process
	const isDebug = process.env.DEBUG === "true";

	const provider = sharedDetectProvider(baseUrl);

	if (isDebug) {
		console.warn("[UsageMonitor:PROVIDER_DETECTION] Detected provider:", {
			baseUrl,
			provider,
		});
	}

	return provider;
}

/**
 * Result of determining the active profile type
 */
interface ActiveProfileResult {
	profileId: string;
	profileName: string;
	profileEmail?: string;
	isAPIProfile: boolean;
	baseUrl: string;
	credential?: string;
}

/**
 * Type guard to check if an error has an HTTP status code
 * @param error - The error to check
 * @returns true if the error has a statusCode property
 */
function isHttpError(error: unknown): error is Error & { statusCode?: number } {
	return error instanceof Error && "statusCode" in error;
}

export class UsageMonitor extends EventEmitter {
	private static instance: UsageMonitor;
	private intervalId: NodeJS.Timeout | null = null;
	private currentUsage: UsageSnapshot | null = null;
	private currentUsageProfileId: string | null = null; // Track which profile's usage is in currentUsage
	private isChecking = false;

	// Per-profile API failure tracking with cooldown-based retry
	// Map<profileId, lastFailureTimestamp> - stores when API last failed for this profile
	private readonly apiFailureTimestamps: Map<string, number> = new Map();
	private static readonly API_FAILURE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown before API retry

	// Per-profile 429 rate limit tracking with exponential backoff
	// Map<profileId, { lastHit: timestamp, consecutiveHits: number }>
	private readonly rateLimitBackoff: Map<
		string,
		{ lastHit: number; consecutiveHits: number }
	> = new Map();
	private static readonly RATE_LIMIT_BASE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes base cooldown on 429
	private static readonly RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes max cooldown

	// Swap loop protection: track profiles that recently failed auth
	private readonly authFailedProfiles: Map<string, number> = new Map(); // profileId -> timestamp
	private static readonly AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown

	// Track profiles that need re-authentication (invalid refresh token)
	// These profiles have permanent auth failures that require manual re-auth
	private readonly needsReauthProfiles: Set<string> = new Set();

	// Cache for all profiles' usage data
	// Map<profileId, { usage: ProfileUsageSummary, fetchedAt: number }>
	private readonly allProfilesUsageCache: Map<
		string,
		{ usage: ProfileUsageSummary; fetchedAt: number }
	> = new Map();

	/** Tracks the last provider name requested via getUsageForProvider / USAGE_REQUEST.
	 *  Used to detect actual provider switches vs. repeated polling for the same provider. */
	private lastRequestedProvider: string | null = null;

	/** In-flight getUsageForProvider promises keyed by providerName.
	 *  Prevents concurrent duplicate requests that cause 429 rate-limiting. */
	private readonly pendingProviderFetch: Map<
		string,
		Promise<UsageSnapshot | null>
	> = new Map();

	/** Short-lived cache for API fetch results, shared across ALL code paths
	 *  (getUsageForProvider, checkUsageAndSwap, fetchUsage, fetchUsageViaAPI).
	 *  Key: "profileId:provider".  Prevents redundant API calls that cause 429. */
	private readonly apiResultCache: Map<
		string,
		{ snapshot: UsageSnapshot; fetchedAt: number }
	> = new Map();
	private static readonly API_RESULT_CACHE_TTL_MS = 15_000; // 15 seconds

	private static readonly PROFILE_USAGE_CACHE_TTL_MS = 60 * 1000; // 1 minute cache for inactive profiles

	// Proactive swap cooldown: prevents cascading swaps (A→B→C→A loops)
	private lastProactiveSwapAt = 0;
	private static readonly PROACTIVE_SWAP_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between proactive swaps

	// Recent swap chain for loop detection
	private recentSwapChain: Array<{ from: string; to: string; at: number }> = [];
	private static readonly MAX_SWAP_CHAIN_LENGTH = 5;
	private static readonly SWAP_CHAIN_WINDOW_MS = 10 * 60 * 1000; // 10 minute window

	// Debug flag for verbose logging
	private readonly isDebug = process.env.DEBUG === "true";

	/**
	 * Debug log helper - only logs when DEBUG=true with colored output and scope highlighting
	 */
	private debugLog(message: string, data?: unknown): void {
		if (this.isDebug) {
			if (data) {
				frontendDebugLog(message, data);
			} else {
				frontendDebugLog(message);
			}
		}
	}

	private async fetchBackendWithRetry(
		url: string,
		init: RequestInit,
		context: string,
	): Promise<Response> {
		const MAX_RETRIES = 2;
		const BASE_DELAY_MS = 500;
		let lastResponse: Response | null = null;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const response = await fetch(url, init);
			if (response.status !== 429) {
				return response;
			}
			lastResponse = response;
			if (attempt === MAX_RETRIES) break;
			const retryAfter = Number(response.headers.get("retry-after"));
			const delay = Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: BASE_DELAY_MS * 2 ** attempt;
			this.debugLog(
				`[UsageMonitor:${context}] 429 received, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		return lastResponse as Response;
	}

	private constructor() {
		super();
		this.debugLog("[UsageMonitor] Initialized");
	}

	static getInstance(): UsageMonitor {
		if (!UsageMonitor.instance) {
			UsageMonitor.instance = new UsageMonitor();
		}
		return UsageMonitor.instance;
	}

	/**
	 * Start monitoring usage at configured interval
	 *
	 * Note: Usage monitoring always runs to display the usage badge.
	 * Proactive account swapping only occurs if enabled in settings.
	 *
	 * Update interval: 60 seconds (60000ms) to keep usage stats accurate
	 * while avoiding API rate limits (429 errors).
	 */
	start(): void {
		if (this.intervalId) {
			this.debugLog("[UsageMonitor] Already running");
			return;
		}

		const profileManager = getClaudeProfileManager();
		const settings = profileManager.getAutoSwitchSettings();
		const interval = settings.usageCheckInterval || 60000; // 60 seconds — balanced between freshness and rate limits

		this.debugLog(`[UsageMonitor] Starting with interval: ${interval} ms`);

		// Delay the initial check by 10 seconds so the renderer's useEffect
		// calls (via getUsageForProvider) can complete first.  Without this
		// delay, checkUsageAndSwap fires at the same time as 6+ renderer
		// requests, all competing for the same Anthropic usage API and
		// causing 429 "Too Many Requests" on every single one.
		// The apiResultCache in fetchUsageViaAPI also protects against this,
		// but the delay ensures the UI gets first crack at a clean API call.
		setTimeout(() => this.checkUsageAndSwap(true), 10000);

		// Then check periodically
		this.intervalId = setInterval(() => {
			this.checkUsageAndSwap(false); // false = don't suppress errors
		}, interval);
	}

	/**
	 * Stop monitoring
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.debugLog("[UsageMonitor] Stopped");
		}
	}

	/**
	 * Get current usage snapshot (for UI indicator)
	 */
	getCurrentUsage(): UsageSnapshot | null {
		return this.currentUsage;
	}

	/**
	 * Clear the usage cache for a specific profile.
	 * Called after re-authentication to ensure fresh usage data is fetched.
	 *
	 * @param profileId - Profile identifier to clear cache for
	 */
	clearProfileUsageCache(profileId: string): void {
		const deleted = this.allProfilesUsageCache.delete(profileId);

		// Also clear currentUsage if it belongs to this profile
		// This prevents stale data from being displayed when getAllProfilesUsage()
		// uses this.currentUsage for the active profile
		const clearedCurrentUsage = this.currentUsageProfileId === profileId;
		if (clearedCurrentUsage) {
			this.currentUsage = null;
			this.currentUsageProfileId = null;
		}

		// Clear velocity data to avoid stale predictions
		getVelocityTracker().clearProfile(profileId);

		this.debugLog("[UsageMonitor] Cleared usage cache for profile:", {
			profileId,
			wasInCache: deleted,
			clearedCurrentUsage,
		});
	}

	/**
	 * Clear a profile from the auth-failed list.
	 * Called after successful re-authentication to allow the profile to be used again.
	 *
	 * @param profileId - Profile identifier to clear from failed list
	 */
	clearAuthFailedProfile(profileId: string): void {
		const wasInFailedList = this.authFailedProfiles.has(profileId);
		const wasNeedsReauth = this.needsReauthProfiles.has(profileId);
		this.authFailedProfiles.delete(profileId);
		this.needsReauthProfiles.delete(profileId);
		this.clearProfileUsageCache(profileId);

		if (wasInFailedList || wasNeedsReauth) {
			this.debugLog(
				`[UsageMonitor] Cleared auth failure status for profile: ${profileId}`,
				{
					wasInFailedList,
					wasNeedsReauth,
				},
			);
		}
	}

	/**
	 * Trigger an immediate usage check.
	 * Called after re-authentication to give the user immediate feedback.
	 */
	checkNow(): void {
		this.debugLog("[UsageMonitor] Immediate check triggered");
		this.checkUsageAndSwap().catch((error) => {
			console.error("[UsageMonitor] Immediate check failed:", error);
		});
	}

	/**
	 * Reset usage monitoring state after a provider switch.
	 *
	 * Clears all stale caches, failure cooldowns, and rate limit backoffs so that
	 * the next usage fetch for the new provider starts fresh.
	 * Called from USAGE_REQUEST and PROVIDER_SELECT IPC handlers.
	 *
	 * Does NOT trigger an immediate background check — the caller is expected to
	 * follow up with getUsageForProvider() or similar. This avoids redundant
	 * concurrent fetches.
	 *
	 * @param providerName - The provider being switched to (e.g., 'anthropic', 'openai')
	 */
	onProviderSwitch(providerName: string): void {
		this.debugLog(
			"[UsageMonitor] Provider switch detected, resetting state for:",
			providerName,
		);

		// Clear all failure cooldowns and rate limit backoffs
		// These are keyed by profileId, so clear them all to avoid blocking the new provider
		this.apiFailureTimestamps.clear();
		this.rateLimitBackoff.clear();

		// Clear the all-profiles usage cache (stale from previous provider context)
		this.allProfilesUsageCache.clear();

		// Clear API result cache so the new provider gets a fresh fetch
		this.apiResultCache.clear();

		// Clear currentUsage so stale data from the old provider is not used as fallback
		this.currentUsage = null;
		this.currentUsageProfileId = null;

		// Clear all velocity tracking data (stale from previous provider)
		getVelocityTracker().clear();

		// Clear keychain cache to ensure fresh credentials are fetched
		clearKeychainCache();

		// Update tracking so subsequent requests for the same provider don't re-clear
		this.lastRequestedProvider = providerName;
	}

	/**
	 * Called on every USAGE_REQUEST with a providerName.
	 * Only performs the full cache reset when the provider actually changed
	 * compared to the last request. This avoids clearing caches on every
	 * 30-second polling cycle or initial mount for the same provider.
	 *
	 * @param providerName - The provider being requested
	 * @returns true if a reset was performed, false if same provider as before
	 */
	onProviderRequestIfChanged(providerName: string): boolean {
		if (this.lastRequestedProvider === providerName) {
			return false; // Same provider — no reset needed
		}

		// First request ever (initial app load): just record the provider,
		// do NOT clear caches — there is nothing stale to clear and
		// clearKeychainCache() would destroy credentials loaded during startup.
		if (this.lastRequestedProvider === null) {
			this.debugLog(
				`[UsageMonitor] Initial provider request: ${providerName} (no reset)`,
			);
			this.lastRequestedProvider = providerName;
			return false;
		}

		// Actual provider switch — clear stale state
		this.debugLog(
			`[UsageMonitor] Provider changed from ${this.lastRequestedProvider} to ${providerName}`,
		);
		this.onProviderSwitch(providerName);
		return true;
	}

	/**
	 * Get all profiles usage data (for multi-profile display in UI)
	 * Returns cached data if fresh, otherwise fetches for all profiles
	 *
	 * Uses parallel fetching for inactive profiles to minimize blocking delays.
	 *
	 * @param forceRefresh - If true, bypasses cache and fetches fresh data for all profiles
	 */
	async getAllProfilesUsage(
		forceRefresh: boolean = false,
	): Promise<AllProfilesUsage | null> {
		const profileManager = getClaudeProfileManager();
		const settings = profileManager.getSettings();
		const activeProfileId = settings.activeProfileId;

		// CRITICAL: On startup, currentUsage may be null, but we still need to check for
		// missing credentials to show the re-auth indicator. Proactively check all profiles
		// for missing credentials and populate needsReauthProfiles.
		if (!this.currentUsage) {
			// Check all OAuth profiles for missing credentials
			for (const profile of settings.profiles) {
				if (profile.configDir) {
					const expandedConfigDir = profile.configDir.startsWith("~")
						? profile.configDir.replace(/^~/, homedir())
						: profile.configDir;
					const creds = getCredentialsFromKeychain(expandedConfigDir);
					if (!creds.token) {
						// Credentials are missing - mark for re-auth
						this.needsReauthProfiles.add(profile.id);
						this.debugLog(
							"[UsageMonitor:getAllProfilesUsage] Profile needs re-auth (no credentials): " +
								profile.name,
						);
					}
				}
			}

			// Build a minimal response with needsReauthentication flags even without usage data
			const allProfiles: ProfileUsageSummary[] = settings.profiles.map(
				(profile) => ({
					profileId: profile.id,
					profileName: profile.name,
					profileEmail: profile.email,
					sessionPercent: 0,
					weeklyPercent: 0,
					isAuthenticated: profile.isAuthenticated ?? false,
					isRateLimited: false,
					availabilityScore: profile.isAuthenticated ? 100 : 0,
					isActive: profile.id === activeProfileId,
					needsReauthentication: this.needsReauthProfiles.has(profile.id),
				}),
			);

			// Return minimal data with auth status - don't return null!
			return {
				activeProfile: {
					profileId: activeProfileId || "",
					profileName:
						settings.profiles.find((p) => p.id === activeProfileId)?.name || "",
					sessionPercent: 0,
					weeklyPercent: 0,
					fetchedAt: new Date(),
					needsReauthentication: this.needsReauthProfiles.has(
						activeProfileId || "",
					),
				},
				allProfiles,
				fetchedAt: new Date(),
			};
		}

		const now = Date.now();
		const allProfiles: ProfileUsageSummary[] = [];

		// First pass: identify profiles that need fresh data vs cached
		type ProfileToFetch = {
			profile: (typeof settings.profiles)[0];
			index: number;
		};
		const profilesToFetch: ProfileToFetch[] = [];
		const profileResults: (ProfileUsageSummary | null)[] = new Array(
			settings.profiles.length,
		).fill(null);

		for (let i = 0; i < settings.profiles.length; i++) {
			const profile = settings.profiles[i];
			const cached = this.allProfilesUsageCache.get(profile.id);

			// For active profile, always prefer this.currentUsage (most up-to-date data from last poll)
			// This must run BEFORE the cache check so a stale cache entry cannot shadow fresh polling data
			if (profile.id === activeProfileId && this.currentUsage) {
				const summary = this.buildProfileUsageSummary(
					{
						id: profile.id,
						name: profile.name,
						email: profile.email || "",
						isAuthenticated: profile.isAuthenticated,
					},
					this.currentUsage,
				);
				profileResults[i] = summary;
				this.allProfilesUsageCache.set(profile.id, {
					usage: summary,
					fetchedAt: now,
				});
				continue;
			}

			// Use cached data if fresh (within TTL) and not force refreshing
			if (
				!forceRefresh &&
				cached &&
				now - cached.fetchedAt < UsageMonitor.PROFILE_USAGE_CACHE_TTL_MS
			) {
				profileResults[i] = {
					...cached.usage,
					isActive: profile.id === activeProfileId,
				};
				continue;
			}

			// Mark for parallel fetch
			profilesToFetch.push({ profile, index: i });
		}

		// Parallel fetch for all inactive profiles that need fresh data
		if (profilesToFetch.length > 0) {
			// Collect usage updates for batch save (avoids race condition with concurrent saves)
			const usageUpdates: Array<{
				profileId: string;
				sessionPercent: number;
				weeklyPercent: number;
			}> = [];

			const fetchPromises = profilesToFetch.map(async ({ profile, index }) => {
				const inactiveUsage = await this.fetchUsageForInactiveProfile(profile);
				const rateLimitStatus = isProfileRateLimited(profile);

				let sessionPercent = 0;
				let weeklyPercent = 0;

				if (inactiveUsage) {
					sessionPercent = inactiveUsage.sessionPercent;
					weeklyPercent = inactiveUsage.weeklyPercent;
					// Collect update for batch save (don't save here to avoid race condition)
					return {
						index,
						update: { profileId: profile.id, sessionPercent, weeklyPercent },
						profile,
						inactiveUsage,
						rateLimitStatus,
					};
				} else {
					// Fallback to cached profile data if API fetch failed
					sessionPercent = profile.usage?.sessionUsagePercent ?? 0;
					weeklyPercent = profile.usage?.weeklyUsagePercent ?? 0;
					return {
						index,
						update: null, // No update needed for fallback
						profile,
						inactiveUsage,
						rateLimitStatus,
						sessionPercent,
						weeklyPercent,
					};
				}
			});

			// Wait for all fetches to complete in parallel, with a global safety timeout
			// in case any sub-promise hangs (sub-promises have their own 10s timeouts).
			const FETCH_ALL_TIMEOUT_MS = 30000;
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`Usage fetch batch timed out after ${FETCH_ALL_TIMEOUT_MS}ms`,
							),
						),
					FETCH_ALL_TIMEOUT_MS,
				),
			);
			const fetchResults = await Promise.race([
				Promise.all(fetchPromises),
				timeoutPromise,
			]);

			// Collect all updates and build summaries
			for (const result of fetchResults) {
				const { index, update, profile, inactiveUsage, rateLimitStatus } =
					result;

				// Get percentages from either the update or the fallback values
				const sessionPercent =
					update?.sessionPercent ?? result.sessionPercent ?? 0;
				const weeklyPercent =
					update?.weeklyPercent ?? result.weeklyPercent ?? 0;

				if (update) {
					usageUpdates.push(update);
				}

				const summary: ProfileUsageSummary = {
					profileId: profile.id,
					profileName: profile.name,
					profileEmail: profile.email,
					sessionPercent,
					weeklyPercent,
					isAuthenticated: profile.isAuthenticated ?? false,
					isRateLimited: rateLimitStatus.limited,
					rateLimitType: rateLimitStatus.type,
					availabilityScore: calculateProfileScore({
						sessionPercent,
						weeklyPercent,
						isRateLimited: rateLimitStatus.limited,
						rateLimitType: rateLimitStatus.type,
						isAuthenticated: profile.isAuthenticated ?? false,
					}),
					isActive: profile.id === activeProfileId,
					lastFetchedAt:
						inactiveUsage?.fetchedAt?.toISOString() ??
						profile.usage?.lastUpdated?.toISOString(),
					needsReauthentication: this.needsReauthProfiles.has(profile.id),
				};

				this.allProfilesUsageCache.set(profile.id, {
					usage: summary,
					fetchedAt: now,
				});
				profileResults[index] = summary;
			}

			// Batch save all usage updates at once (single disk write, no race condition)
			if (usageUpdates.length > 0) {
				profileManager.batchUpdateProfileUsageFromAPI(usageUpdates);
			}
		}

		// Collect non-null results
		for (const result of profileResults) {
			if (result) {
				allProfiles.push(result);
			}
		}

		// Sort by availability score (highest first = most available)
		allProfiles.sort((a, b) => b.availabilityScore - a.availabilityScore);

		return {
			activeProfile: this.currentUsage,
			allProfiles,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Fetch usage for an inactive profile using its own credentials
	 * This allows showing real usage data for non-active profiles
	 *
	 * Uses ensureValidToken to proactively refresh tokens before making API calls,
	 * preventing 401 errors for inactive profiles whose tokens may have expired.
	 */
	private async fetchUsageForInactiveProfile(profile: {
		id: string;
		name: string;
		email?: string;
		configDir?: string;
		isAuthenticated?: boolean;
	}): Promise<UsageSnapshot | null> {
		// Only fetch for authenticated profiles with a configDir
		if (!profile.isAuthenticated || !profile.configDir) {
			this.debugLog(
				"[UsageMonitor] Skipping inactive profile fetch - not authenticated or no configDir:",
				{
					profileId: profile.id,
					profileName: profile.name,
					isAuthenticated: profile.isAuthenticated,
					hasConfigDir: !!profile.configDir,
				},
			);
			return null;
		}

		try {
			// Get credentials from keychain for this profile's configDir
			const expandedConfigDir = profile.configDir.startsWith("~")
				? profile.configDir.replace(/^~/, homedir())
				: profile.configDir;

			// Use ensureValidToken to proactively refresh the token if near expiry
			// This is critical for inactive profiles whose tokens may have expired
			let token: string | null = null;
			let wasRefreshed = false;

			try {
				const tokenResult = await ensureValidToken(expandedConfigDir);

				if (tokenResult.wasRefreshed) {
					this.debugLog(
						"[UsageMonitor] Proactively refreshed token for inactive profile: " +
							profile.name,
						{
							tokenFingerprint: getCredentialFingerprint(tokenResult.token),
						},
					);
					wasRefreshed = true;

					// Check if token refresh succeeded but persistence failed
					// The token works for this session but will be lost on restart
					if (tokenResult.persistenceFailed) {
						console.warn(
							"[UsageMonitor] Token refreshed but persistence failed for profile: " +
								profile.name +
								" - user should re-authenticate to avoid auth errors on next restart",
						);
						this.needsReauthProfiles.add(profile.id);
					} else {
						// Token was refreshed and persisted successfully - clear from needsReauth if present
						this.needsReauthProfiles.delete(profile.id);
					}
				}

				token = tokenResult.token;

				if (tokenResult.error) {
					this.debugLog(
						"[UsageMonitor] Token validation failed for inactive profile: " +
							profile.name,
						tokenResult.error,
					);

					// Check for invalid_grant error - indicates refresh token is invalid
					// and user needs to manually re-authenticate
					if (tokenResult.errorCode === "invalid_grant") {
						this.debugLog(
							"[UsageMonitor] Profile needs re-authentication (invalid refresh token): " +
								profile.name,
						);
						this.needsReauthProfiles.add(profile.id);
					}

					// Check for missing_credentials error - indicates no token in credential store
					// User needs to authenticate via /login
					if (tokenResult.errorCode === "missing_credentials") {
						this.debugLog(
							"[UsageMonitor] Profile needs authentication (no credentials found): " +
								profile.name,
						);
						this.needsReauthProfiles.add(profile.id);
					}
				}
			} catch (error) {
				this.debugLog(
					"[UsageMonitor] ensureValidToken failed for inactive profile: " +
						profile.name,
					error,
				);
			}

			// Fallback: Try direct keychain read if ensureValidToken failed
			if (!token) {
				const keychainCreds = getCredentialsFromKeychain(expandedConfigDir);
				token = keychainCreds.token;

				if (!token) {
					this.debugLog(
						"[UsageMonitor] No keychain credentials for inactive profile: " +
							profile.name,
					);
					// Mark profile as needing re-authentication since credentials are missing
					this.needsReauthProfiles.add(profile.id);
					return null;
				}
			}

			this.debugLog("[UsageMonitor] Fetching usage for inactive profile:", {
				profileId: profile.id,
				profileName: profile.name,
				tokenFingerprint: getCredentialFingerprint(token),
				wasRefreshed,
			});

			// Fetch usage via API - OAuth profiles always use Anthropic
			const usage = await this.fetchUsageViaAPI(
				token,
				profile.id,
				profile.name,
				profile.email,
				{
					profileId: profile.id,
					profileName: profile.name,
					profileEmail: profile.email,
					isAPIProfile: false,
					baseUrl: "https://api.anthropic.com",
				},
			);

			if (usage) {
				this.debugLog(
					"[UsageMonitor] Successfully fetched inactive profile usage:",
					{
						profileName: profile.name,
						sessionPercent: usage.sessionPercent,
						weeklyPercent: usage.weeklyPercent,
					},
				);
				// Record velocity data point for inactive profile predictions
				getVelocityTracker().recordDataPoint(
					profile.id,
					usage.sessionPercent,
					usage.weeklyPercent,
				);
			}

			return usage;
		} catch (error) {
			this.debugLog(
				"[UsageMonitor] Failed to fetch inactive profile usage: " +
					profile.name,
				error,
			);
			return null;
		}
	}

	/**
	 * Build a ProfileUsageSummary from a UsageSnapshot
	 */
	private buildProfileUsageSummary(
		profile: {
			id: string;
			name: string;
			email: string;
			isAuthenticated?: boolean;
		},
		usage: UsageSnapshot,
	): ProfileUsageSummary {
		const profileManager = getClaudeProfileManager();
		const fullProfile = profileManager.getProfile(profile.id);
		const rateLimitStatus = fullProfile
			? isProfileRateLimited(fullProfile)
			: { limited: false };

		return {
			profileId: profile.id,
			profileName: profile.name,
			profileEmail: usage.profileEmail || profile.email,
			sessionPercent: usage.sessionPercent,
			weeklyPercent: usage.weeklyPercent,
			sessionResetTimestamp: usage.sessionResetTimestamp,
			weeklyResetTimestamp: usage.weeklyResetTimestamp,
			isAuthenticated: profile.isAuthenticated ?? true,
			isRateLimited: rateLimitStatus.limited,
			rateLimitType: rateLimitStatus.type,
			availabilityScore: calculateProfileScore({
				sessionPercent: usage.sessionPercent,
				weeklyPercent: usage.weeklyPercent,
				isRateLimited: rateLimitStatus.limited,
				rateLimitType: rateLimitStatus.type,
				isAuthenticated: profile.isAuthenticated ?? true,
			}),
			isActive: profile.id === profileManager.getActiveProfile()?.id,
			lastFetchedAt: usage.fetchedAt?.toISOString(),
			needsReauthentication: this.needsReauthProfiles.has(profile.id),
		};
	}

	/**
	 * Get credential for usage monitoring (OAuth token or API key)
	 * Detects profile type and returns appropriate credential
	 *
	 * Priority:
	 * 1. API Profile (if active) - returns apiKey directly
	 * 2. OAuth Profile - reads FRESH token from Keychain (not cached oauthToken)
	 *
	 * IMPORTANT: For OAuth profiles, we read from Keychain instead of cached profile.oauthToken.
	 * OAuth tokens expire in 8-12 hours, but Claude CLI auto-refreshes and stores fresh tokens
	 * in Keychain. Using cached tokens causes 401 errors after a few hours.
	 * See: docs/LONG_LIVED_AUTH_PLAN.md
	 *
	 * @returns The credential string or undefined if none available
	 */
	private async getCredential(): Promise<string | undefined> {
		// Try API profile first (highest priority)
		try {
			const profilesFile = await loadProfilesFile();
			if (profilesFile.activeProfileId) {
				const activeProfile = profilesFile.profiles.find(
					(p) => p.id === profilesFile.activeProfileId,
				);
				if (activeProfile?.apiKey) {
					this.debugLog(
						"[UsageMonitor:TRACE] Using API profile credential: " +
							activeProfile.name,
					);
					return activeProfile.apiKey;
				}
			}
		} catch (error) {
			// API profile loading failed, fall through to OAuth
			this.debugLog(
				"[UsageMonitor:TRACE] Failed to load API profiles, falling back to OAuth:",
				error,
			);
		}

		// Fall back to OAuth profile - use ensureValidToken for proactive refresh
		const profileManager = getClaudeProfileManager();
		const activeProfile = profileManager.getActiveProfile();
		if (activeProfile) {
			// Use ensureValidToken to proactively refresh tokens before they expire
			// This prevents 401 errors during overnight autonomous operation
			try {
				const tokenResult = await ensureValidToken(activeProfile.configDir);

				if (tokenResult.wasRefreshed) {
					this.debugLog(
						"[UsageMonitor] Proactively refreshed token for profile: " +
							activeProfile.name,
						{
							tokenFingerprint: getCredentialFingerprint(tokenResult.token),
						},
					);

					// Check if token refresh succeeded but persistence failed
					// The token works for this session but will be lost on restart
					if (tokenResult.persistenceFailed) {
						console.warn(
							"[UsageMonitor] Token refreshed but persistence failed for profile: " +
								activeProfile.name +
								" - user should re-authenticate to avoid auth errors on next restart",
						);
						this.needsReauthProfiles.add(activeProfile.id);
					} else {
						// Token was refreshed and persisted successfully - clear from needsReauth if present
						this.needsReauthProfiles.delete(activeProfile.id);
					}
				}

				if (tokenResult.token) {
					this.debugLog(
						"[UsageMonitor:TRACE] Using OAuth token for profile: " +
							activeProfile.name,
						{
							tokenFingerprint: getCredentialFingerprint(tokenResult.token),
							wasRefreshed: tokenResult.wasRefreshed,
						},
					);
					return tokenResult.token;
				}

				// Token unavailable - log the error
				if (tokenResult.error) {
					this.debugLog(
						"[UsageMonitor] Token validation failed:",
						tokenResult.error,
					);

					// Check for invalid_grant error - indicates refresh token is permanently invalid
					// and user needs to manually re-authenticate
					if (tokenResult.errorCode === "invalid_grant") {
						this.debugLog(
							"[UsageMonitor] Profile needs re-authentication (invalid refresh token): " +
								activeProfile.name,
						);
						this.needsReauthProfiles.add(activeProfile.id);
					}

					// Check for missing_credentials error - indicates no token in credential store
					// User needs to authenticate via /login
					if (tokenResult.errorCode === "missing_credentials") {
						this.debugLog(
							"[UsageMonitor] Profile needs authentication (no credentials found): " +
								activeProfile.name,
						);
						this.needsReauthProfiles.add(activeProfile.id);
					}
				}
			} catch (error) {
				console.error("[UsageMonitor] ensureValidToken threw error:", error);
			}

			// Fallback: Try direct keychain read (e.g., if refresh token unavailable)
			const keychainCreds = getCredentialsFromKeychain(activeProfile.configDir);
			if (keychainCreds.token) {
				this.debugLog(
					"[UsageMonitor:TRACE] Using fallback OAuth token from Keychain for profile: " +
						activeProfile.name,
					{
						tokenFingerprint: getCredentialFingerprint(keychainCreds.token),
					},
				);
				return keychainCreds.token;
			}

			// Keychain read also failed
			if (keychainCreds.error) {
				this.debugLog(
					"[UsageMonitor] Keychain access failed:",
					keychainCreds.error,
				);
			} else {
				this.debugLog(
					"[UsageMonitor:TRACE] No token in Keychain for profile: " +
						activeProfile.name +
						" - user may need to re-authenticate with claude /login",
				);
			}

			// Mark profile as needing re-authentication since credentials are missing
			this.needsReauthProfiles.add(activeProfile.id);
		}

		// No credential available
		this.debugLog(
			"[UsageMonitor:TRACE] No credential available (no API or OAuth profile active)",
		);
		return undefined;
	}

	/**
	 * Get credential for a specific OAuth profile.
	 *
	 * Unlike getCredential() which uses getActiveProfile() (which may return a different
	 * profile than the one we want), this method directly targets the specified profile's
	 * configDir for token retrieval.
	 */
	private async getCredentialForProfile(profile: {
		id: string;
		name: string;
		configDir?: string;
	}): Promise<string | undefined> {
		if (!profile.configDir) {
			console.warn(
				"[UsageMonitor:getCredentialForProfile] Profile has no configDir:",
				profile.name,
			);
			return undefined;
		}

		// Try ensureValidToken first (proactive refresh)
		try {
			const tokenResult = await ensureValidToken(profile.configDir);

			if (tokenResult.wasRefreshed) {
				if (tokenResult.persistenceFailed) {
					console.warn(
						"[UsageMonitor:getCredentialForProfile] Token refreshed but persistence failed for:",
						profile.name,
					);
					this.needsReauthProfiles.add(profile.id);
				} else {
					this.needsReauthProfiles.delete(profile.id);
				}
			}

			if (tokenResult.token) {
				return tokenResult.token;
			}

			// Token unavailable
			if (tokenResult.error) {
				console.warn(
					"[UsageMonitor:getCredentialForProfile] Token validation failed for",
					profile.name,
					":",
					tokenResult.error,
				);
				if (
					tokenResult.errorCode === "invalid_grant" ||
					tokenResult.errorCode === "missing_credentials"
				) {
					this.needsReauthProfiles.add(profile.id);
				}
			}
		} catch (error) {
			console.error(
				"[UsageMonitor:getCredentialForProfile] ensureValidToken threw for",
				profile.name,
				":",
				error,
			);
		}

		// Fallback: direct keychain read
		const keychainCreds = getCredentialsFromKeychain(profile.configDir);
		if (keychainCreds.token) {
			return keychainCreds.token;
		}

		if (keychainCreds.error) {
			console.warn(
				"[UsageMonitor:getCredentialForProfile] Keychain access failed for",
				profile.name,
				":",
				keychainCreds.error,
			);
		}

		// Mark as needing re-authentication
		this.needsReauthProfiles.add(profile.id);
		console.warn(
			"[UsageMonitor:getCredentialForProfile] No credential found for:",
			profile.name,
			"- user may need to re-authenticate",
		);
		return undefined;
	}

	/**
	 * Check usage and trigger swap if thresholds exceeded
	 *
	 * Refactored to use helper methods for better maintainability:
	 * - determineActiveProfile(): Detects API vs OAuth profile
	 * - checkThresholdsExceeded(): Evaluates usage against thresholds
	 * - handleAuthFailure(): Manages auth failure recovery
	 *
	 * @param suppressErrors - If true, suppresses error logging (used during startup)
	 */
	private async checkUsageAndSwap(
		suppressErrors: boolean = false,
	): Promise<void> {
		if (this.isChecking) {
			return; // Prevent concurrent checks
		}

		this.isChecking = true;
		let profileId: string | undefined;
		let isAPIProfile = false;

		try {
			// Step 1: Determine active profile (API vs OAuth)
			const activeProfile = await this.determineActiveProfile();
			if (!activeProfile) {
				return; // No active profile
			}

			profileId = activeProfile.profileId;
			isAPIProfile = activeProfile.isAPIProfile;

			// Step 2: Fetch current usage (pass activeProfile for consistency)
			const provider = detectProvider(activeProfile.baseUrl);

			// Skip OAuth credential fetch for non-Anthropic providers — they manage their own
			// credentials internally (e.g., Windsurf uses getUsageForProvider which fetches its own key).
			// This avoids unnecessary Claude OAuth token refresh when Windsurf/Copilot is active.
			const credential =
				provider === "windsurf" || provider === "copilot"
					? undefined
					: await this.getCredential();
			let usage = await this.fetchUsage(
				profileId,
				credential,
				activeProfile,
				provider,
				suppressErrors,
			);

			// For anthropic API key profiles, if weekly data is missing (0%), try OAuth as well
			// since the OAuth usage endpoint may return more complete data with an OAuth token
			if (
				usage &&
				isAPIProfile &&
				provider === "anthropic" &&
				usage.weeklyPercent === 0 &&
				usage.sessionPercent > 0
			) {
				this.debugLog(
					"[UsageMonitor] API key returned incomplete anthropic data, trying OAuth supplement",
				);
				const profileManager = getClaudeProfileManager();
				const oauthProfile =
					profileManager.getProfilesSortedByAvailability()?.[0];
				if (oauthProfile) {
					const oauthCredential =
						await this.getCredentialForProfile(oauthProfile);
					if (oauthCredential) {
						const oauthResult: ActiveProfileResult = {
							profileId: oauthProfile.id,
							profileName: oauthProfile.name,
							profileEmail: oauthProfile.email,
							isAPIProfile: false,
							baseUrl: "https://api.anthropic.com",
						};
						const oauthUsage = await this.fetchUsageViaAPI(
							oauthCredential,
							oauthProfile.id,
							oauthProfile.name,
							oauthProfile.email,
							oauthResult,
							suppressErrors,
						);
						if (oauthUsage && oauthUsage.weeklyPercent > 0) {
							// Merge: use OAuth weekly data, keep API session data
							usage = {
								...usage,
								weeklyPercent: oauthUsage.weeklyPercent,
								weeklyResetTimestamp: oauthUsage.weeklyResetTimestamp,
							};
						}
					}
				}
			}

			if (!usage) {
				this.debugLog("[UsageMonitor] Failed to fetch usage");
				return;
			}

			// Add needsReauthentication flag to the snapshot for the active profile
			usage.needsReauthentication = this.needsReauthProfiles.has(profileId);

			this.currentUsage = usage;
			this.currentUsageProfileId = profileId; // Track which profile this usage belongs to

			// Step 2.4: Record velocity data point for predictive switching
			getVelocityTracker().recordDataPoint(
				profileId,
				usage.sessionPercent,
				usage.weeklyPercent,
			);

			// Step 2.5: Persist usage to profile for caching (so other profiles can display cached usage)
			const profileManager = getClaudeProfileManager();
			profileManager.updateProfileUsageFromAPI(
				profileId,
				usage.sessionPercent,
				usage.weeklyPercent,
			);

			// Step 2.6: Clear stale rate limit events when usage is well below the threshold.
			// A successful API fetch with low usage means the window has reset and the user is no longer blocked.
			if (usage.sessionPercent < 90 && usage.weeklyPercent < 90) {
				profileManager.clearRateLimitEvents(profileId);
			}

			// Step 3: Emit usage update for UI (always emit, regardless of proactive swap settings)
			// Ensure providerName is always set so the renderer can filter by provider correctly.
			// CLI-fetched snapshots (fetchUsageViaCLI) do not set providerName, so we add it here.
			if (!usage.providerName && provider) {
				usage = { ...usage, providerName: provider };
			}
			this.emit("usage-updated", usage);

			// Step 3.5: Emit all profiles usage for multi-profile display
			const allProfilesUsage = await this.getAllProfilesUsage();
			if (allProfilesUsage) {
				this.emit("all-profiles-usage-updated", allProfilesUsage);
			}

			// Step 4: Check thresholds and perform proactive swap (OAuth profiles only)
			if (activeProfile.isAPIProfile === false) {
				const profileManager = getClaudeProfileManager();
				const settings = profileManager.getAutoSwitchSettings();

				if (!settings.enabled || !settings.proactiveSwapEnabled) {
					this.debugLog(
						"[UsageMonitor:TRACE] Proactive swap disabled, skipping threshold check",
					);
					return;
				}

				// Get velocity data for predictive switching
				const velocityTracker = getVelocityTracker();
				const velocityData = velocityTracker.getVelocity(profileId);
				const timeToLimit = velocityData
					? velocityTracker.getEstimatedTimeToLimit(
							profileId,
							settings.sessionThreshold ?? 95,
							settings.weeklyThreshold ?? 99,
						)
					: undefined;

				const thresholds = this.checkThresholdsExceeded(usage, settings);

				// Determine swap reason: threshold exceeded or velocity-predicted
				let shouldSwap = false;
				let swapReason: "session" | "weekly" = "session";

				if (thresholds.anyExceeded) {
					shouldSwap = true;
					swapReason = thresholds.sessionExceeded ? "session" : "weekly";

					this.debugLog("[UsageMonitor] Threshold exceeded:", {
						sessionPercent: usage.sessionPercent,
						sessionThreshold: settings.sessionThreshold ?? 95,
						weeklyPercent: usage.weeklyPercent,
						weeklyThreshold: settings.weeklyThreshold ?? 99,
					});
				} else if (
					velocityData &&
					velocityData.confidence !== "low" &&
					timeToLimit
				) {
					// Velocity-based early switch: predicted to hit limit soon
					if (
						timeToLimit.sessionMinutesRemaining !== null &&
						timeToLimit.sessionMinutesRemaining < 5
					) {
						shouldSwap = true;
						this.debugLog(
							"[UsageMonitor] Velocity-predicted session limit in ~" +
								Math.round(timeToLimit.sessionMinutesRemaining) +
								" min",
							{
								velocity: `${velocityData.sessionVelocity.toFixed(2)}%/min`,
								confidence: velocityData.confidence,
							},
						);
					} else if (
						timeToLimit.weeklyMinutesRemaining !== null &&
						timeToLimit.weeklyMinutesRemaining < 30
					) {
						shouldSwap = true;
						swapReason = "weekly";
						this.debugLog(
							"[UsageMonitor] Velocity-predicted weekly limit in ~" +
								Math.round(timeToLimit.weeklyMinutesRemaining) +
								" min",
							{
								velocity: `${velocityData.weeklyVelocity.toFixed(2)}%/min`,
								confidence: velocityData.confidence,
							},
						);
					}
				}

				if (shouldSwap) {
					// Check cooldown before proactive swap (prevents cascading swaps)
					const timeSinceLastSwap = Date.now() - this.lastProactiveSwapAt;
					if (timeSinceLastSwap < UsageMonitor.PROACTIVE_SWAP_COOLDOWN_MS) {
						this.debugLog(
							"[UsageMonitor] Proactive swap on cooldown, skipping",
							{
								remainingMs:
									UsageMonitor.PROACTIVE_SWAP_COOLDOWN_MS - timeSinceLastSwap,
							},
						);
					} else if (this.detectSwapLoop(profileId)) {
						this.debugLog(
							"[UsageMonitor] Swap loop detected, suppressing proactive swap",
						);
					} else {
						// Attempt proactive swap
						await this.performProactiveSwap(profileId, swapReason);
					}
				} else {
					this.debugLog("[UsageMonitor:TRACE] Usage OK", {
						sessionPercent: usage.sessionPercent,
						weekPercent: usage.weeklyPercent,
					});
				}
			} else {
				this.debugLog(
					"[UsageMonitor:TRACE] Skipping proactive swap for API profile (only supported for OAuth profiles)",
				);
			}
		} catch (error) {
			// Step 5: Handle auth failures
			if (
				isHttpError(error) &&
				(error.statusCode === 401 || error.statusCode === 403)
			) {
				if (profileId) {
					await this.handleAuthFailure(profileId, isAPIProfile);
					return; // handleAuthFailure manages its own logging
				}
			}

			console.error("[UsageMonitor] Check failed:", error);
		} finally {
			this.isChecking = false;
		}
	}

	/**
	 * Check if API method should be used for a specific profile
	 *
	 * Uses cooldown-based retry: API is retried after API_FAILURE_COOLDOWN_MS
	 *
	 * @param profileId - Profile identifier
	 * @returns true if API should be tried, false if CLI should be used
	 */
	private shouldUseApiMethod(profileId: string): boolean {
		// Check 429 rate limit backoff first (longer cooldown with exponential backoff)
		const backoffState = this.rateLimitBackoff.get(profileId);
		if (backoffState) {
			const cooldown = Math.min(
				UsageMonitor.RATE_LIMIT_BASE_COOLDOWN_MS *
					2 ** (backoffState.consecutiveHits - 1),
				UsageMonitor.RATE_LIMIT_MAX_COOLDOWN_MS,
			);
			const elapsed = Date.now() - backoffState.lastHit;
			if (elapsed < cooldown) {
				this.debugLog(
					`[UsageMonitor] Rate limit backoff active for ${profileId}: ${Math.round((cooldown - elapsed) / 1000)}s remaining`,
				);
				return false;
			}
			// Cooldown expired — allow retry but keep backoff state in case it 429s again
		}

		const lastFailure = this.apiFailureTimestamps.get(profileId);
		if (!lastFailure) return true; // No previous failure, try API
		// Check if cooldown has expired (use >= to allow retry at exact boundary)
		const elapsed = Date.now() - lastFailure;
		return elapsed >= UsageMonitor.API_FAILURE_COOLDOWN_MS;
	}

	/**
	 * Determine which profile is active (API profile vs OAuth profile)
	 * API profiles take priority over OAuth profiles
	 *
	 * @returns Active profile info or null if no profile is active
	 */
	private async determineActiveProfile(): Promise<ActiveProfileResult | null> {
		// First, check if an API profile is active
		try {
			const profilesFile = await loadProfilesFile();
			if (profilesFile.activeProfileId) {
				const activeAPIProfile = profilesFile.profiles.find(
					(p) => p.id === profilesFile.activeProfileId,
				);
				if (activeAPIProfile?.apiKey) {
					// API profile is active and has an apiKey
					this.debugLog("[UsageMonitor:TRACE] Active auth type: API Profile", {
						profileId: activeAPIProfile.id,
						profileName: activeAPIProfile.name,
						baseUrl: activeAPIProfile.baseUrl,
					});
					return {
						profileId: activeAPIProfile.id,
						profileName: activeAPIProfile.name,
						isAPIProfile: true,
						baseUrl: activeAPIProfile.baseUrl,
					};
				} else if (activeAPIProfile) {
					// API profile exists but missing apiKey - fall back to OAuth
					this.debugLog(
						"[UsageMonitor:TRACE] Active API profile missing apiKey, falling back to OAuth",
						{
							profileId: activeAPIProfile.id,
							profileName: activeAPIProfile.name,
						},
					);
				} else {
					// activeProfileId is set but profile not found - fall through to OAuth
					this.debugLog(
						"[UsageMonitor:TRACE] Active API profile ID set but profile not found, falling back to OAuth",
					);
				}
			}
		} catch (error) {
			// Failed to load API profiles - fall through to OAuth
			this.debugLog(
				"[UsageMonitor:TRACE] Failed to load API profiles, falling back to OAuth:",
				error,
			);
		}

		// Check if a non-Claude provider (Windsurf, Copilot) is selected
		// This prevents fetching Anthropic usage when another provider is active
		const profileManager = getClaudeProfileManager();
		const settings = profileManager.getSettings();

		// Check if Windsurf is the active provider — multiple detection methods:
		// 1. selectedProvider in settings.json (persisted by CredentialManager.setActiveProvider)
		// 2. globalWindsurfApiKey in settings.json (user configured Windsurf key in settings)
		// 3. CredentialManager's active credential is windsurf-type
		try {
			const { readSettingsFile } = await import("../settings-utils");
			const appSettings = readSettingsFile();
			const selectedProvider = appSettings?.selectedProvider as
				| string
				| undefined;
			const globalWindsurfKey = appSettings?.globalWindsurfApiKey as
				| string
				| undefined;

			// Only detect Windsurf via globalWindsurfApiKey when no explicit provider is set.
			// If the user has explicitly selected another provider (e.g. 'anthropic'), respect it
			// and do not override it just because a Windsurf API key happens to be configured.
			const windsurfKeyActive =
				selectedProvider === "windsurf" ||
				(!selectedProvider && !!globalWindsurfKey?.trim());
			if (windsurfKeyActive) {
				const reason =
					selectedProvider === "windsurf"
						? "settings.selectedProvider"
						: "settings.globalWindsurfApiKey present";
				this.debugLog(
					`[UsageMonitor:TRACE] Active provider is Windsurf (${reason})`,
					{
						selectedProvider,
						hasGlobalWindsurfKey: !!globalWindsurfKey,
					},
				);

				// Auto-persist selectedProvider if it was detected via globalWindsurfApiKey fallback
				// so future checks are faster and the CredentialManager also picks it up
				if (!selectedProvider && globalWindsurfKey && appSettings) {
					try {
						const { writeSettingsFile } = await import("../settings-utils");
						appSettings.selectedProvider = "windsurf";
						writeSettingsFile(appSettings);
						this.debugLog(
							"[UsageMonitor] Auto-persisted selectedProvider=windsurf from globalWindsurfApiKey",
						);
					} catch (e) {
						this.debugLog(
							"[UsageMonitor] Failed to auto-persist selectedProvider:",
							e,
						);
					}
				}

				return {
					profileId: "windsurf-provider",
					profileName: "Windsurf (Codeium)",
					profileEmail: undefined,
					isAPIProfile: false,
					baseUrl: "https://server.codeium.com",
				};
			}
		} catch (error) {
			this.debugLog(
				"[UsageMonitor] Failed to read selectedProvider from settings:",
				error,
			);
		}

		// Check if Copilot or Windsurf is configured via API profiles
		if (settings.activeProfileId) {
			try {
				const currentProfilesFile = await loadProfilesFile();
				const activeProfile = currentProfilesFile.profiles.find(
					(p: { id?: string }) => p.id === settings.activeProfileId,
				);
				if (activeProfile) {
					const provider = detectProvider(activeProfile.baseUrl);
					if (provider === "copilot" || provider === "windsurf") {
						this.debugLog(
							`[UsageMonitor:TRACE] Active provider is ${provider} (from API profile)`,
							{
								profileId: activeProfile.id,
								profileName: activeProfile.name,
								baseUrl: activeProfile.baseUrl,
							},
						);
						return {
							profileId: activeProfile.id,
							profileName: activeProfile.name,
							profileEmail: undefined, // API profiles don't have email
							isAPIProfile: false,
							baseUrl: activeProfile.baseUrl,
						};
					}
				}
			} catch (error) {
				this.debugLog("[UsageMonitor] Failed to check provider status:", error);
			}
		}

		// If no API profile is active, check OAuth profiles
		const activeOAuthProfile = profileManager.getActiveProfile();

		if (!activeOAuthProfile) {
			this.debugLog("[UsageMonitor] No active profile (neither API nor OAuth)");
			return null;
		}

		// Get email from profile or try keychain
		let profileEmail = activeOAuthProfile.email;
		if (!profileEmail) {
			// Try to get email from keychain
			// IMPORTANT: Always pass configDir - service name is based on expanded path (e.g., /Users/xxx/.claude)
			const keychainCreds = getCredentialsFromKeychain(
				activeOAuthProfile.configDir,
			);
			profileEmail = keychainCreds.email ?? undefined;
		}

		this.debugLog("[UsageMonitor:TRACE] Active auth type: OAuth Profile", {
			profileId: activeOAuthProfile.id,
			profileName: activeOAuthProfile.name,
			profileEmail,
		});

		const result = {
			profileId: activeOAuthProfile.id,
			profileName: activeOAuthProfile.name,
			profileEmail,
			isAPIProfile: false,
			baseUrl: "https://api.anthropic.com",
		};

		return result;
	}

	/**
	 * Check if thresholds are exceeded for proactive swapping
	 *
	 * @param usage - Current usage snapshot
	 * @param settings - Auto-switch settings
	 * @returns Object indicating which thresholds are exceeded
	 */
	private checkThresholdsExceeded(
		usage: UsageSnapshot,
		settings: { sessionThreshold?: number; weeklyThreshold?: number },
	): {
		sessionExceeded: boolean;
		weeklyExceeded: boolean;
		anyExceeded: boolean;
	} {
		const sessionExceeded =
			usage.sessionPercent >= (settings.sessionThreshold ?? 95);
		const weeklyExceeded =
			usage.weeklyPercent >= (settings.weeklyThreshold ?? 99);

		return {
			sessionExceeded,
			weeklyExceeded,
			anyExceeded: sessionExceeded || weeklyExceeded,
		};
	}

	/**
	 * Handle auth failure by attempting token refresh, then marking profile as failed
	 * and attempting proactive swap if refresh fails.
	 *
	 * @param profileId - Profile that failed auth
	 * @param isAPIProfile - Whether this is an API profile (token refresh only for OAuth)
	 */
	private async handleAuthFailure(
		profileId: string,
		isAPIProfile: boolean,
	): Promise<void> {
		const profileManager = getClaudeProfileManager();

		// For OAuth profiles, attempt token refresh before giving up
		if (!isAPIProfile) {
			const profile = profileManager.getProfile(profileId);
			if (profile?.configDir) {
				this.debugLog(
					"[UsageMonitor] Auth failure - attempting token refresh for profile: " +
						profileId,
				);

				try {
					const refreshResult = await reactiveTokenRefresh(profile.configDir);

					if (refreshResult.wasRefreshed && refreshResult.token) {
						this.debugLog(
							"[UsageMonitor] Token refresh successful for profile: " +
								profileId,
							{
								tokenFingerprint: getCredentialFingerprint(refreshResult.token),
							},
						);

						// Check if token refresh succeeded but persistence failed
						// The token works for this session but will be lost on restart
						if (refreshResult.persistenceFailed) {
							console.warn(
								"[UsageMonitor] Token refreshed but persistence failed for profile: " +
									profileId +
									" - user should re-authenticate to avoid auth errors on next restart",
							);
							this.needsReauthProfiles.add(profileId);
						} else {
							// Token was refreshed and persisted successfully - clear from needsReauth if present
							this.needsReauthProfiles.delete(profileId);
						}

						// Token was refreshed - don't mark as failed, let next poll use the new token
						return;
					}

					if (refreshResult.error) {
						this.debugLog(
							"[UsageMonitor] Token refresh failed:",
							refreshResult.error,
						);

						// Check for invalid_grant error - indicates refresh token is permanently invalid
						// and user needs to manually re-authenticate (matches inactive profile handling)
						if (refreshResult.errorCode === "invalid_grant") {
							this.debugLog(
								"[UsageMonitor] Profile needs re-authentication (invalid refresh token): " +
									profileId,
							);
							this.needsReauthProfiles.add(profileId);
						}
					}
				} catch (refreshError) {
					console.error(
						"[UsageMonitor] Token refresh threw error:",
						refreshError,
					);
				}

				// Refresh failed - clear cache so next attempt gets fresh credentials
				this.debugLog(
					"[UsageMonitor] Auth failure - clearing keychain cache for profile: " +
						profileId,
				);
				clearKeychainCache(profile.configDir);
			}
		}

		// Mark this profile as auth-failed to prevent swap loops
		// This MUST happen before the early return to prevent infinite loops
		this.authFailedProfiles.set(profileId, Date.now());
		this.debugLog(
			"[UsageMonitor] Auth failure detected, marked profile as failed: " +
				profileId,
		);

		// Clean up expired entries from the failed profiles map
		const now = Date.now();
		this.authFailedProfiles.forEach((timestamp, failedProfileId) => {
			if (now - timestamp > UsageMonitor.AUTH_FAILURE_COOLDOWN_MS) {
				this.authFailedProfiles.delete(failedProfileId);
			}
		});

		const settings = profileManager.getAutoSwitchSettings();

		// Proactive swap is only supported for OAuth profiles, not API profiles
		if (isAPIProfile || !settings.enabled || !settings.proactiveSwapEnabled) {
			this.debugLog(
				"[UsageMonitor] Auth failure detected but proactive swap is disabled or using API profile, skipping swap",
			);
			return;
		}

		try {
			const excludeProfiles = Array.from(this.authFailedProfiles.keys());
			this.debugLog(
				"[UsageMonitor] Attempting proactive swap (excluding failed profiles):",
				excludeProfiles,
			);
			await this.performProactiveSwap(
				profileId,
				"session", // Treat auth failure as session limit for immediate swap
				excludeProfiles,
			);
		} catch (swapError) {
			console.error(
				"[UsageMonitor] Failed to perform auth-failure swap:",
				swapError,
			);
		}
	}

	/**
	 * Fetch usage - HYBRID APPROACH
	 * Tries API first, falls back to CLI if API fails
	 *
	 * Enhanced to support multiple providers (Anthropic, OpenAI, Ollama)
	 * Detects provider from active profile's baseUrl and routes to appropriate endpoint
	 *
	 * @param profileId - Profile identifier
	 * @param credential - OAuth token or API key
	 * @param activeProfile - Optional active profile info to avoid race conditions
	 * @param providerName - Optional provider name for endpoint detection
	 * @param suppressErrors - If true, suppresses error logging (used during startup)
	 */
	private async fetchUsage(
		profileId: string,
		credential?: string,
		activeProfile?: ActiveProfileResult,
		providerName?: string,
		suppressErrors?: boolean,
	): Promise<UsageSnapshot | null> {
		this.debugLog("[UsageMonitor:fetchUsage] Called with:", {
			profileId,
			hasCredential: !!credential,
			hasActiveProfile: !!activeProfile,
			providerName,
		});

		// Get profile name and email - prefer activeProfile since it's already determined
		// This fixes the bug where API profile names were incorrectly shown for OAuth profiles
		let profileName: string | undefined;
		let profileEmail: string | undefined;

		// Special handling for Windsurf provider — route to getUsageForProvider()
		// which has the full Codeium API integration (GetTeamCreditBalance, GetUser, etc.)
		if (providerName === "windsurf") {
			this.debugLog(
				'[UsageMonitor:fetchUsage] Windsurf provider detected — routing to getUsageForProvider("windsurf")',
			);
			return await this.getUsageForProvider("windsurf");
		}

		// Special handling for CLI-based providers like Copilot
		if (providerName === "copilot") {
			this.debugLog(
				"[UsageMonitor:Copilot] ENTERING Copilot branch - providerName is copilot",
			);

			// Get profile name and email from activeProfile for Copilot
			if (activeProfile?.profileName) {
				profileName = activeProfile.profileName;
				profileEmail = activeProfile.profileEmail;
				this.debugLog("[UsageMonitor:Copilot] Using activeProfile data:", {
					profileName,
					profileEmail,
				});
			}

			this.debugLog(
				"[UsageMonitor:Copilot] Using FastAPI backend for Copilot usage",
			);

			try {
				// Call our FastAPI backend endpoint
				const backendUrl = "http://localhost:9000/providers/usage/copilot";
				const response = await fetch(backendUrl, {
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
					signal: AbortSignal.timeout(10000), // 10 second timeout
				});

				if (!response.ok) {
					this.debugLog("[UsageMonitor:Copilot] Backend returned error:", {
						status: response.status,
						statusText: response.statusText,
					});
					return null;
				}

				const usageData = await response.json();
				this.debugLog(
					"[UsageMonitor:Copilot] Backend response received:",
					usageData,
				);

				// Normalize the backend response to match UsageSnapshot format
				const result = this.normalizeCopilotResponse(
					usageData,
					profileId,
					profileName || "GitHub Copilot",
					profileEmail,
				);
				this.debugLog(
					"[UsageMonitor:Copilot] Returning result from normalizeCopilotResponse:",
					{
						hasProviderName: !!result.providerName,
						providerName: result.providerName,
						// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
						hasError: !!(result as any).error,
						// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
						error: (result as any).error,
					},
				);
				return result;
			} catch (error) {
				this.debugLog(
					"[UsageMonitor:Copilot] Failed to fetch from backend:",
					error,
				);

				// Check if it's a timeout or connection error
				if (error instanceof Error) {
					if (error.name === "AbortError") {
						this.debugLog("[UsageMonitor:Copilot] Request timeout");
					} else if (error.message.includes("ECONNREFUSED")) {
						this.debugLog(
							"[UsageMonitor:Copilot] Backend not running - starting placeholder response",
						);
						// Backend not running, return placeholder
						return this.normalizeCopilotResponse(
							{
								error: "BACKEND_UNAVAILABLE",
								message: "Backend FastAPI non démarré",
								provider: "copilot",
								available: false,
							},
							profileId,
							profileName || "GitHub Copilot",
							profileEmail,
						);
					}
				}

				return null;
			}
		}

		// Only search API profiles if not already set from activeProfile
		if (!profileName) {
			try {
				const profilesFile = await loadProfilesFile();
				const apiProfile = profilesFile.profiles.find((p) => {
					const detected = detectProvider(p.baseUrl);
					return detected === providerName;
				});
				if (apiProfile) {
					profileName = apiProfile.name;
					this.debugLog("[UsageMonitor:FETCH] Found API profile:", {
						profileId,
						profileName,
						baseUrl: apiProfile.baseUrl,
					});
				}
			} catch (error) {
				// Failed to load API profiles, continue to OAuth check
				this.debugLog(
					"[UsageMonitor:FETCH] Failed to load API profiles:",
					error,
				);
			}
		}

		// If not found in API profiles, check OAuth profiles
		if (!profileName) {
			const profileManager = getClaudeProfileManager();
			const oauthProfile = profileManager.getProfile(profileId);
			if (oauthProfile) {
				profileName = oauthProfile.name;
				// Get email from OAuth profile if not already set
				if (!profileEmail) {
					profileEmail = oauthProfile.email;
				}
				this.debugLog("[UsageMonitor:FETCH] Found OAuth profile:", {
					profileId,
					profileName,
					profileEmail,
				});
			}
		}

		// If still not found, return null
		if (!profileName) {
			this.debugLog(
				"[UsageMonitor:FETCH] Profile not found in either API or OAuth profiles: " +
					profileId,
			);
			return null;
		}

		// Special case: For anthropic OAuth profiles, if we don't have credential,
		// try CLI directly since OAuth API might fail
		if (providerName === "anthropic" && !credential) {
			this.debugLog(
				"[UsageMonitor:FETCH] Anthropic OAuth profile without credential, trying CLI directly",
			);
			return await this.fetchUsageViaCLI(profileId, profileName);
		}

		this.debugLog("[UsageMonitor:FETCH] Starting usage fetch:", {
			profileId,
			profileName,
			hasCredential: !!credential,
			useApiMethod: this.shouldUseApiMethod(profileId),
		});

		// Attempt 1: Direct API call (preferred)
		// Per-profile tracking: if API fails for one profile, it only affects that profile
		// Skip for anthropic API key profiles — the OAuth usage endpoint (/api/oauth/usage)
		// requires an OAuth Bearer token, not a plain API key (always returns 401)
		const isAnthropicApiKey =
			activeProfile?.isAPIProfile && providerName === "anthropic";
		if (
			this.shouldUseApiMethod(profileId) &&
			credential &&
			!isAnthropicApiKey
		) {
			this.debugLog("[UsageMonitor:FETCH] Attempting API fetch method");
			const apiUsage = await this.fetchUsageViaAPI(
				credential,
				profileId,
				profileName,
				profileEmail,
				activeProfile,
				suppressErrors,
			);
			if (apiUsage) {
				this.debugLog("[UsageMonitor] Successfully fetched via API");
				this.debugLog("[UsageMonitor:FETCH] API fetch successful:", {
					sessionPercent: apiUsage.sessionPercent,
					weeklyPercent: apiUsage.weeklyPercent,
				});
				return apiUsage;
			}

			// API failed - record timestamp for cooldown-based retry
			this.debugLog(
				"[UsageMonitor] API method failed, recording failure timestamp for cooldown retry",
			);
			this.debugLog(
				"[UsageMonitor:FETCH] API fetch failed, will retry after cooldown",
			);
			this.apiFailureTimestamps.set(profileId, Date.now());
		} else if (!credential) {
			this.debugLog(
				"[UsageMonitor:FETCH] No credential available, skipping API method",
			);
		} else if (isAnthropicApiKey) {
			this.debugLog(
				"[UsageMonitor:FETCH] Skipping API fetch for anthropic API key profile — OAuth endpoint requires OAuth token",
			);
		} else {
			// API method skipped due to rate limit backoff — return cached result if available
			// This prevents falling through to CLI fallback which may not work reliably
			const cachedResult = this.apiResultCache.get(profileId);
			if (cachedResult) {
				this.debugLog(
					`[UsageMonitor:FETCH] API skipped (backoff), returning cached result (age: ${Math.round((Date.now() - cachedResult.fetchedAt) / 1000)}s)`,
				);
				return cachedResult.snapshot;
			}
			// Also check currentUsage as a last resort before CLI
			if (this.currentUsage && this.currentUsageProfileId === profileId) {
				this.debugLog(
					"[UsageMonitor:FETCH] API skipped (backoff), returning currentUsage as fallback",
				);
				return this.currentUsage;
			}
		}

		// Attempt 2: CLI /usage command (fallback)
		this.debugLog("[UsageMonitor:FETCH] Attempting CLI fallback method");
		return await this.fetchUsageViaCLI(profileId, profileName);
	}

	/**
	 * Fetch usage via provider-specific API endpoints
	 *
	 * Supports multiple providers with automatic detection:
	 * - Anthropic OAuth: https://api.anthropic.com/api/oauth/usage
	 * - OpenAI: https://api.openai.com/v1/usage
	 *
	 * Detects provider from active profile's baseUrl and routes to appropriate endpoint.
	 * Normalizes all provider responses to common UsageSnapshot format.
	 *
	 * @param credential - OAuth token or API key
	 * @param profileId - Profile identifier
	 * @param profileName - Profile display name
	 * @param profileEmail - Optional email associated with the profile
	 * @param activeProfile - Optional pre-determined active profile info to avoid race conditions
	 * @param suppressErrors - If true, suppresses error logging (used during startup)
	 * @returns Normalized usage snapshot or null on failure
	 */
	private async fetchUsageViaAPI(
		credential: string,
		profileId: string,
		profileName: string,
		profileEmail?: string,
		activeProfile?: ActiveProfileResult,
		suppressErrors?: boolean,
	): Promise<UsageSnapshot | null> {
		// ── Short-lived result cache ────────────────────────────────────────
		// Multiple code paths (getUsageForProvider, checkUsageAndSwap, polling)
		// can call this method nearly simultaneously at startup.  The Anthropic
		// usage API aggressively rate-limits (429) concurrent requests.
		// Return a recently fetched result instead of hitting the API again.
		const cacheKey = profileId;
		const cached = this.apiResultCache.get(cacheKey);

		if (
			cached &&
			Date.now() - cached.fetchedAt < UsageMonitor.API_RESULT_CACHE_TTL_MS
		) {
			this.debugLog(
				"[UsageMonitor:API_FETCH] Returning cached result for " +
					profileId +
					" (age: " +
					Math.round((Date.now() - cached.fetchedAt) / 1000) +
					"s)",
			);
			return cached.snapshot;
		}

		this.debugLog("[UsageMonitor:API_FETCH] Starting API fetch for usage:", {
			profileId,
			profileName,
			hasCredential: !!credential,
			hasActiveProfile: !!activeProfile,
		});

		try {
			// Step 1: Determine if we're using an API profile or OAuth profile
			// Use passed activeProfile if available, otherwise detect to maintain backward compatibility
			let apiProfile: APIProfile | undefined;
			let baseUrl: string;
			let provider: ApiProvider;

			if (activeProfile?.isAPIProfile) {
				// Use the pre-determined profile to avoid race conditions
				// Trust the activeProfile data and use baseUrl directly
				baseUrl = activeProfile.baseUrl;
				provider = detectProvider(baseUrl);
			} else if (activeProfile && !activeProfile.isAPIProfile) {
				// OAuth profile - always Anthropic
				provider = "anthropic";
				baseUrl = "https://api.anthropic.com";
			} else {
				// No activeProfile passed - need to detect from profiles file
				const profilesFile = await loadProfilesFile();
				apiProfile = profilesFile.profiles.find((p) => p.id === profileId);

				if (apiProfile?.apiKey) {
					// API profile found
					baseUrl = apiProfile.baseUrl;
					provider = detectProvider(baseUrl);
				} else {
					// OAuth profile fallback
					provider = "anthropic";
					baseUrl = "https://api.anthropic.com";
				}
			}

			const isAPIProfile = !!apiProfile;
			this.debugLog("[UsageMonitor:TRACE] Fetching usage", {
				provider,
				baseUrl,
				isAPIProfile,
				profileId,
			});

			// ── Cache check with provider-specific TTL ───────────────────────────────
			// For Windsurf, use 5s cache since data comes from local SQLite DB (fast read)
			// For other providers, use standard 15s cache to avoid API rate limits
			if (cached) {
				const cacheTTL =
					provider === "windsurf" ? 5000 : UsageMonitor.API_RESULT_CACHE_TTL_MS; // 5s for Windsurf (local DB read), 15s for others
				if (Date.now() - cached.fetchedAt < cacheTTL) {
					this.debugLog(
						"[UsageMonitor:API_FETCH] Returning cached result for " +
							profileId +
							" (age: " +
							Math.round((Date.now() - cached.fetchedAt) / 1000) +
							"s, provider: " +
							provider +
							")",
					);
					return cached.snapshot;
				}
			}

			// Step 3: Handle API providers via our FastAPI backend (OpenAI, Copilot)
			if (provider === "openai" || provider === "copilot") {
				this.debugLog(
					`[UsageMonitor:${provider}] Using FastAPI backend for ${provider} usage`,
				);

				try {
					// Call our FastAPI backend endpoint
					const backendUrl = `http://localhost:9000/providers/usage/${provider}`;
					const response = await this.fetchBackendWithRetry(
						backendUrl,
						{
							method: "GET",
							headers: {
								"Content-Type": "application/json",
							},
							signal: AbortSignal.timeout(10000), // 10 second timeout
						},
						provider,
					);

					if (!response.ok) {
						this.debugLog(
							`[UsageMonitor:${provider}] Backend returned error:`,
							{
								status: response.status,
								statusText: response.statusText,
							},
						);
						return null;
					}

					const usageData = await response.json();
					this.debugLog(
						`[UsageMonitor:${provider}] Backend response received:`,
						usageData,
					);

					// Normalize the backend response to match UsageSnapshot format
					if (provider === "openai") {
						return this.normalizeOpenAIResponse(
							usageData,
							profileId,
							profileName,
							profileEmail,
						);
					} else {
						return this.normalizeCopilotResponse(
							usageData,
							profileId,
							profileName,
							profileEmail,
						);
					}
				} catch (error) {
					this.debugLog(
						`[UsageMonitor:${provider}] Failed to fetch from backend:`,
						error,
					);

					// Check if it's a timeout or connection error
					if (error instanceof Error) {
						if (error.name === "AbortError") {
							this.debugLog(`[UsageMonitor:${provider}] Request timeout`);
						} else if (error.message.includes("ECONNREFUSED")) {
							this.debugLog(
								`[UsageMonitor:${provider}] Backend not running - starting placeholder response`,
							);
							// Backend not running, return placeholder
							const placeholderData = {
								error: "BACKEND_UNAVAILABLE",
								message: `Backend FastAPI non démarré`,
								provider: provider,
								available: false,
							};
							if (provider === "openai") {
								return this.normalizeOpenAIResponse(
									placeholderData,
									profileId,
									profileName,
									profileEmail,
								);
							} else {
								return this.normalizeCopilotResponse(
									placeholderData,
									profileId,
									profileName,
									profileEmail,
								);
							}
						}
					}

					return null;
				}
			}

			// Step 4: Get provider-specific usage endpoint for API-based providers
			const usageEndpoint = getUsageEndpoint(provider, baseUrl);
			if (!usageEndpoint) {
				this.debugLog(
					"[UsageMonitor] Unknown provider - no usage endpoint configured:",
					{
						provider,
						baseUrl,
						profileId,
					},
				);
				return null;
			}

			this.debugLog("[UsageMonitor:API_FETCH] API request:", {
				endpoint: usageEndpoint,
				profileId,
				credentialFingerprint: getCredentialFingerprint(credential),
			});

			this.debugLog("[UsageMonitor:API_FETCH] Fetching from endpoint:", {
				provider,
				endpoint: usageEndpoint,
				hasCredential: !!credential,
			});

			// Step 6: Validate endpoint domain before making request (API providers only)
			// Security: Only allow requests to known provider domains
			let endpointHostname: string;
			try {
				const endpointUrl = new URL(usageEndpoint);
				endpointHostname = endpointUrl.hostname;
			} catch {
				console.error(
					"[UsageMonitor] Invalid usage endpoint URL:",
					usageEndpoint,
				);
				return null;
			}

			if (!ALLOWED_USAGE_API_DOMAINS.has(endpointHostname)) {
				console.error(
					"[UsageMonitor] Blocked request to unauthorized domain:",
					endpointHostname,
					{
						allowedDomains: Array.from(ALLOWED_USAGE_API_DOMAINS),
					},
				);
				return null;
			}

			// Step 7: Fetch usage from provider endpoint
			// All providers use Bearer token authentication (RFC 6750)
			const authHeader = `Bearer ${credential}`;

			// Step 8: Build headers based on provider
			// Anthropic OAuth requires the 'anthropic-beta: oauth-2025-04-20' header
			// and a claude-code User-Agent to access the /api/oauth/usage endpoint.
			// See: https://codelynx.dev/posts/claude-code-usage-limits-statusline
			const headers: Record<string, string> = {
				Authorization: authHeader,
				"Content-Type": "application/json",
			};

			if (provider === "anthropic") {
				// OAuth authentication requires the beta header and claude-code User-Agent
				headers["anthropic-beta"] = "oauth-2025-04-20";
				headers["anthropic-version"] = "2023-06-01";
				headers["User-Agent"] = "claude-code/1.0.0";
			}
			// OpenAI uses standard Authorization header - no special headers needed for usage endpoint

			const response = await fetch(usageEndpoint, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(15000),
			});

			if (!response.ok) {
				this.debugLog(
					"[UsageMonitor:fetchUsageViaAPI] API error: " +
						response.status +
						" " +
						response.statusText +
						" for " +
						usageEndpoint,
				);
				// Handle 429 rate limiting with exponential backoff — suppress log spam
				if (response.status === 429) {
					const backoffState = this.rateLimitBackoff.get(profileId) || {
						lastHit: 0,
						consecutiveHits: 0,
					};
					backoffState.consecutiveHits += 1;
					backoffState.lastHit = Date.now();
					this.rateLimitBackoff.set(profileId, backoffState);

					const cooldown = Math.min(
						UsageMonitor.RATE_LIMIT_BASE_COOLDOWN_MS *
							2 ** (backoffState.consecutiveHits - 1),
						UsageMonitor.RATE_LIMIT_MAX_COOLDOWN_MS,
					);
					// Always use debugLog for 429 — this is expected rate limiting, not an error worth spamming
					this.debugLog(
						`[UsageMonitor] Rate limited (429) for ${profileId} — backing off ${Math.round(cooldown / 1000)}s (attempt #${backoffState.consecutiveHits})`,
					);
					this.apiFailureTimestamps.set(profileId, Date.now());

					// Return last cached result if available — prevents showing 0% during backoff
					const cached429 = this.apiResultCache.get(cacheKey);
					if (cached429) {
						this.debugLog(
							`[UsageMonitor] Returning stale cached result during 429 backoff for ${profileId} (age: ${Math.round((Date.now() - cached429.fetchedAt) / 1000)}s)`,
						);
						return cached429.snapshot;
					}
					return null;
				}

				const logMethod = suppressErrors
					? this.debugLog.bind(this)
					: console.error;
				logMethod(
					"[UsageMonitor] API error:",
					response.status,
					response.statusText,
					{
						provider,
						endpoint: usageEndpoint,
					},
				);

				// Check for auth failures via status code (works for all providers)
				if (response.status === 401 || response.status === 403) {
					const error = new Error(
						`API Auth Failure: ${response.status} (${provider})`,
					);
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					(error as any).statusCode = response.status;
					throw error;
				}

				// For other error statuses, try to parse response body to detect auth failures
				// This handles cases where providers might return different status codes for auth errors
				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				let errorData: any;
				try {
					errorData = await response.json();
				} catch (parseError) {
					// If we can't parse the error response, just log it and continue
					this.debugLog(
						"[UsageMonitor:AUTH_DETECTION] Could not parse error response body:",
						{
							provider,
							status: response.status,
							parseError,
						},
					);
					// Record failure timestamp for cooldown retry
					this.apiFailureTimestamps.set(profileId, Date.now());
					return null;
				}

				this.debugLog(
					"[UsageMonitor:AUTH_DETECTION] Checking error response for auth failure:",
					{
						provider,
						status: response.status,
						errorData,
					},
				);

				// Check for common auth error patterns in response body
				const authErrorPatterns = [
					"unauthorized",
					"authentication",
					"invalid token",
					"invalid api key",
					"expired token",
					"forbidden",
					"access denied",
					"credentials",
					"auth failed",
				];

				const errorText = JSON.stringify(errorData).toLowerCase();
				const hasAuthError = authErrorPatterns.some((pattern) =>
					errorText.includes(pattern),
				);

				if (hasAuthError) {
					const error = new Error(
						`API Auth Failure detected in response body (${provider}): ${JSON.stringify(errorData)}`,
					);
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					(error as any).statusCode = response.status; // Include original status code
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					(error as any).detectedInBody = true;
					throw error;
				}

				// Record failure timestamp for cooldown retry (non-auth error)
				this.apiFailureTimestamps.set(profileId, Date.now());
				return null;
			}

			// Success — clear rate limit backoff state for this profile
			this.rateLimitBackoff.delete(profileId);

			this.debugLog(
				"[UsageMonitor:API_FETCH] API response received successfully:",
				{
					provider,
					status: response.status,
					contentType: response.headers.get("content-type"),
				},
			);

			// Step 5: Parse and normalize response based on provider
			const rawData = await response.json();

			this.debugLog(
				`[UsageMonitor:PROVIDER] Raw response from ${provider}:`,
				JSON.stringify(rawData, null, 2),
			);

			// Step 6: Normalize response based on provider type
			let normalizedUsage: UsageSnapshot | null = null;

			this.debugLog(
				"[UsageMonitor:NORMALIZATION] Selecting normalization method:",
				{
					provider,
					method: `normalize${provider.charAt(0).toUpperCase() + provider.slice(1)}Response`,
				},
			);

			switch (provider as ApiProvider) {
				case "anthropic":
					normalizedUsage = this.normalizeAnthropicResponse(
						rawData,
						profileId,
						profileName,
						profileEmail,
					);
					break;
				case "copilot":
					normalizedUsage = this.normalizeCopilotResponse(
						rawData,
						profileId,
						profileName,
						profileEmail,
					);
					break;
				case "windsurf":
					normalizedUsage = this.normalizeWindsurfResponse(
						rawData,
						profileId,
						profileName,
						profileEmail,
					);
					break;
				case "openai":
				case "ollama":
				case "ollama_local":
				case "unknown":
					this.debugLog(
						"[UsageMonitor] Unsupported provider for usage normalization: " +
							provider,
					);
					return null;
			}

			if (!normalizedUsage) {
				this.debugLog(
					`[UsageMonitor] Failed to normalize response from ${provider}`,
				);
				// Record failure timestamp for cooldown retry (normalization failure)
				this.apiFailureTimestamps.set(profileId, Date.now());
				return null;
			}

			// For Anthropic Pro accounts on tier "default_claude_ai",
			// the /api/oauth/usage endpoint returns seven_day: null and
			// the Messages API headers don't include 7d utilization.
			// Mark weeklyPercent as -1 so the UI can show "N/A" instead of "0%".

			// Populate providerName so the renderer can filter snapshots by provider
			normalizedUsage.providerName = provider;

			this.debugLog("[UsageMonitor:API_FETCH] Fetch completed - usage:", {
				profileId,
				profileName,
				email: normalizedUsage.profileEmail,
				provider,
				sessionPercent: normalizedUsage.sessionPercent,
				weeklyPercent: normalizedUsage.weeklyPercent,
				limitType: normalizedUsage.limitType,
			});
			this.debugLog(
				"[UsageMonitor:API_FETCH] API fetch completed successfully",
			);

			// Cache the successful result so concurrent/near-concurrent calls
			// (e.g. checkUsageAndSwap + getUsageForProvider at startup) reuse
			// it instead of hitting the API again and getting 429.
			this.apiResultCache.set(cacheKey, {
				snapshot: normalizedUsage,
				fetchedAt: Date.now(),
			});

			return normalizedUsage;
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (error: any) {
			// Re-throw auth failures to be handled by checkUsageAndSwap
			// This includes both status code auth failures (401/403) and body-detected failures
			if (
				error?.message?.includes("Auth Failure") ||
				error?.statusCode === 401 ||
				error?.statusCode === 403
			) {
				throw error;
			}

			console.error("[UsageMonitor] API fetch failed:", error);
			// Record failure timestamp for cooldown retry (network/other errors)
			this.apiFailureTimestamps.set(profileId, Date.now());
			return null;
		}
	}

	/**
	 * Normalize Anthropic API response to UsageSnapshot
	 *
	 * Anthropic OAuth usage API response formats:
	 *
	 * Max plan — single global seven_day bucket:
	 * {
	 *   "five_hour": { "utilization": 19, "resets_at": "..." },
	 *   "seven_day": { "utilization": 45, "resets_at": "..." }
	 * }
	 *
	 * Pro plan — seven_day is null, quota split per model/feature:
	 * {
	 *   "five_hour": { "utilization": 59, "resets_at": "..." },
	 *   "seven_day": null,
	 *   "seven_day_opus": null,
	 *   "seven_day_sonnet": null,
	 *   "seven_day_omelette": { "utilization": 0, "resets_at": null },
	 *   ...
	 * }
	 * For Pro, we use the max utilization across all seven_day* buckets.
	 */
	private normalizeAnthropicResponse(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		data: any,
		profileId: string,
		profileName: string,
		profileEmail?: string,
	): UsageSnapshot {
		// Support both new nested format and legacy flat format for backward compatibility
		//
		// NEW format (current API): { five_hour: { utilization: 72, resets_at: "..." } }
		// OLD format (legacy):      { five_hour_utilization: 0.72, five_hour_reset_at: "..." }

		let fiveHourUtil: number;
		let sevenDayUtil: number;
		let sessionResetTimestamp: string | undefined;
		let weeklyResetTimestamp: string | undefined;

		// Check for new nested format first
		if (data.five_hour !== undefined || data.seven_day !== undefined) {
			// New nested format - utilization is already 0-100 integer
			fiveHourUtil = data.five_hour?.utilization ?? 0;
			sessionResetTimestamp = data.five_hour?.resets_at;

			// seven_day is null for Pro accounts on "default_claude_ai" tier.
			// Try the global bucket first, then scan per-model buckets
			// (seven_day_opus, seven_day_sonnet, …). A bucket counts as
			// "active" only if it has a resets_at timestamp — a bucket with
			// utilization: 0 and resets_at: null means no quota is tracked.
			// Use -1 to signal "unavailable" so the UI shows N/A.
			if (data.seven_day?.utilization != null) {
				sevenDayUtil = data.seven_day.utilization;
				weeklyResetTimestamp = data.seven_day.resets_at;
			} else {
				let maxUtil = -1;
				let maxResetAt: string | undefined;
				for (const key of Object.keys(data)) {
					if (key === "seven_day" || !key.startsWith("seven_day")) continue;
					const bucket = data[key];
					if (!bucket || typeof bucket.utilization !== "number") continue;
					// Only consider buckets with a reset timestamp (actively tracked)
					if (!bucket.resets_at) continue;
					if (bucket.utilization > maxUtil) {
						maxUtil = bucket.utilization;
						maxResetAt = bucket.resets_at;
					}
				}
				sevenDayUtil = maxUtil;
				weeklyResetTimestamp = maxResetAt;
			}
		} else {
			// Legacy flat format - utilization is 0-1 float, needs *100
			const rawFiveHour = data.five_hour_utilization ?? 0;
			const rawSevenDay = data.seven_day_utilization ?? 0;
			// Convert 0-1 float to 0-100 integer
			fiveHourUtil = Math.round(rawFiveHour * 100);
			sevenDayUtil = Math.round(rawSevenDay * 100);
			sessionResetTimestamp = data.five_hour_reset_at;
			weeklyResetTimestamp = data.seven_day_reset_at;
		}

		return {
			sessionPercent: fiveHourUtil,
			weeklyPercent: sevenDayUtil,
			// Omit sessionResetTime/weeklyResetTime - renderer uses timestamps with formatTimeRemaining
			sessionResetTime: undefined,
			weeklyResetTime: undefined,
			sessionResetTimestamp,
			weeklyResetTimestamp,
			profileId,
			profileName,
			profileEmail,
			fetchedAt: new Date(),
			limitType: sevenDayUtil > fiveHourUtil ? "weekly" : "session",
			usageWindows: {
				sessionWindowLabel: "common:usage.window5Hour",
				weeklyWindowLabel: "common:usage.window7Day",
			},
		};
	}

	/**
	 * Normalize Windsurf/Codeium GetTeamCreditBalance response to UsageSnapshot
	 *
	 * Windsurf API returns:
	 * - promptCreditsPerSeat: credits allocated per seat
	 * - numSeats: total team seats
	 * - addOnCreditsAvailable: remaining add-on credits
	 * - addOnCreditsUsed: consumed add-on credits
	 * - billingCycleStart: ISO 8601 billing cycle start
	 * - billingCycleEnd: ISO 8601 billing cycle end
	 *
	 * We convert this to percentage-based usage:
	 * - sessionPercent: % of total credits used (seat credits + add-on used / total available)
	 * - weeklyPercent: % of billing cycle elapsed (time-based progress)
	 */
	private normalizeWindsurfResponse(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		data: any,
		profileId: string,
		profileName: string,
		profileEmail?: string,
	): UsageSnapshot {
		// Try to use messages if available (matching cache local calculation)
		const totalMessages = data.totalMessages ?? 0;
		const usedMessages = data.usedMessages ?? 0;

		const promptCreditsPerSeat = data.promptCreditsPerSeat ?? 0;
		const numSeats = data.numSeats ?? 1;
		const addOnCreditsAvailable = data.addOnCreditsAvailable ?? 0;
		const addOnCreditsUsed = data.addOnCreditsUsed ?? 0;

		const seatCreditsTotal = promptCreditsPerSeat * numSeats;
		const totalCredits =
			seatCreditsTotal + addOnCreditsAvailable + addOnCreditsUsed;
		const usedCredits = addOnCreditsUsed;

		let sessionPercent = 0;
		let displayTotal = 0;
		let displayUsed = 0;

		if (totalMessages > 0) {
			// Use messages (primary metric - matches Windsurf IDE display)
			sessionPercent = Math.round((usedMessages / totalMessages) * 100);
			displayTotal = totalMessages;
			displayUsed = usedMessages;
		} else {
			// Fallback to credits if messages not available
			if (totalCredits > 0) {
				sessionPercent = Math.round((usedCredits / totalCredits) * 100);
			}
			displayTotal = totalCredits;
			displayUsed = usedCredits;
		}

		// Billing cycle progress as "weekly" percentage
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

		return {
			profileId,
			profileName,
			profileEmail,
			sessionPercent,
			weeklyPercent,
			sessionResetTimestamp: data.billingCycleEnd
				? new Date(data.billingCycleEnd).toISOString()
				: undefined,
			weeklyResetTimestamp: data.billingCycleEnd
				? new Date(data.billingCycleEnd).toISOString()
				: undefined,
			fetchedAt: new Date(),
			limitType: weeklyPercent > sessionPercent ? "weekly" : "session",
			// Show "used / total" messages/credits below the session progress bar
			sessionUsageValue: displayUsed,
			sessionUsageLimit: displayTotal,
			usageWindows: {
				sessionWindowLabel: "common:usage.windowDailyQuota", // "Daily quota"
				weeklyWindowLabel: "common:usage.windowWeeklyQuota", // "Weekly quota"
			},
			windsurfCredits: {
				totalCredits: displayTotal,
				usedCredits: displayUsed,
				remainingCredits: displayTotal - displayUsed,
				seatCreditsTotal,
				addOnCreditsAvailable,
				addOnCreditsUsed,
				numSeats,
				billingCycleStart: data.billingCycleStart,
				billingCycleEnd: data.billingCycleEnd,
			},
		};
	}

	/**
	 * Normalize Windsurf cached plan info (from local IDE database) to UsageSnapshot
	 *
	 * The Windsurf IDE caches plan info in its local SQLite database with detailed
	 * usage data: messages (prompts) used/remaining and flow actions used/remaining.
	 *
	 * We map:
	 *   - sessionPercent → % of messages (prompts) used
	 *   - weeklyPercent  → % of billing cycle elapsed (time-based)
	 */
	private normalizeWindsurfCachedPlanInfo(
		planInfo: import("../services/credential-manager").WindsurfCachedPlanInfo,
		profileId: string,
		profileName: string,
	): UsageSnapshot {
		const { usage, startTimestamp, endTimestamp } = planInfo;

		// Windsurf/Codeium stores message counts in hundredths (fixed-point × 100).
		// E.g. a 500-message plan stores messages=50000, usedMessages=33600 → 336 messages used.
		// Detect this by checking if the total is a clean multiple of 100 (e.g. 50000, 100000).
		// If so, scale down for human-readable display values.
		const scale = usage.messages >= 1000 && usage.messages % 100 === 0 ? 100 : 1;
		const displayTotal = Math.round(usage.messages / scale);
		const displayUsed = Math.round(usage.usedMessages / scale);
		const displayRemaining = Math.max(0, displayTotal - displayUsed);

		// Since March 2026, Windsurf uses a quota-based system with daily and weekly allowances
		// instead of the old monthly credit-based system.
		// The cached data still uses the old monthly format, so we need to adapt.
		// For now, we'll show the monthly usage as the session percentage and calculate weekly based on time elapsed.

		// Messages (prompts) usage percentage (session = monthly in old system)
		let sessionPercent = 0;
		if (usage.messages > 0) {
			sessionPercent = Math.round((usage.usedMessages / usage.messages) * 100);
		}

		// Weekly usage percentage (estimated as monthly usage / 4)
		// Since the cached data is monthly but Windsurf now uses daily/weekly quotas,
		// we estimate weekly usage by dividing monthly usage by 4 weeks
		let weeklyPercent = 0;
		if (sessionPercent > 0) {
			weeklyPercent = Math.round(sessionPercent / 4);
		}

		return {
			sessionPercent,
			weeklyPercent,
			sessionResetTime: undefined,
			weeklyResetTime: undefined,
			sessionResetTimestamp: new Date(endTimestamp).toISOString(),
			weeklyResetTimestamp: new Date(endTimestamp).toISOString(),
			profileId,
			profileName,
			profileEmail: undefined,
			providerName: "windsurf",
			fetchedAt: new Date(),
			limitType: "session",
			// Show "used / total" messages below the session progress bar
			sessionUsageValue: displayUsed,
			sessionUsageLimit: displayTotal,
			usageWindows: {
				sessionWindowLabel: "common:usage.windowWeeklyQuota", // "Weekly quota (estimated from monthly)"
				weeklyWindowLabel: "common:usage.windowMonthlyQuota", // "Monthly quota" (old system)
			},
			windsurfCredits: {
				totalCredits: displayTotal,
				usedCredits: displayUsed,
				remainingCredits: displayRemaining,
				seatCreditsTotal: displayTotal,
				addOnCreditsAvailable: Math.round(usage.flowActions / scale),
				addOnCreditsUsed: Math.round(usage.usedFlowActions / scale),
				numSeats: 1,
				billingCycleStart: new Date(startTimestamp).toISOString(),
				billingCycleEnd: new Date(endTimestamp).toISOString(),
			},
		};
	}

	/**
	 * Normalize GitHub Copilot CLI response to UsageSnapshot
	 *
	 * GitHub Copilot doesn't have a public usage API, so we create a placeholder
	 * response that indicates the provider is available but usage data is not available.
	 *
	 * This allows the UI to show that Copilot is configured and working,
	 * even though we can't track token usage.
	 */
	private normalizeCopilotResponse(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		data: any,
		profileId: string,
		profileName: string,
		profileEmail?: string,
	): UsageSnapshot {
		this.debugLog("[UsageMonitor:Copilot] Normalizing Copilot response:", data);

		// Handle error responses from backend
		if (data.error) {
			this.debugLog(
				"[UsageMonitor:Copilot] Backend returned error:",
				data.error,
			);

			// Create a response that indicates the error but still shows the provider is configured
			return {
				sessionPercent: 0,
				weeklyPercent: 0,
				sessionResetTime: undefined,
				weeklyResetTime: undefined,
				sessionResetTimestamp: undefined,
				weeklyResetTimestamp: undefined,
				profileId,
				profileName,
				profileEmail,
				fetchedAt: new Date(),
				limitType: "session" as const,
				usageWindows: {
					sessionWindowLabel: "common:usage.window5Hour",
					weeklyWindowLabel: "common:usage.window7Day",
				},
				providerName: "copilot",
				// Put error information in copilotUsageDetails
				copilotUsageDetails: {
					lastUpdated: new Date().toISOString(),
					periodDays: 28,
					// Custom error properties (using existing fields creatively)
					totalTokens: 0,
					suggestionsCount: 0,
					acceptancesCount: 0,
					acceptanceRate: 0,
					estimatedCost: 0,
				},
				// Add error metadata as additional properties (will be ignored by TypeScript but accessible at runtime)
				...(data.error && { error: data.error }),
				...(data.message && { errorMessage: data.message }),
				...(data.permission_required && {
					permissionRequired: data.permission_required,
				}),
			} as UsageSnapshot & {
				error?: string;
				errorMessage?: string;
				permissionRequired?: string;
			};
		}

		// Handle successful response with usage data
		if (data.available && data.usage) {
			const usage = data.usage;
			const copilotDetails = data.copilotUsageDetails || {};

			// New branch: personal-quotas (Premium Requests from /copilot_internal/user)
			if (copilotDetails.scope === "personal-quotas") {
				const pctUsed =
					typeof copilotDetails.premiumRequestsPercentUsed === "number"
						? copilotDetails.premiumRequestsPercentUsed
						: 0;
				const sessionPct = copilotDetails.premiumRequestsUnlimited
					? 0
					: Math.min(Math.max(pctUsed, 0), 100);

				return {
					sessionPercent: sessionPct,
					weeklyPercent: sessionPct,
					sessionResetTime: copilotDetails.quotaResetDate,
					weeklyResetTime: copilotDetails.quotaResetDate,
					sessionResetTimestamp: copilotDetails.quotaResetDate,
					weeklyResetTimestamp: copilotDetails.quotaResetDate,
					profileId,
					profileName,
					profileEmail,
					fetchedAt: new Date(data.fetched_at || Date.now()),
					limitType: "session" as const,
					usageWindows: {
						sessionWindowLabel: "common:usage.window5Hour",
						weeklyWindowLabel: "common:usage.window7Day",
					},
					sessionUsageValue: copilotDetails.premiumRequestsUsed,
					sessionUsageLimit: copilotDetails.premiumRequestsEntitlement,
					providerName: "copilot",
					copilotUsageDetails: copilotDetails,
				} as UsageSnapshot;
			}

			// Legacy branch: aggregated metrics (admin enterprise/org)
			// Calculate percentages based on suggestions (assuming 1000 as a reasonable limit)
			const suggestions =
				usage.total_suggestions || copilotDetails.suggestions || 0;
			const sessionPercent = Math.min((suggestions / 1000) * 100, 100);
			const weeklyPercent = sessionPercent; // Use same for weekly since we don't have separate data

			this.debugLog(
				"[UsageMonitor:Copilot] Creating usage response with data:",
				{
					suggestions,
					acceptances: usage.total_acceptances || copilotDetails.acceptances,
					acceptanceRate:
						usage.acceptance_rate_percent || copilotDetails.acceptanceRate,
					sessionPercent,
					weeklyPercent,
				},
			);

			return {
				sessionPercent,
				weeklyPercent,
				sessionResetTime: undefined,
				weeklyResetTime: undefined,
				sessionResetTimestamp: undefined,
				weeklyResetTimestamp: undefined,
				profileId,
				profileName,
				profileEmail,
				fetchedAt: new Date(data.fetched_at || Date.now()),
				limitType: "session" as const,
				usageWindows: {
					sessionWindowLabel: "common:usage.window5Hour",
					weeklyWindowLabel: "common:usage.window7Day",
				},
				providerName: "copilot",
				// Include Copilot-specific data for UI
				copilotUsageDetails: {
					totalTokens: usage.total_tokens || 0,
					suggestionsCount: suggestions,
					acceptancesCount:
						usage.total_acceptances || copilotDetails.acceptances || 0,
					acceptanceRate:
						usage.acceptance_rate_percent || copilotDetails.acceptanceRate || 0,
					estimatedCost: 0, // GitHub Copilot doesn't provide cost data
					periodDays: 28,
					lastUpdated: data.fetched_at || new Date().toISOString(),
				},
				// Add additional metadata for extended usage details
				...(usage.total_lines_suggested !== undefined && {
					linesSuggested: usage.total_lines_suggested,
				}),
				...(usage.total_lines_accepted !== undefined && {
					linesAccepted: usage.total_lines_accepted,
				}),
				...(usage.line_acceptance_rate_percent !== undefined && {
					lineAcceptanceRate: usage.line_acceptance_rate_percent,
				}),
				...(usage.organization && { organization: usage.organization }),
				...(usage.level && { level: usage.level }),
			} as UsageSnapshot & {
				linesSuggested?: number;
				linesAccepted?: number;
				lineAcceptanceRate?: number;
				organization?: string;
				level?: string;
				available?: boolean;
			};
		}

		// Fallback: Create a placeholder response for when no specific data is available
		this.debugLog(
			"[UsageMonitor:Copilot] Creating placeholder response (no specific data)",
		);

		return {
			sessionPercent: 0,
			weeklyPercent: 0,
			sessionResetTime: undefined,
			weeklyResetTime: undefined,
			sessionResetTimestamp: undefined,
			weeklyResetTimestamp: undefined,
			profileId,
			profileName,
			profileEmail,
			fetchedAt: new Date(),
			limitType: "session" as const,
			usageWindows: {
				sessionWindowLabel: "common:usage.window5Hour",
				weeklyWindowLabel: "common:usage.window7Day",
			},
			providerName: "copilot",
			copilotUsageDetails: {
				lastUpdated: new Date().toISOString(),
				periodDays: 28,
				totalTokens: 0,
				suggestionsCount: 0,
				acceptancesCount: 0,
				acceptanceRate: 0,
				estimatedCost: 0,
			},
			errorMessage: "No usage data available",
		} as UsageSnapshot & { errorMessage?: string };
	}

	/**
	 * Normalize OpenAI usage response from FastAPI backend
	 *
	 * This allows the UI to show OpenAI usage status and handle errors gracefully.
	 */
	private normalizeOpenAIResponse(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		data: any,
		profileId: string,
		profileName: string,
		profileEmail?: string,
	): UsageSnapshot {
		this.debugLog("[UsageMonitor:OpenAI] Normalizing OpenAI response:", data);

		// Handle error responses from backend
		if (data.error) {
			this.debugLog(
				"[UsageMonitor:OpenAI] Backend returned error:",
				data.error,
			);

			// Create a response that indicates the error but still shows the provider is configured
			return {
				sessionPercent: 0,
				weeklyPercent: 0,
				sessionResetTime: undefined,
				weeklyResetTime: undefined,
				sessionResetTimestamp: undefined,
				weeklyResetTimestamp: undefined,
				profileId,
				profileName,
				profileEmail,
				fetchedAt: new Date(),
				limitType: "session" as const,
				usageWindows: {
					sessionWindowLabel: "common:usage.window5Hour",
					weeklyWindowLabel: "common:usage.window7Day",
				},
				providerName: "openai",
				// Put error information in openaiUsageDetails
				openaiUsageDetails: {
					lastUpdated: new Date().toISOString(),
					periodDays: 30,
					// Custom error properties (using existing fields creatively)
					totalTokens: 0,
					requestsCount: 0,
					estimatedCost: 0,
					currency: "USD",
				},
				// Add error metadata as additional properties (will be ignored by TypeScript but accessible at runtime)
				...(data.error && { error: data.error }),
				...(data.message && { errorMessage: data.message }),
				...(data.alternative && { alternative: data.alternative }),
			} as UsageSnapshot & {
				error?: string;
				errorMessage?: string;
				alternative?: string;
			};
		}

		// Handle successful response with usage data
		if (data.usage) {
			const usage = data.usage;

			// For OpenAI, we'll use token usage if available, otherwise default to 0
			// Since the /v1/usage endpoint is not accessible, we'll show a placeholder
			const totalTokens = usage.total_tokens || 0;
			const sessionPercent = Math.min((totalTokens / 100000) * 100, 100); // Assume 100k tokens as session limit
			const weeklyPercent = sessionPercent; // Use same for weekly since we don't have separate data

			this.debugLog(
				"[UsageMonitor:OpenAI] Creating usage response with data:",
				{
					totalTokens,
					sessionPercent,
					weeklyPercent,
				},
			);

			return {
				sessionPercent,
				weeklyPercent,
				sessionResetTime: undefined,
				weeklyResetTime: undefined,
				sessionResetTimestamp: undefined,
				weeklyResetTimestamp: undefined,
				profileId,
				profileName,
				profileEmail,
				fetchedAt: new Date(data.fetched_at || Date.now()),
				limitType: "session" as const,
				usageWindows: {
					sessionWindowLabel: "common:usage.window5Hour",
					weeklyWindowLabel: "common:usage.window7Day",
				},
				providerName: "openai",
				// Include OpenAI-specific data for UI
				openaiUsageDetails: {
					totalTokens: totalTokens,
					requestsCount: usage.requests || 0,
					estimatedCost: usage.estimated_cost || 0,
					currency: "USD",
					periodDays: 30,
					lastUpdated: data.fetched_at || new Date().toISOString(),
				},
				// Add additional metadata for extended usage details
				...(usage.models && { models: usage.models }),
				...(usage.organization_id && { organizationId: usage.organization_id }),
			};
		}

		// Fallback: return a basic response indicating OpenAI is configured
		return {
			sessionPercent: 0,
			weeklyPercent: 0,
			sessionResetTime: undefined,
			weeklyResetTime: undefined,
			sessionResetTimestamp: undefined,
			weeklyResetTimestamp: undefined,
			profileId,
			profileName,
			profileEmail,
			fetchedAt: new Date(),
			limitType: "session" as const,
			usageWindows: {
				sessionWindowLabel: "common:usage.window5Hour",
				weeklyWindowLabel: "common:usage.window7Day",
			},
			providerName: "openai",
			openaiUsageDetails: {
				completions: undefined,
				cost: undefined,
				embeddings: undefined,
				moderations: undefined,
			},
		};
	}

	/**
	 * Fetch usage via CLI /usage command (fallback)
	 * Note: This is a fallback method. The API method is preferred.
	 * CLI-based fetching would require spawning a Claude process and parsing output,
	 * which is complex. For now, we rely on the API method.
	 */
	private async fetchUsageViaCLI(
		profileId: string,
		profileName: string,
	): Promise<UsageSnapshot | null> {
		this.debugLog(
			"[UsageMonitor] CLI fallback - attempting to use claude usage command",
		);

		try {
			const { spawn } = await import("node:child_process");
			const { getSpawnCommand, getSpawnOptions } = await import(
				"../env-utils"
			);

			const result = await new Promise<{
				stdout: string;
				stderr: string;
				code: number | null;
			}>((resolve, reject) => {
				this.debugLog("[UsageMonitor:CLI] Spawning claude usage process");

				// Try different approaches to find claude executable
				const claudePath = "claude"; // Let system find it in PATH

				// Use helpers so shell:true is only set on Windows .cmd/.bat targets,
				// avoiding Node DEP0190 (shell:true with array args).
				const spawnCommand = getSpawnCommand(claudePath);
				const spawnOptions = getSpawnOptions(claudePath, {
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 15000,
				});
				const process = spawn(spawnCommand, ["usage"], spawnOptions);

				let stdout = "";
				let stderr = "";

				process.stdout?.on("data", (data) => {
					stdout += data.toString();
				});

				process.stderr?.on("data", (data) => {
					stderr += data.toString();
				});

				process.on("close", (code) => {
					this.debugLog("[UsageMonitor:CLI] Process closed with code:", code);
					resolve({ stdout, stderr, code });
				});

				process.on("error", (error) => {
					this.debugLog("[UsageMonitor:CLI] Process error:", error);
					reject(error);
				});
			});

			this.debugLog("[UsageMonitor:CLI] Process completed:", {
				code: result.code,
				stdoutLength: result.stdout.length,
				stderrLength: result.stderr.length,
				hasOutput: !!result.stdout,
			});

			// Check if the command succeeded
			if (result.code !== 0 && result.code !== null) {
				this.debugLog(
					"[UsageMonitor:CLI] Command failed with non-zero exit code:",
					{
						code: result.code,
						stderr: result.stderr,
					},
				);
				return null;
			}

			if (!result.stdout || result.stdout.trim().length === 0) {
				this.debugLog("[UsageMonitor:CLI] No stdout output received");
				return null;
			}

			this.debugLog(
				"[UsageMonitor:CLI] claude usage output received (first 200 chars):",
				result.stdout.substring(0, 200),
			);

			// Strip ANSI escape codes before parsing (CLI output may contain color/progress bar sequences)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are intentional
			const output = result.stdout.replaceAll(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

			// Use the dedicated usage parser that handles the actual "claude usage" output format:
			//   "Current session ████▌ 9% used Resets 11:59pm"
			//   "Current week (all models) 79% used Resets Nov 1, 10:59am"
			const parsed = parseUsageOutput(output);

			let sessionPercent = parsed.sessionUsagePercent;
			let weeklyPercent = parsed.weeklyUsagePercent;

			this.debugLog("[UsageMonitor:CLI] Parsed usage via parseUsageOutput:", {
				sessionPercent,
				weeklyPercent,
				sessionResetTime: parsed.sessionResetTime,
				weeklyResetTime: parsed.weeklyResetTime,
			});

			// Fallback: if parseUsageOutput found nothing, try generic percentage extraction
			if (sessionPercent === 0 && weeklyPercent === 0) {
				if (output.includes("You've hit your limit")) {
					sessionPercent = 100;
					this.debugLog(
						"[UsageMonitor:CLI] Detected session limit hit, setting session to 100%",
					);
				} else {
					const percentagePattern = /(\d+)%/g;
					// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from assignment
					let match;
					const allPercentages: string[] = [];

					// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
					while ((match = percentagePattern.exec(output)) !== null) {
						allPercentages.push(match[1]);
					}

					if (allPercentages.length >= 1) {
						sessionPercent = Number(allPercentages[0]);
						if (allPercentages.length >= 2) {
							weeklyPercent = Number(allPercentages[1]);
						}
						this.debugLog(
							"[UsageMonitor:CLI] Generic parsing found percentages:",
							{ sessionPercent, weeklyPercent },
						);
					}
				}
			}

			this.debugLog("[UsageMonitor:CLI] Final parsed usage from CLI:", {
				sessionPercent,
				weeklyPercent,
				outputLength: output.length,
			});

			return {
				sessionPercent,
				weeklyPercent,
				profileId,
				profileName,
				profileEmail: undefined, // CLI doesn't provide email in usage output
				fetchedAt: new Date(),
				limitType: weeklyPercent > sessionPercent ? "weekly" : "session",
				usageWindows: {
					sessionWindowLabel: "common:usage.window5Hour",
					weeklyWindowLabel: "common:usage.window7Day",
				},
			};
		} catch (error) {
			this.debugLog("[UsageMonitor:CLI] CLI fallback failed:", error);
			return null;
		}
	}

	/**
	 * Detect if we're about to create a swap loop (A→B→A or A→B→C→A).
	 * Only applies to proactive swaps — reactive swaps (actual 429) always proceed.
	 */
	private detectSwapLoop(currentProfileId: string): boolean {
		const recent = this.recentSwapChain.filter(
			(s) => Date.now() - s.at < UsageMonitor.SWAP_CHAIN_WINDOW_MS,
		);
		if (recent.length < 2) return false;

		// Check for A→B→A cycle: we just swapped TO this profile and now want to swap FROM it
		if (recent.at(-1)?.to === currentProfileId) {
			return true;
		}

		// Check for longer loops: same profile appears as "from" multiple times
		const fromProfiles = recent.map((s) => s.from);
		const uniqueFroms = new Set(fromProfiles);
		if (uniqueFroms.size < fromProfiles.length) {
			return true;
		}

		return false;
	}

	/**
	 * Perform proactive profile swap
	 * @param currentProfileId - The profile to switch from
	 * @param limitType - The type of limit that triggered the swap
	 * @param additionalExclusions - Additional profile IDs to exclude (e.g., auth-failed profiles)
	 */
	private async performProactiveSwap(
		currentProfileId: string,
		limitType: "session" | "weekly",
		additionalExclusions: string[] = [],
	): Promise<void> {
		const profileManager = getClaudeProfileManager();
		const excludeIds = new Set([currentProfileId, ...additionalExclusions]);

		// Get priority order for unified account system
		const priorityOrder = profileManager.getAccountPriorityOrder();

		// Build unified list of available accounts
		type UnifiedSwapTarget = {
			id: string;
			unifiedId: string; // oauth-{id} or api-{id}
			name: string;
			type: "oauth" | "api";
			priorityIndex: number;
		};

		const unifiedAccounts: UnifiedSwapTarget[] = [];

		// Add OAuth profiles (sorted by availability)
		const oauthProfiles = profileManager.getProfilesSortedByAvailability();
		for (const profile of oauthProfiles) {
			if (!excludeIds.has(profile.id)) {
				const unifiedId = `oauth-${profile.id}`;
				const priorityIndex = priorityOrder.indexOf(unifiedId);
				unifiedAccounts.push({
					id: profile.id,
					unifiedId,
					name: profile.name,
					type: "oauth",
					priorityIndex: priorityIndex === -1 ? Infinity : priorityIndex,
				});
			}
		}

		// Add API profiles (always considered available since they have unlimited usage)
		try {
			const profilesFile = await loadProfilesFile();
			for (const apiProfile of profilesFile.profiles) {
				if (!excludeIds.has(apiProfile.id) && apiProfile.apiKey) {
					const unifiedId = `api-${apiProfile.id}`;
					const priorityIndex = priorityOrder.indexOf(unifiedId);
					unifiedAccounts.push({
						id: apiProfile.id,
						unifiedId,
						name: apiProfile.name,
						type: "api",
						priorityIndex: priorityIndex === -1 ? Infinity : priorityIndex,
					});
				}
			}
		} catch (error) {
			this.debugLog(
				"[UsageMonitor] Failed to load API profiles for swap:",
				error,
			);
		}

		if (unifiedAccounts.length === 0) {
			this.debugLog(
				"[UsageMonitor] No alternative profile for proactive swap (excluded:",
				Array.from(excludeIds),
			);
			this.emit("proactive-swap-failed", {
				reason:
					additionalExclusions.length > 0
						? "all_alternatives_failed_auth"
						: "no_alternative",
				currentProfile: currentProfileId,
				excludedProfiles: Array.from(excludeIds),
			});
			return;
		}

		// Sort by priority order (lower index = higher priority)
		// If no priority order is set, OAuth profiles come first (they were already sorted by availability)
		unifiedAccounts.sort((a, b) => {
			// If both have priority indices, use them
			if (a.priorityIndex !== Infinity || b.priorityIndex !== Infinity) {
				return a.priorityIndex - b.priorityIndex;
			}
			// Otherwise, prefer OAuth profiles (which are sorted by availability)
			if (a.type !== b.type) {
				return a.type === "oauth" ? -1 : 1;
			}
			return 0;
		});

		// Use the best available from unified accounts
		// Try to acquire a lock to prevent race conditions with concurrent swaps
		const lock = getProfileSelectionLock();
		let bestAccount = unifiedAccounts[0];

		if (!lock.tryAcquire(bestAccount.id, "proactive-swap")) {
			// First choice is locked by another concurrent swap — try next available
			this.debugLog(
				"[UsageMonitor] Profile locked, trying next candidate:",
				bestAccount.id,
			);
			const fallback = unifiedAccounts.find((a) =>
				lock.tryAcquire(a.id, "proactive-swap"),
			);
			if (!fallback) {
				this.debugLog(
					"[UsageMonitor] All candidate profiles are locked, skipping proactive swap",
				);
				return;
			}
			bestAccount = fallback;
		}

		this.debugLog("[UsageMonitor] Proactive swap:", {
			from: currentProfileId,
			to: bestAccount.id,
			toType: bestAccount.type,
			reason: limitType,
		});

		// Clear cache for the profile that's becoming inactive
		// This ensures the next fetch gets fresh data instead of stale cached values
		this.clearProfileUsageCache(currentProfileId);

		// Switch to the new profile
		if (bestAccount.type === "oauth") {
			// Switch OAuth profile via profile manager
			profileManager.setActiveProfile(bestAccount.id);
		} else {
			// Switch API profile via profile-manager service
			try {
				const { setActiveAPIProfile } = await import(
					"../services/profile/profile-manager"
				);
				await setActiveAPIProfile(bestAccount.id);
			} catch (error) {
				console.error(
					"[UsageMonitor] Failed to set active API profile:",
					error,
				);
				lock.release(bestAccount.id);
				return;
			}
		}

		// Release the selection lock now that the swap is committed
		lock.release(bestAccount.id);

		// Record swap for cooldown and loop detection
		this.lastProactiveSwapAt = Date.now();
		this.recentSwapChain.push({
			from: currentProfileId,
			to: bestAccount.id,
			at: Date.now(),
		});
		// Prune old entries
		const swapCutoff = Date.now() - UsageMonitor.SWAP_CHAIN_WINDOW_MS;
		this.recentSwapChain = this.recentSwapChain
			.filter((s) => s.at >= swapCutoff)
			.slice(-UsageMonitor.MAX_SWAP_CHAIN_LENGTH);

		// Get the "from" profile name
		let fromProfileName: string | undefined;
		const fromOAuthProfile = profileManager.getProfile(currentProfileId);
		if (fromOAuthProfile) {
			fromProfileName = fromOAuthProfile.name;
		} else {
			// It might be an API profile
			try {
				const profilesFile = await loadProfilesFile();
				const fromAPIProfile = profilesFile.profiles.find(
					(p) => p.id === currentProfileId,
				);
				if (fromAPIProfile) {
					fromProfileName = fromAPIProfile.name;
				}
			} catch {
				// Ignore
			}
		}

		// Emit swap event
		this.emit("proactive-swap-completed", {
			fromProfile: { id: currentProfileId, name: fromProfileName },
			toProfile: { id: bestAccount.id, name: bestAccount.name },
			limitType,
			timestamp: new Date(),
		});

		// Notify UI
		this.emit("show-swap-notification", {
			fromProfile: fromProfileName,
			toProfile: bestAccount.name,
			reason: "proactive",
			limitType,
		});

		// PROACTIVE OPERATION RESTART: Stop and restart all running Claude SDK operations with new profile credentials
		// This includes autonomous tasks, PR reviews, insights, roadmap, etc.
		// Claude Agent SDK sessions maintain state independently of auth tokens, so no progress is lost
		const operationRegistry = getOperationRegistry();
		const operationSummary = operationRegistry.getSummary();
		const operationIdsOnOldProfile =
			operationSummary.byProfile[currentProfileId] || [];

		if (operationIdsOnOldProfile.length > 0) {
			// Restart all operations on the old profile with the new profile
			const restartedCount = await operationRegistry.restartOperationsOnProfile(
				currentProfileId,
				bestAccount.id,
				bestAccount.name,
			);

			// Emit event for tracking/logging
			this.emit("proactive-operations-restarted", {
				fromProfile: { id: currentProfileId, name: fromProfileName },
				toProfile: { id: bestAccount.id, name: bestAccount.name },
				operationIds: operationIdsOnOldProfile,
				restartedCount,
				limitType,
				timestamp: new Date(),
			});
		} else {
			// noop
		}

		// Note: Don't immediately check new profile - let normal interval handle it
		// This prevents cascading swaps if multiple profiles are near limits
	}

	/**
	 * Get usage for a given provider name (ex: 'anthropic', 'openai', 'ollama', ...)
	 *
	 * Searches both API profiles (profiles.json) and OAuth profiles (ClaudeProfileManager)
	 * to find a profile matching the requested provider, then fetches fresh usage data.
	 */
	async getUsageForProvider(
		providerName: string,
	): Promise<UsageSnapshot | null> {
		// ── Deduplication ──────────────────────────────────────────────────
		// Multiple useEffects in the renderer fire requestUsageUpdate() at
		// nearly the same time on startup (mount, OAuth check, polling setup,
		// providerChanged event…).  Without deduplication each call hits the
		// Anthropic usage API concurrently, causing 429 "Too Many Requests"
		// on ALL of them — and the UI shows "N/D" because every fetch fails.
		//
		// Fix: if a fetch for the same provider is already in-flight, piggy-
		// back on its promise instead of sending another HTTP request.
		const pending = this.pendingProviderFetch.get(providerName);
		if (pending) {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Reusing in-flight request for: " +
					providerName,
			);
			return pending;
		}

		const fetchPromise = this._getUsageForProviderImpl(providerName);
		this.pendingProviderFetch.set(providerName, fetchPromise);

		try {
			return await fetchPromise;
		} finally {
			this.pendingProviderFetch.delete(providerName);
		}
	}

	/**
	 * Internal implementation — always called through getUsageForProvider()
	 * which handles deduplication of concurrent requests.
	 */
	private async _getUsageForProviderImpl(
		providerName: string,
	): Promise<UsageSnapshot | null> {
		// Normalize provider aliases: 'claude' is an alias for 'anthropic'
		if (providerName === "claude") {
			providerName = "anthropic";
		}

		this.debugLog(
			"[UsageMonitor:getUsageForProvider] Fetching usage for provider: " +
				providerName,
		);

		// Ensure the ClaudeProfileManager is fully initialized before we look up
		// OAuth profiles.  On app startup the renderer fires USAGE_REQUEST before
		// initializeClaudeProfileManager() resolves, so the default (empty) profile
		// data would be used, causing the OAuth lookup to silently fail.
		// initializeClaudeProfileManager is idempotent and returns instantly when
		// already initialized, so this adds zero overhead on subsequent calls.
		try {
			await initializeClaudeProfileManager();
		} catch (e) {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] ClaudeProfileManager init failed: " +
					e,
			);
			// Continue anyway — getClaudeProfileManager() will return best-effort data
		}

		// Copilot special case — uses gh CLI, not a traditional API profile in profiles.json
		// Fetch directly from our FastAPI backend without requiring a matching profile
		if (providerName === "copilot") {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Copilot provider — fetching directly from backend",
			);
			try {
				const resp = await fetch(
					"http://localhost:9000/providers/usage/copilot",
					{
						signal: AbortSignal.timeout(5000),
					},
				);
				if (!resp.ok) {
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Copilot backend returned error:",
						{
							status: resp.status,
							statusText: resp.statusText,
						},
					);
					return this.normalizeCopilotResponse(
						{
							error: "BACKEND_ERROR",
							message: `Backend returned ${resp.status}: ${resp.statusText}`,
							provider: "copilot",
							available: false,
						},
						"copilot",
						"GitHub Copilot",
					);
				}
				const usageData = await resp.json();
				return this.normalizeCopilotResponse(
					usageData,
					"copilot",
					"GitHub Copilot",
				);
			} catch (e) {
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Copilot backend fetch failed:",
					e,
				);
				if (e instanceof Error && e.message.includes("ECONNREFUSED")) {
					return this.normalizeCopilotResponse(
						{
							error: "BACKEND_UNAVAILABLE",
							message: "Backend FastAPI non démarré",
							provider: "copilot",
							available: false,
						},
						"copilot",
						"GitHub Copilot",
					);
				}
				return null;
			}
		}

		// Windsurf/Codeium special case
		// Strategy priority:
		//   1. Local IDE cached plan info (windsurf.settings.cachedPlanInfo — updated by IDE during active use)
		//   2. Fall back to Codeium API with service key (Enterprise only)
		// Note: The Codeium GetUserStatus API requires gRPC binary protocol and cannot
		// be called with fetch(). The windsurf.settings.cachedPlanInfo key is the most
		// reliable source — it's written by the Windsurf IDE and reflects current usage.
		if (providerName === "windsurf") {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Windsurf provider — fetching credits",
			);

			// Strategy 1: Read local IDE cached plan info (primary source)
			try {
				const { readWindsurfCachedPlanInfo } = await import(
					"../services/credential-manager"
				);
				const cached = await readWindsurfCachedPlanInfo();
				if (cached.success && cached.planInfo) {
					const rawMsgs = cached.planInfo.usage;
					const scl =
						rawMsgs.messages >= 1000 && rawMsgs.messages % 100 === 0 ? 100 : 1;
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Windsurf — using local IDE cached plan info",
						{
							planName: cached.planInfo.planName,
							userName: cached.userName,
							messagesRaw: `${rawMsgs.usedMessages}/${rawMsgs.messages}`,
							creditsDisplay: `${Math.round(rawMsgs.usedMessages / scl)}/${Math.round(rawMsgs.messages / scl)}`,
							usagePercent:
								rawMsgs.messages > 0
									? `${Math.round((rawMsgs.usedMessages / rawMsgs.messages) * 100)}%`
									: "N/A",
							flowActions: `${rawMsgs.usedFlowActions}/${rawMsgs.flowActions}`,
							isStale: cached.planInfo.isStale ?? false,
							source: "windsurf.settings.cachedPlanInfo",
							billingStart: new Date(
								cached.planInfo.startTimestamp,
							).toISOString(),
							billingEnd: new Date(cached.planInfo.endTimestamp).toISOString(),
						},
					);
					const result = this.normalizeWindsurfCachedPlanInfo(
						cached.planInfo,
						"windsurf-local",
						cached.userName
							? `Windsurf (${cached.userName})`
							: "Windsurf (Codeium)",
					);
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Windsurf normalized result:",
						{
							sessionPercent: result.sessionPercent,
							weeklyPercent: result.weeklyPercent,
							usageWindows: result.usageWindows
								? {
										sessionWindowLabel: translateUsageLabel(result.usageWindows.sessionWindowLabel),
										weeklyWindowLabel: translateUsageLabel(result.usageWindows.weeklyWindowLabel),
									}
								: undefined,
							windsurfCredits: result.windsurfCredits,
						},
					);
					return result;
				}
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf — local IDE cache unavailable:",
					cached.error,
				);
			} catch (e) {
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf — local IDE cache read failed:",
					e,
				);
			}

			// Strategy 1+: Try Codeium API with service key (Enterprise only)
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Windsurf — falling back to Codeium API",
			);
			try {
				// Find the Windsurf API profile to get the service key
				const profilesFile = await loadProfilesFile();
				const windsurfProfile = profilesFile.profiles.find((p) => {
					const detected = detectProvider(p.baseUrl);
					return detected === "windsurf";
				});

				let serviceKey = windsurfProfile?.apiKey;
				let wsProfileId = windsurfProfile?.id || "windsurf-global";
				let wsProfileName = windsurfProfile?.name || "Windsurf (Codeium)";
				let keySource = serviceKey ? "api-profile" : "";

				// Fallback to global settings (globalWindsurfApiKey) for SSO users
				if (!serviceKey) {
					try {
						const { readSettingsFile } = await import("../settings-utils");
						const settings = readSettingsFile();
						const globalKey = settings?.globalWindsurfApiKey as
							| string
							| undefined;
						if (globalKey?.trim()) {
							serviceKey = globalKey.trim();
							wsProfileId = "windsurf-global";
							wsProfileName = "Windsurf (Codeium)";
							keySource = "global-settings";
						}
					} catch {
						// Settings file not available
					}
				}

				// Fallback to environment variables (WINDSURF_API_KEY, CODEIUM_API_KEY)
				if (!serviceKey) {
					const envKey =
						process.env.WINDSURF_API_KEY || process.env.CODEIUM_API_KEY;
					if (envKey?.trim()) {
						serviceKey = envKey.trim();
						wsProfileId = "windsurf-env";
						wsProfileName = "Windsurf (env)";
						keySource = "env-var";
					}
				}

				// Fallback to auto-detection from local Windsurf IDE (SSO enterprise users)
				if (!serviceKey) {
					try {
						const { detectWindsurfLocalToken } = await import(
							"../services/credential-manager"
						);
						const detected = await detectWindsurfLocalToken();
						if (detected.success && detected.apiKey) {
							serviceKey = detected.apiKey;
							wsProfileId = "windsurf-sso";
							wsProfileName = detected.userName
								? `Windsurf (${detected.userName})`
								: "Windsurf (SSO)";
							keySource = "local-ide-detection";
							this.debugLog(
								"[UsageMonitor:getUsageForProvider] Windsurf — SSO token detected from local IDE",
								{
									userName: detected.userName,
									keyLength: serviceKey.length,
									isJWT: serviceKey.startsWith("eyJ"),
								},
							);
						}
					} catch (e) {
						this.debugLog(
							"[UsageMonitor:getUsageForProvider] Windsurf — local IDE detection failed:",
							e,
						);
					}
				}

				if (!serviceKey) {
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Windsurf — no service key found in profiles, settings, env vars, or local IDE",
					);
					// Return a minimal snapshot so the UI shows Windsurf info instead of Anthropic
					return {
						sessionPercent: 0,
						weeklyPercent: 0,
						profileId: wsProfileId,
						profileName: wsProfileName,
						fetchedAt: new Date(),
						providerName: "windsurf",
					} as UsageSnapshot;
				}

				const isJWT = serviceKey.startsWith("eyJ");

				// Log key source and fingerprint for debugging auth issues
				const keyFingerprint =
					serviceKey.length > 8
						? serviceKey.substring(0, 6) +
							"..." +
							serviceKey.substring(serviceKey.length - 4)
						: "***";
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf — calling Codeium API",
					{
						keySource,
						keyFingerprint,
						keyLength: serviceKey.length,
						isJWT,
					},
				);

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

				// Strategy 2: Authorization Bearer header (works for both service keys and SSO/JWT tokens)
				if (!resp || resp.status === 401) {
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Windsurf — trying GetTeamCreditBalance with Bearer header (SSO/JWT compatible)",
					);
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

				if (resp.ok) {
					const usageData = await resp.json();
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Windsurf credits response:",
						usageData,
					);
					return this.normalizeWindsurfResponse(
						usageData,
						wsProfileId,
						wsProfileName,
					);
				}

				// Strategy 3: Try GetUser to validate key and get user info
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf — credit balance unavailable, trying GetUser",
					{
						status: resp.status,
						statusText: resp.statusText,
						keySource,
						keyFingerprint,
					},
				);

				let ssoUserName: string | undefined;
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
						const userData = await userResp.json();
						ssoUserName = userData?.name || userData?.email || "Windsurf User";
						this.debugLog(
							"[UsageMonitor:getUsageForProvider] Windsurf — key validated via GetUser:",
							{ ssoUserName },
						);
					}
				} catch {
					// GetUser also failed — continue to return basic snapshot
				}

				// Strategy 4: For SSO enterprise, try GetTeamInfo to get actual usage quotas
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
							this.debugLog(
								"[UsageMonitor:getUsageForProvider] Windsurf SSO — GetTeamInfo response:",
								teamData,
							);
							// If team info contains credit/usage data, normalize it
							if (
								teamData &&
								(teamData.promptCreditsPerSeat ||
									teamData.addOnCreditsUsed ||
									teamData.numSeats)
							) {
								const displayName = ssoUserName
									? `${wsProfileName} (${ssoUserName})`
									: wsProfileName;
								return this.normalizeWindsurfResponse(
									teamData,
									wsProfileId,
									displayName,
								);
							}
						}
					} catch {
						// GetTeamInfo failed — continue to return connected snapshot
					}
				}

				// Return a Windsurf snapshot to prevent Anthropic fallback
				// For SSO enterprise: show as connected even if we can't get usage details
				const displayName = ssoUserName
					? `${wsProfileName} (${ssoUserName})`
					: wsProfileName;
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf — returning SSO connected snapshot",
					{
						ssoUserName,
						isJWT,
						keySource,
					},
				);
				return {
					sessionPercent: 0,
					weeklyPercent: 0,
					profileId: wsProfileId,
					profileName: displayName,
					fetchedAt: new Date(),
					providerName: "windsurf",
				} as UsageSnapshot;
			} catch (e) {
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Windsurf credits fetch failed:",
					e,
				);
				return null;
			}
		}

		// Step 1: Search API profiles first (profiles.json) — these cover anthropic, openai, ollama API key profiles
		let apiProfileSnapshot: UsageSnapshot | null = null;
		try {
			const profilesFile = await loadProfilesFile();
			const apiProfile = profilesFile.profiles.find((p) => {
				const detected = detectProvider(p.baseUrl);
				return detected === providerName;
			});

			if (apiProfile?.apiKey) {
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Found API profile for provider:",
					{
						providerName,
						profileId: apiProfile.id,
						profileName: apiProfile.name,
					},
				);

				// Skip API key attempt for anthropic — the OAuth usage endpoint (/api/oauth/usage)
				// requires an OAuth Bearer token, not a plain API key. Plain API keys will always
				// get 401 here, so skip directly to Step 2 (OAuth profile lookup) instead.
				if (providerName === "anthropic") {
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Step 1: Skipping API key for anthropic — OAuth usage endpoint requires OAuth token, falling through to Step 2",
					);
				} else if (providerName === "openai") {
					// OpenAI special case — usage API has a different format
					try {
						const resp = await fetch(
							"http://localhost:9000/providers/usage/openai",
						);
						if (!resp.ok) {
							return null;
						}
						const usageData = await resp.json();
						return {
							sessionPercent: 0,
							weeklyPercent: 0,
							profileId: apiProfile.id,
							profileName: apiProfile.name,
							providerName: "openai",
							openaiUsageDetails: usageData,
							fetchedAt: new Date(),
						};
					} catch (e) {
						this.debugLog(
							"[UsageMonitor:getUsageForProvider] OpenAI usage fetch failed:",
							{
								error: e instanceof Error ? e.message : String(e),
								profileId: apiProfile.id,
								profileName: apiProfile.name,
							},
						);
						return null;
					}
				} else {
					// Non-anthropic, non-openai providers — try API key fetch
					const activeProfileResult: ActiveProfileResult = {
						profileId: apiProfile.id,
						profileName: apiProfile.name,
						profileEmail: undefined,
						isAPIProfile: true,
						baseUrl: apiProfile.baseUrl,
						credential: apiProfile.apiKey,
					};

					apiProfileSnapshot = await this.fetchUsageViaAPI(
						apiProfile.apiKey,
						apiProfile.id,
						apiProfile.name,
						undefined,
						activeProfileResult,
						true, // suppressErrors — Step 1 is a best-effort attempt before OAuth fallback
					);

					if (apiProfileSnapshot) {
						return apiProfileSnapshot;
					}

					// API fetch returned no data — return a minimal snapshot with correct
					// provider info so the UI displays the right provider name/account
					// instead of falling through to OAuth (which would show Anthropic data)
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Step 1: API profile returned no usage data, returning minimal snapshot for:",
						providerName,
					);
					return {
						sessionPercent: 0,
						weeklyPercent: 0,
						profileId: apiProfile.id,
						profileName: apiProfile.name,
						providerName: providerName,
						fetchedAt: new Date(),
					} as UsageSnapshot;
				}
			} else {
				this.debugLog(
					"[UsageMonitor:getUsageForProvider] Step 1: No API profile found for provider:",
					providerName,
				);
			}
		} catch (error) {
			console.warn(
				"[UsageMonitor:getUsageForProvider] Step 1: Failed to search API profiles:",
				error,
			);
		}

		// Step 2: Search OAuth profiles (ClaudeProfileManager) — these are always 'anthropic'
		if (providerName === "anthropic") {
			try {
				const profileManager = getClaudeProfileManager();
				const allOauthProfiles =
					profileManager.getProfilesSortedByAvailability();
				const oauthProfile = allOauthProfiles?.[0];

				if (oauthProfile) {
					this.debugLog(
						"[UsageMonitor:getUsageForProvider] Step 2: Found OAuth profile, attempting fetch with fallback",
					);

					// Get credential for the OAuth profile
					const credential = await this.getCredentialForProfile(oauthProfile);
					if (!credential) {
						// No credential yet (fresh install, token expired, etc.)
						// Fall through to Step 4 to return a minimal Anthropic snapshot so the
						// UI exits loading state instead of spinning indefinitely.
						console.warn(
							"[UsageMonitor:getUsageForProvider] Step 2: No credential found for OAuth profile:",
							oauthProfile.name,
							"— falling through to minimal snapshot",
						);
					} else {
						// Use the complete fetchUsage method which includes CLI fallback
						const snapshot = await this.fetchUsage(
							oauthProfile.id,
							credential,
							undefined, // activeProfile - will be determined inside fetchUsage
							"anthropic", // providerName
							true, // suppressErrors - Step 2 is also a best-effort attempt
						);
						if (snapshot) {
							// CLI-fetched snapshots lack providerName — ensure it is always set before returning.
							if (!snapshot.providerName) {
								snapshot.providerName = "anthropic";
							}
							return snapshot;
						}
						console.warn(
							"[UsageMonitor:getUsageForProvider] Step 2: fetchUsage returned null for OAuth profile:",
							oauthProfile.name,
						);
					}
				} else {
					console.warn(
						"[UsageMonitor:getUsageForProvider] Step 2: No OAuth profiles found in ClaudeProfileManager (total profiles:",
						allOauthProfiles?.length ?? 0,
						")",
					);
				}
			} catch (error) {
				console.warn(
					"[UsageMonitor:getUsageForProvider] Step 2 OAuth lookup failed:",
					error,
				);
			}
		}

		// Step 2b: If API profile snapshot was obtained earlier (even with incomplete weekly data),
		// return it as a fallback rather than returning nothing
		if (apiProfileSnapshot) {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Returning API profile snapshot as fallback:",
				{
					sessionPercent: apiProfileSnapshot.sessionPercent,
					weeklyPercent: apiProfileSnapshot.weeklyPercent,
				},
			);
			return apiProfileSnapshot;
		}

		// Step 3: Check if currentUsage matches the requested provider
		if (this.currentUsage?.providerName === providerName) {
			this.debugLog(
				"[UsageMonitor:getUsageForProvider] Returning currentUsage for provider: " +
					providerName,
			);
			return this.currentUsage;
		}

		// Step 4: Return a minimal snapshot with the correct provider name
		// so the UI displays the right provider instead of stale data from another provider
		this.debugLog(
			"[UsageMonitor:getUsageForProvider] No usage data found for provider: " +
				providerName +
				" — returning minimal snapshot",
		);
		return {
			sessionPercent: 0,
			weeklyPercent: 0,
			profileId: providerName,
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			profileName: getProviderLabel(providerName as any),
			providerName: providerName,
			fetchedAt: new Date(),
		} as UsageSnapshot;
	}

	public override emit: EventEmitter["emit"] = super.emit;
}

/**
 * Get the singleton UsageMonitor instance
 */
export function getUsageMonitor(): UsageMonitor {
	return UsageMonitor.getInstance();
}

declare const process: { env: { [key: string]: string | undefined } };

export type { ApiProvider } from "../../shared/utils/provider-detection";
