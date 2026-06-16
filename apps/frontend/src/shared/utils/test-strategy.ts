/**
 * Test-strategy classification for files touched by a task.
 *
 * Maps each changed file to the kind of test worth generating for it:
 * - "unit"        — services/business logic → unit tests (xunit, vitest, pytest...)
 * - "api"         — controllers/routes → endpoint-focused tests
 * - "e2e-web"     — web UI components/pages → end-to-end tests
 * - "desktop-ui"  — WinForms/WPF surfaces → UI-level tests
 * - "skip"        — tests themselves, designers, resources, config...
 */

export type TestStrategy = "unit" | "api" | "e2e-web" | "desktop-ui" | "skip";

const SOURCE_EXTENSIONS = new Set([
	".cs",
	".ts",
	".js",
	".py",
	".java",
	".go",
	".rb",
	".php",
	".kt",
	".swift",
	".vb",
	".cpp",
	".c",
]);

const WEB_UI_EXTENSIONS = new Set([
	".tsx",
	".jsx",
	".vue",
	".svelte",
	".html",
	".razor",
	".cshtml",
]);

const TEST_PATH_PATTERN =
	/(^|\/)(tests?|__tests__|testdata|automatedtests)(\/|$)|\.(test|spec)s?\.[a-z]+$|tests?\.cs$/i;

const API_PATH_PATTERN =
	/(^|\/)(controllers?|routes?|routers?|endpoints?|api)(\/|$)|controller\.(cs|ts|js)$|\.controller\.(ts|js)$|endpoints?\.cs$/i;

const DESKTOP_UI_FILE_PATTERN =
	/(form|formbase|usercontrol|window|panel|dialog)[a-z0-9]*\.(cs|vb)$|\.xaml(\.cs)?$/i;

function getExtension(normalizedPath: string): string {
	const fileName = normalizedPath.split("/").pop() ?? "";
	const dotIndex = fileName.lastIndexOf(".");
	return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

/**
 * Classify a changed file into a test strategy.
 *
 * @param filePath - File path relative to the worktree (any separator)
 * @param allPaths - All changed paths, used to detect WinForms designer pairs
 */
export function classifyTestStrategy(
	filePath: string,
	allPaths: readonly string[] = [],
): TestStrategy {
	const normalized = filePath.replaceAll("\\", "/");
	const lower = normalized.toLowerCase();
	const extension = getExtension(lower);

	// Never generate tests for tests, designers or non-source assets
	if (lower.endsWith(".designer.cs") || TEST_PATH_PATTERN.test(lower)) {
		return "skip";
	}
	if (!SOURCE_EXTENSIONS.has(extension) && !WEB_UI_EXTENSIONS.has(extension)) {
		return "skip";
	}

	// WinForms: a sibling .Designer.cs marks the file as a designed surface
	if (extension === ".cs" || extension === ".vb") {
		const designerSibling = lower.replace(/\.(cs|vb)$/, ".designer.$1");
		const hasDesignerPair = allPaths.some(
			(candidate) => candidate.replaceAll("\\", "/").toLowerCase() === designerSibling,
		);
		if (hasDesignerPair || DESKTOP_UI_FILE_PATTERN.test(lower)) {
			// Controllers named *FormController.cs stay API: check API first there
			if (API_PATH_PATTERN.test(lower)) return "api";
			return "desktop-ui";
		}
	}

	if (API_PATH_PATTERN.test(lower)) {
		return "api";
	}

	if (WEB_UI_EXTENSIONS.has(extension)) {
		return "e2e-web";
	}

	return "unit";
}

/** Strategies that produce something when generated (everything but "skip"). */
export function isGeneratableStrategy(
	strategy: TestStrategy,
): strategy is Exclude<TestStrategy, "skip"> {
	return strategy !== "skip";
}
