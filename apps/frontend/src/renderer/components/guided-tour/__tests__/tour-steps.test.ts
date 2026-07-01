import type { ProjectEnvConfig } from "@shared/types/project";
import { describe, expect, it } from "vitest";
import { computeSetupCategories } from "../../setup-hub/useSetupStatus";
import { GUIDE_ANCHORS } from "../anchors";
import { buildTodoTour } from "../tour-steps";

/** Minimal env config; only `graphitiEnabled` is required by the type. */
const env = (overrides: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig =>
	({ graphitiEnabled: false, ...overrides }) as ProjectEnvConfig;

/** All anchors present in the produced tour, in order. */
const anchorsOf = (status: ReturnType<typeof computeSetupCategories>) =>
	buildTodoTour(status).map((s) => s.anchor);

describe("buildTodoTour", () => {
	it("emits journeys only for items still in 'todo' state", () => {
		// GitHub configured (done) -> skipped; Jira not configured -> included.
		const status = computeSetupCategories(
			{ anthropic: true }, // providers done -> providers step skipped
			env({ githubEnabled: true, githubToken: "ghp_x" }),
		);
		const anchors = anchorsOf(status);

		// GitHub done -> none of its steps.
		expect(anchors).not.toContain(GUIDE_ANCHORS.github.enable);
		// Providers done -> no providers step.
		expect(anchors).not.toContain(GUIDE_ANCHORS.providers.configure);
		// Jira still todo -> its enable step is present.
		expect(anchors).toContain(GUIDE_ANCHORS.jira.enable);
	});

	it("orders the toggle step before the field steps within a journey", () => {
		const status = computeSetupCategories({}, env());
		const anchors = anchorsOf(status);
		const enableIdx = anchors.indexOf(GUIDE_ANCHORS.jira.enable);
		const tokenIdx = anchors.indexOf(GUIDE_ANCHORS.jira.token);
		expect(enableIdx).toBeGreaterThanOrEqual(0);
		expect(tokenIdx).toBeGreaterThan(enableIdx);
	});

	it("keeps AI providers before project integrations (category priority)", () => {
		const status = computeSetupCategories({}, env()); // nothing configured
		const anchors = anchorsOf(status);
		const providersIdx = anchors.indexOf(GUIDE_ANCHORS.providers.configure);
		const githubIdx = anchors.indexOf(GUIDE_ANCHORS.github.enable);
		expect(providersIdx).toBe(0);
		expect(githubIdx).toBeGreaterThan(providersIdx);
	});

	it("attaches the correct deep-link section to each step", () => {
		const status = computeSetupCategories({}, env());
		const steps = buildTodoTour(status);
		const jiraStep = steps.find((s) => s.anchor === GUIDE_ANCHORS.jira.token);
		expect(jiraStep?.section).toEqual({ kind: "project", section: "jira" });
		const providerStep = steps.find(
			(s) => s.anchor === GUIDE_ANCHORS.providers.configure,
		);
		expect(providerStep?.section).toEqual({ kind: "app", section: "accounts" });
	});

	it("produces an empty tour when everything is configured", () => {
		const status = computeSetupCategories(
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
		expect(buildTodoTour(status)).toHaveLength(0);
	});

	it("marks toggle/field steps with a condition and optional steps without", () => {
		const status = computeSetupCategories({}, env());
		const steps = buildTodoTour(status);
		const enable = steps.find((s) => s.anchor === GUIDE_ANCHORS.jira.enable);
		const projectKey = steps.find(
			(s) => s.anchor === GUIDE_ANCHORS.jira.projectKey,
		);
		expect(typeof enable?.condition).toBe("function");
		expect(projectKey?.optional).toBe(true);
		expect(projectKey?.condition).toBeUndefined();
	});
});
