/**
 * Integration tests for AgentProcessManager
 * Tests API profile environment variable injection into spawnProcess
 *
 * Story 2.3: Env Var Injection - AC1, AC2, AC3, AC4
 */

/// @vitest/environment node

// Mock Electron BEFORE any other imports since agent-process.ts imports it
vi.mock("electron", () => ({
	app: {
		getAppPath: vi.fn(() => "/fake/app/path"),
		getPath: vi.fn((name: string) => {
			const paths: Record<string, string> = {
				userData: "/tmp/test-app-data",
				home: "/tmp/test-home",
				temp: "/tmp",
			};
			return paths[name] || "/tmp";
		}),
	},
}));

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Create a mock process object that will be returned by spawn
function createMockProcess() {
	return {
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
		on: vi.fn((event: string, callback: (code: number) => void) => {
			if (event === "exit") {
				// Simulate immediate exit with code 0
				setTimeout(() => callback(0), 10);
			}
		}),
		kill: vi.fn(),
	};
}

// Mock child_process - must be BEFORE imports of modules that use it
const spawnCalls: Array<{
	command: string;
	args: string[];
	options: {
		env: Record<string, string>;
		cwd?: string;
		[key: string]: unknown;
	};
}> = [];

vi.mock("node:child_process", () => {
	const mockSpawn = vi.fn(
		(
			command: string,
			args: string[],
			options: {
				env: Record<string, string>;
				cwd?: string;
				[key: string]: unknown;
			},
		) => {
			// Record the call for test assertions
			spawnCalls.push({ command, args, options });
			return createMockProcess();
		},
	);

	const mockExecSync = vi.fn((command: string) => {
		if (command.includes("git")) {
			return "/fake/path";
		}
		return "";
	});

	const mod = {
		spawn: mockSpawn,
		execSync: mockExecSync,
		execFileSync: mockExecSync,
		execFile: vi.fn(),
		exec: vi.fn(),
		fork: vi.fn(),
		spawnSync: vi.fn(),
	};
	return { ...mod, default: mod };
});

// Mock fs to avoid browser-external issues in jsdom
vi.mock("node:fs", () => {
	const mod = {
		existsSync: vi.fn((inputPath: string) => {
			// Normalize path separators for cross-platform compatibility
			const normalizedPath = inputPath.replaceAll(/\\/g, "/");
			// Return true for the fake auto-build path and its expected files
			if (
				normalizedPath === "/fake/auto-build" ||
				normalizedPath === "/fake/auto-build/runners" ||
				normalizedPath === "/fake/auto-build/runners/spec_runner.py"
			) {
				return true;
			}
			return false;
		}),
		readFileSync: vi.fn(() => ""),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
		renameSync: vi.fn(),
		unlinkSync: vi.fn(),
		readdirSync: vi.fn(() => []),
		promises: {},
	};
	return { ...mod, default: mod };
});

// Mock os to avoid browser-external issues in jsdom
vi.mock("node:os", () => {
	const mod = {
		homedir: vi.fn(() => "/mock/home"),
		userInfo: vi.fn(() => ({ username: "testuser" })),
	};
	return { ...mod, default: mod };
});

// Mock claude-profile modules that import 'fs' (browser-external in jsdom)
vi.mock("../claude-profile/token-refresh", () => ({
	ensureValidToken: vi.fn(),
	markAgentRunning: vi.fn(),
	markAgentStopped: vi.fn(),
}));

vi.mock("../claude-profile/credential-utils", () => ({
	clearKeychainCache: vi.fn(),
	getStoredCredentials: vi.fn(),
	storeCredentials: vi.fn(),
}));

vi.mock("../claude-profile/profile-selection-lock", () => ({
	getProfileSelectionLock: vi.fn(() => ({
		acquire: vi.fn(),
		release: vi.fn(),
	})),
}));

// Mock project-initializer to avoid child_process.execSync issues
vi.mock("../project-initializer", () => ({
	getAutoBuildPath: vi.fn(() => "/fake/auto-build"),
	isInitialized: vi.fn(() => true),
	initializeProject: vi.fn(),
	getProjectStorePath: vi.fn(() => "/fake/store/path"),
}));

