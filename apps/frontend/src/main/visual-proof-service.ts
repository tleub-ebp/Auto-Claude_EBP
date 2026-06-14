import {
	execFile,
	spawn,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { BrowserWindow, desktopCapturer } from "electron";
import { getSpecsDir } from "../shared/constants";
import type {
	VisualProofApiSmoke,
	VisualProofNavigationPlan,
	VisualProofNavigationStep,
	VisualProofProviderId,
	VisualProofRun,
	VisualProofRunOptions,
	VisualProofScreenshot,
	VisualProofStatus,
	VisualProofTargetKind,
} from "../shared/types";
import { runApiSmokeProof } from "./api-smoke";
import { logger } from "./app-logger";
import type { AppEmulatorConfig } from "./app-emulator-service";
import { appEmulatorService } from "./app-emulator-service";
import {
	findCommandInPath,
	findMsBuildInvocation,
	LEGACY_MSBUILD_UNAVAILABLE_MESSAGE,
} from "./dotnet-msbuild";
import {
	LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE,
	createLegacyCompilerBuildArgs,
	createLegacyPackageReferencesTarget,
	createLegacySdkBuildArgs,
	ensureLegacyWorktreeBuildAssets,
	LEGACY_RESOURCE_PROPERTY,
	runWithShortLegacySolutionPath,
	runWithLegacyXmlNamespacePatch,
} from "./legacy-dotnet-build";

const execFileAsync = promisify(execFile);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const DEFAULT_IIS_EXPRESS_PORT = 50548;
const PROVIDER_ENV = "WORKPILOT_VISUAL_PROOF_PROVIDER";
const REMOTE_URL_ENV = "WORKPILOT_VISUAL_PROOF_REMOTE_URL";
const HYPERV_COMMAND_ENV = "WORKPILOT_VISUAL_PROOF_HYPERV_COMMAND";
const HYPERV_ARGS_ENV = "WORKPILOT_VISUAL_PROOF_HYPERV_ARGS";
const WSL_COMMAND_ENV = "WORKPILOT_VISUAL_PROOF_WSL_COMMAND";
const WSL_ARGS_ENV = "WORKPILOT_VISUAL_PROOF_WSL_ARGS";
const IIS_EXPRESS_ENV = "WORKPILOT_IIS_EXPRESS_PATH";
const DESKTOP_CAPTURE_COUNT_ENV = "WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES";
/** When set, the desktop app is launched without UAC elevation (no Start-Process -Verb RunAs). */
const NO_ELEVATE_ENV = "WORKPILOT_VISUAL_PROOF_NO_ELEVATE";
const DESKTOP_CAPTURE_INTERVAL_MS = 2500;
const NAVIGATION_ENV = "WORKPILOT_VISUAL_PROOF_NAVIGATION";
const NAVIGATION_FILE_NAME = "visual-proof-navigation.json";
const NAVIGATION_STEP_SETTLE_MS = 1200;
const NAVIGATION_WAIT_TIMEOUT_MS = 15000;
const LEGACY_DOTNET_BUILD_MAX_BUFFER = 100 * 1024 * 1024;
const LEGACY_WEB_HOST_UNAVAILABLE_MESSAGE =
	"IIS Express/xsp was not found for this legacy .NET Framework web app.";

const WEB_FRAMEWORKS = new Set([
	"angular",
	"vite",
	"next",
	"nuxt",
	"create-react-app",
	"vue-cli",
	"svelte",
	"django",
	"fastapi",
	"flask",
	"streamlit",
	"dotnet",
	"docker",
	"docker-compose",
	"go",
	"nestjs",
	"express",
]);

interface GitHubPrRef {
	owner: string;
	repo: string;
	pullNumber: string;
}

interface DotNetProjectInfo {
	csprojPath: string;
	projectDir: string;
	isLegacy: boolean;
	isDesktop: boolean;
	isWeb: boolean;
}

interface VisualProofProviderContext {
	options: VisualProofRunOptions;
	runPath: string;
	artifactDir: string;
	relativeArtifactDir: string;
	config: AppEmulatorConfig;
	dotnetProjects: DotNetProjectInfo[];
}

interface VisualProofProviderResult {
	status: VisualProofStatus;
	targetKind: VisualProofTargetKind;
	isolated: boolean;
	providerDetails?: string;
	framework?: string;
	appUrl?: string;
	screenshots: VisualProofScreenshot[];
	apiSmoke?: VisualProofApiSmoke;
	error?: string;
}

interface VisualProofProvider {
	id: VisualProofProviderId;
	canHandle(context: VisualProofProviderContext): boolean;
	run(context: VisualProofProviderContext): Promise<VisualProofProviderResult>;
}

interface DesktopCaptureSourceLike {
	id: string;
	name: string;
}

interface DesktopCaptureSelectionOptions {
	excludeSourceIds?: ReadonlySet<string>;
	requireWindowMatch?: boolean;
}

interface DesktopImageCaptureOptions extends DesktopCaptureSelectionOptions {
	preferredNames?: readonly string[];
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return `visual-proof-${timestamp}`;
}

export function parseGitHubPrUrl(prUrl: string): GitHubPrRef | null {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(
		prUrl,
	);
	if (!match) return null;
	return {
		owner: match[1],
		repo: match[2].replace(/\.git$/i, ""),
		pullNumber: match[3],
	};
}

function normalizePathForMarkdown(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

function normalizeEnvProvider(
	value: string | undefined,
): VisualProofProviderId | null {
	if (!value || value === "auto") return null;
	const allowed = new Set<VisualProofProviderId>([
		"local-web",
		"local-iis-express",
		"local-windows-desktop",
		"docker",
		"wsl",
		"hyper-v",
		"remote-runner",
	]);
	return allowed.has(value as VisualProofProviderId)
		? (value as VisualProofProviderId)
		: null;
}

function requestedProvider(
	options: VisualProofRunOptions,
): VisualProofProviderId | null {
	return normalizeEnvProvider(
		options.provider && options.provider !== "auto"
			? options.provider
			: process.env[PROVIDER_ENV],
	);
}

function isLikelyTestProjectPath(candidatePath: string): boolean {
	const segments = candidatePath
		.toLowerCase()
		.split(/[\\/]+/)
		.map((segment) => segment.replace(/\.csproj$/i, ""));
	return segments.some(
		(segment) =>
			segment === "tests" ||
			segment === "test" ||
			segment === "unittests" ||
			segment === "automatedtests" ||
			segment.endsWith(".tests") ||
			segment.endsWith(".test") ||
			segment.endsWith(".testapplication") ||
			segment.includes("testapplication"),
	);
}

function scanFiles(
	rootDir: string,
	maxDepth: number,
	predicate: (filePath: string, entry: string) => boolean,
): string[] {
	const results: string[] = [];
	const scan = (dir: string, depth: number): void => {
		if (depth < 0) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (
				entry === "node_modules" ||
				entry === ".git" ||
				entry === "dist" ||
				isLikelyTestProjectPath(entry)
			) {
				continue;
			}
			const full = path.join(dir, entry);
			let isDirectory = false;
			try {
				isDirectory = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) {
				scan(full, depth - 1);
				continue;
			}
			if (predicate(full, entry)) {
				results.push(full);
			}
		}
	};
	scan(rootDir, maxDepth);
	return results;
}

function readTextFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function analyzeDotNetProject(csprojPath: string): DotNetProjectInfo {
	const content = readTextFile(csprojPath) ?? "";
	const legacyTfm = /<TargetFrameworkVersion>\s*v4\./i;
	const legacyMoniker = /<TargetFramework[s]?>\s*net4[0-9]{1,2}\b/i;
	const sdkStyle = /<Project\s+Sdk=/i;
	const isLegacy =
		legacyTfm.test(content) ||
		legacyMoniker.test(content) ||
		(!sdkStyle.test(content) && /<TargetFrameworkVersion>/i.test(content));
	const isDesktop =
		/<UseWPF>\s*true\s*<\/UseWPF>/i.test(content) ||
		/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content) ||
		/<OutputType>\s*WinExe\s*<\/OutputType>/i.test(content) ||
		/System\.Windows\.Forms/i.test(content) ||
		/PresentationFramework/i.test(content);
	const hasExplicitWebMarkers =
		/System\.Web/i.test(content) ||
		/Microsoft\.WebApplication\.targets/i.test(content) ||
		/{349c5851-65df-11da-9384-00065b846f21}/i.test(content);
	const isWeb = hasExplicitWebMarkers && !isDesktop;

	return {
		csprojPath,
		projectDir: path.dirname(csprojPath),
		isLegacy,
		isDesktop,
		isWeb,
	};
}

