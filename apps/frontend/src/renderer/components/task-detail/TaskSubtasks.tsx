import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	ChevronRight,
	Clock,
	Code2,
	Edit3,
	FileCode,
	ListChecks,
	MessageSquarePlus,
	Plus,
	Trash2,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Subtask, Task } from "../../../shared/types";
import { calculateProgress, cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PlanApprovalSection } from "./PlanApprovalSection";
import { TaskCodeEditor } from "./TaskCodeEditor";
import { TaskResetButton } from "./TaskResetButton";
import { SubtaskFilesViewer } from "./SubtaskFilesViewer";

interface Phase {
	name: string;
	subtasks: Array<{
		id: string;
		title?: string;
		description?: string;
		status: "pending" | "in_progress" | "completed" | "blocked" | "failed";
		files?: string[];
		blockedReason?: string;
		verification?: {
			type: "command" | "browser";
			run?: string;
			scenario?: string;
		};
	}>;
}

interface TaskSubtasksProps {
	readonly task: Task;
	readonly onUpdatePlan?: (phases: Phase[]) => Promise<void>;
}

function getSubtaskStatusIcon(status: string) {
	switch (status) {
		case "completed":
			return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
		case "in_progress":
			return <Clock className="h-4 w-4 text-[var(--info)] animate-pulse" />;
		case "blocked":
			// Counts as "done" for progress, but the agent gave up — flag it amber
			// so it reads as "needs attention", never as a clean (green) pass.
			return <AlertTriangle className="h-4 w-4 text-amber-500" />;
		case "failed":
			return <XCircle className="h-4 w-4 text-[var(--error)]" />;
		default:
			return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
	}
}

function getStatusBadgeClass(status: string): string {
	switch (status) {
		case "completed":
			return "bg-success/20 text-success";
		case "in_progress":
			return "bg-info/20 text-info";
		case "blocked":
			return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
		case "failed":
			return "bg-destructive/20 text-destructive";
		default:
			return "bg-muted text-muted-foreground";
	}
}

