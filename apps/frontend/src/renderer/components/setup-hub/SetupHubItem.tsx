import { ArrowRight, CheckCircle2, Circle, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import type { SetupItem } from "./useSetupStatus";

interface SetupHubItemProps {
	item: SetupItem;
	onConfigure: () => void;
}

/**
 * One checklist row in the Setup Hub. Visual pattern mirrors `NextStepCard`
 * from the onboarding CompletionStep (icon pill + title + muted description +
 * link button), with a leading state icon and a state badge.
 */
export function SetupHubItem({ item, onConfigure }: SetupHubItemProps) {
	const { t } = useTranslation("setupHub");

	const stateIcon = {
		done: <CheckCircle2 className="h-5 w-5 text-success" />,
		todo: <Circle className="h-5 w-5 text-muted-foreground" />,
		error: <TriangleAlert className="h-5 w-5 text-warning" />,
	}[item.state];

	const stateBadgeVariant = {
		done: "success",
		todo: "muted",
		error: "warning",
	}[item.state] as "success" | "muted" | "warning";

	// "Edit" reads better than "Configure" for something already set up.
	const actionLabel =
		item.state === "done" ? t("actions.edit") : t("actions.configure");

	return (
		<Card
			className={cn(
				"border border-border bg-card/50 backdrop-blur-sm transition-colors",
				item.state === "done" && "border-success/30",
			)}
		>
			<CardContent className="p-4">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 shrink-0">{stateIcon}</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<h3 className="font-medium text-foreground">
								{t(`items.${item.id}.label`)}
							</h3>
							<Badge variant={stateBadgeVariant}>
								{t(`state.${item.state}`)}
							</Badge>
							{item.progress && (
								<span className="text-xs text-muted-foreground">
									{t("providersCount", {
										configured: item.progress.configured,
										total: item.progress.total,
									})}
								</span>
							)}
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							{t(`items.${item.id}.desc`)}
						</p>
					</div>
					<Button
						variant={item.state === "done" ? "ghost" : "outline"}
						size="sm"
						onClick={onConfigure}
						className="shrink-0 gap-1"
					>
						{actionLabel}
						<ArrowRight className="h-3.5 w-3.5" />
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
