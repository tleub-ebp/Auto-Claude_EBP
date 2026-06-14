import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	TASK_STATUS_COLUMNS,
	TASK_STATUS_LABELS,
	type TaskStatusColumn,
} from "../../../shared/constants";
import type { Task, TaskStatus } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Badge, type BadgeProps } from "../ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * Couleur de la pastille par colonne cible (design-system tokens).
 * Permet d'identifier visuellement la destination dans le menu "Déplacer vers".
 */
const STATUS_DOT_CLASS: Record<TaskStatusColumn, string> = {
	backlog: "bg-muted-foreground/60",
	queue: "bg-cyan-400",
	in_progress: "bg-info",
	ai_review: "bg-warning",
	human_review: "bg-purple-400",
	build_failed: "bg-destructive",
	done: "bg-success",
};

interface TaskStatusMoveBadgeProps {
	readonly task: Task;
	readonly variant: BadgeProps["variant"];
	readonly isRunning: boolean;
	readonly onMove: (newStatus: TaskStatus) => void;
	/**
	 * Libellé affiché à la place du nom de la colonne courante.
	 * Utilisé pour les états spéciaux (« Bloqué », « Incomplet ») afin de
	 * conserver leur sémantique visuelle tout en gardant le menu de déplacement.
	 */
	readonly label?: ReactNode;
	/** Icône optionnelle affichée avant le libellé (ex. triangle d'alerte). */
	readonly leadingIcon?: ReactNode;
	/** Anime la pastille pour signaler un état nécessitant une attention. */
	readonly pulse?: boolean;
}

/**
 * Badge de statut interactif du header de la modale de détail.
 *
 * Le badge EST le sélecteur de colonne : bordure permanente + chevron pour
 * signaler qu'il est cliquable, surbrillance au survol et tooltip explicite.
 * Au clic, il propose de déplacer la tâche vers une autre colonne du Kanban —
 * équivalent du menu « Déplacer vers » des cartes, sans alourdir l'en-tête.
 *
 * Les états spéciaux (Bloqué / Incomplet) réutilisent ce même badge via les
 * props `label`/`leadingIcon`/`pulse`, pour rester déplaçables.
 */
export function TaskStatusMoveBadge({
	task,
	variant,
	isRunning,
	onMove,
	label,
	leadingIcon,
	pulse = false,
}: TaskStatusMoveBadgeProps) {
	const { t } = useTranslation(["tasks"]);

	const targets = TASK_STATUS_COLUMNS.filter(
		(status) => status !== task.status,
	);

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={t("tasks:modal.move.trigger")}
							className="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						>
							<Badge
								variant={variant}
								className={cn(
									// Bordure permanente + transition : le badge se lit comme un menu déroulant
									"text-xs gap-1 cursor-pointer ring-1 ring-border/60 transition-all group-hover:ring-border group-hover:brightness-110 group-data-[state=open]:ring-border group-data-[state=open]:brightness-110",
									pulse
										? "animate-pulse"
										: task.status === "in_progress" &&
												isRunning &&
												"status-running",
								)}
							>
								{leadingIcon}
								{label ?? t(TASK_STATUS_LABELS[task.status])}
								<ChevronDown className="h-3 w-3 opacity-70 transition-all group-hover:opacity-100 group-data-[state=open]:rotate-180" />
							</Badge>
						</button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{t("tasks:modal.move.trigger")}
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="start" className="min-w-[11rem]">
				<DropdownMenuLabel className="text-xs text-muted-foreground">
					{t("tasks:modal.move.label")}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{targets.map((status) => (
					<DropdownMenuItem
						key={status}
						className="gap-2 cursor-pointer"
						onClick={() => onMove(status)}
					>
						<span
							className={cn(
								"h-2 w-2 shrink-0 rounded-full",
								STATUS_DOT_CLASS[status],
							)}
						/>
						{t(TASK_STATUS_LABELS[status])}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
