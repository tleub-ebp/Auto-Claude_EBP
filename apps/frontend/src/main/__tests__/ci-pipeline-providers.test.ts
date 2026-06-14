/**
 * Tests pour ci-pipeline-providers — résolution du provider CI/CD par projet
 * (explicite via CICD_PROVIDER ou auto-détection) et normalisation des états
 * de runs entre Azure DevOps, GitHub Actions, GitLab CI et Jenkins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";
import { resolvePipelineProvider } from "../ci-pipeline-providers";

// Les helpers GitHub/GitLab peuvent invoquer les CLIs gh/glab — on les neutralise.
vi.mock("../ipc-handlers/github/utils", () => ({
	getGitHubConfig: vi.fn(() => null),
	normalizeRepoReference: (repo: string) =>
		repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
}));
vi.mock("../ipc-handlers/gitlab/utils", () => ({
	getGitLabConfig: vi.fn(async () => null),
	normalizeProjectReference: (project: string) => project,
}));

const project = { id: "p1", path: "C:/tmp/proj", autoBuildPath: ".workpilot" } as Project;

describe("resolvePipelineProvider", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("retourne null sans aucune configuration", async () => {
		expect(await resolvePipelineProvider(project, {})).toBeNull();
	});

	it("auto-détecte Azure DevOps avec les variables AZURE_DEVOPS_*", async () => {
		const adapter = await resolvePipelineProvider(project, {
			AZURE_DEVOPS_PAT: "pat",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/ebp",
			AZURE_DEVOPS_PROJECT: "MeCa",
		});
		expect(adapter?.id).toBe("azure-devops");
	});

	it("accepte la famille CICD_AZURE_* (config des triggers)", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_AZURE_TOKEN: "pat",
			CICD_AZURE_ORG: "ebp",
			CICD_AZURE_PROJECT: "MeCa",
		});
		expect(adapter?.id).toBe("azure-devops");
	});

	it("sélectionne GitHub Actions explicitement via CICD_PROVIDER", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "github",
			GITHUB_TOKEN: "ghp_x",
			GITHUB_REPO: "https://github.com/ebp/meca.git",
		});
		expect(adapter?.id).toBe("github-actions");
	});

	it("sélectionne GitLab CI avec les variables CICD_GITLAB_*", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "gitlab",
			CICD_GITLAB_TOKEN: "glpat",
			CICD_GITLAB_PROJECT_ID: "1234",
		});
		expect(adapter?.id).toBe("gitlab-ci");
	});

	it("sélectionne Jenkins avec URL + job + token", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_JENKINS_URL: "https://jenkins.local",
			CICD_JENKINS_JOB: "meca-pipeline",
			CICD_JENKINS_TOKEN: "tok",
		});
		expect(adapter?.id).toBe("jenkins");
	});

	it("CICD_PROVIDER=none désactive la boucle même si Azure est configuré", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "none",
			AZURE_DEVOPS_PAT: "pat",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/ebp",
			AZURE_DEVOPS_PROJECT: "MeCa",
		});
		expect(adapter).toBeNull();
	});

	it("un CICD_PROVIDER explicite sans credentials retourne null (pas de repli silencieux)", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "jenkins",
			AZURE_DEVOPS_PAT: "pat",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/ebp",
			AZURE_DEVOPS_PROJECT: "MeCa",
		});
		expect(adapter).toBeNull();
	});
});

describe("mapping des états de runs", () => {
	function stubFetch(payload: unknown) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => payload,
			})),
		);
	}

	it("GitHub Actions : completed+failure → failed, in_progress → running", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "github",
			GITHUB_TOKEN: "t",
			GITHUB_REPO: "ebp/meca",
		});
		stubFetch({
			workflow_runs: [
				{
					id: 7,
					run_number: 42,
					status: "completed",
					conclusion: "failure",
					html_url: "https://github.com/ebp/meca/actions/runs/7",
				},
			],
		});
		const failed = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(failed?.state).toBe("failed");
		expect(failed?.runNumber).toBe("#42");

		stubFetch({ workflow_runs: [{ id: 8, status: "in_progress" }] });
		const running = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(running?.state).toBe("running");
	});

	it("GitLab CI : success → succeeded, failed → failed", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_PROVIDER: "gitlab",
			CICD_GITLAB_TOKEN: "t",
			CICD_GITLAB_PROJECT_ID: "1234",
		});
		stubFetch([{ id: 11, iid: 3, status: "success", web_url: "https://gitlab.com/x" }]);
		const ok = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(ok?.state).toBe("succeeded");

		stubFetch([{ id: 12, status: "failed" }]);
		const ko = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(ko?.state).toBe("failed");
	});

	it("Jenkins : building → running, UNSTABLE → partiallySucceeded", async () => {
		const adapter = await resolvePipelineProvider(project, {
			CICD_JENKINS_URL: "https://jenkins.local",
			CICD_JENKINS_JOB: "meca",
			CICD_JENKINS_TOKEN: "t",
		});
		stubFetch({ number: 5, building: true });
		const running = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(running?.state).toBe("running");

		stubFetch({ number: 6, building: false, result: "UNSTABLE" });
		const unstable = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(unstable?.state).toBe("partiallySucceeded");
	});

	it("Azure DevOps : completed+succeeded → succeeded, pas de build → null", async () => {
		const adapter = await resolvePipelineProvider(project, {
			AZURE_DEVOPS_PAT: "pat",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/ebp",
			AZURE_DEVOPS_PROJECT: "MeCa",
		});
		stubFetch({
			value: [{ id: 1, buildNumber: "20260611.1", status: "completed", result: "succeeded" }],
		});
		const ok = await adapter?.fetchLatestRun("workpilot/spec-x");
		expect(ok?.state).toBe("succeeded");

		stubFetch({ value: [] });
		expect(await adapter?.fetchLatestRun("workpilot/spec-x")).toBeNull();
	});
});
