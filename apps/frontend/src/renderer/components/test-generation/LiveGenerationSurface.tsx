import {
	AlertTriangle,
	Check,
	Copy,
	FileCode2,
	FileText,
	Loader2,
	Save,
	Search,
	Sparkles,
	Square,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	type StageId,
	useTestGenerationStore,
} from "../../stores/test-generation-store";

/**
 * LiveGenerationSurface — the real-time view of a running test generation.
 *
 * Shows an animated pipeline stepper, a code editor into which the generated
 * test file streams in live (token deltas from the backend, revealed with a
 * typewriter easing so it feels alive even when a provider returns everything at
 * once), and a stats strip. Rendered while `phase` is "generating" or "complete".
 */

const STAGE_ORDER: StageId[] = ["detect", "read", "generate", "write"];

const STAGE_ICONS: Record<StageId, typeof Search> = {
	detect: Search,
	read: FileText,
	generate: Sparkles,
	write: Save,
	done: Check,
};

// ── minimal, fail-safe syntax highlighter (visual only) ──────────────
const KEYWORDS = new Set(
	(
		"using namespace public private protected internal class interface void var new return null true false this base async await if else for foreach while do switch case break continue throw try catch finally get set static readonly const import from export default function def assert lambda pass raise yield with as in is not and or None True False self"
	).split(" "),
);

interface Tok {
	t: string;
	c: string;
}

const TOKEN_RE =
	/(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\[[A-Za-z@][\w.]*\]?|@[A-Za-z_]\w*)|([A-Za-z_]\w*)|(\d[\d._]*)|(\s+)|([^\w\s]+)/g;

function tokenize(line: string): Tok[] {
	const out: Tok[] = [];
	let m: RegExpExecArray | null;
	TOKEN_RE.lastIndex = 0;
	// Guard against pathological lines
	if (line.length > 2000) return [{ t: line, c: "text-zinc-300" }];
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = TOKEN_RE.exec(line)) !== null) {
		if (m[1]) out.push({ t: m[1], c: "text-zinc-500 italic" });
		else if (m[2]) out.push({ t: m[2], c: "text-amber-300" });
		else if (m[3]) out.push({ t: m[3], c: "text-fuchsia-300" });
		else if (m[4])
			out.push({
				t: m[4],
				c: KEYWORDS.has(m[4])
					? "text-sky-300"
					: /^[A-Z]/.test(m[4])
						? "text-emerald-300"
						: "text-zinc-200",
			});
		else if (m[5]) out.push({ t: m[5], c: "text-orange-300" });
		else if (m[6]) out.push({ t: m[6], c: "text-zinc-300" });
		else if (m[7]) out.push({ t: m[7], c: "text-zinc-400" });
	}
	return out;
}

function useTypewriter(target: string, animate: boolean): string {
	const [revealed, setRevealed] = useState("");
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		if (!animate) {
			setRevealed(target);
			return;
		}
		let raf = 0;
		const loop = () => {
			setRevealed((cur) => {
				const full = targetRef.current;
				if (cur.length >= full.length) return full; // in sync (no re-render)
				const remaining = full.length - cur.length;
				const step = Math.max(4, Math.ceil(remaining / 6));
				return full.slice(0, cur.length + step);
			});
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [animate, target]);

	return animate ? revealed : target;
}

