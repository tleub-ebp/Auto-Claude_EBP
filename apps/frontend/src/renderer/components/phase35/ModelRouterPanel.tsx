/**
 * #3.1 Adaptive Model Routing panel.
 *
 * Type a prompt + optional task class hint, see (a) the chosen model
 * and (b) a "what would it cost on each tier" comparison table.
 */

import { ChevronDown, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, getEurRate } from "../../lib/currency";
import { useModelRouterStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { PanelShell } from "./_panel-shell";

const PROVIDER_OPTIONS = [
	{ value: "anthropic", labelKey: "modelRouter.providerAnthropic" },
	{ value: "openai", labelKey: "modelRouter.providerOpenai" },
	{ value: "google", labelKey: "modelRouter.providerGoogle" },
	{ value: "mistral", labelKey: "modelRouter.providerMistral" },
	{ value: "ollama", labelKey: "modelRouter.providerOllama" },
] as const;

const PROMPT_MAX_LEN = 4000;
const HINT_MAX_LEN = 64;

export function ModelRouterPanel() {
	const { t, i18n } = useTranslation("phase35");
	const { phase, error, chosen, comparison, route, compare } = useModelRouterStore();
	const [prompt, setPrompt] = useState("");
	const [hint, setHint] = useState("");
	const [providers, setProviders] = useState<string[]>(["anthropic", "openai"]);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [eurRate, setEurRate] = useState(0.92);

	const isFr = i18n.language.startsWith("fr");

	useEffect(() => {
		if (!isFr) return;
		let cancelled = false;
		void getEurRate().then((r) => {
			if (!cancelled) setEurRate(r);
		});
		return () => {
			cancelled = true;
		};
	}, [isFr]);

	const isRunning = phase === "running";

	const promptError = useMemo(() => {
		const trimmed = prompt.trim();
		if (trimmed.length === 0) return t("modelRouter.validation.promptRequired");
		if (prompt.length > PROMPT_MAX_LEN)
			return t("common.tooLong", { max: PROMPT_MAX_LEN });
		return null;
	}, [prompt, t]);

	const providersError = useMemo(() => {
		if (providers.length === 0) return t("modelRouter.validation.providersRequired");
		return null;
	}, [providers, t]);

	const hasValidationError = Boolean(promptError) || Boolean(providersError);

	const buildReq = () => ({
		prompt: prompt.trim(),
		hint: hint.trim() || undefined,
		available: [...providers],
	});

	const toggleProvider = (value: string) => {
		setProviders((prev) =>
			prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value],
		);
	};

	const selectAll = () => setProviders(PROVIDER_OPTIONS.map((p) => p.value));
	const clearAll = () => setProviders([]);

	const triggerLabel =
		providers.length === 0
			? t("modelRouter.providersPlaceholder")
			: providers.length === PROVIDER_OPTIONS.length
				? t("common.selectAll")
				: t("common.selected", { count: providers.length });

	return (
		<PanelShell
			title={t("modelRouter.title")}
			subtitle={t("modelRouter.subtitle")}
			error={error}
			actions={
				<>
					<Button
						size="sm"
						onClick={() => route(buildReq())}
						disabled={isRunning || hasValidationError}
					>
						{isRunning ? t("common.running") : t("common.run")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => compare(buildReq())}
						disabled={isRunning || hasValidationError}
					>
						{t("modelRouter.compare")}
					</Button>
				</>
			}
		>
			<div className="space-y-3">
				<div>
					<label htmlFor="prompt-input" className="block text-sm font-medium mb-1">
						{t("modelRouter.prompt")}
					</label>
					<textarea
						id="prompt-input"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX_LEN))}
						rows={3}
						maxLength={PROMPT_MAX_LEN}
						aria-invalid={Boolean(promptError) || undefined}
						aria-describedby={promptError ? "prompt-error" : undefined}
						className="w-full rounded border bg-background p-2 text-sm font-mono"
						placeholder={t("modelRouter.promptPlaceholder")}
					/>
					{promptError && (
						<p id="prompt-error" className="mt-1 text-xs text-destructive">
							{promptError}
						</p>
					)}
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="hint-input" className="block text-sm font-medium mb-1">
							{t("modelRouter.hint")}
						</label>
						<input
							id="hint-input"
							value={hint}
							onChange={(e) => setHint(e.target.value.slice(0, HINT_MAX_LEN))}
							maxLength={HINT_MAX_LEN}
							className="w-full rounded border bg-background p-2 text-sm"
							placeholder={t("modelRouter.hintPlaceholder")}
						/>
					</div>
					<div>
						<div className="block text-sm font-medium mb-1">
							{t("modelRouter.availableProviders")}
						</div>
						<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									aria-haspopup="listbox"
									aria-expanded={popoverOpen}
									aria-invalid={Boolean(providersError) || undefined}
									aria-describedby={providersError ? "providers-error" : undefined}
									className="flex h-10 w-full items-center justify-between rounded border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
								>
									<span
										className={
											providers.length === 0
												? "text-muted-foreground truncate"
												: "truncate"
										}
									>
										{triggerLabel}
									</span>
									<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
								</button>
							</PopoverTrigger>
							<PopoverContent
								className="w-(--radix-popover-trigger-width) p-2"
								align="start"
							>
								<div className="flex items-center justify-between gap-2 border-b pb-2 mb-2">
									<button
										type="button"
										onClick={selectAll}
										className="text-xs underline-offset-2 hover:underline"
									>
										{t("common.selectAll")}
									</button>
									<button
										type="button"
										onClick={clearAll}
										className="text-xs underline-offset-2 hover:underline"
									>
										{t("common.clearAll")}
									</button>
								</div>
								<ul className="space-y-1" aria-label={t("modelRouter.availableProviders")}>
									{PROVIDER_OPTIONS.map((opt) => {
										const checked = providers.includes(opt.value);
										return (
											<li key={opt.value}>
												<label className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent cursor-pointer">
													<Checkbox
														checked={checked}
														onCheckedChange={() => toggleProvider(opt.value)}
													/>
													<span>{t(opt.labelKey as never)}</span>
												</label>
											</li>
										);
									})}
								</ul>
							</PopoverContent>
						</Popover>
						{providers.length > 0 && (
							<div className="mt-2 flex flex-wrap gap-1">
								{providers.map((p) => {
									const opt = PROVIDER_OPTIONS.find((o) => o.value === p);
									return (
										<Badge
											key={p}
											variant="outline"
											className="gap-1 pr-1 text-xs"
										>
											{opt ? t(opt.labelKey as never) : p}
											<button
												type="button"
												aria-label={`remove ${p}`}
												onClick={() => toggleProvider(p)}
												className="rounded p-0.5 hover:bg-muted"
											>
												<X className="h-3 w-3" />
											</button>
										</Badge>
									);
								})}
							</div>
						)}
						{providersError && (
							<p id="providers-error" className="mt-1 text-xs text-destructive">
								{providersError}
							</p>
						)}
					</div>
				</div>

				{chosen && (
					<div className="rounded border p-3 text-sm space-y-1">
						<div>
							<span className="font-medium">{t("modelRouter.chosen")}: </span>
							<Badge variant="outline">{chosen.provider}</Badge>{" "}
							<code>{chosen.model}</code> ({chosen.tier})
						</div>
						<div className="text-muted-foreground">
							{t("modelRouter.estimatedCost")}:{" "}
							{formatCurrency(
								chosen.estimated_cost_usd,
								i18n.language,
								eurRate,
								6,
							)}
						</div>
						<div className="text-xs text-muted-foreground">
							{t("modelRouter.reason")}: {chosen.reason}
						</div>
					</div>
				)}

				{comparison && (
					<table className="w-full text-sm border">
						<thead>
							<tr className="border-b bg-muted/40">
								<th className="text-left p-2">{t("modelRouter.colTier")}</th>
								<th className="text-left p-2">{t("modelRouter.colModel")}</th>
								<th className="text-right p-2">{t("modelRouter.colCost")}</th>
							</tr>
						</thead>
						<tbody>
							{Object.entries(comparison).map(([tier, c]) => (
								<tr key={tier} className="border-b">
									<td className="p-2">{tier}</td>
									<td className="p-2 font-mono">
										{c.provider}/{c.model}
									</td>
									<td className="p-2 text-right font-mono">
										{formatCurrency(
											c.estimated_cost_usd,
											i18n.language,
											eurRate,
											6,
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</PanelShell>
	);
}
