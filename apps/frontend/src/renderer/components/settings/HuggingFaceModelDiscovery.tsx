/**
 * HuggingFaceModelDiscovery
 * =========================
 *
 * A live "Discover models" panel backed by the official Hugging Face MCP
 * server (via window.electronAPI.searchHuggingFaceModels → main → HF MCP).
 *
 * This is a DISCOVERY aid only: it lists repos on the Hub so the user can find
 * a model to run locally. The models actually selectable for inference still
 * come from the local server's /v1/models (Ollama / LM Studio). Each row offers
 * a one-click "ollama pull hf.co/<id>" copy to fetch a GGUF repo.
 *
 * The filter bar mirrors the facets on https://huggingface.co/models (task,
 * library, language, license, sort). Parameter-size filtering is intentionally
 * absent: the HF MCP `hub_repo_search` tool exposes no size facet.
 */

import { Check, Copy, Download, Heart, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HuggingFaceModelInfo } from "../../../shared/types/mcp-marketplace";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface HuggingFaceModelDiscoveryProps {
	className?: string;
	/** Optional HF read token (raises rate limits, unlocks gated repos). */
	hfToken?: string;
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

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<div>
				<h3 className="text-sm font-medium text-foreground">
					Découvrir des modèles (Hugging Face)
				</h3>
				<p className="text-xs text-muted-foreground mt-0.5">
					Liste en direct du Hub via le MCP Hugging Face. Récupérez un modèle
					(GGUF) avec « ollama pull », puis sélectionnez-le dans le serveur
					local.
				</p>
			</div>

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
					{isLoading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						"Rechercher"
					)}
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
				{models.map((m) => (
					<div
						key={m.id}
						className="flex items-center justify-between gap-3 p-2 rounded-md border border-border hover:bg-muted/40"
					>
						<div className="min-w-0">
							<p className="text-sm font-medium text-foreground truncate">
								{m.id}
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
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => copyPullCommand(m.id)}
							title={`ollama pull hf.co/${m.id}`}
						>
							{copiedId === m.id ? (
								<Check className="h-4 w-4 text-success" />
							) : (
								<Copy className="h-4 w-4" />
							)}
							<span className="ml-1.5 hidden sm:inline">ollama pull</span>
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}

export default HuggingFaceModelDiscovery;
