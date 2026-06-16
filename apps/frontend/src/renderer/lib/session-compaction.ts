import type { Subtask, SubtaskStatus, Task } from "../../shared/types";

/**
 * Session Compaction: selective reduction of long task histories.
 *
 * Best practice (2026): drop low-value intermediate phases while preserving the
 * high-value state — the first/last steps, anything that failed, and explicit
 * verification/review steps — into a structured handoff that survives a session
 * reset. This module is the data layer; `SessionCompactionBadge` renders it.
 */

/** Display buckets we collapse the five raw subtask statuses into. */
export type CompactedStatus = "completed" | "failed" | "in_progress" | "pending";

export interface CompactedPhase {
	/** 1-indexed position in the original subtask list (for display). */
	index: number;
	title: string;
	status: CompactedStatus;
	/** Why the step is worth keeping (drives the "critical" highlight). */
	critical: boolean;
	/** Failure detail, from the subtask's blockedReason. */
	failureReason?: string;
}

export interface SessionHandoff {
	totalPhases: number;
	completedPhases: number;
	failedPhases: number;
	/** Completion ratio in [0, 100], derived from completed / total. */
	completionPercent: number;
	criticalPhases: CompactedPhase[];
	lastFailure?: CompactedPhase;
	contextSummary: string;
}

/** Steps whose titles mention these are kept verbatim — they carry decisions. */
const CRITICAL_PHASE_KEYWORDS = [
	"test",
	"review",
	"merge",
	"deploy",
	"migration",
	"security",
	"breaking",
	"rollback",
];

/** Below this many subtasks there is nothing to compact — show the raw list. */
export const MIN_PHASES_TO_COMPACT = 10;

/** Keep at least this share of steps as "critical" context. */
const CRITICAL_PHASE_SHARE = 0.25;

/** Collapse the five raw statuses into the four display buckets. */
function normalizeStatus(status: SubtaskStatus): CompactedStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "failed":
		case "blocked":
			return "failed";
		case "in_progress":
			return "in_progress";
		default:
			return "pending";
	}
}

/** A step is critical if it failed or its title names a decision/verification. */
function isCriticalPhase(subtask: Subtask): boolean {
	if (subtask.status === "failed" || subtask.status === "blocked") return true;
	const title = subtask.title.toLowerCase();
	return CRITICAL_PHASE_KEYWORDS.some((kw) => title.includes(kw));
}

function toCompactedPhase(subtask: Subtask, idx: number): CompactedPhase {
	return {
		index: idx + 1,
		title: subtask.title,
		status: normalizeStatus(subtask.status),
		critical: isCriticalPhase(subtask),
		failureReason: subtask.blockedReason,
	};
}

/**
 * Compact a task's execution history. Returns `null` for short tasks (nothing to
 * compact) so callers can cheaply gate the UI on a truthy result.
 */
export function compactSessionHistory(task: Task): SessionHandoff | null {
	const subtasks = task.subtasks ?? [];
	if (subtasks.length < MIN_PHASES_TO_COMPACT) return null;

	const total = subtasks.length;
	const completedPhases = subtasks.filter(
		(s) => s.status === "completed",
	).length;
	const failedPhases = subtasks.filter(
		(s) => s.status === "failed" || s.status === "blocked",
	).length;

	// 1. Always keep failures + decision/verification steps.
	const keep = new Set<number>();
	subtasks.forEach((s, idx) => {
		if (isCriticalPhase(s)) keep.add(idx);
	});

	// 2. Anchor with the first and last step for trajectory context.
	keep.add(0);
	keep.add(total - 1);

	// 3. Backfill with the most recent steps until we hit the target share, so a
	//    long but uneventful run still shows where it currently stands.
	const target = Math.max(keep.size, Math.ceil(total * CRITICAL_PHASE_SHARE));
	for (let i = total - 1; i >= 0 && keep.size < target; i--) {
		keep.add(i);
	}

	const criticalPhases = Array.from(keep)
		.sort((a, b) => a - b)
		.map((idx) => toCompactedPhase(subtasks[idx], idx));

	// Last failure, scanning from the end.
	let lastFailure: CompactedPhase | undefined;
	for (let i = total - 1; i >= 0; i--) {
		const s = subtasks[i];
		if (s.status === "failed" || s.status === "blocked") {
			lastFailure = toCompactedPhase(s, i);
			break;
		}
	}

	const completionPercent = Math.round((completedPhases / total) * 100);

	const contextSummary =
		`${completedPhases}/${total} phases completed` +
		(failedPhases > 0 ? `, ${failedPhases} need attention` : ", no failures") +
		(lastFailure
			? `. Last issue at phase ${lastFailure.index}: ${lastFailure.title}`
			: ".");

	return {
		totalPhases: total,
		completedPhases,
		failedPhases,
		completionPercent,
		criticalPhases,
		lastFailure,
		contextSummary,
	};
}

/**
 * One-line context string suitable for injection into a fresh LLM session when
 * a long task is resumed after a context reset.
 */
export function injectCompactionContext(handoff: SessionHandoff): string {
	const points = handoff.criticalPhases
		.map((p) => `#${p.index} ${p.title}`)
		.join("; ");
	return `[Session handoff] ${handoff.contextSummary} Key steps: ${points}`;
}
