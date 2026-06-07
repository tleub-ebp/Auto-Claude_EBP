import { describe, expect, it } from "vitest";
import type { TaskMetadata } from "../../types";
import {
	buildThinkingMetadataUpdate,
	isPerPhaseThinkingTask,
	LOG_PHASE_TO_CONFIG_PHASE,
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

describe("buildThinkingMetadataUpdate", () => {
	it("met à jour uniquement la phase ciblée pour un profil par phase", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "coding", "high");
		expect(update.phaseThinking).toEqual({
			spec: "ultrathink",
			planning: "high",
			coding: "high",
			qa: "low",
		});
		expect(update.thinkingLevel).toBeUndefined();
	});

	it("mappe la phase de logs 'validation' vers la clé 'qa'", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "validation", "ultrathink");
		expect(update.phaseThinking?.qa).toBe("ultrathink");
		// les autres phases restent inchangées
		expect(update.phaseThinking?.coding).toBe("low");
	});

	it("mappe la phase de logs 'planning' vers la clé 'spec'", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "planning", "none");
		expect(update.phaseThinking?.spec).toBe("none");
	});

	it("met à jour le thinkingLevel global pour un profil mono-modèle", () => {
		const update = buildThinkingMetadataUpdate(singleMeta, "coding", "high");
		expect(update.thinkingLevel).toBe("high");
		expect(update.phaseThinking).toBeUndefined();
	});
});
