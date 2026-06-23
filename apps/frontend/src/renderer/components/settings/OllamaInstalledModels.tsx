/**
 * OllamaInstalledModels
 * =====================
 *
 * Lists the models actually pulled into the local Ollama server, with their
 * on-disk size and a delete button so the user can reclaim space without a
 * terminal. Talks to the server via the existing IPC (list + delete).
 */

import { HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface InstalledModel {
	name: string;
	size_gb: number;
}

interface OllamaInstalledModelsProps {
	className?: string;
	/** Configured local server URL (defaults to localhost:11434). */
	baseUrl?: string;
}

function formatSize(gb: number): string {
	if (!gb || gb <= 0) return "—";
	if (gb < 1) return `${Math.round(gb * 1024)} Mo`;
	return `${gb.toFixed(1)} Go`;
}

export function OllamaInstalledModels({
	className,
	baseUrl,
}: OllamaInstalledModelsProps) {
	const [models, setModels] = useState<InstalledModel[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const res = await globalThis.electronAPI?.listOllamaModels?.(baseUrl);
			if (res?.success && res.data?.models) {
				setModels(
					res.data.models.map((m) => ({
						name: m.name,
						size_gb: m.size_gb,
					})),
				);
			} else {
				// Server not running / unreachable → just show nothing, no scary error.
				setModels([]);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erreur inattendue.");
			setModels([]);
		} finally {
			setIsLoading(false);
		}
	}, [baseUrl]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleDelete = useCallback(
		async (name: string) => {
			if (
				!confirm(
					`Supprimer le modèle « ${name} » du disque ? Cette action est irréversible (il faudra le retélécharger pour le réutiliser).`,
				)
			) {
				return;
			}
			setDeleting(name);
			setError(null);
			try {
				const res = await globalThis.electronAPI?.deleteOllamaModel?.(
					name,
					baseUrl,
				);
				if (res?.success) {
					setModels((prev) => prev.filter((m) => m.name !== name));
				} else {
					setError(res?.error || `Échec de la suppression de ${name}.`);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Erreur inattendue.");
			} finally {
				setDeleting(null);
			}
		},
		[baseUrl],
	);

	const totalGb = models.reduce((sum, m) => sum + (m.size_gb || 0), 0);

	// Nothing pulled and nothing loading → keep the panel quiet (no empty box).
	if (!isLoading && models.length === 0 && !error) return null;

	return (
		<div className={cn("flex flex-col gap-2", className)}>
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
						<HardDrive className="h-4 w-4" />
						Modèles installés localement
					</h3>
					<p className="text-xs text-muted-foreground mt-0.5">
						{models.length > 0
							? `${models.length} modèle(s) · ${formatSize(totalGb)} sur le disque`
							: "Aucun modèle pour l'instant."}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => void refresh()}
					disabled={isLoading}
					title="Rafraîchir la liste"
				>
					{isLoading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<RefreshCw className="h-4 w-4" />
					)}
				</Button>
			</div>

			{error && (
				<div className="p-2 rounded-md bg-destructive/10 border border-destructive/30">
					<p className="text-sm text-destructive">{error}</p>
				</div>
			)}

			<div className="flex flex-col gap-1.5">
				{models.map((m) => (
					<div
						key={m.name}
						className="flex items-center justify-between gap-3 p-2 rounded-md border border-border"
					>
						<div className="min-w-0">
							<p className="text-sm text-foreground truncate">{m.name}</p>
							<p className="text-xs text-muted-foreground">
								{formatSize(m.size_gb)}
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => handleDelete(m.name)}
							disabled={deleting === m.name}
							title={`Supprimer ${m.name} du disque`}
							className="text-destructive hover:text-destructive"
						>
							{deleting === m.name ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Trash2 className="h-4 w-4" />
							)}
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}

export default OllamaInstalledModels;
