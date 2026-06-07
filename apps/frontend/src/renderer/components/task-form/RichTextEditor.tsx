/**
 * RichTextEditor - Lightweight WYSIWYG editor for task descriptions.
 *
 * Renders HTML content visually (instead of showing raw markup) while staying
 * editable. Built on a `contentEditable` element + `document.execCommand`, which
 * is reliable in the app's single Chromium runtime (Electron) and preserves
 * imported HTML (e.g. Azure DevOps) far better than a schema-based editor.
 *
 * Content is sanitized on display and theme-adapted via {@link prepareRichTextForDisplay}.
 */
import {
	Bold,
	Italic,
	Link as LinkIcon,
	List,
	ListOrdered,
	RemoveFormatting,
	Underline,
} from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { escapeHtml, prepareRichTextForDisplay } from "./rich-text-utils";

interface RichTextEditorProps {
	/** Current HTML value (controlled). */
	value: string;
	/** Called with the new HTML whenever the content changes. */
	onChange: (html: string) => void;
	placeholder?: string;
	disabled?: boolean;
	id?: string;
	ariaRequired?: boolean;
	ariaDescribedBy?: string;
	className?: string;
	/** Highlight the editor as a drop target. */
	isDragOver?: boolean;
	onPaste?: (e: ClipboardEvent<HTMLElement>) => void;
	onDragOver?: (e: DragEvent<HTMLElement>) => void;
	onDragLeave?: (e: DragEvent<HTMLElement>) => void;
	onDrop?: (e: DragEvent<HTMLElement>) => void;
}

/** Prose styling mirrored from the read-only description renderer for consistency. */
const editorProseClasses = cn(
	"prose prose-sm dark:prose-invert max-w-none",
	"prose-p:text-foreground/90 prose-p:leading-relaxed prose-p:my-2",
	"prose-headings:text-foreground prose-headings:font-semibold",
	"prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-h4:text-sm",
	"prose-strong:text-foreground prose-strong:font-semibold",
	"prose-em:text-foreground/90 prose-em:italic",
	"prose-ul:my-2 prose-ul:pl-6 prose-ol:my-2 prose-ol:pl-6",
	"prose-li:text-foreground/90 prose-li:my-0.5",
	"prose-a:text-info prose-a:underline hover:prose-a:text-info/80",
	"prose-img:max-w-full prose-img:h-auto prose-img:rounded-md prose-img:border prose-img:border-border",
	"prose-hr:border-border prose-hr:my-4",
	"prose-blockquote:border-l-4 prose-blockquote:border-muted-foreground/30 prose-blockquote:pl-4 prose-blockquote:italic",
	"prose-code:text-foreground prose-code:bg-muted/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded",
	"prose-code:before:content-none prose-code:after:content-none",
	"text-foreground",
);

interface ToolbarButtonProps {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}

function ToolbarButton({
	label,
	active,
	disabled,
	onClick,
	children,
}: ToolbarButtonProps) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={active}
			disabled={disabled}
			// Keep the editor's text selection when interacting with the toolbar.
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
				"hover:bg-muted hover:text-foreground",
				"disabled:opacity-50 disabled:pointer-events-none",
				active && "bg-muted text-foreground",
			)}
		>
			{children}
		</button>
	);
}

