import { describe, expect, it } from "vitest";
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_PHASE_MODELS,
	DEFAULT_PHASE_THINKING,
} from "../../constants/models";
import type { TaskMetadata } from "../../types";
import type {
	AppSettings,
	PhaseModelConfig,
	PhaseThinkingConfig,
} from "../../types/settings";
import {
	buildModelMetadataUpdate,
	buildProviderMetadataUpdate,
	buildThinkingMetadataUpdate,
	isPerPhaseThinkingTask,
	LOG_PHASE_TO_CONFIG_PHASE,
	resolvePhaseDefaults,
} from "../task-thinking";

const perPhaseMeta: TaskMetadata = {
	isAutoProfile: true,
	phaseModels: { spec: "opus", planning: "opus", coding: "opus", qa: "opus" },
	phaseThinking: {
		spec: "ultrathink",
		planning: "high",
		coding: "low",
		qa: "low",
	},
};

const singleMeta: TaskMetadata = {
	model: "opus",
	thinkingLevel: "medium",
};

describe("LOG_PHASE_TO_CONFIG_PHASE", () => {
	it("mappe planning→spec, coding→coding, validation→qa", () => {
		expect(LOG_PHASE_TO_CONFIG_PHASE.planning).toBe("spec");
		expect(LOG_PHASE_TO_CONFIG_PHASE.coding).toBe("coding");
		expect(LOG_PHASE_TO_CONFIG_PHASE.validation).toBe("qa");
	});
});

describe("isPerPhaseThinkingTask", () => {
	it("détecte un profil par phase", () => {
		expect(isPerPhaseThinkingTask(perPhaseMeta)).toBe(true);
	});

	it("retourne false pour un profil mono-modèle ou metadata absente", () => {
		expect(isPerPhaseThinkingTask(singleMeta)).toBe(false);
		expect(isPerPhaseThinkingTask(undefined)).toBe(false);
	});
});

describe("resolvePhaseDefaults", () => {
	const phaseModelsCopilot: PhaseModelConfig = {
		spec: "claude-opus-4.8",
		planning: "claude-opus-4.8",
		coding: "claude-sonnet-4.6",
		qa: "claude-sonnet-4.6",
	};
	const phaseThinkingCopilot: PhaseThinkingConfig = {
		spec: "high",
		planning: "high",
		coding: "medium",
		qa: "low",
	};

	it("priorise la config par provider (providerPhaseModels[provider])", () => {
		const settings = {
			providerPhaseModels: { copilot: phaseModelsCopilot },
			providerPhaseThinking: { copilot: phaseThinkingCopilot },
		} as unknown as AppSettings;
		const defaults = resolvePhaseDefaults(settings, "copilot");
		expect(defaults.provider).toBe("copilot");
		expect(defaults.phaseModels).toEqual(phaseModelsCopilot);
		expect(defaults.phaseThinking).toEqual(phaseThinkingCopilot);
	});

	it("retombe sur customPhaseModels quand le provider n'a pas de config", () => {
		const custom: PhaseModelConfig = {
			spec: "sonnet",
			planning: "sonnet",
			coding: "sonnet",
			qa: "haiku",
		};
		const settings = {
			customPhaseModels: custom,
		} as unknown as AppSettings;
		const defaults = resolvePhaseDefaults(settings, "anthropic");
		expect(defaults.phaseModels).toEqual(custom);
	});

	it("retombe sur le profil d'agent sélectionné (auto) sans Settings", () => {
		const autoProfile = DEFAULT_AGENT_PROFILES.find((p) => p.id === "auto");
		const defaults = resolvePhaseDefaults(undefined);
		expect(defaults.provider).toBe("anthropic");
		expect(defaults.phaseModels).toEqual(autoProfile?.phaseModels);
		expect(defaults.phaseThinking).toEqual(autoProfile?.phaseThinking);
	});

	it("utilise selectedProvider quand aucun provider explicite", () => {
		const settings = { selectedProvider: "openai" } as unknown as AppSettings;
		expect(resolvePhaseDefaults(settings).provider).toBe("openai");
	});
});

