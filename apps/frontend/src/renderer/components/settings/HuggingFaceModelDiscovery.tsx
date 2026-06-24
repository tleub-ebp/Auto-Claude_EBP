/**
 * HuggingFaceModelDiscovery
 * =========================
 *
 * A live "Discover models" panel backed by the official Hugging Face MCP
 * server (via window.electronAPI.searchHuggingFaceModels → main → HF MCP).
 *
 * Click a row to set the provider's default model to `hf.co/<id>`; "Download &
 * start" launches Ollama and pulls the GGUF repo locally. A copy button yields
 * the equivalent `ollama pull` command.
 *
 * The filter bar mirrors the facets on https://huggingface.co/models (task,
 * library, language, license, sort). Parameter-size filtering is intentionally
 * absent: the HF MCP `hub_repo_search` tool exposes no size facet.
 */

import {
	AlertCircle,
	Check,
	CircleCheck,
	Copy,
	Download,
	ExternalLink,
	Heart,
	Loader2,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HuggingFaceModelInfo } from "../../../shared/types/mcp-marketplace";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface HuggingFaceModelDiscoveryProps {
	className?: string;
	/** Optional HF read token (raises rate limits, unlocks gated repos). */
	hfToken?: string;
	/** Currently-selected default model (to highlight the active row). */
	selectedModel?: string;
	/**
	 * Configured local server URL (Ollama). Used to start the server on the right
	 * port and pull the model into the right instance. Defaults to localhost:11434.
	 */
	baseUrl?: string;
	/**
	 * Called when the user picks a model. Receives the local-runnable name
	 * (`hf.co/<id>` — the id Ollama uses after `ollama pull hf.co/<id>`), which
	 * the parent stores as the provider's default model.
	 */
	onSelectModel?: (model: string) => void;
}

/** Stages of the "make this model actually runnable locally" pipeline. */
type ProvisionPhase =
	| "idle"
	| "checking"
	| "starting"
	| "pulling"
	| "done"
	| "info"
	| "error";

/** Sentinel returned by detectNonOllamaServer for an unrecognised foreign port. */
const GENERIC_FOREIGN = "__generic__";

/**
 * Common default ports of OpenAI-compatible local servers that are NOT Ollama.
 * Auto-start + `ollama pull` only make sense for Ollama (port 11434); for these
 * the user runs their own server and loads the model there.
 */
const NON_OLLAMA_SERVER_PORTS: Record<string, string> = {
	"1234": "LM Studio",
	"8000": "vLLM",
	"8080": "llama.cpp / LocalAI",
	"5000": "LocalAI",
};

/**
 * Returns the non-Ollama server the URL appears to target (brand name, or the
 * GENERIC_FOREIGN sentinel), or null when the URL looks like Ollama (default
 * port 11434, or empty = default).
 */
function detectNonOllamaServer(baseUrl?: string): string | null {
	const raw = baseUrl?.trim();
	if (!raw) return null; // empty → backend default (Ollama on 11434)
	try {
		const parsed = new URL(raw);
		const port = parsed.port || "11434"; // no port → Ollama default
		if (port === "11434") return null;
		return NON_OLLAMA_SERVER_PORTS[port] ?? GENERIC_FOREIGN;
	} catch {
		return null; // unparseable → don't block; let the pipeline surface errors
	}
}

interface ProvisionState {
	phase: ProvisionPhase;
	/** Model being provisioned (the `hf.co/<id>` name). */
	model: string;
	message: string;
	percentage: number;
	/** Optional follow-up the user can take from the status panel. */
	action?: "install-ollama";
}

type SortOption = "trending" | "downloads" | "likes" | "created" | "modified";

/** Filter facets: stable `value` sent to the API + i18n key for the label. */
const TASK_OPTIONS = [
	{ value: "text-generation", key: "textGeneration" },
	{ value: "image-text-to-text", key: "vision" },
	{ value: "text2text-generation", key: "text2text" },
	{ value: "text-to-image", key: "textToImage" },
	{ value: "automatic-speech-recognition", key: "asr" },
	{ value: "feature-extraction", key: "embeddings" },
	{ value: "", key: "all" },
] as const;

