import { Loader2, Play, Terminal } from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Quick slash-command bar for the Kanban toolbar.
 *
 * Fetches the merged list of slash commands (project / user / built-in) from
 * the FastAPI backend and lets the user fire one against the active project.
 * The backend resolves the command through the Claude Agent SDK so existing
 * `.claude/commands/*.md` files Just Work.
 *
 * The component is purely additive: when no project is active, the input is
 * disabled with a localised tooltip. All user-facing strings come from the
 * `tasks:kanban.quickCommand.*` i18n namespace (FR + EN provided).
 */

interface SlashCommand {
	name: string;
	description: string;
	source: "project" | "user" | "built-in";
	path: string;
}

interface QuickCommandBarProps {
	readonly projectPath?: string;
	readonly className?: string;
}

const BACKEND_URL: string =
	(import.meta as { env?: { VITE_BACKEND_URL?: string } }).env
		?.VITE_BACKEND_URL || "";

export function QuickCommandBar({ projectPath, className }: QuickCommandBarProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const [input, setInput] = useState("");
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	const [isRunning, setIsRunning] = useState(false);
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Fetch command list whenever the active project changes. Errors are
	// swallowed: an empty picker is acceptable, we don't want to spam toasts
	// for a power-user affordance.
	useEffect(() => {
		if (!projectPath) {
			setCommands([]);
			return;
		}
		const controller = new AbortController();
		const url = `${BACKEND_URL}/api/slash-commands?project_dir=${encodeURIComponent(projectPath)}`;
		fetch(url, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (data?.success && Array.isArray(data.commands)) {
					setCommands(data.commands as SlashCommand[]);
				}
			})
			.catch(() => {
				/* silent: feature is non-critical */
			});
		return () => controller.abort();
	}, [projectPath]);

	// Filter suggestions by what the user has typed (minus the leading slash).
	const filtered = useMemo(() => {
		const q = input.trim().replace(/^\//, "").toLowerCase();
		if (!q) return commands.slice(0, 12);
		return commands
			.filter(
				(c) =>
					c.name.toLowerCase().includes(q) ||
					c.description.toLowerCase().includes(q),
			)
			.slice(0, 12);
	}, [commands, input]);

	const parseInput = useCallback(
		(): { command: string; args: string } | null => {
			const raw = input.trim();
			if (!raw) return null;
			const noSlash = raw.startsWith("/") ? raw.slice(1) : raw;
			const [command, ...rest] = noSlash.split(/\s+/);
			if (!command) return null;
			return { command, args: rest.join(" ") };
		},
		[input],
	);

	const runCommand = useCallback(
		async (override?: string) => {
			if (!projectPath) {
				globalThis.window.alert(t("tasks:kanban.quickCommand.missingProject"));
				return;
			}
			const parsed = override
				? { command: override, args: "" }
				: parseInput();
			if (!parsed) return;
			setIsRunning(true);
			setOpen(false);
			try {
				const res = await fetch(`${BACKEND_URL}/api/slash-commands/run`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						project_dir: projectPath,
						command: parsed.command,
						args: parsed.args,
					}),
				});
				const data = await res.json();
				if (data?.success) {
					// Don't pop a modal — surface in console so the dev can inspect.
					console.info(
						`[QuickCommand] /${parsed.command} →`,
						data.result ?? "(no output)",
					);
				} else {
					globalThis.window.alert(
						`${t("tasks:kanban.quickCommand.errorTitle")}: ${data?.error ?? "unknown"}`,
					);
				}
			} catch (err) {
				globalThis.window.alert(
					`${t("tasks:kanban.quickCommand.errorTitle")}: ${(err as Error).message}`,
				);
			} finally {
				setIsRunning(false);
				setInput("");
			}
		},
		[projectPath, parseInput, t],
	);

	const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void runCommand();
		} else if (e.key === "Escape") {
			setOpen(false);
		} else if (e.key === "Tab" && filtered.length > 0) {
			// Autocomplete to the first suggestion.
			e.preventDefault();
			setInput(`/${filtered[0].name} `);
		}
	};

	const disabled = !projectPath || isRunning;

	return (
		<div className={cn("relative flex items-center gap-1", className)}>
			<Terminal className="h-4 w-4 text-muted-foreground" aria-hidden />
			<Input
				ref={inputRef}
				value={input}
				onChange={(e) => {
					setInput(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => {
					// Delay so a click on a suggestion still registers.
					globalThis.window.setTimeout(() => setOpen(false), 150);
				}}
				onKeyDown={handleKey}
				placeholder={t("tasks:kanban.quickCommand.placeholder")}
				disabled={disabled}
				className="h-8 w-72 font-mono text-xs"
				aria-label={t("tasks:kanban.quickCommand.placeholder")}
				title={
					projectPath
						? t("tasks:kanban.quickCommand.hint")
						: t("tasks:kanban.quickCommand.missingProject")
				}
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={disabled || input.trim().length === 0}
				onClick={() => void runCommand()}
				className="gap-1 text-muted-foreground hover:text-foreground"
				aria-label={t("tasks:kanban.quickCommand.buttonLabel")}
			>
				{isRunning ? (
					<>
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
						<span className="text-xs">
							{t("tasks:kanban.quickCommand.running")}
						</span>
					</>
				) : (
					<>
						<Play className="h-3.5 w-3.5" />
						<span className="sr-only">
							{t("tasks:kanban.quickCommand.buttonLabel")}
						</span>
					</>
				)}
			</Button>

			{open && filtered.length > 0 && (
				<ul
					role="listbox"
					aria-label={t("tasks:kanban.quickCommand.ariaListLabel")}
					className="absolute top-9 left-5 z-50 max-h-72 w-96 overflow-auto rounded-md border bg-popover p-1 shadow-md"
				>
					{filtered.map((cmd) => (
						<li key={`${cmd.source}-${cmd.name}`}>
							<button
								type="button"
								onMouseDown={(e) => {
									// onMouseDown so it fires before the input's onBlur.
									e.preventDefault();
									void runCommand(cmd.name);
								}}
								className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
							>
								<div className="flex w-full items-center justify-between gap-2">
									<code className="font-mono">/{cmd.name}</code>
									<span className="text-[10px] uppercase text-muted-foreground">
										{cmd.source === "project"
											? t("tasks:kanban.quickCommand.sourceProject")
											: cmd.source === "user"
												? t("tasks:kanban.quickCommand.sourceUser")
												: t("tasks:kanban.quickCommand.sourceBuiltIn")}
									</span>
								</div>
								{cmd.description && (
									<span className="text-muted-foreground">
										{cmd.description}
									</span>
								)}
							</button>
						</li>
					))}
				</ul>
			)}
			{open && filtered.length === 0 && input.trim().length > 0 && (
				<div className="absolute top-9 left-5 z-50 w-72 rounded-md border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
					{t("tasks:kanban.quickCommand.noResults")}
				</div>
			)}
		</div>
	);
}
