/**
 * OAuth Token Refresh Module
 *
 * Handles automatic token refresh for Claude Code OAuth tokens.
 * Supports proactive refresh (before expiry) and reactive refresh (on 401 errors).
 *
 * CRITICAL: When a token is refreshed, the old token is IMMEDIATELY REVOKED by Anthropic.
 * Therefore, new tokens must be written back to the credential store immediately.
 *
 * Verified endpoint:
 * POST https://console.anthropic.com/v1/oauth/token
 * Content-Type: application/x-www-form-urlencoded
 * Body: grant_type=refresh_token&refresh_token=sk-ant-ort01-...&client_id=<CLIENT_ID>
 * Response: { access_token, refresh_token, expires_in: 28800, token_type: "Bearer" }
 */

import { homedir } from "node:os";
import {
	clearKeychainCache,
	getFullCredentialsFromKeychain,
	updateKeychainCredentials,
} from "./credential-utils";

// =============================================================================
// Constants
// =============================================================================

/**
 * Anthropic OAuth token endpoint
 */
const ANTHROPIC_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

/**
 * Claude Code OAuth client ID (public - same for all Claude Code installations)
 * This is the official client ID used by Claude Code CLI
 */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Proactive refresh threshold: refresh tokens 30 minutes before expiry
 * This provides a buffer to handle network issues and ensures tokens are
 * always valid when needed for autonomous overnight operation.
 */
const PROACTIVE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Maximum retry attempts for token refresh
 */
const MAX_REFRESH_RETRIES = 2;

/**
 * Delay between retry attempts (exponential backoff base)
 */
const RETRY_DELAY_BASE_MS = 1000;

// =============================================================================
// Types
// =============================================================================

/**
 * Result of a token refresh operation
 */
export interface TokenRefreshResult {
	success: boolean;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number; // Unix timestamp in ms
	expiresIn?: number; // Seconds until expiry
	error?: string;
	errorCode?: string; // 'invalid_grant', 'invalid_client', 'network_error', etc.
}

/**
 * Result of ensuring a valid token
 */
export interface EnsureValidTokenResult {
	token: string | null;
	wasRefreshed: boolean;
	error?: string;
	errorCode?: string; // 'invalid_grant', 'invalid_client', 'network_error', etc.
	/**
	 * True if token was refreshed but failed to persist to keychain.
	 * The token is valid for this session but will be lost on restart.
	 * Callers should alert the user to re-authenticate.
	 */
	persistenceFailed?: boolean;
}

/**
 * Callback for when tokens are refreshed
 */
export type OnTokenRefreshedCallback = (
	configDir: string | undefined,
	newAccessToken: string,
	newRefreshToken: string,
	expiresAt: number,
) => void;

// =============================================================================
// Token Expiry Detection
// =============================================================================

/**
 * Check if a token is expired or near expiry.
 *
 * @param expiresAt - Unix timestamp in ms when the token expires, or null if unknown
 * @param thresholdMs - How far before expiry to consider "near expiry" (default: 30 minutes)
 * @returns true if token is expired or will expire within the threshold
 */
export function isTokenExpiredOrNearExpiry(
	expiresAt: number | null,
	thresholdMs: number = PROACTIVE_REFRESH_THRESHOLD_MS,
): boolean {
	// If we don't know the expiry time, assume it might be expired
	// This is safer than assuming it's valid
	if (expiresAt === null) {
		return true;
	}

	const now = Date.now();
	const expiryThreshold = expiresAt - thresholdMs;

	return now >= expiryThreshold;
}

/**
 * Get time remaining until token expiry.
 *
 * @param expiresAt - Unix timestamp in ms when the token expires
 * @returns Time remaining in ms, or null if expiresAt is null
 */
export function getTimeUntilExpiry(expiresAt: number | null): number | null {
	if (expiresAt === null) return null;
	return Math.max(0, expiresAt - Date.now());
}

/**
 * Format time remaining for logging
 */
export function formatTimeRemaining(ms: number | null): string {
	if (ms === null) return "unknown";
	if (ms <= 0) return "expired";

	const minutes = Math.floor(ms / (60 * 1000));
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	}
	return `${minutes}m`;
}

