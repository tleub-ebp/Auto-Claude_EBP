import type {
	GitConflictInfo,
	ImageAttachment,
	MergeConflict,
	MergeStats,
	Task,
	WorktreeCreatePRResult,
	WorktreeDiff,
	WorktreeStatus,
} from "../../../shared/types";
import {
	ConflictDetailsDialog,
	CreatePRDialog,
	DiffViewDialog,
	DiscardDialog,
	LoadingMessage,
	NoWorkspaceMessage,
	QAFeedbackSection,
	StagedInProjectMessage,
	StagedSuccessMessage,
	WorkspaceStatus,
} from "./task-review";
import { PlanApprovalSection } from "./PlanApprovalSection";
import { TaskTestGenerator } from "./TaskTestGenerator";

interface TaskReviewProps {
	readonly task: Task;
	readonly feedback: string;
	readonly isSubmitting: boolean;
	readonly worktreeStatus: WorktreeStatus | null;
	readonly worktreeDiff: WorktreeDiff | null;
	readonly isLoadingWorktree: boolean;
	readonly isMerging: boolean;
	readonly isDiscarding: boolean;
	readonly showDiscardDialog: boolean;
	readonly showDiffDialog: boolean;
	readonly workspaceError: string | null;
	readonly stageOnly: boolean;
	readonly stagedSuccess: string | null;
	readonly stagedProjectPath: string | undefined;
	readonly suggestedCommitMessage: string | undefined;
	readonly mergePreview: {
		files: string[];
		conflicts: MergeConflict[];
		summary: MergeStats;
		gitConflicts?: GitConflictInfo;
		uncommittedChanges?: {
			hasChanges: boolean;
			files: string[];
			count: number;
		} | null;
	} | null;
	readonly isLoadingPreview: boolean;
	readonly showConflictDialog: boolean;
	readonly onFeedbackChange: (value: string) => void;
	readonly onReject: () => void;
	/** Image attachments for visual feedback */
	readonly images?: ImageAttachment[];
	/** Callback when images change */
	readonly onImagesChange?: (images: ImageAttachment[]) => void;
	readonly onMerge: () => void;
	readonly onDiscard: () => void;
	readonly onShowDiscardDialog: (show: boolean) => void;
	readonly onShowDiffDialog: (show: boolean) => void;
	readonly onStageOnlyChange: (value: boolean) => void;
	readonly onShowConflictDialog: (show: boolean) => void;
	readonly onLoadMergePreview: () => void;
	readonly onClose?: () => void;
	readonly onReviewAgain?: () => void;
	// PR creation
	readonly showPRDialog: boolean;
	readonly isCreatingPR: boolean;
	readonly onShowPRDialog: (show: boolean) => void;
	readonly onCreatePR: (options: {
		targetBranch?: string;
		title?: string;
		draft?: boolean;
	}) => Promise<WorktreeCreatePRResult | null>;
	readonly onRefreshDiff?: () => void;
}

/**
 * TaskReview Component
 *
 * Main component for reviewing task completion, displaying workspace status,
 * merge previews, and providing options to merge, stage, or discard changes.
 *
 * This component has been refactored into smaller, focused sub-components for better
 * maintainability. See ./task-review/ directory for individual component implementations.
 */
