import DOMPurify from "dompurify";
import {
	Bug,
	Check,
	ChevronDown,
	ChevronRight,
	Clock,
	ExternalLink,
	FileCode,
	Gauge,
	GitBranch,
	GitPullRequest,
	Lightbulb,
	ListChecks,
	Palette,
	Pencil,
	Shield,
	StickyNote,
	Target,
	Users,
	Wrench,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useToast } from "../../hooks/use-toast";
import { persistUpdateTask, useTaskStore } from "../../stores/task-store";
import { Badge } from "../ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import { Textarea } from "../ui/textarea";

// Schéma de sanitization personnalisé permettant les styles inline
const customSanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		"*": [
			...(defaultSchema.attributes?.["*"] || []),
			"style",
			"className",
			"class",
			"dir",
		],
		a: [...(defaultSchema.attributes?.a || []), "href", "target", "rel"],
		span: ["style", "className", "class"],
		div: ["style", "className", "class"],
		p: ["style", "className", "class", "dir"],
		b: ["style", "className", "class"],
		strong: ["style", "className", "class"],
		em: ["style", "className", "class"],
		i: ["style", "className", "class"],
		u: ["style", "className", "class"],
		code: ["style", "className", "class"],
		pre: ["style", "className", "class"],
	},
	tagNames: [...(defaultSchema.tagNames || []), "span", "div", "br", "hr"],
};

import { useFormatRelativeTime } from "@/hooks/useFormatRelativeTime";
import {
	IDEATION_TYPE_LABELS,
	JSON_ERROR_PREFIX,
	TASK_CATEGORY_COLORS,
	TASK_CATEGORY_LABELS,
	TASK_COMPLEXITY_COLORS,
	TASK_COMPLEXITY_LABELS,
	TASK_IMPACT_COLORS,
	TASK_IMPACT_LABELS,
	TASK_PRIORITY_COLORS,
	TASK_PRIORITY_LABELS,
} from "../../../shared/constants";
import type { Task, TaskCategory } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Target> = {
	feature: Target,
	bug_fix: Bug,
	refactoring: Wrench,
	documentation: FileCode,
	security: Shield,
	performance: Gauge,
	ui_ux: Palette,
	infrastructure: Wrench,
	testing: FileCode,
};

interface TaskMetadataProps {
	readonly task: Task;
}

// Height threshold for collapsing long descriptions (~8 lines)
const COLLAPSED_HEIGHT = 200;

// Custom code component for ReactMarkdown
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
const CustomCodeComponent = (props: any) => {
	const { children, className, node, ...rest } = props;
	const match = /language-(\w+)/.exec(className || "");
	const isInline = !match;

	if (isInline) {
		return (
			<code className={className} {...rest}>
				{children}
			</code>
		);
	}
	return (
		<pre className="overflow-x-auto">
			<code className={className} {...rest}>
				{children}
			</code>
		</pre>
	);
};

// Custom table component for ReactMarkdown
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
const CustomTableComponent = (props: any) => {
	const { children, ...rest } = props;
	return (
		<div className="overflow-x-auto my-4">
			<table {...rest}>{children}</table>
		</div>
	);
};

