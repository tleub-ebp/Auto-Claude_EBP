/**
 * CI/CD pipeline provider adapters for the « Build rouge » loop.
 *
 * Each adapter knows how to fetch the latest pipeline run for a git branch
 * and extract human-readable error messages from a failed run. The polling
 * service (ci-pipeline-service.ts) is provider-agnostic and only talks to
 * the PipelineProviderAdapter interface.
 *
 * Supported providers and their configuration (project `.env`, either at the
 * project root or in `{autoBuildPath}/.env` — the latter wins):
 *
 *  - Azure DevOps:   AZURE_DEVOPS_PAT + AZURE_DEVOPS_ORG_URL + AZURE_DEVOPS_PROJECT
 *                    (or CICD_AZURE_TOKEN / CICD_AZURE_ORG / CICD_AZURE_PROJECT)
 *  - GitHub Actions: GITHUB_TOKEN (or gh CLI) + GITHUB_REPO (or CICD_GITHUB_TOKEN)
 *  - GitLab CI:      GITLAB_TOKEN (or glab CLI) + GITLAB_PROJECT [+ GITLAB_INSTANCE_URL]
 *                    (or CICD_GITLAB_TOKEN / CICD_GITLAB_PROJECT_ID)
 *  - Jenkins:        CICD_JENKINS_URL + CICD_JENKINS_JOB + CICD_JENKINS_TOKEN
 *                    [+ CICD_JENKINS_USER] — multibranch job layout
 *
 * Provider selection: explicit CICD_PROVIDER=azure|github|gitlab|jenkins,
 * otherwise auto-detected in that order from available credentials.
 */

import type {
	PipelineProviderId,
	PipelineRunState,
	Project,
} from "../shared/types";
import {
	getGitHubConfig,
	normalizeRepoReference,
} from "./ipc-handlers/github/utils";
import {
	getGitLabConfig,
	normalizeProjectReference,
} from "./ipc-handlers/gitlab/utils";

const MAX_ERROR_LINES = 40;

/** Latest run of a pipeline on a branch, normalized across providers. */
export interface PipelineRun {
	state: PipelineRunState;
	runId: number | string;
	/** Display reference (build number, run number…). */
	runNumber?: string;
	/** Pipeline/workflow/job display name. */
	definitionName?: string;
	webUrl?: string;
	queueTime?: string;
	finishTime?: string;
}

export interface PipelineProviderAdapter {
	readonly id: PipelineProviderId;
	/** Human-readable provider name for logs and BUILD_FAILURE.md. */
	readonly label: string;
	fetchLatestRun(branch: string): Promise<PipelineRun | null>;
	fetchRunErrors(run: PipelineRun): Promise<string[]>;
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
): Promise<unknown> {
	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new Error(`${url.split("?")[0]} returned ${res.status}`);
	}
	return res.json();
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

export interface AzureDevOpsProviderConfig {
	pat: string;
	orgUrl: string;
	project: string;
}

class AzureDevOpsAdapter implements PipelineProviderAdapter {
	readonly id = "azure-devops" as const;
	readonly label = "Azure DevOps";

	constructor(private readonly cfg: AzureDevOpsProviderConfig) {}

	private get headers(): Record<string, string> {
		return {
			Authorization: `Basic ${Buffer.from(`:${this.cfg.pat}`).toString("base64")}`,
		};
	}

	private get baseUrl(): string {
		return `${this.cfg.orgUrl.replace(/\/+$/, "")}/${encodeURIComponent(this.cfg.project)}`;
	}

	async fetchLatestRun(branch: string): Promise<PipelineRun | null> {
		const url =
			`${this.baseUrl}/_apis/build/builds` +
			`?branchName=${encodeURIComponent(`refs/heads/${branch}`)}` +
			`&$top=1&queryOrder=queueTimeDescending&api-version=7.1`;
		const body = (await fetchJson(url, this.headers)) as {
			value?: Array<{
				id: number;
				buildNumber?: string;
				status?: string;
				result?: string;
				queueTime?: string;
				finishTime?: string;
				definition?: { name?: string };
				_links?: { web?: { href?: string } };
			}>;
		};
		const build = body.value?.[0];
		if (!build) return null;

		let state: PipelineRunState;
		if (build.status === "completed") {
			switch (build.result) {
				case "succeeded":
					state = "succeeded";
					break;
				case "partiallySucceeded":
					state = "partiallySucceeded";
					break;
				case "canceled":
					state = "canceled";
					break;
				default:
					state = "failed";
					break;
			}
		} else if (build.status === "inProgress" || build.status === "cancelling") {
			state = "running";
		} else {
			state = "queued";
		}

		return {
			state,
			runId: build.id,
			runNumber: build.buildNumber,
			definitionName: build.definition?.name,
			webUrl: build._links?.web?.href,
			queueTime: build.queueTime,
			finishTime: build.finishTime,
		};
	}

