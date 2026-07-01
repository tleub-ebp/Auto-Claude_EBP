import { FolderOpen, FolderPlus, GitBranch, Sparkles, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SetupBanner } from "./setup-hub/SetupBanner";
import { Button } from "./ui/button";

interface NoProjectPageProps {
	readonly onAddProject: () => void;
}

export function NoProjectPage({ onAddProject }: NoProjectPageProps) {
	const { t } = useTranslation("common");

	return (
		<div className="flex h-full items-center justify-center p-8">
			<div className="w-full max-w-lg flex flex-col items-center gap-8">
				{/* Finish-your-setup nudge (hidden once fully configured / dismissed) */}
				<div className="w-full">
					<SetupBanner />
				</div>

				{/* Assistant bubble */}
				<div className="flex items-start gap-4 w-full">
					<div className="shrink-0 w-9 h-9 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
						<span className="text-primary text-base font-bold select-none">
							W
						</span>
					</div>
					<div className="flex-1 bg-muted/40 border border-border rounded-2xl rounded-tl-sm px-5 py-4 space-y-4">
						<p className="text-sm font-medium text-foreground">
							{t("noProject.greeting")}
						</p>
						<p className="text-sm text-muted-foreground leading-relaxed">
							{t("noProject.explanation")}
						</p>

						{/* Feature highlights */}
						<ul className="space-y-2">
							<li className="flex items-center gap-3 text-sm text-muted-foreground">
								<GitBranch className="h-4 w-4 text-primary shrink-0" />
								{t("noProject.feature1")}
							</li>
							<li className="flex items-center gap-3 text-sm text-muted-foreground">
								<Zap className="h-4 w-4 text-primary shrink-0" />
								{t("noProject.feature2")}
							</li>
							<li className="flex items-center gap-3 text-sm text-muted-foreground">
								<Sparkles className="h-4 w-4 text-primary shrink-0" />
								{t("noProject.feature3")}
							</li>
						</ul>
					</div>
				</div>

				{/* CTA */}
				<div className="flex flex-col sm:flex-row gap-3 w-full justify-center">
					<Button size="lg" onClick={onAddProject} className="gap-2">
						<FolderPlus className="h-4 w-4" />
						{t("noProject.ctaNew")}
					</Button>
					<Button
						size="lg"
						variant="outline"
						onClick={onAddProject}
						className="gap-2"
					>
						<FolderOpen className="h-4 w-4" />
						{t("noProject.ctaExisting")}
					</Button>
				</div>
			</div>
		</div>
	);
}
