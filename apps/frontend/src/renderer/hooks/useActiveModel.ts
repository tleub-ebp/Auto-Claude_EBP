/**
 * Resolve the (provider, model) pair the user is currently driving.
 *
 * Priority order:
 *   1. Active API profile's `models.default` (set in Settings → API Profiles).
 *   2. App-wide `defaultModel` setting.
 *   3. Provider's flagship model (best-effort fallback).
 *
 * The hook returns `null` for `model` when nothing is configured yet — UI
 * code should display an unobtrusive "configure a model" hint rather than
 * fabricating a default that might not match the user's actual setup.
 *
 * Note: the `useContext(ProviderContext)` call is *not* wrapped in
 * `useProviderContext()` because that helper throws when used outside a
 * provider — fine for the main app, but breaks isolated tests / Storybook.
 * Reading the context directly and tolerating an undefined value lets this
 * hook be used safely in any rendering context.
 */

import { useContext, useMemo } from "react";
import { getDefaultModelForProvider, MODEL_ID_MAP } from "../../shared/constants/models";
import { ProviderContext } from "../components/ProviderContext";
import { useSettingsStore } from "../stores/settings-store";

interface ActiveModel {
	provider: string;
	/** The model identifier as configured. `null` when nothing is set. */
	model: string | null;
	/** Where the model was resolved from, for debugging / tooltips. */
	source: "profile" | "settings" | "providerDefault" | "none";
}

export function useActiveModel(): ActiveModel {
	const ctx = useContext(ProviderContext);
	const selectedProvider = ctx?.selectedProvider ?? "";
	const profiles = useSettingsStore((s) => s.profiles);
	const activeProfileId = useSettingsStore((s) => s.activeProfileId);
	const settingsDefaultModel = useSettingsStore((s) => s.settings.defaultModel);

	return useMemo(() => {
		const provider = selectedProvider || "anthropic";

		// 1. Active API profile's default model.
		if (activeProfileId) {
			const profile = profiles.find((p) => p.id === activeProfileId);
			const profileModel = profile?.models?.default;
			if (profileModel) {
				return { provider, model: profileModel, source: "profile" };
			}
		}

		// 2. App-wide default model. May be a shorthand ("opus" / "sonnet")
		//    that needs expansion to a real Claude model ID for pricing.
		if (settingsDefaultModel) {
			const expanded = MODEL_ID_MAP[settingsDefaultModel] ?? settingsDefaultModel;
			return { provider, model: expanded, source: "settings" };
		}

		// 3. Best-effort fallback to the provider's flagship.
		const flagship = getDefaultModelForProvider(provider);
		if (flagship) {
			return { provider, model: flagship, source: "providerDefault" };
		}

		return { provider, model: null, source: "none" };
	}, [selectedProvider, profiles, activeProfileId, settingsDefaultModel]);
}
