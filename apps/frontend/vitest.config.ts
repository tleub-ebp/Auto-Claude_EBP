import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "jsdom",
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"src/**/*.spec.ts",
			"src/**/*.spec.tsx",
		],
		exclude: ["node_modules", "dist", "out"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.test.tsx",
				"src/**/*.spec.ts",
				"src/**/*.spec.tsx",
				"src/**/*.d.ts",
			],
		},
		// Mock Electron modules for unit tests
		alias: {
			electron: resolve(__dirname, "src/__mocks__/electron.ts"),
			// electron-log requires the electron binary at module load time via CJS require('electron').
			// In CI, electron is installed with --ignore-scripts so the binary is absent and index.js throws.
			// Aliasing at the vitest level prevents any test from ever loading the real electron-log.
			"electron-log/main.js": resolve(
				__dirname,
				"src/__mocks__/electron-log-main.ts",
			),
			"@sentry/electron/main": resolve(
				__dirname,
				"src/__mocks__/sentry-electron-main.ts",
			),
			"@sentry/electron/renderer": resolve(
				__dirname,
				"src/__mocks__/sentry-electron-renderer.ts",
			),
		},
		// Setup files for test environment - use setupFiles to avoid vitest import issues
		setupFiles: ["./src/__tests__/testSetup.ts"],
		// Suppress internal worker state errors from vitest 2.x
		dangerouslyIgnoreUnhandledErrors: true,
		// Prevent vitest import issues
		testTimeout: 30000,
		hookTimeout: 30000,
		// In CI / pre-push we hit a long-standing vitest fork-pool flake on
		// Windows: workers occasionally die with "Vitest failed to access
		// its internal state" at startup. The same suite passes
		// interactively. The trigger seems to be the density of fork
		// startups, not parallelism per se — so we throttle (not disable)
		// parallelism when VITEST_LIMIT_WORKERS=1 (the pre-push script
		// sets this). Interactive runs (no env var) keep full parallelism.
		//
		// maxWorkers: 1 also works but is ~14× slower on the full suite,
		// so prefer 2 here and let the pre-push retry-once policy catch
		// the rare residual flake.
		...(process.env.VITEST_LIMIT_WORKERS === "1" ? { maxWorkers: 2 } : {}),
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src/renderer"),
			"@main": resolve(__dirname, "src/main"),
			"@renderer": resolve(__dirname, "src/renderer"),
			"@shared": resolve(__dirname, "src/shared"),
			"@preload": resolve(__dirname, "src/preload"),
			"@features": resolve(__dirname, "src/renderer/features"),
			"@components": resolve(__dirname, "src/renderer/shared/components"),
			"@hooks": resolve(__dirname, "src/renderer/shared/hooks"),
			"@lib": resolve(__dirname, "src/renderer/lib"),
		},
	},
});