const LIBRARY_OPTIONS = [
	{ value: "", key: "all" },
	{ value: "gguf", key: "gguf" },
	{ value: "transformers", key: "transformers" },
	{ value: "safetensors", key: "safetensors" },
	{ value: "gptq", key: "gptq" },
	{ value: "awq", key: "awq" },
	{ value: "mlx", key: "mlx" },
] as const;

const LANGUAGE_OPTIONS = [
	{ value: "", key: "all" },
	{ value: "en", key: "en" },
	{ value: "fr", key: "fr" },
	{ value: "zh", key: "zh" },
	{ value: "es", key: "es" },
	{ value: "de", key: "de" },
	{ value: "multilingual", key: "multilingual" },
] as const;

const LICENSE_OPTIONS = [
	{ value: "", key: "all" },
	{ value: "apache-2.0", key: "apache" },
	{ value: "mit", key: "mit" },
	{ value: "llama3.1", key: "llama31" },
	{ value: "llama3", key: "llama3" },
	{ value: "gemma", key: "gemma" },
	{ value: "cc-by-nc-4.0", key: "ccByNc" },
] as const;

const SORT_OPTIONS = [
	{ value: "trending", key: "trending" },
	{ value: "downloads", key: "downloads" },
	{ value: "likes", key: "likes" },
	{ value: "created", key: "created" },
	{ value: "modified", key: "modified" },
] as const;

