import type { TaskLogPhase, TaskMetadata } from "../types";
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_PHASE_MODELS,
	DEFAULT_PHASE_THINKING,
	getCanonicalModelKey,
	resolveCatalogModelValue,
} from "../constants/models";
import type {
	AppSettings,
	PhaseModelConfig,
	PhaseProviderConfig,
	PhaseThinkingConfig,
	ThinkingLevel,
} from "../types/settings";

/**
 * Correspondance phase de logs → clé de configuration.
 * La phase de logs « planning » couvre la création de spec ; elle pilote donc
 * le thinking de la phase `spec`.
 */
export const LOG_PHASE_TO_CONFIG_PHASE: Record<
	TaskLogPhase,
	keyof PhaseThinkingConfig
> = {
	planning: "spec",
	coding: "coding",
	validation: "qa",
};

/**
 * Défauts par phase résolus depuis les Settings (provider + modèles + thinking).
 * Sert à amorcer la configuration par phase d'une tâche : tant qu'une phase n'a
 * pas d'override explicite, elle hérite de ces valeurs.
 */
export interface PhaseDefaults {
	provider: string;
	phaseModels: PhaseModelConfig;
	phaseThinking: PhaseThinkingConfig;
}

/** Sous-ensemble des Settings nécessaire à la résolution des défauts par phase. */
type PhaseDefaultsSettings = Pick<
	AppSettings,
	| "selectedProvider"
	| "selectedAgentProfile"
	| "providerPhaseModels"
	| "providerPhaseThinking"
	| "customPhaseModels"
	| "customPhaseThinking"
	| "globalOllamaModel"
>;

/**
 * Résout les défauts par phase à partir des Settings, pour un provider donné.
 *
 * Priorité (du plus spécifique au plus générique) :
 * 1. Config par provider (`providerPhaseModels[provider]`)
 * 2. Override custom global (`customPhaseModels`)
 * 3. Profil d'agent sélectionné (`DEFAULT_AGENT_PROFILES`)
 * 4. Défauts applicatifs (`DEFAULT_PHASE_MODELS`)
 *
 * Le provider effectif retombe sur `settings.selectedProvider` puis `"anthropic"`.
 */
export function resolvePhaseDefaults(
	settings: PhaseDefaultsSettings | undefined,
	provider?: string,
): PhaseDefaults {
	const effectiveProvider =
		provider || settings?.selectedProvider || "anthropic";

	const profile =
		DEFAULT_AGENT_PROFILES.find(
			(p) => p.id === (settings?.selectedAgentProfile || "auto"),
		) || DEFAULT_AGENT_PROFILES[0];

	let phaseModels =
		settings?.providerPhaseModels?.[effectiveProvider] ||
		settings?.customPhaseModels ||
		profile?.phaseModels ||
		DEFAULT_PHASE_MODELS;

	// For local providers (Ollama / LM Studio …) the user configures a single
	// default model in the provider page (`globalOllamaModel`). Use it for every
	// phase so tasks default to the model actually installed/configured, instead
	// of a generic catalog name (e.g. "qwen2.5-coder") the user never picked —
	// unless they've set an explicit per-provider phase config.
	const isLocalProvider =
		effectiveProvider === "ollama" ||
		effectiveProvider === "local" ||
		effectiveProvider === "lmstudio";
	if (
		isLocalProvider &&
		!settings?.providerPhaseModels?.[effectiveProvider] &&
		settings?.globalOllamaModel?.trim()
	) {
		const m = settings.globalOllamaModel.trim();
		phaseModels = { spec: m, planning: m, coding: m, qa: m };
	}

	const phaseThinking =
		settings?.providerPhaseThinking?.[effectiveProvider] ||
		settings?.customPhaseThinking ||
		profile?.phaseThinking ||
		DEFAULT_PHASE_THINKING;

	return { provider: effectiveProvider, phaseModels, phaseThinking };
}

/**
 * Vrai lorsque la tâche utilise une configuration par phase (profil Auto), où
 * chaque phase peut avoir son propre niveau de réflexion.
 */
export function isPerPhaseThinkingTask(
	metadata: TaskMetadata | undefined,
): boolean {
	return Boolean(
		metadata?.isAutoProfile && metadata.phaseModels && metadata.phaseThinking,
	);
}

/**
 * Construit la base modèles/thinking par phase d'une tâche : on part des
 * overrides déjà présents sur la tâche, sinon des défauts résolus depuis les
 * Settings (et en dernier recours des défauts applicatifs).
 */
function basePhaseConfig(
	metadata: TaskMetadata | undefined,
	defaults: PhaseDefaults | undefined,
): { phaseModels: PhaseModelConfig; phaseThinking: PhaseThinkingConfig } {
	return {
		phaseModels:
			metadata?.phaseModels ?? defaults?.phaseModels ?? DEFAULT_PHASE_MODELS,
		phaseThinking:
			metadata?.phaseThinking ??
			defaults?.phaseThinking ??
			DEFAULT_PHASE_THINKING,
	};
}

