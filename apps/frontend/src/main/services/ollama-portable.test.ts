import { describe, expect, it } from "vitest";
import { _internal, ollamaReleaseAsset } from "./ollama-portable";

describe("ollamaReleaseAsset", () => {
	it("maps Windows x64/arm64 to the .zip assets", () => {
		expect(ollamaReleaseAsset("win32", "x64")).toBe("ollama-windows-amd64.zip");
		expect(ollamaReleaseAsset("win32", "arm64")).toBe(
			"ollama-windows-arm64.zip",
		);
	});

	it("maps macOS (any arch) to the universal darwin tgz", () => {
		expect(ollamaReleaseAsset("darwin", "x64")).toBe("ollama-darwin.tgz");
		expect(ollamaReleaseAsset("darwin", "arm64")).toBe("ollama-darwin.tgz");
	});

	it("maps Linux x64/arm64 to the .tgz assets", () => {
		expect(ollamaReleaseAsset("linux", "x64")).toBe("ollama-linux-amd64.tgz");
		expect(ollamaReleaseAsset("linux", "arm64")).toBe("ollama-linux-arm64.tgz");
	});

	it("returns null for unsupported platforms", () => {
		expect(ollamaReleaseAsset("aix" as NodeJS.Platform, "x64")).toBeNull();
	});
});

describe("ollamaHostFromUrl", () => {
	const f = _internal.ollamaHostFromUrl;

	it("rewrites localhost to 127.0.0.1 and keeps the port", () => {
		expect(f("http://localhost:11434")).toBe("127.0.0.1:11434");
		expect(f("http://localhost:1234")).toBe("127.0.0.1:1234");
	});

	it("defaults the port to 11434 when absent", () => {
		expect(f("http://127.0.0.1")).toBe("127.0.0.1:11434");
	});

	it("preserves a non-localhost host", () => {
		expect(f("http://192.168.1.50:11434")).toBe("192.168.1.50:11434");
	});

	it("falls back to the default on an unparseable URL", () => {
		expect(f("not-a-url")).toBe("127.0.0.1:11434");
	});
});
