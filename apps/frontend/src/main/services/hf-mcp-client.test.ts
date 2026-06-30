/**
 * Unit tests for the Hugging Face MCP client result parser and the marketplace
 * catalog entry. These are offline: no MCP server is contacted (the parser is a
 * pure function; the SDK import lives inside searchHuggingFaceModels()).
 */

import { describe, expect, it } from "vitest";
import { buildCatalog } from "../ipc-handlers/mcp-marketplace-handlers";
import { parseModelSearchResult } from "./hf-mcp-client";

describe("parseModelSearchResult", () => {
	it("parses an MCP tool result with a JSON array in a text block", () => {
		const result = {
			content: [
				{
					type: "text",
					text: JSON.stringify([
						{
							id: "Qwen/Qwen2.5-Coder-7B-Instruct",
							downloads: 1234567,
							likes: 42,
							pipeline_tag: "text-generation",
						},
						{ modelId: "meta-llama/Llama-3.1-8B-Instruct", downloads: 999 },
					]),
				},
			],
		};
		const models = parseModelSearchResult(result);
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			id: "Qwen/Qwen2.5-Coder-7B-Instruct",
			downloads: 1234567,
			likes: 42,
			pipelineTag: "text-generation",
			url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct",
		});
		expect(models[1].id).toBe("meta-llama/Llama-3.1-8B-Instruct");
		expect(models[1].url).toBe(
			"https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct",
		);
	});

	it("unwraps a { models: [...] } container", () => {
		const models = parseModelSearchResult({
			models: [{ id: "mistralai/Mistral-7B-Instruct-v0.3" }],
		});
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("mistralai/Mistral-7B-Instruct-v0.3");
	});

	it("falls back to scanning markdown for owner/name ids", () => {
		const result = {
			content: [
				{
					type: "text",
					text: "Top models:\n- TheBloke/Llama-2-7B-GGUF\n- google/gemma-2-9b",
				},
			],
		};
		const models = parseModelSearchResult(result);
		const ids = models.map((m) => m.id);
		expect(ids).toContain("TheBloke/Llama-2-7B-GGUF");
		expect(ids).toContain("google/gemma-2-9b");
	});

	it("accepts an already-parsed array of strings", () => {
		const models = parseModelSearchResult(["owner/model-a", "owner/model-b"]);
		expect(models.map((m) => m.id)).toEqual(["owner/model-a", "owner/model-b"]);
	});

	it("returns an empty list for null / unrecognized input", () => {
		expect(parseModelSearchResult(null)).toEqual([]);
		expect(parseModelSearchResult({ foo: "bar" })).toEqual([]);
		expect(parseModelSearchResult({ content: [] })).toEqual([]);
	});

	it("coerces comma-formatted download counts", () => {
		const models = parseModelSearchResult([
			{ id: "a/b", downloads: "1,234,567" },
		]);
		expect(models[0].downloads).toBe(1234567);
	});

	it("parses the hub_repo_search markdown into rich model rows", () => {
		const md = [
			'Found 2 repositories across models matching query "qwen".',
			"",
			"## Models (2)",
			"",
			"### Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
			"",
			"**Task:** text-generation | **Library:** gguf | **Downloads:** 4.1M | **Likes:** 2110 | **Trending Score:** 196",
			"",
			"**Tags:** gguf, conversational, license:apache-2.0",
			"",
			"**Created:** 17 Apr, 2026",
			"**Link:** [https://hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF](https://hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF)",
			"",
			"---",
			"",
			"### meta-llama/Llama-3.1-8B-Instruct",
			"",
			"**Task:** text-generation | **Downloads:** 52.8K | **Likes:** 106",
			"",
			"**Created:** 2 Jun, 2026",
			"**Link:** [https://hf.co/meta-llama/Llama-3.1-8B-Instruct](https://hf.co/meta-llama/Llama-3.1-8B-Instruct)",
			"",
			"---",
		].join("\n");
		const models = parseModelSearchResult({
			content: [{ type: "text", text: md }],
		});
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
			downloads: 4_100_000,
			likes: 2110,
			pipelineTag: "text-generation",
			library: "gguf",
			url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
		});
		expect(models[1].id).toBe("meta-llama/Llama-3.1-8B-Instruct");
		expect(models[1].downloads).toBe(52_800);
		expect(models[1].likes).toBe(106);
		expect(models[1].pipelineTag).toBe("text-generation");
		expect(models[1].library).toBeUndefined();
	});
});

describe("MCP marketplace catalog — Hugging Face entry", () => {
	it("registers the Hugging Face MCP server (http transport)", () => {
		const hf = buildCatalog().find((s) => s.id === "huggingface");
		expect(hf).toBeDefined();
		expect(hf?.transport).toBe("http");
		expect(hf?.url).toBe("https://huggingface.co/mcp");
		// Exposes a model-search tool the agent can use.
		expect(hf?.tools.some((t) => t.name === "hub_repo_search")).toBe(true);
	});
});