/**
 * Construit la mise à jour de metadata pour changer le « thinking effort »
 * d'une phase donnée.
 *
 * La configuration est toujours écrite **par phase** (et `isAutoProfile` est
 * activé) afin que la modification d'une phase n'impacte pas les autres et soit
 * réellement appliquée au runtime (le backend n'honore `phaseThinking` que pour
 * les tâches par phase). Les phases non modifiées sont amorcées depuis les
 * défauts Settings.
 */
export function buildThinkingMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	level: ThinkingLevel,
	defaults?: PhaseDefaults,
): Partial<TaskMetadata> {
	const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
	const base = basePhaseConfig(metadata, defaults);
	return {
		isAutoProfile: true,
		phaseModels: { ...base.phaseModels },
		phaseThinking: { ...base.phaseThinking, [configPhase]: level },
	};
}

/**
 * Construit la mise à jour de metadata pour changer le modèle d'une phase.
 *
 * Comme pour le thinking, la config est écrite par phase (avec `isAutoProfile`)
 * en amorçant les phases non modifiées depuis les défauts Settings.
 */
export function buildModelMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	model: string,
	defaults?: PhaseDefaults,
): Partial<TaskMetadata> {
	const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
	const base = basePhaseConfig(metadata, defaults);
	return {
		isAutoProfile: true,
		phaseModels: { ...base.phaseModels, [configPhase]: model },
		phaseThinking: { ...base.phaseThinking },
	};
}

/**
 * Construit une configuration provider par phase complète, en partant de
 * `phaseProviders` existant ou, à défaut, du provider résolu depuis les Settings
 * (puis du provider unique de la tâche, replié sur "anthropic" si absent).
 */
function basePhaseProviders(
	metadata: TaskMetadata | undefined,
	defaults: PhaseDefaults | undefined,
): PhaseProviderConfig {
	if (metadata?.phaseProviders) return metadata.phaseProviders;
	const fallback = defaults?.provider ?? metadata?.provider ?? "anthropic";
	return {
		spec: fallback,
		planning: fallback,
		coding: fallback,
		qa: fallback,
	};
}

/**
 * Construit la mise à jour de metadata pour changer le fournisseur (provider)
 * d'une phase.
 *
 * Le provider par phase (`phaseProviders[phase]`) est honoré par le backend
 * quel que soit le profil ; on écrit donc toujours par phase (jamais le provider
 * global, réservé au switch « à chaud »).
 */
export function buildProviderMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	provider: string,
	defaults?: PhaseDefaults,
): Partial<TaskMetadata> {
	const base = basePhaseProviders(metadata, defaults);
	const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
	return { phaseProviders: { ...base, [configPhase]: provider } };
}

interface ModelSelectOption {
	value: string;
	label: string;
	/** Local providers only: model is pulled on the server (vs catalog-only). */
	installed?: boolean;
}

/**
 * Construit les options du sélecteur de modèle d'une phase à partir du catalogue
 * (déjà dédupliqué) et de la valeur actuellement persistée.
 *
 * Le catalogue Anthropic est la **source de vérité unique** : il n'expose qu'une
 * entrée par version (ex. `claude-opus-4-8`). La valeur persistée peut toutefois
 * être écrite différemment pour la même version — notation pointée héritée d'un
 * autre fournisseur (`claude-opus-4.8`), alias court (`opus`) ou snapshot daté.
 * Une comparaison brute par `value` ne reconnaîtrait pas cette équivalence et
 * injecterait un doublon (« claude-opus-4.8 » à côté de « Claude Opus 4.8 »).
 *
 * On compare donc par identité canonique ({@link getCanonicalModelKey}) :
 *  - si la version est déjà dans le catalogue, on ne ré-injecte rien et on pointe
 *    le `<Select>` sur l'entrée canonique du catalogue ({@link resolveCatalogModelValue}),
 *    de sorte que l'étiquette correcte s'affiche sans doublon ;
 *  - sinon (modèle réellement absent, ex. autre fournisseur), on conserve le
 *    filet de sécurité : la valeur courante reste sélectionnable.
 */
export function buildModelSelectOptions(
	catalog: readonly ModelSelectOption[],
	currentValue: string | undefined,
	shortLabels: Record<string, string> = {},
): { options: ModelSelectOption[]; value: string } {
	const options: ModelSelectOption[] = catalog.map((m) => ({
		value: m.value,
		label: m.label,
		installed: m.installed,
	}));
	const current = currentValue ?? "";
	if (!current) return { options, value: current };

	const currentKey = getCanonicalModelKey(current);
	const inCatalog = options.some(
		(m) => getCanonicalModelKey(m.value) === currentKey,
	);

	if (!inCatalog) {
		// Modèle non couvert par le catalogue : le rendre sélectionnable tel quel.
		options.unshift({ value: current, label: shortLabels[current] || current });
		return { options, value: current };
	}

	// Même version déjà présente : on aligne la sélection sur l'entrée du
	// catalogue pour éviter un second élément au libellé brut.
	return { options, value: resolveCatalogModelValue(current, options) };
}
