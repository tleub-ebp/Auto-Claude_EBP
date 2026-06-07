import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const MSBUILD_ENV = "WORKPILOT_MSBUILD_PATH";

export const MSBUILD_UNAVAILABLE_MESSAGE =
	"MSBuild was not found. Set WORKPILOT_MSBUILD_PATH, install MSBuild/Mono Build Tools/.NET SDK, or configure a remote/VM runner.";

export const LEGACY_MSBUILD_UNAVAILABLE_MESSAGE =
	"MSBuild for legacy .NET Framework was not found. Set WORKPILOT_MSBUILD_PATH to MSBuild.exe, msbuild, or xbuild; install Visual Studio Build Tools/MSBuild or Mono Build Tools; or configure a remote/VM runner.";

export const WINDOWS_RUNTIME_UNAVAILABLE_MESSAGE =
	"A Windows-compatible runtime was not found. Install Mono/Wine for local .NET Framework desktop runs on this OS, or configure a remote/VM runner.";

export const KNOWN_MSBUILD_PATHS = [
	"C:\\Program Files\\Microsoft Visual Studio\\2022\\Preview\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\BuildTools\\MSBuild\\15.0\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\Enterprise\\MSBuild\\15.0\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\Professional\\MSBuild\\15.0\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\Community\\MSBuild\\15.0\\Bin\\MSBuild.exe",
	"C:\\Program Files (x86)\\MSBuild\\14.0\\Bin\\MSBuild.exe",
	"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe",
	"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\MSBuild.exe",
];

export interface MsBuildInvocation {
	command: string;
	argsPrefix: string[];
	label: string;
	source: "env" | "vswhere" | "known-path" | "path-msbuild" | "path-xbuild" | "dotnet";
}

export interface MsBuildSearchOptions {
	allowDotnetMsBuild?: boolean;
}

export function quotePowerShellSingle(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function findCommandInPath(command: string): string | null {
	const lookupCommand = process.platform === "win32" ? "where" : "which";
	try {
		const stdout = execFileSync(lookupCommand, [command], { encoding: "utf-8" });
		return stdout.split(/\r?\n/).find(Boolean) ?? null;
	} catch {
		return null;
	}
}

function isDotnetExecutable(commandPath: string): boolean {
	const baseName = path.basename(commandPath, path.extname(commandPath)).toLowerCase();
	return baseName === "dotnet";
}

function allowsDotnetMsBuild(options?: MsBuildSearchOptions): boolean {
	return options?.allowDotnetMsBuild !== false;
}

function fromExecutable(
	command: string,
	source: MsBuildInvocation["source"],
	options?: MsBuildSearchOptions,
): MsBuildInvocation | null {
	if (isDotnetExecutable(command)) {
		if (!allowsDotnetMsBuild(options)) return null;
		return {
			command,
			argsPrefix: ["msbuild"],
			label: `${command} msbuild`,
			source: "dotnet",
		};
	}
	return { command, argsPrefix: [], label: command, source };
}

function resolveConfiguredCommand(value: string | undefined): string | null {
	const normalized = value?.trim().replace(/^["']|["']$/g, "");
	if (!normalized) return null;
	if (existsSync(normalized)) return normalized;
	return findCommandInPath(normalized);
}

function findMsBuildViaVsWhere(): MsBuildInvocation | null {
	if (process.platform !== "win32") return null;
	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	if (!existsSync(vswhere)) return null;
	const findPatterns = [
		"MSBuild\\Current\\Bin\\MSBuild.exe",
		"MSBuild\\**\\Bin\\MSBuild.exe",
	];
	try {
		for (const findPattern of findPatterns) {
			const stdout = execFileSync(
				vswhere,
				[
					"-latest",
					"-products",
					"*",
					"-requires",
					"Microsoft.Component.MSBuild",
					"-find",
					findPattern,
				],
				{ encoding: "utf-8" },
			);
			const [msbuild] = stdout.split(/\r?\n/).filter(Boolean);
			const invocation =
				msbuild && existsSync(msbuild) ? fromExecutable(msbuild, "vswhere") : null;
			if (invocation) return invocation;
		}
		return null;
	} catch {
		return null;
	}
}

export function findMsBuildInvocation(
	options?: MsBuildSearchOptions,
): MsBuildInvocation | null {
	const envPath = resolveConfiguredCommand(process.env[MSBUILD_ENV]);
	if (envPath) {
		const envMsBuild = fromExecutable(envPath, "env", options);
		if (envMsBuild) return envMsBuild;
	}

	const vswhereMsBuild = findMsBuildViaVsWhere();
	if (vswhereMsBuild) return vswhereMsBuild;

	const knownPath =
		process.platform === "win32"
			? KNOWN_MSBUILD_PATHS.find((candidate) => existsSync(candidate))
			: null;
	if (knownPath) return fromExecutable(knownPath, "known-path", options);

	const pathMsBuild = findCommandInPath("msbuild");
	if (pathMsBuild) return fromExecutable(pathMsBuild, "path-msbuild", options);

	const pathXBuild = findCommandInPath("xbuild");
	if (pathXBuild) return fromExecutable(pathXBuild, "path-xbuild", options);

	if (!allowsDotnetMsBuild(options)) return null;
	const dotnet = findCommandInPath("dotnet");
	return dotnet ? fromExecutable(dotnet, "dotnet", options) : null;
}

export function buildPowerShellKnownMsBuildArray(): string {
	return KNOWN_MSBUILD_PATHS.map(quotePowerShellSingle).join(",");
}
