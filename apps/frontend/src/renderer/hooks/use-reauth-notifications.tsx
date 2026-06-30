/**
 * Re-authentication Notifications Hook
 *
 * Surfaces a toast whenever a provider account's token can no longer be
 * refreshed automatically (refresh token revoked / expired / missing) and
 * therefore requires the user to sign in again.
 *
 * Provider-agnostic: reacts to the `needsReauthentication` flag carried by
 * both the active-provider usage snapshot (`onUsageUpdated`) and the
 * multi-profile payload (`onAllProfilesUsageUpdated`). Claude/Anthropic,
 * GitHub Copilot, OpenAI, Windsurf, … all flow through the same signal.
 *
 * The toast offers a one-click "Reconnect" action that opens
 * Settings → Accounts where every provider's re-auth flow lives.
 *
 * Deduplication: one toast per account until it recovers. When the flag
 * clears (successful re-auth or auto-refresh), the account is removed from
 * the notified set so a future failure can notify again.
 */

import type {
	AllProfilesUsage,
	ProfileUsageSummary,
	UsageSnapshot,
} from "@shared/types";
import {
	type ApiProvider,
	getProviderLabel,
} from "@shared/utils/provider-detection";
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AppSection } from "@/components/settings/AppSettings";
import { ToastAction } from "../components/ui/toast";
import { toast } from "./use-toast";

/** How long the re-auth toast stays visible (ms). Long enough to be noticed. */
const REAUTH_TOAST_DURATION_MS = 15000;

/**
 * Open Settings → Accounts, where every provider exposes its re-auth flow.
 * Mirrors the navigation used by UsageIndicator's ReauthContent.
 */
function openAccountsSettings(): void {
	const event = new CustomEvent<AppSection>("open-app-settings", {
		detail: "accounts",
	});
	globalThis.dispatchEvent(event);
}

export function useReauthNotifications(): void {
	const { t } = useTranslation(["common"]);
	// Accounts (keyed by profileId) we have already notified about, so we don't
	// spam a new toast on every 30s/60s polling cycle.
	const notifiedRef = useRef<Set<string>>(new Set());

	const notify = useCallback(
		(key: string, providerName: string | undefined, accountName?: string) => {
			if (notifiedRef.current.has(key)) return;
			notifiedRef.current.add(key);

			const providerLabel = getProviderLabel(
				(providerName ?? "anthropic") as ApiProvider,
			);

			const description = accountName
				? t("common:usage.reauthToastDescriptionAccount", {
						account: accountName,
						provider: providerLabel,
					})
				: t("common:usage.reauthToastDescription", {
						provider: providerLabel,
					});

			toast({
				variant: "destructive",
				duration: REAUTH_TOAST_DURATION_MS,
				// `title` collides with the HTML title attribute on Radix Toast.Root,
				// so it must be a plain string — the icon goes in the description.
				title: t("common:usage.reauthToastTitle"),
				description: (
					<span className="flex items-start gap-2">
						<LogIn className="h-3.5 w-3.5 mt-0.5 shrink-0" />
						<span>{description}</span>
					</span>
				),
				action: (
					<ToastAction
						altText={t("common:usage.reauthToastAction")}
						onClick={openAccountsSettings}
					>
						{t("common:usage.reauthToastAction")}
					</ToastAction>
				),
			});
		},
		[t],
	);

	/** Clear an account from the notified set once it recovers. */
	const resolve = useCallback((key: string) => {
		notifiedRef.current.delete(key);
	}, []);

	const processProfile = useCallback(
		(profile: ProfileUsageSummary, providerName: string | undefined) => {
			const key = profile.profileId;
			if (!key) return;
			if (profile.needsReauthentication) {
				notify(key, providerName, profile.profileName || profile.profileEmail);
			} else {
				resolve(key);
			}
		},
		[notify, resolve],
	);

	const processSnapshot = useCallback(
		(snapshot: UsageSnapshot) => {
			const key = snapshot.profileId || snapshot.providerName || "active";
			if (snapshot.needsReauthentication) {
				notify(
					key,
					snapshot.providerName,
					snapshot.profileName || snapshot.profileEmail,
				);
			} else {
				resolve(key);
			}
		},
		[notify, resolve],
	);

	const processAllProfiles = useCallback(
		(payload: AllProfilesUsage) => {
			// Claude/Anthropic multi-profile payload (provider is always anthropic here).
			for (const profile of payload.allProfiles) {
				processProfile(profile, "anthropic");
			}
		},
		[processProfile],
	);

	useEffect(() => {
		const api = globalThis.electronAPI;
		if (!api) return;

		const unsubscribeUsage = api.onUsageUpdated?.(processSnapshot);
		const unsubscribeAll =
			api.onAllProfilesUsageUpdated?.(processAllProfiles);

		// Best-effort initial read so a token that is already revoked at launch
		// surfaces a toast without waiting for the first polling cycle.
		api
			.requestAllProfilesUsage?.()
			.then((result) => {
				if (result?.success && result.data) processAllProfiles(result.data);
			})
			.catch(() => {
				/* non-fatal: events will deliver the state shortly */
			});

		return () => {
			unsubscribeUsage?.();
			unsubscribeAll?.();
		};
	}, [processSnapshot, processAllProfiles]);
}
