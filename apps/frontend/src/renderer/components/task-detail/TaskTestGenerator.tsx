import {
	CheckCircle2,
	FlaskConical,
	Loader2,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, WorktreeDiff } from "../../../shared/types";
import {
	classifyTestStrategy,
	isGeneratableStrategy,
	type TestStrategy,
} from "../../../shared/utils/test-strategy";
import { cn } from "../../lib/utils";
import { useToast } from "../../hooks/use-toast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

type FileGenerationState = "idle" | "generating" | "done" | "error";

interface FilePlan {
	path: string;
	strategy: TestStrategy;
	selected: boolean;
	state: FileGenerationState;
	testPath?: string;
	error?: string;
}

interface TaskTestGeneratorProps {
	readonly task: Task;
	readonly worktreeDiff: WorktreeDiff | null;
	readonly worktreePath?: string;
	/** Called after test files were written so the parent can refresh the diff. */
	readonly onTestsWritten?: () => void;
}

interface GenerationOutput {
	test_file_path: string;
	test_file_content: string;
}

const STRATEGY_BADGE_CLASSES: Record<Exclude<TestStrategy, "skip">, string> = {
	unit: "bg-info/10 text-info",
	api: "bg-success/10 text-success",
	"e2e-web": "bg-warning/10 text-[var(--warning)]",
	"desktop-ui": "bg-purple-500/10 text-purple-400",
};

