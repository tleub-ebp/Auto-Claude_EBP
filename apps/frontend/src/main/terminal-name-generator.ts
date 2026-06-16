import { EventEmitter } from "node:events";
import { runOneShotLLM } from "./oneshot-llm";
import { pythonEnvManager } from "./python-env-manager";

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG =
	process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		console.warn("[TerminalNameGenerator]", ...args);
	}
}

const SYSTEM_PROMPT =
	"You generate very short, concise terminal names (2-3 words MAX). Output ONLY " +
	"the name, nothing else. No quotes, no explanation, no preamble. Keep it as " +
	"short as possible while being descriptive.";

/**
 * Service for generating terminal names from commands.
 *
 * Provider-agnostic: the actual completion runs through {@link runOneShotLLM},
 * which honours whatever LLM provider the user selected (Claude / Copilot /
 * OpenAI / Windsurf / …) instead of hardcoding the Claude SDK.
 */
export class TerminalNameGenerator extends EventEmitter {
	private autoBuildSourcePath = "";

	constructor() {
		super();
		debug("TerminalNameGenerator initialized");
	}

	configure(autoBuildSourcePath?: string): void {
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Generate a terminal name from a command.
	 * @param command - The command or recent output to generate a name from
	 * @param cwd - Current working directory for context
	 * @returns Promise resolving to the generated name (2-3 words) or null on failure
	 */
	async generateName(command: string, cwd?: string): Promise<string | null> {
		// Ensure the bundled Python env (with the SDK) is ready, then use its
		// interpreter so the provider clients' dependencies resolve.
		if (!pythonEnvManager.isEnvReady()) {
			debug("Python environment not ready, initializing...");
			const status = await pythonEnvManager.initialize(this.autoBuildSourcePath);
			if (!status.ready) {
				debug("Python environment initialization failed:", status.error);
				return null;
			}
		}
		const venvPythonPath = pythonEnvManager.getPythonPath() ?? undefined;

		debug(
			"Generating terminal name for command:",
			`${command.substring(0, 100)}...`,
		);

		const text = await runOneShotLLM({
			prompt: this.createNamePrompt(command, cwd),
			systemPrompt: SYSTEM_PROMPT,
			pythonPath: venvPythonPath,
			autoBuildSourcePath: this.autoBuildSourcePath || undefined,
			timeoutMs: 30000,
			rateLimitSource: "other",
			onRateLimit: (info) => this.emit("sdk-rate-limit", info),
			debugLabel: "TerminalNameGenerator",
		});
		if (!text) return null;

		const name = this.cleanName(text);
		debug("Generated terminal name:", name);
		return name;
	}

	/**
	 * Create the prompt for terminal name generation
	 */
	private createNamePrompt(command: string, cwd?: string): string {
		let prompt = `Generate a very short, descriptive name (2-3 words MAX) for a terminal window based on what it's doing. The name should be concise and help identify the terminal at a glance.

Command or activity:
${command}`;

		if (cwd) {
			prompt += `

Working directory:
${cwd}`;
		}

		prompt += `

Output ONLY the name (2-3 words), nothing else. Examples: "npm build", "git logs", "python tests", "claude dev"`;

		return prompt;
	}

	/**
	 * Clean up the generated name
	 */
	private cleanName(name: string): string {
		// Name may arrive multi-line; keep the first non-empty line.
		let cleaned = name.split("\n")[0]?.trim() ?? "";

		// Remove quotes if present
		cleaned = cleaned.replaceAll(/^["']|["']$/g, "");

		// Remove any "Terminal:" or similar prefixes
		cleaned = cleaned.replace(/^(terminal|name)[:\s]*/i, "");

		// Truncate if too long (max 30 chars for terminal names)
		if (cleaned.length > 30) {
			cleaned = `${cleaned.substring(0, 27)}...`;
		}

		return cleaned.trim();
	}
}

// Export singleton instance
export const terminalNameGenerator = new TerminalNameGenerator();
