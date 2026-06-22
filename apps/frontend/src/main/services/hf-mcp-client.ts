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

	// 1) MCP tool-result shape: { content: [{ type: "text", text }] }
	let payload: unknown = raw;
	if (
		typeof raw === "object" &&
		raw !== null &&
		Array.isArray((raw as { content?: unknown }).content)
	) {
		const blocks = (raw as { content: Array<Record<string, unknown>> }).content;
		const text = blocks
			.filter((b) => b && (b.type === "text" || typeof b.text === "string"))
			.map((b) => String(b.text ?? ""))
			.join("\n")
			.trim();
		// Prefer structured JSON in the text; fall back to markdown line scan.
		const parsed = tryParseJson(text);
		payload = parsed ?? markdownIdsToModels(text);
	} else if (typeof raw === "string") {
		payload = tryParseJson(raw) ?? markdownIdsToModels(raw);
	}

	// 2) Unwrap common container shapes.
	let items: unknown[] = [];
	if (Array.isArray(payload)) {
		items = payload;
	} else if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		const container = obj.models ?? obj.results ?? obj.data ?? obj.items;
		if (Array.isArray(container)) items = container;
	}

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

/**
 * Search the Hugging Face Hub for models via the HF MCP server.
 * Returns a normalized list, or an error result that the UI can surface.
 */
export async function searchHuggingFaceModels(
	params: HuggingFaceModelSearchParams = {},
): Promise<IPCResult<HuggingFaceModelInfo[]>> {
	const { query = "", task = "text-generation", sort, limit = 30, token } =
		params;

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
			tools.find((t) => /model.*search|search.*model/i.test(t.name));
		if (!tool) {
			return {
				success: false,
				error: "Hugging Face MCP exposes no model-search tool.",
			};
		}

		const args: Record<string, unknown> = { limit };
		if (query) args.query = query;
		if (task) args.task = task;
		if (sort) args.sort = sort;

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