export function TaskMetadata({ task }: TaskMetadataProps) {
	const { t } = useTranslation(["tasks", "errors"]);
	const formatRelativeTime = useFormatRelativeTime();
	const [isExpanded, setIsExpanded] = useState(true); // Start expanded by default
	const [hasOverflow, setHasOverflow] = useState(false);
	const [userManuallyExpanded, setUserManuallyExpanded] = useState(false); // Track user's manual choice
	const contentRef = useRef<HTMLDivElement>(null);
	const contentId = useId();

	// Handle JSON error description with i18n
	const displayDescription = (() => {
		if (!task.description) return null;
		if (task.description.startsWith(JSON_ERROR_PREFIX)) {
			const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
			return t("errors:task.jsonError.description", { error: errorMessage });
		}
		return task.description;
	})();

	// Détecter si le contenu est du HTML pur (commence par une balise HTML)
	const isHtmlContent = displayDescription?.trim().startsWith("<") || false;

	// Hydratation des tâches importées d'Azure DevOps, à l'ouverture :
	//  - le titre slugifié a perdu ses accents (« fen-tre-… ») → on récupère le
	//    vrai System.Title (avec accents) via le PAT côté main ;
	//  - les <img> pointant vers des pièces jointes protégées par PAT ne se
	//    chargent pas dans le renderer (ERR_TIMED_OUT) → on les inline en data URI.
	// Le résultat est persisté côté main et reflété immédiatement ici.
	const [inlinedDescription, setInlinedDescription] = useState<string | null>(
		null,
	);
	// Hydrate au plus une fois par tâche : mettre à jour le titre dans le store
	// fait re-jouer cet effet, on ne veut ni re-fetch ni flicker de la description.
	const hydratedTaskIdRef = useRef<string | null>(null);

	useEffect(() => {
		// Nouvelle tâche ouverte → on réinitialise l'état d'hydratation.
		if (hydratedTaskIdRef.current !== task.id) {
			setInlinedDescription(null);
		}

		const isImported = task.metadata?.sourceType === "imported";
		const hasAttachmentImages =
			isHtmlContent &&
			!!displayDescription?.includes("/_apis/wit/attachments/");
		// Un titre encore slugifié (ex. « 003-fen-tre-… ») = titre non hydraté.
		const titleLooksSlugified = /^\d{3}-/.test(task.title || "");

		if (!isImported || (!hasAttachmentImages && !titleLooksSlugified)) return;
		if (hydratedTaskIdRef.current === task.id) return; // déjà hydraté
		hydratedTaskIdRef.current = task.id;

		let cancelled = false;
		(async () => {
			try {
				const res =
					await globalThis.electronAPI?.hydrateAzureDevOpsTaskDisplay?.(
						task.projectId,
						task.id,
					);
				if (cancelled || !res?.success) return;
				if (res.data?.html) {
					setInlinedDescription(res.data.html);
				}
				// Reflète immédiatement le titre accentué dans l'en-tête (la version
				// persistée sera reprise par le scanner au prochain rafraîchissement).
				if (res.data?.title && res.data.title !== task.title) {
					useTaskStore.getState().updateTask(task.id, { title: res.data.title });
				}
			} catch {
				// Non bloquant : on conserve l'affichage d'origine.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		task.id,
		task.projectId,
		task.title,
		task.metadata?.sourceType,
		displayDescription,
		isHtmlContent,
	]);

	// HTML effectivement rendu : version inlinée si disponible, sinon l'originale.
	const htmlToRender = inlinedDescription ?? displayDescription;

	// Transformer le HTML pour appliquer les styles du thème
	const transformHtmlStyles = (html: string): string => {
		if (!html) return "";

		// Utiliser DOMParser pour manipuler le HTML de manière sécurisée
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, "text/html");

		// Fonction récursive pour traiter tous les éléments
		const processElement = (element: Element) => {
			// Conserver le style pour certaines propriétés mais adapter les couleurs
			const style = element.getAttribute("style");
			if (style) {
				let newStyle = style;

				// Remplacer les couleurs noires par la couleur du texte du thème
				newStyle = newStyle.replaceAll(
					/color:\s*#000000?/gi,
					"color: hsl(var(--foreground))",
				);
				newStyle = newStyle.replaceAll(
					/color:\s*rgb\(0,\s*0,\s*0\)/gi,
					"color: hsl(var(--foreground))",
				);
				newStyle = newStyle.replaceAll(
					/color:\s*black/gi,
					"color: hsl(var(--foreground))",
				);

				// Remplacer les backgrounds blancs par transparent ou muted
				newStyle = newStyle.replaceAll(
					/background-color:\s*#ffffff?/gi,
					"background-color: transparent",
				);
				newStyle = newStyle.replaceAll(
					/background-color:\s*rgb\(255,\s*255,\s*255\)/gi,
					"background-color: transparent",
				);
				newStyle = newStyle.replaceAll(
					/background-color:\s*white/gi,
					"background-color: transparent",
				);

				// Simplifier les margins et paddings excessifs
				newStyle = newStyle.replaceAll(
					/margin-top:\s*\d+pt/gi,
					"margin-top: 0.75rem",
				);
				newStyle = newStyle.replaceAll(
					/margin-bottom:\s*\d+pt/gi,
					"margin-bottom: 0.75rem",
				);

				element.setAttribute("style", newStyle);
			}

			// Ajouter des classes CSS pour améliorer le rendu
			const tagName = element.tagName.toLowerCase();
			const existingClass = element.getAttribute("class") || "";

			switch (tagName) {
				case "p":
					element.setAttribute(
						"class",
						`${existingClass} my-2 leading-relaxed text-foreground`.trim(),
					);
					break;
				case "b":
				case "strong":
					element.setAttribute(
						"class",
						`${existingClass} font-semibold text-foreground`.trim(),
					);
					break;
				case "em":
				case "i":
					element.setAttribute(
						"class",
						`${existingClass} italic text-foreground/90`.trim(),
					);
					break;
				case "u":
					element.setAttribute(
						"class",
						`${existingClass} underline decoration-foreground/50`.trim(),
					);
					break;
				case "span":
					// Conserver les spans avec style inline mais ajouter classe pour couleur par défaut
					if (!style?.includes("color")) {
						element.setAttribute(
							"class",
							`${existingClass} text-foreground`.trim(),
						);
					}
					break;
				case "a":
					element.setAttribute(
						"class",
						`${existingClass} text-info hover:text-info/80 underline transition-colors`.trim(),
					);
					break;
				case "ul":
				case "ol":
					element.setAttribute(
						"class",
						`${existingClass} my-3 pl-6 space-y-1 list-disc`.trim(),
					);
					break;
				case "li":
					element.setAttribute(
						"class",
						`${existingClass} text-foreground leading-relaxed ml-2`.trim(),
					);
					break;
				case "div":
					// Éviter d'ajouter trop de marges aux divs
					if (!existingClass && !style) {
						element.setAttribute("class", "my-1");
					}
					break;
				case "br":
					// Conserver les breaks mais sans style particulier
					break;
			}

			// Traiter les enfants récursivement
			Array.from(element.children).forEach((child) => processElement(child));
		};

		// Traiter tous les éléments du body
		Array.from(doc.body.children).forEach((child) => processElement(child));

		return doc.body.innerHTML;
	};

	// Detect if content overflows the collapsed height
	// Re-check when description changes (content height depends on rendered description)
	// Start expanded, but auto-collapse if content exceeds threshold
	// biome-ignore lint/correctness/useExhaustiveDependencies: task.description triggers re-render which changes content height
	useLayoutEffect(() => {
		const checkOverflow = () => {
			const element = contentRef.current;
			if (element) {
				// Temporarily remove max-height to get natural height
				const originalMaxHeight = element.style.maxHeight;
				element.style.maxHeight = "none";

				// Force a reflow to get accurate measurements
				element.getBoundingClientRect();

				const scrollHeight = element.scrollHeight;
				const _clientHeight = element.clientHeight;
				const hasContentOverflow = scrollHeight > COLLAPSED_HEIGHT;

				// Restore original max-height
				element.style.maxHeight = originalMaxHeight;

				setHasOverflow(hasContentOverflow);

				// Only auto-collapse if user hasn't manually expanded
				if (!userManuallyExpanded) {
					setIsExpanded(!hasContentOverflow);
				}
			}
		};

		// Initial check
		checkOverflow();

		// Re-check after a short delay to ensure content is fully rendered
		const timeoutId = setTimeout(checkOverflow, 100);

		// Additional check after images and other elements might have loaded
		const timeoutId2 = setTimeout(checkOverflow, 500);

		// Set up ResizeObserver to detect content size changes, but with debouncing
		let resizeObserver: ResizeObserver | null = null;
		let resizeTimeout: NodeJS.Timeout | null = null;

		if (contentRef.current && typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(() => {
				// Debounce resize events to prevent immediate re-collapse
				if (resizeTimeout) {
					clearTimeout(resizeTimeout);
				}
				resizeTimeout = setTimeout(checkOverflow, 50);
			});
			resizeObserver.observe(contentRef.current);
		}

		return () => {
			clearTimeout(timeoutId);
			clearTimeout(timeoutId2);
			if (resizeTimeout) {
				clearTimeout(resizeTimeout);
			}
			if (resizeObserver) {
				resizeObserver.disconnect();
			}
		};
	}, [task.id, task.description, userManuallyExpanded]);

	const hasClassification =
		task.metadata &&
		(task.metadata.category ||
			task.metadata.priority ||
			task.metadata.complexity ||
			task.metadata.impact ||
			task.metadata.securitySeverity ||
			task.metadata.sourceType);

	return (
		<div className="space-y-5">
			{/* Compact Metadata Bar: Classification + Timeline */}
			<div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-border">
				{/* Classification Badges - Left */}
				{hasClassification && (
					<div className="flex flex-wrap items-center gap-1.5">
						{/* Category */}
						{task.metadata?.category && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									TASK_CATEGORY_COLORS[task.metadata.category],
								)}
							>
								{CategoryIcon[task.metadata.category] &&
									(() => {
										const Icon = CategoryIcon[task.metadata.category];
										return <Icon className="h-3 w-3 mr-1" />;
									})()}
								{TASK_CATEGORY_LABELS[task.metadata.category]}
							</Badge>
						)}
						{/* Priority */}
						{task.metadata?.priority && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									TASK_PRIORITY_COLORS[task.metadata.priority],
								)}
							>
								{TASK_PRIORITY_LABELS[task.metadata.priority]}
							</Badge>
						)}
						{/* Complexity */}
						{task.metadata?.complexity && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									TASK_COMPLEXITY_COLORS[task.metadata.complexity],
								)}
							>
								{TASK_COMPLEXITY_LABELS[task.metadata.complexity]}
							</Badge>
						)}
						{/* Impact */}
						{task.metadata?.impact && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									TASK_IMPACT_COLORS[task.metadata.impact],
								)}
							>
								{TASK_IMPACT_LABELS[task.metadata.impact]}
							</Badge>
						)}
						{/* Security Severity */}
						{task.metadata?.securitySeverity && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									TASK_IMPACT_COLORS[task.metadata.securitySeverity],
								)}
							>
								<Shield className="h-3 w-3 mr-1" />
								{task.metadata.securitySeverity}
							</Badge>
						)}
						{/* Source Type */}
						{task.metadata?.sourceType && (
							<Badge variant="secondary" className="text-xs">
								{task.metadata.sourceType === "ideation" &&
								task.metadata.ideationType
									? IDEATION_TYPE_LABELS[task.metadata.ideationType] ||
										task.metadata.ideationType
									: task.metadata.sourceType}
							</Badge>
						)}
					</div>
				)}

				{/* Timeline - Right */}
				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<Clock className="h-3 w-3" />
						{t("tasks:metadata.created")} {formatRelativeTime(task.createdAt)}
					</span>
					<span className="text-border">•</span>
					<span>
						{t("tasks:metadata.updated")} {formatRelativeTime(task.updatedAt)}
					</span>
				</div>
			</div>

			{/* Description - Primary Content */}
			{displayDescription && (
				<div className="bg-muted/30 rounded-lg px-4 py-3 border border-border/50 overflow-hidden max-w-full">
					{/* Content container with conditional max-height */}
					<div className="relative">
						<div
							ref={contentRef}
							id={contentId}
							className={cn(
								"prose prose-sm dark:prose-invert max-w-none overflow-hidden",
								// Texte et paragraphes
								"prose-p:text-foreground/90 prose-p:leading-relaxed prose-p:my-3",
								// En-têtes
								"prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight",
								"prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-h4:text-sm",
								"prose-h1:mb-4 prose-h2:mb-3 prose-h3:mb-2 prose-h4:mb-2",
								// Texte fort et emphase
								"prose-strong:text-foreground prose-strong:font-semibold",
								"prose-em:text-foreground/90 prose-em:italic",
								// Listes avec meilleure indentation
								"prose-ul:my-3 prose-ul:pl-6 prose-ul:space-y-1",
								"prose-ol:my-3 prose-ol:pl-6 prose-ol:space-y-1",
								"prose-li:text-foreground/90 prose-li:my-1 prose-li:leading-relaxed",
								"prose-li:pl-2",
								// Listes imbriquées
								"[&_ul_ul]:my-1 [&_ol_ol]:my-1 [&_ul_ol]:my-1 [&_ol_ul]:my-1",
								"[&_ul_ul]:pl-4 [&_ol_ol]:pl-4 [&_ul_ol]:pl-4 [&_ol_ul]:pl-4",
								// Liens
								"prose-a:text-info prose-a:underline prose-a:wrap-break-word",
								"hover:prose-a:text-info/80",
								// Blocs de code
								"prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border",
								"prose-pre:rounded-md prose-pre:p-4 prose-pre:my-4",
								"prose-pre:overflow-x-auto prose-pre:text-sm",
								"prose-code:text-foreground prose-code:bg-muted/50",
								"prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded",
								"prose-code:text-sm prose-code:font-mono",
								"prose-code:before:content-none prose-code:after:content-none",
								// Tableaux
								"prose-table:w-full prose-table:my-4",
								"prose-table:border-collapse prose-table:border prose-table:border-border",
								"prose-th:bg-muted/50 prose-th:p-2 prose-th:text-left prose-th:font-semibold",
								"prose-th:border prose-th:border-border",
								"prose-td:p-2 prose-td:border prose-td:border-border",
								// Citations
								"prose-blockquote:border-l-4 prose-blockquote:border-muted-foreground/30",
								"prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-foreground/80",
								"prose-blockquote:my-4",
								// Images
								"prose-img:max-w-full prose-img:h-auto prose-img:rounded-md",
								"prose-img:border prose-img:border-border prose-img:my-4",
								// Règles horizontales
								"prose-hr:border-border prose-hr:my-6",
								// Limite de largeur et gestion du débordement
								"**:max-w-full **:overflow-x-auto",
								!isExpanded && hasOverflow && "max-h-[200px]",
							)}
							style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
						>
							{isHtmlContent ? (
								// Rendu HTML pur avec DOMPurify et transformation des styles
								<div
									className="html-content"
									// biome-ignore lint/security/noDangerouslySetInnerHtml: content is sanitized before use
									dangerouslySetInnerHTML={{
										__html: DOMPurify.sanitize(
											transformHtmlStyles(htmlToRender || ""),
											{
												ADD_TAGS: [
													"span",
													"div",
													"br",
													"hr",
													"p",
													"b",
													"strong",
													"em",
													"i",
													"u",
													"a",
													"ul",
													"ol",
													"li",
												],
												ADD_ATTR: [
													"style",
													"class",
													"dir",
													"href",
													"target",
													"rel",
												],
												ALLOW_DATA_ATTR: false,
											},
										),
									}}
								/>
							) : (
								// Rendu Markdown avec ReactMarkdown
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									rehypePlugins={[
										rehypeRaw,
										[rehypeSanitize, customSanitizeSchema],
									]}
									components={{
										// Personnaliser le rendu des blocs de code
										code: CustomCodeComponent,
										// Améliorer le rendu des tableaux
										table: CustomTableComponent,
									}}
								>
									{displayDescription}
								</ReactMarkdown>
							)}
						</div>

						{/* Gradient overlay when collapsed and has overflow */}
						{!isExpanded && hasOverflow && (
							<div className="absolute bottom-0 left-0 right-0 h-16 bg-linear-to-t from-muted/80 to-transparent pointer-events-none" />
						)}
					</div>

					{/* Expand/Collapse button */}
					{hasOverflow && !isExpanded && (
						<div className="flex justify-center mt-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setIsExpanded(true);
									setUserManuallyExpanded(true);
								}}
								className="text-muted-foreground hover:text-foreground"
								aria-expanded={isExpanded}
								aria-controls={contentId}
							>
								<ChevronDown className="h-4 w-4 mr-1" aria-hidden="true" />
								{t("tasks:metadata.showMore")}
							</Button>
						</div>
					)}
				</div>
			)}

			{/* Secondary Details */}
			{task.metadata && (
				<div className="space-y-4 pt-2">
					{/* Rationale */}
					{task.metadata.rationale && (
						<div>
							<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
								<Lightbulb className="h-3 w-3 text-warning" />
								{t("tasks:metadata.rationale")}
							</h3>
							<p className="text-sm text-foreground/80">
								{task.metadata.rationale}
							</p>
						</div>
					)}

					{/* Problem Solved */}
					{task.metadata.problemSolved && (
						<div>
							<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
								<Target className="h-3 w-3 text-success" />
								{t("tasks:metadata.problemSolved")}
							</h3>
							<p className="text-sm text-foreground/80">
								{task.metadata.problemSolved}
							</p>
						</div>
					)}

					{/* Target Audience */}
					{task.metadata.targetAudience && (
						<div>
							<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
								<Users className="h-3 w-3 text-info" />
								{t("tasks:metadata.targetAudience")}
							</h3>
							<p className="text-sm text-foreground/80">
								{task.metadata.targetAudience}
							</p>
						</div>
					)}

					{/* Dependencies */}
					{task.metadata.dependencies &&
						task.metadata.dependencies.length > 0 && (
							<div>
								<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
									<GitBranch className="h-3 w-3 text-purple-400" />
									{t("tasks:metadata.dependencies")}
								</h3>
								<ul className="text-sm text-foreground/80 list-disc list-inside space-y-0.5">
									{task.metadata.dependencies.map((dep) => (
										<li key={dep}>{dep}</li>
									))}
								</ul>
							</div>
						)}

					{/* Pull Request */}
					{task.metadata.prUrl && (
						<div>
							<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
								<GitPullRequest className="h-3 w-3 text-info" />
								{t("tasks:metadata.pullRequest")}
							</h3>
							<button
								type="button"
								onClick={() => {
									if (task.metadata?.prUrl) {
										globalThis.electronAPI.openExternal(task.metadata.prUrl);
									}
								}}
								className="text-sm text-info hover:underline flex items-center gap-1.5 bg-transparent border-none cursor-pointer p-0 text-left"
							>
								{task.metadata.prUrl}
								<ExternalLink className="h-3 w-3" />
							</button>
						</div>
					)}

					{/* Acceptance Criteria — always visible, editable */}
					<AcceptanceCriteriaSection task={task} />

					{/* Extra note — editable, persisted as additional_context */}
					<ExtraNoteSection task={task} />

					{/* Affected Files */}
					{task.metadata.affectedFiles &&
						task.metadata.affectedFiles.length > 0 && (
							<div>
								<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
									<FileCode className="h-3 w-3" />
									{t("tasks:metadata.affectedFiles")}
								</h3>
								<div className="flex flex-wrap gap-1">
									{task.metadata.affectedFiles.map((file) => (
										<Tooltip key={file}>
											<TooltipTrigger asChild>
												<Badge
													variant="secondary"
													className="text-xs font-mono cursor-help"
												>
													{file.split("/").pop()}
												</Badge>
											</TooltipTrigger>
											<TooltipContent side="top" className="font-mono text-xs">
												{file}
											</TooltipContent>
										</Tooltip>
									))}
								</div>
							</div>
						)}
				</div>
			)}
		</div>
	);
}