export function LiveGenerationSurface() {
	const { t } = useTranslation(["testGeneration"]);
	const phase = useTestGenerationStore((s) => s.phase);
	const liveStages = useTestGenerationStore((s) => s.liveStages);
	const streamedCode = useTestGenerationStore((s) => s.streamedCode);
	const liveMeta = useTestGenerationStore((s) => s.liveMeta);
	const genStartedAt = useTestGenerationStore((s) => s.genStartedAt);
	const result = useTestGenerationStore((s) => s.result);
	const cancelGeneration = useTestGenerationStore((s) => s.cancelGeneration);

	const isGenerating = phase === "generating";
	const isComplete = phase === "complete";
	const isError = phase === "error";

	const prefersReduced = useMemo(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
		[],
	);

	// The final file is the source of truth once complete (streaming may have
	// been partial); otherwise reveal whatever has streamed in so far.
	const fullText =
		isComplete && result?.test_file_content
			? result.test_file_content
			: streamedCode;
	const revealed = useTypewriter(fullText, isGenerating && !prefersReduced);

	// Elapsed timer — ticks while generating, freezes on completion.
	const [, forceTick] = useState(0);
	useEffect(() => {
		if (!isGenerating) return;
		const id = setInterval(() => forceTick((n) => n + 1), 100);
		return () => clearInterval(id);
	}, [isGenerating]);
	const elapsed = genStartedAt ? (Date.now() - genStartedAt) / 1000 : 0;

	// Auto-scroll the editor as code streams in.
	const scrollRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [revealed]);

	const lines = revealed.length ? revealed.split("\n") : [""];
	const lineCount = revealed ? lines.length : 0;
	const testsCount = liveMeta.tests ?? result?.tests_generated;
	const framework = liveMeta.framework ?? "—";
	// Absolute path the runner resolved and wrote to — this is where the user
	// can open the generated file on disk.
	const filePath = result?.test_file_path ?? liveMeta.path;
	const fileName = filePath ? filePath.split(/[\\/]/).pop() : undefined;

	const [pathCopied, setPathCopied] = useState(false);
	const handleCopyPath = () => {
		if (!filePath) return;
		try {
			navigator.clipboard.writeText(filePath);
			setPathCopied(true);
			setTimeout(() => setPathCopied(false), 2000);
		} catch {
			// best-effort — clipboard may be unavailable
		}
	};

	return (
		<div className="flex flex-col gap-3 rounded-xl border bg-card/60 p-3">
			{/* ── pipeline stepper ── */}
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{STAGE_ORDER.map((id) => {
					const stage = liveStages.find((s) => s.id === id);
					const Icon = STAGE_ICONS[id];
					const active = stage?.status === "active";
					const isDone = stage?.status === "done";
					const isFailed = isError && active; // the stage we stalled on
					const isActive = active && !isError;
					const seen = Boolean(stage);
					return (
						<div
							key={id}
							className={[
								"relative flex flex-col gap-1.5 rounded-lg border p-2.5 transition-all duration-300",
								isFailed
									? "border-red-500/50 bg-red-500/5"
									: isActive
										? "border-primary/50 bg-primary/5 ring-1 ring-primary/25"
										: isDone
											? "border-emerald-600/30 bg-emerald-500/5"
											: "border-border bg-muted/30",
								seen ? "opacity-100" : "opacity-50",
							].join(" ")}
						>
							<div className="flex items-center gap-2">
								<span
									className={[
										"grid h-5 w-5 place-items-center rounded",
										isFailed
											? "text-red-400"
											: isDone
												? "text-emerald-400"
												: isActive
													? "text-primary"
													: "text-muted-foreground",
									].join(" ")}
								>
									{isFailed ? (
										<AlertTriangle className="h-3.5 w-3.5" />
									) : isDone ? (
										<Check className="h-3.5 w-3.5" />
									) : isActive ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Icon className="h-3.5 w-3.5" />
									)}
								</span>
								<span className="truncate text-xs font-medium">
									{t(`live.stages.${id}`)}
								</span>
								{isActive && (
									<span className="ml-auto h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
								)}
							</div>
							<span className="min-h-[14px] truncate font-mono text-[10.5px] text-muted-foreground">
								{stage?.detail ?? ""}
							</span>
						</div>
					);
				})}
			</div>

			{/* ── streaming code editor ── */}
			<div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
				<div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
					<span className="flex gap-1.5">
						<i className="block h-2.5 w-2.5 rounded-full bg-red-500/80" />
						<i className="block h-2.5 w-2.5 rounded-full bg-amber-500/80" />
						<i className="block h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
					</span>
					<span className="flex items-center gap-1.5 font-mono text-xs text-zinc-300">
						<FileCode2 className="h-3.5 w-3.5 text-primary" />
						{fileName ?? "…"}
					</span>
					{isGenerating && (
						<span className="ml-auto flex items-center gap-1.5 text-[10.5px] tracking-wide text-primary">
							<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
							{t("live.badgeLive")}
						</span>
					)}
				</div>
				<div ref={scrollRef} className="max-h-[300px] overflow-auto">
					{revealed ? (
						<pre className="m-0 font-mono text-[12px] leading-[1.6]">
							{lines.map((ln, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
									key={i}
									className="flex"
								>
									<span className="w-11 flex-none select-none pr-3 text-right text-zinc-600 tabular-nums">
										{i + 1}
									</span>
									<span className="whitespace-pre pr-4">
										{tokenize(ln).map(
											(tok, j): ReactNode => (
												// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
												<span key={j} className={tok.c}>
													{tok.t}
												</span>
											),
										)}
										{isGenerating && i === lines.length - 1 && (
											<span className="ml-px inline-block h-[14px] w-[7px] translate-y-0.5 animate-pulse rounded-[1px] bg-primary align-middle" />
										)}
									</span>
								</div>
							))}
						</pre>
					) : (
						<div className="flex items-center gap-2 px-4 py-6 font-mono text-xs text-zinc-500">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							{t("live.waiting")}
						</div>
					)}
				</div>
			</div>

			{/* ── stats strip ── */}
			<div className="grid grid-cols-4 overflow-hidden rounded-lg border">
				<Stat label={t("live.elapsed")}>
					<span className="tabular-nums">{elapsed.toFixed(1)}</span>
					<span className="ml-0.5 text-xs font-normal text-muted-foreground">
						s
					</span>
				</Stat>
				<Stat label={t("live.lines")} accent>
					<span className="tabular-nums">{lineCount}</span>
				</Stat>
				<Stat label={t("live.tests")} accent>
					<span className="tabular-nums">{testsCount ?? "—"}</span>
				</Stat>
				<Stat label={t("live.framework")}>
					<span className="truncate text-base">{framework}</span>
				</Stat>
			</div>

			{/* ── footer: cancel while running, written-to (full path) when done ── */}
			{isGenerating ? (
				<button
					type="button"
					onClick={cancelGeneration}
					className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
				>
					<Square className="h-3.5 w-3.5" />
					{t("live.cancel")}
				</button>
			) : (
				isComplete &&
				filePath && (
					<div className="flex flex-col gap-1.5 rounded-lg border border-emerald-600/30 bg-emerald-500/5 px-3 py-2.5">
						<div className="flex items-center gap-2 text-sm text-foreground">
							<Check className="h-4 w-4 flex-none text-emerald-400" />
							<span className="font-medium">{t("live.writtenTo")}</span>
						</div>
						<div className="flex items-center gap-2 pl-6">
							<code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-primary">
								{filePath}
							</code>
							<button
								type="button"
								onClick={handleCopyPath}
								title={t("live.copyPath")}
								className="flex flex-none items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
							>
								{pathCopied ? (
									<Check className="h-3 w-3 text-emerald-400" />
								) : (
									<Copy className="h-3 w-3" />
								)}
								{pathCopied ? t("live.copied") : t("live.copyPath")}
							</button>
						</div>
					</div>
				)
			)}
		</div>
	);
}

function Stat({
	label,
	accent,
	children,
}: {
	readonly label: string;
	readonly accent?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-0.5 border-r bg-muted/20 px-3 py-2 last:border-r-0">
			<span
				className={[
					"text-lg font-semibold leading-none",
					accent ? "text-primary" : "text-foreground",
				].join(" ")}
			>
				{children}
			</span>
			<span className="text-[10px] uppercase tracking-wider text-muted-foreground">
				{label}
			</span>
		</div>
	);
}
