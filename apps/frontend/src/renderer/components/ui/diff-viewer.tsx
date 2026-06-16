import { FileText } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type DiffViewMode = "unified" | "split";

interface DiffViewerProps {
	patch?: string;
	className?: string;
	/** "unified" (default) shows one column; "split" shows old/new side by side. */
	viewMode?: DiffViewMode;
}

interface DiffLine {
	content: string;
	type: "context" | "added" | "removed" | "hunk";
	oldLineNumber?: number;
	newLineNumber?: number;
}

/** A single row of the side-by-side view, pairing an old line with a new one. */
interface SplitRow {
	type: "context" | "change" | "hunk";
	left?: DiffLine;
	right?: DiffLine;
}

export function DiffViewer({
	patch,
	className,
	viewMode = "unified",
}: DiffViewerProps) {
	const { t } = useTranslation(["common"]);

	if (!patch || patch.trim() === "") {
		return (
			<div className={cn("p-4 text-center text-muted-foreground", className)}>
				<div className="flex flex-col items-center gap-2">
					<FileText className="h-8 w-8 opacity-50" />
					<span>{t("common:diffViewer.noContent")}</span>
					<span className="text-xs">
						{t("common:diffViewer.noContentHint")}
					</span>
				</div>
			</div>
		);
	}

	const lines = parseDiff(patch);

	return (
		<div className={cn("diff-viewer font-mono text-xs", className)}>
			{viewMode === "split" ? (
				<SplitDiff lines={lines} />
			) : (
				<UnifiedDiff lines={lines} />
			)}
		</div>
	);
}

/** Classic single-column diff: removed and added lines interleaved. */
function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
	return (
		<div className="diff-content">
			{lines.map((line, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
					key={index}
					className={cn(
						"flex diff-line",
						line.type === "added" && "bg-green-500/20",
						line.type === "removed" && "bg-red-500/20",
						line.type === "hunk" && "bg-blue-500/20",
						line.type === "context" && "bg-transparent",
					)}
				>
					<div
						className={cn(
							"diff-line-numbers flex shrink-0 select-none",
							"w-20 border-r border-border",
						)}
					>
						<div
							className={cn(
								"w-10 text-right pr-2",
								line.type === "added" && "text-green-400 font-medium",
								line.type === "removed" && "text-red-400 font-medium",
								line.type === "context" && "text-muted-foreground",
								line.type === "hunk" && "text-blue-400 font-medium",
							)}
						>
							{line.oldLineNumber || ""}
						</div>
						<div
							className={cn(
								"w-10 text-right pr-2 border-l border-border",
								line.type === "added" && "text-green-400 font-medium",
								line.type === "removed" && "text-red-400 font-medium",
								line.type === "context" && "text-muted-foreground",
								line.type === "hunk" && "text-blue-400 font-medium",
							)}
						>
							{line.newLineNumber || ""}
						</div>
					</div>
					<div
						className={cn(
							"flex-1 px-2 py-0.5 whitespace-pre overflow-x-auto",
							line.type === "added" && "text-green-400 font-medium",
							line.type === "removed" && "text-red-400 font-medium",
							line.type === "hunk" && "text-blue-400 font-medium",
							line.type === "context" && "text-foreground",
						)}
					>
						{line.content}
					</div>
				</div>
			))}
		</div>
	);
}

