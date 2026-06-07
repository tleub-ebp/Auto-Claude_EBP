import { Maximize2, Minimize2 } from "lucide-react";
import * as React from "react";
import { useCallback, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * Tailwind classes that expand a dialog/popin to fill the whole viewport. Append
 * these *last* in a `cn(...)` call so tailwind-merge lets them win over each
 * dialog's own sizing (max-w-*, h-*, rounded-*, w-*).
 */
export const DIALOG_MAXIMIZED_CLASS =
	"max-w-none w-screen h-screen rounded-none";

/**
 * Local maximize/restore state for a popin. Pass a `storageKey` to remember the
 * user's choice across re-opens (persisted in localStorage, best-effort).
 */
export function useDialogMaximize(storageKey?: string): {
	maximized: boolean;
	toggle: () => void;
	setMaximized: (value: boolean) => void;
} {
	const [maximized, setMaximizedState] = useState<boolean>(() => {
		if (!storageKey) return false;
		try {
			return localStorage.getItem(storageKey) === "true";
		} catch {
			return false;
		}
	});

	const persist = useCallback(
		(value: boolean) => {
			if (!storageKey) return;
			try {
				localStorage.setItem(storageKey, String(value));
			} catch {
				/* ignore quota / privacy-mode errors */
			}
		},
		[storageKey],
	);

	const setMaximized = useCallback(
		(value: boolean) => {
			setMaximizedState(value);
			persist(value);
		},
		[persist],
	);

	const toggle = useCallback(() => {
		setMaximizedState((prev) => {
			const next = !prev;
			persist(next);
			return next;
		});
	}, [persist]);

	return { maximized, toggle, setMaximized };
}

interface DialogMaximizeButtonProps
	extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onToggle"> {
	maximized: boolean;
	onToggle: () => void;
	maximizeLabel?: string;
	restoreLabel?: string;
}

/**
 * Toggle button that morphs between a "maximize" and "restore" glyph with a
 * spring-like scale/rotate cross-fade. Drop it into any dialog header next to the
 * close button. Forwards its ref and extra props so it works as a Radix
 * Tooltip/Slot trigger (`asChild`).
 */
export const DialogMaximizeButton = React.forwardRef<
	HTMLButtonElement,
	DialogMaximizeButtonProps
>(
	(
		{
			maximized,
			onToggle,
			className,
			maximizeLabel = "Fullscreen",
			restoreLabel = "Restore",
			onClick,
			...props
		},
		ref,
	) => {
		const label = maximized ? restoreLabel : maximizeLabel;
		return (
			<button
				ref={ref}
				type="button"
				{...props}
				// Compose with any injected handler (e.g. Radix Tooltip's onClick that
				// dismisses the tooltip) so the maximize toggle still fires.
				onClick={(event) => {
					onClick?.(event);
					onToggle();
				}}
				aria-label={label}
				title={label}
				className={cn(
					"group relative inline-flex h-8 w-8 shrink-0 items-center justify-center",
					"rounded-lg text-muted-foreground",
					"transition-all duration-200 ease-out",
					"hover:bg-accent hover:text-foreground",
					"focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					"active:scale-90",
					className,
				)}
			>
				<Maximize2
					className={cn(
						"absolute h-4 w-4 transition-all duration-300 ease-out",
						maximized
							? "scale-50 rotate-45 opacity-0"
							: "scale-100 rotate-0 opacity-100 group-hover:scale-110",
					)}
				/>
				<Minimize2
					className={cn(
						"absolute h-4 w-4 transition-all duration-300 ease-out",
						maximized
							? "scale-100 rotate-0 opacity-100 group-hover:scale-110"
							: "scale-50 -rotate-45 opacity-0",
					)}
				/>
			</button>
		);
	},
);
DialogMaximizeButton.displayName = "DialogMaximizeButton";