// =============================================================================
// Token Refresh
// =============================================================================

/**
 * Refresh an OAuth token using the refresh_token grant type.
 *
 * CRITICAL: After a successful refresh, the old access token AND refresh token are REVOKED.
 * The new tokens must be stored immediately.
 *
 * @param refreshToken - The refresh token to use
 * @param configDir - Optional config directory for the profile (used to clear cache on error)
 * @returns Result containing new tokens or error information
 */
export async function refreshOAuthToken(
	refreshToken: string,
	configDir?: string,
): Promise<TokenRefreshResult> {
	const isDebug = process.env.DEBUG === "true";

	if (isDebug) {
		// Reduce fingerprint to fewer characters to minimize information exposure
		// Show only first 4 and last 2 characters for debugging purposes
		console.warn("[TokenRefresh] Starting token refresh", {
			refreshTokenFingerprint: refreshToken
				? `${refreshToken.slice(0, 4)}...${refreshToken.slice(-2)}`
				: "null",
		});
	}

	if (!refreshToken) {
		return {
			success: false,
			error: "No refresh token provided",
			errorCode: "missing_refresh_token",
		};
	}

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
		if (attempt > 0) {
			// Exponential backoff between retries
			const delay = RETRY_DELAY_BASE_MS * 2 ** (attempt - 1);
			if (isDebug) {
				console.warn(
					"[TokenRefresh] Retrying after delay:",
					delay,
					"ms (attempt",
					attempt + 1,
					")",
				);
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}

		try {
			// Build form-urlencoded body
			const body = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLAUDE_CODE_CLIENT_ID,
			});

			const response = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			});

			if (!response.ok) {
				let errorData: Record<string, string> = {};
				try {
					errorData = await response.json();
				} catch {
					// Ignore JSON parse errors
				}

				const errorCode = errorData.error || `http_${response.status}`;
				const errorDescription =
					errorData.error_description || response.statusText;

				// Check for permanent errors that shouldn't be retried
				if (errorCode === "invalid_grant" || errorCode === "invalid_client") {
					console.error(
						"[TokenRefresh] Permanent error - refresh token invalid:",
						{
							errorCode,
							errorDescription,
						},
					);

					// Clear credential cache to ensure stale tokens aren't reused
					// This prevents infinite loops where cached invalid tokens are repeatedly used
					clearKeychainCache(configDir);

					return {
						success: false,
						error: `Token refresh failed: ${errorDescription}`,
						errorCode,
					};
				}

				// Temporary errors - continue to retry
				lastError = new Error(`HTTP ${response.status}: ${errorDescription}`);
				if (isDebug) {
					console.warn(
						"[TokenRefresh] Temporary error, will retry:",
						lastError.message,
					);
				}
				continue;
			}

			// Parse successful response
			const data = await response.json();

			if (!data.access_token) {
				return {
					success: false,
					error: "Response missing access_token",
					errorCode: "invalid_response",
				};
			}

			// Calculate expiry timestamp
			// expires_in is in seconds, convert to ms and add to current time
			const expiresIn = data.expires_in || 28800; // Default 8 hours if not provided
			const expiresAt = Date.now() + expiresIn * 1000;

			if (isDebug) {
				console.warn("[TokenRefresh] Token refresh successful", {
					newTokenFingerprint: `${data.access_token.slice(0, 12)}...${data.access_token.slice(-4)}`,
					expiresIn: expiresIn,
					expiresAt: new Date(expiresAt).toISOString(),
				});
			}

			return {
				success: true,
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt,
				expiresIn,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (isDebug) {
				console.warn(
					"[TokenRefresh] Network error, will retry:",
					lastError.message,
				);
			}
		}
	}

	// All retries exhausted
	console.error("[TokenRefresh] All retry attempts failed");
	return {
		success: false,
		error: lastError?.message || "Token refresh failed after retries",
		errorCode: "network_error",
	};
}

// =============================================================================
// Concurrency Control for Token Refresh
// =============================================================================

