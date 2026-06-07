/**
 * useContextUsage - Pourcentage de fenêtre de contexte consommée (façon Claude Code)
 *
 * Calcule le « % de contexte consommé » pour un provider à partir des tokens
 * réellement envoyés lors de la dernière requête (cost_data.json), divisés par
 * la fenêtre de contexte du modèle utilisé.
 *
 * Sert de remplacement à l'indicateur quota Copilot (qui renvoie 0 token en
 * scope personal-quotas). Retourne `null` si aucune donnée n'est disponible,
 * permettant un fallback sur l'affichage existant.
 */

import { getContextWindowForModel } from "@shared/constants/models";
import { useCallback, useEffect, useState } from "react";
import { useProjectStore } from "../stores/project-store";

export interface ContextUsageInfo {
	/** Modèle de la dernière requête (ex. "gpt-4o"). */
	model: string;
	/** Tokens envoyés au modèle (remplissage du contexte). */
	contextTokens: number;
	/** Fenêtre de contexte du modèle (tokens). */
	contextWindow: number;
	/** Pourcentage consommé, borné à [0, 100]. */
	percentUsed: number;
}

/**
 * Hook fournissant le % de fenêtre de contexte consommée pour un provider.
 *
 * @param providerName Provider concerné (ex. "copilot"). `null` désactive le hook.
 * @returns Les informations de contexte, ou `null` si indisponible.
 */
export function useContextUsage(
	providerName: string | null | undefined,
): ContextUsageInfo | null {
	const [info, setInfo] = useState<ContextUsageInfo | null>(null);

	const fetchUsage = useCallback(async () => {
		const projectPath = useProjectStore.getState().getActiveProject()?.path;
		if (!projectPath || !providerName) {
			setInfo(null);
			return;
		}

		try {
			const res = await globalThis.electronAPI.getContextUsage(
				projectPath,
				providerName,
			);
			const usage = res?.success ? res.contextUsage : null;
			if (!usage || usage.contextTokens <= 0) {
				setInfo(null);
				return;
			}

			const contextWindow = getContextWindowForModel(usage.model);
			const percentUsed = Math.min(
				100,
				Math.max(0, (usage.contextTokens / contextWindow) * 100),
			);

			setInfo({
				model: usage.model,
				contextTokens: usage.contextTokens,
				contextWindow,
				percentUsed,
			});
		} catch {
			setInfo(null);
		}
	}, [providerName]);

	useEffect(() => {
		void fetchUsage();

		// Rafraîchit quand cost_data.json change (nouveau tour d'agent).
		const unsubscribe = globalThis.electronAPI.onCostsUpdated(() => {
			void fetchUsage();
		});
		return unsubscribe;
	}, [fetchUsage]);

	return info;
}
