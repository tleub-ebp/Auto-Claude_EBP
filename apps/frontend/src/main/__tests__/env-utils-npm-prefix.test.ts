/**
 * Regression tests for the synchronous npm-global-prefix detection inside
 * getAugmentedEnv().
 *
 * Bug: on Windows, getAugmentedEnv() (called by every synchronous getToolPath())
 * ran `npm config get prefix` via cmd.exe → npm.cmd → node, a ~1s SYNCHRONOUS
 * subprocess. Because it was called several times per startup (the changelog
 * service singleton constructor, the git/gh IPC handlers, …) and was NOT cached,
 * it blocked the Electron main-process event loop for seconds and froze the
 * window at launch ("Ne répond pas").
 *
 * Fix: on Windows the prefix is deterministic (%APPDATA%\npm), so it is resolved
 * without a child process. These tests assert no synchronous spawn happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn((..._args: unknown[]) => "");

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		// Only intercept the synchronous spawn; everything else stays real so
		// other modules in the import chain (e.g. windows-paths) keep working.
		execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
	};
});

describe("getAugmentedEnv – no synchronous npm spawn on Windows", () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		execFileSyncMock.mockClear();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			writable: true,
			configurable: true,
		});
		vi.resetModules();
	});

	const setPlatform = (value: NodeJS.Platform) => {
		Object.defineProperty(process, "platform", {
			value,
			writable: true,
			configurable: true,
		});
	};

	it("does NOT spawn a subprocess on Windows (prefix resolved from %APPDATA%)", async () => {
		setPlatform("win32");
		// Fresh module so the module-level npm prefix cache starts empty.
		vi.resetModules();
		const { getAugmentedEnv } = await import("../env-utils");

		const env = getAugmentedEnv();

		// The core guarantee: the main process is never blocked by a sync spawn.
		expect(execFileSyncMock).not.toHaveBeenCalled();
		expect(typeof env.PATH).toBe("string");
	});

	it("does NOT spawn a subprocess on repeated Windows calls", async () => {
		setPlatform("win32");
		vi.resetModules();
		const { getAugmentedEnv } = await import("../env-utils");

		getAugmentedEnv();
		getAugmentedEnv(["C:\\some\\extra\\path"]);
		getAugmentedEnv();

		expect(execFileSyncMock).not.toHaveBeenCalled();
	});
});