	async fetchRunErrors(run: PipelineRun): Promise<string[]> {
		const url = `${this.baseUrl}/_apis/build/builds/${run.runId}/timeline?api-version=7.1`;
		const body = (await fetchJson(url, this.headers)) as {
			records?: Array<{
				name?: string;
				issues?: Array<{ type?: string; message?: string }>;
			}>;
		};
		const errors: string[] = [];
		for (const record of body.records ?? []) {
			for (const issue of record.issues ?? []) {
				if (issue.type === "error" && issue.message) {
					errors.push(`${record.name ? `[${record.name}] ` : ""}${issue.message}`);
					if (errors.length >= MAX_ERROR_LINES) return errors;
				}
			}
		}
		return errors;
	}
}

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

interface GitHubProviderConfig {
	token: string;
	/** owner/repo */
	repo: string;
}

class GitHubActionsAdapter implements PipelineProviderAdapter {
	readonly id = "github-actions" as const;
	readonly label = "GitHub Actions";

	constructor(private readonly cfg: GitHubProviderConfig) {}

	private get headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.cfg.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	async fetchLatestRun(branch: string): Promise<PipelineRun | null> {
		const url =
			`https://api.github.com/repos/${this.cfg.repo}/actions/runs` +
			`?branch=${encodeURIComponent(branch)}&per_page=1`;
		const body = (await fetchJson(url, this.headers)) as {
			workflow_runs?: Array<{
				id: number;
				run_number?: number;
				name?: string;
				status?: string; // queued | in_progress | completed | waiting | pending
				conclusion?: string | null; // success | failure | cancelled | timed_out | neutral | skipped | action_required
				html_url?: string;
				created_at?: string;
				updated_at?: string;
			}>;
		};
		const run = body.workflow_runs?.[0];
		if (!run) return null;

		let state: PipelineRunState;
		if (run.status === "completed") {
			switch (run.conclusion) {
				case "success":
					state = "succeeded";
					break;
				case "neutral":
				case "skipped":
				case "action_required":
					state = "partiallySucceeded";
					break;
				case "cancelled":
					state = "canceled";
					break;
				default: // failure | timed_out | startup_failure | null
					state = "failed";
					break;
			}
		} else if (run.status === "in_progress") {
			state = "running";
		} else {
			state = "queued";
		}

		return {
			state,
			runId: run.id,
			runNumber: run.run_number !== undefined ? `#${run.run_number}` : undefined,
			definitionName: run.name,
			webUrl: run.html_url,
			queueTime: run.created_at,
			finishTime: run.updated_at,
		};
	}

	async fetchRunErrors(run: PipelineRun): Promise<string[]> {
		const url = `https://api.github.com/repos/${this.cfg.repo}/actions/runs/${run.runId}/jobs?per_page=50`;
		const body = (await fetchJson(url, this.headers)) as {
			jobs?: Array<{
				name?: string;
				conclusion?: string | null;
				steps?: Array<{ name?: string; conclusion?: string | null }>;
			}>;
		};
		const errors: string[] = [];
		for (const job of body.jobs ?? []) {
			if (job.conclusion !== "failure" && job.conclusion !== "timed_out") {
				continue;
			}
			const failedSteps = (job.steps ?? []).filter(
				(s) => s.conclusion === "failure" || s.conclusion === "timed_out",
			);
			if (failedSteps.length === 0) {
				errors.push(`[${job.name ?? "job"}] failed`);
			}
			for (const step of failedSteps) {
				errors.push(
					`[${job.name ?? "job"}] step "${step.name ?? "?"}" ${step.conclusion}`,
				);
				if (errors.length >= MAX_ERROR_LINES) return errors;
			}
		}
		return errors;
	}
}

// ---------------------------------------------------------------------------
// GitLab CI
// ---------------------------------------------------------------------------

interface GitLabProviderConfig {
	token: string;
	instanceUrl: string;
	/** group/project path or numeric ID, NOT yet URL-encoded. */
	project: string;
}

class GitLabCIAdapter implements PipelineProviderAdapter {
	readonly id = "gitlab-ci" as const;
	readonly label = "GitLab CI";

	constructor(private readonly cfg: GitLabProviderConfig) {}

	private get headers(): Record<string, string> {
		return { "PRIVATE-TOKEN": this.cfg.token };
	}

	private get projectUrl(): string {
		const base = this.cfg.instanceUrl.replace(/\/+$/, "");
		return `${base}/api/v4/projects/${encodeURIComponent(this.cfg.project)}`;
	}

