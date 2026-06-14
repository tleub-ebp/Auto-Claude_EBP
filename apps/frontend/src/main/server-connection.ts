/**
 * Server-mode connection manager (multi-user deployments).
 *
 * Holds the connection state for "server mode": which remote WorkPilot
 * server we talk to, the current user, and the JWT pair. The access token
 * lives only in main-process memory; the refresh token is persisted with
 * Electron safeStorage (OS-level encryption) so a restart keeps the session.
 *
 * In "local mode" (default) this module is dormant and every consumer
 * falls back to the historical localhost behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";

export type ConnectionMode = "local" | "server";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

export interface ServerAuthState {
	mode: ConnectionMode;
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	// True once the user has made an explicit connection choice (signed in to
	// a server, or picked local mode). Drives the first-launch login gate.
	configured: boolean;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user: ServerUser;
}

interface PersistedState {
	mode: ConnectionMode;
	serverUrl: string | null;
	encryptedRefreshToken: string | null; // base64 of safeStorage buffer
}

let mode: ConnectionMode = "local";
let serverUrl: string | null = null;
let accessToken: string | null = null;
let refreshToken: string | null = null;
let currentUser: ServerUser | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
// Whether a connection choice has ever been persisted (first-launch gate).
let configured = false;
// Shared in-flight restore so a concurrent main+renderer restore does not
// refresh twice (refresh rotates the token — a double call would fail).
let restoreInFlight: Promise<boolean> | null = null;

function stateFilePath(): string {
	return path.join(app.getPath("userData"), "server-connection.json");
}

function persist(): void {
	try {
		let encryptedRefreshToken: string | null = null;
		if (refreshToken && safeStorage.isEncryptionAvailable()) {
			encryptedRefreshToken = safeStorage
				.encryptString(refreshToken)
				.toString("base64");
		}
		const state: PersistedState = { mode, serverUrl, encryptedRefreshToken };
		fs.writeFileSync(stateFilePath(), JSON.stringify(state), "utf-8");
		configured = true;
	} catch (err) {
		console.error("[server-connection] Failed to persist state:", err);
	}
}

export function loadPersistedState(): void {
	try {
		if (!fs.existsSync(stateFilePath())) return;
		const raw = JSON.parse(
			fs.readFileSync(stateFilePath(), "utf-8"),
		) as PersistedState;
		// A persisted file means the user has already made a connection choice.
		configured = true;
		mode = raw.mode === "server" ? "server" : "local";
		serverUrl = raw.serverUrl || null;
		if (raw.encryptedRefreshToken && safeStorage.isEncryptionAvailable()) {
			refreshToken = safeStorage.decryptString(
				Buffer.from(raw.encryptedRefreshToken, "base64"),
			);
		}
	} catch (err) {
		console.error("[server-connection] Failed to load persisted state:", err);
	}
}

export function isServerMode(): boolean {
	return mode === "server" && !!serverUrl;
}

export function getServerUrl(): string | null {
	return serverUrl;
}

export function getAccessToken(): string | null {
	return accessToken;
}

export function getAuthState(): ServerAuthState {
	return {
		mode,
		serverUrl,
		user: currentUser,
		isAuthenticated: !!accessToken,
		configured,
	};
}

export function setMode(newMode: ConnectionMode, url?: string): void {
	mode = newMode;
	if (newMode === "server" && url) {
		serverUrl = url.replace(/\/+$/, "");
	}
	if (newMode === "local") {
		clearSession();
	}
	persist();
}

function applyTokens(tokens: TokenResponse): void {
	accessToken = tokens.access_token;
	refreshToken = tokens.refresh_token;
	currentUser = tokens.user;
	persist();
	scheduleRefresh(tokens.expires_in);
}

function scheduleRefresh(expiresInSeconds: number): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	// Refresh 60s before expiry (minimum 30s from now).
	const delayMs = Math.max((expiresInSeconds - 60) * 1000, 30_000);
	refreshTimer = setTimeout(() => {
		refreshSession().catch((err) =>
			console.error("[server-connection] Scheduled refresh failed:", err),
		);
	}, delayMs);
	refreshTimer.unref?.();
}

function clearSession(): void {
	accessToken = null;
	refreshToken = null;
	currentUser = null;
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
}

async function serverFetch<T>(
	pathName: string,
	body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	if (!serverUrl) return { ok: false, error: "No server URL configured" };
	try {
		const res = await fetch(`${serverUrl}${pathName}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: text || `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: JSON.parse(text) as T };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function getServerAuthConfig(
	url: string,
): Promise<
	| { ok: true; data: { local_enabled: boolean; entra_enabled: boolean; entra_tenant_id: string | null; entra_client_id: string | null } }
	| { ok: false; error: string }
> {
	try {
		const res = await fetch(`${url.replace(/\/+$/, "")}/auth/config`);
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		return { ok: true, data: await res.json() };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Authenticated request against the current server, attaching the access
 * token. Used by admin-only invitation management.
 */
