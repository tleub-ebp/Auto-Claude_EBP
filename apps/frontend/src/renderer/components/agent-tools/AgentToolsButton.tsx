import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { CostEstimatorDialog } from "./CostEstimatorDialog";
import { PromotionDecisionDialog } from "./PromotionDecisionDialog";
import { PromptPreviewDialog } from "./PromptPreviewDialog";
import { RestartDialog } from "./RestartDialog";
import { TimelineDialog } from "./TimelineDialog";
import { VariationsDialog } from "./VariationsDialog";
import { VirtualReviewerDialog } from "./VirtualReviewerDialog";
import type {
	PromotionDecision,
	RestartMode,
} from "../../lib/agent-tools-api";

export interface AgentToolsButtonProps {
	readonly projectDir: string;
	readonly specDir: string;
	/** "coder" | "planner" | "qa_reviewer" | "qa_fixer" — defaults to coder. */
	readonly agentType?: string;
	/**
	 * Triggered by the cost estimator's "Start build" button. The hosting
	 * Kanban already knows how to spawn agents — this is just the user's
	 * confirmation that the cost is acceptable.
	 */
	readonly onStartBuild?: () => void;
	/**
	 * Triggered after the restart-prepare endpoint cleans up. The hosting
	 * Kanban is responsible for actually re-spawning the agent (via its
	 * existing electronAPI handlers). The mode + deleted files are passed
	 * for logging.
	 */
	readonly onRestart?: (mode: RestartMode, deleted: string[]) => void;
	/**
	 * Triggered when the user accepts the auto-promotion suggestion. The
	 * Kanban moves the card from ai_review to (after) human_review.
	 */
	readonly onPromote?: (decision: PromotionDecision) => void;
	/**
	 * Triggered when the user picks a winning variation in the Arena.
	 * The Kanban does the actual merge (we never auto-merge).
	 */
	readonly onPickVariation?: (label: string, path: string) => void;
	/**
	 * Triggered after virtual_review.md is written. The Kanban can show a
	 * notification or refresh its file tree.
	 */
	readonly onVirtualReviewWritten?: (path: string) => void;
	/**
	 * Subset of tools to show. Defaults to all of them. Useful when a card
	 * is in a state where, say, the cost estimator is irrelevant (already
	 * running) or the prompt preview makes no sense (no spec yet).
	 */
	readonly tools?: ReadonlyArray<
		| "cost"
		| "restart"
		| "prompt"
		| "timeline"
		| "promotion"
		| "variations"
		| "virtual_review"
	>;
}

const ALL_TOOLS = [
	"cost",
	"restart",
	"prompt",
	"timeline",
	"promotion",
	"variations",
	"virtual_review",
] as const;

export function AgentToolsButton({
	projectDir,
	specDir,
	agentType = "coder",
	onStartBuild,
	onRestart,
	onPromote,
	onPickVariation,
	onVirtualReviewWritten,
	tools = ALL_TOOLS,
}: AgentToolsButtonProps) {
	const { t } = useTranslation("agentTools");
	const [openCost, setOpenCost] = useState(false);
	const [openRestart, setOpenRestart] = useState(false);
	const [openPrompt, setOpenPrompt] = useState(false);
	const [openTimeline, setOpenTimeline] = useState(false);
	const [openPromotion, setOpenPromotion] = useState(false);
	const [openVariations, setOpenVariations] = useState(false);
	const [openVirtualReview, setOpenVirtualReview] = useState(false);

	const showCost = tools.includes("cost");
	const showRestart = tools.includes("restart");
	const showPrompt = tools.includes("prompt");
	const showTimeline = tools.includes("timeline");
	const showPromotion = tools.includes("promotion");
	const showVariations = tools.includes("variations");
	const showVirtualReview = tools.includes("virtual_review");

	if (
		!showCost &&
		!showRestart &&
		!showPrompt &&
		!showTimeline &&
		!showPromotion &&
		!showVariations &&
		!showVirtualReview
	) {
		return null;
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						aria-label={t("menuLabel")}
					>
						{t("buttonLabel")}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					<DropdownMenuLabel>{t("menuLabel")}</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{showCost && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenCost(true);
							}}
						>
							{t("estimateCost")}
						</DropdownMenuItem>
					)}
					{showRestart && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenRestart(true);
							}}
						>
							{t("restartAgent")}
						</DropdownMenuItem>
					)}
					{showPrompt && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenPrompt(true);
							}}
						>
							{t("showActivePrompt")}
						</DropdownMenuItem>
					)}
					{showTimeline && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenTimeline(true);
							}}
						>
							{t("showTimeline", "Show timeline…")}
						</DropdownMenuItem>
					)}
					{showPromotion && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenPromotion(true);
							}}
						>
							{t("checkPromotion", "Check QA promotion…")}
						</DropdownMenuItem>
					)}
					{showVariations && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenVariations(true);
							}}
						>
							{t("manageVariations", "Variations (Arena)…")}
						</DropdownMenuItem>
					)}
					{showVirtualReview && (
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								setOpenVirtualReview(true);
							}}
						>
							{t("virtualReviewer", "Virtual reviewer…")}
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			{showCost && (
				<CostEstimatorDialog
					open={openCost}
					onOpenChange={setOpenCost}
					specDir={specDir}
					onConfirm={() => onStartBuild?.()}
				/>
			)}
			{showRestart && (
				<RestartDialog
					open={openRestart}
					onOpenChange={setOpenRestart}
					specDir={specDir}
					onRestartReady={(mode, deleted) => onRestart?.(mode, deleted)}
				/>
			)}
			{showPrompt && (
				<PromptPreviewDialog
					open={openPrompt}
					onOpenChange={setOpenPrompt}
					projectDir={projectDir}
					specDir={specDir}
					agentType={agentType}
				/>
			)}
			{showTimeline && (
				<TimelineDialog
					open={openTimeline}
					onOpenChange={setOpenTimeline}
					projectDir={projectDir}
					// correlation_id = the spec_id, which is the spec_dir's basename.
					// Mirrors what `agents/agent_audit.py` writes to the trail.
					correlationId={specDir.split(/[/\\]/).pop() ?? ""}
				/>
			)}
			{showPromotion && (
				<PromotionDecisionDialog
					open={openPromotion}
					onOpenChange={setOpenPromotion}
					specDir={specDir}
					onAcceptPromotion={(d) => onPromote?.(d)}
				/>
			)}
			{showVariations && (
				<VariationsDialog
					open={openVariations}
					onOpenChange={setOpenVariations}
					specDir={specDir}
					onPickWinner={(label, path) => onPickVariation?.(label, path)}
				/>
			)}
			{showVirtualReview && (
				<VirtualReviewerDialog
					open={openVirtualReview}
					onOpenChange={setOpenVirtualReview}
					projectDir={projectDir}
					specDir={specDir}
					onReviewWritten={(path) => onVirtualReviewWritten?.(path)}
				/>
			)}
		</>
	);
}
