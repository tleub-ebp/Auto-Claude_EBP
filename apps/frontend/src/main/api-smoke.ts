import { writeFileSync } from "node:fs";
import path from "node:path";
import type {
	ApiSmokeEndpointResult,
	VisualProofApiSmoke,
} from "../shared/types";
import { logger } from "./app-logger";

const SPEC_CANDIDATE_PATHS = [
	"/swagger/v1/swagger.json",
	"/swagger/v2/swagger.json",
	"/openapi.json",
	"/swagger.json",
	"/v3/api-docs",
	"/api-docs",
	"/api/openapi.json",
] as const;

const SWAGGER_UI_CANDIDATE_PATHS = [
	"/swagger",
	"/swagger/index.html",
	"/docs",
	"/redoc",
	"/api-docs/index.html",
] as const;

const PROBE_TIMEOUT_MS = 5000;
const ENDPOINT_TIMEOUT_MS = 10000;
const MAX_SMOKED_ENDPOINTS = 15;
export const API_SMOKE_REPORT_FILE = "api-smoke-report.md";

interface OpenApiParameter {
	required?: boolean;
	in?: string;
}

interface OpenApiOperation {
	parameters?: OpenApiParameter[];
	deprecated?: boolean;
}

interface OpenApiDocument {
	openapi?: string;
	swagger?: string;
	basePath?: string;
	paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
}

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe the running app for an OpenAPI/Swagger document at the usual
 * locations (ASP.NET Core, FastAPI, springdoc, express-swagger...).
 */
export async function discoverOpenApiSpec(
	baseUrl: string,
): Promise<{ specUrl: string; document: OpenApiDocument } | null> {
	for (const candidate of SPEC_CANDIDATE_PATHS) {
		const specUrl = new URL(candidate, baseUrl).toString();
		try {
			const response = await fetchWithTimeout(specUrl, PROBE_TIMEOUT_MS);
			if (!response.ok) continue;
			const document = (await response.json()) as OpenApiDocument;
			if (
				(document.openapi || document.swagger) &&
				document.paths &&
				typeof document.paths === "object"
			) {
				return { specUrl, document };
			}
		} catch {
			// Not an API or endpoint absent - try the next candidate
		}
	}
	return null;
}

/** Find a Swagger/OpenAPI UI page worth screenshotting, if any. */
export async function discoverSwaggerUiUrl(
	baseUrl: string,
): Promise<string | null> {
	for (const candidate of SWAGGER_UI_CANDIDATE_PATHS) {
		const uiUrl = new URL(candidate, baseUrl).toString();
		try {
			const response = await fetchWithTimeout(uiUrl, PROBE_TIMEOUT_MS);
			const contentType = response.headers.get("content-type") ?? "";
			if (response.ok && contentType.includes("html")) {
				return uiUrl;
			}
		} catch {
			// Keep probing
		}
	}
	return null;
}

function isOperation(value: unknown): value is OpenApiOperation {
	return typeof value === "object" && value !== null;
}

/**
 * Select the GET endpoints that can be called without crafting inputs:
 * no path template, no required parameter. Capped to keep the proof fast.
 */
export function selectSmokeableEndpoints(
	document: OpenApiDocument,
): Array<{ method: string; path: string }> {
	const endpoints: Array<{ method: string; path: string }> = [];
	const basePath = document.basePath ?? "";
	for (const [rawPath, operations] of Object.entries(document.paths ?? {})) {
		if (rawPath.includes("{")) continue;
		const operation = operations?.get ?? operations?.GET;
		if (!isOperation(operation)) continue;
		if (operation.deprecated) continue;
		const hasRequiredParam = (operation.parameters ?? []).some(
			(parameter) => parameter?.required === true,
		);
		if (hasRequiredParam) continue;
		endpoints.push({ method: "GET", path: `${basePath}${rawPath}` });
		if (endpoints.length >= MAX_SMOKED_ENDPOINTS) break;
	}
	return endpoints;
}

async function callEndpoint(
	baseUrl: string,
	endpoint: { method: string; path: string },
): Promise<ApiSmokeEndpointResult> {
	const url = new URL(endpoint.path, baseUrl).toString();
	const startedAt = Date.now();
	try {
		const response = await fetchWithTimeout(url, ENDPOINT_TIMEOUT_MS);
		return {
			method: endpoint.method,
			path: endpoint.path,
			status: response.status,
			// 2xx/3xx pass; 401/403 count as alive-but-protected (still a pass:
			// the endpoint responded and auth is out of scope for a smoke proof)
			ok:
				response.status < 400 ||
				response.status === 401 ||
				response.status === 403,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		return {
			method: endpoint.method,
			path: endpoint.path,
			ok: false,
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function buildApiSmokeReport(
	smoke: VisualProofApiSmoke,
	baseUrl: string,
): string {
	const lines = [
		"# API smoke report",
		"",
		`Base URL: ${baseUrl}`,
		`OpenAPI document: ${smoke.specUrl}`,
		smoke.swaggerUiUrl ? `Swagger UI: ${smoke.swaggerUiUrl}` : undefined,
		"",
		`Result: **${smoke.passed}/${smoke.attempted} endpoints passed**`,
		"",
		"| Endpoint | Status | Time | Result |",
		"| --- | --- | --- | --- |",
		...smoke.results.map(
			(result) =>
				`| \`${result.method} ${result.path}\` | ${
					result.status ?? "—"
				} | ${result.durationMs} ms | ${
					result.ok ? "✅" : `❌ ${result.error ?? ""}`.trim()
				} |`,
		),
		"",
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

/**
 * Run the API smoke proof against a started app: discover the OpenAPI
 * document, call the parameterless GET endpoints, and write a markdown
 * report into the artifact directory.
 *
 * Returns null when the app does not expose an OpenAPI document — callers
 * treat the proof as not applicable (pure front-ends, desktop apps...).
 * Never throws: the smoke proof is a best-effort complement to screenshots.
 */
export async function runApiSmokeProof(
	baseUrl: string,
	artifactDir: string,
): Promise<VisualProofApiSmoke | null> {
	try {
		const discovered = await discoverOpenApiSpec(baseUrl);
		if (!discovered) return null;

		const swaggerUiUrl = (await discoverSwaggerUiUrl(baseUrl)) ?? undefined;
		const endpoints = selectSmokeableEndpoints(discovered.document);
		const results: ApiSmokeEndpointResult[] = [];
		for (const endpoint of endpoints) {
			results.push(await callEndpoint(baseUrl, endpoint));
		}

		const smoke: VisualProofApiSmoke = {
			specUrl: discovered.specUrl,
			swaggerUiUrl,
			attempted: results.length,
			passed: results.filter((result) => result.ok).length,
			failed: results.filter((result) => !result.ok).length,
			results,
			reportFileName: API_SMOKE_REPORT_FILE,
		};

		try {
			writeFileSync(
				path.join(artifactDir, API_SMOKE_REPORT_FILE),
				buildApiSmokeReport(smoke, baseUrl),
				"utf-8",
			);
		} catch (writeError) {
			logger.warn("[ApiSmoke] Could not write report:", writeError);
		}

		return smoke;
	} catch (error) {
		logger.warn("[ApiSmoke] Smoke proof failed:", error);
		return null;
	}
}