async function authedFetch<T>(
	pathName: string,
	method: string,
	body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	if (!serverUrl) return { ok: false, error: "No server URL configured" };
	if (!accessToken) return { ok: false, error: "Not authenticated" };
	try {
		const res = await fetch(`${serverUrl}${pathName}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: text || `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: (text ? JSON.parse(text) : null) as T };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface InviteLookup {
	email: string;
	role: string;
}

export interface InvitationPublic {
	id: string;
	email: string;
	role: string;
	project_id?: string | null;
	project_role?: string | null;
	expires_at: string;
	created_at: string;
}

export interface CreateInvitationResult extends InvitationPublic {
	invite_link: string;
	email_sent: boolean;
}

/**
 * Public invite lookup (no auth, no global state mutation): used by the
 * accept-invitation screen to prefill the bound email. POST (not GET) so the
 * token is never placed in a URL / proxy access log.
 */
export async function lookupInvite(
	url: string,
	token: string,
): Promise<{ ok: true; data: InviteLookup } | { ok: false; error: string }> {
	try {
		const res = await fetch(
			`${url.replace(/\/+$/, "")}/auth/invitations/lookup`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			},
		);
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: JSON.parse(text) as InviteLookup };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Accept an invitation: creates the account server-side and auto-logs in.
 * The resulting token pair is stored in the main process (never the renderer).
 */
export async function acceptInvite(
	token: string,
	displayName: string,
	password: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/invitations/accept", {
		token,
		display_name: displayName,
		password,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function createInvite(payload: {
	email: string;
	role?: string;
	project_id?: string | null;
	project_role?: string | null;
}): Promise<
	{ ok: true; data: CreateInvitationResult } | { ok: false; error: string }
> {
	return authedFetch<CreateInvitationResult>(
		"/auth/invitations",
		"POST",
		payload,
	);
}

export async function listInvites(): Promise<
	{ ok: true; data: InvitationPublic[] } | { ok: false; error: string }
> {
	return authedFetch<InvitationPublic[]>("/auth/invitations", "GET");
}

export async function revokeInvite(
	invitationId: string,
): Promise<{ ok: true; data: { revoked: boolean } } | { ok: false; error: string }> {
	return authedFetch<{ revoked: boolean }>(
		`/auth/invitations/${encodeURIComponent(invitationId)}`,
		"DELETE",
	);
}

export async function loginLocal(
	email: string,
	password: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/login", {
		email,
		password,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function loginWithEntraIdToken(
	idToken: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/oidc/exchange", {
		id_token: idToken,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function refreshSession(): Promise<boolean> {
	if (!refreshToken) return false;
	const result = await serverFetch<TokenResponse>("/auth/refresh", {
		refresh_token: refreshToken,
	});
	if (!result.ok) {
		console.warn("[server-connection] Refresh failed:", result.error);
		clearSession();
		persist();
		return false;
	}
	applyTokens(result.data);
	return true;
}

export async function logout(): Promise<void> {
	if (refreshToken && serverUrl) {
		await serverFetch("/auth/logout", { refresh_token: refreshToken }).catch(
			() => undefined,
		);
	}
	clearSession();
	persist();
}

/**
 * Try to restore a session at startup from the persisted refresh token.
 */
export async function restoreSession(): Promise<boolean> {
	if (accessToken) return true; // already restored this run
	if (!isServerMode() || !refreshToken) return false;
	// Share a single in-flight refresh so a concurrent main + renderer restore
	// does not rotate the refresh token twice (the second call would fail).
	if (restoreInFlight) return restoreInFlight;
	restoreInFlight = refreshSession().finally(() => {
		restoreInFlight = null;
	});
	return restoreInFlight;
}
