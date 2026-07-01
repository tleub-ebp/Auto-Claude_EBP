import { Compass, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { useSetupHubStore } from "../../stores/setup-hub-store";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { useSetupStatus } from "./useSetupStatus";

/**
 * Dismissible "finish your setup" banner for the home / empty state.
 * Hides itself once everything is configured or the user dismisses it
 * (persisted via `settings.setupBannerDismissed`).
 */
export function SetupBanner() {
	const { t } = useTranslation("setupHub");
	const status = useSetupStatus();
	const openSetupHub = useSetupHubStore((s) => s.openSetupHub);
	const dismissed = useSettingsStore((s) => s.settings.setupBannerDismissed);

	// Nothing left to do, or the user told us to stop nudging.
	if (dismissed || status.percent >= 100) return null;

	return (
		<div className="flex items-center gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
				<Compass className="h-5 w-5" />
			</div>
			<div className="min-w-0 flex-1">
				<h3 className="font-medium text-foreground">{t("banner.title")}</h3>
				<p className="mt-0.5 text-sm text-muted-foreground">
					{t("banner.description", {
						completed: status.completed,
						total: status.total,
					})}
				</p>
				<Progress value={status.percent} className="mt-2" />
			</div>
			<Button onClick={() => openSetupHub()} className="shrink-0 gap-2">
				<Compass className="h-4 w-4" />
				{t("banner.cta")}
			</Button>
			<Button
				variant="ghost"
				size="icon"
				className="shrink-0"
				aria-label={t("banner.dismiss")}
				onClick={() => saveSettings({ setupBannerDismissed: true })}
			>
				<X className="h-4 w-4" />
			</Button>
		</div>
	);
}
