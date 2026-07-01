import type { ProjectEnvConfig } from "@shared/types/project";
import { useEffect, useMemo, useState } from "react";
import { getStaticProviders } from "../../../shared/utils/providers";
import { useProjectEnvStore } from "../../stores/project-env-store";
import { useSettingsStore } from "../../stores/settings-store";
import type { AppSection, ProjectSettingsSection } from "../settings/AppSettings";

/**
 * Status aggregation for the Setup Hub ("Centre de configuration").
 *
 * The hub presents a guided, ordered checklist of what the user still needs to
 * configure to unlock WorkPilot features. We deliberately reuse the existing
 * sources of truth instead of recomputing them:
 *  - AI providers: `getStaticProviders(profiles, settings)` — same call the
 *    "Comptes IA" screen uses, so the configured count stays consistent.
 *  - Project integrations: the `ProjectEnvConfig` already loaded into
 *    `useProjectEnvStore` (no extra IPC round-trip).
 *
 * The pure `computeSetupCategories` function holds all the logic so it can be
 * unit-tested without React or the Electron bridge.
 */

export type SetupItemState = "done" | "todo" | "error";

/** Where a checklist item deep-links to inside the Settings dialog. */
export type SetupDeepLink =
	| { kind: "app"; section: AppSection }
	| { kind: "project"; section: ProjectSettingsSection };

export interface SetupItem {
	/** Stable id, also used as the i18n sub-key under `setupHub.items`. */
	id: string;
	state: SetupItemState;
	deepLink: SetupDeepLink;
	/** Only set for the aggregated AI-providers row. */
	progress?: { configured: number; total: number };
}

export interface SetupCategory {
	/** Stable id, also used as the i18n sub-key under `setupHub.categories`. */
	id: string;
	/** Mirrors the Settings theme `priority` so the hub follows the same order. */
	priority: number;
	items: SetupItem[];
}

export interface SetupStatus {
	categories: SetupCategory[];
	completed: number;
	total: number;
	/** 0-100, rounded. 100 when there is nothing left to configure. */
	percent: number;
}

/** Treat a credential string as present only when it has non-whitespace content. */
function hasValue(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * An integration counts as configured when it is both explicitly enabled and
 * carries the credential it needs to actually work. Enabled-without-credential
 * stays `todo` (the user started but did not finish).
 */
function integrationItem(
	id: string,
	enabled: boolean | undefined,
	hasCredential: boolean,
	deepLink: SetupDeepLink,
): SetupItem {
	return {
		id,
		state: enabled && hasCredential ? "done" : "todo",
		deepLink,
	};
}

/**
 * Build the ordered checklist from already-resolved status inputs.
 * Pure — safe to unit test. AI status is pre-resolved into `providerStatus`
 * (which already folds in profiles + global keys), so settings aren't needed here.
 */
export function computeSetupCategories(
	providerStatus: Record<string, boolean>,
	env: ProjectEnvConfig | null,
): SetupStatus {
	// ── AI providers: a single aggregated row that mirrors the accounts screen.
	const providerNames = Object.keys(providerStatus);
	const configuredProviders = providerNames.filter(
		(name) => providerStatus[name],
	).length;
	const hasAnyProvider = configuredProviders > 0;

	const aiCategory: SetupCategory = {
		id: "ai",
		priority: 2,
		items: [
			{
				id: "providers",
				state: hasAnyProvider ? "done" : "todo",
				deepLink: { kind: "app", section: "accounts" },
				progress: { configured: configuredProviders, total: providerNames.length },
			},
		],
	};

	// ── Project integrations: read straight off the loaded env config.
	const integrationsCategory: SetupCategory = {
		id: "integrations",
		priority: 3,
		items: [
			integrationItem("github", env?.githubEnabled, hasValue(env?.githubToken), {
				kind: "project",
				section: "github",
			}),
			integrationItem("gitlab", env?.gitlabEnabled, hasValue(env?.gitlabToken), {
				kind: "project",
				section: "gitlab",
			}),
			integrationItem(
				"azureDevOps",
				env?.azureDevOpsEnabled,
				hasValue(env?.azureDevOpsPat),
				{ kind: "project", section: "azure-devops" },
			),
			integrationItem("jira", env?.jiraEnabled, hasValue(env?.jiraApiToken), {
				kind: "project",
				section: "jira",
			}),
			integrationItem("linear", env?.linearEnabled, hasValue(env?.linearApiKey), {
				kind: "project",
				section: "linear",
			}),
			// Memory/Graphiti has no single credential — enabled is enough.
			integrationItem("memory", env?.graphitiEnabled, true, {
				kind: "project",
				section: "memory",
			}),
			// CI/CD is "configured" once a real provider is chosen
			// ("" means auto-detect / unset, "none" means explicitly disabled).
			integrationItem(
				"cicd",
				hasValue(env?.cicdProvider) && env?.cicdProvider !== "none",
				true,
				{ kind: "project", section: "cicd" },
			),
			// Notifications: any one channel enabled + its webhook counts as done.
			integrationItem(
				"notifications",
				hasAnyNotificationChannel(env),
				true,
				{ kind: "project", section: "teams" },
			),
		],
	};

	const categories = [aiCategory, integrationsCategory].sort(
		(a, b) => a.priority - b.priority,
	);

	const allItems = categories.flatMap((c) => c.items);
	const total = allItems.length;
	const completed = allItems.filter((i) => i.state === "done").length;
	const percent = total === 0 ? 100 : Math.round((completed / total) * 100);

	return { categories, completed, total, percent };
}

/** True when at least one notification channel is enabled with its webhook set. */
function hasAnyNotificationChannel(env: ProjectEnvConfig | null): boolean {
	if (!env) return false;
	return Boolean(
		(env.teamsNotificationsEnabled && hasValue(env.teamsWebhookUrl)) ||
			(env.slackNotificationsEnabled && hasValue(env.slackWebhookUrl)) ||
			(env.discordNotificationsEnabled && hasValue(env.discordWebhookUrl)) ||
			(env.googleChatNotificationsEnabled &&
				hasValue(env.googleChatWebhookUrl)) ||
			(env.notifyWebhookEnabled && hasValue(env.notifyWebhookUrl)),
	);
}

/**
 * Live setup status for the current settings + selected project.
 * Resolves AI provider status asynchronously (it reads profiles + global keys).
 */
export function useSetupStatus(): SetupStatus {
	const settings = useSettingsStore((s) => s.settings);
	const profiles = useSettingsStore((s) => s.profiles);
	const envConfig = useProjectEnvStore((s) => s.envConfig);

	const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>(
		{},
	);

	useEffect(() => {
		let cancelled = false;
		getStaticProviders(profiles, settings as unknown as Record<string, unknown>)
			.then((res) => {
				if (!cancelled) setProviderStatus(res.status);
			})
			.catch(() => {
				if (!cancelled) setProviderStatus({});
			});
		return () => {
			cancelled = true;
		};
	}, [profiles, settings]);

	return useMemo(
		() => computeSetupCategories(providerStatus, envConfig),
		[providerStatus, envConfig],
	);
}