export function TaskSubtasks({ task, onUpdatePlan }: TaskSubtasksProps) {
	const { t } = useTranslation(["tasks"]);
	const [isEditing, setIsEditing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [selectedSubtaskForCodeEdit, setSelectedSubtaskForCodeEdit] =
		useState<Subtask | null>(null);
	const [selectedSubtaskForFilesView, setSelectedSubtaskForFilesView] =
		useState<Subtask | null>(null);
	const [editedPhases, setEditedPhases] = useState<Phase[]>(
		task.subtasks.length > 0
			? [
					{
						name: "Implementation",
						subtasks: task.subtasks,
					},
				]
			: [],
	);

	const progress = calculateProgress(task.subtasks);
	const completedCount = task.subtasks.filter(
		(s) => s.status === "completed",
	).length;
	const blockedCount = task.subtasks.filter(
		(s) => s.status === "blocked",
	).length;
	const failedCount = task.subtasks.filter((s) => s.status === "failed").length;

	const handleCodeEditorUpdate = async (updatedSubtask: Subtask) => {
		// Update the subtask in editedPhases
		const newPhases = editedPhases.map((phase) => ({
			...phase,
			subtasks: phase.subtasks.map((s) =>
				s.id === updatedSubtask.id ? updatedSubtask : s,
			),
		}));
		setEditedPhases(newPhases);

		// Call onUpdatePlan to save
		if (onUpdatePlan) {
			await onUpdatePlan(newPhases);
		}

		setSelectedSubtaskForCodeEdit(null);
	};

	async function handleSaveChanges() {
		if (!onUpdatePlan) return;

		setIsSaving(true);
		try {
			const phases = editedPhases.map((phase) => ({
				name: phase.name,
				subtasks: phase.subtasks,
			}));

			await onUpdatePlan(phases);
			setIsEditing(false);
		} catch (error) {
			console.error("Failed to save changes:", error);
		} finally {
			setIsSaving(false);
		}
	}

	function handleDeleteSubtask(phaseIndex: number, subtaskIndex: number) {
		const newPhases = [...editedPhases];
		newPhases[phaseIndex].subtasks.splice(subtaskIndex, 1);

		// Remove empty phases
		setEditedPhases(newPhases.filter((phase) => phase.subtasks.length > 0));
	}

	function handleAddSubtask(phaseIndex: number) {
		const newPhases = [...editedPhases];
		newPhases[phaseIndex].subtasks.push({
			id: `new-${Date.now()}`,
			title: "",
			description: "",
			status: "pending",
			files: [],
		});
		setEditedPhases(newPhases);
	}

	function handleUpdateSubtask(
		phaseIndex: number,
		subtaskIndex: number,
		field: string,
		value: string,
	) {
		const newPhases = [...editedPhases];
		(newPhases[phaseIndex].subtasks[subtaskIndex] as Record<string, unknown>)[
			field
		] = value;
		setEditedPhases(newPhases);
	}

	if (selectedSubtaskForFilesView) {
		return (
			<SubtaskFilesViewer
				files={selectedSubtaskForFilesView.files || []}
				subtaskTitle={selectedSubtaskForFilesView.title}
				taskId={task.id}
				onClose={() => setSelectedSubtaskForFilesView(null)}
			/>
		);
	}

	if (selectedSubtaskForCodeEdit) {
		return (
			<div className="h-full flex flex-col">
				<div className="p-3 border-b border-border bg-muted/50 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Code2 className="h-4 w-4" />
						<span className="text-sm font-medium">
							Edit Files: {selectedSubtaskForCodeEdit.title}
						</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setSelectedSubtaskForCodeEdit(null)}
						className="h-6"
					>
						Back
					</Button>
				</div>
				<div className="flex-1 overflow-hidden">
					<TaskCodeEditor
						subtask={selectedSubtaskForCodeEdit}
						onUpdate={handleCodeEditorUpdate}
					/>
				</div>
			</div>
		);
	}

	if (task.subtasks.length === 0) {
		return (
			<ScrollArea className="h-full">
				<div className="p-4 space-y-3">
					<div className="text-center py-12">
						<ListChecks className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
						<p className="text-sm font-medium text-muted-foreground mb-1">
							No subtasks defined
						</p>
						<p className="text-xs text-muted-foreground/70">
							Implementation subtasks will appear here after planning
						</p>
					</div>
				</div>
			</ScrollArea>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-4 space-y-3">
				{/* Plan validation - approve/reject the proposed subtasks before coding */}
				<PlanApprovalSection task={task} />

				{/* Header with edit/reset buttons */}
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center justify-between text-xs text-muted-foreground flex-1">
						<span className="flex items-center gap-1.5">
							<span>
								{t("tasks:subtasks.completedCount", {
									completed: completedCount,
									total: task.subtasks.length,
								})}
							</span>
							{blockedCount > 0 && (
								<span className="text-amber-600 dark:text-amber-400">
									· {t("tasks:subtasks.blockedCount", { count: blockedCount })}
								</span>
							)}
							{failedCount > 0 && (
								<span className="text-[var(--error)]">
									· {t("tasks:subtasks.failedCount", { count: failedCount })}
								</span>
							)}
						</span>
						<span className="tabular-nums">{progress}%</span>
					</div>
					{!isEditing && <TaskResetButton task={task} className="ml-2 h-7" />}
					{!isEditing && onUpdatePlan && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setIsEditing(true)}
							className="ml-2 h-7 w-7 p-0"
							title={t("tasks:modal.plan.edit")}
						>
							<Edit3 className="h-3.5 w-3.5" />
						</Button>
					)}
				</div>

				{isEditing ? (
					// Edit mode
					<div className="space-y-4">
						{editedPhases.map((phase, phaseIndex) => (
							<div key={`phase-${phase.name}`} className="border rounded-lg p-3 space-y-2">
								<h3 className="font-medium text-sm text-foreground">
									{phase.name}
								</h3>

								{phase.subtasks.map((subtask, subtaskIndex) => (
									<div
										key={subtask.id}
										className="flex gap-2 items-start bg-secondary/30 p-2 rounded"
									>
										<div className="flex-1 space-y-1">
											<input
												type="text"
												value={subtask.title || ""}
												onChange={(e) =>
													handleUpdateSubtask(
														phaseIndex,
														subtaskIndex,
														"title",
														e.target.value,
													)
												}
												placeholder={t("tasks:modal.plan.subtaskTitle")}
												className="w-full text-sm font-medium bg-background/50 rounded px-2 py-1 border border-border/50"
											/>
											<textarea
												value={subtask.description || ""}
												onChange={(e) =>
													handleUpdateSubtask(
														phaseIndex,
														subtaskIndex,
														"description",
														e.target.value,
													)
												}
												placeholder={t("tasks:modal.plan.subtaskDescription")}
												className="w-full text-xs bg-background/50 rounded px-2 py-1 border border-border/50 resize-none"
												rows={2}
											/>
										</div>
										{subtask.status === "pending" && (
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													handleDeleteSubtask(phaseIndex, subtaskIndex)
												}
												className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
											>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										)}
									</div>
								))}

								<Button
									size="sm"
									variant="outline"
									onClick={() => handleAddSubtask(phaseIndex)}
									className="w-full text-xs h-7"
								>
									<Plus className="h-3 w-3 mr-1" />
									{t("tasks:modal.plan.addSubtask")}
								</Button>
							</div>
						))}

						<div className="flex gap-2 pt-2 border-t border-border/50">
							<Button
								size="sm"
								onClick={handleSaveChanges}
								disabled={isSaving}
								className="flex-1"
							>
								{isSaving ? (
									<>
										<span className="animate-spin">⟳</span>
										{t("tasks:modal.plan.savingChanges")}
									</>
								) : (
									t("tasks:modal.plan.save")
								)}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setIsEditing(false);
									setEditedPhases(
										task.subtasks.length > 0
											? [
													{
														name: "Implementation",
														subtasks: task.subtasks,
													},
												]
											: [],
									);
								}}
								disabled={isSaving}
								className="flex-1"
							>
								{t("tasks:modal.plan.cancel")}
							</Button>
						</div>
					</div>
				) : (
					// View mode
					task.subtasks.map((subtask, index) => (
							<div
								key={subtask.id}
								onClick={() => {
									setSelectedSubtaskForFilesView(subtask);
								}}
								className={cn(
									"rounded-xl border border-border bg-secondary/30 p-3 transition-all duration-200 hover:bg-secondary/50 cursor-pointer group",
									subtask.status === "in_progress" &&
										"border-[var(--info)]/50 bg-[var(--info-light)] ring-1 ring-info/20",
									subtask.status === "completed" &&
										"border-[var(--success)]/50 bg-[var(--success-light)]",
									subtask.status === "blocked" &&
										"border-amber-500/50 bg-amber-500/10",
									subtask.status === "failed" &&
										"border-[var(--error)]/50 bg-[var(--error-light)]",
									// User-requested changes get a distinct violet treatment so they
									// stand out from the originally-planned subtasks, whatever their
									// status. Last in the list so it wins the bg/border merge.
									subtask.origin === "change_request" &&
										"border-violet-500/50 bg-violet-500/10 hover:bg-violet-500/15",
								)}
							>
								<div className="flex items-start gap-2 w-full">
									{getSubtaskStatusIcon(subtask.status)}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 min-w-0 w-full">
											<span
												className={cn(
													"text-[10px] font-medium px-1.5 py-0.5 rounded-full",
													getStatusBadgeClass(subtask.status),
												)}
											>
												#{index + 1}
											</span>
											{subtask.origin === "change_request" && (
												<span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-600 dark:text-violet-400 flex-shrink-0">
													<MessageSquarePlus className="h-2.5 w-2.5" />
													{t("tasks:subtasks.changeRequest")}
												</span>
											)}
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="text-sm font-medium text-foreground truncate cursor-default">
														{subtask.title || t("tasks:subtasks.untitled")}
													</span>
												</TooltipTrigger>
												<TooltipContent side="top" className="max-w-xs">
													<p className="text-xs">
														{subtask.title || t("tasks:subtasks.untitled")}
													</p>
												</TooltipContent>
											</Tooltip>
										</div>
										<div className="flex items-start justify-between gap-2 w-full">
											<Tooltip>
												<TooltipTrigger asChild>
													<p className="text-xs text-muted-foreground line-clamp-2 cursor-default">
														{subtask.description}
													</p>
												</TooltipTrigger>
												{subtask.description &&
													subtask.description.length > 80 && (
														<TooltipContent side="bottom" className="max-w-sm">
															<p className="text-xs">{subtask.description}</p>
														</TooltipContent>
													)}
											</Tooltip>
											<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
										</div>
										{subtask.origin === "change_request" &&
											subtask.requestedAt && (
												<p className="mt-0.5 text-[10px] text-violet-600/70 dark:text-violet-400/70">
													{t("tasks:subtasks.requestedAt", {
														date: new Date(
															subtask.requestedAt,
														).toLocaleString(),
													})}
												</p>
											)}
										{subtask.status === "blocked" && (
											<div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
												<AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
												<span>
													{subtask.blockedReason
														? t("tasks:subtasks.blockedReason", {
																reason: subtask.blockedReason,
															})
														: t("tasks:subtasks.blockedGeneric")}
												</span>
											</div>
										)}
										{subtask.files && subtask.files.length > 0 && (
											<div className="flex flex-wrap gap-1 items-center">
												{subtask.files.slice(0, 2).map((file: string) => (
													<Tooltip key={file}>
														<TooltipTrigger asChild>
															<Badge
																variant="secondary"
																className="text-xs font-mono cursor-help"
															>
																<FileCode className="mr-1 h-3 w-3" />
																{file.split("/").pop()}
															</Badge>
														</TooltipTrigger>
														<TooltipContent
															side="top"
															className="font-mono text-xs"
														>
															{file}
														</TooltipContent>
													</Tooltip>
												))}
												{subtask.files.length > 2 && (
													<Badge variant="outline" className="text-xs">
														+{subtask.files.length - 2} more
													</Badge>
												)}
												{subtask.status === "pending" && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																size="sm"
																variant="ghost"
																onClick={(e) => {
																	e.stopPropagation();
																	setSelectedSubtaskForCodeEdit(subtask);
																}}
																className="h-6 w-6 p-0 ml-1"
															>
																<Edit3 className="h-3 w-3" />
															</Button>
														</TooltipTrigger>
														<TooltipContent>Edit files</TooltipContent>
													</Tooltip>
												)}
											</div>
										)}
									</div>
								</div>
							</div>
						))
				)}
			</div>
		</ScrollArea>
	);
}
