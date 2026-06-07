import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import {
	DIALOG_MAXIMIZED_CLASS,
	DialogMaximizeButton,
	useDialogMaximize,
} from "./dialog-maximize";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Overlay
		ref={ref}
		className={cn(
			"fixed inset-0 z-60 bg-black/80 backdrop-blur-sm",
			"data-[state=open]:animate-in data-[state=closed]:animate-out",
			"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
			className,
		)}
		{...props}
	/>
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps
	extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
	hideCloseButton?: boolean;
	/**
	 * Show a maximize/restore toggle that expands the popin to fullscreen.
	 * Defaults to `true` whenever the standard close button is rendered.
	 */
	maximizable?: boolean;
}

const DialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	DialogContentProps
>(({ className, children, hideCloseButton, maximizable, ...props }, ref) => {
	const { maximized, toggle } = useDialogMaximize();
	// Maximize lives alongside the standard close affordance; custom headers
	// (hideCloseButton) opt in explicitly via the exported button.
	const showMaximize = (maximizable ?? true) && !hideCloseButton;
	return (
		<DialogPortal>
			<DialogOverlay />
			<div className="fixed inset-0 z-60 flex items-center justify-center pointer-events-none">
				<DialogPrimitive.Content
					ref={ref}
					className={cn(
						"z-60 p-4 w-full max-w-lg pointer-events-auto",
						"bg-card border border-border rounded-2xl",
						"shadow-xl overflow-hidden outline-none",
						"transition-[width,max-width,height,border-radius] ease-out",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
						"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
						"duration-200",
						className,
						// Appended last so tailwind-merge overrides the dialog's own sizing.
						maximized && DIALOG_MAXIMIZED_CLASS,
					)}
					{...props}
				>
					<div className="p-6 flex flex-col h-full min-h-0 overflow-hidden">
						{children}
						{(showMaximize || !hideCloseButton) && (
							<div className="absolute right-3 top-3 z-10 flex items-center gap-1">
								{showMaximize && (
									<DialogMaximizeButton
										maximized={maximized}
										onToggle={toggle}
										className="h-7 w-7"
									/>
								)}
								{!hideCloseButton && (
									<DialogPrimitive.Close
										className={cn(
											"rounded-lg p-1.5",
											"text-muted-foreground hover:text-foreground",
											"hover:bg-accent transition-colors",
											"focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
											"disabled:pointer-events-none",
										)}
									>
										<X className="h-4 w-4" />
										<span className="sr-only">Close</span>
									</DialogPrimitive.Close>
								)}
							</div>
						)}
					</div>
				</DialogPrimitive.Content>
			</div>
		</DialogPortal>
	);
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex flex-col space-y-4 text-center sm:text-left",
			className,
		)}
		{...props}
	/>
);
DialogHeader.displayName = "DialogHeader";

export const DialogFooter = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex flex-col-reverse sm:flex-row sm:justify-center sm:space-x-3 mt-6 px-4",
			className,
		)}
		{...props}
	/>
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Title
		ref={ref}
		className={cn(
			"text-lg font-semibold leading-none tracking-tight text-foreground",
			className,
		)}
		{...props}
	/>
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description
		ref={ref}
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogClose,
	DialogTrigger,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
};