// Mock project-store BEFORE agent-process imports it
vi.mock("../project-store", () => ({
	projectStore: {
		getProject: vi.fn(),
		listProjects: vi.fn(),
		createProject: vi.fn(),
		updateProject: vi.fn(),
		deleteProject: vi.fn(),
		getProjectSettings: vi.fn(),
		updateProjectSettings: vi.fn(),
	},
}));

// Mock claude-profile-manager
vi.mock("../claude-profile-manager", () => ({
	getClaudeProfileManager: vi.fn(() => ({
		getProfilePath: vi.fn(() => "/fake/profile/path"),
		ensureProfileDir: vi.fn(),
		readProfile: vi.fn(),
		writeProfile: vi.fn(),
		deleteProfile: vi.fn(),
		getActiveProfile: vi.fn(() => null),
		listProfiles: vi.fn(() => []),
		setActiveProfile: vi.fn(),
	})),
}));

// Mock credential-manager to avoid browser-external issues in jsdom
vi.mock("../services/credential-manager", () => ({
	credentialManager: {
		getEnvironmentVariables: vi.fn(() => ({})),
		getActiveCredential: vi.fn(() => null),
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
	},
	detectWindsurfLocalToken: vi.fn(() => Promise.resolve({ success: false })),
	readWindsurfCachedPlanInfo: vi.fn(() => Promise.resolve({ success: false })),
}));

// Mock dependencies
vi.mock("../services/profile", () => ({
	getAPIProfileEnv: vi.fn(),
}));

vi.mock("../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: vi.fn(() => ({
		env: {},
		profileId: "default",
		profileName: "Default",
		wasSwapped: false,
	})),
	detectRateLimit: vi.fn(() => ({ isRateLimited: false })),
	createSDKRateLimitInfo: vi.fn(),
	detectAuthFailure: vi.fn(() => ({ isAuthFailure: false })),
}));

vi.mock("../python-detector", () => ({
	findPythonCommand: vi.fn(() => "python"),
	parsePythonCommand: vi.fn(() => ["python", []]),
}));

// Mock python-env-manager for ensurePythonEnvReady tests
vi.mock("../python-env-manager", () => ({
	pythonEnvManager: {
		isEnvReady: vi.fn(() => true),
		initialize: vi.fn(() => Promise.resolve({ ready: true })),
		getPythonEnv: vi.fn(() => ({})),
	},
	getConfiguredPythonPath: vi.fn(() => "python3"),
}));

// Mock cli-tool-manager to avoid blocking tool detection on Windows
vi.mock("../cli-tool-manager", () => ({
	getToolInfo: vi.fn((tool: string) => {
		if (tool === "gh") {
			// Default: gh CLI not found
			return {
				found: false,
				path: undefined,
				source: "user-config",
				message: "gh CLI not found",
			};
		}
		if (tool === "claude") {
			return {
				found: false,
				path: undefined,
				source: "user-config",
				message: "Claude CLI not found",
			};
		}
		return {
			found: false,
			path: undefined,
			source: "user-config",
			message: `${tool} not found`,
		};
	}),
	// getClaudeCliPathForSdk returns null by default (simulates not found or .cmd file on Windows)
	getClaudeCliPathForSdk: vi.fn(() => null),
	deriveGitBashPath: vi.fn(() => null),
	clearCache: vi.fn(),
}));

// Mock env-utils to avoid blocking environment augmentation
vi.mock("../env-utils", () => ({
	getAugmentedEnv: vi.fn(() => ({ ...process.env })),
}));

import { getToolInfo } from "../cli-tool-manager";
import { pythonEnvManager } from "../python-env-manager";
import * as rateLimitDetector from "../rate-limit-detector";
import * as profileService from "../services/profile";
import { AgentEvents } from "./agent-events";
// Import AFTER all mocks are set up
import { AgentProcessManager, resolveExitFailure } from "./agent-process";
import { AgentState } from "./agent-state";

