/**
 * Fetches the live model catalog for a given AI provider from the backend
 * and unions it with the local static catalog so the dropdown always
 * exposes both:
 *
 *  - The freshest live entries from the provider's /v1/models response
 *    (so a brand-new model like "claude-opus-4-7" or "gpt-5.5" appears
 *    automatically the day the provider lists it).
 *  - The local static entries (legacy short aliases like "opus"/"sonnet"
 *    used by preset agent profiles, plus curated additions in
 *    PROVIDER_MODELS_MAP). These are kept so existing tasks persisted
 *    with these values keep working.
 *
 * Backed by `GET /providers/models/{provider}/catalog`, which has a 24h
 * disk cache and falls back to a static catalog when the provider's API
 * is unreachable or no API key is configured.
 *
 * The hook serves static entries instantly so the UI never shows an empty
 * dropdown, then upgrades the union as the live response arrives.
 * `refresh()` bypasses the backend cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AVAILABLE_MODELS,
	getModelsForProvider,
} from "../../shared/constants";

export type CatalogSource = "live" | "cache" | "static";

/** Subset of ProviderModel — `tier` and `supportsThinking` are optional. */
export interface CatalogModel {
	value: string;
	label: string;
	tier?: "flagship" | "standard" | "fast" | "local";
	supportsThinking?: boolean;
}

export interface ProviderModelCatalog {
	models: readonly CatalogModel[];
	source: CatalogSource;
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	refresh: () => void;
}

interface CatalogResponse {
	provider: string;
	models: CatalogModel[];
	source: CatalogSource;
	fetchedAt: number | null;
	error: string | null;
}

/** Local static entries shown for `provider` regardless of what the live
 * API returns (legacy aliases, curated additions). */
function localStaticEntries(provider: string): readonly CatalogModel[] {
	const isClaude =
		!provider || provider === "anthropic" || provider === "claude";
	if (isClaude) {
		// AVAILABLE_MODELS holds the short aliases (opus/sonnet/haiku/…) used
		// by preset agent profiles. We also surface the modern PROVIDER_MODELS
		// curated list for Anthropic so anything the live API hides (e.g.
		// when the key cannot list a model the user is still authorised to
		// call) remains selectable.
		return [...AVAILABLE_MODELS, ...getModelsForProvider("anthropic")];
	}
	return getModelsForProvider(provider);
}

/** Merge two model lists, deduplicating by `value`. Items from `primary`
 * win over `secondary` (so live entries override stale static ones). */
function mergeCatalogs(
	primary: readonly CatalogModel[],
	secondary: readonly CatalogModel[],
): CatalogModel[] {
	const seen = new Set<string>();
	const out: CatalogModel[] = [];
	for (const m of primary) {
		if (m.value && !seen.has(m.value)) {
			seen.add(m.value);
			out.push(m);
		}
	}
	for (const m of secondary) {
		if (m.value && !seen.has(m.value)) {
			seen.add(m.value);
			out.push(m);
		}
	}
	return out;
}

export function useProviderModelCatalog(
	provider: string,
): ProviderModelCatalog {
	const staticEntries = useMemo(() => localStaticEntries(provider), [provider]);

	// `liveModels` holds whatever the backend last returned for this provider
	// (empty until the first response). The exposed catalog is always the
	// union staticEntries ∪ liveModels.
	const [liveModels, setLiveModels] = useState<readonly CatalogModel[]>([]);
	const [source, setSource] = useState<CatalogSource>("static");
	const [fetchedAt, setFetchedAt] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [bumpToken, setBumpToken] = useState(0);
	const lastProviderRef = useRef<string>("");

	const refresh = useCallback(() => setBumpToken((n) => n + 1), []);

	useEffect(() => {
		// Reset live data whenever the provider changes; static entries are
		// already provider-correct via useMemo above.
		if (lastProviderRef.current !== provider) {
			lastProviderRef.current = provider;
			setLiveModels([]);
			setSource("static");
			setFetchedAt(null);
			setError(null);
		}

		if (!provider) return;

		const controller = new AbortController();
		const backendUrl = import.meta.env?.VITE_BACKEND_URL || "";
		const url = `${backendUrl}/providers/models/${encodeURIComponent(
			provider,
		)}/catalog${bumpToken > 0 ? "?refresh=true" : ""}`;

		setLoading(true);
		fetch(url, { signal: controller.signal })
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const contentType = res.headers.get("content-type") || "";
				if (!contentType.includes("application/json")) {
					throw new Error("non-json");
				}
				return res.json() as Promise<CatalogResponse>;
			})
			.then((data) => {
				const models = Array.isArray(data?.models) ? data.models : [];
				setLiveModels(models);
				setSource(data?.source ?? "static");
				setFetchedAt(data?.fetchedAt ?? null);
				setError(data?.error ?? null);
			})
			.catch((err) => {
				if (err?.name === "AbortError") return;
				setError(err?.message ?? "fetch_failed");
			})
			.finally(() => setLoading(false));

		return () => controller.abort();
	}, [provider, bumpToken]);

	// Live first → static second so a freshly listed model (e.g. Opus 4.7
	// returned by /v1/models) shows above its statically-curated peer.
	const models = useMemo(
		() => mergeCatalogs(liveModels, staticEntries),
		[liveModels, staticEntries],
	);

	return { models, source, fetchedAt, error, loading, refresh };
}
