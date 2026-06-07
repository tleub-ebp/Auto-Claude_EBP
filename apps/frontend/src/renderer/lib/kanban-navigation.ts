/**
 * Utilitaires de navigation entre tâches dans l'ordre du Kanban.
 *
 * Reproduit la logique de regroupement/tri utilisée par `KanbanBoard`
 * (voir `tasksByStatus` dans `KanbanBoard.tsx`) afin de produire une liste
 * plate des tâches dans l'ordre exact où elles apparaissent à l'écran :
 * colonne par colonne (selon `columnOrder`), puis de haut en bas dans chaque
 * colonne (selon `taskOrder`, avec repli sur `createdAt`).
 *
 * Cette liste plate permet de naviguer d'une tâche à l'autre via les chevrons
 * de la popin de détail sans avoir à fermer/rouvrir.
 */
import { TASK_STATUS_COLUMNS } from "../../shared/constants";
import type { TaskStatusColumn } from "../../shared/constants/task";
import type { Task, TaskOrderState, TaskStatus } from "../../shared/types";

/**
 * Détermine la colonne visuelle d'une tâche.
 * Les tâches `pr_created` sont affichées dans la colonne `done`,
 * les tâches `error` dans la colonne `human_review`.
 */
function getVisualColumn(status: TaskStatus): TaskStatusColumn {
	if (status === "pr_created") return "done";
	if (status === "error") return "human_review";
	return status as TaskStatusColumn;
}

function sortByCreatedAtDesc(a: Task, b: Task): number {
	return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/**
 * Trie les tâches d'une colonne selon l'ordre personnalisé du Kanban.
 * Les tâches sans position connue sont placées en tête (les plus récentes
 * d'abord), comme dans `KanbanBoard`.
 */
function sortColumnTasks(
	columnTasks: Task[],
	columnOrder: string[] | undefined,
): Task[] {
	if (!columnOrder || columnOrder.length === 0) {
		return [...columnTasks].sort(sortByCreatedAtDesc);
	}

	const currentTaskIds = new Set(columnTasks.map((t) => t.id));
	const validOrder = columnOrder.filter((id) => currentTaskIds.has(id));
	const validOrderSet = new Set(validOrder);

	const newTasks = columnTasks
		.filter((t) => !validOrderSet.has(t.id))
		.sort(sortByCreatedAtDesc);

	const indexMap = new Map(validOrder.map((id, idx) => [id, idx]));
	const orderedTasks = columnTasks
		.filter((t) => validOrderSet.has(t.id))
		.sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));

	return [...newTasks, ...orderedTasks];
}

/**
 * Retourne la liste plate des tâches dans l'ordre du Kanban.
 *
 * @param tasks - Toutes les tâches du projet.
 * @param taskOrder - Ordre personnalisé par colonne (peut être null).
 * @param columnOrder - Ordre d'affichage des colonnes (peut être vide).
 */
export function getKanbanOrderedTasks(
	tasks: Task[],
	taskOrder: TaskOrderState | null,
	columnOrder: TaskStatusColumn[],
): Task[] {
	const grouped = new Map<TaskStatusColumn, Task[]>();
	for (const column of TASK_STATUS_COLUMNS) {
		grouped.set(column, []);
	}

	for (const task of tasks) {
		const column = getVisualColumn(task.status);
		grouped.get(column)?.push(task);
	}

	const effectiveColumnOrder =
		columnOrder && columnOrder.length > 0
			? columnOrder
			: [...TASK_STATUS_COLUMNS];

	const ordered: Task[] = [];
	for (const column of effectiveColumnOrder) {
		const columnTasks = grouped.get(column);
		if (!columnTasks || columnTasks.length === 0) continue;
		ordered.push(...sortColumnTasks(columnTasks, taskOrder?.[column]));
	}

	return ordered;
}

export interface KanbanSiblings {
	readonly previous: Task | null;
	readonly next: Task | null;
	readonly index: number;
}

/**
 * Retourne les tâches précédente et suivante d'une tâche donnée dans
 * l'ordre du Kanban. La navigation ne boucle pas : aux extrémités, la
 * tâche manquante vaut `null`.
 */
export function getKanbanSiblings(
	orderedTasks: Task[],
	currentTaskId: string | undefined,
): KanbanSiblings {
	if (!currentTaskId) {
		return { previous: null, next: null, index: -1 };
	}

	const index = orderedTasks.findIndex((t) => t.id === currentTaskId);
	if (index === -1) {
		return { previous: null, next: null, index: -1 };
	}

	return {
		previous: index > 0 ? orderedTasks[index - 1] : null,
		next: index < orderedTasks.length - 1 ? orderedTasks[index + 1] : null,
		index,
	};
}
