import { CheckCircle2, Compass, FolderGit2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "../../hooks/use-toast";
import { useProjectStore } from "../../stores/project-store";
import { startGuidedTour } from "../guided-tour/guided-tour-store";
import { buildTodoTour } from "../guided-tour/tour-steps";
import { Button } from "../ui/button";
import {
	FullScreenDialog,
	FullScreenDialogBody,
	FullScreenDialogContent,
	FullScreenDialogDescription,
	FullScreenDialogHeader,
	FullScreenDialogTitle,
} from "../ui/full-screen-dialog";
import { Progress } from "../ui/progress";
import { ScrollArea } from "../ui/scroll-area";
import { SetupHubItem } from "./SetupHubItem";
import { type SetupDeepLink, useSetupStatus } from "./useSetupStatus";

interface SetupHubProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Opens the Settings dialog focused on the given section. */
	onOpenSettingsSection: (deepLink: SetupDeepLink) => void;
}

/**
 * Setup Hub ("Centre de configuration") — a guided, ordered checklist of what
 * the user still needs to configure (AI providers + project integrations),
 * each row deep-linking into the matching Settings section.
 *
 * Reuses the existing FullScreenDialog shell (same as the OnboardingWizard) and
 * the live status from `useSetupStatus`.
 */
export function SetupHub({
	open,
	onOpenChange,
	onOpenSettingsSection,
}: SetupHubProps) {
	const { t } = useTranslation("setupHub");
	const status = useSetupStatus();
	const hasProject = useProjectStore((s) => Boolean(s.selectedProjectId));

	const handleConfigure = (deepLink: SetupDeepLink) => {
		// Close the hub first so the Settings dialog takes focus cleanly.
		onOpenChange(false);
		onOpenSettingsSection(deepLink);
	};

	const handleGuideMe = () => {
		const tour = buildTodoTour(status);
		// Close the hub first, then start the tour on the next tick so the hub
		// dialog has begun unmounting before the Settings dialog opens.
		onOpenChange(false);
		if (tour.length === 0) {
			toast({ description: t("nothingToGuide") });
			return;
		}
		setTimeout(() => startGuidedTour(tour), 50);
	};

	return (
		<FullScreenDialog open={open} onOpenChange={onOpenChange}>
			<FullScreenDialogContent>
				<FullScreenDialogHeader>
					<FullScreenDialogTitle className="flex items-center gap-3">
						<Compass className="h-6 w-6" />
						{t("title")}
					</FullScreenDialogTitle>
					<FullScreenDialogDescription>
						{t("description")}
					</FullScreenDialogDescription>

					<div className="mt-4 space-y-1.5">
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">
								{t("progress", {
									completed: status.completed,
									total: status.total,
								})}
							</span>
							<span className="font-medium text-foreground">
								{status.percent}%
							</span>
						</div>
						<Progress value={status.percent} />

						{status.percent < 100 && (
							<div className="pt-1">
								<Button size="sm" onClick={handleGuideMe} className="gap-2">
									<Wand2 className="h-4 w-4" />
									{t("guideMe")}
								</Button>
							</div>
						)}
					</div>
				</FullScreenDialogHeader>

				<FullScreenDialogBody>
					<ScrollArea className="h-full">
						<div className="mx-auto w-full max-w-3xl space-y-8 p-6">
							{status.percent === 100 && (
								<div className="flex items-start gap-4 rounded-xl border border-success/30 bg-success/10 p-5">
									<CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-success" />
									<div>
										<h3 className="text-lg font-medium text-success">
											{t("allDone.title")}
										</h3>
										<p className="mt-1 text-sm text-success/80">
											{t("allDone.description")}
										</p>
									</div>
								</div>
							)}

							{status.categories.map((category) => {
								const isProjectCategory = category.id === "integrations";
								return (
									<section key={category.id} className="space-y-3">
										<h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
											{t(`categories.${category.id}`)}
										</h2>

										{isProjectCategory && !hasProject ? (
											<div className="flex items-start gap-3 rounded-xl border border-dashed border-muted-foreground/30 p-5 text-muted-foreground">
												<FolderGit2 className="mt-0.5 h-5 w-5 shrink-0" />
												<div>
													<h3 className="font-medium text-foreground">
														{t("noProject.title")}
													</h3>
													<p className="mt-1 text-sm">
														{t("noProject.description")}
													</p>
												</div>
											</div>
										) : (
											<div className="space-y-3">
												{category.items.map((item) => (
													<SetupHubItem
														key={item.id}
														item={item}
														onConfigure={() =>
															handleConfigure(item.deepLink)
														}
													/>
												))}
											</div>
										)}
									</section>
								);
							})}
						</div>
					</ScrollArea>
				</FullScreenDialogBody>
			</FullScreenDialogContent>
		</FullScreenDialog>
	);
}
