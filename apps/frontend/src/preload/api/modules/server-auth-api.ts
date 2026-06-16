/**
 * Server Auth API — renderer bridge for multi-user server mode
 * (connection, login local / Microsoft Entra ID, session state).
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

export interface ServerAuthState {
	mode: "local" | "server";
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	// True once the user has made an explicit connection choice (server login
	// or local mode). Drives the first-launch login gate.
	configured: boolean;
}

export interface ServerAuthConfig {
	local_enabled: boolean;
	entra_enabled: boolean;
	entra_tenant_id: string | null;
	entra_client_id: string | null;
}

export type ServerAuthResult =
	| { ok: true; user: ServerUser }
	| { ok: false; error: string };

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

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ServerAuthAPI {
	getState: () => Promise<ServerAuthState>;
	getConfig: (
		serverUrl: string,
	) => Promise<{ ok: true; data: ServerAuthConfig } | { ok: false; error: string }>;
	setMode: (
		mode: "local" | "server",
		serverUrl?: string,
	) => Promise<ServerAuthState>;
	loginLocal: (
		serverUrl: string,
		email: string,
		password: string,
	) => Promise<ServerAuthResult>;
	loginEntra: (serverUrl: string) => Promise<ServerAuthResult>;
	lookupInvite: (
		serverUrl: string,
		token: string,
	) => Promise<DataResult<InviteLookup>>;
	acceptInvite: (
		serverUrl: string,
		token: string,
		displayName: string,
		password: string,
	) => Promise<ServerAuthResult>;
	createInvite: (payload: {
		email: string;
		role?: string;
		project_id?: string | null;
		project_role?: string | null;
	}) => Promise<DataResult<CreateInvitationResult>>;
	listInvites: () => Promise<DataResult<InvitationPublic[]>>;
	revokeInvite: (
		invitationId: string,
	) => Promise<DataResult<{ revoked: boolean }>>;
	logout: () => Promise<ServerAuthState>;
	restore: () => Promise<ServerAuthState>;
	onStateChanged: (callback: (state: ServerAuthState) => void) => () => void;
}

export const createServerAuthAPI = (): ServerAuthAPI => ({
	getState: () => invokeIpc<ServerAuthState>("server-auth:get-state"),
	getConfig: (serverUrl) => invokeIpc("server-auth:get-config", serverUrl),
	setMode: (mode, serverUrl) =>
		invokeIpc<ServerAuthState>("server-auth:set-mode", mode, serverUrl),
	loginLocal: (serverUrl, email, password) =>
		invokeIpc<ServerAuthResult>(
			"server-auth:login-local",
			serverUrl,
			email,
			password,
		),
	loginEntra: (serverUrl) =>
		invokeIpc<ServerAuthResult>("server-auth:login-entra", serverUrl),
	lookupInvite: (serverUrl, token) =>
		invokeIpc<DataResult<InviteLookup>>(
			"server-auth:lookup-invite",
			serverUrl,
			token,
		),
	acceptInvite: (serverUrl, token, displayName, password) =>
		invokeIpc<ServerAuthResult>(
			"server-auth:accept-invite",
			serverUrl,
			token,
			displayName,
			password,
		),
	createInvite: (payload) =>
		invokeIpc<DataResult<CreateInvitationResult>>(
			"server-auth:create-invite",
			payload,
		),
	listInvites: () =>
		invokeIpc<DataResult<InvitationPublic[]>>("server-auth:list-invites"),
	revokeInvite: (invitationId) =>
		invokeIpc<DataResult<{ revoked: boolean }>>(
			"server-auth:revoke-invite",
			invitationId,
		),
	logout: () => invokeIpc<ServerAuthState>("server-auth:logout"),
	restore: () => invokeIpc<ServerAuthState>("server-auth:restore"),
	onStateChanged: (callback) =>
		createIpcListener<[ServerAuthState]>("server-auth:state-changed", (state) =>
			callback(state),
		),
});