function formatCount(n?: number): string {
	if (n == null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const selectClass =
	"flex-1 min-w-0 text-xs rounded-md border border-input bg-background text-foreground px-2 py-1.5";

export function HuggingFaceModelDiscovery({
	className,
	hfToken,
	selectedModel,
	baseUrl,
	onSelectModel,
}: HuggingFaceModelDiscoveryProps) {
	const { t } = useTranslation("settings");
	/** Shorthand for the model-discovery namespace. */
	const td = useCallback(
		(key: string, opts?: Record<string, unknown>) =>
			t(`sections.accounts.modelDiscovery.${key}`, opts ?? {}),
		[t],
	);

	const [query, setQuery] = useState("");
	const [task, setTask] = useState("text-generation");
	// Default to GGUF: Ollama can only pull GGUF repos from the Hub, so showing
	// GGUF first stops users from picking a transformers/safetensors repo that
	// fails with "no GGUF file". They can still switch to "All libraries".
	const [library, setLibrary] = useState("gguf");
	const [language, setLanguage] = useState("");
	const [license, setLicense] = useState("");
	const [sort, setSort] = useState<SortOption>("trending");
	const [models, setModels] = useState<HuggingFaceModelInfo[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [provision, setProvision] = useState<ProvisionState>({
		phase: "idle",
		model: "",
		message: "",
		percentage: 0,
	});
	// Holds the active pull-progress unsubscribe so we can detach it when the
	// download ends or the component unmounts.
	const progressUnsubRef = useRef<(() => void) | null>(null);

	const runSearch = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.searchHuggingFaceModels({
				query: query.trim(),
				task,
				library,
				language,
				license,
				sort,
				limit: 30,
				token: hfToken,
			});
			if (result.success && result.data) {
				setModels(result.data);
				if (result.data.length === 0) {
					setError(td("noResults"));
				}
			} else {
				setModels([]);
				setError(result.error || td("searchFailed"));
			}
		} catch (err) {
			setModels([]);
			setError(err instanceof Error ? err.message : td("unexpectedError"));
		} finally {
			setIsLoading(false);
		}
	}, [query, hfToken, task, library, language, license, sort, td]);

	// Search-as-you-type: re-run on any change to the query OR a filter, debounced
	// so a burst of keystrokes fires a single request. No "Search" button needed.
	useEffect(() => {
		const id = setTimeout(() => {
			void runSearch();
		}, 350);
		return () => clearTimeout(id);
	}, [runSearch]);

	const copyPullCommand = useCallback(async (id: string) => {
		try {
			await navigator.clipboard.writeText(`ollama pull hf.co/${id}`);
			setCopiedId(id);
			setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
		} catch {
			/* clipboard unavailable — ignore */
		}
	}, []);

	// Detach any live progress listener on unmount.
	useEffect(
		() => () => {
			progressUnsubRef.current?.();
			progressUnsubRef.current = null;
		},
		[],
	);

	/**
	 * The actual "plumbing": take a picked model and make it runnable locally.
	 *   1. ensure Ollama is installed,
	 *   2. start the server on the configured port if it isn't running,
	 *   3. pull the model into that server, streaming progress.
	 * Picking a model only stores a string; THIS is what downloads and serves it.
	 */
	const provisionModel = useCallback(
		async (model: string) => {
			const api = globalThis.electronAPI;
			if (!api?.pullOllamaModel) {
				setProvision({
					phase: "error",
					model,
					message: td("apiUnavailable"),
					percentage: 0,
				});
				return;
			}

			// Make sure the picked model is also the stored default.
			onSelectModel?.(model);

			// Auto-start + pull is Ollama-only. If the configured URL targets a
			// different local server, we can't drive it — tell the user plainly
			// rather than booting `ollama serve` on that server's port.
			const foreignServer = detectNonOllamaServer(baseUrl);
			if (foreignServer) {
				const serverName =
					foreignServer === GENERIC_FOREIGN
						? td("foreignServerGeneric")
						: foreignServer;
				setProvision({
					phase: "info",
					model,
					message: td("foreignServer", {
						url: baseUrl?.trim(),
						server: serverName,
						model,
					}),
					percentage: 0,
				});
				return;
			}

			try {
				// 1. Ensure Ollama is ready — downloads the portable binary if it
				// isn't installed, then starts the server. Fully automatic, no admin.
				setProvision({
					phase: "checking",
					model,
					message: td("preparing"),
					percentage: 0,
				});
				const ensureUnsub = api.onOllamaInstallProgress?.(
					(p: {
						phase:
							| "resolving"
							| "downloading"
							| "extracting"
							| "starting"
							| "ready";
						percentage: number;
						message: string;
					}) => {
						setProvision((prev) =>
							prev.model === model
								? {
										...prev,
										phase: p.phase === "downloading" ? "pulling" : "starting",
										message: p.message,
										percentage: p.percentage < 0 ? 0 : p.percentage,
									}
								: prev,
						);
					},
				);
				let ensured: Awaited<ReturnType<NonNullable<typeof api.ensureOllama>>>;
				try {
					ensured = await api.ensureOllama?.(baseUrl);
				} finally {
					ensureUnsub?.();
				}
				if (!ensured?.success) {
					setProvision({
						phase: "error",
						model,
						message: ensured?.error || td("ensureFailed"),
						percentage: 0,
						action: "install-ollama",
					});
					return;
				}

				// 2. Pull, streaming progress for this model.
				setProvision({
					phase: "pulling",
					model,
					message: td("downloadingModel", { model }),
					percentage: 0,
				});
				progressUnsubRef.current?.();
				progressUnsubRef.current =
					api.onDownloadProgress?.((data) => {
						if (data.modelName === model) {
							setProvision((p) =>
								p.phase === "pulling" && p.model === model
									? { ...p, percentage: data.percentage }
									: p,
							);
						}
					}) ?? null;

				const pulled = await api.pullOllamaModel(model, baseUrl);
				progressUnsubRef.current?.();
				progressUnsubRef.current = null;

				if (pulled?.success) {
					setProvision({
						phase: "done",
						model,
						message: td("ready", { model }),
						percentage: 100,
					});
				} else {
					setProvision({
						phase: "error",
						model,
						message: pulled?.error || td("pullFailed", { model }),
						percentage: 0,
					});
				}
			} catch (err) {
				progressUnsubRef.current?.();
				progressUnsubRef.current = null;
				setProvision({
					phase: "error",
					model,
					message: err instanceof Error ? err.message : td("unexpectedError"),
					percentage: 0,
				});
			}
		},
		[baseUrl, onSelectModel, td],
	);

	// Open the platform installer (terminal with the official install command).
	const installOllama = useCallback(async () => {
		const api = globalThis.electronAPI;
		try {
			const res = await api?.installOllama?.();
			setProvision((p) => ({
				...p,
				phase: res?.success ? "info" : "error",
				message: res?.success
					? td("installLaunched")
					: res?.error || td("installFailed"),
				action: undefined,
			}));
		} catch (err) {
			setProvision((p) => ({
				...p,
				phase: "error",
				message: err instanceof Error ? err.message : td("unexpectedError"),
				action: undefined,
			}));
		}
	}, [td]);

	const fb = "sections.accounts.modelDiscovery.filters";

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<div>
				<h3 className="text-sm font-medium text-foreground">{td("title")}</h3>
				<p className="text-xs text-muted-foreground mt-0.5">
					{td("description")}
				</p>
			</div>

			{provision.phase !== "idle" && (
				<div
					className={cn(
						"rounded-md border p-2.5",
						provision.phase === "error"
							? "border-destructive/30 bg-destructive/10"
							: provision.phase === "done"
								? "border-success/30 bg-success/10"
								: provision.phase === "info"
									? "border-warning/30 bg-warning/10"
									: "border-primary/30 bg-primary/5",
					)}
				>
					<div className="flex items-start gap-2 text-sm">
						{provision.phase === "error" ? (
							<AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
						) : provision.phase === "done" ? (
							<CircleCheck className="h-4 w-4 text-success shrink-0 mt-0.5" />
						) : provision.phase === "info" ? (
							<AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
						) : (
							<Loader2 className="h-4 w-4 animate-spin text-primary shrink-0 mt-0.5" />
						)}
						<span
							className={cn(
								provision.phase === "error"
									? "text-destructive"
									: provision.phase === "done"
										? "text-success"
										: provision.phase === "info"
											? "text-warning"
											: "text-foreground",
							)}
						>
							{provision.message}
						</span>
					</div>
					{provision.phase === "pulling" && (
						<div className="mt-2 w-full bg-muted rounded-full h-2 overflow-hidden">
							{provision.percentage > 0 ? (
								<div
									className="h-full rounded-full bg-primary transition-all duration-300"
									style={{
										width: `${Math.max(0, Math.min(100, provision.percentage))}%`,
									}}
								/>
							) : (
								<div className="h-full w-1/4 rounded-full bg-primary animate-indeterminate" />
							)}
						</div>
					)}
					{provision.action === "install-ollama" && (
						<div className="mt-2 flex items-center gap-2">
							<Button type="button" size="sm" onClick={installOllama}>
								<Download className="h-4 w-4 mr-1.5" />
								{td("installOllama")}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									globalThis.electronAPI?.openExternal?.("https://ollama.com")
								}
							>
								<ExternalLink className="h-4 w-4 mr-1.5" />
								ollama.com
							</Button>
						</div>
					)}
				</div>
			)}

			{/* Search-as-you-type (debounced) — no button needed. */}
			<div className="relative">
				<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={td("searchPlaceholder")}
					className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-input bg-background text-foreground"
				/>
				{isLoading && (
					<Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
				)}
			</div>

			{/* Filter bar — all facets on a single aligned row. */}
			<div className="flex items-center gap-2">
				<select
					value={task}
					onChange={(e) => setTask(e.target.value)}
					className={selectClass}
					aria-label={t(`${fb}.taskAria`)}
				>
					{TASK_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{t(`${fb}.task.${o.key}`)}
						</option>
					))}
				</select>
				<select
					value={library}
					onChange={(e) => setLibrary(e.target.value)}
					className={selectClass}
					aria-label={t(`${fb}.libAria`)}
				>
					{LIBRARY_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{t(`${fb}.lib.${o.key}`)}
						</option>
					))}
				</select>
				<select
					value={language}
					onChange={(e) => setLanguage(e.target.value)}
					className={selectClass}
					aria-label={t(`${fb}.langAria`)}
				>
					{LANGUAGE_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{t(`${fb}.lang.${o.key}`)}
						</option>
					))}
				</select>
				<select
					value={license}
					onChange={(e) => setLicense(e.target.value)}
					className={selectClass}
					aria-label={t(`${fb}.licenseAria`)}
				>
					{LICENSE_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{t(`${fb}.license.${o.key}`)}
						</option>
					))}
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value as SortOption)}
					className={selectClass}
					aria-label={t(`${fb}.sortAria`)}
				>
					{SORT_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{t(`${fb}.sort.${o.key}`)}
						</option>
					))}
				</select>
			</div>

			{error && (
				<div className="p-2 rounded-md bg-destructive/10 border border-destructive/30">
					<p className="text-sm text-destructive">{error}</p>
				</div>
			)}

			<div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
				{models.map((m) => {
					const localName = `hf.co/${m.id}`;
					const isSelected = selectedModel === localName;
					const isActiveProvision =
						provision.phase === "checking" ||
						provision.phase === "starting" ||
						provision.phase === "pulling";
					const isProvisioningThis =
						isActiveProvision && provision.model === localName;
					const isBusyElsewhere =
						isActiveProvision && provision.model !== localName;
					return (
						// biome-ignore lint/a11y/useSemanticElements: row wraps action <button>s, so it cannot itself be a <button>
						<div
							key={m.id}
							role="button"
							tabIndex={0}
							aria-pressed={isSelected}
							onClick={() => onSelectModel?.(localName)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelectModel?.(localName);
								}
							}}
							title={td("setDefaultTooltip", { name: localName })}
							className={cn(
								"flex items-center justify-between gap-3 p-2 rounded-md border cursor-pointer hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
								isSelected ? "border-primary bg-primary/5" : "border-border",
							)}
						>
							<div className="min-w-0">
								<p className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
									{isSelected && (
										<CircleCheck className="h-4 w-4 text-primary shrink-0" />
									)}
									{m.id}
									{isSelected && (
										<span className="text-[10px] font-normal text-primary">
											{td("default")}
										</span>
									)}
								</p>
								<div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
									<span className="inline-flex items-center gap-1">
										<Download className="h-3 w-3" />
										{formatCount(m.downloads)}
									</span>
									<span className="inline-flex items-center gap-1">
										<Heart className="h-3 w-3" />
										{formatCount(m.likes)}
									</span>
									{m.pipelineTag && (
										<span className="px-1.5 py-0.5 rounded bg-muted text-[10px]">
											{m.pipelineTag}
										</span>
									)}
									{m.library && (
										<span className="px-1.5 py-0.5 rounded bg-muted text-[10px]">
											{m.library}
										</span>
									)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<Button
									type="button"
									variant={isSelected ? "default" : "outline"}
									size="sm"
									onClick={(e) => {
										e.stopPropagation();
										provisionModel(localName);
									}}
									disabled={isProvisioningThis || isBusyElsewhere}
									title={td("setDefaultTooltip", { name: localName })}
								>
									{isProvisioningThis ? (
										<Loader2 className="h-4 w-4 animate-spin" />
									) : (
										<Download className="h-4 w-4" />
									)}
									<span className="ml-1.5 hidden sm:inline">
										{td("downloadStart")}
									</span>
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={(e) => {
										e.stopPropagation();
										copyPullCommand(m.id);
									}}
									title={td("copyTooltip", { id: m.id })}
								>
									{copiedId === m.id ? (
										<Check className="h-4 w-4 text-success" />
									) : (
										<Copy className="h-4 w-4" />
									)}
								</Button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default HuggingFaceModelDiscovery;
