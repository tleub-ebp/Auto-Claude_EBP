import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "../ui/card";
import { translateBackendError } from "./_translate-backend-error";

interface PanelShellProps {
	readonly title: string;
	readonly subtitle?: string;
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly error?: string | null;
}

/**
 * Lightweight wrapper used by every Phase 3-5 panel.
 *
 * Keeps the layout consistent (title + optional subtitle + actions row +
 * body + inline error) without dragging in a heavy header component.
 *
 * Backend error strings (raw English from the Python API) are routed
 * through the localizer so users see French messages in FR mode.
 */
export function PanelShell({ title, subtitle, actions, children, error }: PanelShellProps) {
	const { t } = useTranslation("phase35");
	const localizedError = translateBackendError(error, t);
	return (
		<Card className="p-4 space-y-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-lg font-semibold">{title}</h2>
					{subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
				</div>
				{actions && <div className="flex items-center gap-2">{actions}</div>}
			</div>
			{localizedError && (
				<div className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
					{localizedError}
				</div>
			)}
			<div>{children}</div>
		</Card>
	);
}