/**
 * Per-configDir mutex to prevent concurrent token refreshes.
 *
 * CRITICAL: When a token is refreshed, the old token is IMMEDIATELY REVOKED.
 * If two components (e.g., UsageMonitor and AgentProcess) refresh simultaneously:
 * - Component A refreshes with refresh_token R1 → gets T-A
 * - Component B also refreshes with R1 → gets error (R1 already used) or gets T-B
 * - One of T-A or T-B is immediately revoked, leaving an invalid token
 *
 * This mutex ensures only one refresh happens at a time per configDir.
 */
const refreshLocks = new Map<string, Promise<EnsureValidTokenResult>>();

/**
 * Set of configDir paths that currently have an agent process running.
 * When an agent is running, the UsageMonitor should NOT refresh tokens for that
 * profile, because:
 * 1. The agent already has the token in its subprocess env
 * 2. Refreshing would REVOKE that token, causing a 401 in the agent
 * 3. The agent can't pick up the new token (it's in a subprocess)
 */
const agentRunningProfiles = new Set<string>();

/**
 * Mark a profile as having an active agent process.
 * While marked, ensureValidToken will skip refresh for this configDir.
 */
export function markAgentRunning(configDir: string | undefined): void {
	const key = normalizeConfigDir(configDir);
	agentRunningProfiles.add(key);
}

/**
 * Unmark a profile when its agent process exits.
 */
export function markAgentStopped(configDir: string | undefined): void {
	const key = normalizeConfigDir(configDir);
	agentRunningProfiles.delete(key);
}

/**
 * Check if an agent is running for a configDir.
 */
export function isAgentRunning(configDir: string | undefined): boolean {
	const key = normalizeConfigDir(configDir);
	return agentRunningProfiles.has(key);
}

function normalizeConfigDir(configDir: string | undefined): string {
	if (!configDir) return "__default__";
	return configDir.startsWith("~")
		? configDir.replace(/^~/, homedir())
		: configDir;
}

// =============================================================================
// Token Refresh Cooldown (Bug #10)
// =============================================================================

/**
 * Per-configDir cooldown tracker for token refreshes.
 *
 * PROBLEM (Bug #10): The UsageMonitor calls ensureValidToken() on every 30-second
 * polling cycle for the active profile (and for inactive profiles when fetching usage).
 * Each call that finds a near-expiry token triggers a refresh, which:
 * 1. REVOKES the previous access token
 * 2. Consumes the refresh token (single-use in OAuth)
 * 3. Issues a new access_token + refresh_token pair
 *
 * Rapid sequential refreshes (e.g., 6 in a row) can trigger Anthropic's OAuth security
 * mechanisms (refresh token replay detection), invalidating the ENTIRE token family.
 * This causes all tokens to become invalid, including ones given to agent subprocesses.
 *
 * SOLUTION: After a successful refresh, enforce a cooldown period (60 seconds) during
 * which no further refreshes are allowed for the same configDir. The only exception is
 * forceRefresh from agent spawn, which bypasses the cooldown (since it needs a
 * guaranteed-fresh token for the subprocess).
 */
const lastRefreshTimestamps = new Map<string, number>();

/**
 * Cooldown period in milliseconds after a successful token refresh.
 * During this period, ensureValidToken() will return the existing token
 * without attempting another refresh (unless forceRefresh is set).
 */
const REFRESH_COOLDOWN_MS = 60_000; // 60 seconds

// =============================================================================
// Integrated Token Validation and Refresh
// =============================================================================

/**
 * Options for ensureValidToken
 */
export interface EnsureValidTokenOptions {
	/**
	 * Force a token refresh regardless of expiry time.
	 *
	 * Use this before spawning agent subprocesses to guarantee a fresh token.
	 * A token can be revoked on Anthropic's side (e.g., by a previous race condition)
	 * while its local expiresAt timestamp still says it's valid. forceRefresh bypasses
	 * the expiry check and always uses the refresh_token to get a new access_token.
	 *
	 * If the refresh_token is also revoked (invalid_grant), the error is propagated
	 * to the caller so it can prompt re-authentication.
	 */
	forceRefresh?: boolean;
}