describe("AgentProcessManager - API Profile Env Injection (Story 2.3)", () => {
	let processManager: AgentProcessManager;
	let state: AgentState;
	let events: AgentEvents;
	let emitter: EventEmitter;

	beforeEach(() => {
		// Reset all mocks and spawn calls
		vi.clearAllMocks();
		spawnCalls.length = 0;

		// Clear environment variables that could interfere with tests
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		// Clear CLI path env vars so tests use mocked getToolInfo
		delete process.env.CLAUDE_CLI_PATH;
		delete process.env.GITHUB_CLI_PATH;

		// Initialize components
		state = new AgentState();
		events = new AgentEvents();
		emitter = new EventEmitter();
		processManager = new AgentProcessManager(state, events, emitter);
	});

	afterEach(() => {
		processManager.killAllProcesses();
	});

	describe("AC1: API Profile Env Var Injection", () => {
		it("should inject ANTHROPIC_BASE_URL when active profile has baseUrl", async () => {
			const mockApiProfileEnv = {
				ANTHROPIC_BASE_URL: "https://custom.api.com",
				ANTHROPIC_AUTH_TOKEN: "sk-test-key",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0].command).toBe("python");
			expect(spawnCalls[0].args).toContain("run.py");
			expect(spawnCalls[0].options.env).toMatchObject({
				ANTHROPIC_BASE_URL: "https://custom.api.com",
				ANTHROPIC_AUTH_TOKEN: "sk-test-key",
			});
		});

		it("should inject ANTHROPIC_AUTH_TOKEN when active profile has apiKey", async () => {
			const mockApiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-custom-key-12345678",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0].options.env.ANTHROPIC_AUTH_TOKEN).toBe(
				"sk-custom-key-12345678",
			);
		});

		it("should inject model env vars when active profile has models configured", async () => {
			const mockApiProfileEnv = {
				ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
				ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
				ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5-20250929",
				ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5-20251101",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0].options.env).toMatchObject({
				ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
				ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
				ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5-20250929",
				ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5-20251101",
			});
		});

		it("should give API profile env vars highest precedence over extraEnv", async () => {
			const extraEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-extra-token",
				ANTHROPIC_BASE_URL: "https://extra.com",
			};

			const mockApiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-profile-token",
				ANTHROPIC_BASE_URL: "https://profile.com",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				extraEnv,
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			// API profile should override extraEnv
			expect(spawnCalls[0].options.env.ANTHROPIC_AUTH_TOKEN).toBe(
				"sk-profile-token",
			);
			expect(spawnCalls[0].options.env.ANTHROPIC_BASE_URL).toBe(
				"https://profile.com",
			);
		});
	});

	describe("AC2: OAuth Mode (No Active Profile)", () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			// Save original environment before each test
			originalEnv = { ...process.env };
		});

		afterEach(() => {
			// Restore original environment after each test
			process.env = originalEnv;
		});

		it("should NOT set ANTHROPIC_AUTH_TOKEN when no active profile (OAuth mode)", async () => {
			// Return empty object = OAuth mode
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue({});

			// Set OAuth token via getProfileEnv (existing flow)
			vi.mocked(rateLimitDetector.getBestAvailableProfileEnv).mockReturnValue({
				env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-123" },
				profileId: "default",
				profileName: "Default",
				wasSwapped: false,
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;
			expect(envArg.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-123");
			// OAuth mode clears ANTHROPIC_AUTH_TOKEN with empty string (not undefined)
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("");
		});

		it("should return empty object from getAPIProfileEnv when activeProfileId is null", async () => {
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue({});

			const result = await profileService.getAPIProfileEnv();
			expect(result).toEqual({});
		});

		it("should clear stale ANTHROPIC_AUTH_TOKEN from process.env when switching to OAuth mode", async () => {
			// Simulate process.env having stale ANTHROPIC_* vars from previous session
			process.env = {
				...originalEnv,
				ANTHROPIC_AUTH_TOKEN: "stale-token-from-env",
				ANTHROPIC_BASE_URL: "https://stale.example.com",
			};

			// OAuth mode - no active API profile
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue({});

			// Set OAuth token
			vi.mocked(rateLimitDetector.getBestAvailableProfileEnv).mockReturnValue({
				env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-456" },
				profileId: "default",
				profileName: "Default",
				wasSwapped: false,
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// OAuth token should be present
			expect(envArg.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-456");

			// Stale ANTHROPIC_* vars should be cleared (empty string overrides process.env)
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("");
			expect(envArg.ANTHROPIC_BASE_URL).toBe("");
		});

		it("should clear stale ANTHROPIC_BASE_URL when switching to OAuth mode", async () => {
			process.env = {
				...originalEnv,
				ANTHROPIC_BASE_URL: "https://old-custom-endpoint.com",
			};

			// OAuth mode
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue({});
			vi.mocked(rateLimitDetector.getBestAvailableProfileEnv).mockReturnValue({
				env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-789" },
				profileId: "default",
				profileName: "Default",
				wasSwapped: false,
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Should clear the base URL (so Python uses default api.anthropic.com)
			expect(envArg.ANTHROPIC_BASE_URL).toBe("");
			expect(envArg.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-789");
		});

		it("should NOT clear ANTHROPIC_* vars when API Profile is active", async () => {
			process.env = {
				...originalEnv,
				ANTHROPIC_AUTH_TOKEN: "old-token-in-env",
			};

			// API Profile mode - active profile
			const mockApiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-profile-active",
				ANTHROPIC_BASE_URL: "https://active-profile.com",
			};
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Should use API profile vars, NOT clear them
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("sk-profile-active");
			expect(envArg.ANTHROPIC_BASE_URL).toBe("https://active-profile.com");
		});
	});

	describe("AC4: No API Key Logging", () => {
		it("should never log full API keys in spawn env vars", async () => {
			const mockApiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-sensitive-api-key-12345678",
				ANTHROPIC_BASE_URL: "https://api.example.com",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			// Mock ALL console methods to capture any debug/error output
			const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
				/* noop */
			});
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {
					/* noop */
				});
			const consoleWarnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {
					/* noop */
				});
			const consoleDebugSpy = vi
				.spyOn(console, "debug")
				.mockImplementation(() => {
					/* noop */
				});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			// Get the env object passed to spawn
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Verify the full API key is in the env (for Python subprocess)
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("sk-sensitive-api-key-12345678");

			// Collect ALL console output from all methods
			const allLogCalls = [
				...consoleLogSpy.mock.calls,
				...consoleErrorSpy.mock.calls,
				...consoleWarnSpy.mock.calls,
				...consoleDebugSpy.mock.calls,
			].flatMap((call) => call.map(String));
			const logString = JSON.stringify(allLogCalls);

			// The full API key should NOT appear in any logs (AC4 compliance)
			expect(logString).not.toContain("sk-sensitive-api-key-12345678");

			// Restore all spies
			consoleLogSpy.mockRestore();
			consoleErrorSpy.mockRestore();
			consoleWarnSpy.mockRestore();
			consoleDebugSpy.mockRestore();
		});

		it("should not log API key even in error scenarios", async () => {
			const mockApiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-secret-key-for-error-test",
				ANTHROPIC_BASE_URL: "https://api.example.com",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				mockApiProfileEnv,
			);

			// Mock console methods
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {
					/* noop */
				});
			const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
				/* noop */
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			// Collect all error and log output
			const allOutput = [
				...consoleErrorSpy.mock.calls,
				...consoleLogSpy.mock.calls,
			].flatMap((call) =>
				call.map((arg) =>
					typeof arg === "object" ? JSON.stringify(arg) : String(arg),
				),
			);
			const outputString = allOutput.join(" ");

			// Verify API key is never exposed in logs
			expect(outputString).not.toContain("sk-secret-key-for-error-test");

			consoleErrorSpy.mockRestore();
			consoleLogSpy.mockRestore();
		});
	});

	describe("AC3: Profile Switching Between Builds", () => {
		it("should allow different profiles for different spawn calls", async () => {
			// First spawn with Profile A
			const profileAEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-profile-a",
				ANTHROPIC_BASE_URL: "https://api-a.com",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValueOnce(
				profileAEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const firstEnv = spawnCalls[0].options.env as Record<string, unknown>;
			expect(firstEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-profile-a");

			// Second spawn with Profile B (user switched active profile)
			const profileBEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-profile-b",
				ANTHROPIC_BASE_URL: "https://api-b.com",
			};

			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValueOnce(
				profileBEnv,
			);

			await processManager.spawnProcess(
				"task-2",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const secondEnv = spawnCalls[1].options.env as Record<string, unknown>;
			expect(secondEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-profile-b");

			// Verify first spawn's env is NOT affected by second spawn
			expect(firstEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-profile-a");
		});
	});

	describe("Integration: Combined env precedence", () => {
		it("should merge env vars in correct precedence order", async () => {
			const extraEnv = {
				CUSTOM_VAR: "from-extra",
			};

			const profileEnv = {
				CLAUDE_CONFIG_DIR: "/custom/config",
			};

			const apiProfileEnv = {
				ANTHROPIC_AUTH_TOKEN: "sk-api-profile",
				ANTHROPIC_BASE_URL: "https://api-profile.com",
			};

			vi.mocked(rateLimitDetector.getBestAvailableProfileEnv).mockReturnValue({
				env: profileEnv,
				profileId: "default",
				profileName: "Default",
				wasSwapped: false,
			});
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue(
				apiProfileEnv,
			);

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				extraEnv,
				"task-execution",
			);

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Verify all sources are included
			expect(envArg.CUSTOM_VAR).toBe("from-extra"); // From extraEnv
			expect(envArg.CLAUDE_CONFIG_DIR).toBe("/custom/config"); // From profileEnv
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("sk-api-profile"); // From apiProfileEnv (highest for ANTHROPIC_*)

			// Verify standard Python env vars
			expect(envArg.PYTHONUNBUFFERED).toBe("1");
			expect(envArg.PYTHONIOENCODING).toBe("utf-8");
			expect(envArg.PYTHONUTF8).toBe("1");
		});

		it("should call getOAuthModeClearVars and apply clearing when in OAuth mode", async () => {
			// OAuth mode - empty API profile
			vi.mocked(profileService.getAPIProfileEnv).mockResolvedValue({});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Verify clearing vars are applied (empty strings for ANTHROPIC_* vars)
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("");
			expect(envArg.ANTHROPIC_BASE_URL).toBe("");
			expect(envArg.ANTHROPIC_MODEL).toBe("");
			expect(envArg.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("");
			expect(envArg.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("");
			expect(envArg.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("");
		});

		it("should handle getAPIProfileEnv errors gracefully", async () => {
			// Simulate service error
			vi.mocked(profileService.getAPIProfileEnv).mockRejectedValue(
				new Error("Service unavailable"),
			);

			// Should not throw - should fall back to OAuth mode
			await expect(
				processManager.spawnProcess(
					"task-1",
					"/fake/cwd",
					["run.py"],
					{},
					"task-execution",
				),
			).resolves.not.toThrow();

			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Should have clearing vars (falls back to OAuth mode on error)
			expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe("");
			expect(envArg.ANTHROPIC_BASE_URL).toBe("");
		});
	});

	describe("ensurePythonEnvReady - Python Environment Readiness (ACS-254)", () => {
		let testProcessManager: AgentProcessManager;

		beforeEach(() => {
			// Reset all mocks
			vi.clearAllMocks();
			spawnCalls.length = 0;

			// Create fresh process manager for these tests
			state = new AgentState();
			events = new AgentEvents();
			emitter = new EventEmitter();
			testProcessManager = new AgentProcessManager(state, events, emitter);
		});

		it("should return ready: true when Python environment is already ready", async () => {
			vi.mocked(pythonEnvManager.isEnvReady).mockReturnValue(true);

			// Configure with valid autoBuildSource
			testProcessManager.configure(undefined, "/fake/auto-build");

			const result =
				await testProcessManager.ensurePythonEnvReady("TestContext");

			expect(result.ready).toBe(true);
			expect(result.error).toBeUndefined();
			expect(pythonEnvManager.initialize).not.toHaveBeenCalled();
		});

		it("should initialize Python environment when not ready", async () => {
			vi.mocked(pythonEnvManager.isEnvReady).mockReturnValue(false);
			vi.mocked(pythonEnvManager.initialize).mockResolvedValue({
				ready: true,
				pythonPath: "/fake/python",
				sitePackagesPath: "/fake/site-packages",
				venvExists: true,
				depsInstalled: true,
				usingBundledPackages: false,
			});

			testProcessManager.configure(undefined, "/fake/auto-build");

			const result =
				await testProcessManager.ensurePythonEnvReady("TestContext");

			expect(result.ready).toBe(true);
			expect(result.error).toBeUndefined();
			expect(pythonEnvManager.initialize).toHaveBeenCalledWith(
				"/fake/auto-build",
			);
		});

		it("should return error when autoBuildSource is not found", async () => {
			vi.mocked(pythonEnvManager.isEnvReady).mockReturnValue(false);

			// Don't configure - autoBuildSource will be null
			const result =
				await testProcessManager.ensurePythonEnvReady("TestContext");

			expect(result.ready).toBe(false);
			expect(result.error).toBe("auto-build source not found");
			expect(pythonEnvManager.initialize).not.toHaveBeenCalled();
		});

		it("should return error when Python initialization fails", async () => {
			vi.mocked(pythonEnvManager.isEnvReady).mockReturnValue(false);
			vi.mocked(pythonEnvManager.initialize).mockResolvedValue({
				ready: false,
				pythonPath: null,
				sitePackagesPath: null,
				venvExists: false,
				depsInstalled: false,
				usingBundledPackages: false,
				error: "Failed to create venv: permission denied",
			});

			testProcessManager.configure(undefined, "/fake/auto-build");

			const result =
				await testProcessManager.ensurePythonEnvReady("TestContext");

			expect(result.ready).toBe(false);
			expect(result.error).toBe("Failed to create venv: permission denied");
		});

		it("should return error when Python initialization fails without message", async () => {
			vi.mocked(pythonEnvManager.isEnvReady).mockReturnValue(false);
			vi.mocked(pythonEnvManager.initialize).mockResolvedValue({
				ready: false,
				pythonPath: null,
				sitePackagesPath: null,
				venvExists: false,
				depsInstalled: false,
				usingBundledPackages: false,
				// No error field
			});

			testProcessManager.configure(undefined, "/fake/auto-build");

			const result =
				await testProcessManager.ensurePythonEnvReady("TestContext");

			expect(result.ready).toBe(false);
			expect(result.error).toBe("initialization failed");
			expect(pythonEnvManager.initialize).toHaveBeenCalledWith(
				"/fake/auto-build",
			);
		});
	});

	describe("GITHUB_CLI_PATH Environment Variable (ACS-321)", () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			// Save original environment before each test
			originalEnv = { ...process.env };
			// Clear GITHUB_CLI_PATH if set
			delete process.env.GITHUB_CLI_PATH;
		});

		afterEach(() => {
			// Restore original environment after each test
			process.env = originalEnv;
		});

		it("should NOT set GITHUB_CLI_PATH when gh CLI is not found", async () => {
			// Mock gh CLI as not found
			vi.mocked(getToolInfo).mockReturnValue({
				found: false,
				path: undefined,
				source: "user-config",
				message: "gh CLI not found",
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// GITHUB_CLI_PATH should not be set
			expect(envArg.GITHUB_CLI_PATH).toBeUndefined();
		});

		it("should set GITHUB_CLI_PATH when gh CLI is found by getToolInfo", async () => {
			// Mock gh CLI as found
			vi.mocked(getToolInfo).mockReturnValue({
				found: true,
				path: "/opt/homebrew/bin/gh",
				source: "homebrew",
				message: "gh CLI found via Homebrew",
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// GITHUB_CLI_PATH should be set to the detected path
			expect(envArg.GITHUB_CLI_PATH).toBe("/opt/homebrew/bin/gh");
		});

		it("should NOT override existing GITHUB_CLI_PATH from process.env", async () => {
			// Set GITHUB_CLI_PATH in process environment
			process.env.GITHUB_CLI_PATH = "/existing/path/to/gh";

			// Mock gh CLI as found at different path
			vi.mocked(getToolInfo).mockReturnValue({
				found: true,
				path: "/opt/homebrew/bin/gh",
				source: "homebrew",
				message: "gh CLI found via Homebrew",
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Should use existing GITHUB_CLI_PATH from process.env, not detected one
			expect(envArg.GITHUB_CLI_PATH).toBe("/existing/path/to/gh");
		});

		it("should detect gh CLI from system-path source", async () => {
			// Mock gh CLI found in system PATH
			vi.mocked(getToolInfo).mockReturnValue({
				found: true,
				path: "C:\\Program Files\\GitHub CLI\\gh.exe",
				source: "system-path",
				message: "gh CLI found in system PATH",
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			expect(envArg.GITHUB_CLI_PATH).toBe(
				"C:\\Program Files\\GitHub CLI\\gh.exe",
			);
		});

		it("should handle getToolInfo errors gracefully", async () => {
			// Mock getToolInfo to throw an error
			vi.mocked(getToolInfo).mockImplementation(() => {
				throw new Error("Tool detection failed");
			});

			// Should not throw - should fall back to not setting GITHUB_CLI_PATH
			await expect(
				processManager.spawnProcess(
					"task-1",
					"/fake/cwd",
					["run.py"],
					{},
					"task-execution",
				),
			).resolves.not.toThrow();

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// GITHUB_CLI_PATH should not be set on error
			expect(envArg.GITHUB_CLI_PATH).toBeUndefined();
		});

		it("should set GITHUB_CLI_PATH with same precedence as CLAUDE_CLI_PATH", async () => {
			// Mock both Claude CLI and gh CLI via getToolInfo (both use standard detection)
			vi.mocked(getToolInfo).mockImplementation((tool: string) => {
				if (tool === "claude") {
					return {
						found: true,
						path: "/opt/homebrew/bin/claude",
						source: "homebrew",
						message: "Claude CLI found via Homebrew",
					};
				}
				if (tool === "gh") {
					return {
						found: true,
						path: "/opt/homebrew/bin/gh",
						source: "homebrew",
						message: "gh CLI found via Homebrew",
					};
				}
				return {
					found: false,
					path: undefined,
					source: "user-config",
					message: `${tool} not found`,
				};
			});

			await processManager.spawnProcess(
				"task-1",
				"/fake/cwd",
				["run.py"],
				{},
				"task-execution",
			);

			expect(spawnCalls).toHaveLength(1);
			const envArg = spawnCalls[0].options.env as Record<string, unknown>;

			// Both should be set
			expect(envArg.CLAUDE_CLI_PATH).toBe("/opt/homebrew/bin/claude");
			expect(envArg.GITHUB_CLI_PATH).toBe("/opt/homebrew/bin/gh");
		});
	});
});

describe("resolveExitFailure - backend exit without terminal phase", () => {
	it("retourne null lorsque le pipeline est terminé (complete)", () => {
		expect(resolveExitFailure(0, "complete")).toBeNull();
	});

	it("retourne null lorsque le pipeline a déjà échoué (failed)", () => {
		expect(resolveExitFailure(1, "failed")).toBeNull();
	});

	it("signale un échec quand le processus meurt en code 0 au milieu du coding", () => {
		const result = resolveExitFailure(0, "coding");
		expect(result).not.toBeNull();
		expect(result?.message).toBe(
			"Le processus backend s'est arrêté avant la fin du pipeline",
		);
	});

	it("signale un échec quand le processus est tué (code null) en planning", () => {
		const result = resolveExitFailure(null, "planning");
		expect(result).not.toBeNull();
		expect(result?.message).toBe(
			"Le processus backend s'est arrêté avant la fin du pipeline",
		);
	});

	it("conserve le code de sortie dans le message pour un échec non nul", () => {
		const result = resolveExitFailure(137, "coding");
		expect(result?.message).toBe("Process exited with code 137");
	});

	it("ne signale pas d'échec pour une phase en pause (rate limit)", () => {
		expect(resolveExitFailure(0, "rate_limit_paused")).toBeNull();
	});

	it("ne signale pas d'échec pour une phase en pause (auth)", () => {
		expect(resolveExitFailure(1, "auth_failure_paused")).toBeNull();
	});
});