export function TaskReview({
	task,
	feedback,
	isSubmitting,
	worktreeStatus,
	worktreeDiff,
	isLoadingWorktree,
	isMerging,
	isDiscarding,
	showDiscardDialog,
	showDiffDialog,
	workspaceError,
	stageOnly,
	stagedSuccess,
	stagedProjectPath,
	suggestedCommitMessage,
	mergePreview,
	isLoadingPreview,
	showConflictDialog,
	onFeedbackChange,
	onReject,
	images,
	onImagesChange,
	onMerge,
	onDiscard,
	onShowDiscardDialog,
	onShowDiffDialog,
	onStageOnlyChange,
	onShowConflictDialog,
	onLoadMergePreview,
	onClose,
	onReviewAgain,
	showPRDialog,
	isCreatingPR,
	onShowPRDialog,
	onCreatePR,
	onRefreshDiff,
}: TaskReviewProps) {
	// Extract nested ternary into a clear variable
	const workspaceStatusComponent = (() => {
		if (isLoadingWorktree) {
			return <LoadingMessage />;
		}

		if (stagedSuccess) {
			/* Fresh staging just completed - StagedSuccessMessage is rendered above */
			return null;
		}

		if (task.stagedInMainProject) {
			/* Task was previously staged (persisted state) - show even if worktree still exists */
			return (
				<StagedInProjectMessage
					task={task}
					projectPath={stagedProjectPath}
					hasWorktree={worktreeStatus?.exists || false}
					onClose={onClose}
					onReviewAgain={onReviewAgain}
				/>
			);
		}

		if (worktreeStatus?.exists) {
			/* Worktree exists but not yet staged - show staging UI */
			return (
				<WorkspaceStatus
					taskId={task.id}
					worktreeStatus={worktreeStatus}
					workspaceError={workspaceError}
					stageOnly={stageOnly}
					mergePreview={mergePreview}
					isLoadingPreview={isLoadingPreview}
					isMerging={isMerging}
					isDiscarding={isDiscarding}
					isCreatingPR={isCreatingPR}
					existingPrUrl={task.prUrl ?? task.metadata?.prUrl}
					onShowDiffDialog={onShowDiffDialog}
					onShowDiscardDialog={onShowDiscardDialog}
					onShowConflictDialog={onShowConflictDialog}
					onLoadMergePreview={onLoadMergePreview}
					onStageOnlyChange={onStageOnlyChange}
					onMerge={onMerge}
					onShowPRDialog={onShowPRDialog}
				/>
			);
		}

		return <NoWorkspaceMessage task={task} onClose={onClose} />;
	})();

	return (
		<div className="space-y-4">
			{/* Section divider */}
			<div className="section-divider-gradient" />

			{/* Plan Approval Section - shown when task requires plan review before coding */}
			<PlanApprovalSection task={task} isSubmitting={isSubmitting} />

			{/* Staged Success Message */}
			{stagedSuccess && (
				<StagedSuccessMessage
					stagedSuccess={stagedSuccess}
					suggestedCommitMessage={suggestedCommitMessage}
				/>
			)}

			{/* Workspace Status Section */}
			{workspaceStatusComponent}

			{/* Test generation for the files touched by this task */}
			{worktreeStatus?.exists && !task.stagedInMainProject && (
				<TaskTestGenerator
					task={task}
					worktreeDiff={worktreeDiff}
					worktreePath={worktreeStatus.worktreePath}
					onTestsWritten={onRefreshDiff}
				/>
			)}

			{/* QA Feedback Section */}
			<QAFeedbackSection
				feedback={feedback}
				isSubmitting={isSubmitting}
				onFeedbackChange={onFeedbackChange}
				onReject={onReject}
				images={images}
				onImagesChange={onImagesChange}
			/>

			{/* Discard Confirmation Dialog */}
			<DiscardDialog
				open={showDiscardDialog}
				task={task}
				worktreeStatus={worktreeStatus}
				isDiscarding={isDiscarding}
				onOpenChange={onShowDiscardDialog}
				onDiscard={onDiscard}
			/>

			{/* Diff View Dialog */}
			<DiffViewDialog
				open={showDiffDialog}
				worktreeDiff={worktreeDiff}
				onOpenChange={onShowDiffDialog}
				worktreePath={worktreeStatus?.worktreePath}
				onRefresh={onRefreshDiff}
			/>

			{/* Conflict Details Dialog */}
			<ConflictDetailsDialog
				open={showConflictDialog}
				mergePreview={mergePreview}
				stageOnly={stageOnly}
				onOpenChange={onShowConflictDialog}
				onMerge={onMerge}
			/>

			{/* Create PR Dialog */}
			<CreatePRDialog
				open={showPRDialog}
				task={task}
				worktreeStatus={worktreeStatus}
				onOpenChange={onShowPRDialog}
				onCreatePR={onCreatePR}
			/>
		</div>
	);
}
