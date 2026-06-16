/**
 * IPC handlers for multi-user server mode: connection, login (local +
 * Microsoft Entra ID PKCE), session state.
 *
 * The Entra flow is the standard public-client Authorization Code + PKCE:
 * system browser -> loopback redirect -> token exchange from the main
 * process -> id_token handed to the WorkPilot server, which answers with
 * its own JWT pair (see apps/backend/server/auth/oidc.py).
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import { type BrowserWindow, ipcMain, shell } from "electron";
import {
	acceptInvite,
	createInvite,
	getAuthState,
	getServerAuthConfig,
	listInvites,
	loginLocal,
	loginWithEntraIdToken,
	logout,
	lookupInvite,
	restoreSession,
	revokeInvite,
	setMode,
} from "../server-connection";

const ENTRA_SCOPES = "openid profile email";
const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

function base64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

interface EntraConfig {
	entra_tenant_id: string;
	entra_client_id: string;
}

/**
 * Run the browser PKCE dance and resolve with the Entra id_token.
 */
async function acquireEntraIdToken(config: EntraConfig): Promise<string> {
	const verifier = base64Url(crypto.randomBytes(48));
	const challenge = base64Url(
		crypto.createHash("sha256").update(verifier).digest(),
	);
	const state = base64Url(crypto.randomBytes(16));

	const code = await new Promise<string>((resolve, reject) => {
		const server = http.createServer();
		const timeout = setTimeout(() => {
			server.close();
			reject(new Error("Login timed out (5 minutes)"));
		}, LOOPBACK_TIMEOUT_MS);

		server.on("request", (req, res) => {
			const url = new URL(req.url || "/", "http://localhost");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get("error_description");
			const returnedState = url.searchParams.get("state");
			const authCode = url.searchParams.get("code");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<html><body style='font-family:sans-serif'><h3>WorkPilot AI</h3>" +
					"<p>Connexion terminée, vous pouvez fermer cet onglet.</p></body></html>",
			);
			clearTimeout(timeout);
			server.close();
			if (error) reject(new Error(error));
			else if (returnedState !== state) reject(new Error("State mismatch"));
			else if (!authCode) reject(new Error("No authorization code returned"));
			else resolve(authCode);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const redirectUri = `http://localhost:${port}/callback`;
			const authorizeUrl =
				`https://login.microsoftonline.com/${config.entra_tenant_id}/oauth2/v2.0/authorize` +
				`?client_id=${encodeURIComponent(config.entra_client_id)}` +
				"&response_type=code" +
				`&redirect_uri=${encodeURIComponent(redirectUri)}` +
				`&scope=${encodeURIComponent(ENTRA_SCOPES)}` +
				`&state=${state}` +
				`&code_challenge=${challenge}` +
				"&code_challenge_method=S256";
			// Stash the redirect URI for the token exchange below.
			(server as { _redirectUri?: string })._redirectUri = redirectUri;
			pendingRedirectUri = redirectUri;
			void shell.openExternal(authorizeUrl);
		});
	});

	const tokenRes = await fetch(
		`https://login.microsoftonline.com/${config.entra_tenant_id}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: config.entra_client_id,
				grant_type: "authorization_code",
				code,
				redirect_uri: pendingRedirectUri,
				code_verifier: verifier,
				scope: ENTRA_SCOPES,
			}).toString(),
		},
	);
	const tokenJson = (await tokenRes.json()) as {
		id_token?: string;
		error_description?: string;
	};
	if (!tokenRes.ok || !tokenJson.id_token) {
		throw new Error(tokenJson.error_description || "Token exchange failed");
	}
	return tokenJson.id_token;
}

let pendingRedirectUri = "";

export function registerServerAuthHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	const notifyRenderer = () => {
		getMainWindow()?.webContents.send(
			"server-auth:state-changed",
			getAuthState(),
		);
	};

	ipcMain.handle("server-auth:get-state", () => getAuthState());

	ipcMain.handle(
		"server-auth:get-config",
		async (_e, serverUrl: string) => await getServerAuthConfig(serverUrl),
	);

	ipcMain.handle(
		"server-auth:set-mode",
		(_e, mode: "local" | "server", serverUrl?: string) => {
			setMode(mode, serverUrl);
			notifyRenderer();
			return getAuthState();
		},
	);

	ipcMain.handle(
		"server-auth:login-local",
		async (_e, serverUrl: string, email: string, password: string) => {
			setMode("server", serverUrl);
			const result = await loginLocal(email, password);
			notifyRenderer();
			return result;
		},
	);

	ipcMain.handle(
		"server-auth:login-entra",
		async (_e, serverUrl: string) => {
			setMode("server", serverUrl);
			const config = await getServerAuthConfig(serverUrl);
			if (!config.ok) return config;
			if (!config.data.entra_enabled || !config.data.entra_tenant_id) {
				return {
					ok: false as const,
					error: "Entra ID n'est pas configuré sur ce serveur",
				};
			}
			try {
				const idToken = await acquireEntraIdToken({
					entra_tenant_id: config.data.entra_tenant_id,
					entra_client_id: config.data.entra_client_id as string,
				});
				const result = await loginWithEntraIdToken(idToken);
				notifyRenderer();
				return result;
			} catch (err) {
				return {
					ok: false as const,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);

	// --- Invitation-only self-service signup ---

	ipcMain.handle(
		"server-auth:lookup-invite",
		async (_e, serverUrl: string, token: string) =>
			await lookupInvite(serverUrl, token),
	);

	ipcMain.handle(
		"server-auth:accept-invite",
		async (
			_e,
			serverUrl: string,
			token: string,
			displayName: string,
			password: string,
		) => {
			setMode("server", serverUrl);
			const result = await acceptInvite(token, displayName, password);
			notifyRenderer();
			return result;
		},
	);

	ipcMain.handle(
		"server-auth:create-invite",
		async (
			_e,
			payload: {
				email: string;
				role?: string;
				project_id?: string | null;
				project_role?: string | null;
			},
		) => await createInvite(payload),
	);

	ipcMain.handle(
		"server-auth:list-invites",
		async () => await listInvites(),
	);

	ipcMain.handle(
		"server-auth:revoke-invite",
		async (_e, invitationId: string) => await revokeInvite(invitationId),
	);

	ipcMain.handle("server-auth:logout", async () => {
		await logout();
		notifyRenderer();
		return getAuthState();
	});

	ipcMain.handle("server-auth:restore", async () => {
		await restoreSession();
		notifyRenderer();
		return getAuthState();
	});
}
