import type {
	VisualProofNavigationPlan,
	VisualProofNavigationStep,
} from "../shared/types";
import { runOneShotLLM } from "./oneshot-llm";

/** Hard caps so the one-shot prompt stays cheap. */
const MAX_SPEC_CHARS = 6000;
const MAX_CHANGED_FILES = 60;
const MAX_DOM_CANDIDATES = 60;
const MAX_UI_ELEMENTS = 80;
const GENERATION_TIMEOUT_MS = 90000;

const SYSTEM_PROMPT =
	"You output ONLY valid JSON. No prose, no markdown fences.";

/** A real, interactive element discovered on the running web page. */
export interface NavDomCandidate {
	/** Tag name (a, button, input, …). */
	tag: string;
	/** Best CSS selector to target the element. */
	selector: string;
	/** Visible text or accessible label, trimmed. */
	text?: string;
	/** href for links. */
	href?: string;
	/** input type / role hint. */
	type?: string;
}

/** A real UI Automation element discovered on the running desktop app. */
export interface NavUiElement {
	/** The element's visible Name (what `invoke`/`setText` match against). */
	name: string;
	/** Localized control type (button, menu item, edit, tab item, …). */
	controlType?: string;
	/** AutomationId, when present. */
	automationId?: string;
}

export interface NavPlanInput {
	targetKind: "web" | "desktop";
	framework: string;
	/** Working directory (the worktree) — passed to the agent client. */
	projectDir: string;
	/** Spec directory — used to resolve the active provider/model. */
	specDir: string;
	/** Task spec / description text describing the feature that was built. */
	specText?: string;
	/** Files changed by the task (git diff --name-only). */
	changedFiles?: readonly string[];
	/** Real interactive elements collected from the running page (web only). */
	domCandidates?: readonly NavDomCandidate[];
	/** Real UI Automation elements from the running app (desktop only). */
	uiElements?: readonly NavUiElement[];
	/** Target window title (desktop only). */
	windowName?: string;
	appLanguage: string;
}

/**
 * Service generating a visual-proof navigation plan: given the task spec, the
 * diff, the detected framework and (for web) the real DOM of the running app,
 * a one-shot LLM call produces the steps needed to reach the feature that was
 * built so the screenshots show it — instead of falling back to the home page.
 *
 * **Provider-agnostic**: the prompt is built here, but the call goes through
 * {@link runOneShotLLM} → `oneshot_completion_runner.py` →
 * `core.client.create_agent_client`, so whatever provider the user selected
 * (Claude / Copilot / OpenAI / Windsurf / …) is honoured. Always best-effort —
 * returns null on any failure so the caller degrades to a home-page screenshot.
 */
export class VisualProofNavigationService {
	/**
	 * Generate the navigation plan for a single target (web or desktop).
	 * Returns null when generation is impossible or fails (no provider access,
	 * timeout, invalid output); the caller falls back to a home-page screenshot.
	 */
	async generatePlan(
		input: NavPlanInput,
	): Promise<VisualProofNavigationPlan | null> {
		const languageName = input.appLanguage === "fr" ? "French" : "English";
		const text = await runOneShotLLM({
			prompt: buildPrompt(input, languageName),
			systemPrompt: SYSTEM_PROMPT,
			projectDir: input.projectDir,
			specDir: input.specDir,
			timeoutMs: GENERATION_TIMEOUT_MS,
			debugLabel: "VisualProofNavigation",
		});
		if (!text) return null;
		return parseNavigationPlanOutput(text, input.targetKind);
	}
}