export function analyzeDotNetProjects(searchDir: string): DotNetProjectInfo[] {
	return scanFiles(searchDir, 4, (_filePath, entry) =>
		entry.toLowerCase().endsWith(".csproj") && !isLikelyTestProjectPath(entry),
	).map(analyzeDotNetProject);
}

/**
 * Indicates whether a project targets legacy .NET Framework (for example v4.8).
 *
 * The default emulator uses `dotnet run`, which does not work for non-SDK
 * .NET Framework projects. Provider selection uses this to route legacy web
 * apps to IIS Express and desktop apps to the Windows desktop provider.
 */
export function isLegacyDotNetFramework(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some((project) => project.isLegacy);
}

export function hasLegacyDotNetDesktopProject(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some(
		(project) => project.isLegacy && project.isDesktop,
	);
}

export function hasLegacyDotNetWebProject(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some(
		(project) => project.isLegacy && project.isWeb,
	);
}

async function getCurrentBranch(worktreePath: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: worktreePath },
		);
		return stdout.trim() || null;
	} catch (error) {
		logger.warn("[VisualProof] Could not resolve worktree branch:", error);
		return null;
	}
}

async function commitAndPushArtifacts(
	worktreePath: string,
	relativeDir: string,
	specId: string,
): Promise<string | undefined> {
	await execFileAsync("git", ["add", "--", relativeDir], { cwd: worktreePath });

	const status = await execFileAsync(
		"git",
		["status", "--porcelain", "--", relativeDir],
		{ cwd: worktreePath },
	);
	if (!status.stdout.trim()) {
		return undefined;
	}

	await execFileAsync(
		"git",
		["commit", "-m", `Add visual proof screenshots for ${specId}`],
		{ cwd: worktreePath },
	);

	const branch = await getCurrentBranch(worktreePath);
	if (branch) {
		await execFileAsync("git", ["push", "origin", branch], { cwd: worktreePath });
	}

	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
		cwd: worktreePath,
	});
	return stdout.trim() || undefined;
}

async function postGitHubComment(
	prUrl: string,
	body: string,
): Promise<string | undefined> {
	const pr = parseGitHubPrUrl(prUrl);
	if (!pr) return undefined;

	const { stdout } = await execFileAsync(
		"gh",
		[
			"api",
			`repos/${pr.owner}/${pr.repo}/issues/${pr.pullNumber}/comments`,
			"-f",
			`body=${body}`,
			"--jq",
			".html_url",
		],
		{ encoding: "utf-8" },
	);
	return stdout.trim() || undefined;
}

export function buildProofComment(run: VisualProofRun, branch?: string): string {
	const lines = [
		"## WorkPilot visual proof",
		"",
		`Status: **${run.status}**`,
		run.framework ? `Framework: \`${run.framework}\`` : undefined,
		run.provider ? `Provider: \`${run.provider}\`` : undefined,
		run.targetKind ? `Target: \`${run.targetKind}\`` : undefined,
		typeof run.isolated === "boolean"
			? `Isolation: **${run.isolated ? "isolated" : "local"}**`
			: undefined,
		run.providerDetails ? `Provider details: ${run.providerDetails}` : undefined,
		run.appUrl ? `Emulated URL: ${run.appUrl}` : undefined,
		"",
	].filter((line): line is string => line !== undefined);

	if (run.error) {
		lines.push(`Error: ${run.error}`, "");
	}

	if (run.apiSmoke && run.apiSmoke.attempted > 0) {
		lines.push(
			"### API smoke",
			"",
			`**${run.apiSmoke.passed}/${run.apiSmoke.attempted}** endpoints passed` +
				` ([OpenAPI](${run.apiSmoke.specUrl}))`,
			"",
			"| Endpoint | Status | Result |",
			"| --- | --- | --- |",
			...run.apiSmoke.results.map(
				(result) =>
					`| \`${result.method} ${result.path}\` | ${result.status ?? "—"} | ${
						result.ok ? "✅" : "❌"
					} |`,
			),
			"",
		);
	}

	if (run.screenshots.length > 0) {
		lines.push("### Screenshots", "");
		for (const screenshot of run.screenshots) {
			const imageUrl =
				screenshot.url ??
				(branch
					? `blob/${branch}/${normalizePathForMarkdown(
							screenshot.relativePath,
						)}?raw=1`
					: normalizePathForMarkdown(screenshot.relativePath));
			lines.push(`![${screenshot.label}](${imageUrl})`);
			lines.push("");
		}
	} else {
		lines.push("No screenshot was captured.", "");
	}

	lines.push(`Run ID: \`${run.id}\``);
	return lines.join("\n");
}

