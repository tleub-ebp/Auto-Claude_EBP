import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * Custom scroll area that avoids Radix's ScrollAreaRoot/ScrollAreaScrollbar
 * components, which trigger a React 19 "Maximum update depth exceeded" loop.
 *
 * Root cause: Radix 1.2.x uses `useComposedRefs(forwardedRef, (node) => setState(node))`
 * with an inline arrow function, creating a new composed ref on every render.
 * React 19's synchronous `flushSpawnedWork` then re-flushes the setState call
 * triggered during ref attachment, creating an infinite loop.
 *
 * Fix: replace with plain divs + native CSS scrollbar styling.
 * The viewport div keeps `data-radix-scroll-area-viewport=""` so that existing
 * DOM queries (`element.closest('[data-radix-scroll-area-viewport]')`) still work.
 */
const ScrollArea = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement> & {
		viewportClassName?: string;
		onViewportRef?: (element: HTMLDivElement | null) => void;
	}
>(
	(
		{ className, children, viewportClassName, onViewportRef, ...props },
		ref,
	) => {
		const viewportCallbackRef = React.useCallback(
			(element: HTMLDivElement | null) => {
				onViewportRef?.(element);
			},
			[onViewportRef],
		);

		return (
			<div
				ref={ref}
				className={cn("relative overflow-hidden", className)}
				{...props}
			>
				<div
					ref={viewportCallbackRef}
					data-radix-scroll-area-viewport=""
					className={cn(
						// Scrollbar styling comes from the global themed rules in
						// globals.css. Do NOT set `scrollbar-width`/`scrollbar-color`
						// here: on Chromium >= 121 either one disables all
						// ::-webkit-scrollbar-* styling and renders the native
						// (light-scheme) scrollbar instead.
						"h-full w-full rounded-[inherit] overflow-auto",
						viewportClassName,
					)}
				>
					{children}
				</div>
			</div>
		);
	},
);
ScrollArea.displayName = "ScrollArea";

// Kept for API compatibility; scrollbars are now rendered natively via CSS on the viewport.
const ScrollBar = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement> & {
		orientation?: "vertical" | "horizontal";
	}
>((_props, _ref) => null);
ScrollBar.displayName = "ScrollBar";

export { ScrollArea, ScrollBar };