/**
 * Cross-process recovery after a refresh `invalid_grant` / `invalid_client`.
 *
 * ROOT CAUSE: the OAuth refresh token is single-use. When several actors share
 * the same credential store — WorkPilot's UsageMonitor, each agent subprocess
 * (the Claude Code SDK refreshes on its own), a second WorkPilot window, or an
 * external `claude` CLI — whoever refreshes first rotates the token and writes a
 * fresh access token to disk. Every other actor's refresh token is then revoked,
 * so its next refresh fails with `invalid_grant` even though a perfectly valid
 * token is already sitting on disk.
 *
 * In that situation the correct action is NOT to force the user to
 * re-authenticate: it is to re-read the credential store and adopt the fresh
 * token the winning process just wrote. This makes the whole system self-healing
 * under refresh-token contention.
 *
 * @param expandedConfigDir - resolved config directory of the profile
 * @param previousAccessToken - the (now stale) access token we tried to refresh from
 * @returns a newer, still-valid access token written by another process, or null
 */
function recoverTokenAfterInvalidGrant(
	expandedConfigDir: string | undefined,
	previousAccessToken: string | null,
): string | null {
	// Bypass the in-memory cache so we observe what another process just wrote.
	clearKeychainCache(expandedConfigDir);
	const diskCreds = getFullCredentialsFromKeychain(expandedConfigDir);
	if (
		diskCreds.token &&
		diskCreds.token !== previousAccessToken &&
		// threshold 0: accept any token that is not already expired
		!isTokenExpiredOrNearExpiry(diskCreds.expiresAt, 0)
	) {
		return diskCreds.token;
	}
	return null;
}

/**
 * Ensure a valid token is available, refreshing if necessary.
 *
 * This function:
 * 1. Reads credentials from keychain
 * 2. Checks if token is expired or near expiry (unless forceRefresh is set)
 * 3. If needed, refreshes the token and writes back to keychain
 * 4. Returns a valid token
 *
 * CONCURRENCY SAFETY: Uses a per-configDir lock to prevent simultaneous refreshes.
 * When an agent process is running (marked via markAgentRunning), refresh is SKIPPED
 * to avoid revoking the token the agent is using.
 *
 * @param configDir - Config directory for the profile (can be undefined for default profile)
 * @param onRefreshed - Optional callback when tokens are refreshed
 * @param options - Optional settings like forceRefresh
 * @returns Valid token or null with error information
 */
