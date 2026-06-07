import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLegacyPackageReferencesTarget,
	shouldUseExternalRoslynCompiler,
} from "./legacy-dotnet-build";

interface PackageAsset {
	id: string;
	version: string;
	assembly: string;
	extraLibAssemblies?: string[];
}

function writeAssetsFile(
	projectDir: string,
	packagesRoot: string,
	packages: PackageAsset[],
): void {
	const target: Record<string, { compile: Record<string, Record<string, never>> }> = {};
	for (const packageAsset of packages) {
		const compilePath = `lib/net48/${packageAsset.assembly}.dll`;
		const packageDir = path.join(
			packagesRoot,
			packageAsset.id.toLowerCase(),
			packageAsset.version,
			"lib",
			"net48",
		);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(path.join(packageDir, `${packageAsset.assembly}.dll`), "");
		for (const extraAssembly of packageAsset.extraLibAssemblies ?? []) {
			writeFileSync(path.join(packageDir, `${extraAssembly}.dll`), "");
		}
		target[`${packageAsset.id}/${packageAsset.version}`] = {
			compile: { [compilePath]: {} },
		};
	}

	const objDir = path.join(projectDir, "obj");
	mkdirSync(objDir, { recursive: true });
	writeFileSync(
		path.join(objDir, "project.assets.json"),
		JSON.stringify({
			targets: { ".NETFramework,Version=v4.8": target },
			project: { restore: { packagesPath: packagesRoot } },
		}),
	);
}

describe("legacy .NET build helpers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "workpilot-legacy-dotnet-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates references from every restored project asset in the solution", () => {
		const solutionDir = path.join(tempDir, "Sources");
		const appDir = path.join(solutionDir, "App");
		const siblingDir = path.join(solutionDir, "Sibling");
		const packagesRoot = path.join(solutionDir, "packages");
		mkdirSync(appDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });
		const appProject = path.join(appDir, "App.csproj");
		writeFileSync(appProject, "<Project />");
		mkdirSync(path.join(appDir, "Properties"), { recursive: true });
		writeFileSync(
			path.join(appDir, "Properties", "licenses.licx"),
			[
				"DevExpress.XtraGrid.GridControl, DevExpress.XtraGrid.v22.2, Version=22.2.3.0, Culture=neutral, PublicKeyToken=b88d1754d700e49a",
			].join("\n"),
		);
		writeFileSync(
			path.join(appDir, "Dashboard.resx"),
			[
				'    <data name="Button" type="DevExpress.XtraEditors.Controls.ButtonPredefines, DevExpress.Utils.v22.2, Version=22.2.3.0, Culture=neutral, PublicKeyToken=b88d1754d700e49a">',
				"    </data>",
				'    <assembly alias="DevExpress.XtraCharts.v22.2" name="DevExpress.XtraCharts.v22.2, Version=22.2.3.0, Culture=neutral, PublicKeyToken=b88d1754d700e49a" />',
				'    <data name="Legend" type="DevExpress.XtraCharts.LegendAlignmentHorizontal, DevExpress.XtraCharts.v22.2">',
				"    </data>",
			].join("\n"),
		);

		writeAssetsFile(appDir, packagesRoot, [
			{ id: "Acme.Core", version: "1.0.0", assembly: "Acme.Core" },
			{
				id: "DevExpress.Win.Grid",
				version: "22.2.3",
				assembly: "DevExpress.XtraGrid.v22.2",
			},
			{
				id: "DevExpress.Win.Core",
				version: "22.2.3",
				assembly: "DevExpress.Utils.v22.2",
			},
			{
				id: "DevExpress.Charts",
				version: "22.2.3",
				assembly: "DevExpress.XtraCharts.v22.2",
			},
		]);
		writeAssetsFile(siblingDir, packagesRoot, [
			{ id: "Acme.Core", version: "2.0.0", assembly: "Acme.Core" },
			{
				id: "Acme.Tools",
				version: "1.0.0",
				assembly: "Acme.Tools",
				extraLibAssemblies: ["Acme.Tools.Hidden"],
			},
			{
				id: "EBP.Framework.Api",
				version: "8.10.0.28026",
				assembly: "EBP.Api",
				extraLibAssemblies: ["EBP.Api.Common"],
			},
		]);

		const targetPath = createLegacyPackageReferencesTarget(appProject, solutionDir);

		expect(targetPath).not.toBeNull();
		const target = readFileSync(targetPath ?? "", "utf-8");
		expect(target).toContain("EBP.Api");
		expect(target).toContain("EBP.Api.Common");
		expect(target).toContain("WorkPilotSkipLegacyLicxResources");
		expect(target).toContain('BeforeTargets="SplitResourcesByCulture"');
		expect(target).toContain('BeforeTargets="CoreCompile"');
		expect(target).toContain("<ReferencePath Include=");
		expect(target).toContain('BeforeTargets="CoreResGen;CompileLicxFiles"');
		expect(target).toContain("%(ProjectReference.Filename).dll");
		expect(target).toContain("WorkPilotCopyLegacyRuntimeDependencies");
		expect(target).toContain('AfterTargets="CopyFilesToOutputDirectory"');
		expect(target).toContain('DestinationFolder="$(TargetDir)"');
		expect(target).toContain(path.join("acme.core", "2.0.0"));
		expect(target).not.toContain(path.join("acme.core", "1.0.0"));
		expect(target).not.toContain("Acme.Tools.Hidden");
		const licenseTarget =
			target.match(/WorkPilotLegacyBuildToolReferencePath[\s\S]+?<\/Target>/)?.[0] ??
			"";
		expect(licenseTarget).toContain("DevExpress.XtraGrid.v22.2.dll");
		expect(licenseTarget).toContain("DevExpress.Utils.v22.2.dll");
		expect(licenseTarget).toContain("DevExpress.XtraCharts.v22.2.dll");
		expect(licenseTarget).not.toContain("Acme.Core.dll");
		const runtimeTarget =
			target.match(/WorkPilotCopyLegacyRuntimeDependencies[\s\S]+?<\/Target>/)?.[0] ??
			"";
		expect(runtimeTarget).toContain("EBP.Api.Common.dll");
		expect(runtimeTarget).toContain("<Copy SourceFiles=");
	});

	it("uses external Roslyn only for legacy framework MSBuild hosts", () => {
		expect(
			shouldUseExternalRoslynCompiler(
				"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe",
			),
		).toBe(true);
		expect(
			shouldUseExternalRoslynCompiler(
				"C:\\Program Files (x86)\\MSBuild\\14.0\\Bin\\MSBuild.exe",
			),
		).toBe(true);
		expect(
			shouldUseExternalRoslynCompiler(
				"C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
			),
		).toBe(false);
		expect(shouldUseExternalRoslynCompiler("C:\\Program Files\\dotnet\\dotnet.exe")).toBe(
			false,
		);
	});
});
