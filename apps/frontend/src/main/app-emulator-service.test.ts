import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEmulatorService, formatServerExitError } from "./app-emulator-service";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		isPackaged: false,
	},
}));

describe("AppEmulatorService project detection", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "workpilot-emulator-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects a nested legacy ASP.NET project from a worktree root", async () => {
		const appDir = path.join(tempDir, "Sources", "LegacyWeb");
		mkdirSync(appDir, { recursive: true });
		writeFileSync(path.join(appDir, "Web.config"), "<configuration />");
		writeFileSync(
			path.join(appDir, "LegacyWeb.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(tempDir);

		expect(config.framework).toBe("dotnet-framework-iis-express");
		expect(config.isWeb).toBe(true);
		expect(config.projectDir).toBe(appDir);
		expect(config.startCommand).toContain("WORKPILOT_IIS_EXPRESS_PATH");
		expect(config.startCommand).toContain(appDir);
	});

	it.skipIf(process.platform !== "win32")(
		"classifies a nested legacy WinForms project as a desktop app",
		async () => {
		const appDir = path.join(tempDir, "src", "HeavyClient");
		mkdirSync(appDir, { recursive: true });
		writeFileSync(
			path.join(appDir, "HeavyClient.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"    <OutputType>WinExe</OutputType>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(tempDir);

		expect(config.framework).toBe("dotnet-framework-desktop");
		expect(config.isWeb).toBe(false);
		expect(config.type).toBe("desktop");
		expect(config.projectDir).toBe(appDir);
		expect(config.startCommand).toContain("workpilot-run-legacy-desktop.ps1");
		expect(config.startCommand).not.toContain("dotnet msbuild");
		const scriptPath = path.join(appDir, "obj", "workpilot-run-legacy-desktop.ps1");
		expect(config.startCommand).toContain(`-File "${scriptPath}"`);
		expect(config.startCommand).not.toContain("-File '");
		const script = readFileSync(scriptPath, "utf-8");
		expect(script).toContain("WORKPILOT_MSBUILD_PATH");
		expect(script).toContain(
			"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe",
		);
		expect(script).toContain("& $dotnet.Source restore");
		expect(script).toContain("New-LegacyPackageReferencesTarget");
		expect(script).toContain("Invoke-WithLegacyXmlNamespacePatch");
		expect(script).not.toContain("-match 'MSB4097'");
		const patchIndex = script.indexOf(
			"$output = Invoke-WithLegacyXmlNamespacePatch {",
		);
		const buildExitIndex = script.indexOf("if ($script:buildExit -ne 0) {");
		expect(patchIndex).toBeGreaterThan(-1);
		expect(buildExitIndex).toBeGreaterThan(patchIndex);
		expect(script).toContain("MSBuild 15+ / Roslyn C# compiler");
		expect(script).toContain("WORKPILOT_CSC_TOOL_PATH");
		expect(script).toContain("CscToolPath");
		expect(script).toContain("WORKPILOT_SDK_TOOLS_PATH");
		expect(script).toContain("TargetFrameworkSDKToolsDirectory");
		expect(script).toContain("workpilot-msbuild");
		expect(script).toContain("New-Item -ItemType Junction");
		expect(script).toContain("Find-NetStandardFacadePaths");
		expect(script).toContain("WorkPilotSkipLegacyLicxResources");
		expect(script).toContain("SplitResourcesByCulture");
		expect(script).toContain("Find-BuildToolAssemblyNames");
		expect(script).toContain("WorkPilotLegacyBuildToolReferencePath");
		expect(script).toContain("CoreResGen;CompileLicxFiles");
		expect(script).toContain("WorkPilotCopyLegacyRuntimeDependencies");
		expect(script).toContain("Should-CopyRuntimeReference");
		expect(script).toContain("DestinationFolder=\"$(TargetDir)\"");
		expect(script).toContain("WorkPilotLegacyReferencePath");
		expect(script).toContain("ReferencePath Include");
		expect(script).toContain("%(ProjectReference.Filename).dll");
		expect(script).toContain("CustomBeforeMicrosoftCommonTargets");
		expect(script).toContain("GenerateResourceUsePreserializedResources=true");
		expect(script).not.toContain("& $dotnet.Source msbuild");
		const msbuildLookupIndex = script.indexOf("$msbuild = Find-LegacyMsBuild");
		const executableLookupIndex = script.indexOf(
			"$exe = Get-ChildItem -Path $binDir -Recurse",
		);
		expect(msbuildLookupIndex).toBeGreaterThan(-1);
		expect(executableLookupIndex).toBeGreaterThan(msbuildLookupIndex);
		},
	);

	it("prefers the first runnable non-test project declared in a solution", async () => {
		const sourcesDir = path.join(tempDir, "Sources");
		const appDir = path.join(sourcesDir, "EBP.Invoicing.Application");
		const testHarnessDir = path.join(sourcesDir, "EBP.Automotive.Hub.TestApplication");
		mkdirSync(appDir, { recursive: true });
		mkdirSync(testHarnessDir, { recursive: true });
		writeFileSync(
			path.join(sourcesDir, "EBP.Automotive.Trunc.sln"),
			[
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "EBP.Invoicing.Application", "EBP.Invoicing.Application\\EBP.Invoicing.Application.csproj", "{00000000-0000-0000-0000-000000000001}"',
				"EndProject",
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "EBP.Automotive.Hub.TestApplication", "EBP.Automotive.Hub.TestApplication\\EBP.Automotive.Hub.TestApplication.csproj", "{00000000-0000-0000-0000-000000000002}"',
				"EndProject",
			].join("\n"),
		);
		writeFileSync(
			path.join(appDir, "EBP.Invoicing.Application.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"    <OutputType>WinExe</OutputType>",
				"    <AssemblyName>EBP.Automotive.Application</AssemblyName>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);
		writeFileSync(
			path.join(testHarnessDir, "EBP.Automotive.Hub.TestApplication.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"    <OutputType>WinExe</OutputType>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(tempDir);

		expect(config.framework).toBe("dotnet-framework-desktop");
		expect(config.projectDir).toBe(appDir);
		// La lecture du script PowerShell n'a de sens que sur Windows :
		// sur POSIX, la commande de lancement est un script shell, pas un .ps1.
		if (process.platform === "win32") {
			const script = readFileSync(
				path.join(appDir, "obj", "workpilot-run-legacy-desktop.ps1"),
				"utf-8",
			);
			expect(script).toContain("EBP.Invoicing.Application.csproj");
			expect(script).toContain("/t:Build");
		}
		expect(config.startCommand).not.toContain("Hub.TestApplication");
	});

	it("links legacy package assets from the main repo into a worktree", async () => {
		const repoRoot = path.join(tempDir, "Repo");
		const mainPackagesDir = path.join(repoRoot, "Sources", "packages");
		const worktreeSourcesDir = path.join(
			repoRoot,
			".workpilot",
			"worktrees",
			"tasks",
			"task-1",
			"Sources",
		);
		const worktreeAppDir = path.join(worktreeSourcesDir, "LegacyClient");
		mkdirSync(mainPackagesDir, { recursive: true });
		mkdirSync(worktreeAppDir, { recursive: true });
		writeFileSync(
			path.join(worktreeSourcesDir, "Legacy.sln"),
			[
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "LegacyClient", "LegacyClient\\LegacyClient.csproj", "{00000000-0000-0000-0000-000000000001}"',
				"EndProject",
			].join("\n"),
		);
		writeFileSync(
			path.join(worktreeAppDir, "LegacyClient.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"    <OutputType>WinExe</OutputType>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(worktreeSourcesDir);

		expect(config.framework).toBe("dotnet-framework-desktop");
		expect(existsSync(path.join(worktreeSourcesDir, "packages"))).toBe(true);
	});
});

describe("formatServerExitError", () => {
	it("returns only the exit code when no output was captured", () => {
		expect(formatServerExitError(1, [])).toBe("Server exited with code 1");
	});

	it("includes the captured error lines instead of just the code", () => {
		const output = [
			"MSBuild starting...",
			"Restoring packages",
			"C:\\Microsoft.Common.targets(2863,5): error MSB3086: La tâche n'a pas pu trouver \"AL.exe\"",
			"Build FAILED.",
		];
		const message = formatServerExitError(4294770688, output);
		expect(message).toContain("Server exited with code 4294770688");
		expect(message).toContain("error MSB3086");
		expect(message).toContain('trouver "AL.exe"');
		expect(message).not.toContain("Restoring packages");
	});

	it("falls back to the last output lines when no error pattern matches", () => {
		const output = Array.from({ length: 30 }, (_, index) => `line ${index}`);
		const message = formatServerExitError(2, output);
		expect(message).toContain("line 29");
		expect(message).not.toContain("line 0");
	});

	it("deduplicates repeated error lines", () => {
		const output = ["error: boom", "error: boom", "error: boom"];
		const message = formatServerExitError(1, output);
		const occurrences = message.split("error: boom").length - 1;
		expect(occurrences).toBe(1);
	});
});
