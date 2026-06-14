import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { SpecInterviewQuestion } from "../shared/types";
import { getOAuthModeClearVars } from "./agent/env-utils";
import { getValidatedPythonPath, parsePythonCommand } from "./python-detector";
import { getConfiguredPythonPath } from "./python-env-manager";
import { getBestAvailableProfileEnv } from "./rate-limit-detector";
import { getAPIProfileEnv } from "./services/profile";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GENERATION_TIMEOUT_MS = 90000;

/**
 * Service generating spec-interview questions: before planning starts, the
 * agent reads the task description and asks 3-5 targeted questions (edge
 * cases, expected behaviours, constraints). Answers are appended to the spec
 * by the renderer, which drastically reduces rejected plans.
 *
 * Follows the TitleGenerator pattern: a one-shot Python subprocess using the
 * Claude Agent SDK, with profile/env handling shared with the rest of the app.
 */
export class SpecInterviewService {
	private _pythonPath: string | null = null;
	private autoBuildSourcePath: string = "";

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

	private get pythonPath(): string {
		return this._pythonPath ?? getConfiguredPythonPath();
	}

	private getAutoBuildSourcePath(): string | null {
		if (this.autoBuildSourcePath && existsSync(this.autoBuildSourcePath)) {
			return this.autoBuildSourcePath;
		}
		const possiblePaths = [
			path.resolve(__dirname, "..", "..", "..", "backend"),
			path.resolve(app.getAppPath(), "..", "backend"),
			path.resolve(process.cwd(), "apps", "backend"),
		];
		for (const p of possiblePaths) {
			if (existsSync(p) && existsSync(path.join(p, "runners", "spec_runner.py"))) {
				return p;
			}
		}
		return null;
	}

	private loadAutoBuildEnv(): Record<string, string> {
		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) return {};
		const envPath = path.join(autoBuildSource, ".env");
		if (!existsSync(envPath)) return {};
		try {
			const envVars: Record<string, string> = {};
			for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eqIndex = trimmed.indexOf("=");
				if (eqIndex > 0) {
					const key = trimmed.substring(0, eqIndex).trim();
					let value = trimmed.substring(eqIndex + 1).trim();
					if (
						(value.startsWith('"') && value.endsWith('"')) ||
						(value.startsWith("'") && value.endsWith("'"))
					) {
						value = value.slice(1, -1);
					}
					envVars[key] = value;
				}
			}
			return envVars;
		} catch {
			return {};
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
		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) return null;

		const script = this.createGenerationScript(description, appLanguage);
		const autoBuildEnv = this.loadAutoBuildEnv();
		const apiProfileEnv = await getAPIProfileEnv();
		const isApiProfileActive = Object.keys(apiProfileEnv).length > 0;
		const profileEnv = isApiProfileActive
			? {}
			: getBestAvailableProfileEnv().env;
		const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);

		return new Promise((resolve) => {
			const [pythonCommand, pythonBaseArgs] = parsePythonCommand(this.pythonPath);
			const child = spawn(pythonCommand, [...pythonBaseArgs, "-c", script], {
				cwd: autoBuildSource,
				env: {
					...process.env,
					...autoBuildEnv,
					...profileEnv,
					...apiProfileEnv,
					...oauthModeClearVars,
					PYTHONUNBUFFERED: "1",
					PYTHONIOENCODING: "utf-8",
					PYTHONUTF8: "1",
				},
			});

			let output = "";
			let errorOutput = "";
			const timeout = setTimeout(() => {
				console.warn("[SpecInterview] Question generation timed out");
				child.kill();
				resolve(null);
			}, GENERATION_TIMEOUT_MS);

			child.stdout?.on("data", (data: Buffer) => {
				output += data.toString("utf-8");
			});
			child.stderr?.on("data", (data: Buffer) => {
				errorOutput += data.toString("utf-8");
			});

			child.on("exit", (code: number | null) => {
				clearTimeout(timeout);
				if (code === 0 && output.trim()) {
					resolve(this.parseQuestions(output));
				} else {
					console.warn("[SpecInterview] Generation failed", {
						code,
						errorOutput: errorOutput.substring(0, 500),
					});
					resolve(null);
				}
			});

			child.on("error", (err) => {
				clearTimeout(timeout);
				console.warn("[SpecInterview] Process error:", err.message);
				resolve(null);
			});
		});
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

	private createGenerationScript(
		description: string,
		appLanguage: string,
	): string {
		const languageName = appLanguage === "fr" ? "French" : "English";
		const prompt = [
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
		const escapedPrompt = JSON.stringify(prompt);

		return `
import asyncio
import sys

async def generate_questions():
    try:
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        prompt = ${escapedPrompt}

        client = ClaudeSDKClient(
            options=ClaudeAgentOptions(
                model="claude-haiku-4-5",
                system_prompt="You output ONLY valid JSON. No prose, no markdown fences.",
                max_turns=1,
            )
        )

        async with client:
            await client.query(prompt)
            response_text = ""
            async for msg in client.receive_response():
                if type(msg).__name__ == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        if type(block).__name__ == "TextBlock" and hasattr(block, "text"):
                            response_text += block.text

            if response_text.strip():
                print(response_text.strip())
                sys.exit(0)
        sys.exit(1)

    except ImportError as e:
        print(f"Import error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

asyncio.run(generate_questions())
`;
	}
}

export const specInterviewService = new SpecInterviewService();