function buildPrompt(input: NavPlanInput, languageName: string): string {
	const spec = (input.specText ?? "").slice(0, MAX_SPEC_CHARS).trim();
	const changed = (input.changedFiles ?? []).slice(0, MAX_CHANGED_FILES);

	const lines: string[] = [
		"You are a QA engineer producing a navigation plan that drives a running",
		"application to the exact feature that was just developed, so a screenshot",
		"can prove it works.",
		"",
		`Application framework: ${input.framework}`,
		`Target: ${input.targetKind}`,
		"",
	];

	if (spec) {
		lines.push("Feature specification:", "---", spec, "---", "");
	}
	if (changed.length > 0) {
		lines.push(
			"Files changed by this task (use them to locate the feature's route/screen):",
			changed.map((f) => `- ${f}`).join("\n"),
			"",
		);
	}

	if (input.targetKind === "web") {
		if (input.domCandidates && input.domCandidates.length > 0) {
			lines.push(
				"Interactive elements currently present on the home page (use ONLY these",
				"selectors and hrefs — do not invent selectors that are not listed):",
				JSON.stringify(input.domCandidates.slice(0, MAX_DOM_CANDIDATES)),
				"",
			);
		}
		lines.push(
			"Produce 1 to 4 web steps that navigate to and reveal the feature. Each step is",
			"an object that may contain:",
			'  "path": route relative to the app origin (e.g. "/invoices/new") or an absolute URL,',
			'  "waitForSelector": CSS selector to wait for before continuing,',
			'  "click": CSS selector to click,',
			'  "fill": { "selector": "...", "value": "..." } to type into a field,',
			'  "label": a short screenshot label,',
			'  "delayMs": optional settle time, "capture": false to skip the screenshot.',
			"Prefer a single step that opens the feature's route when one exists. The last",
			"step MUST display the feature. If you cannot determine where the feature lives,",
			'return {"web": []}.',
			"",
			`Write the "label" fields in ${languageName}.`,
			'Output ONLY a JSON object: {"web": [ ...steps ]}. No markdown, no prose.',
		);
	} else {
		if (input.windowName) {
			lines.push(`Target window title: ${input.windowName}`, "");
		}
		if (input.uiElements && input.uiElements.length > 0) {
			lines.push(
				"UI Automation elements currently present in the running app (use ONLY",
				'these exact "name" values for "invoke"/"setText" — do not invent names):',
				JSON.stringify(input.uiElements.slice(0, MAX_UI_ELEMENTS)),
				"",
			);
		}
		lines.push(
			"Produce 1 to 4 desktop steps that navigate the running heavy client (Windows",
			"UI Automation) to the feature. Each step is an object that may contain:",
			'  "invoke": exact visible name of a menu item / button to click,',
			'  "setText": { "name": "...", "value": "..." } to type into a named field,',
			'  "label": a short screenshot label,',
			'  "delayMs": optional settle time, "capture": false to skip the screenshot.',
			"Use control names a user would see. The last step MUST display the feature.",
			'If you cannot determine the navigation, return {"desktop": []}.',
			"",
			`Write the "label" fields in ${languageName}.`,
			'Output ONLY a JSON object: {"desktop": [ ...steps ]}. No markdown, no prose.',
		);
	}

	return lines.join("\n");
}

/**
 * Extract the navigation plan from raw model output (tolerates fences /
 * preamble). Accepts either an object `{ web?, desktop? }` or a bare array of
 * steps, keeps only the steps relevant to the requested target, and drops
 * empty/irrelevant steps. Returns null when nothing usable is found. Exported
 * for unit testing the parsing without spawning the LLM subprocess.
 */
export function parseNavigationPlanOutput(
	raw: string,
	targetKind: "web" | "desktop",
): VisualProofNavigationPlan | null {
	const parsed = extractJson(raw);
	if (parsed === undefined) return null;

	const steps = Array.isArray(parsed)
		? parsed
		: isRecord(parsed)
			? (parsed[targetKind] ?? parsed.steps)
			: undefined;
	if (!Array.isArray(steps)) return null;

	const clean = steps
		.filter(isRecord)
		.map((step) => sanitizeStep(step, targetKind))
		.filter((step): step is VisualProofNavigationStep => step !== null);
	if (clean.length === 0) return null;

	return targetKind === "web" ? { web: clean } : { desktop: clean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Find and parse the first balanced JSON value (object or array) in the text. */
function extractJson(raw: string): unknown {
	const candidates: Array<[number, number]> = [];
	const objStart = raw.indexOf("{");
	const objEnd = raw.lastIndexOf("}");
	if (objStart !== -1 && objEnd > objStart) candidates.push([objStart, objEnd]);
	const arrStart = raw.indexOf("[");
	const arrEnd = raw.lastIndexOf("]");
	if (arrStart !== -1 && arrEnd > arrStart) candidates.push([arrStart, arrEnd]);
	// Prefer whichever bracket appears first in the output.
	candidates.sort((a, b) => a[0] - b[0]);
	for (const [start, end] of candidates) {
		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

/** Keep only the recognised fields for the active target; drop empty steps. */
function sanitizeStep(
	step: Record<string, unknown>,
	targetKind: "web" | "desktop",
): VisualProofNavigationStep | null {
	const out: VisualProofNavigationStep = {};
	if (typeof step.label === "string" && step.label.trim()) {
		out.label = step.label.trim();
	}
	if (typeof step.delayMs === "number" && Number.isFinite(step.delayMs)) {
		out.delayMs = step.delayMs;
	}
	if (step.capture === false) out.capture = false;

	if (targetKind === "web") {
		if (typeof step.path === "string" && step.path.trim()) {
			out.path = step.path.trim();
		}
		if (typeof step.waitForSelector === "string" && step.waitForSelector.trim()) {
			out.waitForSelector = step.waitForSelector.trim();
		}
		if (typeof step.click === "string" && step.click.trim()) {
			out.click = step.click.trim();
		}
		if (
			isRecord(step.fill) &&
			typeof step.fill.selector === "string" &&
			typeof step.fill.value === "string"
		) {
			out.fill = { selector: step.fill.selector, value: step.fill.value };
		}
		const hasAction = out.path || out.click || out.fill || out.waitForSelector;
		return hasAction ? out : null;
	}

	if (typeof step.invoke === "string" && step.invoke.trim()) {
		out.invoke = step.invoke.trim();
	}
	if (
		isRecord(step.setText) &&
		typeof step.setText.name === "string" &&
		typeof step.setText.value === "string"
	) {
		out.setText = { name: step.setText.name, value: step.setText.value };
	}
	const hasAction = out.invoke || out.setText;
	return hasAction ? out : null;
}

export const visualProofNavigationService = new VisualProofNavigationService();
