import type { ProjectEnvConfig } from "@shared/types/project";
import { useProjectEnvStore } from "../../stores/project-env-store";
import type { SetupCategory, SetupStatus } from "../setup-hub/useSetupStatus";
import { GUIDE_ANCHORS } from "./anchors";
import type { GuidedStep } from "./guided-tour-store";

/**
 * Static "journey" definitions: the sub-steps that walk a user through
 * configuring one checklist item. The Setup Hub item id (e.g. "github",
 * "jira") maps to its journey here. `buildTodoTour` then keeps only the
 * journeys for items still in the `todo` state and flattens them in order.
 *
 * Each step's `condition` reads the LIVE env config from the store so the
 * "Next" gate reflects what the user just typed, regardless of re-renders.
 */

const env = (): ProjectEnvConfig | null =>
	useProjectEnvStore.getState().envConfig;

const nonEmpty = (v: unknown): boolean =>
	typeof v === "string" && v.trim().length > 0;

/** Map of Setup-Hub item id -> ordered guided steps. */
type JourneyTable = Record<string, Omit<GuidedStep, "section">[]>;

const PROJECT_JOURNEYS: JourneyTable = {
	github: [
		{
			anchor: GUIDE_ANCHORS.github.enable,
			titleKey: "steps.github.enable.title",
			descKey: "steps.github.enable.desc",
			condition: () => Boolean(env()?.githubEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.github.token,
			titleKey: "steps.github.token.title",
			descKey: "steps.github.token.desc",
			condition: () => nonEmpty(env()?.githubToken),
		},
		{
			anchor: GUIDE_ANCHORS.github.repo,
			titleKey: "steps.github.repo.title",
			descKey: "steps.github.repo.desc",
			optional: true,
		},
	],
	gitlab: [
		{
			anchor: GUIDE_ANCHORS.gitlab.enable,
			titleKey: "steps.gitlab.enable.title",
			descKey: "steps.gitlab.enable.desc",
			condition: () => Boolean(env()?.gitlabEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.gitlab.token,
			titleKey: "steps.gitlab.token.title",
			descKey: "steps.gitlab.token.desc",
			condition: () => nonEmpty(env()?.gitlabToken),
		},
		{
			anchor: GUIDE_ANCHORS.gitlab.instanceUrl,
			titleKey: "steps.gitlab.instanceUrl.title",
			descKey: "steps.gitlab.instanceUrl.desc",
			optional: true,
		},
		{
			anchor: GUIDE_ANCHORS.gitlab.project,
			titleKey: "steps.gitlab.project.title",
			descKey: "steps.gitlab.project.desc",
			optional: true,
		},
	],
	azureDevOps: [
		{
			anchor: GUIDE_ANCHORS.azureDevOps.enable,
			titleKey: "steps.azureDevOps.enable.title",
			descKey: "steps.azureDevOps.enable.desc",
			condition: () => Boolean(env()?.azureDevOpsEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.azureDevOps.orgUrl,
			titleKey: "steps.azureDevOps.orgUrl.title",
			descKey: "steps.azureDevOps.orgUrl.desc",
			condition: () => nonEmpty(env()?.azureDevOpsOrgUrl),
		},
		{
			anchor: GUIDE_ANCHORS.azureDevOps.pat,
			titleKey: "steps.azureDevOps.pat.title",
			descKey: "steps.azureDevOps.pat.desc",
			condition: () => nonEmpty(env()?.azureDevOpsPat),
		},
		{
			anchor: GUIDE_ANCHORS.azureDevOps.repository,
			titleKey: "steps.azureDevOps.repository.title",
			descKey: "steps.azureDevOps.repository.desc",
			optional: true,
		},
	],
	jira: [
		{
			anchor: GUIDE_ANCHORS.jira.enable,
			titleKey: "steps.jira.enable.title",
			descKey: "steps.jira.enable.desc",
			condition: () => Boolean(env()?.jiraEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.jira.instanceUrl,
			titleKey: "steps.jira.instanceUrl.title",
			descKey: "steps.jira.instanceUrl.desc",
			condition: () => nonEmpty(env()?.jiraInstanceUrl),
		},
		{
			anchor: GUIDE_ANCHORS.jira.email,
			titleKey: "steps.jira.email.title",
			descKey: "steps.jira.email.desc",
			condition: () => nonEmpty(env()?.jiraEmail),
		},
		{
			anchor: GUIDE_ANCHORS.jira.token,
			titleKey: "steps.jira.token.title",
			descKey: "steps.jira.token.desc",
			condition: () => nonEmpty(env()?.jiraApiToken),
		},
		{
			anchor: GUIDE_ANCHORS.jira.projectKey,
			titleKey: "steps.jira.projectKey.title",
			descKey: "steps.jira.projectKey.desc",
			optional: true,
		},
	],
	linear: [
		{
			anchor: GUIDE_ANCHORS.linear.enable,
			titleKey: "steps.linear.enable.title",
			descKey: "steps.linear.enable.desc",
			condition: () => Boolean(env()?.linearEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.linear.apiKey,
			titleKey: "steps.linear.apiKey.title",
			descKey: "steps.linear.apiKey.desc",
			condition: () => nonEmpty(env()?.linearApiKey),
		},
	],
	memory: [
		{
			anchor: GUIDE_ANCHORS.memory.enable,
			titleKey: "steps.memory.enable.title",
			descKey: "steps.memory.enable.desc",
			condition: () => Boolean(env()?.graphitiEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.memory.embeddingProvider,
			titleKey: "steps.memory.embeddingProvider.title",
			descKey: "steps.memory.embeddingProvider.desc",
			optional: true,
		},
	],
	cicd: [
		{
			anchor: GUIDE_ANCHORS.cicd.provider,
			titleKey: "steps.cicd.provider.title",
			descKey: "steps.cicd.provider.desc",
			condition: () => {
				const p = env()?.cicdProvider;
				return nonEmpty(p) && p !== "none";
			},
		},
	],
	notifications: [
		{
			anchor: GUIDE_ANCHORS.notifications.enable("slack"),
			titleKey: "steps.notifications.enable.title",
			descKey: "steps.notifications.enable.desc",
			condition: () => Boolean(env()?.slackNotificationsEnabled),
		},
		{
			anchor: GUIDE_ANCHORS.notifications.webhook("slack"),
			titleKey: "steps.notifications.webhook.title",
			descKey: "steps.notifications.webhook.desc",
			condition: () => nonEmpty(env()?.slackWebhookUrl),
		},
	],
};

/** The single AI-providers step lives in the app-level accounts section. */
const PROVIDERS_JOURNEY: Omit<GuidedStep, "section">[] = [
	{
		anchor: GUIDE_ANCHORS.providers.configure,
		titleKey: "steps.providers.configure.title",
		descKey: "steps.providers.configure.desc",
		// No live condition: configuring a provider happens in a nested dialog
		// we don't drive step-by-step. Treated as informational/optional.
		optional: true,
	},
];

/**
 * Build the guided tour for everything still left to configure.
 * Pure — given a SetupStatus, returns the flattened, ordered step list with
 * each step's `section` deep-link attached. Items already `done` are skipped.
 */
export function buildTodoTour(status: SetupStatus): GuidedStep[] {
	const steps: GuidedStep[] = [];

	const emit = (category: SetupCategory) => {
		for (const item of category.items) {
			if (item.state === "done") continue;
			const journey =
				item.id === "providers"
					? PROVIDERS_JOURNEY
					: PROJECT_JOURNEYS[item.id];
			if (!journey) continue;
			for (const partial of journey) {
				steps.push({ ...partial, section: item.deepLink });
			}
		}
	};

	// Categories are already priority-ordered by useSetupStatus.
	for (const category of status.categories) emit(category);

	return steps;
}
