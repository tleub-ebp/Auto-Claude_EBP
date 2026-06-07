import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type AssetsTarget = Record<
	string,
	{
		compile?: Record<string, unknown>;
	}
>;

interface ProjectAssets {
	targets?: Record<string, AssetsTarget>;
	project?: {
		restore?: {
			packagesPath?: string;
		};
	};
}

export const LEGACY_RESOURCE_PROPERTY =
	"/p:GenerateResourceUsePreserializedResources=true";

export const LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE =
	"A compatible MSBuild 15+ / Roslyn C# compiler is required for this .NET Framework project. Install Visual Studio Build Tools 2017+ with MSBuild/.NET desktop build tools, set WORKPILOT_MSBUILD_PATH to that MSBuild.exe, or use a remote/VM runner.";

const CSC_TOOL_PATH_ENV = "WORKPILOT_CSC_TOOL_PATH";
const SDK_TOOLS_PATH_ENV = "WORKPILOT_SDK_TOOLS_PATH";

export function findWorktreeMirrorPath(candidatePath: string): string | null {
	const normalized = path.normalize(candidatePath);
	const marker = `${path.sep}.workpilot${path.sep}worktrees${path.sep}tasks${path.sep}`;
	const markerIndex = normalized.toLowerCase().indexOf(marker.toLowerCase());
	if (markerIndex === -1) return null;

	const repositoryRoot = normalized.slice(0, markerIndex);
	const worktreeRelativePath = normalized.slice(markerIndex + marker.length);
	const segments = worktreeRelativePath.split(/[\\/]+/).filter(Boolean);
	if (segments.length < 2) return null;

	return path.join(repositoryRoot, ...segments.slice(1));
}