	async fetchLatestRun(branch: string): Promise<PipelineRun | null> {
		const url =
			`${this.projectUrl}/pipelines` +
			`?ref=${encodeURIComponent(branch)}&per_page=1&order_by=id&sort=desc`;
		const pipelines = (await fetchJson(url, this.headers)) as Array<{
			id: number;
			iid?: number;
			status?: string;
			web_url?: string;
			created_at?: string;
			updated_at?: string;
			name?: string | null;
		}>;
		const pipeline = pipelines?.[0];
		if (!pipeline) return null;

		let state: PipelineRunState;
		switch (pipeline.status) {
			case "success":
				state = "succeeded";
				break;
			case "failed":
				state = "failed";
				break;
			case "canceled":
			case "skipped":
				state = "canceled";
				break;
			case "running":
				state = "running";
				break;
			default: // created | pending | preparing | waiting_for_resource | scheduled | manual
				state = "queued";
				break;
		}

		return {
			state,
			runId: pipeline.id,
			runNumber: pipeline.iid !== undefined ? `#${pipeline.iid}` : undefined,
			definitionName: pipeline.name ?? undefined,
			webUrl: pipeline.web_url,
			queueTime: pipeline.created_at,
			finishTime: pipeline.updated_at,
		};
	}

	async fetchRunErrors(run: PipelineRun): Promise<string[]> {
		const url = `${this.projectUrl}/pipelines/${run.runId}/jobs?scope[]=failed&per_page=50`;
		const jobs = (await fetchJson(url, this.headers)) as Array<{
			name?: string;
			stage?: string;
			failure_reason?: string;
		}>;
		return (jobs ?? [])
			.slice(0, MAX_ERROR_LINES)
			.map(
				(job) =>
					`[${job.stage ?? "stage"}/${job.name ?? "job"}] ${job.failure_reason ?? "failed"}`,
			);
	}
}

// ---------------------------------------------------------------------------
// Jenkins (multibranch pipeline layout)
// ---------------------------------------------------------------------------

interface JenkinsProviderConfig {
	url: string;
	job: string;
	token: string;
	user?: string;
}

class JenkinsAdapter implements PipelineProviderAdapter {
	readonly id = "jenkins" as const;
	readonly label = "Jenkins";

	constructor(private readonly cfg: JenkinsProviderConfig) {}

	private get headers(): Record<string, string> {
		const user = this.cfg.user || "admin";
		return {
			Authorization: `Basic ${Buffer.from(`${user}:${this.cfg.token}`).toString("base64")}`,
		};
	}

	private branchJobUrl(branch: string): string {
		const base = this.cfg.url.replace(/\/+$/, "");
		// Multibranch pipelines expose one sub-job per branch; the branch name
		// (including slashes, e.g. workpilot/my-spec) is URI-encoded once.
		return `${base}/job/${encodeURIComponent(this.cfg.job)}/job/${encodeURIComponent(branch)}`;
	}

	async fetchLatestRun(branch: string): Promise<PipelineRun | null> {
		const url = `${this.branchJobUrl(branch)}/lastBuild/api/json`;
		let body: {
			id?: string;
			number?: number;
			building?: boolean;
			result?: string | null; // SUCCESS | FAILURE | UNSTABLE | ABORTED | null
			url?: string;
			timestamp?: number;
			duration?: number;
			fullDisplayName?: string;
		};
		try {
			body = (await fetchJson(url, this.headers)) as typeof body;
		} catch (err) {
			// 404 simply means no build for this branch yet.
			if (String(err).includes(" 404")) return null;
			throw err;
		}
		if (body.number === undefined) return null;

		let state: PipelineRunState;
		if (body.building) {
			state = "running";
		} else {
			switch (body.result) {
				case "SUCCESS":
					state = "succeeded";
					break;
				case "UNSTABLE":
					state = "partiallySucceeded";
					break;
				case "ABORTED":
					state = "canceled";
					break;
				case null:
				case undefined:
					state = "queued";
					break;
				default:
					state = "failed";
					break;
			}
		}

		const started =
			body.timestamp !== undefined
				? new Date(body.timestamp).toISOString()
				: undefined;
		const finished =
			body.timestamp !== undefined && body.duration
				? new Date(body.timestamp + body.duration).toISOString()
				: undefined;

		return {
			state,
			// Keep the branch in the id so fetchRunErrors can rebuild the URL.
			runId: `${branch}#${body.number}`,
			runNumber: `#${body.number}`,
			definitionName: this.cfg.job,
			webUrl: body.url,
			queueTime: started,
			finishTime: finished,
		};
	}

