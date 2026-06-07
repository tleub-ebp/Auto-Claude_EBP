import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { startTask, submitReview } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

interface PlanApprovalSectionProps {
	readonly task: Task;
	readonly isSubmitting?: boolean;
	readonly onApproved?: () => void;
	readonly onRejected?: () => void;
}

/**
 * PlanApprovalSection - Displays approval controls for plan_review tasks
 * Shows when a task requires human review before coding phase
 * Allows user to approve (proceed to coding) or reject (request changes)
 */
export function PlanApprovalSection({
	task,
	isSubmitting = false,
	onApproved,
	onRejected,
}: PlanApprovalSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const [isApproving, setIsApproving] = useState(false);
	const [isRejecting, setIsRejecting] = useState(false);
	const [rejectionReason, setRejectionReason] = useState("");

	const isPlanReview =
		task.status === "human_review" && task.reviewReason === "plan_review";

	if (!isPlanReview) {
		return null;
	}

	const handleApprove = async () => {
		setIsApproving(true);
		try {
			// Approve the plan (approved=true, no feedback needed)
			const success = await submitReview(task.id, true);
			if (success) {
				onApproved?.();
				// Start the task to move to coding phase
				startTask(task.id);
			}
		} catch (err) {
			console.error("Error approving plan:", err);
		} finally {
			setIsApproving(false);
		}
	};

	const handleReject = async () => {
		setIsRejecting(true);
		try {
			// Reject the plan with optional feedback
			const success = await submitReview(
				task.id,
				false,
				rejectionReason || undefined,
			);
			if (success) {
				onRejected?.();
				setRejectionReason("");
			}
		} catch (err) {
			console.error("Error rejecting plan:", err);
		} finally {
			setIsRejecting(false);
		}
	};

	return (
		<div className="space-y-4">
			<Separator />
			<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
				<h3 className="font-semibold text-sm text-foreground mb-2 flex items-center gap-2">
					<CheckCircle2 className="h-4 w-4 text-amber-500" />
					{t("tasks:modal.plan.approvalRequired")}
				</h3>
				<p className="text-sm text-muted-foreground mb-4">
					{t("tasks:modal.plan.approvalDescription")}
				</p>

				{/* Rejection reason textarea - shown when user wants to reject */}
				{isRejecting && (
					<div className="mb-4">
						<label className="text-xs font-medium text-foreground mb-2 block">
							{t("tasks:modal.plan.rejectionReason")}
						</label>
						<textarea
							value={rejectionReason}
							onChange={(e) => setRejectionReason(e.target.value)}
							placeholder={t("tasks:modal.plan.rejectionPlaceholder")}
							className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
							rows={3}
							disabled={isSubmitting}
						/>
					</div>
				)}

				{/* Action buttons */}
				<div className="flex gap-2">
					<Button
						onClick={handleApprove}
						disabled={isApproving || isSubmitting}
						size="sm"
						variant="default"
						className="flex-1"
					>
						{isApproving ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								{t("tasks:modal.plan.approving")}
							</>
						) : (
							<>
								<CheckCircle2 className="h-4 w-4 mr-2" />
								{t("tasks:modal.plan.approvePlan")}
							</>
						)}
					</Button>

					<Button
						onClick={handleReject}
						disabled={isRejecting || isSubmitting}
						size="sm"
						variant="outline"
						className="flex-1"
					>
						{isRejecting ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								{t("tasks:modal.plan.rejecting")}
							</>
						) : (
							<>
								<XCircle className="h-4 w-4 mr-2" />
								{t("tasks:modal.plan.rejectPlan")}
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
