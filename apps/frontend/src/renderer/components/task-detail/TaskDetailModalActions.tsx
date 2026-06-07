import {
	CheckCircle2,
	GitPullRequest,
	Loader2,
	Play,
	RefreshCw,
	RotateCcw,
	Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { IPC_CHANNELS, TASK_STATUS_LABELS } from "../../../shared/constants";
import type { IPCResult, Project, Task } from "../../../shared/types";
import { AgentToolsButton, ProgressIndicatorBadge } from "../agent-tools";
import { StreamingSessionButton } from "../streaming/StreamingSessionButton";
import { Button } from "../ui/button";
import { ResumeWithProviderDropdown } from "./ResumeWithProviderDropdown";

interface TaskDetailModalActionsProps {
	readonly task: Task;
	readonly activeProject?: Project;
	readonly state: ReturnType<
		typeof import("./hooks/useTaskDetail").useTaskDetail
	>;
	readonly handleStartStop: () => Promise<void>;
	readonly handleRecover: () => Promise<void>;
}

interface RunnableActionsProps {
	readonly task: Task;
	readonly activeProject?: Project;
	readonly isRunning: boolean;
	readonly onStartStop: () => Promise<void>;
}

/** Action row for tasks in backlog/queue/in_progress.
 *
 * Extracted from the main component to keep its cognitive complexity below
 * the linter's threshold — the conditional pre-build vs running tools split
 * pushed it over.
 */
function RunnableActions({
	task,
	activeProject,
	isRunning,
	onStartStop,
}: RunnableActionsProps) {
	const { t } = useTranslation(["tasks"]);
	// Pre-build cards (backlog/queue): cost estimator + prompt preview +
	//   variations (Arena scaffolding before launching).
	// Running cards (in_progress): restart + prompt + timeline.
	// Timeline is always available once an audit_trail exists for the spec.
	const tools: Array<
		"cost" | "restart" | "prompt" | "timeline" | "variations"
	> =
		task.status === "in_progress"
			? ["restart", "prompt", "timeline"]
			: ["cost", "variations", "prompt", "timeline"];

	return (
		<div className="flex items-center gap-2">
			{/* Live sub-status pill (renders nothing when idle/unknown). */}
			{task.specsPath && task.status === "in_progress" && (
				<ProgressIndicatorBadge specDir={task.specsPath} />
			)}

			{activeProject?.path && (
				<StreamingSessionButton
					taskId={task.id}
					projectPath={activeProject.path}
				/>
			)}

			{activeProject?.path && task.specsPath && (
				<AgentToolsButton
					projectDir={activeProject.path}
					specDir={task.specsPath}
					tools={tools}
					onStartBuild={() => void onStartStop()}
				/>
			)}

			<Button
				variant={isRunning ? "destructive" : "default"}
				onClick={onStartStop}
			>
				{isRunning ? (
					<>
						<Square className="mr-2 h-4 w-4" />
						{t("tasks:modal.actions.stopTask")}
					</>
				) : (
					<>
						<Play className="mr-2 h-4 w-4" />
						{t("tasks:modal.actions.startTask")}
					</>
				)}
			</Button>
		</div>
	);
}

interface ReviewableActionsProps {
	readonly task: Task;
	readonly activeProject?: Project;
}

/** Action row for tasks awaiting review (ai_review / human_review).
 *
 * Surfaces the QA promotion check, the virtual reviewer (advisory) and the
 * timeline drawer. No mutating buttons here — the existing review UI in the
 * modal body is responsible for moving the card.
 */
function ReviewableActions({ task, activeProject }: ReviewableActionsProps) {
	if (!activeProject?.path || !task.specsPath) return null;

	// `promotion` is most relevant in ai_review (deciding whether to skip
	// human_review); `virtual_review` is most relevant in human_review (advisory
	// commentary for the reviewer).
	const tools: Array<"timeline" | "promotion" | "virtual_review"> =
		task.status === "ai_review"
			? ["promotion", "virtual_review", "timeline"]
			: ["virtual_review", "timeline"];

	return (
		<div className="flex items-center gap-2">
			<AgentToolsButton
				projectDir={activeProject.path}
				specDir={task.specsPath}
				tools={tools}
			/>
		</div>
	);
}

export function TaskDetailModalActions({
	task,
	activeProject,
	state,
	handleStartStop,
	handleRecover,
}: TaskDetailModalActionsProps) {
	const { t } = useTranslation(["tasks"]);

	// Render primary action button based on state
	if (state.isStuck) {
		return (
			<Button
				variant="warning"
				onClick={handleRecover}
				disabled={state.isRecovering}
			>
				{state.isRecovering ? (
					<>
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						{t("tasks:modal.actions.recovering")}
					</>
				) : (
					<>
						<RotateCcw className="mr-2 h-4 w-4" />
						{t("tasks:modal.actions.recoverTask")}
					</>
				)}
			</Button>
		);
	}

	if (state.isIncomplete) {
		return (
			<div className="flex items-center gap-2">
				<Button
					variant="default"
					onClick={handleStartStop}
					disabled={state.isLoadingPlan}
				>
					{state.isLoadingPlan ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							Loading Plan...
						</>
					) : (
						<>
							<Play className="mr-2 h-4 w-4" />
							Resume Task
						</>
					)}
				</Button>
				<ResumeWithProviderDropdown
					taskId={task.id}
					currentProvider={task.metadata?.provider}
					disabled={state.isLoadingPlan}
				/>
			</div>
		);
	}

	if (
		task.status === "backlog" ||
		task.status === "queue" ||
		task.status === "in_progress"
	) {
		return (
			<RunnableActions
				task={task}
				activeProject={activeProject}
				isRunning={state.isRunning}
				onStartStop={handleStartStop}
			/>
		);
	}

	if (task.status === "ai_review" || task.status === "human_review") {
		// Special-case the "prompt too long" halt: the conversation log grew
		// past the LLM context window, so the normal review UI is useless.
		// Offer the two real remediations: reset the conversation log (clears
		// the replay history) or switch to a provider with a larger context.
		if (task.reviewReason === "prompt_too_long") {
			return (
				<div className="flex items-center gap-2">
					<Button
						variant="default"
						onClick={async () => {
							const res = await globalThis.electronAPI.resetTaskConversation(
								task.id,
							);
							if (!res?.success && res?.error) {
								globalThis.window.alert(res.error);
							}
						}}
						title={t(
							"tasks:modal.actions.resetConversationTooltip",
							"Effacer l'historique de la conversation pour repartir avec un contexte vierge",
						)}
					>
						<RotateCcw className="mr-2 h-4 w-4" />
						{t(
							"tasks:modal.actions.resetConversation",
							"Réinitialiser la conversation",
						)}
					</Button>
					<ResumeWithProviderDropdown
						taskId={task.id}
						currentProvider={task.metadata?.provider}
					/>
				</div>
			);
		}
		return <ReviewableActions task={task} activeProject={activeProject} />;
	}

	// Card landed in `error` state — typically after `error_max_turns` or
	// `error_max_budget_usd`. Offer "Reprendre" which resumes the persisted
	// Claude SDK session_id from <spec_dir>/.session.json instead of replaying
	// the whole transcript. The IPC handler validates the session file and
	// surfaces a useful error if none exists.
	if (task.status === "error") {
		return (
			<div className="flex items-center gap-2">
				<Button
					variant="default"
					onClick={async () => {
						const res = (await globalThis.electronAPI.invoke(
							IPC_CHANNELS.TASK_RESUME_SESSION,
							task.id,
						)) as IPCResult;
						if (!res?.success && res?.error) {
							globalThis.window.alert(res.error);
						}
					}}
				>
					<RefreshCw className="mr-2 h-4 w-4" />
					{t("tasks:modal.actions.resumeSession", "Reprendre la session")}
				</Button>
				<ResumeWithProviderDropdown
					taskId={task.id}
					currentProvider={task.metadata?.provider}
				/>
			</div>
		);
	}

	if (task.status === "done" && task.metadata?.prUrl) {
		return (
			<div className="flex items-center gap-4">
				<div className="completion-state text-sm flex items-center gap-2 text-success">
					<CheckCircle2 className="h-5 w-5" />
					<span className="font-medium">{t("tasks:status.complete")}</span>
				</div>
				{task.metadata?.prUrl && (
					<button
						type="button"
						onClick={() => {
							if (task.metadata?.prUrl) {
								globalThis.window.electronAPI?.openExternal(
									task.metadata.prUrl,
								);
							}
						}}
						className="completion-state text-sm flex items-center gap-2 text-info cursor-pointer hover:underline bg-transparent border-none p-0"
					>
						<GitPullRequest className="h-5 w-5" />
						<span className="font-medium">
							{t(TASK_STATUS_LABELS[task.status])}
						</span>
					</button>
				)}
			</div>
		);
	}

	if (task.status === "done") {
		return (
			<div className="completion-state text-sm flex items-center gap-2 text-success">
				<CheckCircle2 className="h-5 w-5" />
				<span className="font-medium">{t("tasks:status.complete")}</span>
			</div>
		);
	}

	return null;
}