export function RichTextEditor({
	value,
	onChange,
	placeholder,
	disabled = false,
	id,
	ariaRequired,
	ariaDescribedBy,
	className,
	isDragOver,
	onPaste,
	onDragOver,
	onDragLeave,
	onDrop,
}: RichTextEditorProps) {
	const { t } = useTranslation("tasks");
	const editorRef = useRef<HTMLDivElement>(null);
	// Tracks the value we last reflected in the DOM, so external updates re-sync
	// the innerHTML but our own edits don't (which would move the caret).
	const lastValueRef = useRef<string | null>(null);

	const [isEmpty, setIsEmpty] = useState(true);
	const [active, setActive] = useState({
		bold: false,
		italic: false,
		underline: false,
		ul: false,
		ol: false,
	});

	// Link popover state
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const savedRangeRef = useRef<Range | null>(null);

	const computeEmpty = useCallback((el: HTMLElement) => {
		return !el.textContent?.trim() && !el.querySelector("img, hr, table");
	}, []);

	// Sync external value -> DOM (only when it actually changed externally).
	useEffect(() => {
		const el = editorRef.current;
		if (!el) return;
		if (value === lastValueRef.current) return;
		el.innerHTML = prepareRichTextForDisplay(value || "");
		lastValueRef.current = value;
		setIsEmpty(computeEmpty(el));
	}, [value, computeEmpty]);

	const emitChange = useCallback(() => {
		const el = editorRef.current;
		if (!el) return;
		const empty = computeEmpty(el);
		setIsEmpty(empty);
		const html = empty ? "" : el.innerHTML;
		lastValueRef.current = html;
		onChange(html);
	}, [onChange, computeEmpty]);

	const updateActive = useCallback(() => {
		const el = editorRef.current;
		const sel = window.getSelection();
		if (!el || !sel || !el.contains(sel.anchorNode)) return;
		try {
			setActive({
				bold: document.queryCommandState("bold"),
				italic: document.queryCommandState("italic"),
				underline: document.queryCommandState("underline"),
				ul: document.queryCommandState("insertUnorderedList"),
				ol: document.queryCommandState("insertOrderedList"),
			});
		} catch {
			// queryCommandState can throw if the selection is detached; ignore.
		}
	}, []);

	useEffect(() => {
		document.addEventListener("selectionchange", updateActive);
		return () => document.removeEventListener("selectionchange", updateActive);
	}, [updateActive]);

	const exec = useCallback(
		(command: string, val?: string) => {
			if (disabled) return;
			editorRef.current?.focus();
			document.execCommand(command, false, val);
			emitChange();
			updateActive();
		},
		[disabled, emitChange, updateActive],
	);

	const getSelectionAnchorHref = useCallback((): string => {
		const sel = window.getSelection();
		let node = (sel?.anchorNode ?? null) as Node | null;
		while (node && node !== editorRef.current) {
			if (node instanceof HTMLAnchorElement) {
				return node.getAttribute("href") ?? "";
			}
			node = node.parentNode;
		}
		return "";
	}, []);

	const openLinkPopover = useCallback(() => {
		if (disabled) return;
		const sel = window.getSelection();
		savedRangeRef.current =
			sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
		setLinkUrl(getSelectionAnchorHref());
		setLinkOpen(true);
	}, [disabled, getSelectionAnchorHref]);

	const applyLink = useCallback(() => {
		const el = editorRef.current;
		if (!el) return;
		const url = linkUrl.trim();
		el.focus();
		const sel = window.getSelection();
		if (sel && savedRangeRef.current) {
			sel.removeAllRanges();
			sel.addRange(savedRangeRef.current);
		}
		if (!url) {
			document.execCommand("unlink");
		} else if (savedRangeRef.current && !savedRangeRef.current.collapsed) {
			document.execCommand("createLink", false, url);
		} else {
			// Nothing selected: insert the URL itself as a link.
			document.execCommand(
				"insertHTML",
				false,
				`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
			);
		}
		emitChange();
		setLinkOpen(false);
		setLinkUrl("");
		savedRangeRef.current = null;
	}, [linkUrl, emitChange]);

	return (
		<div
			className={cn(
				"rounded-md border border-input bg-background transition-colors",
				isDragOver &&
					!disabled &&
					"border-primary bg-primary/5 ring-2 ring-primary/20",
				disabled && "opacity-60",
				className,
			)}
		>
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
				<ToolbarButton
					label={t("form.editor.bold")}
					active={active.bold}
					disabled={disabled}
					onClick={() => exec("bold")}
				>
					<Bold className="h-4 w-4" />
				</ToolbarButton>
				<ToolbarButton
					label={t("form.editor.italic")}
					active={active.italic}
					disabled={disabled}
					onClick={() => exec("italic")}
				>
					<Italic className="h-4 w-4" />
				</ToolbarButton>
				<ToolbarButton
					label={t("form.editor.underline")}
					active={active.underline}
					disabled={disabled}
					onClick={() => exec("underline")}
				>
					<Underline className="h-4 w-4" />
				</ToolbarButton>

				<span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

				<ToolbarButton
					label={t("form.editor.bulletList")}
					active={active.ul}
					disabled={disabled}
					onClick={() => exec("insertUnorderedList")}
				>
					<List className="h-4 w-4" />
				</ToolbarButton>
				<ToolbarButton
					label={t("form.editor.numberedList")}
					active={active.ol}
					disabled={disabled}
					onClick={() => exec("insertOrderedList")}
				>
					<ListOrdered className="h-4 w-4" />
				</ToolbarButton>

				<span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

				<Popover
					open={linkOpen}
					onOpenChange={(open) => {
						setLinkOpen(open);
						if (!open) {
							setLinkUrl("");
							savedRangeRef.current = null;
						}
					}}
				>
					<PopoverAnchor asChild>
						<button
							type="button"
							aria-label={t("form.editor.link")}
							title={t("form.editor.link")}
							disabled={disabled}
							onMouseDown={(e) => {
								e.preventDefault();
								openLinkPopover();
							}}
							className={cn(
								"inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
								"hover:bg-muted hover:text-foreground",
								"disabled:opacity-50 disabled:pointer-events-none",
							)}
						>
							<LinkIcon className="h-4 w-4" />
						</button>
					</PopoverAnchor>
					<PopoverContent align="start" className="w-72 p-2">
						<form
							onSubmit={(e) => {
								e.preventDefault();
								applyLink();
							}}
							className="flex items-center gap-2"
						>
							<Input
								autoFocus
								value={linkUrl}
								onChange={(e) => setLinkUrl(e.target.value)}
								placeholder={t("form.editor.linkPlaceholder")}
								className="h-8 text-sm"
							/>
							<Button type="submit" size="sm" className="h-8 shrink-0">
								{t("form.editor.apply")}
							</Button>
						</form>
					</PopoverContent>
				</Popover>

				<span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

				<ToolbarButton
					label={t("form.editor.clearFormatting")}
					disabled={disabled}
					onClick={() => {
						exec("removeFormat");
						exec("unlink");
					}}
				>
					<RemoveFormatting className="h-4 w-4" />
				</ToolbarButton>
			</div>

			{/* Editable area */}
			<div className="relative">
				{isEmpty && placeholder && (
					<div className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
						{placeholder}
					</div>
				)}
				{/* biome-ignore lint/a11y/useSemanticElements: a contentEditable element is required to render/edit HTML; <input>/<textarea> cannot display formatted markup */}
				<div
					ref={editorRef}
					id={id}
					role="textbox"
					tabIndex={disabled ? -1 : 0}
					aria-multiline="true"
					aria-required={ariaRequired}
					aria-describedby={ariaDescribedBy}
					contentEditable={!disabled}
					suppressContentEditableWarning
					spellCheck
					onInput={emitChange}
					onBlur={emitChange}
					onKeyUp={updateActive}
					onMouseUp={updateActive}
					onPaste={onPaste}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
					className={cn(
						"min-h-[150px] max-h-[400px] resize-y overflow-auto px-3 py-2 outline-none",
						editorProseClasses,
					)}
					style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
				/>
			</div>
		</div>
	);
}