describe("buildThinkingMetadataUpdate", () => {
	it("met à jour uniquement la phase ciblée pour un profil par phase", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "coding", "high");
		expect(update.isAutoProfile).toBe(true);
		expect(update.phaseThinking).toEqual({
			spec: "ultrathink",
			planning: "high",
			coding: "high",
			qa: "low",
		});
		expect(update.thinkingLevel).toBeUndefined();
	});

	it("mappe la phase de logs 'validation' vers la clé 'qa'", () => {
		const update = buildThinkingMetadataUpdate(
			perPhaseMeta,
			"validation",
			"ultrathink",
		);
		expect(update.phaseThinking?.qa).toBe("ultrathink");
		// les autres phases restent inchangées
		expect(update.phaseThinking?.coding).toBe("low");
	});

	it("mappe la phase de logs 'planning' vers la clé 'spec'", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "planning", "none");
		expect(update.phaseThinking?.spec).toBe("none");
	});

	it("bascule une tâche mono-modèle en config par phase (amorcée des défauts)", () => {
		const update = buildThinkingMetadataUpdate(singleMeta, "coding", "high");
		expect(update.isAutoProfile).toBe(true);
		expect(update.thinkingLevel).toBeUndefined();
		expect(update.phaseThinking?.coding).toBe("high");
		// Les autres phases héritent des défauts applicatifs.
		expect(update.phaseThinking?.spec).toBe(DEFAULT_PHASE_THINKING.spec);
	});

	it("amorce les phases non modifiées depuis les défauts fournis", () => {
		const defaults = {
			provider: "copilot",
			phaseModels: DEFAULT_PHASE_MODELS,
			phaseThinking: {
				spec: "high",
				planning: "high",
				coding: "medium",
				qa: "low",
			} as PhaseThinkingConfig,
		};
		const update = buildThinkingMetadataUpdate(
			singleMeta,
			"validation",
			"ultrathink",
			defaults,
		);
		expect(update.phaseThinking?.qa).toBe("ultrathink");
		expect(update.phaseThinking?.coding).toBe("medium");
	});
});

describe("buildModelMetadataUpdate", () => {
	it("met à jour uniquement le modèle de la phase ciblée (profil par phase)", () => {
		const update = buildModelMetadataUpdate(perPhaseMeta, "coding", "sonnet");
		expect(update.isAutoProfile).toBe(true);
		expect(update.phaseModels).toEqual({
			spec: "opus",
			planning: "opus",
			coding: "sonnet",
			qa: "opus",
		});
		expect(update.model).toBeUndefined();
	});

	it("mappe 'validation' vers la clé 'qa'", () => {
		const update = buildModelMetadataUpdate(perPhaseMeta, "validation", "haiku");
		expect(update.phaseModels?.qa).toBe("haiku");
		expect(update.phaseModels?.coding).toBe("opus");
	});

	it("bascule une tâche mono-modèle en config par phase (amorcée des défauts)", () => {
		const update = buildModelMetadataUpdate(singleMeta, "coding", "sonnet");
		expect(update.isAutoProfile).toBe(true);
		expect(update.model).toBeUndefined();
		expect(update.phaseModels?.coding).toBe("sonnet");
		expect(update.phaseModels?.spec).toBe(DEFAULT_PHASE_MODELS.spec);
	});
});

describe("buildProviderMetadataUpdate", () => {
	it("met à jour uniquement le provider de la phase ciblée (profil par phase)", () => {
		const update = buildProviderMetadataUpdate(perPhaseMeta, "coding", "copilot");
		expect(update.phaseProviders).toEqual({
			spec: "anthropic",
			planning: "anthropic",
			coding: "copilot",
			qa: "anthropic",
		});
		expect(update.provider).toBeUndefined();
	});

	it("conserve les providers per-phase existants", () => {
		const meta: TaskMetadata = {
			...perPhaseMeta,
			phaseProviders: {
				spec: "anthropic",
				planning: "openai",
				coding: "anthropic",
				qa: "anthropic",
			},
		};
		const update = buildProviderMetadataUpdate(meta, "validation", "copilot");
		expect(update.phaseProviders).toEqual({
			spec: "anthropic",
			planning: "openai",
			coding: "anthropic",
			qa: "copilot",
		});
	});

	it("écrit toujours par phase pour une tâche mono-modèle (jamais le provider global)", () => {
		const update = buildProviderMetadataUpdate(singleMeta, "coding", "openai");
		expect(update.provider).toBeUndefined();
		expect(update.phaseProviders?.coding).toBe("openai");
		expect(update.phaseProviders?.spec).toBe("anthropic");
	});

	it("amorce les autres phases depuis le provider des défauts fournis", () => {
		const defaults = {
			provider: "copilot",
			phaseModels: DEFAULT_PHASE_MODELS,
			phaseThinking: DEFAULT_PHASE_THINKING,
		};
		const update = buildProviderMetadataUpdate(
			singleMeta,
			"coding",
			"openai",
			defaults,
		);
		expect(update.phaseProviders?.coding).toBe("openai");
		expect(update.phaseProviders?.spec).toBe("copilot");
	});
});