	async fetchRunErrors(run: PipelineRun): Promise<string[]> {
		const [branch, number] = String(run.runId).split("#");
		if (!branch || !number) return [];
		const url = `${this.branchJobUrl(branch)}/${number}/consoleText`;
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) return [];
		const text = await res.text();
		// Keep the most relevant console lines: explicit errors first, else tail.
		const lines = text.split("\n");
		const errorLines = lines.filter((line) =>
			/(error|failed|failure|exception)/i.test(line),
		);
		const selected = (errorLines.length > 0 ? errorLines : lines).slice(
			-MAX_ERROR_LINES,
		);
		return selected.map((line) => line.trim()).filter(Boolean);
	}
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Env vars merged from the project root .env and {autoBuildPath}/.env. */
export type MergedEnv = Record<string, string>;

function resolveAzureConfig(env: MergedEnv): AzureDevOpsProviderConfig | null {
	const pat = env.AZURE_DEVOPS_PAT || env.CICD_AZURE_TOKEN;
	const orgUrl =
		env.AZURE_DEVOPS_ORG_URL ||
		(env.CICD_AZURE_ORG ? `https://dev.azure.com/${env.CICD_AZURE_ORG}` : "");
	const project = env.AZURE_DEVOPS_PROJECT || env.CICD_AZURE_PROJECT;
	if (!pat || !orgUrl || !project) return null;
	return { pat, orgUrl, project };
}

function resolveGitHubConfig(
	env: MergedEnv,
	project: Project,
): GitHubProviderConfig | null {
	// Direct env first (covers CICD_* overrides), then the shared helper
	// (which can also pull the token from the gh CLI).
	const token = env.GITHUB_TOKEN || env.CICD_GITHUB_TOKEN;
	const repo = env.GITHUB_REPO || env.CICD_GITHUB_REPO;
	if (token && repo) {
		return { token, repo: normalizeRepoReference(repo) };
	}
	const cfg = getGitHubConfig(project);
	if (cfg) {
		return { token: cfg.token, repo: normalizeRepoReference(cfg.repo) };
	}
	return null;
}

async function resolveGitLabConfig(
	env: MergedEnv,
	project: Project,
): Promise<GitLabProviderConfig | null> {
	const token = env.GITLAB_TOKEN || env.CICD_GITLAB_TOKEN;
	const projectRef = env.GITLAB_PROJECT || env.CICD_GITLAB_PROJECT_ID;
	const instanceUrl =
		env.GITLAB_INSTANCE_URL || env.CICD_GITLAB_URL || "https://gitlab.com";
	if (token && projectRef) {
		return {
			token,
			instanceUrl,
			project: normalizeProjectReference(projectRef, instanceUrl),
		};
	}
	const cfg = await getGitLabConfig(project);
	if (cfg) {
		return {
			token: cfg.token,
			instanceUrl: cfg.instanceUrl,
			project: normalizeProjectReference(cfg.project, cfg.instanceUrl),
		};
	}
	return null;
}

function resolveJenkinsConfig(env: MergedEnv): JenkinsProviderConfig | null {
	const url = env.CICD_JENKINS_URL || env.JENKINS_URL;
	const job = env.CICD_JENKINS_JOB || env.JENKINS_JOB;
	const token = env.CICD_JENKINS_TOKEN || env.JENKINS_TOKEN;
	const user = env.CICD_JENKINS_USER || env.JENKINS_USER;
	if (!url || !job || !token) return null;
	return { url, job, token, user };
}

/**
 * Resolve the CI provider adapter for a project.
 *
 * Explicit CICD_PROVIDER wins; otherwise the first provider with complete
 * credentials is used (Azure → GitHub → GitLab → Jenkins). Returns null when
 * no provider is configured — the polling service then skips the project.
 */
export async function resolvePipelineProvider(
	project: Project,
	env: MergedEnv,
): Promise<PipelineProviderAdapter | null> {
	const explicit = (env.CICD_PROVIDER ?? "").trim().toLowerCase();

	const buildAzure = () => {
		const cfg = resolveAzureConfig(env);
		return cfg ? new AzureDevOpsAdapter(cfg) : null;
	};
	const buildGitHub = () => {
		const cfg = resolveGitHubConfig(env, project);
		return cfg ? new GitHubActionsAdapter(cfg) : null;
	};
	const buildGitLab = async () => {
		const cfg = await resolveGitLabConfig(env, project);
		return cfg ? new GitLabCIAdapter(cfg) : null;
	};
	const buildJenkins = () => {
		const cfg = resolveJenkinsConfig(env);
		return cfg ? new JenkinsAdapter(cfg) : null;
	};

	switch (explicit) {
		case "azure":
		case "azure-devops":
		case "azuredevops":
			return buildAzure();
		case "github":
		case "github-actions":
			return buildGitHub();
		case "gitlab":
		case "gitlab-ci":
			return buildGitLab();
		case "jenkins":
			return buildJenkins();
		case "none":
		case "off":
			return null;
		default:
			break;
	}

	return (
		buildAzure() ?? buildGitHub() ?? (await buildGitLab()) ?? buildJenkins()
	);
}
