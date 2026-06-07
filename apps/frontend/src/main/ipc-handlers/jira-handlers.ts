import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	IPCResult,
	JiraSyncStatus,
	JiraWorkItem,
	Project,
} from "../../shared/types";
import type { AgentManager } from "../agent";
import { projectStore } from "../project-store";
import { parseEnvFile } from "./utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const connectorSrcPath = path.resolve(__dirname, "..", "..", "..", "..", "src");

/**
 * Register all Jira-related IPC handlers
 */
export function registerJiraHandlers(
	_agentManager: AgentManager,
	_getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Helper to get Jira credentials from project env
	 */
	const getJiraConfig = (
		project: Project,
	): {
		instanceUrl: string | null;
		email: string | null;
		apiToken: string | null;
		projectKey: string | null;
	} => {
		if (!project.autoBuildPath) {
			return {
				instanceUrl: null,
				email: null,
				apiToken: null,
				projectKey: null,
			};
		}
		const envPath = path.join(project.path, project.autoBuildPath, ".env");
		if (!existsSync(envPath)) {
			return {
				instanceUrl: null,
				email: null,
				apiToken: null,
				projectKey: null,
			};
		}

		try {
			const content = readFileSync(envPath, "utf-8");
			const vars = parseEnvFile(content);
			return {
				instanceUrl: vars.JIRA_INSTANCE_URL || null,
				email: vars.JIRA_EMAIL || null,
				apiToken: vars.JIRA_API_TOKEN || null,
				projectKey: vars.JIRA_PROJECT_KEY || null,
			};
		} catch {
			return {
				instanceUrl: null,
				email: null,
				apiToken: null,
				projectKey: null,
			};
		}
	};

	/**
	 * Call Python Jira connector
	 */
	const callJiraPython = async (
		projectPath: string,
		operation: string,
		params: Record<string, unknown> = {},
		envOverrides: Record<string, string> = {},
	): Promise<unknown> => {
		return new Promise((resolve, reject) => {
			const pythonScript = `
import sys
import json
import os
from pathlib import Path

# Add project root (parent of src/) to sys.path
sys.path.insert(0, str(Path('${connectorSrcPath.replace(/\\/g, "\\\\")}').parent))

from src.connectors.jira.client import JiraClient
from src.connectors.jira.connector import JiraConnector

try:
    instance_url = os.getenv('JIRA_URL') or os.getenv('JIRA_INSTANCE_URL')
    email = os.getenv('JIRA_EMAIL')
    api_token = os.getenv('JIRA_API_TOKEN')
    project_key = os.getenv('JIRA_PROJECT_KEY', '')

    if not instance_url or not email or not api_token:
        print(json.dumps({'error': 'Jira not configured'}))
        sys.exit(1)

    client = JiraClient(base_url=instance_url, email=email, token=api_token)
    client.connect()
    connector = JiraConnector(client)

    operation = '${operation}'
    params = ${JSON.stringify(params)}

    if operation == 'test_connection':
        info = client.get_connection_info()
        print(json.dumps({'data': info}))

    elif operation == 'list_issues':
        project_key_param = params.get('project_key') or project_key
        max_results = params.get('max_results', 100)

        if not project_key_param:
            print(json.dumps({'error': 'Jira project key is required'}))
            sys.exit(1)

        issues = connector.search_issues(project_key_param, max_results=max_results)
        result = [{
            'id': issue.key,
            'title': issue.summary,
            'description': issue.description,
            'state': issue.status.name,
            'workItemType': issue.issue_type,
            'assignedTo': issue.assignee.display_name if issue.assignee else None,
            'tags': issue.labels,
            'priority': issue.priority,
            'createdDate': issue.created.isoformat() if issue.created else None,
            'projectKey': issue.project_key,
            'url': f"{instance_url}/browse/{issue.key}",
            'acceptanceCriteria': issue.acceptance_criteria or None,
        } for issue in issues]
        print(json.dumps({'data': result}))

    elif operation == 'get_issue':
        issue_key = params.get('issue_key')
        if not issue_key:
            print(json.dumps({'error': 'Jira issue key is required'}))
            sys.exit(1)

        issue = connector.get_issue(issue_key)
        result = {
            'id': issue.key,
            'title': issue.summary,
            'description': issue.description,
            'state': issue.status.name,
            'workItemType': issue.issue_type,
            'assignedTo': issue.assignee.display_name if issue.assignee else None,
            'tags': issue.labels,
            'priority': issue.priority,
            'createdDate': issue.created.isoformat() if issue.created else None,
            'projectKey': issue.project_key,
            'url': f"{instance_url}/browse/{issue.key}",
            'acceptanceCriteria': issue.acceptance_criteria or None,
        }
        print(json.dumps({'data': result}))

    else:
        print(json.dumps({'error': f'Unknown operation: {operation}'}))
        sys.exit(1)

except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
`;

			const proc = spawn("python", ["-c", pythonScript], {
				cwd: projectPath,
				env: { ...process.env, ...envOverrides },
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					const errorOutput = [stderr.trim(), stdout.trim()]
						.filter(Boolean)
						.join("\n");
					reject(new Error(errorOutput || `Process exited with code ${code}`));
					return;
				}

				try {
					const result = JSON.parse(stdout);
					if (result.error) {
						reject(new Error(result.error));
					} else {
						resolve(result.data);
					}
				} catch (_e) {
					reject(new Error(`Failed to parse response: ${stdout}`));
				}
			});

			proc.on("error", (error) => {
				reject(error);
			});
		});
	};

	ipcMain.handle(
		IPC_CHANNELS.JIRA_CHECK_CONNECTION,
		async (_, projectId: string): Promise<IPCResult<JiraSyncStatus>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getJiraConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.instanceUrl) envOverrides.JIRA_URL = config.instanceUrl;
			if (config.email) envOverrides.JIRA_EMAIL = config.email;
			if (config.apiToken) envOverrides.JIRA_API_TOKEN = config.apiToken;
			if (config.projectKey) envOverrides.JIRA_PROJECT_KEY = config.projectKey;

			if (!config.instanceUrl || !config.email || !config.apiToken) {
				return {
					success: true,
					data: {
						connected: false,
						error: "Jira not configured",
					},
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);
				await callJiraPython(projectPath, "test_connection", {}, envOverrides);

				return {
					success: true,
					data: {
						connected: true,
						instanceUrl: config.instanceUrl,
						projectKey: config.projectKey || undefined,
					},
				};
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					success: true,
					data: {
						connected: false,
						error: errorMessage,
					},
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.JIRA_GET_ISSUES,
		async (
			_,
			projectId: string,
			maxItems?: number,
		): Promise<IPCResult<JiraWorkItem[]>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getJiraConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.instanceUrl) envOverrides.JIRA_URL = config.instanceUrl;
			if (config.email) envOverrides.JIRA_EMAIL = config.email;
			if (config.apiToken) envOverrides.JIRA_API_TOKEN = config.apiToken;
			if (config.projectKey) envOverrides.JIRA_PROJECT_KEY = config.projectKey;

			if (!config.instanceUrl || !config.email || !config.apiToken) {
				return {
					success: false,
					error: "Jira not configured for this project",
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);
				const items = (await callJiraPython(
					projectPath,
					"list_issues",
					{
						project_key: config.projectKey,
						max_results: maxItems || 100,
					},
					envOverrides,
				)) as JiraWorkItem[];

				return { success: true, data: items };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	// Fetch a single issue directly by its key. Unlike GET_ISSUES (which lists
	// the project backlog and is capped), this resolves any issue — including
	// sub-tasks/custom types or issues outside the listed window — so the
	// import search can find it by key.
	ipcMain.handle(
		IPC_CHANNELS.JIRA_GET_ISSUE,
		async (
			_,
			projectId: string,
			issueKey: string,
		): Promise<IPCResult<JiraWorkItem>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getJiraConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.instanceUrl) envOverrides.JIRA_URL = config.instanceUrl;
			if (config.email) envOverrides.JIRA_EMAIL = config.email;
			if (config.apiToken) envOverrides.JIRA_API_TOKEN = config.apiToken;
			if (config.projectKey) envOverrides.JIRA_PROJECT_KEY = config.projectKey;

			if (!config.instanceUrl || !config.email || !config.apiToken) {
				return {
					success: false,
					error: "Jira not configured for this project",
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);
				const item = (await callJiraPython(
					projectPath,
					"get_issue",
					{ issue_key: issueKey },
					envOverrides,
				)) as JiraWorkItem;

				return { success: true, data: item };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.JIRA_TEST_CONNECTION,
		async (
			_,
			config: { instanceUrl: string; email: string; apiToken: string },
		): Promise<IPCResult<JiraSyncStatus>> => {
			if (!config.instanceUrl || !config.email || !config.apiToken) {
				return {
					success: false,
					error: "Jira credentials are required",
				};
			}

			try {
				// Create a temporary environment for testing
				const envOverrides: Record<string, string> = {
					JIRA_URL: config.instanceUrl,
					JIRA_EMAIL: config.email,
					JIRA_API_TOKEN: config.apiToken,
				};

				// Test connection using a temporary path (current working directory)
				const _result = await callJiraPython(
					process.cwd(),
					"test_connection",
					{},
					envOverrides,
				);

				return {
					success: true,
					data: {
						connected: true,
						instanceUrl: config.instanceUrl,
					},
				};
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					success: true,
					data: {
						connected: false,
						error: errorMessage,
					},
				};
			}
		},
	);
}
