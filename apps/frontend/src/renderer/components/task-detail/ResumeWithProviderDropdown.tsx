/**
 * ResumeWithProviderDropdown
 * ==========================
 *
 * "Reprendre avec un autre provider" — Niveau 3b UI.
 *
 * Lists every provider configured on the user's machine and resumes the
 * current task under the chosen one. Backend wiring:
 *   - On click → `electronAPI.resumeTaskWithProvider(taskId, providerName)`
 *   - The handler writes a `RESUME_WITH_PROVIDER` marker in the task spec
 *     dir and restarts the subprocess.
 *   - Python's `_get_active_provider()` consumes the marker once on session
 *     start, then `_maybe_replay_conversation()` replays the persisted
 *     conversation.jsonl into the new provider's client.
 *
 * Only providers detected as configured (a profile or global API key
 * present) appear in the menu; the rest are hidden because picking them
 * would just fail the restart immediately.
 */

import { ChevronDown, Loader2, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getStaticProviders } from "../../../shared/utils/providers";
import { debugError } from "../../../shared/utils/debug-logger";
import { useToast } from "../../hooks/use-toast";
import { useSettingsStore } from "../../stores/settings-store";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface ResumeWithProviderDropdownProps {
	readonly taskId: string;
	/** Current provider running this task, hidden from the menu (no-op switch). */
	readonly currentProvider?: string;
	/** Render the dropdown trigger as a small button next to the primary action. */
	readonly variant?: "default" | "outline";
	readonly disabled?: boolean;
}

interface AvailableProvider {
	name: string;
	label: string;
}

export function ResumeWithProviderDropdown({
	taskId,
	currentProvider,
	variant = "outline",
	disabled = false,
}: ResumeWithProviderDropdownProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const { toast } = useToast();
	const settings = useSettingsStore((s) => s.settings);
	const profiles = useSettingsStore((s) => s.profiles);

	const [isLoading, setIsLoading] = useState(false);
	const [isResuming, setIsResuming] = useState<string | null>(null);
	const [providers, setProviders] = useState<AvailableProvider[]>([]);

	// Build the list of providers that are actually configured. We re-derive
	// every time settings or profiles change so that adding a key in Settings
	// shows up here without re-mount.
	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		getStaticProviders(
			profiles,
			settings as unknown as Record<string, unknown>,
		)
			.then((res) => {
				if (cancelled) return;
				const configured: AvailableProvider[] = res.providers
					.filter((p) => res.status[p.name] === true)
					.filter(
						(p) => p.name.toLowerCase() !== currentProvider?.toLowerCase(),
					)
					.map((p) => ({ name: p.name, label: p.label }));
				setProviders(configured);
			})
			.catch((err) => {
				debugError("[ResumeWithProviderDropdown] getStaticProviders failed", err);
				if (!cancelled) setProviders([]);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [profiles, settings, currentProvider]);

	const hasOptions = useMemo(() => providers.length > 0, [providers]);

	const handlePick = async (providerName: string, providerLabel: string) => {
		setIsResuming(providerName);
		try {
			const res = await globalThis.electronAPI.resumeTaskWithProvider(
				taskId,
				providerName,
			);
			if (res?.success) {
				toast({
					title: t(
						"tasks:modal.actions.resumeWithProviderSuccessTitle",
						"Reprise avec {{provider}}",
						{ provider: providerLabel },
					),
					description: t(
						"tasks:modal.actions.resumeWithProviderSuccessDesc",
						"La conversation précédente sera rejouée vers le nouveau provider.",
					),
					variant: "default",
				});
			} else {
				toast({
					title: t(
						"tasks:modal.actions.resumeWithProviderErrorTitle",
						"Échec de la reprise",
					),
					description: res?.error || "Unknown error",
					variant: "destructive",
				});
			}
		} catch (err) {
			debugError("[ResumeWithProviderDropdown] resumeTaskWithProvider failed", err);
			toast({
				title: t(
					"tasks:modal.actions.resumeWithProviderErrorTitle",
					"Échec de la reprise",
				),
				description: err instanceof Error ? err.message : String(err),
				variant: "destructive",
			});
		} finally {
			setIsResuming(null);
		}
	};

	// Hide the dropdown entirely if there are no alternative configured
	// providers — surfacing an empty menu would just confuse the user.
	if (!isLoading && !hasOptions) {
		return null;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant={variant}
					size="default"
					disabled={disabled || isLoading || isResuming !== null}
					title={t(
						"tasks:modal.actions.resumeWithProviderTooltip",
						"Reprendre cette tâche avec un autre provider LLM",
					)}
				>
					{isResuming ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							{t(
								"tasks:modal.actions.resumingWithProvider",
								"Reprise en cours…",
							)}
						</>
					) : (
						<>
							<RefreshCcw className="mr-2 h-4 w-4" />
							{t(
								"tasks:modal.actions.resumeWithProvider",
								"Reprendre avec…",
							)}
							<ChevronDown className="ml-2 h-4 w-4 opacity-70" />
						</>
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel>
					{t(
						"tasks:modal.actions.resumeWithProviderMenuLabel",
						"Choisir un provider",
					)}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{providers.map((p) => (
					<DropdownMenuItem
						key={p.name}
						disabled={isResuming !== null}
						onSelect={() => handlePick(p.name, p.label)}
					>
						{p.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
