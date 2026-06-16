import type { SpecInterviewQuestion } from "../shared/types";
import { getValidatedPythonPath } from "./python-detector";
import { runOneShotLLM } from "./oneshot-llm";

const GENERATION_TIMEOUT_MS = 90000;

const SYSTEM_PROMPT =
	"You output ONLY valid JSON. No prose, no markdown fences.";

/**
 * Service generating spec-interview questions: before planning starts, the
 * agent reads the task description and asks 3-5 targeted questions (edge
 * cases, expected behaviours, constraints). Answers are appended to the spec
 * by the renderer, which drastically reduces rejected plans.
 *
 * Provider-agnostic: the completion runs through {@link runOneShotLLM}, which
 * honours whatever LLM provider the user selected (Claude / Copilot / OpenAI /
 * Windsurf / …) instead of hardcoding the Claude SDK.
 */
export class SpecInterviewService {
	private _pythonPath: string | null = null;
	private autoBuildSourcePath = "";

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) {
			this._pythonPath = getValidatedPythonPath(
				pythonPath,
				"SpecInterviewService",
			);
		}
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Generate 3-5 clarifying questions for a task description.
	 * Returns null when generation fails (no API access, timeout, bad output);
	 * the caller should degrade gracefully — the interview is always optional.
	 */
	async generateQuestions(
		description: string,
		appLanguage: string,
	): Promise<SpecInterviewQuestion[] | null> {
		const text = await runOneShotLLM({
			prompt: this.buildPrompt(description, appLanguage),
			systemPrompt: SYSTEM_PROMPT,
			pythonPath: this._pythonPath ?? undefined,
			autoBuildSourcePath: this.autoBuildSourcePath || undefined,
			timeoutMs: GENERATION_TIMEOUT_MS,
			debugLabel: "SpecInterview",
		});
		if (!text) return null;
		return this.parseQuestions(text);
	}

	/** Extract the JSON array from the model output (tolerates fences/preamble). */
	private parseQuestions(raw: string): SpecInterviewQuestion[] | null {
		const start = raw.indexOf("[");
		const end = raw.lastIndexOf("]");
		if (start === -1 || end === -1 || end <= start) return null;
		try {
			const parsed = JSON.parse(raw.slice(start, end + 1));
			if (!Array.isArray(parsed)) return null;
			const questions = parsed
				.filter(
					(item): item is Record<string, unknown> =>
						typeof item === "object" && item !== null,
				)
				.map((item, index) => ({
					id: `q${index + 1}`,
					question: String(item.question ?? "").trim(),
					rationale:
						typeof item.rationale === "string" && item.rationale.trim()
							? item.rationale.trim()
							: undefined,
					suggestion:
						typeof item.suggestion === "string" && item.suggestion.trim()
							? item.suggestion.trim()
							: undefined,
				}))
				.filter((question) => question.question.length > 0)
				.slice(0, 5);
			return questions.length > 0 ? questions : null;
		} catch {
			return null;
		}
	}

	private buildPrompt(description: string, appLanguage: string): string {
		const languageName = appLanguage === "fr" ? "French" : "English";
		return [
			"You are a senior software analyst preparing the implementation of a task.",
			"Read the task specification below and produce the 3 to 5 most valuable",
			"clarifying questions to ask BEFORE planning the implementation.",
			"Focus on: edge cases, expected behaviours, validation rules, error handling,",
			"impacted surfaces, and acceptance criteria that are ambiguous or missing.",
			"Do NOT ask anything already answered by the spec. Prefer questions whose",
			"answer changes the implementation.",
			"",
			`Write the questions in ${languageName}.`,
			"Output ONLY a JSON array, no markdown fences, with objects of the shape:",
			'[{"question": "...", "rationale": "why this matters (short)", "suggestion": "a plausible default answer (short)"}]',
			"",
			"Task specification:",
			"---",
			description,
			"---",
		].join("\n");
	}
}

export const specInterviewService = new SpecInterviewService();
