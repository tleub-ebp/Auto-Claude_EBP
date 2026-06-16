import type { LanguageSupport } from "@codemirror/language";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * Track the app's light/dark mode by observing the `dark` class on <html>,
 * so the editor follows theme switches without a reload.
 */
function useIsDarkMode(): boolean {
	const [isDark, setIsDark] = useState(() =>
		document.documentElement.classList.contains("dark"),
	);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDark(document.documentElement.classList.contains("dark"));
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);

	return isDark;
}

/**
 * Resolve the CodeMirror language support for a file name (e.g. "Form.cs",
 * "src/app.tsx"). Grammars are lazy-loaded on first use; unknown extensions
 * fall back to plain text.
 */
function useLanguageExtension(filename?: string): Extension | null {
	const [support, setSupport] = useState<LanguageSupport | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSupport(null);

		if (!filename) return;
		const basename = filename.replaceAll("\\", "/").split("/").pop() ?? "";
		const description = LanguageDescription.matchFilename(languages, basename);
		if (!description) return;

		description.load().then(
			(languageSupport) => {
				if (!cancelled) setSupport(languageSupport);
			},
			() => {
				/* unknown/failed grammar — stay in plain text */
			},
		);

		return () => {
			cancelled = true;
		};
	}, [filename]);

	return support;
}

export interface CodeEditorProps {
	readonly value: string;
	readonly onChange?: (value: string) => void;
	/** File name or path used to pick the syntax highlighting grammar. */
	readonly filename?: string;
	readonly readOnly?: boolean;
	readonly placeholder?: string;
	readonly className?: string;
	readonly autoFocus?: boolean;
}

/**
 * Code editor with VS Code-style syntax highlighting (CodeMirror 6 +
 * vscodeDark/vscodeLight themes). The grammar is chosen from the file
 * extension, matching what VS Code / Rider would highlight.
 */
export function CodeEditor({
	value,
	onChange,
	filename,
	readOnly = false,
	placeholder,
	className,
	autoFocus = false,
}: CodeEditorProps) {
	const isDark = useIsDarkMode();
	const language = useLanguageExtension(filename);

	const extensions = useMemo(
		() => (language ? [language] : []),
		[language],
	);

	return (
		<CodeMirror
			value={value}
			onChange={onChange}
			extensions={extensions}
			theme={isDark ? vscodeDark : vscodeLight}
			readOnly={readOnly}
			editable={!readOnly}
			placeholder={placeholder}
			autoFocus={autoFocus}
			height="100%"
			className={cn(
				"h-full overflow-hidden rounded-md border border-border text-xs",
				// CodeMirror root must inherit the height for height="100%" to work
				"[&_.cm-editor]:h-full [&_.cm-scroller]:font-mono",
				className,
			)}
			basicSetup={{
				lineNumbers: true,
				foldGutter: true,
				highlightActiveLine: !readOnly,
				highlightActiveLineGutter: !readOnly,
				bracketMatching: true,
				closeBrackets: !readOnly,
				autocompletion: false,
				searchKeymap: true,
			}}
		/>
	);
}
