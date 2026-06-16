import { EventEmitter } from "node:events";
import { getValidatedPythonPath } from "./python-detector";
import { runOneShotLLM } from "./oneshot-llm";

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG =
	process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		console.warn("[TitleGenerator]", ...args);
	}
}

const SYSTEM_PROMPT =
	"You generate short, concise task titles (3-7 words). Output ONLY the title, " +
	"nothing else. No quotes, no explanation, no preamble.";

/**
 * Service for generating task titles from descriptions.
 *
 * Provider-agnostic: the actual completion runs through {@link runOneShotLLM},
 * which honours whatever LLM provider the user selected (Claude / Copilot /
 * OpenAI / Windsurf / …) instead of hardcoding the Claude SDK.
 */
export class TitleGenerator extends EventEmitter {
	private _pythonPath: string | null = null;
	private autoBuildSourcePath = "";

	constructor() {
		super();
		debug("TitleGenerator initialized");
	}

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) {
			this._pythonPath = getValidatedPythonPath(pythonPath, "TitleGenerator");
		}
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Generate a task title from a description.
	 * @returns Promise resolving to the generated title or null on failure
	 */
	async generateTitle(description: string): Promise<string | null> {
		debug(
			"Generating title for description:",
			`${description.substring(0, 100)}...`,
		);

		const text = await runOneShotLLM({
			prompt: this.createTitlePrompt(description),
			systemPrompt: SYSTEM_PROMPT,
			pythonPath: this._pythonPath ?? undefined,
			autoBuildSourcePath: this.autoBuildSourcePath || undefined,
			timeoutMs: 60000,
			rateLimitSource: "title-generator",
			onRateLimit: (info) => this.emit("sdk-rate-limit", info),
			debugLabel: "TitleGenerator",
		});
		if (!text) return null;

		const title = this.cleanTitle(text);
		debug("Generated title:", title);
		return title;
	}

	/**
	 * Create the prompt for title generation
	 */
	private createTitlePrompt(description: string): string {
		return `Generate a short, concise task title (3-7 words) for the following task description. The title should be action-oriented and describe what will be done. Output ONLY the title, nothing else.

Description:
${description}

Title:`;
	}

	/**
	 * Clean up the generated title
	 */
	private cleanTitle(title: string): string {
		// Title may arrive multi-line; keep the first non-empty line.
		let cleaned = title.split("\n")[0]?.trim() ?? "";

		// Remove quotes if present
		cleaned = cleaned.replaceAll(/^["']|["']$/g, "");

		// Remove any "Title:" or similar prefixes
		cleaned = cleaned.replace(/^(title|task|feature)[:\s]*/i, "");

		// Capitalize first letter
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

		// Truncate if too long (max 100 chars)
		if (cleaned.length > 100) {
			cleaned = `${cleaned.substring(0, 97)}...`;
		}

		return cleaned.trim();
	}
}

// Export singleton instance
export const titleGenerator = new TitleGenerator();
