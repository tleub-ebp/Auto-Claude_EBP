import { describe, expect, it } from "vitest";
import type { HuggingFaceModelInfo } from "../../types/mcp-marketplace";
import { assessHfModel, parseParamBillions } from "../hf-model-suitability";

const mk = (id: string, pipelineTag?: string): HuggingFaceModelInfo =>
	({ id, pipelineTag }) as HuggingFaceModelInfo;

describe("parseParamBillions", () => {
	it("parses sizes; ignores version numbers and GB file sizes", () => {
		expect(parseParamBillions("deepreinforce-ai/Ornith-1.0-35B-GGUF")).toBe(35);
		expect(parseParamBillions("yuxinlu1/gemma-4-12B-agentic")).toBe(12);
		expect(parseParamBillions("unsloth/GLM-5.2-GGUF")).toBeNull();
		expect(parseParamBillions("Org/foo-7B-Q4_K_M-3.5GB")).toBe(7);
	});

	it("MoE: reads ACTIVE params, not total (a 30B-A3B behaves like ~3B)", () => {
		expect(parseParamBillions("Org/Qwen3-30B-A3B-Instruct-GGUF")).toBe(3);
		expect(parseParamBillions("Org/Qwen3-235B-A22B")).toBe(22);
	});
});

describe("assessHfModel", () => {
	it("good = agentic family/keyword AND ≥24B", () => {
		expect(assessHfModel(mk("Org/Qwen2.5-32B-Instruct-GGUF")).verdict).toBe(
			"good",
		);
		expect(assessHfModel(mk("Org/llama3.3-70B-instruct")).verdict).toBe("good");
	});

	it("ok = agentic but small (<24B), incl. small-active MoE", () => {
		expect(
			assessHfModel(mk("yuxinlu1/gemma-4-12B-agentic-composer")).verdict,
		).toBe("ok");
		expect(assessHfModel(mk("Org/qwen2.5-coder-7b")).verdict).toBe("ok");
		// 30B total but 3B active → effectively small.
		expect(assessHfModel(mk("Org/Qwen3-30B-A3B-Instruct")).verdict).toBe("ok");
	});

	it("27B coder is Recommandé (threshold 24), no longer 'trop petit'", () => {
		expect(
			assessHfModel(mk("Jackrong/Qwopus3.6-27B-Coder-MTP-GGUF")).verdict,
		).toBe("good");
	});

	it("unsuitable = embedding or tiny", () => {
		expect(assessHfModel(mk("Org/bge-large-en")).verdict).toBe("unsuitable");
		expect(assessHfModel(mk("x/y", "feature-extraction")).verdict).toBe(
			"unsuitable",
		);
		expect(assessHfModel(mk("Org/some-1B-model")).verdict).toBe("unsuitable");
	});

	it("uncertain = unknown family + no agentic signal (even if big)", () => {
		expect(
			assessHfModel(mk("deepreinforce-ai/Ornith-1.0-35B-GGUF")).verdict,
		).toBe("uncertain");
	});
});