async function captureWebPage(
	url: string,
	outputPath: string,
): Promise<{ width: number; height: number }> {
	const window = new BrowserWindow({
		show: false,
		width: DEFAULT_VIEWPORT.width,
		height: DEFAULT_VIEWPORT.height,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	try {
		await window.loadURL(url);
		await delay(1500);
		const image = await window.webContents.capturePage();
		writeFileSync(outputPath, image.toPNG());
		return DEFAULT_VIEWPORT;
	} finally {
		if (!window.isDestroyed()) {
			window.close();
		}
	}
}

type WebContentsLike = Pick<
	BrowserWindow["webContents"],
	"loadURL" | "executeJavaScript" | "capturePage"
>;

function buildWaitForSelectorScript(selector: string, timeoutMs: number): string {
	const sel = JSON.stringify(selector);
	return `new Promise((resolve) => {
		const deadline = Date.now() + ${timeoutMs};
		const tick = () => {
			if (document.querySelector(${sel})) { resolve(true); return; }
			if (Date.now() > deadline) { resolve(false); return; }
			setTimeout(tick, 200);
		};
		tick();
	})`;
}

function buildClickScript(selector: string): string {
	const sel = JSON.stringify(selector);
	return `(() => {
		const el = document.querySelector(${sel});
		if (!el) return false;
		el.scrollIntoView({ block: 'center' });
		el.click();
		return true;
	})()`;
}

function buildFillScript(selector: string, value: string): string {
	const sel = JSON.stringify(selector);
	const val = JSON.stringify(value);
	return `(() => {
		const el = document.querySelector(${sel});
		if (!el) return false;
		const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
		if (setter && setter.set) { setter.set.call(el, ${val}); }
		else { el.value = ${val}; }
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	})()`;
}

/**
 * Exécute une étape de navigation web dans la page chargée. Best-effort : un
 * sélecteur introuvable est journalisé sans interrompre la séquence, afin de
 * toujours produire des preuves visuelles même si l'UI a légèrement changé.
 */
async function runWebNavigationStep(
	webContents: WebContentsLike,
	step: VisualProofNavigationStep,
	baseUrl: string,
): Promise<void> {
	if (step.path) {
		const target = new URL(step.path, baseUrl).toString();
		await webContents.loadURL(target);
		await delay(500);
	}
	if (step.waitForSelector) {
		const found = await webContents.executeJavaScript(
			buildWaitForSelectorScript(step.waitForSelector, NAVIGATION_WAIT_TIMEOUT_MS),
		);
		if (found === false) {
			logger.warn(
				`[VisualProof] Selector never appeared: ${step.waitForSelector}`,
			);
		}
	}
	if (step.fill) {
		const ok = await webContents.executeJavaScript(
			buildFillScript(step.fill.selector, step.fill.value),
		);
		if (ok === false) {
			logger.warn(`[VisualProof] Fill target not found: ${step.fill.selector}`);
		}
	}
	if (step.click) {
		const ok = await webContents.executeJavaScript(buildClickScript(step.click));
		if (ok === false) {
			logger.warn(`[VisualProof] Click target not found: ${step.click}`);
		}
	}
	await delay(step.delayMs ?? NAVIGATION_STEP_SETTLE_MS);
}

function navigationScreenshotFileName(index: number, label?: string): string {
	const safeLabel = label
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return safeLabel
		? `feature-${index + 1}-${safeLabel}.png`
		: `feature-${index + 1}.png`;
}

/**
 * Navigue jusqu'à la feature implémentée puis capture une ou plusieurs preuves
 * visuelles. Sans plan, retombe sur une simple capture de la page d'accueil.
 */
async function captureWebFeatureScreenshots(
	baseUrl: string,
	context: VisualProofProviderContext,
	steps: readonly VisualProofNavigationStep[],
): Promise<VisualProofScreenshot[]> {
	if (steps.length === 0) {
		const fileName = "home.png";
		const screenshotPath = path.join(context.artifactDir, fileName);
		const viewport = await captureWebPage(baseUrl, screenshotPath);
		return [
			createScreenshot(
				"Home page",
				context.relativeArtifactDir,
				fileName,
				screenshotPath,
				viewport,
			),
		];
	}

	const window = new BrowserWindow({
		show: false,
		width: DEFAULT_VIEWPORT.width,
		height: DEFAULT_VIEWPORT.height,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	const screenshots: VisualProofScreenshot[] = [];
	try {
		await window.loadURL(baseUrl);
		await delay(1500);
		let captureIndex = 0;
		for (const step of steps) {
			await runWebNavigationStep(window.webContents, step, baseUrl);
			if (step.capture === false) continue;
			const fileName = navigationScreenshotFileName(captureIndex, step.label);
			const screenshotPath = path.join(context.artifactDir, fileName);
			const image = await window.webContents.capturePage();
			writeFileSync(screenshotPath, image.toPNG());
			screenshots.push(
				createScreenshot(
					step.label ?? `Feature step ${captureIndex + 1}`,
					context.relativeArtifactDir,
					fileName,
					screenshotPath,
					DEFAULT_VIEWPORT,
				),
			);
			captureIndex += 1;
		}
	} finally {
		if (!window.isDestroyed()) {
			window.close();
		}
	}

	if (screenshots.length === 0) {
		const fileName = "home.png";
		const screenshotPath = path.join(context.artifactDir, fileName);
		const viewport = await captureWebPage(baseUrl, screenshotPath);
		screenshots.push(
			createScreenshot(
				"Home page",
				context.relativeArtifactDir,
				fileName,
				screenshotPath,
				viewport,
			),
		);
	}
	return screenshots;
}

/**
 * API complement to the visual proof: when the started app exposes an OpenAPI
 * document, smoke-test the parameterless GET endpoints (report written to the
 * artifact dir) and capture the Swagger/OpenAPI console as a screenshot.
 * Best-effort: returns empty results when the app is not an API.
 */
async function runApiProof(
	appUrl: string,
	context: VisualProofProviderContext,
): Promise<{
	apiSmoke?: VisualProofApiSmoke;
	screenshots: VisualProofScreenshot[];
}> {
	const screenshots: VisualProofScreenshot[] = [];
	const apiSmoke = await runApiSmokeProof(appUrl, context.artifactDir);
	if (!apiSmoke) return { screenshots };

	if (apiSmoke.swaggerUiUrl) {
		const fileName = "swagger-ui.png";
		const screenshotPath = path.join(context.artifactDir, fileName);
		try {
			const viewport = await captureWebPage(apiSmoke.swaggerUiUrl, screenshotPath);
			screenshots.push(
				createScreenshot(
					"Swagger UI",
					context.relativeArtifactDir,
					fileName,
					screenshotPath,
					viewport,
				),
			);
		} catch (error) {
			logger.warn("[VisualProof] Could not capture Swagger UI:", error);
		}
	}
	return { apiSmoke, screenshots };
}

function describeApiSmoke(apiSmoke: VisualProofApiSmoke | undefined): string {
	if (!apiSmoke || apiSmoke.attempted === 0) return "";
	return ` API smoke: ${apiSmoke.passed}/${apiSmoke.attempted} endpoints passed.`;
}

async function captureDesktopImage(
	outputPath: string,
	options: DesktopImageCaptureOptions = {},
): Promise<{ width: number; height: number }> {
	const sources = await desktopCapturer.getSources({
		types: options.requireWindowMatch ? ["window"] : ["window", "screen"],
		thumbnailSize: DEFAULT_VIEWPORT,
	});
	if (sources.length === 0) {
		throw new Error("No desktop or window source was available for capture");
	}

	const source = selectDesktopCaptureSource(sources, options.preferredNames, {
		excludeSourceIds: options.excludeSourceIds,
		requireWindowMatch: options.requireWindowMatch,
	});
	if (!source) {
		const names = normalizePreferredWindowNames(options.preferredNames);
		throw new Error(
			names.length > 0
				? `No desktop application window matched ${names.join(", ")}`
				: "No desktop application window was available for capture",
		);
	}
	const size = source.thumbnail.getSize();
	writeFileSync(outputPath, source.thumbnail.toPNG());
	return {
		width: size.width || DEFAULT_VIEWPORT.width,
		height: size.height || DEFAULT_VIEWPORT.height,
	};
}

async function getDesktopWindowSourceIds(): Promise<Set<string>> {
	const sources = await desktopCapturer.getSources({
		types: ["window"],
		thumbnailSize: { width: 1, height: 1 },
	});
	return new Set(sources.map((source) => source.id));
}

function normalizePreferredWindowNames(names: readonly string[] = []): string[] {
	return [
		...new Set(
			names
				.map((name) => name.trim().toLowerCase())
				.filter((name) => name.length > 0),
		),
	];
}

function isWindowSource(source: DesktopCaptureSourceLike): boolean {
	return source.id.startsWith("window:");
}

function isWorkPilotWindowName(name: string): boolean {
	return /workpilot|auto-claude|visual studio code|vscode|copilot/i.test(name);
}

export function selectDesktopCaptureSource<T extends DesktopCaptureSourceLike>(
	sources: readonly T[],
	preferredNames: readonly string[] = [],
	options: DesktopCaptureSelectionOptions = {},
): T | null {
	const preferred = normalizePreferredWindowNames(preferredNames);
	const windows = sources.filter(isWindowSource);
	const eligibleWindows = windows.filter(
		(source) => !isWorkPilotWindowName(source.name),
	);
	const candidateWindows = eligibleWindows.filter(
		(source) => !options.excludeSourceIds?.has(source.id),
	);
	const matchesPreferred = (source: T) => {
		const normalizedSourceName = source.name.toLowerCase();
		return preferred.some((name) => normalizedSourceName.includes(name));
	};

	if (preferred.length > 0) {
		const preferredMatch =
			candidateWindows.find(matchesPreferred) ??
			(options.excludeSourceIds ? undefined : eligibleWindows.find(matchesPreferred));
		if (preferredMatch) {
			return preferredMatch;
		}
	}

	if (candidateWindows[0]) {
		return candidateWindows[0];
	}

	if (options.requireWindowMatch) {
		return null;
	}

	return eligibleWindows[0] ?? windows[0] ?? sources[0] ?? null;
}

async function readWindowsProcessWindowTitle(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowTitle }`,
			],
			{ windowsHide: true, maxBuffer: 64 * 1024 },
		);
		const title = stdout.trim();
		return title.length > 0 ? title : null;
	} catch {
		return null;
	}
}

async function waitForProcessWindowNames(
	pid: number | undefined,
	fallbackNames: readonly string[],
): Promise<string[]> {
	const names = new Set(fallbackNames.filter((name) => name.trim().length > 0));
	if (process.platform !== "win32" || !pid) {
		await delay(3000);
		return [...names];
	}

	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const title = await readWindowsProcessWindowTitle(pid);
		if (title) {
			names.add(title);
			break;
		}
		await delay(500);
	}
	return [...names];
}

function resolveDesktopCaptureCount(): number {
	const raw = process.env[DESKTOP_CAPTURE_COUNT_ENV];
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(parsed)) return 3;
	return Math.min(Math.max(parsed, 1), 10);
}

function isNavigationStep(value: unknown): value is VisualProofNavigationStep {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise une valeur JSON arbitraire en plan de navigation. Accepte soit un
 * objet `{ web?, desktop? }`, soit un tableau simple d'étapes (appliqué aux deux
 * cibles). Les entrées invalides sont ignorées silencieusement.
 */
export function normalizeNavigationPlan(
	value: unknown,
): VisualProofNavigationPlan | null {
	if (Array.isArray(value)) {
		const steps = value.filter(isNavigationStep);
		if (steps.length === 0) return null;
		return { web: steps, desktop: steps };
	}
	if (!isNavigationStep(value)) return null;
	const candidate = value as {
		web?: unknown;
		desktop?: unknown;
		steps?: unknown;
	};
	const web = Array.isArray(candidate.web)
		? candidate.web.filter(isNavigationStep)
		: Array.isArray(candidate.steps)
			? candidate.steps.filter(isNavigationStep)
			: [];
	const desktop = Array.isArray(candidate.desktop)
		? candidate.desktop.filter(isNavigationStep)
		: Array.isArray(candidate.steps)
			? candidate.steps.filter(isNavigationStep)
			: [];
	if (web.length === 0 && desktop.length === 0) return null;
	return {
		web: web.length > 0 ? web : undefined,
		desktop: desktop.length > 0 ? desktop : undefined,
	};
}

function parseNavigationJson(raw: string): VisualProofNavigationPlan | null {
	try {
		return normalizeNavigationPlan(JSON.parse(raw));
	} catch (error) {
		logger.warn(
			`[VisualProof] Could not parse navigation plan: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * Charge le plan de navigation vers la feature. Priorité :
 *   1. Env WORKPILOT_VISUAL_PROOF_NAVIGATION (JSON inline ou chemin vers un .json)
 *   2. Fichier .workpilot/visual-proof-navigation.json dans worktreePath puis projectPath
 * Retourne null si aucun plan exploitable.
 */
export function loadVisualProofNavigationPlan(
	options: Partial<Pick<VisualProofRunOptions, "worktreePath" | "projectPath">>,
): VisualProofNavigationPlan | null {
	const envValue = process.env[NAVIGATION_ENV]?.trim();
	if (envValue) {
		if (envValue.startsWith("{") || envValue.startsWith("[")) {
			const inline = parseNavigationJson(envValue);
			if (inline) return inline;
		} else if (existsSync(envValue)) {
			const fileContent = readTextFile(envValue);
			if (fileContent) {
				const parsed = parseNavigationJson(fileContent);
				if (parsed) return parsed;
			}
		}
	}

	const searchRoots = [options.worktreePath, options.projectPath].filter(
		(root): root is string => Boolean(root),
	);
	for (const root of searchRoots) {
		const candidate = path.join(root, ".workpilot", NAVIGATION_FILE_NAME);
		if (existsSync(candidate)) {
			const fileContent = readTextFile(candidate);
			if (fileContent) {
				const parsed = parseNavigationJson(fileContent);
				if (parsed) return parsed;
			}
		}
	}
	return null;
}

interface DesktopCaptureSequenceOptions {
	excludeSourceIds: ReadonlySet<string>;
	preferredNames: readonly string[];
}

/**
 * Capture une séquence de screenshots de la fenêtre de l'application cible.
 * Plusieurs captures espacées laissent le temps à l'application de charger et,
 * le cas échéant, à l'utilisateur/automation de naviguer jusqu'à la feature
 * implémentée. Le nombre de captures est configurable via
 * WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES (défaut: 3).
 */
async function captureDesktopScreenshotSequence(
	context: VisualProofProviderContext,
	options: DesktopCaptureSequenceOptions,
): Promise<VisualProofScreenshot[]> {
	const total = resolveDesktopCaptureCount();
	const screenshots: VisualProofScreenshot[] = [];
	let lastError: unknown;
	for (let index = 0; index < total; index += 1) {
		if (index > 0) {
			await delay(DESKTOP_CAPTURE_INTERVAL_MS);
		}
		const fileName = total === 1 ? "desktop.png" : `desktop-${index + 1}.png`;
		const screenshotPath = path.join(context.artifactDir, fileName);
		try {
			const size = await captureDesktopImage(screenshotPath, {
				excludeSourceIds: options.excludeSourceIds,
				preferredNames: options.preferredNames,
				requireWindowMatch: true,
			});
			screenshots.push(
				createScreenshot(
					total === 1
						? "Desktop application"
						: `Desktop application (${index + 1}/${total})`,
					context.relativeArtifactDir,
					fileName,
					screenshotPath,
					size,
				),
			);
		} catch (error) {
			lastError = error;
		}
	}
	if (screenshots.length === 0) {
		throw lastError instanceof Error
			? lastError
			: new Error("Could not capture the desktop application window");
	}
	return screenshots;
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replaceAll("'", "''");
}

/**
 * Génère un script PowerShell qui pilote la fenêtre du process cible via
 * Windows UI Automation (System.Windows.Automation). Selon l'étape, il invoque
 * un contrôle par nom (menu/bouton) ou écrit du texte dans un champ. Retourne
 * null si l'étape ne contient aucune action desktop exploitable.
 *
 * Limite connue (UIPI) : si l'app cible est élevée (admin) et que WorkPilot ne
 * l'est pas, l'invoke peut être refusé. La capture d'écran reste fonctionnelle.
 */
export function buildUiAutomationStepScript(
	pid: number,
	step: VisualProofNavigationStep,
): string | null {
	let action: string | null = null;
	if (step.invoke) {
		const name = escapePowerShellSingleQuoted(step.invoke);
		action = `$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name}')
$el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
if (-not $el) { exit 3 }
try {
  $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
} catch {
  try {
    $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $sel.Select()
  } catch { exit 4 }
}`;
	} else if (step.setText) {
		const name = escapePowerShellSingleQuoted(step.setText.name);
		const value = escapePowerShellSingleQuoted(step.setText.value);
		action = `$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name}')
$el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
if (-not $el) { exit 3 }
try {
  $value = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue('${value}')
} catch { exit 4 }`;
	}
	if (!action) return null;
	return `$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$procCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $procCond)
if (-not $win) { exit 2 }
${action}
exit 0`;
}

/**
 * Exécute une étape de navigation desktop via UI Automation. Best-effort : toute
 * erreur (fenêtre/contrôle introuvable, UIPI) est journalisée sans interrompre
 * la séquence afin de toujours produire des preuves visuelles.
 */
async function runDesktopNavigationStep(
	pid: number | undefined,
	step: VisualProofNavigationStep,
	canDrive: boolean,
): Promise<void> {
	if (
		canDrive &&
		process.platform === "win32" &&
		pid &&
		(step.invoke || step.setText)
	) {
		const script = buildUiAutomationStepScript(pid, step);
		if (script) {
			try {
				await execFileAsync(
					"powershell",
					["-NoProfile", "-NonInteractive", "-Command", script],
					{ windowsHide: true, maxBuffer: 256 * 1024 },
				);
			} catch (error) {
				logger.warn(
					`[VisualProof] UI Automation step failed (${
						step.invoke ?? step.setText?.name ?? "unknown"
					}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	await delay(step.delayMs ?? NAVIGATION_STEP_SETTLE_MS);
}

interface DesktopFeatureSequenceOptions extends DesktopCaptureSequenceOptions {
	pid?: number;
	steps: readonly VisualProofNavigationStep[];
	/** Whether UI Automation can drive the app (false ⇒ UIPI blocks input → capture only). */
	canDrive: boolean;
}

/**
 * Navigue jusqu'à la feature dans le client lourd (UI Automation) puis capture
 * une preuve par étape. Sans plan desktop, retombe sur la séquence
 * settle-and-capture classique.
 */
async function captureDesktopFeatureSequence(
	context: VisualProofProviderContext,
	options: DesktopFeatureSequenceOptions,
): Promise<VisualProofScreenshot[]> {
	if (options.steps.length === 0) {
		return captureDesktopScreenshotSequence(context, options);
	}

	if (
		!options.canDrive &&
		options.steps.some((step) => step.invoke || step.setText)
	) {
		logger.warn(
			"[VisualProof] Skipping automated desktop navigation: WorkPilot is not " +
				"elevated while the app is (Windows UIPI). Relaunch WorkPilot as " +
				"administrator to drive the app; capturing screenshots only.",
		);
	}

	const screenshots: VisualProofScreenshot[] = [];
	let lastError: unknown;
	let captureIndex = 0;
	for (const step of options.steps) {
		await runDesktopNavigationStep(options.pid, step, options.canDrive);
		if (step.capture === false) continue;
		const fileName = navigationScreenshotFileName(captureIndex, step.label);
		const screenshotPath = path.join(context.artifactDir, fileName);
		try {
			const size = await captureDesktopImage(screenshotPath, {
				excludeSourceIds: options.excludeSourceIds,
				preferredNames: options.preferredNames,
				requireWindowMatch: true,
			});
			screenshots.push(
				createScreenshot(
					step.label ?? `Feature step ${captureIndex + 1}`,
					context.relativeArtifactDir,
					fileName,
					screenshotPath,
					size,
				),
			);
			captureIndex += 1;
		} catch (error) {
			lastError = error;
		}
	}

	if (screenshots.length === 0) {
		if (lastError instanceof Error) throw lastError;
		return captureDesktopScreenshotSequence(context, options);
	}
	return screenshots;
}

async function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await delay(500);
	}
	throw new Error(
		`Timed out waiting for ${url}${lastError ? ` (${String(lastError)})` : ""}`,
	);
}

function parseJsonArrayEnv(envName: string): string[] {
	const raw = process.env[envName];
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
			? parsed
			: [];
	} catch {
		return raw.split(" ").filter(Boolean);
	}
}

function stopChildProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.killed) {
		child.kill();
	}
}

interface DesktopLaunchHandle {
	pid?: number;
	/** Whether the launched app runs elevated (admin). */
	elevated: boolean;
	stop: () => Promise<void>;
}

let cachedElevation: boolean | null = null;

/**
 * Whether the current WorkPilot process runs elevated (admin on Windows, root
 * elsewhere). Cached for the process lifetime. Drives the UI Automation decision:
 * a non-elevated process cannot send input to an elevated window (Windows UIPI),
 * so we must know our own integrity level to decide whether navigation can run.
 */
async function isCurrentProcessElevated(): Promise<boolean> {
	if (cachedElevation !== null) return cachedElevation;
	if (process.platform !== "win32") {
		cachedElevation =
			typeof process.getuid === "function" && process.getuid() === 0;
		return cachedElevation;
	}
	try {
		const { stdout } = await execFileAsync(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)",
			],
			{ windowsHide: true, maxBuffer: 64 * 1024 },
		);
		cachedElevation = stdout.trim().toLowerCase() === "true";
	} catch {
		cachedElevation = false;
	}
	return cachedElevation;
}

/**
 * Decide whether UI Automation can drive the launched desktop app, and produce a
 * user-facing note when it cannot. Windows UIPI forbids a lower-integrity process
 * from sending input to a higher-integrity window, so a non-elevated WorkPilot
 * cannot click/type into an elevated app — only screenshots remain possible.
 */
export function resolveDesktopUiAutomation(
	appElevated: boolean,
	workpilotElevated: boolean,
): { canDrive: boolean; note?: string } {
	if (!appElevated || workpilotElevated) {
		return { canDrive: true };
	}
	return {
		canDrive: false,
		note:
			"Automated navigation is disabled because the desktop app runs elevated " +
			"and WorkPilot does not (Windows UIPI). Relaunch WorkPilot as administrator " +
			"to drive the app; screenshots are still captured.",
	};
}

/**
 * Lance l'exécutable desktop. Sous Windows, les clients lourds EBP exigent les
 * droits administrateur (réparation de la base de registre). Si WorkPilot est déjà
 * élevé (ou si l'élévation est désactivée via WORKPILOT_VISUAL_PROOF_NO_ELEVATE),
 * on lance directement : l'enfant hérite alors de l'intégrité du parent et reste
 * pilotable inline par UI Automation, sans second UAC. Sinon on élève via
 * Start-Process -Verb RunAs (déclenche UAC) et on récupère le PID élevé ; dans ce
 * cas, WorkPilot non élevé ne pourra pas piloter la fenêtre (UIPI), mais la
 * capture d'écran reste fonctionnelle. Sous mono/wine, lancement direct.
 */
async function launchDesktopApplication(
	runtime: DesktopRuntimeInvocation,
): Promise<DesktopLaunchHandle> {
	const spawnDirect = (elevated: boolean): DesktopLaunchHandle => {
		const child = spawn(runtime.command, runtime.args, {
			cwd: runtime.cwd,
			windowsHide: false,
		});
		return {
			pid: child.pid,
			elevated,
			stop: async () => stopChildProcess(child),
		};
	};

	if (process.platform !== "win32") {
		return spawnDirect(false);
	}

	// When WorkPilot is already elevated, a direct child inherits admin rights
	// (no extra UAC) and stays drivable by inline UI Automation. The opt-out env
	// launches non-elevated on purpose (caller accepts the registry-repair prompt).
	const workpilotElevated = await isCurrentProcessElevated();
	if (workpilotElevated || process.env[NO_ELEVATE_ENV]) {
		return spawnDirect(workpilotElevated);
	}

	const psExe = `'${runtime.command.replaceAll("'", "''")}'`;
	const psCwd = `'${runtime.cwd.replaceAll("'", "''")}'`;
	const psArgs =
		runtime.args.length > 0
			? ` -ArgumentList @(${runtime.args
					.map((arg) => `'${arg.replaceAll("'", "''")}'`)
					.join(",")})`
			: "";
	const { stdout } = await execFileAsync(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference='Stop'; $p = Start-Process -FilePath ${psExe} -WorkingDirectory ${psCwd} -Verb RunAs -PassThru${psArgs}; [Console]::Out.Write($p.Id)`,
		],
		{ windowsHide: true, maxBuffer: 64 * 1024 },
	);
	const pid = Number.parseInt(stdout.trim(), 10);
	return {
		pid: Number.isNaN(pid) ? undefined : pid,
		elevated: true,
		stop: async () => {
			if (Number.isNaN(pid)) return;
			try {
				await execFileAsync(
					"powershell",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
					],
					{ windowsHide: true, maxBuffer: 64 * 1024 },
				);
			} catch (error) {
				logger.warn(
					`[VisualProof] Could not stop elevated desktop process ${pid}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	};
}

function findFirstDotNetProject(
	projects: DotNetProjectInfo[],
	predicate: (project: DotNetProjectInfo) => boolean,
): DotNetProjectInfo | undefined {
	return projects.find(predicate);
}

interface LegacyWebHostInvocation {
	command: string;
	args: string[];
	providerDetails: string;
}

function isXspCommand(commandPath: string): boolean {
	const baseName = path.basename(commandPath, path.extname(commandPath)).toLowerCase();
	return baseName === "xsp" || baseName === "xsp4";
}

function createLegacyWebHostInvocation(
	command: string,
	projectDir: string,
	port: number,
): LegacyWebHostInvocation {
	if (isXspCommand(command)) {
		return {
			command,
			args: ["--root", projectDir, "--port", String(port)],
			providerDetails: "Classic ASP.NET app hosted through Mono xsp.",
		};
	}
	return {
		command,
		args: ["/path:" + projectDir, "/port:" + String(port)],
		providerDetails: "Classic ASP.NET app hosted through IIS Express.",
	};
}

function findLegacyWebHostInvocation(
	projectDir: string,
	port: number,
): LegacyWebHostInvocation | null {
	const candidates = [
		process.env[IIS_EXPRESS_ENV],
		"C:\\Program Files\\IIS Express\\iisexpress.exe",
		"C:\\Program Files (x86)\\IIS Express\\iisexpress.exe",
	].filter((candidate): candidate is string => Boolean(candidate));
	const candidate = candidates.find((item) => existsSync(item));
	if (candidate) return createLegacyWebHostInvocation(candidate, projectDir, port);

	const pathIisExpress = findCommandInPath("iisexpress");
	if (pathIisExpress) {
		return createLegacyWebHostInvocation(pathIisExpress, projectDir, port);
	}

	const pathXsp4 = findCommandInPath("xsp4");
	if (pathXsp4) return createLegacyWebHostInvocation(pathXsp4, projectDir, port);

	const pathXsp = findCommandInPath("xsp");
	return pathXsp ? createLegacyWebHostInvocation(pathXsp, projectDir, port) : null;
}

function formatCommandFailure(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return String(error);
	const details = [error.message];
	const withOutput = error as Error & {
		stdout?: string;
		stderr?: string;
		code?: number | string;
	};
	if (withOutput.code !== undefined) {
		details.push(`Exit code: ${withOutput.code}`);
	}
	for (const [label, value] of [
		["stdout", withOutput.stdout],
		["stderr", withOutput.stderr],
	] as const) {
		const trimmed = value?.trim();
		if (trimmed) {
			details.push(`${label}:\n${trimmed.slice(-6000)}`);
		}
	}
	return details.join("\n\n") || fallback;
}

function findContainingSolutionDir(csprojPath: string): string {
	const normalizedCsprojPath = path.normalize(csprojPath).toLowerCase();
	let currentDir = path.dirname(csprojPath);
	for (let depth = 0; depth < 6; depth += 1) {
		let entries: string[];
		try {
			entries = readdirSync(currentDir);
		} catch {
			return `${path.dirname(csprojPath)}${path.sep}`;
		}
		for (const entry of entries.filter((file) => file.endsWith(".sln"))) {
			const content = readTextFile(path.join(currentDir, entry)) ?? "";
			const matches = content.matchAll(
				/Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gi,
			);
			for (const match of matches) {
				// Les chemins déclarés dans un .sln utilisent toujours le
				// séparateur Windows "\". Sur POSIX, path.resolve ne le traite
				// pas comme séparateur : on normalise donc vers path.sep.
				const relativeFromSolution = match[1].split(/[\\/]+/).join(path.sep);
				const candidatePath = path
					.resolve(currentDir, relativeFromSolution)
					.toLowerCase();
				if (path.normalize(candidatePath) === normalizedCsprojPath) {
					return `${currentDir}${path.sep}`;
				}
			}
		}
		const parentDir = path.dirname(currentDir);
		if (!parentDir || parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return `${path.dirname(csprojPath)}${path.sep}`;
}

function isLegacyCompilerTooOldError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const withOutput = error as Error & { stdout?: string; stderr?: string };
	return [error.message, withOutput.stdout, withOutput.stderr].some((value) =>
		/CS1617|Option\s+'.+'\s+non valide pour\s+\/langversion|Invalid option.*\/langversion/i.test(
			value ?? "",
		),
	);
}

async function buildLegacyDotNetProject(csprojPath: string): Promise<void> {
	const msbuild = findMsBuildInvocation({ allowDotnetMsBuild: false });
	if (!msbuild) {
		throw new Error(LEGACY_MSBUILD_UNAVAILABLE_MESSAGE);
	}
	const solutionDir = findContainingSolutionDir(csprojPath);
	ensureLegacyWorktreeBuildAssets(solutionDir, (message) =>
		logger.info(`[VisualProof] ${message}`),
	);
	await runWithShortLegacySolutionPath(
		csprojPath,
		solutionDir,
		async (buildPaths) => {
			const dotnet = findCommandInPath("dotnet");
			if (dotnet) {
				try {
					await execFileAsync(
						dotnet,
						[
							"restore",
							buildPaths.csprojPath,
							`/p:SolutionDir=${buildPaths.solutionDir}`,
						],
						{
							cwd: path.dirname(buildPaths.csprojPath),
							maxBuffer: LEGACY_DOTNET_BUILD_MAX_BUFFER,
						},
					);
				} catch (restoreError) {
					throw new Error(formatCommandFailure(restoreError, "dotnet restore failed"));
				}
			}
			const referencesTarget = createLegacyPackageReferencesTarget(
				buildPaths.csprojPath,
				buildPaths.solutionDir,
			);
			const buildArgs = [
				buildPaths.csprojPath,
				"/t:Build",
				"/nologo",
				"/v:minimal",
				"/clp:ErrorsOnly;Summary",
				"/p:Configuration=Debug",
				`/p:SolutionDir=${buildPaths.solutionDir}`,
				LEGACY_RESOURCE_PROPERTY,
				...createLegacyCompilerBuildArgs(msbuild.command),
				...createLegacySdkBuildArgs(msbuild.command),
				...(referencesTarget
					? [`/p:CustomBeforeMicrosoftCommonTargets=${referencesTarget}`]
					: []),
			];
			const runMsBuild = () =>
				execFileAsync(msbuild.command, [...msbuild.argsPrefix, ...buildArgs], {
					cwd: path.dirname(buildPaths.csprojPath),
					maxBuffer: LEGACY_DOTNET_BUILD_MAX_BUFFER,
				});
			try {
				// Le patch xmlns="" est appliqué de façon proactive : les projets
				// legacy EBP contiennent des éléments <Compile ... xmlns=""> qui
				// déclenchent MSB4097. On nettoie avant le build pour éviter un
				// double build et garder les logs lisibles.
				await runWithLegacyXmlNamespacePatch(buildPaths.solutionDir, runMsBuild);
			} catch (error) {
				if (isLegacyCompilerTooOldError(error)) {
					throw new Error(
						`${LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE}\n\n${formatCommandFailure(
							error,
							"MSBuild failed",
						)}`,
					);
				}
				throw new Error(formatCommandFailure(error, "MSBuild failed"));
			}
		},
		(message) => logger.info(`[VisualProof] ${message}`),
	);
}

function findDesktopExecutable(projectDir: string): string | null {
	const exeFiles = scanFiles(projectDir, 5, (_filePath, entry) => {
		const lower = entry.toLowerCase();
		return (
			lower.endsWith(".exe") &&
			!lower.includes("vshost") &&
			!lower.includes("testhost") &&
			!lower.includes("iisexpress")
		);
	});
	const ranked = exeFiles.sort((left, right) => {
		const rank = (filePath: string) => {
			const normalized = filePath.toLowerCase();
			if (normalized.includes(`${path.sep}debug${path.sep}`)) return 0;
			if (normalized.includes(`${path.sep}release${path.sep}`)) return 1;
			return 2;
		};
		return rank(left) - rank(right);
	});
	return ranked[0] ?? null;
}

interface DesktopRuntimeInvocation {
	command: string;
	args: string[];
	cwd: string;
	providerDetails: string;
}

function findDesktopRuntimeInvocation(
	executablePath: string,
): DesktopRuntimeInvocation | null {
	if (process.platform === "win32") {
		return {
			command: executablePath,
			args: [],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible Windows desktop capture.",
		};
	}

	const mono = findCommandInPath("mono");
	if (mono) {
		return {
			command: mono,
			args: [executablePath],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible desktop capture through Mono.",
		};
	}

	const wine = findCommandInPath("wine");
	if (wine) {
		return {
			command: wine,
			args: [executablePath],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible desktop capture through Wine.",
		};
	}

	return null;
}

function createScreenshot(
	label: string,
	relativeArtifactDir: string,
	fileName: string,
	absolutePath: string,
	size: { width: number; height: number },
): VisualProofScreenshot {
	return {
		label,
		relativePath: path.join(relativeArtifactDir, fileName),
		absolutePath,
		width: size.width,
		height: size.height,
		capturedAt: new Date().toISOString(),
	};
}

class RemoteRunnerProvider implements VisualProofProvider {
	readonly id = "remote-runner" as const;

	canHandle(): boolean {
		return Boolean(process.env[REMOTE_URL_ENV]);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const endpoint = process.env[REMOTE_URL_ENV];
		if (!endpoint) {
			return {
				status: "skipped",
				targetKind: "remote",
				isolated: true,
				providerDetails: `${REMOTE_URL_ENV} is not configured.`,
				framework: context.config.framework,
				screenshots: [],
				error: "Remote visual proof runner is not configured.",
			};
		}

		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				options: context.options,
				runPath: context.runPath,
				artifactDir: context.artifactDir,
				relativeArtifactDir: context.relativeArtifactDir,
				config: context.config,
				dotnetProjects: context.dotnetProjects,
			}),
		});
		if (!response.ok) {
			throw new Error(`Remote visual proof runner returned HTTP ${response.status}`);
		}
		const payload = (await response.json()) as Partial<VisualProofProviderResult>;
		return {
			status: payload.status ?? "skipped",
			targetKind: payload.targetKind ?? "remote",
			isolated: true,
			providerDetails: payload.providerDetails ?? endpoint,
			framework: payload.framework ?? context.config.framework,
			appUrl: payload.appUrl,
			screenshots: payload.screenshots ?? [],
			error: payload.error,
		};
	}
}

class CommandRunnerProvider implements VisualProofProvider {
	constructor(
		readonly id: VisualProofProviderId,
		private readonly commandEnv: string,
		private readonly argsEnv: string,
		private readonly defaultTargetKind: VisualProofTargetKind,
	) {}

	canHandle(): boolean {
		return Boolean(process.env[this.commandEnv]);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const command = process.env[this.commandEnv];
		if (!command) {
			return {
				status: "skipped",
				targetKind: this.defaultTargetKind,
				isolated: true,
				providerDetails: `${this.commandEnv} is not configured.`,
				framework: context.config.framework,
				screenshots: [],
				error: `${this.id} visual proof provider is not configured.`,
			};
		}
		const input = JSON.stringify({
			options: context.options,
			runPath: context.runPath,
			artifactDir: context.artifactDir,
			relativeArtifactDir: context.relativeArtifactDir,
			config: context.config,
			dotnetProjects: context.dotnetProjects,
		});
		const { stdout } = await execFileAsync(command, parseJsonArrayEnv(this.argsEnv), {
			cwd: context.runPath,
			env: { ...process.env, WORKPILOT_VISUAL_PROOF_INPUT: input },
			maxBuffer: 10 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout || "{}") as Partial<VisualProofProviderResult>;
		return {
			status: parsed.status ?? "skipped",
			targetKind: parsed.targetKind ?? this.defaultTargetKind,
			isolated: true,
			providerDetails: parsed.providerDetails ?? command,
			framework: parsed.framework ?? context.config.framework,
			appUrl: parsed.appUrl,
			screenshots: parsed.screenshots ?? [],
			error: parsed.error,
		};
	}
}

class LocalIisExpressProvider implements VisualProofProvider {
	readonly id = "local-iis-express" as const;

	canHandle(context: VisualProofProviderContext): boolean {
		return Boolean(
			findFirstDotNetProject(
				context.dotnetProjects,
				(project) => project.isLegacy && project.isWeb && !project.isDesktop,
			),
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const project = findFirstDotNetProject(
			context.dotnetProjects,
			(candidate) => candidate.isLegacy && candidate.isWeb && !candidate.isDesktop,
		);
		const port = Number(process.env.WORKPILOT_VISUAL_PROOF_PORT) || DEFAULT_IIS_EXPRESS_PORT;
		const host = project
			? findLegacyWebHostInvocation(project.projectDir, port)
			: null;
		if (!project || !host) {
			return {
				status: "skipped",
				targetKind: "web",
				isolated: false,
				providerDetails: `${IIS_EXPRESS_ENV} can override the IIS Express path.`,
				framework: "dotnet-framework",
				screenshots: [],
				error: LEGACY_WEB_HOST_UNAVAILABLE_MESSAGE,
			};
		}

		const appUrl = `http://localhost:${port}/`;
		const child = spawn(host.command, host.args, {
			cwd: project.projectDir,
			windowsHide: true,
		});
		try {
			await waitForHttp(appUrl);
			mkdirSync(context.artifactDir, { recursive: true });
			const navigationPlan = loadVisualProofNavigationPlan(context.options);
			const screenshots = await captureWebFeatureScreenshots(
				appUrl,
				context,
				navigationPlan?.web ?? [],
			);
			const apiProof = await runApiProof(appUrl, context);
			screenshots.push(...apiProof.screenshots);
			return {
				status: "passed",
				targetKind: "web",
				isolated: false,
				providerDetails: `${host.providerDetails}${describeApiSmoke(apiProof.apiSmoke)}`,
				framework: "dotnet-framework",
				appUrl,
				screenshots,
				apiSmoke: apiProof.apiSmoke,
			};
		} finally {
			stopChildProcess(child);
		}
	}
}

class LocalWindowsDesktopProvider implements VisualProofProvider {
	readonly id = "local-windows-desktop" as const;

	canHandle(context: VisualProofProviderContext): boolean {
		return (
			(process.platform === "win32" ||
				Boolean(findCommandInPath("mono") ?? findCommandInPath("wine"))) &&
			Boolean(
				findFirstDotNetProject(
					context.dotnetProjects,
					(project) => project.isLegacy && project.isDesktop,
				),
			)
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const project = findFirstDotNetProject(
			context.dotnetProjects,
			(candidate) => candidate.isLegacy && candidate.isDesktop,
		);
		if (!project) {
			return {
				status: "skipped",
				targetKind: "desktop",
				isolated: false,
				framework: "dotnet-framework",
				screenshots: [],
				error: "No legacy .NET desktop project was detected.",
			};
		}

		await buildLegacyDotNetProject(project.csprojPath);
		const executablePath = findDesktopExecutable(project.projectDir);
		if (!executablePath) {
			throw new Error(
				"Could not locate a built desktop executable after MSBuild completed.",
			);
		}
		const runtime = findDesktopRuntimeInvocation(executablePath);
		if (!runtime) {
			return {
				status: "skipped",
				targetKind: "desktop",
				isolated: false,
				framework: "dotnet-framework",
				screenshots: [],
				error: "Mono/Wine was not found for this .NET Framework desktop app.",
			};
		}

		mkdirSync(context.artifactDir, { recursive: true });
		const existingWindowIds = await getDesktopWindowSourceIds();
		const handle = await launchDesktopApplication(runtime);
		try {
			const preferredNames = await waitForProcessWindowNames(handle.pid, [
				path.basename(executablePath, ".exe"),
				path.basename(project.projectDir),
			]);
			const navigationPlan = loadVisualProofNavigationPlan(context.options);
			const desktopSteps = navigationPlan?.desktop ?? [];
			const workpilotElevated = await isCurrentProcessElevated();
			const driving = resolveDesktopUiAutomation(
				handle.elevated,
				workpilotElevated,
			);
			const screenshots = await captureDesktopFeatureSequence(context, {
				excludeSourceIds: existingWindowIds,
				preferredNames,
				pid: handle.pid,
				steps: desktopSteps,
				canDrive: driving.canDrive,
			});
			const drivingNote =
				driving.note && desktopSteps.some((step) => step.invoke || step.setText)
					? ` ${driving.note}`
					: "";
			return {
				status: "passed",
				targetKind: "desktop",
				isolated: false,
				providerDetails:
					`${runtime.providerDetails} Use Hyper-V or remote-runner for isolation.${drivingNote}`,
				framework: "dotnet-framework",
				screenshots,
			};
		} finally {
			await handle.stop();
		}
	}
}

class LocalWebProvider implements VisualProofProvider {
	constructor(
		readonly id: VisualProofProviderId,
		private readonly isolated: boolean,
		private readonly predicate: (config: AppEmulatorConfig) => boolean,
	) {}

	canHandle(context: VisualProofProviderContext): boolean {
		return (
			context.config.isWeb &&
			WEB_FRAMEWORKS.has(context.config.framework) &&
			this.predicate(context.config)
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		await appEmulatorService.startServer(context.config);
		try {
			const appUrl = appEmulatorService.getUrl();
			if (!appUrl) {
				throw new Error("App emulator did not expose a preview URL");
			}

			mkdirSync(context.artifactDir, { recursive: true });
			const navigationPlan = loadVisualProofNavigationPlan(context.options);
			const screenshots = await captureWebFeatureScreenshots(
				appUrl,
				context,
				navigationPlan?.web ?? [],
			);
			const apiProof = await runApiProof(appUrl, context);
			screenshots.push(...apiProof.screenshots);
			return {
				status: "passed",
				targetKind: "web",
				isolated: this.isolated,
				providerDetails:
					(this.id === "docker"
						? "Docker-backed web preview through the app emulator."
						: "Local web preview through the app emulator.") +
					describeApiSmoke(apiProof.apiSmoke),
				framework: context.config.framework,
				appUrl,
				screenshots,
				apiSmoke: apiProof.apiSmoke,
			};
		} finally {
			appEmulatorService.stopServer();
		}
	}
}

function buildProviders(): VisualProofProvider[] {
	return [
		new RemoteRunnerProvider(),
		new CommandRunnerProvider("hyper-v", HYPERV_COMMAND_ENV, HYPERV_ARGS_ENV, "remote"),
		new CommandRunnerProvider("wsl", WSL_COMMAND_ENV, WSL_ARGS_ENV, "remote"),
		new LocalIisExpressProvider(),
		new LocalWindowsDesktopProvider(),
		new LocalWebProvider(
			"docker",
			true,
			(config) =>
				config.framework === "docker" || config.framework === "docker-compose",
		),
		new LocalWebProvider(
			"local-web",
			false,
			(config) =>
				config.framework !== "docker" && config.framework !== "docker-compose",
		),
	];
}

function selectProvider(
	context: VisualProofProviderContext,
): VisualProofProvider | undefined {
	const providers = buildProviders();
	const requested = requestedProvider(context.options);
	if (requested) {
		return providers.find((provider) => provider.id === requested);
	}
	return providers.find((provider) => provider.canHandle(context));
}

function targetKindForConfig(config: AppEmulatorConfig): VisualProofTargetKind {
	if (config.type === "desktop") return "desktop";
	if (config.isWeb || WEB_FRAMEWORKS.has(config.framework)) return "web";
	return "remote";
}

function createSkippedProviderResult(
	context: VisualProofProviderContext,
	providerId?: VisualProofProviderId,
): VisualProofProviderResult {
	const details = providerId
		? `Provider "${providerId}" was requested but is unavailable or unconfigured.`
		: "No provider can render this task automatically.";
	return {
		status: "skipped",
		targetKind: targetKindForConfig(context.config),
		isolated: false,
		providerDetails: details,
		framework: context.config.framework,
		screenshots: [],
		error:
			`${details} Available provider families: remote-runner, hyper-v, wsl, ` +
			"local-iis-express, local-windows-desktop, docker, local-web.",
	};
}

function createFailedProviderResult(
	context: VisualProofProviderContext,
	providerId: VisualProofProviderId,
	error: unknown,
): VisualProofProviderResult {
	return {
		status: "failed",
		targetKind: targetKindForConfig(context.config),
		isolated: providerId === "docker" || providerId === "wsl" || providerId === "hyper-v",
		providerDetails: `Provider "${providerId}" failed before a screenshot could be captured.`,
		framework: context.config.framework,
		screenshots: [],
		error: error instanceof Error ? error.message : String(error),
	};
}

function attachGitHubUrls(
	screenshots: VisualProofScreenshot[],
	prUrl: string,
	branch: string | null,
): void {
	if (!branch) return;
	const pr = parseGitHubPrUrl(prUrl);
	if (!pr) return;
	for (const screenshot of screenshots) {
		if (screenshot.url) continue;
		screenshot.url =
			`https://github.com/${pr.owner}/${pr.repo}/blob/${branch}/` +
			`${normalizePathForMarkdown(screenshot.relativePath)}?raw=1`;
	}
}

export class VisualProofService extends EventEmitter {
	/**
	 * In-flight runs keyed by task id. Concurrent requests for the same task share
	 * a single run so switching tabs / double-clicking never launches the emulator
	 * (or the elevated desktop app) twice.
	 */
	private readonly inFlightRuns = new Map<string, Promise<VisualProofRun>>();

	/** Whether a visual proof run is currently in progress for the given task. */
	isRunning(taskId: string): boolean {
		return this.inFlightRuns.has(taskId);
	}

	/**
	 * Run — or attach to an already running — visual proof for a task.
	 *
	 * The actual work happens in {@link execute}; this wrapper makes the run
	 * idempotent per task and emits `running-changed` (taskId, running) so the
	 * renderer can keep its spinner in sync even when it did not initiate the run
	 * (e.g. the tab was reopened while a previous run is still capturing).
	 */
	run(options: VisualProofRunOptions): Promise<VisualProofRun> {
		const existing = this.inFlightRuns.get(options.taskId);
		if (existing) return existing;

		const promise = this.execute(options);
		this.inFlightRuns.set(options.taskId, promise);
		this.emit("running-changed", options.taskId, true);
		void promise.finally(() => {
			this.inFlightRuns.delete(options.taskId);
			this.emit("running-changed", options.taskId, false);
		});
		return promise;
	}

	private async execute(options: VisualProofRunOptions): Promise<VisualProofRun> {
		const startedAt = new Date().toISOString();
		const id = createRunId();
		const runBase: VisualProofRun = {
			id,
			status: "pending",
			taskId: options.taskId,
			specId: options.specId,
			prUrl: options.prUrl,
			screenshots: [],
			startedAt,
		};

		const runPath = options.worktreePath ?? options.projectPath;
		const specsBaseDir = getSpecsDir(options.autoBuildPath);
		const relativeArtifactDir = path.join(
			specsBaseDir,
			"visual-proofs",
			options.specId,
			id,
		);
		const artifactDir = path.join(runPath, relativeArtifactDir);

		try {
			const config = await appEmulatorService.detectProject(runPath);
			const dotnetProjects = config.framework.startsWith("dotnet")
				? analyzeDotNetProjects(config.projectDir ?? runPath)
				: [];
			const context: VisualProofProviderContext = {
				options,
				runPath,
				artifactDir,
				relativeArtifactDir,
				config,
				dotnetProjects,
			};
			const provider = selectProvider(context);
			const providerResult = provider
				? await provider
						.run(context)
						.catch((error: unknown) =>
							createFailedProviderResult(context, provider.id, error),
						)
				: createSkippedProviderResult(context, requestedProvider(options) ?? undefined);

			let branch: string | null = null;
			let commitSha: string | undefined;
			if (options.worktreePath && providerResult.screenshots.length > 0) {
				branch = await getCurrentBranch(options.worktreePath);
				commitSha = await commitAndPushArtifacts(
					options.worktreePath,
					relativeArtifactDir,
					options.specId,
				);
				attachGitHubUrls(providerResult.screenshots, options.prUrl, branch);
			}

			const completedRun: VisualProofRun = {
				...runBase,
				status: providerResult.status,
				framework: providerResult.framework ?? config.framework,
				provider: provider?.id ?? requestedProvider(options) ?? undefined,
				targetKind: providerResult.targetKind,
				isolated: providerResult.isolated,
				providerDetails: providerResult.providerDetails,
				appUrl: providerResult.appUrl,
				artifactDir,
				commitSha,
				screenshots: providerResult.screenshots,
				apiSmoke: providerResult.apiSmoke,
				error: providerResult.error,
				completedAt: new Date().toISOString(),
			};

			try {
				const commentUrl = await postGitHubComment(
					options.prUrl,
					buildProofComment(completedRun, branch ?? undefined),
				);
				return { ...completedRun, commentUrl };
			} catch (commentError) {
				logger.warn("[VisualProof] Could not post PR comment:", commentError);
				return completedRun;
			}
		} catch (error) {
			const failedRun: VisualProofRun = {
				...runBase,
				status: "failed",
				artifactDir,
				error: error instanceof Error ? error.message : String(error),
				completedAt: new Date().toISOString(),
			};
			try {
				const commentUrl = await postGitHubComment(
					options.prUrl,
					buildProofComment(failedRun),
				);
				return { ...failedRun, commentUrl };
			} catch (commentError) {
				logger.warn("[VisualProof] Could not post failure comment:", commentError);
				return failedRun;
			}
		}
	}
}

export const visualProofService = new VisualProofService();
