import type { FileSearchResult } from "@shared/types";
import { FileCode, Folder, Loader2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";

interface FilePathAutocompleteProps {
	/** Current path value (project-relative, POSIX-style). */
	readonly value: string;
	/** Called with the new value on every keystroke and on selection. */
	readonly onChange: (value: string) => void;
	/** Absolute project root the search is scoped to. */
	readonly rootPath: string;
	/** Whether to suggest files or directories. */
	readonly mode: "file" | "directory";
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly className?: string;
	readonly id?: string;
}

const SEARCH_DEBOUNCE_MS = 180;

/**
 * A text input that suggests project files/directories matching what the user
 * types. Matching runs recursively in the main process (see
 * `FILE_EXPLORER_SEARCH`) against the project root; suggestions are ranked with
 * the closest matches first. Choosing a suggestion fills the input with its
 * project-relative path.
 */
export function FilePathAutocomplete({
	value,
	onChange,
	rootPath,
	mode,
	placeholder,
	disabled,
	className,
	id,
}: FilePathAutocompleteProps) {
	const { t } = useTranslation(["documentation"]);
	const generatedId = useId();
	const listboxId = `${id ?? generatedId}-listbox`;

	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [suggestions, setSuggestions] = useState<FileSearchResult[]>([]);
	const [activeIndex, setActiveIndex] = useState(-1);

	const containerRef = useRef<HTMLDivElement>(null);
	// Latest-wins guard so a slow earlier search can't overwrite a newer one.
	const requestSeq = useRef(0);
	// Suppress the search that a programmatic selection would otherwise trigger.
	const suppressSearch = useRef(false);
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const runSearch = useCallback(
		async (query: string) => {
			if (!rootPath) {
				setSuggestions([]);
				setLoading(false);
				return;
			}
			const seq = ++requestSeq.current;
			setLoading(true);
			try {
				const result = await globalThis.electronAPI.searchProjectFiles(
					rootPath,
					query,
					mode,
				);
				if (seq !== requestSeq.current) return; // stale response
				setSuggestions(result.success && result.data ? result.data : []);
				setActiveIndex(-1);
			} catch {
				if (seq === requestSeq.current) setSuggestions([]);
			} finally {
				if (seq === requestSeq.current) setLoading(false);
			}
		},
		[rootPath, mode],
	);

	const scheduleSearch = useCallback(
		(query: string) => {
			if (debounceTimer.current) clearTimeout(debounceTimer.current);
			debounceTimer.current = setTimeout(() => {
				void runSearch(query);
			}, SEARCH_DEBOUNCE_MS);
		},
		[runSearch],
	);

	useEffect(
		() => () => {
			if (debounceTimer.current) clearTimeout(debounceTimer.current);
		},
		[],
	);

	// Close the dropdown when clicking outside the component.
	useEffect(() => {
		if (!open) return;
		function handlePointerDown(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handlePointerDown);
		return () => document.removeEventListener("mousedown", handlePointerDown);
	}, [open]);

	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const next = e.target.value;
			onChange(next);
			suppressSearch.current = false;
			setOpen(true);
			scheduleSearch(next);
		},
		[onChange, scheduleSearch],
	);

	const handleFocus = useCallback(() => {
		if (suppressSearch.current) {
			suppressSearch.current = false;
			return;
		}
		setOpen(true);
		void runSearch(value);
	}, [runSearch, value]);

	const selectSuggestion = useCallback(
		(item: FileSearchResult) => {
			suppressSearch.current = true;
			onChange(item.relativePath);
			setOpen(false);
			setSuggestions([]);
			setActiveIndex(-1);
		},
		[onChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Escape") {
				setOpen(false);
				return;
			}
			if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
				setOpen(true);
				void runSearch(value);
				return;
			}
			if (suggestions.length === 0) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((i) => (i + 1) % suggestions.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((i) =>
					i <= 0 ? suggestions.length - 1 : i - 1,
				);
			} else if (e.key === "Enter" && activeIndex >= 0) {
				e.preventDefault();
				selectSuggestion(suggestions[activeIndex]);
			}
		},
		[open, suggestions, activeIndex, runSearch, value, selectSuggestion],
	);

	const noResultsLabel =
		mode === "directory"
			? t("documentation:autocomplete.noResultsDir")
			: t("documentation:autocomplete.noResults");
	const showDropdown = open && (loading || suggestions.length > 0 || !!rootPath);

	return (
		<div ref={containerRef} className="relative flex-1">
			<Input
				id={id}
				value={value}
				onChange={handleInputChange}
				onFocus={handleFocus}
				onKeyDown={handleKeyDown}
				disabled={disabled}
				placeholder={placeholder}
				className={className}
				autoComplete="off"
				spellCheck={false}
				role="combobox"
				aria-expanded={showDropdown}
				aria-controls={listboxId}
				aria-autocomplete="list"
			/>

			{showDropdown && (
				<ul
					id={listboxId}
					// biome-ignore lint/a11y/useSemanticElements: listbox pattern for combobox
					role="listbox"
					className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
				>
					{loading && suggestions.length === 0 && (
						<li className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							{t("documentation:autocomplete.searching")}
						</li>
					)}

					{!loading && suggestions.length === 0 && (
						<li className="px-3 py-2 text-xs text-muted-foreground">
							{rootPath
								? noResultsLabel
								: t("documentation:autocomplete.noProject")}
						</li>
					)}

					{suggestions.map((item, index) => (
						<li key={item.relativePath}>
							<button
								type="button"
								// biome-ignore lint/a11y/useSemanticElements: option inside listbox
								role="option"
								aria-selected={index === activeIndex}
								// Use onMouseDown so selection fires before the input blurs.
								onMouseDown={(e) => {
									e.preventDefault();
									selectSuggestion(item);
								}}
								onMouseEnter={() => setActiveIndex(index)}
								className={cn(
									"flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-colors",
									index === activeIndex
										? "bg-accent text-accent-foreground"
										: "text-foreground hover:bg-accent/50",
								)}
							>
								{item.isDirectory ? (
									<Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
								) : (
									<FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="truncate">{item.relativePath}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
