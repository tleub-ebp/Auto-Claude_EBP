/**
 * Board-level cost forecast.
 *
 * Each ticket can carry a Formula Lab selection (`metadata.appliedFormula`)
 * with an expected USD cost. Summing those across the non-terminal columns
 * gives a live "what is this board about to spend" figure, split into work
 * already running vs. work still queued.
 */

import type { Task, TaskStatus } from "../../shared/types";

export interface BoardCostForecast {
	/** Sum of expected cost over all non-terminal tickets that have a formula. */
	totalUsd: number;
	/** Subtotal for in-flight work (in_progress + ai_review). */
	activeUsd: number;
	/** Subtotal for not-yet-started work (backlog + queue). */
	pendingUsd: number;
	/** Count of non-terminal tickets carrying a cost estimate. */
	withFormula: number;
	/** Count of non-terminal tickets with no estimate (cost unknown). */
	withoutFormula: number;
}

// Terminal columns: their cost is already spent / irrelevant to a forecast.
const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "pr_created"]);
const ACTIVE: ReadonlySet<TaskStatus> = new Set(["in_progress", "ai_review"]);
const PENDING: ReadonlySet<TaskStatus> = new Set(["backlog", "queue"]);

export function computeBoardCostForecast(tasks: Task[]): BoardCostForecast {
	let totalUsd = 0;
	let activeUsd = 0;
	let pendingUsd = 0;
	let withFormula = 0;
	let withoutFormula = 0;

	for (const task of tasks) {
		if (TERMINAL.has(task.status)) continue;
		const cost = task.metadata?.appliedFormula?.expectedCostUsd;
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
			withFormula++;
			totalUsd += cost;
			if (ACTIVE.has(task.status)) activeUsd += cost;
			else if (PENDING.has(task.status)) pendingUsd += cost;
		} else {
			withoutFormula++;
		}
	}

	return { totalUsd, activeUsd, pendingUsd, withFormula, withoutFormula };
}
