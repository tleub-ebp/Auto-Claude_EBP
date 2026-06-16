import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../shared/constants";
import type {
	AzureDevOpsImportResult,
	AzureDevOpsSyncStatus,
	AzureDevOpsWorkItem,
	IPCResult,
	Project,
	TaskMetadata,
} from "../../shared/types";
import { slugifySpecTitle } from "../../shared/utils/spec-slug";
import type { AgentManager } from "../agent";
import { projectStore } from "../project-store";
import {
	parseAcceptanceCriteriaText,
	stripAcceptanceCriteriaSection,
} from "../../shared/utils/acceptance-criteria";
import {
	inlineAzureDevOpsImages,
	stripAzureAttachmentImages,
} from "./shared/azure-attachments";
import {
	sanitizeText,
	sanitizeUrl,
	stripControlChars,
	stripHtml,
} from "./shared/sanitize";
import { parseEnvFile } from "./utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const connectorSrcPath = path.resolve(__dirname, "..", "..", "..", "..", "src");
const backendPath = path.resolve(__dirname, "..", "..", "..", "backend");

/**
 * Register all Azure DevOps-related IPC handlers
 */
export function registerAzureDevOpsHandlers(
	_agentManager: AgentManager,
	_getMainWindow: () => BrowserWindow | null,
): void {
	// ============================================
	// Azure DevOps Integration Operations
	// ============================================

	/**
	 * Helper to get Azure DevOps credentials from project env
	 */
	const getAzureDevOpsConfig = (
		project: Project,
	): {
		pat: string | null;
		orgUrl: string | null;
		projectName: string | null;
	} => {
		if (!project.autoBuildPath) {
			return { pat: null, orgUrl: null, projectName: null };
		}
		const envPath = path.join(project.path, project.autoBuildPath, ".env");
		if (!existsSync(envPath)) {
			return { pat: null, orgUrl: null, projectName: null };
		}

		try {
			const content = readFileSync(envPath, "utf-8");
			const vars = parseEnvFile(content);
			return {
				pat: vars.AZURE_DEVOPS_PAT || null,
				orgUrl: vars.AZURE_DEVOPS_ORG_URL || null,
				projectName: vars.AZURE_DEVOPS_PROJECT || null,
			};
		} catch {
			return { pat: null, orgUrl: null, projectName: null };
		}
	};

	/**
	 * Helper to normalize project name (URL-decode if needed)
	 */
	const normalizeProjectName = (
		projectName: string | null | undefined,
	): string | undefined => {
		if (!projectName) return undefined;
		// URL-decode project name if it was encoded (e.g., 'MeCa%20Web' → 'MeCa Web')
		try {
			return decodeURIComponent(projectName);
		} catch {
			return projectName;
		}
	};

	/**
	 * Call Python Azure DevOps connector
	 */
	const callAzureDevOpsPython = async (
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

# Add project root (parent of src/) at the front so it takes priority
sys.path.insert(0, str(Path('${connectorSrcPath.replaceAll("\\", "\\\\")}').parent))
# Append apps/backend at the end (lower priority) for core.git_provider
sys.path.append(str(Path('${backendPath.replaceAll("\\", "\\\\")}')))
from src.connectors.azure_devops import AzureDevOpsConnector
try:
    from src.config.settings import Settings
except (ImportError, ModuleNotFoundError):
    from dataclasses import dataclass
    from typing import Optional
    @dataclass
    class Settings:
        pat: str
        organization_url: str
        project: Optional[str] = None
        repository: Optional[str] = None

try:
    # Try to import git_provider for auto-detection
    try:
        from core.git_provider import extract_azure_devops_project
        has_git_provider = True
    except ImportError:
        has_git_provider = False
    
    # Get credentials from environment
    pat = os.getenv('AZURE_DEVOPS_PAT')
    org_url = os.getenv('AZURE_DEVOPS_ORG_URL')
    project_env = os.getenv('AZURE_DEVOPS_PROJECT')  # May be project name or repo name (legacy)
    repository_env = os.getenv('AZURE_DEVOPS_REPOSITORY')  # Explicit repository name

    if not pat or not org_url:
        print(json.dumps({'error': 'Azure DevOps not configured'}))
        sys.exit(1)

    # Always auto-detect project name from Git remote (most reliable source)
    project = None
    if has_git_provider:
        try:
            project_dir = Path('${projectPath.replaceAll("\\", "\\\\")}')
            project = extract_azure_devops_project(project_dir)
        except Exception:
            pass

    # Fallback: use env variable if auto-detection fails
    if not project:
        project = project_env

    settings = Settings(pat=pat, organization_url=org_url, project=project)
    connector = AzureDevOpsConnector(settings)
    connector.connect()
    
    operation = '${operation}'
    params = ${JSON.stringify(params)}
    
    if operation == 'list_work_items':
        project_name = project  # Use auto-detected project name
        item_types = params.get('item_types')
        max_items = params.get('max_items', 100)
        items = connector.list_backlog_items(project_name, item_types, max_items)
        result = [{
            'id': item.id,
            'title': item.title,
            'description': item.description,
            'state': item.state,
            'workItemType': item.work_item_type,
            'assignedTo': item.assigned_to,
            'tags': item.tags,
            'priority': item.priority,
            'createdDate': item.created_date.isoformat() if hasattr(item.created_date, 'isoformat') else item.created_date,
            'areaPath': item.area_path,
            'iterationPath': item.iteration_path,
            'url': item.url,
            'acceptanceCriteria': item.acceptance_criteria,
        } for item in items]
        print(json.dumps({'data': result}))
    
    elif operation == 'list_repositories':
        project_name = project  # Use auto-detected project name
        if not project_name:
            print(json.dumps({'error': 'Project name is required to list repositories'}))
            sys.exit(1)
        repos = connector.list_repositories(project_name)
        result = [{
            'id': repo.id,
            'name': repo.name,
            'project': repo.project,
            'defaultBranch': repo.default_branch,
            'webUrl': repo.web_url,
        } for repo in repos]
        print(json.dumps({'data': result}))
    
    elif operation == 'test_connection':
        # Test auth connection
        info = connector.get_connection_info()

        # Also validate the project exists if one is configured
        if project:
            try:
                core_client = connector._client._connection.clients.get_core_client()
                core_client.get_project(project)
            except Exception as proj_err:
                error_msg = str(proj_err)
                if 'TF200016' in error_msg or 'does not exist' in error_msg.lower():
                    print(json.dumps({'error': f'Project not found: \\'{project}\\'. Verify the project name matches exactly (case-sensitive) on your Azure DevOps organization.'}))
                    sys.exit(1)
                # Other errors (permissions, etc.)
                print(json.dumps({'error': f'Cannot access project \\'{project}\\': {error_msg}'}))
                sys.exit(1)

        print(json.dumps({'data': info}))
    
    elif operation == 'get_work_item':
        work_item_id = int(params.get('work_item_id'))
        item = connector.get_item(project=project, item_id=work_item_id)
        result = {
            'id': item.id,
            'title': item.title,
            'description': item.description,
            'state': item.state,
            'workItemType': item.work_item_type,
            'assignedTo': item.assigned_to,
            'tags': item.tags,
            'priority': item.priority,
            'createdDate': item.created_date.isoformat() if hasattr(item.created_date, 'isoformat') else item.created_date,
            'areaPath': item.area_path,
            'iterationPath': item.iteration_path,
            'url': item.url,
            'acceptanceCriteria': item.acceptance_criteria,
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
		IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION,
		async (_, projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			// Always set AZURE_DEVOPS_PROJECT to override any system env var
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject)
				envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;
			if (!config.pat || !config.orgUrl) {
				return {
					success: true,
					data: {
						connected: false,
						error: "Azure DevOps not configured",
					},
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);
				const info = (await callAzureDevOpsPython(
					projectPath,
					"test_connection",
					{},
					envOverrides,
				)) as Record<string, string>;

				// Use the project name returned by Python (auto-detected from git remote)
				const detectedProjectName =
					info?.project || normalizeProjectName(config.projectName);

				return {
					success: true,
					data: {
						connected: true,
						organizationUrl: config.orgUrl,
						projectName: detectedProjectName,
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
		IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES,
		async (
			_,
			projectId: string,
		): Promise<
			IPCResult<import("../../shared/types").AzureDevOpsRepository[]>
		> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			// Pass project name from env for fallback (Python auto-detects from git remote)
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject)
				envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;

			if (!config.pat || !config.orgUrl) {
				return {
					success: false,
					error: "Azure DevOps not configured for this project",
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);
				const repos = (await callAzureDevOpsPython(
					projectPath,
					"list_repositories",
					{}, // Project name is auto-detected in Python from git remote
					envOverrides,
				)) as import("../../shared/types").AzureDevOpsRepository[];

				return { success: true, data: repos };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY,
		async (
			_,
			projectId: string,
		): Promise<IPCResult<{ repository: string | null }>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);

				// Call Python to detect repository from git remote
				const pythonScript = `
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path('${connectorSrcPath.replaceAll("\\", "\\\\")}').parent))
sys.path.insert(0, str(Path('${backendPath.replaceAll("\\", "\\\\")}')))

try:
    from core.git_provider import extract_azure_devops_repository
    
    project_dir = Path('${projectPath.replaceAll("\\", "\\\\")}')
    repository = extract_azure_devops_repository(project_dir)
    
    print(json.dumps({'data': {'repository': repository}}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
`;

				const proc = spawn("python", ["-c", pythonScript], {
					cwd: projectPath,
				});

				let stdout = "";
				let stderr = "";

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});

				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});

				const result = await new Promise<{ repository: string | null }>(
					(resolve, reject) => {
						proc.on("close", (code) => {
							if (code !== 0) {
								const errorOutput = [stderr.trim(), stdout.trim()]
									.filter(Boolean)
									.join("\n");
								reject(
									new Error(errorOutput || `Process exited with code ${code}`),
								);
								return;
							}

							try {
								const parsed = JSON.parse(stdout);
								if (parsed.error) {
									reject(new Error(parsed.error));
								} else {
									resolve(parsed.data);
								}
							} catch (_e) {
								reject(new Error(`Failed to parse response: ${stdout}`));
							}
						});

						proc.on("error", (error) => {
							reject(error);
						});
					},
				);

				return { success: true, data: result };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS,
		async (
			_,
			projectId: string,
			_azureProject?: string,
			itemTypes?: string[],
			maxItems?: number,
		): Promise<IPCResult<AzureDevOpsWorkItem[]>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			// Always set AZURE_DEVOPS_PROJECT to override any system env var
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject)
				envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;
			if (!config.pat || !config.orgUrl) {
				return {
					success: false,
					error: "Azure DevOps not configured for this project",
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);

				const items = (await callAzureDevOpsPython(
					projectPath,
					"list_work_items",
					{
						item_types: itemTypes,
						max_items: maxItems || 100,
					},
					envOverrides,
				)) as AzureDevOpsWorkItem[];

				return { success: true, data: items };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	// Fetch a single work item directly by its global ID. Unlike
	// GET_WORK_ITEMS (which lists the backlog and is capped/filtered), this
	// resolves any work item — including custom types (e.g. RSD) or items
	// outside the backlog window — so the import search can find it by ID.
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM,
		async (
			_,
			projectId: string,
			workItemId: number,
		): Promise<IPCResult<AzureDevOpsWorkItem>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject)
				envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;
			if (!config.pat || !config.orgUrl) {
				return {
					success: false,
					error: "Azure DevOps not configured for this project",
				};
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);

				const item = (await callAzureDevOpsPython(
					projectPath,
					"get_work_item",
					{ work_item_id: workItemId },
					envOverrides,
				)) as AzureDevOpsWorkItem;

				return { success: true, data: item };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS,
		async (
			_,
			projectId: string,
			workItemIds: number[],
			options?: { requireReviewBeforeCoding?: boolean },
		): Promise<IPCResult<AzureDevOpsImportResult>> => {
			const project = projectStore.getProject(projectId);
			if (!project?.autoBuildPath) {
				return {
					success: false,
					error: "Project not found or not initialized",
				};
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			// Always set AZURE_DEVOPS_PROJECT to override any system env var
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject)
				envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;
			if (!config.pat || !config.orgUrl) {
				return { success: false, error: "Azure DevOps not configured" };
			}

			try {
				const projectPath = path.join(
					project.path,
					project.autoBuildPath || "",
				);

				// Get work items details (project name auto-detected in Python)
				const items = (await callAzureDevOpsPython(
					projectPath,
					"list_work_items",
					{
						max_items: 1000,
					},
					envOverrides,
				)) as AzureDevOpsWorkItem[];

				const selectedItems = items.filter((item) =>
					workItemIds.includes(item.id),
				);

				if (selectedItems.length === 0) {
					return {
						success: false,
						error: "No matching work items found",
					};
				}

				// Create tasks from work items
				const specsBaseDir = getSpecsDir(project.autoBuildPath);
				const specsDir = path.join(project.path, specsBaseDir);
				if (!existsSync(specsDir)) {
					mkdirSync(specsDir, { recursive: true });
				}

				let specNumber = 1;
				const existingDirs = readdirSync(specsDir, { withFileTypes: true })
					.filter((dir) => dir.isDirectory())
					.map((dir) => dir.name);
				const existingNumbers = existingDirs
					.map((name) => {
						const match = name.match(/^(\d+)/);
						return match ? parseInt(match[1], 10) : 0;
					})
					.filter((num) => num > 0);
				if (existingNumbers.length > 0) {
					specNumber = Math.max(...existingNumbers) + 1;
				}

				const importedTasks: import("../../shared/types").Task[] = [];
				const errors: string[] = [];

				for (const item of selectedItems) {
					try {
						// Sanitize inputs.
						// Le titre Azure DevOps peut contenir du HTML enrichi : on le
						// réduit en texte brut sur une seule ligne (pas d'interprétation HTML).
						const safeTitle = sanitizeText(
							stripHtml(item.title).replace(/\s+/g, " "),
							200,
						);
						const safeDescription = item.description
							? stripAcceptanceCriteriaSection(
									sanitizeText(item.description, 5000),
								)
							: "";

						// Description HTML conservée pour l'affichage (rendu enrichi).
						// On inline les images en pièce jointe Azure DevOps (auth PAT)
						// en data URIs pour qu'elles s'affichent dans le renderer.
						let displayDescription = item.description
							? stripAcceptanceCriteriaSection(
									stripControlChars(item.description, true),
								)
							: "";
						if (displayDescription && config.pat && config.orgUrl) {
							displayDescription = await inlineAzureDevOpsImages(
								displayDescription,
								config.orgUrl,
								config.pat,
							);
						}

						const safeIdentifier = sanitizeText(`ADO-${item.id}`, 100);
						const safeUrl = item.url ? sanitizeUrl(item.url) : "";

						const slugifiedTitle = slugifySpecTitle(safeTitle) || "task";
						const specId = `${String(specNumber).padStart(3, "0")}-${slugifiedTitle}`;
						specNumber += 1;

						const specDir = path.join(specsDir, specId);
						mkdirSync(specDir, { recursive: true });

						// Map work item type to task category
						let category: string;
						switch (item.workItemType.toLowerCase()) {
							case "bug":
								category = "bug";
								break;
							case "task":
								category = "task";
								break;
							case "user story":
							case "feature":
								category = "feature";
								break;
							default:
								category = "task";
						}

						// Map priority (Azure DevOps: 1=highest, 4=lowest -> WorkPilot AI: high/medium/low)
						let priority = "medium";
						if (item.priority) {
							if (item.priority <= 1) priority = "high";
							else if (item.priority >= 3) priority = "low";
						}

						const acceptanceCriteriaList = parseAcceptanceCriteriaText(
							item.acceptanceCriteria,
						);

						const metadata: TaskMetadata = {
							sourceType: "imported",
							category: category as import("../../shared/types").TaskCategory,
							priority: priority as import("../../shared/types").TaskPriority,
							azureDevOpsIdentifier: safeIdentifier,
							azureDevOpsUrl: safeUrl,
							azureDevOpsState: item.state,
							azureDevOpsType: item.workItemType,
							...(acceptanceCriteriaList.length > 0 && {
								acceptanceCriteria: acceptanceCriteriaList,
							}),
							...(options?.requireReviewBeforeCoding && {
								requireReviewBeforeCoding: true,
							}),
						};

						const now = new Date().toISOString();

						// Do NOT pre-create implementation_plan.json with empty phases.
						// The spec pipeline's planning phase will create it properly with
						// actual phases and subtasks based on the spec.md it generates.
						// Pre-creating with phases: [] causes the planner to fail validation
						// 3 times and the task errors out.

						// Build a rich task description for the spec pipeline
						const descriptionParts: string[] = [];
						descriptionParts.push(`# ${safeTitle}`);
						descriptionParts.push("");
						descriptionParts.push(
							`**Source:** Azure DevOps ${item.workItemType} ${safeIdentifier}`,
						);
						if (item.state) descriptionParts.push(`**State:** ${item.state}`);
						if (item.priority)
							descriptionParts.push(`**Priority:** ${item.priority}`);
						if (item.areaPath)
							descriptionParts.push(
								`**Area:** ${sanitizeText(item.areaPath, 200)}`,
							);
						if (item.iterationPath)
							descriptionParts.push(
								`**Iteration:** ${sanitizeText(item.iterationPath, 200)}`,
							);
						if (item.tags && item.tags.length > 0) {
							descriptionParts.push(
								`**Tags:** ${item.tags.map((t) => sanitizeText(t, 100)).join(", ")}`,
							);
						}
						descriptionParts.push("");
						descriptionParts.push("## Description");
						descriptionParts.push("");
						if (safeDescription) {
							// Réduire la description HTML enrichie Azure DevOps en texte brut
							// pour le pipeline de spec (les images sont retirées ici).
							const cleanDescription = stripHtml(safeDescription);
							descriptionParts.push(cleanDescription || safeTitle);
						} else {
							descriptionParts.push(safeTitle);
						}

						if (acceptanceCriteriaList.length > 0) {
							descriptionParts.push("");
							descriptionParts.push("## Acceptance Criteria");
							descriptionParts.push("");
							for (const criterion of acceptanceCriteriaList) {
								descriptionParts.push(`- ${criterion}`);
							}
						}

						const richDescription = descriptionParts.join("\n");

						const requirements: Record<string, unknown> = {
							task_description: richDescription,
							workflow_type:
								category === "bug"
									? "bugfix"
									: category === "task"
										? "feature"
										: category,
						};
						// Titre propre et accentué du work item, conservé pour l'affichage.
						// Le scanner le sert en priorité dans extractTitle, ce qui évite de
						// retomber sur le nom de dossier slugifié (accents perdus).
						if (safeTitle) {
							requirements.display_title = safeTitle;
						}
						// HTML enrichi (images Azure DevOps inlinées en data URIs) conservé
						// séparément pour l'affichage. La scanner le sert en priorité 0
						// (getRequirementsDisplayDescription) afin que les captures de l'US/RsD
						// s'affichent sans authentification ni accès réseau au rendu.
						if (displayDescription) {
							requirements.display_description = displayDescription;
						}
						if (acceptanceCriteriaList.length > 0) {
							requirements.acceptance_criteria = acceptanceCriteriaList;
						}
						const requirementsPath = path.join(
							specDir,
							AUTO_BUILD_PATHS.REQUIREMENTS,
						);
						writeFileSync(
							requirementsPath,
							JSON.stringify(requirements, null, 2),
							"utf-8",
						);

						const metadataPath = path.join(specDir, "task_metadata.json");
						writeFileSync(
							metadataPath,
							JSON.stringify(metadata, null, 2),
							"utf-8",
						);

						const task: import("../../shared/types").Task = {
							id: specId,
							specId,
							projectId: project.id,
							title: safeTitle,
							description: displayDescription || safeDescription,
							status: "backlog",
							subtasks: [],
							logs: [],
							metadata,
							createdAt: new Date(now),
							updatedAt: new Date(now),
						};

						importedTasks.push(task);
					} catch (error: unknown) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						errors.push(
							`Failed to import work item ${item.id}: ${errorMessage}`,
						);
					}
				}

				projectStore.invalidateTasksCache(project.id);

				return {
					success: true,
					data: {
						success: true,
						imported: importedTasks.length,
						failed: errors.length,
						errors: errors.length > 0 ? errors : undefined,
						tasks: importedTasks,
					},
				};
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	// ============================================
	// Azure DevOps imported-task display hydration (on demand)
	// ============================================

	/**
	 * Hydrate the display fields of an imported Azure DevOps task on open.
	 *
	 * Older imports stored the raw work-item HTML in requirements.json and lost
	 * the clean title (the spec-folder name is slugified, so accents are gone:
	 * "Fenêtre…" → "fen-tre-…"). Two repairs, both lazy and one-shot:
	 *
	 *  - Title: when requirements.display_title is missing, fetch the work item's
	 *    System.Title via the PAT (accents intact), and persist it. extractTitle
	 *    serves it with top priority.
	 *  - Images: `<img src="https://dev.azure.com/.../_apis/wit/attachments/...">`
	 *    need PAT auth, so the renderer can't load them (ERR_TIMED_OUT). We
	 *    download + base64-inline them (display_description); any that still fail
	 *    are stripped so they never re-fire a failing request.
	 *
	 * Returns the (cleaned) html and the resolved title so the renderer can show
	 * them immediately; both are also persisted for subsequent scans.
	 */
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY,
		async (
			_,
			projectId: string,
			taskId: string,
		): Promise<IPCResult<{ html: string; title?: string }>> => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const task = projectStore
					.getTasks(projectId)
					.find((t) => t.id === taskId);
				const specDir = task?.specsPath;
				if (!specDir) {
					return { success: false, error: "Task spec directory not found" };
				}

				const requirementsPath = path.join(
					specDir,
					AUTO_BUILD_PATHS.REQUIREMENTS,
				);
				if (!existsSync(requirementsPath)) {
					return { success: false, error: "requirements.json not found" };
				}

				let requirements: Record<string, unknown>;
				try {
					requirements = JSON.parse(readFileSync(requirementsPath, "utf-8"));
				} catch {
					return { success: false, error: "requirements.json is malformed" };
				}

				const config = getAzureDevOpsConfig(project);
				let changed = false;

				// --- Title backfill (accented System.Title) -------------------------
				let resolvedTitle =
					typeof requirements.display_title === "string"
						? requirements.display_title
						: undefined;
				const identifier = task?.metadata?.azureDevOpsIdentifier ?? "";
				const workItemId = Number.parseInt(identifier.replace(/\D/g, ""), 10);
				if (
					!resolvedTitle &&
					Number.isFinite(workItemId) &&
					workItemId > 0 &&
					config.pat &&
					config.orgUrl
				) {
					try {
						const projectPath = path.join(
							project.path,
							project.autoBuildPath || "",
						);
						const envOverrides: Record<string, string> = {
							AZURE_DEVOPS_PAT: config.pat,
							AZURE_DEVOPS_ORG_URL: config.orgUrl,
						};
						const normalizedProject = normalizeProjectName(config.projectName);
						if (normalizedProject)
							envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;

						const rawItem = (await callAzureDevOpsPython(
							projectPath,
							"get_work_item",
							{ work_item_id: workItemId },
							envOverrides,
						)) as { id: number; title?: string };

						const cleanTitle = sanitizeText(
							stripHtml(rawItem.title ?? "").replace(/\s+/g, " "),
							200,
						);
						if (cleanTitle) {
							requirements.display_title = cleanTitle;
							resolvedTitle = cleanTitle;
							changed = true;
						}
					} catch (err) {
						console.warn(
							"[AZURE_DEVOPS_HYDRATE_TASK_DISPLAY] Title fetch failed (non-fatal):",
							err,
						);
					}
				}

				// --- Image inlining --------------------------------------------------
				// Prefer an already-inlined display description, else the raw one.
				const sourceHtml =
					typeof requirements.display_description === "string" &&
					requirements.display_description
						? requirements.display_description
						: typeof requirements.task_description === "string"
							? requirements.task_description
							: "";

				let html = sourceHtml;
				if (sourceHtml.includes("<img")) {
					if (config.pat && config.orgUrl) {
						html = await inlineAzureDevOpsImages(
							sourceHtml,
							config.orgUrl,
							config.pat,
						);
					}
					// Strip any attachment image that couldn't be inlined (no PAT, or
					// the download failed) so the renderer never fires a failed request.
					html = stripAzureAttachmentImages(html, config.orgUrl ?? undefined);

					if (html !== requirements.display_description) {
						requirements.display_description = html;
						changed = true;
					}
				}

				// Persist both fields together so the scanner serves them next time.
				if (changed) {
					try {
						writeFileSync(
							requirementsPath,
							JSON.stringify(requirements, null, 2),
							"utf-8",
						);
						projectStore.invalidateTasksCache(projectId);
					} catch (err) {
						console.warn(
							"[AZURE_DEVOPS_HYDRATE_TASK_DISPLAY] Could not persist display fields:",
							err,
						);
					}
				}

				return { success: true, data: { html, title: resolvedTitle } };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	// ============================================
	// Azure DevOps AC Sync Operation
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC,
		async (
			_,
			projectId: string,
			taskId: string,
			workItemId: number,
		): Promise<IPCResult<{ acceptanceCriteria: string[] }>> => {
			const project = projectStore.getProject(projectId);
			if (!project?.autoBuildPath) {
				return { success: false, error: "Project not found or not initialized" };
			}

			const config = getAzureDevOpsConfig(project);
			const envOverrides: Record<string, string> = {};
			if (config.pat) envOverrides.AZURE_DEVOPS_PAT = config.pat;
			if (config.orgUrl) envOverrides.AZURE_DEVOPS_ORG_URL = config.orgUrl;
			const normalizedProject = normalizeProjectName(config.projectName);
			if (normalizedProject) envOverrides.AZURE_DEVOPS_PROJECT = normalizedProject;
			if (!config.pat || !config.orgUrl) {
				return { success: false, error: "Azure DevOps not configured" };
			}

			try {
				const projectPath = path.join(project.path, project.autoBuildPath || "");

				const rawItem = (await callAzureDevOpsPython(
					projectPath,
					"get_work_item",
					{ work_item_id: workItemId },
					envOverrides,
				)) as { id: number; title: string; acceptanceCriteria?: string };

				const acceptanceCriteriaList = parseAcceptanceCriteriaText(
					rawItem.acceptanceCriteria ?? undefined,
				);

				// Persist to disk via TASK_UPDATE path (task_metadata.json + requirements.json)
				const task = projectStore.getTasks(projectId).find((t) => t.id === taskId);
				if (task?.specsPath) {
					const specDir = task.specsPath;
					const metadataPath = path.join(specDir, "task_metadata.json");
					const requirementsPath = path.join(specDir, "requirements.json");

					if (existsSync(metadataPath)) {
						const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
						meta.acceptanceCriteria = acceptanceCriteriaList;
						writeFileSync(metadataPath, JSON.stringify(meta, null, 2), "utf-8");
					}

					if (existsSync(requirementsPath)) {
						const reqs = JSON.parse(readFileSync(requirementsPath, "utf-8"));
						reqs.acceptance_criteria = acceptanceCriteriaList;
						writeFileSync(
							requirementsPath,
							JSON.stringify(reqs, null, 2),
							"utf-8",
						);
					}

					projectStore.invalidateTasksCache(projectId);
				}

				return { success: true, data: { acceptanceCriteria: acceptanceCriteriaList } };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	// ============================================
	// Azure DevOps PR Review Operations
	// ============================================

	// Track running review processes
	const runningPRReviews = new Map<string, ReturnType<typeof spawn>>();

	/**
	 * Run AI-powered PR review using the azure_devops runner
	 */
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW,
		async (_event, projectId: string, prId: number, repositoryId?: string) => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const azConfig = getAzureDevOpsConfig(project);
				if (!azConfig.pat || !azConfig.orgUrl || !azConfig.projectName) {
					return {
						success: false,
						error: "Azure DevOps not configured for this project",
					};
				}

				const repoId = repositoryId || "";
				const runnerPath = path.resolve(
					backendPath,
					"runners",
					"azure_devops",
					"runner.py",
				);
				const pythonArgs = [
					runnerPath,
					"review-pr",
					prId.toString(),
					"--project",
					sanitizeText(normalizeProjectName(azConfig.projectName) || "", 200),
					"--repo",
					sanitizeText(repoId, 200),
					"--project-dir",
					project.path,
				];

				const env = {
					...process.env,
					AZURE_DEVOPS_PAT: azConfig.pat,
					AZURE_DEVOPS_ORG_URL: azConfig.orgUrl,
					AZURE_DEVOPS_PROJECT: azConfig.projectName,
					PYTHONPATH: backendPath,
				};

				return new Promise<IPCResult>((resolve) => {
					let stdout = "";
					let stderr = "";

					const child = spawn("python", pythonArgs, {
						cwd: backendPath,
						env,
						stdio: ["pipe", "pipe", "pipe"],
					});

					const reviewKey = `${projectId}:${prId}`;
					runningPRReviews.set(reviewKey, child);

					child.stdout?.on("data", (data: Buffer) => {
						stdout += data.toString();
					});

					child.stderr?.on("data", (data: Buffer) => {
						stderr += data.toString();
					});

					child.on("close", (code: number | null) => {
						runningPRReviews.delete(reviewKey);

						if (code !== 0) {
							resolve({
								success: false,
								error: `Review process exited with code ${code}: ${stderr.slice(-500)}`,
							});
							return;
						}

						try {
							const result = JSON.parse(stdout);
							resolve({ success: true, data: result });
						} catch {
							resolve({
								success: false,
								error: `Failed to parse review result: ${stdout.slice(-200)}`,
							});
						}
					});

					child.on("error", (err: Error) => {
						runningPRReviews.delete(reviewKey);
						resolve({ success: false, error: err.message });
					});
				});
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	/**
	 * Get a saved PR review result
	 */
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_PR_GET_REVIEW,
		async (_event, projectId: string, prId: number) => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const reviewFile = path.join(
					project.path,
					".workpilot",
					"azure-devops",
					"pr",
					`review_${prId}.json`,
				);

				if (!existsSync(reviewFile)) {
					return { success: true, data: null };
				}

				const content = readFileSync(reviewFile, "utf-8");
				return { success: true, data: JSON.parse(content) };
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);

	/**
	 * Cancel a running PR review
	 */
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_CANCEL,
		async (_event, projectId: string, prId: number) => {
			const reviewKey = `${projectId}:${prId}`;
			const child = runningPRReviews.get(reviewKey);

			if (!child) {
				return { success: false, error: "No running review found" };
			}

			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 5000);

			runningPRReviews.delete(reviewKey);
			return { success: true };
		},
	);

	/**
	 * Post a comment on an Azure DevOps PR
	 */
	ipcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_PR_POST_COMMENT,
		async (
			_event,
			projectId: string,
			prId: number,
			content: string,
			repositoryId?: string,
		) => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const azConfig = getAzureDevOpsConfig(project);
				if (!azConfig.pat || !azConfig.orgUrl || !azConfig.projectName) {
					return { success: false, error: "Azure DevOps not configured" };
				}

				// Use Python script to post comment via the connector
				const sanitizedContent = sanitizeText(content, 5000);
				const repoId = repositoryId || "";
				const projectName = normalizeProjectName(azConfig.projectName) || "";

				const pythonScript = `
import sys, json, os
from pathlib import Path
sys.path.insert(0, '${backendPath.replaceAll("\\", "\\\\")}')
sys.path.insert(0, str(Path('${connectorSrcPath.replaceAll("\\", "\\\\")}').parent))
sys.path.insert(0, '${connectorSrcPath.replaceAll("\\", "\\\\")}')

from src.config.settings import Settings
from src.connectors.azure_devops.client import AzureDevOpsClient
from src.connectors.azure_devops.repos import AzureReposClient

settings = Settings(
    pat=os.environ['AZURE_DEVOPS_PAT'],
    organization_url=os.environ['AZURE_DEVOPS_ORG_URL'],
    project='${projectName.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}',
)
client = AzureDevOpsClient.from_settings(settings)
git_client = client.get_git_client()

from azure.devops.v7_0.git.models import Comment, GitPullRequestCommentThread

thread = GitPullRequestCommentThread(
    comments=[Comment(content=${JSON.stringify(sanitizedContent)})],
    status='active',
)

git_client.create_thread(
    comment_thread=thread,
    repository_id='${repoId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}',
    pull_request_id=${prId},
    project='${projectName.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}',
)
print(json.dumps({'success': True}))
`;

				return new Promise<IPCResult>((resolve) => {
					const child = spawn("python", ["-c", pythonScript], {
						cwd: backendPath,
						env: {
							...process.env,
							AZURE_DEVOPS_PAT: azConfig.pat || "",
							AZURE_DEVOPS_ORG_URL: azConfig.orgUrl || "",
							PYTHONPATH: backendPath,
						},
					});

					let _stdout = "";
					let stderr = "";

					child.stdout?.on("data", (data: Buffer) => {
						_stdout += data.toString();
					});
					child.stderr?.on("data", (data: Buffer) => {
						stderr += data.toString();
					});

					child.on("close", (code: number | null) => {
						if (code !== 0) {
							resolve({
								success: false,
								error: `Failed to post comment: ${stderr.slice(-300)}`,
							});
						} else {
							resolve({ success: true });
						}
					});
				});
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return { success: false, error: errorMessage };
			}
		},
	);
}
