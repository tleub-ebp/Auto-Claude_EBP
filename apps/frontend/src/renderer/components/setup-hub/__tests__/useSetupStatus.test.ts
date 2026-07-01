import type { ProjectEnvConfig } from "@shared/types/project";
import { describe, expect, it } from "vitest";
import {
	computeSetupCategories,
	type SetupItem,
} from "../useSetupStatus";

/** Minimal env config; `graphitiEnabled` is the only required field on the type. */
const env = (overrides: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig =>
	({ graphitiEnabled: false, ...overrides }) as ProjectEnvConfig;

/** Pull a single item out of the computed result by category + item id. */
const find = (
	result: ReturnType<typeof computeSetupCategories>,
	categoryId: string,
	itemId: string,
): SetupItem => {
	const item = result.categories
		.find((c) => c.id === categoryId)
		?.items.find((i) => i.id === itemId);
	if (!item) throw new Error(`item ${categoryId}/${itemId} not found`);
	return item;
};

describe("computeSetupCategories", () => {
	it("with no providers and empty env, everything is 'todo' and percent is low", () => {
		const result = computeSetupCategories({}, env());
		expect(result.completed).toBe(0);
		expect(result.percent).toBe(0);
		// AI providers + 8 integrations.
		expect(result.total).toBe(9);
		expect(result.categories.every((c) => c.items.every((i) => i.state === "todo"))).toBe(
			true,
		);
	});

	it("orders categories by priority (AI before integrations)", () => {
		const result = computeSetupCategories({}, env());
		expect(result.categories.map((c) => c.id)).toEqual(["ai", "integrations"]);
	});

	it("marks AI providers 'done' when at least one provider is configured", () => {
		const result = computeSetupCategories(
			{ anthropic: true, openai: false, ollama: false },
			env(),
		);
		const providers = find(result, "ai", "providers");
		expect(providers.state).toBe("done");
		expect(providers.progress).toEqual({ configured: 1, total: 3 });
	});

	it("keeps AI providers 'todo' when none are configured", () => {
		const result = computeSetupCategories(
			{ anthropic: false, openai: false },
			env(),
		);
		expect(find(result, "ai", "providers").state).toBe("todo");
	});

	it("integration is 'done' only when enabled AND credential present", () => {
		const done = computeSetupCategories(
			{},
			env({ githubEnabled: true, githubToken: "ghp_xxx" }),
		);
		expect(find(done, "integrations", "github").state).toBe("done");

		const enabledNoToken = computeSetupCategories(
			{},
			env({ githubEnabled: true, githubToken: "" }),
		);
		expect(find(enabledNoToken, "integrations", "github").state).toBe("todo");

		const tokenNotEnabled = computeSetupCategories(
			{},
			env({ githubEnabled: false, githubToken: "ghp_xxx" }),
		);
		expect(find(tokenNotEnabled, "integrations", "github").state).toBe("todo");
	});

	it("whitespace-only credentials do not count as configured", () => {
		const result = computeSetupCategories(
			{},
			env({ jiraEnabled: true, jiraApiToken: "   " }),
		);
		expect(find(result, "integrations", "jira").state).toBe("todo");
	});

	it("CI/CD is 'done' for a real provider but not for '' or 'none'", () => {
		expect(
			find(
				computeSetupCategories({}, env({ cicdProvider: "github" })),
				"integrations",
				"cicd",
			).state,
		).toBe("done");
		expect(
			find(
				computeSetupCategories({}, env({ cicdProvider: "none" })),
				"integrations",
				"cicd",
			).state,
		).toBe("todo");
		expect(
			find(
				computeSetupCategories({}, env({ cicdProvider: "" })),
				"integrations",
				"cicd",
			).state,
		).toBe("todo");
	});

	it("memory is 'done' as soon as graphiti is enabled (no separate credential)", () => {
		expect(
			find(
				computeSetupCategories({}, env({ graphitiEnabled: true })),
				"integrations",
				"memory",
			).state,
		).toBe("done");
	});

	it("notifications need an enabled channel WITH its webhook", () => {
		const ok = computeSetupCategories(
			{},
			env({ slackNotificationsEnabled: true, slackWebhookUrl: "https://hook" }),
		);
		expect(find(ok, "integrations", "notifications").state).toBe("done");

		const missingUrl = computeSetupCategories(
			{},
			env({ slackNotificationsEnabled: true, slackWebhookUrl: "" }),
		);
		expect(find(missingUrl, "integrations", "notifications").state).toBe("todo");
	});

	it("percent reaches 100 only when every item is done", () => {
		const fullyConfigured = computeSetupCategories(
			{ anthropic: true },
			env({
				githubEnabled: true,
				githubToken: "t",
				gitlabEnabled: true,
				gitlabToken: "t",
				azureDevOpsEnabled: true,
				azureDevOpsPat: "t",
				jiraEnabled: true,
				jiraApiToken: "t",
				linearEnabled: true,
				linearApiKey: "t",
				graphitiEnabled: true,
				cicdProvider: "github",
				teamsNotificationsEnabled: true,
				teamsWebhookUrl: "https://hook",
			}),
		);
		expect(fullyConfigured.percent).toBe(100);
		expect(fullyConfigured.completed).toBe(fullyConfigured.total);
	});

	it("null env keeps integrations 'todo' but still resolves AI status", () => {
		const result = computeSetupCategories({ anthropic: true }, null);
		expect(find(result, "ai", "providers").state).toBe("done");
		expect(find(result, "integrations", "github").state).toBe("todo");
	});
});