/** Side-by-side diff: old version (left) vs new version (right), GitHub-style. */
function SplitDiff({ lines }: { lines: DiffLine[] }) {
	const rows = buildSplitRows(lines);

	return (
		<div
			className="diff-content grid"
			style={{
				gridTemplateColumns:
					"auto minmax(0,1fr) auto minmax(0,1fr)",
			}}
		>
			{rows.map((row, index) => {
				if (row.type === "hunk") {
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
							key={index}
							className="col-span-4 bg-blue-500/20 text-blue-400 font-medium px-2 py-0.5 whitespace-pre overflow-x-auto"
						>
							{row.left?.content}
						</div>
					);
				}

				const leftRemoved = row.left?.type === "removed";
				const rightAdded = row.right?.type === "added";

				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
					<Fragment key={index}>
						{/* Old side */}
						<div
							className={cn(
								"px-2 text-right select-none border-r border-border tabular-nums",
								leftRemoved ? "text-red-400" : "text-muted-foreground",
								!row.left && "bg-muted/30",
							)}
						>
							{row.left?.oldLineNumber || ""}
						</div>
						<div
							className={cn(
								"px-2 py-0.5 whitespace-pre overflow-x-auto border-r border-border",
								leftRemoved && "bg-red-500/20 text-red-400",
								!leftRemoved && row.left && "text-foreground",
								!row.left && "bg-muted/30",
							)}
						>
							{row.left?.content ?? ""}
						</div>

						{/* New side */}
						<div
							className={cn(
								"px-2 text-right select-none border-r border-border tabular-nums",
								rightAdded ? "text-green-400" : "text-muted-foreground",
								!row.right && "bg-muted/30",
							)}
						>
							{row.right?.newLineNumber || ""}
						</div>
						<div
							className={cn(
								"px-2 py-0.5 whitespace-pre overflow-x-auto",
								rightAdded && "bg-green-500/20 text-green-400",
								!rightAdded && row.right && "text-foreground",
								!row.right && "bg-muted/30",
							)}
						>
							{row.right?.content ?? ""}
						</div>
					</Fragment>
				);
			})}
		</div>
	);
}

/**
 * Pair unified diff lines into side-by-side rows. Context and hunk lines map to
 * a single row; a run of removed/added lines is zipped so the k-th removal sits
 * opposite the k-th addition (extra lines on either side get an empty cell),
 * mirroring GitHub's split view.
 */
export function buildSplitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line.type === "hunk") {
			rows.push({ type: "hunk", left: line, right: line });
			i++;
		} else if (line.type === "context") {
			rows.push({ type: "context", left: line, right: line });
			i++;
		} else {
			// Gather the maximal run of consecutive changed lines, then zip the
			// removals against the additions.
			const removed: DiffLine[] = [];
			const added: DiffLine[] = [];
			while (
				i < lines.length &&
				(lines[i].type === "removed" || lines[i].type === "added")
			) {
				if (lines[i].type === "removed") removed.push(lines[i]);
				else added.push(lines[i]);
				i++;
			}
			const max = Math.max(removed.length, added.length);
			for (let k = 0; k < max; k++) {
				rows.push({ type: "change", left: removed[k], right: added[k] });
			}
		}
	}

	return rows;
}

export function parseDiff(patch: string): DiffLine[] {
	const lines = patch.split("\n");
	const result: DiffLine[] = [];
	let oldLineNumber = 0;
	let newLineNumber = 0;

	for (const line of lines) {
		let diffLine: DiffLine;

		if (line.startsWith("@@")) {
			// Hunk header - extract line numbers
			const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (match) {
				oldLineNumber = parseInt(match[1], 10) - 1;
				newLineNumber = parseInt(match[3], 10) - 1;
			}
			diffLine = {
				content: line,
				type: "hunk",
			};
		} else if (line.startsWith("+")) {
			// Added line
			newLineNumber++;
			diffLine = {
				content: line.substring(1),
				type: "added",
				newLineNumber,
			};
		} else if (line.startsWith("-")) {
			// Removed line
			oldLineNumber++;
			diffLine = {
				content: line.substring(1),
				type: "removed",
				oldLineNumber,
			};
		} else if (line.startsWith(" ")) {
			// Context line
			oldLineNumber++;
			newLineNumber++;
			diffLine = {
				content: line.substring(1),
				type: "context",
				oldLineNumber,
				newLineNumber,
			};
		} else {
			// Other lines (file headers, etc.)
			diffLine = {
				content: line,
				type: "context",
			};
		}

		result.push(diffLine);
	}

	return result;
}

export default DiffViewer;
