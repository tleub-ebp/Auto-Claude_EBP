/**
 * HuggingFaceModelDiscovery
 * =========================
 *
 * A live "Discover models" panel backed by the official Hugging Face MCP
 * server (via window.electronAPI.searchHuggingFaceModels → main → HF MCP).
 *
 * Two actions per row:
 *   - "Choisir" sets the provider's default model to `hf.co/<id>` (the id Ollama
 *     uses after `ollama pull hf.co/<id>`), wired to the parent config form.
 *   - "ollama pull" copies the pull command to fetch the GGUF repo locally.
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

/**
 * Common default ports of OpenAI-compatible local servers that are NOT Ollama.
 * Auto-start + `ollama pull` only make sense for Ollama (port 11434); for these
 * the user runs their own server and loads the model there. We use this to warn
 * instead of mis-starting `ollama serve` on someone else's port.
 */
const NON_OLLAMA_SERVER_PORTS: Record<string, string> = {
	"1234": "LM Studio",
	"8000": "vLLM",
	"8080": "llama.cpp / LocalAI",
	"5000": "LocalAI",
};

/**
 * Returns the name of the non-Ollama server the URL appears to target, or null
 * when the URL looks like Ollama (default port 11434, or empty = default).
 */
function detectNonOllamaServer(baseUrl?: string): string | null {
	const raw = baseUrl?.trim();
	if (!raw) return null; // empty → backend default (Ollama on 11434)
	try {
		const parsed = new URL(raw);
		const port = parsed.port || "11434"; // no port → Ollama default
		if (port === "11434") return null;
		return NON_OLLAMA_SERVER_PORTS[port] ?? "un serveur local non-Ollama";
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

interface SelectOption {
	value: string;
	label: string;
}

/** Curated task facets, LLM-discovery first. Empty value = any task. */
const TASK_OPTIONS: SelectOption[] = [
	{ value: "text-generation", label: "Génération de texte" },
	{ value: "image-text-to-text", label: "Vision (image→texte)" },
	{ value: "text2text-generation", label: "Text2Text" },
	{ value: "text-to-image", label: "Texte→image" },
	{ value: "automatic-speech-recognition", label: "Reconnaissance vocale" },
	{ value: "feature-extraction", label: "Embeddings" },
	{ value: "", label: "Toutes les tâches" },
];

const LIBRARY_OPTIONS: SelectOption[] = [
	{ value: "", label: "Toutes les libs" },
	{ value: "gguf", label: "GGUF (Ollama)" },
	{ value: "transformers", label: "Transformers" },
	{ value: "safetensors", label: "Safetensors" },
	{ value: "gptq", label: "GPTQ" },
	{ value: "awq", label: "AWQ" },
	{ value: "mlx", label: "MLX" },
];

const LANGUAGE_OPTIONS: SelectOption[] = [
	{ value: "", label: "Toutes langues" },
	{ value: "en", label: "Anglais" },
	{ value: "fr", label: "Français" },
	{ value: "zh", label: "Chinois" },
	{ value: "es", label: "Espagnol" },
	{ value: "de", label: "Allemand" },
	{ value: "multilingual", label: "Multilingue" },
];

const LICENSE_OPTIONS: SelectOption[] = [
	{ value: "", label: "Toutes licences" },
	{ value: "apache-2.0", label: "Apache 2.0" },
	{ value: "mit", label: "MIT" },
	{ value: "llama3.1", label: "Llama 3.1" },
	{ value: "llama3", label: "Llama 3" },
	{ value: "gemma", label: "Gemma" },
	{ value: "cc-by-nc-4.0", label: "CC BY-NC 4.0" },
];

const SORT_OPTIONS: SelectOption[] = [
	{ value: "trending", label: "Tendances" },
	{ value: "downloads", label: "Téléchargements" },
	{ value: "likes", label: "Likes" },
	{ value: "created", label: "Récents" },
	{ value: "modified", label: "Modifiés" },
];

function formatCount(n?: number): string {
	if (n == null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const selectClass =
	"text-xs rounded-md border border-input bg-background text-foreground px-2 py-1.5";

export function HuggingFaceModelDiscovery({
	className,
	hfToken,
	selectedModel,
	baseUrl,
	onSelectModel,
}: HuggingFaceModelDiscoveryProps) {
	const [query, setQuery] = useState("");
	const [task, setTask] = useState("text-generation");
	const [library, setLibrary] = useState("");
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

	// Keep the latest free-text query in a ref so dropdown-driven auto-searches
	// read it without making `query` a dependency (which would re-fire on every
	// keystroke). The query itself is applied manually (Enter / button).
	const queryRef = useRef(query);
	queryRef.current = query;

	const runSearch = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.searchHuggingFaceModels({
				query: queryRef.current.trim(),
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
					setError("Aucun modèle trouvé pour ces critères.");
				}
			} else {
				setModels([]);
				setError(result.error || "La recherche Hugging Face a échoué.");
			}
		} catch (err) {
			setModels([]);
			setError(err instanceof Error ? err.message : "Erreur inattendue.");
		} finally {
			setIsLoading(false);
		}
	}, [hfToken, task, library, language, license, sort]);

	// Initial load + re-run whenever any dropdown filter changes (runSearch's
	// identity changes with those deps).
	useEffect(() => {
		void runSearch();
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
					message: "Indisponible : API Ollama non chargée.",
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
				setProvision({
					phase: "info",
					model,
					message:
						`L'URL configurée (${baseUrl?.trim()}) vise ${foreignServer}, pas Ollama. ` +
						`Le téléchargement et le démarrage automatiques ne sont disponibles que pour Ollama. ` +
						`Démarrez votre serveur et chargez-y « ${model} » manuellement (le modèle a bien été défini par défaut).`,
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
					message: "Préparation d'Ollama…",
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
						message:
							(ensured?.error ||
								"Impossible de préparer Ollama automatiquement.") +
							" Vous pouvez aussi l'installer manuellement depuis ollama.com.",
						percentage: 0,
						action: "install-ollama",
					});
					return;
				}

				// 2. Pull, streaming progress for this model.
				setProvision({
					phase: "pulling",
					model,
					message: `Téléchargement de ${model}…`,
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
						message: `${model} est prêt et servi localement.`,
						percentage: 100,
					});
				} else {
					setProvision({
						phase: "error",
						model,
						message: pulled?.error || `Échec du téléchargement de ${model}.`,
						percentage: 0,
					});
				}
			} catch (err) {
				progressUnsubRef.current?.();
				progressUnsubRef.current = null;
				setProvision({
					phase: "error",
					model,
					message: err instanceof Error ? err.message : "Erreur inattendue.",
					percentage: 0,
				});
			}
		},
		[baseUrl, onSelectModel],
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
					? "Installation lancée dans un terminal. Une fois terminée, relancez « Télécharger & démarrer »."
					: res?.error || "Impossible de lancer l'installation d'Ollama.",
				action: undefined,
			}));
		} catch (err) {
			setProvision((p) => ({
				...p,
				phase: "error",
				message: err instanceof Error ? err.message : "Erreur inattendue.",
				action: undefined,
			}));
		}
	}, []);

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<div>
				<h3 className="text-sm font-medium text-foreground">
					Découvrir des modèles (Hugging Face)
				</h3>
				<p className="text-xs text-muted-foreground mt-0.5">
					Liste en direct du Hub via le MCP Hugging Face. Cliquez une ligne pour
					la définir par défaut ; « Télécharger & démarrer » lance Ollama et
					récupère le modèle localement.
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
								Installer Ollama
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

			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void runSearch();
				}}
			>
				<div className="relative flex-1">
					<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<input
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Rechercher (ex. qwen2.5-coder, llama 3.1, mistral)…"
						className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md border border-input bg-background text-foreground"
					/>
				</div>
				<Button type="submit" size="sm" disabled={isLoading}>
					{isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rechercher"}
				</Button>
			</form>

			{/* Filter bar — mirrors the facets on huggingface.co/models. */}
			<div className="flex flex-wrap items-center gap-2">
				<select
					value={task}
					onChange={(e) => setTask(e.target.value)}
					className={selectClass}
					aria-label="Tâche"
				>
					{TASK_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<select
					value={library}
					onChange={(e) => setLibrary(e.target.value)}
					className={selectClass}
					aria-label="Bibliothèque"
				>
					{LIBRARY_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<select
					value={language}
					onChange={(e) => setLanguage(e.target.value)}
					className={selectClass}
					aria-label="Langue"
				>
					{LANGUAGE_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<select
					value={license}
					onChange={(e) => setLicense(e.target.value)}
					className={selectClass}
					aria-label="Licence"
				>
					{LICENSE_OPTIONS.map((o) => (
						<option key={o.value || "all"} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value as SortOption)}
					className={cn(selectClass, "ml-auto")}
					aria-label="Trier les modèles"
				>
					{SORT_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
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
							title={`Définir ${localName} comme modèle par défaut`}
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
											(par défaut)
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
									onClick={(e) => { e.stopPropagation(); provisionModel(localName); }}
									disabled={isProvisioningThis || isBusyElsewhere}
									title={`Démarrer Ollama et télécharger ${localName}`}
								>
									{isProvisioningThis ? (
										<Loader2 className="h-4 w-4 animate-spin" />
									) : (
										<Download className="h-4 w-4" />
									)}
									<span className="ml-1.5 hidden sm:inline">
										Télécharger & démarrer
									</span>
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={(e) => { e.stopPropagation(); copyPullCommand(m.id); }}
									title={`Copier : ollama pull hf.co/${m.id}`}
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