export async function ensureValidToken(
	configDir: string | undefined,
	onRefreshed?: OnTokenRefreshedCallback,
	options?: EnsureValidTokenOptions,
): Promise<EnsureValidTokenResult> {
	const isDebug = process.env.DEBUG === "true";

	// Expand ~ in configDir if present
	const expandedConfigDir = configDir?.startsWith("~")
		? configDir.replace(/^~/, homedir())
		: configDir;

	// CONCURRENCY GUARD: If another refresh is in progress for this configDir,
	// wait for it to complete and return its result
	const lockKey = expandedConfigDir || "__default__";
	const existingLock = refreshLocks.get(lockKey);
	if (existingLock) {
		if (isDebug) {
			console.warn(
				"[TokenRefresh:ensureValidToken] Another refresh in progress for",
				lockKey,
				"- waiting",
			);
		}
		return existingLock;
	}

	if (isDebug) {
		console.warn("[TokenRefresh:ensureValidToken] Checking token validity", {
			configDir: expandedConfigDir || "default",
		});
	}

	// Step 1: Read full credentials from keychain
	const creds = getFullCredentialsFromKeychain(expandedConfigDir);

	if (creds.error) {
		return {
			token: null,
			wasRefreshed: false,
			error: `Failed to read credentials: ${creds.error}`,
		};
	}

	if (!creds.token) {
		return {
			token: null,
			wasRefreshed: false,
			error: "No access token found in credentials",
			errorCode: "missing_credentials",
		};
	}

	// Step 2: Check if token is expired or near expiry
	// When forceRefresh is set, ALWAYS refresh regardless of expiry timestamp.
	// This handles the case where a token was revoked on Anthropic's side (e.g., by a
	// previous race condition) but its local expiresAt hasn't passed yet.
	const forceRefresh = options?.forceRefresh === true;
	const needsRefresh =
		forceRefresh || isTokenExpiredOrNearExpiry(creds.expiresAt);

	if (!needsRefresh) {
		if (isDebug) {
			console.warn("[TokenRefresh:ensureValidToken] Token is valid", {
				timeRemaining: formatTimeRemaining(getTimeUntilExpiry(creds.expiresAt)),
			});
		}
		return {
			token: creds.token,
			wasRefreshed: false,
		};
	}

	if (forceRefresh) {
		console.warn(
			"[TokenRefresh:ensureValidToken] Force refresh requested — bypassing expiry check",
			{
				configDir: expandedConfigDir || "default",
				currentTokenFingerprint: creds.token
					? `${creds.token.slice(0, 8)}...${creds.token.slice(-4)}`
					: "(none)",
				hasRefreshToken: !!creds.refreshToken,
			},
		);
	}

	if (isDebug) {
		console.warn("[TokenRefresh:ensureValidToken] Token needs refresh", {
			expiresAt: creds.expiresAt
				? new Date(creds.expiresAt).toISOString()
				: "unknown",
			hasRefreshToken: !!creds.refreshToken,
		});
	}

	// AGENT SAFETY GUARD: If an agent process is currently running with this profile's
	// token, DO NOT refresh — the refresh would REVOKE the token the agent is using,
	// causing an immediate 401. The agent has the token baked into its subprocess env
	// and cannot pick up a new one. Return the existing (possibly near-expiry) token.
	if (agentRunningProfiles.has(lockKey)) {
		console.warn(
			"[TokenRefresh:ensureValidToken] SKIPPING refresh — agent process is running for",
			lockKey,
			"(token would be revoked, causing 401 in agent subprocess)",
		);
		return {
			token: creds.token,
			wasRefreshed: false,
			error: "Refresh skipped: agent process running with this token",
		};
	}

	// COOLDOWN GUARD (Bug #10): If we recently refreshed this profile's token,
	// skip refresh to avoid rapid token rotation that can trigger Anthropic's
	// OAuth security mechanisms (token family invalidation).
	// Exception: forceRefresh (from agent spawn) bypasses cooldown because
	// the agent needs a guaranteed-fresh token for its subprocess env.
	if (!forceRefresh) {
		const lastRefresh = lastRefreshTimestamps.get(lockKey);
		if (lastRefresh && Date.now() - lastRefresh < REFRESH_COOLDOWN_MS) {
			const cooldownRemaining =
				REFRESH_COOLDOWN_MS - (Date.now() - lastRefresh);
			console.warn(
				"[TokenRefresh:ensureValidToken] COOLDOWN — skipping refresh for",
				lockKey,
				`(${Math.round(cooldownRemaining / 1000)}s remaining after recent refresh)`,
			);
			return {
				token: creds.token,
				wasRefreshed: false,
				error: "Refresh skipped: cooldown after recent refresh",
			};
		}
	}

	// Step 3: Check if we have a refresh token
	if (!creds.refreshToken) {
		// Can't refresh - return existing token and let caller handle potential 401
		if (isDebug) {
			console.warn(
				"[TokenRefresh:ensureValidToken] No refresh token available, returning existing token",
			);
		}
		return {
			token: creds.token,
			wasRefreshed: false,
			error: "Token expired but no refresh token available",
		};
	}

	// Step 4: Refresh the token (with concurrency lock)
	const refreshPromise = (async (): Promise<EnsureValidTokenResult> => {
		const refreshResult = await refreshOAuthToken(
			creds.refreshToken as string,
			expandedConfigDir,
		);

		if (
			!refreshResult.success ||
			!refreshResult.accessToken ||
			!refreshResult.refreshToken ||
			!refreshResult.expiresAt
		) {
			console.error(
				"[TokenRefresh:ensureValidToken] Token refresh failed:",
				refreshResult.error,
			);

			// Check for permanent errors (revoked/invalid tokens)
			const isPermanentError =
				refreshResult.errorCode === "invalid_grant" ||
				refreshResult.errorCode === "invalid_client";

			if (isPermanentError) {
				// Before declaring the account unusable, check whether another process
				// (agent SDK, second window, external CLI) already rotated the token and
				// wrote a fresh one to disk. If so, adopt it instead of forcing re-auth.
				const recovered = recoverTokenAfterInvalidGrant(
					expandedConfigDir,
					creds.token,
				);
				if (recovered) {
					console.warn(
						"[TokenRefresh:ensureValidToken] invalid_grant, but a newer valid token was found on disk (rotated by another process) — adopting it instead of requiring re-authentication",
					);
					lastRefreshTimestamps.set(lockKey, Date.now());
					return { token: recovered, wasRefreshed: true };
				}

				// Return null for permanent errors to prevent infinite 401 loops
				console.error(
					"[TokenRefresh:ensureValidToken] Permanent error detected, returning null token",
				);
				return {
					token: null,
					wasRefreshed: false,
					error: `Token refresh failed: ${refreshResult.error}`,
					errorCode: refreshResult.errorCode,
				};
			}

			// For transient errors (network issues, etc.), return old token as best-effort fallback
			return {
				token: creds.token,
				wasRefreshed: false,
				error: `Token refresh failed: ${refreshResult.error}`,
				errorCode: refreshResult.errorCode,
			};
		}

		// Step 5: CRITICAL - Write new tokens to keychain immediately
		// The old token is now REVOKED, so we must persist the new one
		const updateResult = updateKeychainCredentials(expandedConfigDir, {
			accessToken: refreshResult.accessToken,
			refreshToken: refreshResult.refreshToken,
			expiresAt: refreshResult.expiresAt,
			scopes: creds.scopes || undefined,
		});

		// Track if persistence failed - callers can alert user to re-authenticate
		let persistenceFailed = false;

		if (updateResult.success) {
			if (isDebug) {
				console.warn(
					"[TokenRefresh:ensureValidToken] Successfully refreshed and persisted token",
					{
						newExpiresAt: new Date(refreshResult.expiresAt).toISOString(),
					},
				);
			}
		} else {
			// This is a critical error - we have new tokens but can't persist them
			console.error(
				"[TokenRefresh:ensureValidToken] CRITICAL: Failed to persist refreshed tokens:",
				updateResult.error,
			);
			console.error(
				"[TokenRefresh:ensureValidToken] The new token will be lost on next restart!",
			);
			console.error(
				"[TokenRefresh:ensureValidToken] Old credentials in keychain are now REVOKED and must be cleared on restart",
			);
			persistenceFailed = true;

			// Clear credential cache immediately to prevent serving revoked tokens from cache
			// On restart, the revoked tokens will trigger re-authentication via Bugs #3 and #4 fixes
			clearKeychainCache(expandedConfigDir);
			// Still return the new token for this session
		}

		// Step 6: Clear the credential cache so next read gets fresh data
		clearKeychainCache(expandedConfigDir);

		// Step 7: Call the callback if provided
		if (onRefreshed) {
			onRefreshed(
				expandedConfigDir,
				refreshResult.accessToken,
				refreshResult.refreshToken,
				refreshResult.expiresAt,
			);
		}

		// Record cooldown timestamp after successful refresh (Bug #10)
		// This prevents rapid sequential refreshes from UsageMonitor cycles
		lastRefreshTimestamps.set(lockKey, Date.now());

		return {
			token: refreshResult.accessToken,
			wasRefreshed: true,
			...(persistenceFailed && { persistenceFailed: true }),
		};
	})();

	// Register the lock so other callers wait for this refresh to complete
	refreshLocks.set(lockKey, refreshPromise);

	try {
		return await refreshPromise;
	} finally {
		refreshLocks.delete(lockKey);
	}
}

