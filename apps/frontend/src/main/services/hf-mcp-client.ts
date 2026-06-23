/**
 * Hugging Face MCP client (main process)
 * ======================================
 *
 * Thin client that talks to the official Hugging Face MCP server
 * (https://huggingface.co/mcp, Streamable HTTP transport) to power the
 * "Discover models" UI panel with a live view of the Hub.
 *
 * The @modelcontextprotocol/sdk import is dynamic and resolved through a string
 * specifier so the bundler/typechecker doesn't hard-fail before the dependency
 * is installed (`pnpm install`). The result-parsing logic is exported
 * separately as a pure function for unit testing without the SDK.
 */

import type { IPCResult } from "../../shared/types/common";
import type {
	HuggingFaceModelInfo,
	HuggingFaceModelSearchParams,
} from "../../shared/types/mcp-marketplace";
import { appLog } from "../app-logger";

const HF_MCP_URL = "https://huggingface.co/mcp";

/** Names we accept for the Hub model-search tool, in priority order. */
const MODEL_SEARCH_TOOL_NAMES = [
	// Modern HF MCP: a single unified models/datasets/spaces search tool.
	"hub_repo_search",
	// Older HF MCP deployments exposed a dedicated model search.
	"model_search",
	"hf_model_search",
	"search_models",
	"models_search",
];

function hubUrlFor(id: string): string {
	return `https://huggingface.co/${id}`;
}

function coerceNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value.replace(/[, ]/g, ""));
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function normalizeModelObject(
	obj: Record<string, unknown>,
): HuggingFaceModelInfo | null {
	const id =
		(obj.id as string) ||
		(obj.modelId as string) ||
		(obj.model_id as string) ||
		(obj.name as string) ||
		(obj.repo_id as string) ||
		"";
	if (!id || typeof id !== "string") return null;
	const pipelineTag =
		(obj.pipelineTag as string) ||
		(obj.pipeline_tag as string) ||
		(obj.task as string) ||
		undefined;
	return {
		id,
		downloads: coerceNumber(obj.downloads ?? obj.downloadsAllTime),
		likes: coerceNumber(obj.likes),
		pipelineTag,
		url: typeof obj.url === "string" ? obj.url : hubUrlFor(id),
	};
}

/**
 * Parse an MCP tool result (or already-parsed payload) into a normalized list
 * of models. Defensive by design: the HF MCP may return a JSON array, a
 * `{ models: [...] }` object, or markdown text — all are handled, and anything
 * unrecognized yields an empty list rather than throwing.
 */
export function parseModelSearchResult(raw: unknown): HuggingFaceModelInfo[] {
	if (raw == null) return [];

	// 1) Extract the text payload from the MCP tool-result shape, if present.
	let payload: unknown = raw;
	let text = "";
	if (
		typeof raw === "object" &&
		raw !== null &&
		Array.isArray((raw as { content?: unknown }).content)
	) {
		const blocks = (raw as { content: Array<Record<string, unknown>> }).content;
		text = blocks
			.filter((b) => b && (b.type === "text" || typeof b.text === "string"))
			.map((b) => String(b.text ?? ""))
			.join("\n")
			.trim();
		payload = tryParseJson(text);
	} else if (typeof raw === "string") {
		text = raw;
		payload = tryParseJson(raw);
	}

	// 2) Prefer structured JSON, unwrapping common container shapes.
	let items: unknown[] = [];
	if (Array.isArray(payload)) {
		items = payload;
	} else if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		const container = obj.models ?? obj.results ?? obj.data ?? obj.items;
		if (Array.isArray(container)) items = container;
	}

	if (items.length > 0) {
		const out: HuggingFaceModelInfo[] = [];
		for (const item of items) {
			if (typeof item === "string") {
				const m = normalizeModelObject({ id: item });
				if (m) out.push(m);
			} else if (item && typeof item === "object") {
				const m = normalizeModelObject(item as Record<string, unknown>);
				if (m) out.push(m);
			}
		}
		return out;
	}

	// 3) No structured payload: parse the markdown that `hub_repo_search`
	//    returns (### owner/name blocks with rich metadata), then fall back to
	//    a crude id scan for older/plainer text shapes.
	if (text) {
		const rich = parseHubMarkdown(text);
		if (rich.length > 0) return rich;
		return markdownIdsToModels(text);
	}
	return [];
}

function tryParseJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Extract `owner/name` repo ids from markdown/plain text as a last resort. */
function markdownIdsToModels(text: string): HuggingFaceModelInfo[] {
	if (!text) return [];
	const ids = new Set<string>();
	const re = /([A-Za-z0-9][\w.-]+\/[\w.-]+)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = re.exec(text)) !== null) {
		ids.add(match[1]);
	}
	return [...ids].map((id) => ({ id, url: hubUrlFor(id) }));
}

/** Pull a `**Label:** value` field (pipe/newline-delimited) from a block. */
function markdownField(block: string, label: string): string | undefined {
	const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^|\\n]+)`);
	const value = block.match(re)?.[1]?.trim();
	return value || undefined;
}

/** Parse a human-formatted count ("4.1M", "52.8K", "2,110") into a number. */
function parseHumanCount(value?: string): number | undefined {
	if (!value) return undefined;
	const m = value.trim().match(/^([\d.,]+)\s*([KkMmBb])?/);
	if (!m) return undefined;
	let n = Number(m[1].replace(/,/g, ""));
	if (!Number.isFinite(n)) return undefined;
	switch ((m[2] || "").toLowerCase()) {
		case "k":
			n *= 1e3;
			break;
		case "m":
			n *= 1e6;
			break;
		case "b":
			n *= 1e9;
			break;
	}
	return Math.round(n);
}

/**
 * Parse the markdown document returned by `hub_repo_search` into models. Each
 * repo is a `### owner/name` heading followed by a metadata line of the form
 * `**Task:** … | **Library:** … | **Downloads:** … | **Likes:** …`. Returns []
 * when the text isn't in this shape so the caller can fall back to an id scan.
 */
function parseHubMarkdown(text: string): HuggingFaceModelInfo[] {
	if (!text.includes("### ")) return [];
	const out: HuggingFaceModelInfo[] = [];
	const seen = new Set<string>();
	// Lead with a newline so a heading at offset 0 is also a valid split point.
	const blocks = `\n${text}`.split(/\n###\s+/);
	for (let i = 1; i < blocks.length; i++) {
		const block = blocks[i];
		const firstLine = (block.split("\n", 1)[0] ?? "").trim();
		const id = firstLine.split(/\s/)[0] ?? "";
		// Repo ids are exactly "owner/name" — skip section headers and noise.
		if (!/^[^/\s]+\/[^/\s]+$/.test(id) || seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			downloads: parseHumanCount(markdownField(block, "Downloads")),
			likes: parseHumanCount(markdownField(block, "Likes")),
			pipelineTag: markdownField(block, "Task"),
			library: markdownField(block, "Library"),
			url: hubUrlFor(id),
		});
	}
	return out;
}

/** Map a UI sort key to the `hub_repo_search` enum value. */
function mapHubSort(sort?: string): string | undefined {
	switch (sort) {
		case "trending":
			return "trendingScore";
		case "downloads":
			return "downloads";
		case "likes":
			return "likes";
		case "created":
			return "createdAt";
		case "modified":
			return "lastModified";
		default:
			return undefined;
	}
}

/**
 * Build the tool arguments for the selected HF search tool. The modern HF MCP
 * exposes `hub_repo_search` (unified models/datasets/spaces) whose filters are
 * plain hub tags; older deployments used `model_search` with discrete fields.
 *
 * Filter-tag formats are quirky and verified against the LIVE server — the
 * tool's own JSON-schema docs are partly wrong (they suggest `library:gguf` and
 * `language:fr`, neither of which match anything):
 *   task / library / language → bare tags ("text-generation", "gguf", "en")
 *   license                   → prefixed ("license:apache-2.0")
 */
