/**
 * Cross-Platform Credential Utilities Tests
 *
 * Tests for credential retrieval on macOS, Linux, and Windows platforms.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module
vi.mock("../platform", () => ({
	isMacOS: vi.fn(() => false),
	isWindows: vi.fn(() => false),
	isLinux: vi.fn(() => false),
}));

vi.mock("node:fs", () => {
	const mod = {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => ""),
		mkdirSync: vi.fn(),
		renameSync: vi.fn(),
		unlinkSync: vi.fn(),
		writeFileSync: vi.fn(),
		promises: {},
	};
	return { ...mod, default: mod };
});

vi.mock("node:child_process", () => {
	const execFileSync = vi.fn(() => "");
	const mod = { execFileSync };
	return { ...mod, default: mod };
});

vi.mock("node:os", () => {
	const mod = { homedir: vi.fn(() => "/home/testuser") };
	return { ...mod, default: mod };
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isLinux, isMacOS, isWindows } from "../platform";
// Import after mocks are set up
import {
	calculateConfigDirHash,
	clearCredentialCache,
	clearKeychainCache,
	getCredentials,
	getCredentialsFromKeychain,
	getFullCredentialsFromKeychain,
	getKeychainServiceName,
	getWindowsCredentialTarget,
} from "./credential-utils";

describe("credential-utils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Clear the credential cache before each test
		clearCredentialCache();
	});

	describe("calculateConfigDirHash", () => {
		it("should return first 8 characters of SHA256 hash", () => {
			const configDir = "/home/user/.claude-profiles/work";
			const expectedHash = createHash("sha256")
				.update(configDir)
				.digest("hex")
				.slice(0, 8);
			expect(calculateConfigDirHash(configDir)).toBe(expectedHash);
		});

		it("should return different hashes for different paths", () => {
			const hash1 = calculateConfigDirHash("/path/one");
			const hash2 = calculateConfigDirHash("/path/two");
			expect(hash1).not.toBe(hash2);
		});

		it("should return consistent hash for same path", () => {
			const path = "/home/user/.claude";
			expect(calculateConfigDirHash(path)).toBe(calculateConfigDirHash(path));
		});
	});

	describe("getKeychainServiceName", () => {
		it("should return default service name when no configDir provided", () => {
			expect(getKeychainServiceName()).toBe("Claude Code-credentials");
		});

		it("should return hashed service name for custom configDir", () => {
			const configDir = "/home/user/.claude-profiles/work";
			const hash = calculateConfigDirHash(configDir);
			expect(getKeychainServiceName(configDir)).toBe(
				`Claude Code-credentials-${hash}`,
			);
		});
	});

	describe("getWindowsCredentialTarget", () => {
		it("should use same naming convention as macOS Keychain", () => {
			expect(getWindowsCredentialTarget()).toBe("Claude Code-credentials");

			const configDir = "/home/user/.claude-profiles/work";
			expect(getWindowsCredentialTarget(configDir)).toBe(
				getKeychainServiceName(configDir),
			);
		});
	});

	describe("getCredentialsFromKeychain (macOS)", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(true);
			vi.mocked(isWindows).mockReturnValue(false);
			vi.mocked(isLinux).mockReturnValue(false);
		});

		it("should return credentials from macOS Keychain", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-test-token-123",
						email: "test@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-test-token-123");
			expect(result.email).toBe("test@example.com");
			expect(result.error).toBeUndefined();
		});

		it("should return null when security command not found", () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
			expect(result.error).toBe("macOS security command not found");
		});

		it("should return null for invalid JSON", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue("invalid json");

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
		});

		it("should reject invalid token format", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "invalid-token",
						email: "test@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBe("test@example.com");
		});

		it("should handle exit code 44 (item not found)", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockImplementation(() => {
				const error = new Error("Item not found") as Error & { status: number };
				error.status = 44;
				throw error;
			});

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
			expect(result.error).toBeUndefined();
		});

		it("should use cache on subsequent calls", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-test-token-123",
						email: "test@example.com",
					},
				}),
			);

			// First call
			getCredentialsFromKeychain();
			// Second call should use cache
			getCredentialsFromKeychain();

			expect(execFileSync).toHaveBeenCalledTimes(1);
		});

		it("should bypass cache when forceRefresh is true", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-test-token-123",
						email: "test@example.com",
					},
				}),
			);

			// First call
			getCredentialsFromKeychain();
			// Second call with forceRefresh
			getCredentialsFromKeychain(undefined, true);

			expect(execFileSync).toHaveBeenCalledTimes(2);
		});
	});

	describe("getCredentialsFromKeychain (Linux)", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(false);
			vi.mocked(isWindows).mockReturnValue(false);
			vi.mocked(isLinux).mockReturnValue(true);
			vi.mocked(homedir).mockReturnValue("/home/testuser");
		});

		// Helper to mock Secret Service not available (secret-tool not found)
		const mockSecretServiceUnavailable = () => {
			vi.mocked(existsSync).mockImplementation((path: string | Buffer | URL) => {
				const pathStr = String(path);
				// secret-tool not found
				if (pathStr.includes("secret-tool")) return false;
				// credentials file exists
				if (pathStr.includes(".credentials.json")) return true;
				return false;
			});
		};

		it("should return credentials from Secret Service when available", () => {
			// secret-tool exists and returns credentials
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-secret-service-token",
						email: "secretservice@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-secret-service-token");
			expect(result.email).toBe("secretservice@example.com");
			expect(result.error).toBeUndefined();
		});

		it("should fall back to .credentials.json when Secret Service unavailable", () => {
			mockSecretServiceUnavailable();
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-linux-token-456",
						email: "linux@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-linux-token-456");
			expect(result.email).toBe("linux@example.com");
			expect(result.error).toBeUndefined();
		});

		it("should return null when credentials file not found and Secret Service unavailable", () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
		});

		it("should use custom configDir for credentials path", () => {
			const customConfigDir = "/home/user/.claude-profiles/work";
			mockSecretServiceUnavailable();
			vi.mocked(existsSync).mockImplementation((path: string | Buffer | URL) => {
				const pathStr = String(path);
				if (pathStr.includes("secret-tool")) return false;
				return true; // credentials file exists
			});
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-custom-token",
						email: "custom@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain(customConfigDir);

			expect(existsSync).toHaveBeenCalledWith(
				join(customConfigDir, ".credentials.json"),
			);
			expect(result.token).toBe("sk-ant-custom-token");
		});

		it("should handle emailAddress field (alternative email location)", () => {
			mockSecretServiceUnavailable();
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-test-token",
						emailAddress: "alternative@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.email).toBe("alternative@example.com");
		});

		it("should handle top-level email field", () => {
			mockSecretServiceUnavailable();
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-test-token",
					},
					email: "toplevel@example.com",
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.email).toBe("toplevel@example.com");
		});

		it("should handle file read permission errors", () => {
			mockSecretServiceUnavailable();
			vi.mocked(readFileSync).mockImplementation(() => {
				throw new Error("EACCES: permission denied");
			});

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
		});

		it("should fall back to file when Secret Service lookup fails", () => {
			// secret-tool exists but lookup fails
			vi.mocked(existsSync).mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr.includes("secret-tool")) return true;
				if (pathStr.includes(".credentials.json")) return true;
				return false;
			});
			vi.mocked(execFileSync).mockImplementation(() => {
				throw new Error("secret-tool lookup failed");
			});
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-fallback-token",
						email: "fallback@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-fallback-token");
			expect(result.email).toBe("fallback@example.com");
		});
	});

	describe("getCredentialsFromKeychain (Windows)", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(false);
			vi.mocked(isWindows).mockReturnValue(true);
			vi.mocked(isLinux).mockReturnValue(false);
			vi.mocked(homedir).mockReturnValue("C:\\Users\\TestUser");
		});

		it("should return null when PowerShell not found and no credentials file exists", () => {
			// Neither PowerShell nor credentials file exists
			vi.mocked(existsSync).mockReturnValue(false);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
			// No error because file fallback returns null gracefully when file doesn't exist
		});

		it("should return credentials from Windows Credential Manager when file is empty", () => {
			// Mock PowerShell path found, but credentials file doesn't exist
			vi.mocked(existsSync).mockImplementation((path: unknown) => {
				const pathStr = String(path);
				// PowerShell exists, but credentials file doesn't
				return pathStr.includes("PowerShell") || pathStr.includes("powershell");
			});
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-windows-token-789",
						email: "windows@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-windows-token-789");
			expect(result.email).toBe("windows@example.com");
		});

		it("should fall back to file when Credential Manager returns empty", () => {
			// Mock PowerShell exists but returns empty (no credential in Credential Manager)
			// Mock file exists with valid credentials
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue(""); // Credential Manager empty
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-file-fallback-token",
						email: "file@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-file-fallback-token");
			expect(result.email).toBe("file@example.com");
		});

		it("should return null when both Credential Manager and file have no credentials", () => {
			// Mock PowerShell exists but returns empty
			// Mock credentials file doesn't exist
			vi.mocked(existsSync).mockImplementation((path: unknown) => {
				const pathStr = String(path);
				// PowerShell exists, but credentials file doesn't
				return pathStr.includes("PowerShell") || pathStr.includes("powershell");
			});
			vi.mocked(execFileSync).mockReturnValue(""); // Credential Manager empty

			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
		});

		it("should handle invalid JSON from Credential Manager by falling back to file", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue("invalid json"); // Invalid JSON from Credential Manager
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-file-token-after-cm-failure",
						email: "fallback@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			// Should fall back to file and get valid credentials
			expect(result.token).toBe("sk-ant-file-token-after-cm-failure");
			expect(result.email).toBe("fallback@example.com");
		});

		it("should prefer file credentials when both sources have tokens", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-windows-file-token",
						email: "windowsfile@example.com",
					},
				}),
			);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-credman-token",
						email: "credman@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			// Should prefer file since Claude CLI writes there after login
			expect(result.token).toBe("sk-ant-windows-file-token");
			expect(result.email).toBe("windowsfile@example.com");
		});

		it("should NOT spawn PowerShell (Credential Manager) when the file already has a token", () => {
			// Regression guard for the startup-freeze fix: reading the Windows
			// Credential Manager spawns PowerShell + Add-Type synchronously, which
			// blocks the Electron main process. When the file already has a valid
			// token (the common case — Claude CLI writes there on login) we must
			// return it WITHOUT touching the Credential Manager.
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-file-only-token",
						email: "fileonly@example.com",
					},
				}),
			);

			const result = getCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-file-only-token");
			// The whole point of the fix: no synchronous PowerShell spawn.
			expect(execFileSync).not.toHaveBeenCalled();
		});
	});

	describe("getFullCredentialsFromKeychain (Windows)", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(false);
			vi.mocked(isWindows).mockReturnValue(true);
			vi.mocked(isLinux).mockReturnValue(false);
			vi.mocked(homedir).mockReturnValue("C:\\Users\\TestUser");
			clearCredentialCache();
		});

		it("should return full credentials from file when available", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-full-creds-token",
						refreshToken: "refresh-token-123",
						expiresAt: 1700000000000,
						email: "full@example.com",
						scopes: ["user:read", "user:write"],
					},
				}),
			);
			vi.mocked(execFileSync).mockReturnValue(""); // Credential Manager empty

			const result = getFullCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-full-creds-token");
			expect(result.refreshToken).toBe("refresh-token-123");
			expect(result.expiresAt).toBe(1700000000000);
			expect(result.email).toBe("full@example.com");
			expect(result.scopes).toEqual(["user:read", "user:write"]);
		});

		it("should return credentials from Credential Manager when file is empty", () => {
			vi.mocked(existsSync).mockImplementation((path: unknown) => {
				const pathStr = String(path);
				return pathStr.includes("PowerShell") || pathStr.includes("powershell");
			});
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-credman-full-token",
						refreshToken: "credman-refresh",
						expiresAt: 1700000000000,
						email: "credman@example.com",
					},
				}),
			);

			const result = getFullCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-credman-full-token");
			expect(result.refreshToken).toBe("credman-refresh");
			expect(result.email).toBe("credman@example.com");
		});

		it("should prefer file credentials when both sources have tokens (consistent with basic API)", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-file-full-token",
						refreshToken: "file-refresh",
						expiresAt: 1700000000000,
						email: "file@example.com",
					},
				}),
			);
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-credman-full-token",
						refreshToken: "credman-refresh",
						expiresAt: 1800000000000, // Later expiry
						email: "credman@example.com",
					},
				}),
			);

			const result = getFullCredentialsFromKeychain();

			// Should prefer file since Claude CLI writes there after login
			// This is consistent with getCredentialsFromKeychain behavior
			expect(result.token).toBe("sk-ant-file-full-token");
			expect(result.refreshToken).toBe("file-refresh");
			expect(result.email).toBe("file@example.com");
		});

		it("should NOT spawn PowerShell (Credential Manager) when the file already has a token", () => {
			// Regression guard for the startup-freeze fix. The full-credentials
			// Credential Manager path is UNCACHED, so without this short-circuit
			// every token-refresh cycle re-spawns PowerShell + Add-Type and
			// re-freezes the main process. File token present => no subprocess.
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "sk-ant-file-full-only-token",
						refreshToken: "file-only-refresh",
						expiresAt: 1700000000000,
						email: "fullfileonly@example.com",
					},
				}),
			);

			const result = getFullCredentialsFromKeychain();

			expect(result.token).toBe("sk-ant-file-full-only-token");
			expect(result.refreshToken).toBe("file-only-refresh");
			expect(execFileSync).not.toHaveBeenCalled();
		});

		it("should return null when both sources have no credentials", () => {
			vi.mocked(existsSync).mockImplementation((path: unknown) => {
				const pathStr = String(path);
				return pathStr.includes("PowerShell") || pathStr.includes("powershell");
			});
			vi.mocked(execFileSync).mockReturnValue("");

			const result = getFullCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.refreshToken).toBeNull();
		});
	});

	describe("getCredentialsFromKeychain (unsupported platform)", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(false);
			vi.mocked(isWindows).mockReturnValue(false);
			vi.mocked(isLinux).mockReturnValue(false);
		});

		it("should return error for unsupported platform", () => {
			const result = getCredentialsFromKeychain();

			expect(result.token).toBeNull();
			expect(result.email).toBeNull();
			expect(result.error).toContain("Unsupported platform");
		});
	});

	describe("getCredentials alias", () => {
		it("should be an alias for getCredentialsFromKeychain", () => {
			expect(getCredentials).toBe(getCredentialsFromKeychain);
		});
	});

	describe("clearKeychainCache", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(true);
			vi.mocked(existsSync).mockReturnValue(true);
		});

		it("should clear all caches when no configDir provided", () => {
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: { accessToken: "sk-ant-test", email: "test@test.com" },
				}),
			);

			// Prime the cache
			getCredentialsFromKeychain();
			expect(execFileSync).toHaveBeenCalledTimes(1);

			// Clear cache
			clearKeychainCache();

			// Should fetch again
			getCredentialsFromKeychain();
			expect(execFileSync).toHaveBeenCalledTimes(2);
		});

		it("should clear specific profile cache when configDir provided", () => {
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: { accessToken: "sk-ant-test", email: "test@test.com" },
				}),
			);

			const configDir = "/custom/path";

			// Prime the cache
			getCredentialsFromKeychain(configDir);
			expect(execFileSync).toHaveBeenCalledTimes(1);

			// Clear specific cache
			clearKeychainCache(configDir);

			// Should fetch again
			getCredentialsFromKeychain(configDir);
			expect(execFileSync).toHaveBeenCalledTimes(2);
		});
	});

	describe("clearCredentialCache alias", () => {
		it("should be an alias for clearKeychainCache", () => {
			expect(clearCredentialCache).toBe(clearKeychainCache);
		});
	});

	describe("token validation", () => {
		beforeEach(() => {
			vi.mocked(isMacOS).mockReturnValue(true);
			vi.mocked(existsSync).mockReturnValue(true);
		});

		it("should accept tokens starting with sk-ant-", () => {
			const validTokens = [
				"sk-ant-oat01-test",
				"sk-ant-oat02-test",
				"sk-ant-api-key",
			];

			for (const token of validTokens) {
				clearCredentialCache();
				vi.mocked(execFileSync).mockReturnValue(
					JSON.stringify({
						claudeAiOauth: { accessToken: token, email: "test@test.com" },
					}),
				);

				const result = getCredentialsFromKeychain();
				expect(result.token).toBe(token);
			}
		});

		it("should reject tokens not starting with sk-ant-", () => {
			const invalidTokens = ["invalid-token", "sk-api-key", "api-key-123"];

			for (const token of invalidTokens) {
				clearCredentialCache();
				vi.mocked(execFileSync).mockReturnValue(
					JSON.stringify({
						claudeAiOauth: { accessToken: token, email: "test@test.com" },
					}),
				);

				const result = getCredentialsFromKeychain();
				expect(result.token).toBeNull();
			}
		});

		it("should reject empty token string", () => {
			clearCredentialCache();
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					claudeAiOauth: { accessToken: "", email: "test@test.com" },
				}),
			);

			const result = getCredentialsFromKeychain();
			expect(result.token).toBeNull();
			expect(result.email).toBe("test@test.com");
		});
	});
});