interface AcceptanceCriteriaListProps {
	readonly criteria: readonly string[];
}

// Renders a flat AC list as visually-grouped Gherkin scenarios.
// A line starting with "Scénario"/"Scenario" (case-insensitive) opens a new
// group rendered as a header; following lines are indented plain text. Lines
// that are not part of a scenario fall into an unlabeled group so the list
// still renders something readable when the AC isn't BDD-shaped.
function AcceptanceCriteriaList({ criteria }: AcceptanceCriteriaListProps) {
	const scenarioRe = /^\s*sc[ée]nario\b/i;
	const groups: { title: string | null; lines: string[] }[] = [];
	let current: { title: string | null; lines: string[] } | null = null;

	for (const raw of criteria) {
		const line = raw.trim();
		if (!line) continue;
		if (scenarioRe.test(line)) {
			current = { title: line, lines: [] };
			groups.push(current);
			continue;
		}
		if (!current) {
			current = { title: null, lines: [] };
			groups.push(current);
		}
		current.lines.push(line);
	}

	return (
		<div className="text-sm text-foreground/80 space-y-3 mb-2">
			{groups.map((group) => {
				const groupKey = `${group.title ?? "intro"}::${group.lines[0] ?? ""}`;
				return (
					<div key={groupKey} className="space-y-1">
						{group.title && (
							<div className="font-semibold text-foreground">
								{group.title}
							</div>
						)}
						{group.lines.length > 0 && (
							<div
								className={
									group.title
										? "pl-3 border-l-2 border-border space-y-0.5"
										: "space-y-0.5"
								}
							>
								{group.lines.map((line) => (
									<div key={`${groupKey}::${line}`}>{line}</div>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

interface AcceptanceCriteriaSectionProps {
	readonly task: Task;
}

function AcceptanceCriteriaSection({ task }: AcceptanceCriteriaSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const initialCriteria = task.metadata?.acceptanceCriteria ?? [];
	const initialText = initialCriteria.join("\n");

	// Extract ADO work item ID from "ADO-603226" format
	const adoWorkItemId = task.metadata?.azureDevOpsIdentifier
		? Number(task.metadata.azureDevOpsIdentifier.replace(/^ADO-/i, ""))
		: null;
	const isAdoTask = adoWorkItemId !== null && !Number.isNaN(adoWorkItemId);

	const [open, setOpen] = useState(initialCriteria.length > 0);
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(initialText);
	const [isSaving, setIsSaving] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	// Sync the textarea draft from the source of truth — but ONLY when the
	// user isn't actively editing. Otherwise every store-triggered re-render
	// (incoming task refresh, kanban poll, etc.) would silently wipe what
	// the user has been typing and lock `isDirty` to false, making the
	// "Enregistrer" button uncliquable.
	useEffect(() => {
		if (isEditing) return;
		const fresh = task.metadata?.acceptanceCriteria ?? [];
		setDraft(fresh.join("\n"));
	}, [task.metadata?.acceptanceCriteria, isEditing]);

	const parsedDraft = draft
		.split("\n")
		.map((l) => l.trim().replace(/^[-*•]\s*/, ""))
		.filter(Boolean);

	const isDirty = parsedDraft.join("\n") !== initialCriteria.join("\n");

	const handleSave = async () => {
		setIsSaving(true);
		const ok = await persistUpdateTask(task.id, {
			metadata: { acceptanceCriteria: parsedDraft },
		});
		setIsSaving(false);
		if (ok) {
			setSavedAt(Date.now());
			setIsEditing(false);
			if (parsedDraft.length > 0) setOpen(true);
		} else {
			// Without this toast the button silently bounces back to "Enregistrer"
			// and the user has no way to know whether the IPC failed, the file
			// couldn't be written, or something else went wrong.
			toast({
				title: t(
					"tasks:metadata.acSaveErrorTitle",
					"Échec de l'enregistrement",
				),
				description: t(
					"tasks:metadata.acSaveErrorDesc",
					"Impossible de sauvegarder les critères d'acceptation. Voir la console pour les détails.",
				),
				variant: "destructive",
			});
		}
	};

	const handleCancel = () => {
		setDraft(initialCriteria.join("\n"));
		setIsEditing(false);
	};

	const handleSyncFromAdo = async () => {
		if (!isAdoTask || !adoWorkItemId) return;
		setIsSyncing(true);
		try {
			const result = await globalThis.electronAPI.syncAzureDevOpsTaskAC(
				task.projectId,
				task.id,
				adoWorkItemId,
			);
			if (result.success && result.data) {
				const synced = result.data.acceptanceCriteria;
				await persistUpdateTask(task.id, { metadata: { acceptanceCriteria: synced } });
				setOpen(synced.length > 0);
				setSavedAt(Date.now());
			}
		} finally {
			setIsSyncing(false);
		}
	};

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 hover:text-foreground transition-colors"
					aria-expanded={open}
				>
					{open ? (
						<ChevronDown className="h-3 w-3" aria-hidden="true" />
					) : (
						<ChevronRight className="h-3 w-3" aria-hidden="true" />
					)}
					<ListChecks className="h-3 w-3 text-success" />
					<span>{t("tasks:metadata.acceptanceCriteria")}</span>
					{initialCriteria.length > 0 && (
						<Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">
							{initialCriteria.length}
						</Badge>
					)}
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				{isEditing ? (
					<>
						<Textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder={t("tasks:metadata.acPlaceholder")}
							rows={5}
							className="text-sm"
						/>
						<div className="flex items-center justify-between mt-2 gap-2">
							<span className="text-xs text-muted-foreground">
								{savedAt && !isDirty
									? t("tasks:metadata.acSaved")
									: t("tasks:metadata.acHelp")}
							</span>
							<div className="flex gap-1.5">
								<Button
									size="sm"
									variant="ghost"
									onClick={handleCancel}
									disabled={isSaving}
								>
									{t("tasks:metadata.acCancel")}
								</Button>
								<Button
									size="sm"
									onClick={handleSave}
									// Only disable during the actual save round-trip.
									// We deliberately allow clicking when isDirty is
									// false: re-render races (a kanban poll firing
									// while the user is editing) can momentarily reset
									// the draft to match the original, which used to
									// lock the button uncliquable. Letting the user
									// click is harmless — handleSave is idempotent.
									disabled={isSaving}
								>
									{isSaving
										? t("tasks:metadata.acSaving")
										: t("tasks:metadata.acSave")}
								</Button>
							</div>
						</div>
					</>
				) : (
					<>
						{initialCriteria.length > 0 ? (
							<AcceptanceCriteriaList criteria={initialCriteria} />
						) : (
							<p className="text-xs text-muted-foreground italic mb-2">
								{t("tasks:metadata.acEmpty")}
							</p>
						)}
						<div className="flex items-center gap-3 flex-wrap">
							<button
								type="button"
								onClick={() => {
									setIsEditing(true);
									setOpen(true);
								}}
								className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
							>
								<Pencil className="h-3 w-3" />
								{t("tasks:metadata.acEdit")}
							</button>
							{isAdoTask && (
								<button
									type="button"
									onClick={handleSyncFromAdo}
									disabled={isSyncing}
									className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
								>
									<Check className="h-3 w-3" />
									{isSyncing
										? t("tasks:metadata.acSyncing")
										: t("tasks:metadata.acSyncFromAdo")}
								</button>
							)}
						</div>
					</>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}

interface ExtraNoteSectionProps {
	readonly task: Task;
}

function ExtraNoteSection({ task }: ExtraNoteSectionProps) {
	const { t } = useTranslation(["tasks"]);
	const initial = task.metadata?.extraNote ?? "";
	const [open, setOpen] = useState(initial.length > 0);
	const [draft, setDraft] = useState(initial);
	const [isSaving, setIsSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		setDraft(task.metadata?.extraNote ?? "");
	}, [task.metadata?.extraNote]);

	const isDirty = draft !== initial;

	const handleSave = async () => {
		setIsSaving(true);
		const ok = await persistUpdateTask(task.id, {
			metadata: { extraNote: draft },
		});
		setIsSaving(false);
		if (ok) {
			setSavedAt(Date.now());
		}
	};

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 hover:text-foreground transition-colors"
					aria-expanded={open}
				>
					{open ? (
						<ChevronDown className="h-3 w-3" aria-hidden="true" />
					) : (
						<ChevronRight className="h-3 w-3" aria-hidden="true" />
					)}
					<StickyNote className="h-3 w-3 text-warning" />
					<span>{t("tasks:metadata.extraNote")}</span>
					{initial.length > 0 && (
						<Check className="h-3 w-3 text-success" aria-hidden="true" />
					)}
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<Textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={t("tasks:metadata.extraNotePlaceholder")}
					rows={4}
					className="text-sm"
				/>
				<div className="flex items-center justify-between mt-2 gap-2">
					<span className="text-xs text-muted-foreground">
						{savedAt && !isDirty
							? t("tasks:metadata.extraNoteSaved")
							: t("tasks:metadata.extraNoteHelp")}
					</span>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={!isDirty || isSaving}
					>
						{isSaving
							? t("tasks:metadata.extraNoteSaving")
							: t("tasks:metadata.extraNoteSave")}
					</Button>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