export function ensureLegacyWorktreeBuildAssets(
	solutionDir: string,
	onMessage?: (message: string) => void,
): void {
	const sourceSolutionDir = findWorktreeMirrorPath(solutionDir);
	if (!sourceSolutionDir || !existsSync(sourceSolutionDir)) return;

	for (const assetName of ["packages", "ReferencedFiles"]) {
		const sourcePath = path.join(sourceSolutionDir, assetName);
		const targetPath = path.join(solutionDir, assetName);
		if (!existsSync(sourcePath) || existsSync(targetPath)) continue;

		try {
			symlinkSync(
				sourcePath,
				targetPath,
				process.platform === "win32" ? "junction" : "dir",
			);
			onMessage?.(`Linked legacy build assets: ${targetPath} -> ${sourcePath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onMessage?.(`Could not link legacy build assets from ${sourcePath}: ${message}`);
		}
	}
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function compareVersionLike(left: string, right: string): number {
	const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10));
	const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10));
	const maxLength = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < maxLength; index += 1) {
		const leftValue = leftParts[index] ?? 0;
		const rightValue = rightParts[index] ?? 0;
		const leftPart = Number.isNaN(leftValue) ? 0 : leftValue;
		const rightPart = Number.isNaN(rightValue) ? 0 : rightValue;
		if (leftPart !== rightPart) return leftPart - rightPart;
	}
	return 0;
}

function findLegacyProjectFiles(solutionDir: string): string[] {
	const results: string[] = [];
	const skipDirs = new Set([".git", ".workpilot", "bin", "obj", "packages"]);
	const scan = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (skipDirs.has(entry)) continue;
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				scan(fullPath);
			} else if (entry.endsWith(".csproj")) {
				results.push(fullPath);
			}
		}
	};
	scan(solutionDir);
	return results;
}

function findProjectAssetsFiles(solutionDir: string, primaryAssetsPath: string): string[] {
	const results = new Set<string>();
	if (existsSync(primaryAssetsPath)) results.add(primaryAssetsPath);

	const skipDirs = new Set([".git", ".workpilot", "bin", "node_modules", "packages"]);
	const scan = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (skipDirs.has(entry)) continue;
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				scan(fullPath);
			} else if (entry === "project.assets.json") {
				results.add(fullPath);
			}
		}
	};
	scan(solutionDir);

	return [...results];
}

interface LegacyReference {
	include: string;
	hintPath: string;
	packageVersion: string;
	frameworkScore: number;
}

function addLegacyReference(
	references: Map<string, LegacyReference>,
	include: string,
	hintPath: string,
	packageVersion: string,
	frameworkScore = scoreLegacyReferencePath(hintPath),
): void {
	const key = include.toLowerCase();
	const existing = references.get(key);
	if (
		!existing ||
		compareVersionLike(packageVersion, existing.packageVersion) > 0 ||
		(compareVersionLike(packageVersion, existing.packageVersion) === 0 &&
			frameworkScore > existing.frameworkScore)
	) {
		references.set(key, { include, hintPath, packageVersion, frameworkScore });
	}
}

function scoreLegacyReferencePath(hintPath: string): number {
	const parts = path.normalize(hintPath).split(/[\\/]+/);
	const libIndex = parts.findIndex((part) => part.toLowerCase() === "lib");
	if (libIndex === -1) return 0;

	const framework = parts[libIndex + 1]?.toLowerCase();
	if (!framework || framework.endsWith(".dll")) return 1600;

	const netFramework = framework.match(/^net(\d+)$/);
	if (netFramework) {
		const version = netFramework[1] ?? "";
		if (version.length === 2) return 1000 + Number.parseInt(version, 10) * 10;
		return 1000 + Number.parseInt(version, 10);
	}

	const netStandard = framework.match(/^netstandard(\d+)(?:\.(\d+))?$/);
	if (netStandard) {
		return (
			700 +
			Number.parseInt(netStandard[1] ?? "0", 10) * 10 +
			Number.parseInt(netStandard[2] ?? "0", 10)
		);
	}

	if (framework.startsWith("portable")) return 600;
	if (framework.startsWith("netcoreapp")) return 100;
	return 200;
}

function scanPackageLibDlls(packageRoot: string): string[] {
	const libRoot = path.join(packageRoot, "lib");
	if (!existsSync(libRoot)) return [];

	const results: string[] = [];
	const scan = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				scan(fullPath);
			} else if (entry.toLowerCase().endsWith(".dll")) {
				results.push(fullPath);
			}
		}
	};
	scan(libRoot);
	return results;
}

function shouldScanAllPackageLibDlls(packageId: string): boolean {
	return packageId.toLowerCase().startsWith("ebp.");
}

function shouldCopyRuntimeReference(hintPath: string): boolean {
	const normalized = path.normalize(hintPath).replaceAll("\\", "/").toLowerCase();
	return (
		!normalized.includes("/reference assemblies/") &&
		!normalized.includes("/packs/netstandard.library.ref/")
	);
}

function findNetStandardFacadePaths(): string[] {
	const candidates = [
		"C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8\\Facades\\netstandard.dll",
		"C:\\Program Files\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8\\Facades\\netstandard.dll",
		"C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.7.2\\Facades\\netstandard.dll",
		"C:\\Program Files\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.7.2\\Facades\\netstandard.dll",
		"/usr/lib/mono/4.8-api/Facades/netstandard.dll",
		"/usr/lib/mono/4.7.2-api/Facades/netstandard.dll",
		"/usr/local/lib/mono/4.8-api/Facades/netstandard.dll",
		"/usr/local/lib/mono/4.7.2-api/Facades/netstandard.dll",
		"/Library/Frameworks/Mono.framework/Versions/Current/lib/mono/4.8-api/Facades/netstandard.dll",
		"/Library/Frameworks/Mono.framework/Versions/Current/lib/mono/4.7.2-api/Facades/netstandard.dll",
	].filter((candidate) => existsSync(candidate));

	const dotnetPacksRoot =
		process.platform === "win32"
			? "C:\\Program Files\\dotnet\\packs\\NETStandard.Library.Ref"
			: "/usr/share/dotnet/packs/NETStandard.Library.Ref";
	if (existsSync(dotnetPacksRoot)) {
		for (const version of readdirSync(dotnetPacksRoot).sort((left, right) =>
			compareVersionLike(right, left),
		)) {
			const candidate = path.join(
				dotnetPacksRoot,
				version,
				"ref",
				"netstandard2.1",
				"netstandard.dll",
			);
			if (existsSync(candidate)) {
				candidates.push(candidate);
				break;
			}
		}
	}

	return [...new Set(candidates)];
}

function collectReferencesFromAssets(
	assetsPath: string,
	references: Map<string, LegacyReference>,
): void {
	const assets = JSON.parse(readFileSync(assetsPath, "utf-8")) as ProjectAssets;
	const packagesPath = assets.project?.restore?.packagesPath;
	if (!packagesPath) return;

	const packagesRoot = path.isAbsolute(packagesPath)
		? packagesPath
		: path.resolve(path.dirname(assetsPath), packagesPath);

	for (const target of Object.values(assets.targets ?? {})) {
		for (const [packageIdAndVersion, packageInfo] of Object.entries(target)) {
			const [packageId, packageVersion] = packageIdAndVersion.split("/");
			if (!packageId || !packageVersion) continue;

			const packageRoot = path.join(
				packagesRoot,
				packageId.toLowerCase(),
				packageVersion,
			);
			if (shouldScanAllPackageLibDlls(packageId)) {
				for (const hintPath of scanPackageLibDlls(packageRoot)) {
					addLegacyReference(
						references,
						path.basename(hintPath, ".dll"),
						hintPath,
						packageVersion,
					);
				}
			}

			if (!packageInfo.compile) continue;

			for (const compilePath of Object.keys(packageInfo.compile)) {
				if (compilePath === "_._" || !compilePath.endsWith(".dll")) continue;
				const hintPath = path.join(
					packageRoot,
					...compilePath.split("/"),
				);
				if (!existsSync(hintPath)) continue;
				addLegacyReference(
					references,
					path.basename(hintPath, ".dll"),
					hintPath,
					packageVersion,
				);
			}
		}
	}
}

function findLegacyBuildToolAssemblyNames(solutionDir: string): Set<string> {
	const results = new Set<string>();
	const skipDirs = new Set(["bin", "obj", "packages"]);
	const assemblyPattern = /(?:,\s*|name=")([A-Za-z_][A-Za-z0-9_.-]*)(?=\s*(?:,|"))/g;
	const scan = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (skipDirs.has(entry)) continue;
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				scan(fullPath);
			} else if (/\.(?:licx|resx)$/i.test(entry)) {
				const content = readFileSync(fullPath, "utf-8");
				for (const match of content.matchAll(assemblyPattern)) {
					if (match[1]) results.add(match[1].toLowerCase());
				}
				if (entry.toLowerCase().endsWith(".licx")) {
					for (const line of content.split(/\r?\n/)) {
						const assemblyName = line.split(",")[1]?.trim();
						if (assemblyName) results.add(assemblyName.toLowerCase());
					}
				}
			}
		}
	};
	scan(solutionDir);
	return results;
}

export async function runWithLegacyXmlNamespacePatch<T>(
	solutionDir: string,
	action: () => Promise<T>,
): Promise<T> {
	const backups = new Map<string, string>();
	for (const projectFile of findLegacyProjectFiles(solutionDir)) {
		const content = readFileSync(projectFile, "utf-8");
		if (!content.includes('xmlns=""')) continue;
		backups.set(projectFile, content);
		writeFileSync(projectFile, content.replaceAll(/\s+xmlns=""/g, ""), "utf-8");
	}

	try {
		return await action();
	} finally {
		for (const [projectFile, content] of backups) {
			writeFileSync(projectFile, content, "utf-8");
		}
	}
}

export function createLegacyPackageReferencesTarget(
	csprojPath: string,
	solutionDir = path.dirname(csprojPath),
): string | null {
	const projectDir = path.dirname(csprojPath);
	const assetsPath = path.join(projectDir, "obj", "project.assets.json");
	const assetsFiles = findProjectAssetsFiles(solutionDir, assetsPath);
	if (assetsFiles.length === 0) return null;

	const references = new Map<string, LegacyReference>();
	for (const projectAssetsPath of assetsFiles) {
		collectReferencesFromAssets(projectAssetsPath, references);
	}
	for (const facadePath of findNetStandardFacadePaths()) {
		addLegacyReference(references, "netstandard", facadePath, "0", 2000);
	}
	if (references.size === 0) return null;

	const lines = ['<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'];

	const addReferencePath = (hintPath: string): void => {
		lines.push(`      <ReferencePath Include="${escapeXml(hintPath)}" />`);
	};
	const addRuntimeDependency = (hintPath: string): void => {
		lines.push(
			`      <_WorkPilotLegacyRuntimeDependency Include="${escapeXml(hintPath)}" Condition="Exists('${escapeXml(hintPath)}')" />`,
		);
	};

	lines.push(
		'  <Target Name="WorkPilotSkipLegacyLicxResources" BeforeTargets="SplitResourcesByCulture">',
	);
	lines.push("    <ItemGroup>");
	lines.push(
		'      <EmbeddedResource Remove="@(EmbeddedResource)" Condition="\'%(EmbeddedResource.Extension)\' == \'.licx\'" />',
	);
	lines.push("    </ItemGroup>");
	lines.push("  </Target>");

	const buildToolAssemblyNames = findLegacyBuildToolAssemblyNames(solutionDir);
	const buildToolReferences = [...references.values()].filter((reference) =>
		buildToolAssemblyNames.has(reference.include.toLowerCase()),
	);
	if (buildToolReferences.length > 0) {
		lines.push(
			'  <Target Name="WorkPilotLegacyBuildToolReferencePath" BeforeTargets="CoreResGen;CompileLicxFiles">',
		);
		lines.push("    <ItemGroup>");
		for (const reference of buildToolReferences.sort((left, right) =>
			left.hintPath.localeCompare(right.hintPath),
		)) {
			addReferencePath(reference.hintPath);
		}
		lines.push("    </ItemGroup>");
		lines.push("  </Target>");
	}

	const runtimeReferences = [...references.values()].filter((reference) =>
		shouldCopyRuntimeReference(reference.hintPath),
	);
	if (runtimeReferences.length > 0) {
		lines.push(
			'  <Target Name="WorkPilotCopyLegacyRuntimeDependencies" AfterTargets="CopyFilesToOutputDirectory" Condition="\'$(OutputType)\' == \'Exe\' or \'$(OutputType)\' == \'WinExe\'">',
		);
		lines.push("    <ItemGroup>");
		for (const reference of runtimeReferences.sort((left, right) =>
			left.hintPath.localeCompare(right.hintPath),
		)) {
			addRuntimeDependency(reference.hintPath);
		}
		lines.push(
			'      <_WorkPilotLegacyRuntimeDependency Include="%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\\$(Configuration)\\%(ProjectReference.Filename).dll" Condition="Exists(\'%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\\$(Configuration)\\%(ProjectReference.Filename).dll\')" />',
		);
		lines.push("    </ItemGroup>");
		lines.push(
			'    <Copy SourceFiles="@(_WorkPilotLegacyRuntimeDependency)" DestinationFolder="$(TargetDir)" SkipUnchangedFiles="true" Condition="\'$(TargetDir)\' != \'\'" />',
		);
		lines.push("  </Target>");
	}

	lines.push('  <Target Name="WorkPilotLegacyReferencePath" BeforeTargets="CoreCompile">');
	lines.push("    <ItemGroup>");
	for (const reference of [...references.values()].sort((left, right) =>
		left.hintPath.localeCompare(right.hintPath),
	)) {
		addReferencePath(reference.hintPath);
	}
	lines.push(
		"      <ReferencePath Include=\"%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\\$(Configuration)\\%(ProjectReference.Filename).dll\" Condition=\"Exists('%(ProjectReference.RootDir)%(ProjectReference.Directory)bin\\$(Configuration)\\%(ProjectReference.Filename).dll')\" />",
	);
	lines.push("    </ItemGroup>");
	lines.push("  </Target>");
	lines.push("</Project>");

	const outputPath = path.join(projectDir, "obj", "workpilot-legacy-package-references.targets");
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
	return outputPath;
}

export interface RoslynCscTool {
	toolPath: string;
	toolExe: string;
}

function findCscToolInDirectory(toolPath: string): RoslynCscTool | null {
	const toolExe = ["csc.exe", "csc"].find((candidate) =>
		existsSync(path.join(toolPath, candidate)),
	);
	return toolExe ? { toolPath, toolExe } : null;
}

export function findRoslynCscTool(): RoslynCscTool | null {
	const configured = process.env[CSC_TOOL_PATH_ENV]?.trim().replace(/^["']|["']$/g, "");
	if (configured) {
		const configuredTool = findCscToolInDirectory(configured);
		if (configuredTool) return configuredTool;
	}

	let dotnetPath: string;
	try {
		const lookupCommand = process.platform === "win32" ? "where" : "which";
		dotnetPath = execFileSync(lookupCommand, ["dotnet"], { encoding: "utf-8" })
			.split(/\r?\n/)
			.find(Boolean) ?? "";
	} catch {
		return null;
	}
	if (!dotnetPath) return null;

	let sdkList: string;
	try {
		sdkList = execFileSync(dotnetPath, ["--list-sdks"], { encoding: "utf-8" });
	} catch {
		return null;
	}

	const candidates = sdkList
		.split(/\r?\n/)
		.map((line) => line.match(/^(\S+)\s+\[(.+)]$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.sort((left, right) => compareVersionLike(right[1] ?? "", left[1] ?? ""))
		.map((match) => path.join(match[2] ?? "", match[1] ?? "", "Roslyn", "bincore"));

	for (const candidate of candidates) {
		const tool = findCscToolInDirectory(candidate);
		if (tool) return tool;
	}

	return null;
}

export function shouldUseExternalRoslynCompiler(msbuildCommand: string): boolean {
	const normalized = path.normalize(msbuildCommand).replaceAll("\\", "/").toLowerCase();
	return (
		normalized.includes("/windows/microsoft.net/framework") ||
		normalized.includes("/msbuild/14.0/")
	);
}

export function createLegacyCompilerBuildArgs(msbuildCommand: string): string[] {
	if (!shouldUseExternalRoslynCompiler(msbuildCommand)) return [];
	const cscTool = findRoslynCscTool();
	if (!cscTool) return [];
	return [`/p:CscToolPath=${cscTool.toolPath}`, `/p:CscToolExe=${cscTool.toolExe}`];
}

function findSdkToolsInDirectory(toolPath: string): string | null {
	return existsSync(path.join(toolPath, process.platform === "win32" ? "al.exe" : "al"))
		? toolPath
		: null;
}

export function findLegacySdkToolsPath(msbuildCommand: string): string | null {
	if (!shouldUseExternalRoslynCompiler(msbuildCommand)) return null;

	const configured = process.env[SDK_TOOLS_PATH_ENV]?.trim().replace(/^["']|["']$/g, "");
	if (configured) {
		const configuredPath = findSdkToolsInDirectory(configured);
		if (configuredPath) return configuredPath;
	}

	const candidates =
		process.platform === "win32"
			? [
					"C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools",
					"C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools\\x64",
					"C:\\Program Files\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools",
					"C:\\Program Files\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools\\x64",
					"C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v8.1A\\bin\\NETFX 4.5.1 Tools",
					"C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v8.1A\\bin\\NETFX 4.5.1 Tools\\x64",
				]
			: [];

	return candidates.find((candidate) => findSdkToolsInDirectory(candidate)) ?? null;
}

export function createLegacySdkBuildArgs(msbuildCommand: string): string[] {
	const sdkToolsPath = findLegacySdkToolsPath(msbuildCommand);
	return sdkToolsPath ? [`/p:TargetFrameworkSDKToolsDirectory=${sdkToolsPath}`] : [];
}

export interface LegacyBuildPathContext {
	csprojPath: string;
	solutionDir: string;
}

function removeTemporaryJunction(linkPath: string, onMessage?: (message: string) => void): void {
	try {
		rmdirSync(linkPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onMessage?.(`Could not remove short legacy build path ${linkPath}: ${message}`);
	}
}

export async function runWithShortLegacySolutionPath<T>(
	csprojPath: string,
	solutionDir: string,
	action: (context: LegacyBuildPathContext) => Promise<T>,
	onMessage?: (message: string) => void,
): Promise<T> {
	if (process.platform !== "win32") {
		return action({ csprojPath, solutionDir });
	}

	const relativeProjectPath = path.relative(solutionDir, csprojPath);
	if (relativeProjectPath.startsWith("..") || path.isAbsolute(relativeProjectPath)) {
		return action({ csprojPath, solutionDir });
	}

	const tempRoot = path.join(tmpdir(), "workpilot-msbuild");
	mkdirSync(tempRoot, { recursive: true });
	const linkPath = path.join(tempRoot, randomUUID().replaceAll("-", "").slice(0, 12));
	try {
		symlinkSync(solutionDir, linkPath, "junction");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onMessage?.(`Could not create short legacy build path for ${solutionDir}: ${message}`);
		return action({ csprojPath, solutionDir });
	}

	try {
		return await action({
			csprojPath: path.join(linkPath, relativeProjectPath),
			solutionDir: `${linkPath}${path.sep}`,
		});
	} finally {
		removeTemporaryJunction(linkPath, onMessage);
	}
}