/**
 * Perform a reactive token refresh (called on 401 error).
 *
 * This is similar to ensureValidToken but:
 * - Doesn't check expiry (we know the token is invalid)
 * - Forces a refresh regardless of apparent token state
 *
 * @param configDir - Config directory for the profile
 * @param onRefreshed - Optional callback when tokens are refreshed
 * @returns New token or null with error information
 */
export async function reactiveTokenRefresh(
	configDir: string | undefined,
	onRefreshed?: OnTokenRefreshedCallback,
): Promise<EnsureValidTokenResult> {
	const isDebug = process.env.DEBUG === "true";

	const expandedConfigDir = configDir?.startsWith("~")
		? configDir.replace(/^~/, homedir())
		: configDir;

	if (isDebug) {
		console.warn(
			"[TokenRefresh:reactive] Performing reactive token refresh (401 received)",
			{
				configDir: expandedConfigDir || "default",
			},
		);
	}

	// AGENT SAFETY GUARD: Same as ensureValidToken — don't refresh while agent is running
	const lockKey = expandedConfigDir || "__default__";
	if (agentRunningProfiles.has(lockKey)) {
		console.warn(
			"[TokenRefresh:reactive] SKIPPING reactive refresh — agent process is running for",
			lockKey,
			"(refresh would revoke the token the agent is using)",
		);
		return {
			token: null,
			wasRefreshed: false,
			error: "Reactive refresh skipped: agent process running with this token",
		};
	}

	// Read credentials to get refresh token
	const creds = getFullCredentialsFromKeychain(expandedConfigDir);

	if (creds.error) {
		return {
			token: null,
			wasRefreshed: false,
			error: `Failed to read credentials: ${creds.error}`,
		};
	}

	if (!creds.refreshToken) {
		return {
			token: null,
			wasRefreshed: false,
			error: "No refresh token available for reactive refresh",
		};
	}

	// Perform refresh
	const refreshResult = await refreshOAuthToken(
		creds.refreshToken,
		expandedConfigDir,
	);

	if (
		!refreshResult.success ||
		!refreshResult.accessToken ||
		!refreshResult.refreshToken ||
		!refreshResult.expiresAt
	) {
		// Cross-process recovery: a concurrent actor may have rotated the token and
		// written a fresh one to disk, revoking ours. Adopt the disk token rather
		// than reporting a permanent auth failure.
		if (
			refreshResult.errorCode === "invalid_grant" ||
			refreshResult.errorCode === "invalid_client"
		) {
			const recovered = recoverTokenAfterInvalidGrant(
				expandedConfigDir,
				creds.token,
			);
			if (recovered) {
				console.warn(
					"[TokenRefresh:reactive] invalid_grant, but a newer valid token was found on disk (rotated by another process) — adopting it instead of requiring re-authentication",
				);
				lastRefreshTimestamps.set(lockKey, Date.now());
				return { token: recovered, wasRefreshed: true };
			}
		}

		return {
			token: null,
			wasRefreshed: false,
			error: `Reactive refresh failed: ${refreshResult.error}`,
			errorCode: refreshResult.errorCode,
		};
	}

	// Write new tokens to keychain
	const updateResult = updateKeychainCredentials(expandedConfigDir, {
		accessToken: refreshResult.accessToken,
		refreshToken: refreshResult.refreshToken,
		expiresAt: refreshResult.expiresAt,
		scopes: creds.scopes || undefined,
	});

	// Track if persistence failed - callers can alert user to re-authenticate
	let persistenceFailed = false;
	if (!updateResult.success) {
		console.error(
			"[TokenRefresh:reactive] CRITICAL: Failed to persist refreshed tokens:",
			updateResult.error,
		);
		console.error(
			"[TokenRefresh:reactive] Old credentials in keychain are now REVOKED and must be cleared on restart",
		);
		persistenceFailed = true;

		// Clear credential cache immediately to prevent serving revoked tokens from cache
		// On restart, the revoked tokens will trigger re-authentication via Bugs #3 and #4 fixes
		clearKeychainCache(expandedConfigDir);
	}

	// Also clear cache on success to ensure fresh data is loaded next time
	clearKeychainCache(expandedConfigDir);

	if (onRefreshed) {
		onRefreshed(
			expandedConfigDir,
			refreshResult.accessToken,
			refreshResult.refreshToken,
			refreshResult.expiresAt,
		);
	}

	// Record cooldown timestamp after successful reactive refresh (Bug #10)
	lastRefreshTimestamps.set(lockKey, Date.now());

	if (isDebug) {
		console.warn("[TokenRefresh:reactive] Reactive refresh successful");
	}

	return {
		token: refreshResult.accessToken,
		wasRefreshed: true,
		...(persistenceFailed && { persistenceFailed: true }),
	};
}
