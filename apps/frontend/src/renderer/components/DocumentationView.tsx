import {
	AlertTriangle,
	BookOpen,
	Check,
	CheckCircle2,
	Copy,
	FileText,
	Loader2,
	Play,
	XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../stores/project-store";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";
import { FilePathAutocomplete } from "./FilePathAutocomplete";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SymbolDoc {
	name: string;
	kind: string;
	status: string;
	existing_doc?: string;
	generated_doc?: string;
}

interface CoverageResult {
	coverage_pct: number;
	total: number;
	documented: number;
	missing: number;
	partial: number;
	symbols?: SymbolDoc[];
}

interface DocGenerationResult {
	generated_docs: SymbolDoc[];
	readme_content?: string;
	diagram_content?: string;
}

interface DocumentationViewProps {
	readonly projectId: string;
}

// ---------------------------------------------------------------------------
// Coverage gauge
// ---------------------------------------------------------------------------

function CoverageGauge({
	pct,
	t,
}: {
	readonly pct: number;
	readonly t: (key: string) => string;
}) {
	let color: string;
	if (pct >= 80) {
		color = "text-emerald-500";
	} else if (pct >= 50) {
		color = "text-amber-500";
	} else {
		color = "text-red-500";
	}
	let bgColor: string;
	if (pct >= 80) {
		bgColor = "bg-emerald-500";
	} else if (pct >= 50) {
		bgColor = "bg-amber-500";
	} else {
		bgColor = "bg-red-500";
	}

	let coverageText: string;
	if (pct >= 80) {
		coverageText = t("documentation:coverage.wellDocumented");
	} else if (pct >= 50) {
		coverageText = t("documentation:coverage.needsImprovement");
	} else {
		coverageText = t("documentation:coverage.poorlyDocumented");
	}

	return (
		<div className="flex items-center gap-4">
			<div className="relative h-20 w-20">
				{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative, intentional */}
				<svg className="h-20 w-20 -rotate-90" viewBox="0 0 36 36">
					<path
						d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
						fill="none"
						stroke="currentColor"
						className="text-secondary"
						strokeWidth="3"
					/>
					<path
						d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
						fill="none"
						stroke="currentColor"
						className={color}
						strokeWidth="3"
						strokeDasharray={`${pct}, 100`}
						strokeLinecap="round"
					/>
				</svg>
				<div className="absolute inset-0 flex items-center justify-center">
					<span className={cn("text-lg font-bold", color)}>
						{pct.toFixed(0)}%
					</span>
				</div>
			</div>
			<div>
				<p className="text-sm font-semibold text-foreground">
					{t("documentation:coverage.title")}
				</p>
				<div className="mt-1 flex items-center gap-1.5">
					<div className={cn("h-2 w-2 rounded-full", bgColor)} />
					<span className="text-xs text-muted-foreground">
						{coverageText}
					</span>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text }: { readonly text: string }) {
	const { t } = useTranslation(["documentation"]);
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Button variant="ghost" size="sm" onClick={handleCopy}>
			{copied ? (
				<Check className="h-3.5 w-3.5 mr-1.5" />
			) : (
				<Copy className="h-3.5 w-3.5 mr-1.5" />
			)}
			{copied
				? t("documentation:actions.copied")
				: t("documentation:actions.copy")}
		</Button>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DocumentationView({ projectId }: DocumentationViewProps) {
	const { t } = useTranslation(["documentation"]);
	const projectPath = useProjectStore(
		(s) => s.projects.find((p) => p.id === projectId)?.path ?? "",
	);
	const [filePath, setFilePath] = useState("");
	const [dirPath, setDirPath] = useState("");
	const [coverage, setCoverage] = useState<CoverageResult | null>(null);
	const [generatedDocs, setGeneratedDocs] =
		useState<DocGenerationResult | null>(null);
	const [readmeContent, setReadmeContent] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadingDocs, setLoadingDocs] = useState(false);
	const [loadingReadme, setLoadingReadme] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCheckCoverage = useCallback(async () => {
		if (!filePath.trim()) return;
		setLoading(true);
		setError(null);
		setCoverage(null);
		try {
			const backendUrl = import.meta.env?.VITE_BACKEND_URL || "";
			const res = await fetch(`${backendUrl}/api/documentation/coverage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file_path: filePath }),
			});
			const data = await res.json();
			if (data.success) {
				setCoverage(data.coverage);
			} else {
				setError(data.error || t("documentation:errors.coverageFailed"));
			}
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("documentation:errors.networkError"),
			);
		} finally {
			setLoading(false);
		}
	}, [filePath, t]);

	const handleGenerateDocstrings = useCallback(async () => {
		if (!filePath.trim()) return;
		setLoadingDocs(true);
		setError(null);
		try {
			const backendUrl = import.meta.env?.VITE_BACKEND_URL || "";
			const res = await fetch(
				`${backendUrl}/api/documentation/generate-docstrings`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ file_path: filePath }),
				},
			);
			const data = await res.json();
			if (data.success) {
				setGeneratedDocs(data.result);
			} else {
				setError(data.error || t("documentation:errors.docstringFailed"));
			}
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("documentation:errors.networkError"),
			);
		} finally {
			setLoadingDocs(false);
		}
	}, [filePath, t]);

	const handleGenerateReadme = useCallback(async () => {
		if (!dirPath.trim()) return;
		setLoadingReadme(true);
		setError(null);
		try {
			const backendUrl = import.meta.env?.VITE_BACKEND_URL || "";
			const res = await fetch(
				`${backendUrl}/api/documentation/generate-readme`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ dir_path: dirPath }),
				},
			);
			const data = await res.json();
			if (data.success) {
				setReadmeContent(
					data.result?.readme_content || data.result?.readme || "",
				);
			} else {
				setError(data.error || t("documentation:errors.readmeFailed"));
			}
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("documentation:errors.networkError"),
			);
		} finally {
			setLoadingReadme(false);
		}
	}, [dirPath, t]);

	return (
		<ScrollArea className="h-full">
			<div className="p-6 space-y-6 max-w-5xl mx-auto">
				{/* Header */}
				<div className="flex items-center gap-3">
					<BookOpen className="h-6 w-6 text-primary" />
					<div>
						<h1 className="text-xl font-bold text-foreground">
							{t("documentation:title")}
						</h1>
						<p className="text-sm text-muted-foreground">
							{t("documentation:description")}
						</p>
					</div>
				</div>

				{/* Coverage check */}
				<Card>
					<CardContent className="p-5 space-y-3">
						{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
						<label className="text-sm font-medium text-foreground">
							{t("documentation:coverage.checkLabel")}
						</label>
						<div className="flex gap-2">
							<FilePathAutocomplete
								value={filePath}
								onChange={setFilePath}
								rootPath={projectPath}
								mode="file"
								placeholder={t("documentation:coverage.filePathPlaceholder")}
								className="font-mono text-xs"
							/>
							<Button
								onClick={handleCheckCoverage}
								disabled={loading || !filePath.trim()}
							>
								{loading ? (
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<Play className="h-4 w-4 mr-2" />
								)}
								{t("documentation:actions.check")}
							</Button>
						</div>
						<Button
							variant="outline"
							onClick={handleGenerateDocstrings}
							disabled={loadingDocs || !filePath.trim()}
						>
							{loadingDocs ? (
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
							) : (
								<FileText className="h-4 w-4 mr-2" />
							)}
							{t("documentation:actions.generateDocstrings")}
						</Button>
					</CardContent>
				</Card>

				{/* README generation */}
				<Card>
					<CardContent className="p-5 space-y-3">
						{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
						<label className="text-sm font-medium text-foreground">
							{t("documentation:readme.generateLabel")}
						</label>
						<div className="flex gap-2">
							<FilePathAutocomplete
								value={dirPath}
								onChange={setDirPath}
								rootPath={projectPath}
								mode="directory"
								placeholder={t("documentation:readme.dirPathPlaceholder")}
								className="font-mono text-xs"
							/>
							<Button
								onClick={handleGenerateReadme}
								disabled={loadingReadme || !dirPath.trim()}
							>
								{loadingReadme ? (
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<FileText className="h-4 w-4 mr-2" />
								)}
								{t("documentation:actions.generate")}
							</Button>
						</div>
					</CardContent>
				</Card>

				{/* Error */}
				{error && (
					<Card className="border-red-500/30">
						<CardContent className="p-4 flex items-center gap-3 text-red-500">
							<AlertTriangle className="h-5 w-5 shrink-0" />
							<p className="text-sm">{error}</p>
						</CardContent>
					</Card>
				)}

				{/* Coverage results */}
				{coverage && (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<Card>
							<CardContent className="p-5">
								<CoverageGauge pct={coverage.coverage_pct} t={t} />
								<div className="mt-4 grid grid-cols-3 gap-4 text-center">
									<div>
										<p className="text-lg font-bold text-foreground">
											{coverage.documented}
										</p>
										<p className="text-xs text-muted-foreground">
											{t("documentation:coverage.documented")}
										</p>
									</div>
									<div>
										<p className="text-lg font-bold text-amber-500">
											{coverage.partial}
										</p>
										<p className="text-xs text-muted-foreground">
											{t("documentation:coverage.partial")}
										</p>
									</div>
									<div>
										<p className="text-lg font-bold text-red-500">
											{coverage.missing}
										</p>
										<p className="text-xs text-muted-foreground">
											{t("documentation:coverage.missing")}
										</p>
									</div>
								</div>
							</CardContent>
						</Card>

						{coverage.symbols && coverage.symbols.length > 0 && (
							<Card>
								<CardContent className="p-5">
									<h3 className="text-sm font-semibold text-foreground mb-3">
										{t("documentation:symbols.title")}
									</h3>
									<div className="space-y-1.5 max-h-60 overflow-y-auto">
										{coverage.symbols.map((sym) => {
											let statusIcon: React.ReactElement;
											if (sym.status === "documented") {
												statusIcon = (
													<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
												);
											} else if (sym.status === "partial") {
												statusIcon = (
													<AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
												);
											} else {
												statusIcon = (
													<XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
												);
											}
											return (
												<div
													key={`symbol-${sym.name}-${sym.status}`}
													className="flex items-center gap-2 text-xs"
												>
													{statusIcon}
												<span className="font-mono text-foreground">
													{sym.name}
												</span>
												<Badge variant="outline" className="text-[10px]">
													{sym.kind}
												</Badge>
											</div>
											);
										})}
									</div>
								</CardContent>
							</Card>
						)}
					</div>
				)}

				{/* Generated docstrings */}
				{generatedDocs && generatedDocs.generated_docs.length > 0 && (
					<Card>
						<CardContent className="p-5">
							<h3 className="text-sm font-semibold text-foreground mb-4">
								{t("documentation:docstrings.title", {
									count: generatedDocs.generated_docs.length,
								})}
							</h3>
							<div className="space-y-4">
								{generatedDocs.generated_docs.map((doc) => (
									<div
										key={`doc-${doc.name.slice(0, 50)}`}
										className="rounded-lg border border-border p-4"
									>
										<div className="flex items-center justify-between mb-2">
											<div className="flex items-center gap-2">
												<span className="text-sm font-mono font-medium text-foreground">
													{doc.name}
												</span>
												<Badge variant="outline" className="text-xs">
													{doc.kind}
												</Badge>
											</div>
											{doc.generated_doc && (
												<CopyButton text={doc.generated_doc} />
											)}
										</div>
										{doc.generated_doc && (
											<pre className="mt-2 rounded-md bg-secondary/50 p-3 text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
												{doc.generated_doc}
											</pre>
										)}
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Generated README */}
				{readmeContent && (
					<Card>
						<CardContent className="p-5">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-sm font-semibold text-foreground">
									{t("documentation:readme.title")}
								</h3>
								<CopyButton text={readmeContent} />
							</div>
							<pre className="rounded-md bg-secondary/50 p-4 text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
								{readmeContent}
							</pre>
						</CardContent>
					</Card>
				)}
			</div>
		</ScrollArea>
	);
}
