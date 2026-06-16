import { Lightbulb, Loader2, MessageCircleQuestion, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpecInterviewQuestion, Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { persistUpdateTask, startTask } from "../../stores/task-store";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

interface SpecInterviewDialogProps {
	readonly task: Task;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}

/**
 * Self-contained entry point for the spec interview, shown on tasks that have
 * not started yet (backlog/queue). Owns the dialog open state so host
 * components only need to render `<SpecInterviewBanner task={task} />`.
 */
export function SpecInterviewBanner({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(false);

	if (task.status !== "backlog" && task.status !== "queue") {
		return null;
	}

	return (
		<>
			<div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary" />
					<p className="text-sm text-muted-foreground truncate">
						{t("tasks:interview.banner")}
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
					{t("tasks:interview.openButton")}
				</Button>
			</div>
			<SpecInterviewDialog task={task} open={open} onOpenChange={setOpen} />
		</>
	);
}

/**
 * Pre-planning spec interview: the agent reads the spec and asks 3-5 targeted
 * questions (edge cases, expected behaviours, validation rules). The answers
 * are appended to the task description as a "Clarifications" section, so the
 * planner works from a richer spec — fewer rejected plans, fewer resets.
 */
export function SpecInterviewDialog({
	task,
	open,
	onOpenChange,
}: SpecInterviewDialogProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [questions, setQuestions] = useState<SpecInterviewQuestion[]>([]);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [isSaving, setIsSaving] = useState(false);
	// Guards against state updates after the dialog was closed mid-generation
	const generationRef = useRef(0);

	const loadQuestions = useCallback(async () => {
		const generation = ++generationRef.current;
		setIsLoading(true);
		setError(null);
		setQuestions([]);
		setAnswers({});
		try {
			const result = await globalThis.electronAPI.generateSpecInterview(task.id);
			if (generation !== generationRef.current) return;
			if (result.success && result.data && result.data.length > 0) {
				setQuestions(result.data);
			} else {
				setError(result.error || t("tasks:interview.generationFailed"));
			}
		} catch (err) {
			if (generation !== generationRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (generation === generationRef.current) {
				setIsLoading(false);
			}
		}
	}, [task.id, t]);

	useEffect(() => {
		if (open) {
			void loadQuestions();
		} else {
			generationRef.current++;
		}
	}, [open, loadQuestions]);

	const answeredCount = questions.filter((q) => answers[q.id]?.trim()).length;

	const buildClarificationsSection = (): string => {
		const lines: string[] = ["", "", `## ${t("tasks:interview.sectionTitle")}`, ""];
		for (const question of questions) {
			const answer = answers[question.id]?.trim();
			if (!answer) continue;
			lines.push(`**${question.question}**`, "", answer, "");
		}
		return lines.join("\n");
	};

	const handleSave = async (startAfter: boolean) => {
		if (answeredCount === 0) return;
		setIsSaving(true);
		try {
			const success = await persistUpdateTask(task.id, {
				description: `${task.description ?? ""}${buildClarificationsSection()}`,
			});
			if (!success) {
				toast({
					title: t("tasks:interview.saveErrorTitle"),
					variant: "destructive",
				});
				return;
			}
			toast({
				title: t("tasks:interview.savedTitle"),
				description: t("tasks:interview.savedDescription", {
					count: answeredCount,
				}),
			});
			onOpenChange(false);
			if (startAfter) {
				startTask(task.id);
			}
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<MessageCircleQuestion className="h-5 w-5 text-primary" />
						{t("tasks:interview.title")}
					</DialogTitle>
					<DialogDescription>
						{t("tasks:interview.description")}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2">
					{isLoading && (
						<div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
							<Loader2 className="h-6 w-6 animate-spin" />
							<p className="text-sm">{t("tasks:interview.generating")}</p>
						</div>
					)}

					{error && !isLoading && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 space-y-3">
							<p className="text-sm text-destructive">{error}</p>
							<Button size="sm" variant="outline" onClick={() => void loadQuestions()}>
								{t("tasks:interview.retry")}
							</Button>
						</div>
					)}

					{!isLoading &&
						!error &&
						questions.map((question, index) => (
							<div
								key={question.id}
								className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2"
							>
								<p className="text-sm font-medium text-foreground">
									{index + 1}. {question.question}
								</p>
								{question.rationale && (
									<p className="text-xs text-muted-foreground">
										{question.rationale}
									</p>
								)}
								<textarea
									value={answers[question.id] ?? ""}
									onChange={(e) =>
										setAnswers((prev) => ({
											...prev,
											[question.id]: e.target.value,
										}))
									}
									placeholder={t("tasks:interview.answerPlaceholder")}
									className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
									rows={2}
									disabled={isSaving}
								/>
								{question.suggestion && !answers[question.id]?.trim() && (
									<button
										type="button"
										onClick={() =>
											setAnswers((prev) => ({
												...prev,
												[question.id]: question.suggestion ?? "",
											}))
										}
										className="flex items-start gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
									>
										<Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
										<span>
											{t("tasks:interview.useSuggestion")} : {question.suggestion}
										</span>
									</button>
								)}
							</div>
						))}
				</div>

				{!isLoading && !error && questions.length > 0 && (
					<DialogFooter className="gap-2">
						<span className="mr-auto self-center text-xs text-muted-foreground">
							{t("tasks:interview.answeredCount", {
								answered: answeredCount,
								total: questions.length,
							})}
						</span>
						<Button
							variant="outline"
							onClick={() => void handleSave(false)}
							disabled={isSaving || answeredCount === 0}
						>
							{isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
							{t("tasks:interview.addToSpec")}
						</Button>
						<Button
							onClick={() => void handleSave(true)}
							disabled={isSaving || answeredCount === 0}
						>
							{isSaving ? (
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
							) : (
								<Play className="h-4 w-4 mr-2" />
							)}
							{t("tasks:interview.addAndStart")}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
