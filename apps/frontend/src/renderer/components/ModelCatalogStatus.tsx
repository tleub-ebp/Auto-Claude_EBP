/**
 * ModelCatalogStatus — small inline indicator showing where the current model
 * list comes from (live API, cache, static fallback) plus a refresh button
 * that bypasses the 24h backend cache.
 */

import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { ProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { cn } from "../lib/utils";

interface ModelCatalogStatusProps {
	catalog: ProviderModelCatalog;
	className?: string;
}

function formatRelative(ts: number | null): string {
	if (!ts) return "à l'instant";
	const diffMs = Date.now() - ts * 1000;
	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 1) return "à l'instant";
	if (minutes < 60) return `il y a ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `il y a ${hours}h`;
	const days = Math.floor(hours / 24);
	return `il y a ${days}j`;
}

export function ModelCatalogStatus({
	catalog,
	className,
}: ModelCatalogStatusProps) {
	const { source, fetchedAt, error, loading, refresh } = catalog;

	const Icon = error || source === "static" ? WifiOff : Wifi;
	const label =
		source === "live"
			? "Liste à jour"
			: source === "cache"
				? `En cache · ${formatRelative(fetchedAt)}`
				: "Liste hors-ligne";

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 text-[10px] text-muted-foreground",
				className,
			)}
		>
			<Icon className="h-3 w-3" />
			<span>{label}</span>
			<button
				type="button"
				onClick={refresh}
				disabled={loading}
				aria-label="Rafraîchir la liste des modèles"
				className={cn(
					"ml-1 rounded p-0.5 hover:bg-muted disabled:opacity-50",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				)}
			>
				{loading ? (
					<Loader2 className="h-3 w-3 animate-spin" />
				) : (
					<RefreshCw className="h-3 w-3" />
				)}
			</button>
		</div>
	);
}
