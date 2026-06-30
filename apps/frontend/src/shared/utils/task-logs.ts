import type { TaskLogPhase, TaskLogs } from "../types";

/**
 * Canonical render/run order of the log phases. The logs view renders phase
 * sections in this fixed order (planning at the top, validation at the
 * bottom) regardless of which one is currently running.
 */
export const LOG_PHASE_ORDER: readonly TaskLogPhase[] = [
	"planning",
	"coding",
	"validation",
];

/**
 * Return the phase whose status is "active" (currently running), or null.
 *
 * Why this matters for scrolling: phases render in {@link LOG_PHASE_ORDER}, so
 * the newest activity is NOT necessarily at the bottom of the document. When a
 * task regresses (e.g. validation → planning), planning becomes active again
 * but its section sits at the TOP — anchoring auto-scroll to the document end
 * would leave the viewport on the stale validation logs. The logs view uses
 * this to anchor on the active phase instead.
 */
export function getActiveLogPhase(
	phaseLogs: TaskLogs | null | undefined,
): TaskLogPhase | null {
	if (!phaseLogs) return null;
	return (
		LOG_PHASE_ORDER.find(
			(phase) => phaseLogs.phases[phase]?.status === "active",
		) ?? null
	);
}
