/**
 * Title-resolution helpers shared by the main-process spec scanner
 * (`ProjectStore.extractTitle`) and the renderer task store
 * (`updateTaskFromPlan`).
 *
 * Both paths can set a kanban card's title from `implementation_plan.json`'s
 * `feature` field, but that field is NOT always a real title:
 *   - The backend auto-fixer (`spec/validate_pkg/auto_fix.py`) falls back to the
 *     `spec_id`, i.e. the slugified spec-folder name ("001-limitation-du-num-ro…"),
 *     which is exactly the worktree directory name we must never show.
 *   - It can be the "Unnamed Feature" placeholder when no title was generated.
 *
 * Keeping the "is this a real title?" rule in one place ensures the scanner and
 * the renderer agree, so a live plan update can't regress a good US/RsD title
 * back to the folder name.
 */

/** Spec-folder slug prefix, e.g. "001-". Such a value is a directory name, not a title. */
const SPEC_ID_PREFIX = /^\d{3}-/;

/** Placeholder written by the backend auto-fixer when a plan has no real feature. */
const PLACEHOLDER_FEATURE = "unnamed feature";

/**
 * True when `feature` is a genuine, human-readable title — not a spec-folder
 * slug, the "Unnamed Feature" placeholder, or empty/whitespace.
 */
export function isMeaningfulFeatureTitle(
	feature: string | null | undefined,
): feature is string {
	if (!feature) {
		return false;
	}
	const trimmed = feature.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (SPEC_ID_PREFIX.test(trimmed)) {
		return false;
	}
	if (trimmed.toLowerCase() === PLACEHOLDER_FEATURE) {
		return false;
	}
	return true;
}