function buildSearchArgs(
	toolName: string,
	p: {
		query: string;
		task?: string;
		library?: string;
		language?: string;
		license?: string;
		author?: string;
		sort?: string;
		limit: number;
	},
): Record<string, unknown> {
	if (toolName === "hub_repo_search") {
		const filters: string[] = [];
		if (p.task) filters.push(p.task);
		if (p.library) filters.push(p.library);
		if (p.language) filters.push(p.language);
		if (p.license) filters.push(`license:${p.license}`);
		const args: Record<string, unknown> = {
			repo_types: ["model"],
			limit: p.limit,
		};
		if (p.query) args.query = p.query;
		if (filters.length) args.filters = filters;
		if (p.author) args.author = p.author;
		const sort = mapHubSort(p.sort);
		if (sort) args.sort = sort;
		return args;
	}
	// Legacy model_search-style tools: discrete fields, UI-level sort keys.
	const args: Record<string, unknown> = { limit: p.limit };
	if (p.query) args.query = p.query;
	if (p.task) args.task = p.task;
	if (p.sort) args.sort = p.sort;
	return args;
}

/**
 * Search the Hugging Face Hub for models via the HF MCP server.
 * Returns a normalized list, or an error result that the UI can surface.
 */
export async function searchHuggingFaceModels(
	params: HuggingFaceModelSearchParams = {},
): Promise<IPCResult<HuggingFaceModelInfo[]>> {
	const {
		query = "",
		task = "text-generation",
		library,
		language,
		license,
		author,
		sort,
		limit = 30,
		token,
	} = params;

	// The MCP SDK is imported dynamically (string specifier) and is therefore
	// untyped here; `any` is intentional for this thin glue client.
	// biome-ignore lint/suspicious/noExplicitAny: dynamically imported SDK
	let client: any = null;
	try {
		// Dynamic, string-specifier imports so the typechecker/bundler doesn't
		// hard-require the package before `pnpm install` has fetched it.
		const clientModPath = "@modelcontextprotocol/sdk/client/index.js";
		const httpModPath = "@modelcontextprotocol/sdk/client/streamableHttp.js";
		const { Client } = await import(clientModPath);
		const { StreamableHTTPClientTransport } = await import(httpModPath);

		const requestInit = token
			? { headers: { Authorization: `Bearer ${token}` } }
			: undefined;
		const transport = new StreamableHTTPClientTransport(new URL(HF_MCP_URL), {
			requestInit,
		});

		client = new Client(
			{ name: "workpilot-hf-discovery", version: "1.0.0" },
			{ capabilities: {} },
		);
		await client.connect(transport);

		// Discover the model-search tool (name varies across HF MCP versions).
		const toolList = await client.listTools();
		const tools: Array<{ name: string }> = toolList?.tools ?? [];
		const tool =
			tools.find((t) => MODEL_SEARCH_TOOL_NAMES.includes(t.name)) ??
			tools.find((t) =>
				/(?:model|repo).*search|search.*(?:model|repo)/i.test(t.name),
			);
		if (!tool) {
			return {
				success: false,
				error: "Hugging Face MCP exposes no model-search tool.",
			};
		}

		const args = buildSearchArgs(tool.name, {
			query,
			task,
			library,
			language,
			license,
			author,
			sort,
			limit,
		});

		const result = await client.callTool({ name: tool.name, arguments: args });
		if (result?.isError) {
			return { success: false, error: "Hugging Face MCP returned an error." };
		}
		const models = parseModelSearchResult(result).slice(0, limit);
		return { success: true, data: models };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		appLog.error("[HF MCP] model search failed:", message);
		return {
			success: false,
			error: `Hugging Face MCP unreachable: ${message}`,
		};
	} finally {
		try {
			await client?.close();
		} catch {
			/* best-effort */
		}
	}
}
