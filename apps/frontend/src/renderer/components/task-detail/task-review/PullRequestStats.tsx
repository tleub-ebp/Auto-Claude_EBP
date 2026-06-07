import {
	ExternalLink,
	FileCode,
	GitBranch,
	GitCommit,
	Minus,
	Plus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PRData } from "../../../../shared/types";
import { Button } from "../../ui/button";

interface PullRequestStatsProps {
	readonly prData: PRData;
	readonly commitCount?: number;
}

/**
 * Displays PR statistics when worktree is not available
 * Shows file count, commits, additions/deletions from PR data
 */
export function PullRequestStats({
	prData,
	commitCount,
}: PullRequestStatsProps) {
	const { t } = useTranslation(["taskReview", "common"]);

	return (
		<div className="rounded-xl border border-border bg-card overflow-hidden">
			{/* Header with stats */}
			<div className="px-4 py-3 bg-muted/30 border-b border-border">
				<div className="flex items-center justify-between mb-3">
					<h3 className="font-medium text-sm text-foreground flex items-center gap-2">
						<GitBranch className="h-4 w-4 text-purple-400" />
						{t("taskReview:merge.buildReadyForReview")}
					</h3>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => globalThis.open?.(prData.url, "_blank")}
						className="h-7 px-2 text-xs"
					>
						<ExternalLink className="h-3.5 w-3.5 mr-1" />
						{t("taskReview:merge.viewPR")}
					</Button>
				</div>

				{/* Compact stats row */}
				<div className="flex items-center gap-4 text-xs">
					<span className="flex items-center gap-1.5 text-muted-foreground">
						<FileCode className="h-3.5 w-3.5" />
						<span className="font-medium text-foreground">
							{prData.changed_files || 0}
						</span>{" "}
						{t("taskReview:merge.status.files")}
					</span>
					{commitCount !== undefined && (
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<GitCommit className="h-3.5 w-3.5" />
							<span className="font-medium text-foreground">
								{commitCount || 0}
							</span>{" "}
							{t("taskReview:merge.commits")}
						</span>
					)}
					<span className="flex items-center gap-1 text-success">
						<Plus className="h-3.5 w-3.5" />
						<span className="font-medium">{prData.additions || 0}</span>
					</span>
					<span className="flex items-center gap-1 text-destructive">
						<Minus className="h-3.5 w-3.5" />
						<span className="font-medium">{prData.deletions || 0}</span>
					</span>
				</div>

				{/* Branch info: spec branch → user's current branch (merge target) */}
				<div className="mt-2 text-xs text-muted-foreground">
					<code className="bg-background/80 px-1.5 py-0.5 rounded text-[11px]">
						{prData.source_branch}
					</code>
					<span className="mx-1.5">→</span>
					<code className="bg-background/80 px-1.5 py-0.5 rounded text-[11px]">
						{prData.target_branch}
					</code>
				</div>
			</div>

			{/* Info Section */}
			<div className="px-4 py-3 space-y-2 text-sm">
				<p className="text-muted-foreground">
					{t("taskReview:merge.prStatusMessage")}
				</p>
				<p className="text-xs text-muted-foreground">
					{prData.state.charAt(0).toUpperCase() + prData.state.slice(1)}
					{prData.mergeable === false && (
						<span className="ml-2 text-destructive font-medium">
							({t("taskReview:merge.notMergeable")})
						</span>
					)}
				</p>
			</div>
		</div>
	);
}
