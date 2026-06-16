import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	hasExecutionFormula,
	isDuplicatedTask,
	needsExecutionFormula,
} from "../../../shared/utils/task-execution-config";
import { useFormulaMatrixStore } from "../../stores/formula-matrix-store";
import { useProjectStore } from "../../stores/project-store";
import { FormulaBadge } from "../formula-lab/FormulaBadge";
import { Button } from "../ui/button";

/**
 * Pré-requis « Provider × LLM × Effort » proposé en haut de l'onglet Vue
 * d'ensemble pour les tâches importées (Azure DevOps, Jira, Linear, GitHub,
 * GitLab…) ou dupliquées, tant qu'aucune formule n'a été choisie.
 *
 * Calqué sur {@link SpecInterviewBanner}. Le choix réutilise le Formula Lab
 * (ouvert via `openLab`) ; une fois une formule appliquée, la bannière se replie
 * en résumé compact réutilisant {@link FormulaBadge}.
 */
export function ExecutionFormulaBanner({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const [dismissed, setDismissed] = useState(false);
	const openLab = useFormulaMatrixStore((s) => s.openLab);

	// Project path is required so the Formula Lab can scope its estimate.
	const projects = useProjectStore((state) => state.projects);
	const projectPath = useMemo(
		() => projects.find((p) => p.id === task.projectId)?.path,
		[projects, task.projectId],
	);

	const openFormulaLab = () =>
		openLab({
			ticketId: task.id,
			ticketTitle: task.title,
			description: task.description,
			projectPath,
		});

	const isPreRun = task.status === "backlog" || task.status === "queue";

	// Already configured → compact applied summary (only while still pre-run, to
	// avoid duplicating the kanban badge once the task is running/done).
	if (isPreRun && hasExecutionFormula(task)) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
				<div className="flex min-w-0 items-center gap-2">
					<span className="shrink-0 text-sm text-muted-foreground">
						{t("tasks:executionFormula.appliedLabel")}
					</span>
					<FormulaBadge task={task} projectPath={projectPath} />
				</div>
				<Button size="sm" variant="ghost" onClick={openFormulaLab}>
					{t("tasks:executionFormula.editButton")}
				</Button>
			</div>
		);
	}

	if (dismissed || !needsExecutionFormula(task)) return null;

	const message = isDuplicatedTask(task)
		? t("tasks:executionFormula.bannerDuplicated")
		: t("tasks:executionFormula.bannerImported");

	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
			<div className="flex min-w-0 items-center gap-2">
				<Sparkles className="h-4 w-4 shrink-0 text-primary" />
				<p className="text-sm text-muted-foreground">{message}</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
					{t("tasks:executionFormula.dismiss")}
				</Button>
				<Button size="sm" variant="outline" onClick={openFormulaLab}>
					{t("tasks:executionFormula.chooseButton")}
				</Button>
			</div>
		</div>
	);
}
