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

type SortOption = "trending" | "downloads" | "likes" | "created";

function formatCount(n?: number): string {
	if (n == null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function HuggingFaceModelDiscovery({
	className,
	hfToken,
}: HuggingFaceModelDiscoveryProps) {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortOption>("trending");
	const [models, setModels] = useState<HuggingFaceModelInfo[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);

	// Keep the latest query in a ref so the auto-run effect can read it without
	// re-firing on every keystroke (it should only re-run when `sort` changes).
	const queryRef = useRef(query);
	queryRef.current = query;

	const runSearch = useCallback(
		async (sortOrder: SortOption) => {
			setIsLoading(true);
			setError(null);
			try {
				const result = await window.electronAPI.searchHuggingFaceModels({
					query: queryRef.current.trim(),
					task: "text-generation",
					sort: sortOrder,
					limit: 30,
					token: hfToken,
				});
				if (result.success && result.data) {
					setModels(result.data);
					if (result.data.length === 0) {
						setError("Aucun modèle trouvé pour cette recherche.");
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
		},
		[hfToken],
	);

	// Initial load + re-run whenever the sort order changes.
	useEffect(() => {
		void runSearch(sort);
	}, [runSearch, sort]);

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
					void runSearch(sort);
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
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value as SortOption)}
					className="text-sm rounded-md border border-input bg-background text-foreground px-2 py-1.5"
					aria-label="Trier les modèles"
				>
					<option value="trending">Tendances</option>
					<option value="downloads">Téléchargements</option>
					<option value="likes">Likes</option>
					<option value="created">Récents</option>
				</select>
				<Button type="submit" size="sm" disabled={isLoading}>
					{isLoading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						"Rechercher"
					)}
				</Button>
			</form>

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
