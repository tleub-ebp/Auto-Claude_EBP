/**
 * Extract the list of files impacted by a subtask from an implementation plan.
 *
 * There are two notions of "impacted files" on a subtask:
 *  - `files_changed`: the *actual* git diff recorded by the backend once the
 *    subtask completes (ground truth — see `_persist_subtask_changed_files` in
 *    apps/backend/agents/session.py).
 *  - `files_to_modify` / `files_to_create`: the planner's *prediction* made
 *    before any code is written. These are frequently empty or inaccurate.
 *
 * We prefer the ground-truth `files_changed` when present so a completed
 * subtask shows what it really touched, and fall back to the prediction while
 * the subtask is still pending/in-progress (no diff exists yet).
 *
 * The backend stores all of these under snake_case keys, NOT under a single
 * `files` field, while the UI `Subtask` model exposes a flat `files: string[]`.
 * Without this normalization the per-subtask "files modified" view is always
 * empty even though the plan does carry the data. `files` is kept as a fallback
 * for any legacy or manually edited subtask. The result is order-preserving and
 * de-duplicated.
 */
export function extractSubtaskFiles(subtask: {
	files?: unknown;
	files_changed?: unknown;
	files_to_modify?: unknown;
	files_to_create?: unknown;
}): string[] {
	const toStringArray = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];

	// Ground truth (actual git diff) takes precedence once it exists.
	const actual = toStringArray(subtask.files_changed);
	if (actual.length > 0) {
		return [...new Set(actual)];
	}

	// Otherwise fall back to the planner's prediction (modify first, then create)
	// and any legacy flat `files` field.
	const predicted = [
		...toStringArray(subtask.files_to_modify),
		...toStringArray(subtask.files_to_create),
		...toStringArray(subtask.files),
	];

	// De-duplicate while preserving first-seen order.
	return [...new Set(predicted)];
}
