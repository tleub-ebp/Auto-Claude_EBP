import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
	fetchPromptPreview,
	type PromptPreview,
} from "../../lib/agent-tools-api";

export interface PromptPreviewDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly projectDir: string;
	readonly specDir: string;
	readonly agentType?: string;
}

export function PromptPreviewDialog({
	open,
	onOpenChange,
	projectDir,
	specDir,
	agentType = "coder",
}: PromptPreviewDialogProps) {
	const { t } = useTranslation("agentTools");
	const [preview, setPreview] = useState<PromptPreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setPreview(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchPromptPreview(projectDir, specDir, agentType, controller.signal)
			.then((res) => {
				if (res.ok) setPreview(res.data.preview);
				else if (res.error !== "aborted") setError(res.error);
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, projectDir, specDir, agentType]);

	const copyToClipboard = () => {
		if (preview) {
			void navigator.clipboard.writeText(preview.system_prompt);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("promptPreview.title")}</DialogTitle>
					<DialogDescription>
						{t("promptPreview.description", { agentType })}
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{t("promptPreview.loading")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{preview && (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2 text-xs">
							<Badge variant="outline">
								{t("promptPreview.badges.model")} <code>{preview.model || "default"}</code>
							</Badge>
							<Badge variant="outline">
								{t("promptPreview.badges.provider")} <code>{preview.provider}</code>
							</Badge>
							<Badge variant="outline">
								{t("promptPreview.badges.chars", { count: preview.system_prompt_length })}
							</Badge>
							{preview.claude_md_included && (
								<Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">
									{t("promptPreview.badges.claudeMd")}
								</Badge>
							)}
							{preview.domain_addendum_included && (
								<Badge className="bg-purple-500/15 text-purple-700 dark:text-purple-300">
									{t("promptPreview.badges.domainAddendum", { count: preview.domain_addendum_chars })}
								</Badge>
							)}
							<Badge variant="outline">
								{t("promptPreview.badges.tools", { count: preview.allowed_tools.length })}
							</Badge>
						</div>

						<ScrollArea className="h-80 rounded-md border bg-muted/30">
							<pre className="p-3 text-xs whitespace-pre-wrap font-mono">
								{preview.system_prompt}
							</pre>
						</ScrollArea>

						{preview.allowed_tools.length > 0 && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground">
									{t("promptPreview.allowedTools", { count: preview.allowed_tools.length })}
								</summary>
								<div className="mt-2 flex flex-wrap gap-1">
									{preview.allowed_tools.map((tool) => (
										<code
											key={tool}
											className="px-1.5 py-0.5 rounded bg-muted text-[10px]"
										>
											{tool}
										</code>
									))}
								</div>
							</details>
						)}

						{preview.notes.length > 0 && (
							<ul className="text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
								{preview.notes.map((n) => (
									<li key={n}>· {n}</li>
								))}
							</ul>
						)}
					</div>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						disabled={!preview}
						onClick={copyToClipboard}
					>
						{t("promptPreview.copyPrompt")}
					</Button>
					<Button onClick={() => onOpenChange(false)}>{t("promptPreview.close")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
