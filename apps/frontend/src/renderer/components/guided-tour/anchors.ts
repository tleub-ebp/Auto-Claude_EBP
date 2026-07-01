/**
 * Stable `data-guide` anchor keys for the guided tour.
 *
 * Single source of truth shared between the JSX that renders each target
 * (`data-guide={GUIDE_ANCHORS.jira.token}`) and the step registry that points
 * the spotlight at it. Centralising the strings avoids silent typos drifting
 * between the two sides.
 *
 * Convention: `data-guide="<section>.<field>"`. The DOM attribute lands on the
 * actual focusable element (input / [role=switch] / [role=combobox] / button).
 */
export const GUIDE_ANCHORS = {
	providers: {
		// Rendered on every UNconfigured provider card's "Configure" button;
		// querySelector returns the first one in DOM order.
		configure: "providers.configure",
	},
	github: {
		enable: "github.enable",
		token: "github.token",
		repo: "github.repo",
	},
	gitlab: {
		enable: "gitlab.enable",
		token: "gitlab.token",
		instanceUrl: "gitlab.instanceUrl",
		project: "gitlab.project",
	},
	azureDevOps: {
		enable: "azureDevOps.enable",
		orgUrl: "azureDevOps.orgUrl",
		pat: "azureDevOps.pat",
		repository: "azureDevOps.repository",
	},
	jira: {
		enable: "jira.enable",
		instanceUrl: "jira.instanceUrl",
		email: "jira.email",
		token: "jira.token",
		projectKey: "jira.projectKey",
	},
	linear: {
		enable: "linear.enable",
		apiKey: "linear.apiKey",
	},
	memory: {
		enable: "memory.enable",
		embeddingProvider: "memory.embeddingProvider",
	},
	cicd: {
		provider: "cicd.provider",
	},
	notifications: {
		// Per channel, e.g. "notif.slack.enable" / "notif.slack.webhook".
		enable: (channel: string) => `notif.${channel}.enable`,
		webhook: (channel: string) => `notif.${channel}.webhook`,
	},
} as const;

/** Build the attribute object to spread onto a target element. */
export const guideAttr = (anchor: string) => ({ "data-guide": anchor });

/** CSS selector for a given anchor. */
export const guideSelector = (anchor: string) =>
	`[data-guide="${anchor}"]`;