/** Make the suggested test path relative to the worktree, normalized to "/". */
export function toWorktreeRelativePath(
	suggestedPath: string,
	worktreePath: string,
): string {
	const normalizedSuggested = suggestedPath.replaceAll("\\", "/");
	const normalizedWorktree = worktreePath.replaceAll("\\", "/").replace(/\/$/, "");
	if (
		normalizedSuggested.toLowerCase().startsWith(
			`${normalizedWorktree.toLowerCase()}/`,
		)
	) {
		return normalizedSuggested.slice(normalizedWorktree.length + 1);
	}
	return normalizedSuggested.replace(/^\//, "");
}

/**
 * Generate tests for the files touched by the task, with a per-file strategy
 * (unit / API / web E2E / desktop UI) inferred from the file type and path.
 * Generated test files are written INTO the worktree so they are reviewed and
 * shipped with the same PR as the change they cover.
 */
export function TaskTestGenerator({
	task,
	worktreeDiff,
	worktreePath,
	onTestsWritten,
}: TaskTestGeneratorProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [plans, setPlans] = useState<FilePlan[]>([]);
	const [isGenerating, setIsGenerating] = useState(false);
	const isMountedRef = useRef(true);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const changedPaths = useMemo(
		() =>
			(worktreeDiff?.files ?? [])
				.filter((file) => file.status !== "deleted")
				.map((file) => file.path),
		[worktreeDiff?.files],
	);

	// Rebuild plans when the diff changes (keep nothing from previous runs:
	// the diff is the source of truth for what is testable)
	useEffect(() => {
		setPlans(
			changedPaths.map((path) => {
				const strategy = classifyTestStrategy(path, changedPaths);
				return {
					path,
					strategy,
					selected: isGeneratableStrategy(strategy),
					state: "idle" as const,
				};
			}),
		);
	}, [changedPaths]);

	const generatablePlans = plans.filter((plan) =>
		isGeneratableStrategy(plan.strategy),
	);
	const selectedPlans = generatablePlans.filter((plan) => plan.selected);

	if (!worktreePath || generatablePlans.length === 0) {
		return null;
	}

	const updatePlan = (path: string, updates: Partial<FilePlan>) => {
		if (!isMountedRef.current) return;
		setPlans((previous) =>
			previous.map((plan) =>
				plan.path === path ? { ...plan, ...updates } : plan,
			),
		);
	};

	/**
	 * One-shot wrapper around the global test-generation events. The main
	 * service runs a single generation at a time, so calls are sequential.
	 */
	const generateOne = (plan: FilePlan): Promise<GenerationOutput> => {
		return new Promise<GenerationOutput>((resolve, reject) => {
			const api = globalThis.electronAPI;
			const cleanup = () => {
				api.removeTestGenerationCompleteListener(onComplete);
				api.removeTestGenerationErrorListener(onError);
			};
			const onComplete = (data: unknown) => {
				cleanup();
				const result = (data as { result?: GenerationOutput }).result;
				if (result?.test_file_content && result.test_file_path) {
					resolve(result);
				} else {
					reject(new Error(t("tasks:testGen.emptyResult")));
				}
			};
			const onError = (error: string) => {
				cleanup();
				reject(new Error(error));
			};
			api.onTestGenerationComplete(onComplete);
			api.onTestGenerationError(onError);

			const absolutePath = `${worktreePath.replaceAll("\\", "/")}/${plan.path.replaceAll("\\", "/")}`;
			if (plan.strategy === "e2e-web") {
				// E2E: the user story drives the scenario; the file localizes it
				const userStory = [task.title, task.description?.slice(0, 1500)]
					.filter(Boolean)
					.join("\n\n");
				api.generateE2ETests(userStory, absolutePath, worktreePath);
			} else {
				api.generateUnitTests(absolutePath, undefined, undefined, worktreePath);
			}
		});
	};

	const handleGenerate = async () => {
		if (selectedPlans.length === 0 || isGenerating) return;
		setIsGenerating(true);
		let written = 0;
		try {
			for (const plan of selectedPlans) {
				updatePlan(plan.path, { state: "generating", error: undefined });
				try {
					const result = await generateOne(plan);
					const relativeTestPath = toWorktreeRelativePath(
						result.test_file_path,
						worktreePath,
					);
					const writeResult = await globalThis.electronAPI.worktreeWriteFile(
						worktreePath,
						relativeTestPath,
						result.test_file_content,
					);
					if (!writeResult.success) {
						throw new Error(writeResult.error || "Could not write test file");
					}
					written += 1;
					updatePlan(plan.path, { state: "done", testPath: relativeTestPath });
				} catch (error) {
					updatePlan(plan.path, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
				}
				if (!isMountedRef.current) return;
			}
		} finally {
			if (isMountedRef.current) {
				setIsGenerating(false);
			}
		}
		if (written > 0) {
			toast({
				title: t("tasks:testGen.doneTitle"),
				description: t("tasks:testGen.doneDescription", { count: written }),
			});
			onTestsWritten?.();
		}
	};

	return (
		<div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<FlaskConical className="h-4 w-4 shrink-0 text-primary" />
					<div className="min-w-0">
						<h4 className="text-sm font-medium">{t("tasks:testGen.title")}</h4>
						<p className="text-xs text-muted-foreground truncate">
							{t("tasks:testGen.description")}
						</p>
					</div>
				</div>
				<Button
					size="sm"
					onClick={() => void handleGenerate()}
					disabled={isGenerating || selectedPlans.length === 0}
				>
					{isGenerating ? (
						<Loader2 className="h-4 w-4 mr-2 animate-spin" />
					) : (
						<FlaskConical className="h-4 w-4 mr-2" />
					)}
					{t("tasks:testGen.generate", { count: selectedPlans.length })}
				</Button>
			</div>

			<div className="space-y-1">
				{generatablePlans.map((plan) => (
					<div
						key={plan.path}
						className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/40 transition-colors"
					>
						<div className="flex items-center gap-2 min-w-0 flex-1">
							<Checkbox
								checked={plan.selected}
								disabled={isGenerating}
								onCheckedChange={(checked) =>
									updatePlan(plan.path, { selected: checked === true })
								}
							/>
							<span className="text-xs font-mono truncate" title={plan.path}>
								{plan.path}
							</span>
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{plan.state === "generating" && (
								<Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
							)}
							{plan.state === "done" && (
								<span
									className="flex items-center gap-1 text-xs text-success"
									title={plan.testPath}
								>
									<CheckCircle2 className="h-3.5 w-3.5" />
									{t("tasks:testGen.written")}
								</span>
							)}
							{plan.state === "error" && (
								<span
									className="flex items-center gap-1 text-xs text-destructive"
									title={plan.error}
								>
									<XCircle className="h-3.5 w-3.5" />
									{t("tasks:testGen.failed")}
								</span>
							)}
							<Badge
								variant="secondary"
								className={cn(
									"text-[10px]",
									STRATEGY_BADGE_CLASSES[
										plan.strategy as Exclude<TestStrategy, "skip">
									],
								)}
							>
								{t(`tasks:testGen.strategy.${plan.strategy}`)}
							</Badge>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
