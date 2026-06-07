import type { UsageSnapshot } from "@shared/types";
import { AlertCircle, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContextUsage } from "../../hooks/useContextUsage";

interface CopilotUsageContentProps {
	readonly usage: UsageSnapshot;
}

export function CopilotUsageContent({ usage }: CopilotUsageContentProps) {
	return (
		<div className="py-2 space-y-3">
			<CopilotContextWindow usage={usage} />
			{renderCopilotErrorState(usage)}
		</div>
	);
}

/**
 * Section « fenêtre de contexte » (façon Claude Code) : % du contexte du modèle
 * consommé par le dernier tour. Masquée s'il n'y a pas de données réelles.
 */
function CopilotContextWindow({ usage }: CopilotUsageContentProps) {
	const { t, i18n } = useTranslation(["common"]);
	const contextUsage = useContextUsage(usage.providerName ?? null);
	if (!contextUsage) return null;

	const pct = contextUsage.percentUsed;
	const barColor =
		pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-orange-500" : "bg-blue-500";
	const nf = new Intl.NumberFormat(i18n.language);

	return (
		<div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
			<TrendingUp className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
			<div className="space-y-1.5 w-full min-w-0">
				<div className="flex items-center justify-between gap-2">
					<p className="text-xs font-medium text-blue-500">
						{t("common:usage.copilotContextTitleShort")}
					</p>
					<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
						{contextUsage.model}
					</span>
				</div>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{t("common:usage.copilotContextDesc")}
				</p>
				<div className="flex items-baseline justify-between gap-2 mt-1">
					<span className="text-[10px] text-muted-foreground">
						{t("common:usage.copilotContextPercentLabel")}
					</span>
					<span className="font-mono text-xs text-foreground">
						{pct.toFixed(1)}%
					</span>
				</div>
				<div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
					<div
						className={`h-full ${barColor}`}
						style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
					/>
				</div>
				<div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
					<span>{t("common:usage.copilotContextUsedLabel")}</span>
					<span className="font-mono">
						{nf.format(contextUsage.contextTokens)} /{" "}
						{nf.format(contextUsage.contextWindow)}
					</span>
				</div>
			</div>
		</div>
	);
}

function renderCopilotErrorState(usage: UsageSnapshot) {
	if (usage.error === "INSUFFICIENT_PERMISSIONS") {
		return <CopilotInsufficientPermissions usage={usage} />;
	}

	if (usage.error === "BACKEND_UNAVAILABLE") {
		return <CopilotBackendUnavailable />;
	}

	const scope = usage.copilotUsageDetails?.scope;
	if (scope === "personal-quotas") {
		return <CopilotPremiumQuotas usage={usage} />;
	}
	return <CopilotMetrics usage={usage} />;
}

interface CopilotInsufficientPermissionsProps {
	readonly usage: UsageSnapshot;
}

function CopilotInsufficientPermissions({
	usage,
}: CopilotInsufficientPermissionsProps) {
	const { t } = useTranslation(["common"]);

	return (
		<div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
			<AlertCircle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
			<div className="space-y-1">
				<p className="text-xs font-medium text-orange-500">
					{t("common:usage.copilotInsuffPermissions")}
				</p>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{usage.errorMessage ||
						t("common:usage.copilotInsuffPermissionsDesc")}
				</p>
				<div className="text-[10px] text-muted-foreground">
					<strong>{t("common:usage.copilotSuggestionsLabel")}:</strong>
					<ul className="list-disc list-inside space-y-0.5 mt-1">
						<li>
							{t("common:usage.copilotRunCmd")}{" "}
							<code className="bg-muted px-1 rounded">
								gh auth refresh -h github.com -s admin:org
							</code>
						</li>
						<li>{t("common:usage.copilotMustBeAdmin")}</li>
						<li>{t("common:usage.copilotContactAdmin")}</li>
					</ul>
				</div>
			</div>
		</div>
	);
}

function CopilotBackendUnavailable() {
	const { t } = useTranslation(["common"]);

	return (
		<div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
			<AlertCircle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
			<div className="space-y-1">
				<p className="text-xs font-medium text-yellow-500">
					{t("common:usage.copilotBackendUnavailable")}
				</p>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{t("common:usage.copilotBackendUnavailableDesc")}
				</p>
			</div>
		</div>
	);
}

function formatResetDate(raw: string | undefined, locale: string): string {
	if (!raw) return "";
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return raw;
	return date.toLocaleDateString(locale, {
		day: "2-digit",
		month: "short",
		year: "numeric",
	});
}

interface CopilotPremiumQuotasProps {
	readonly usage: UsageSnapshot;
}

function CopilotPremiumQuotas({ usage }: CopilotPremiumQuotasProps) {
	const { t, i18n } = useTranslation(["common"]);
	const details = usage.copilotUsageDetails;
	if (!details) return null;

	const used = details.premiumRequestsUsed ?? 0;
	const entitlement = details.premiumRequestsEntitlement ?? 0;
	const remaining = details.premiumRequestsRemaining ?? 0;
	const percentUsed = details.premiumRequestsPercentUsed ?? 0;
	const unlimited = details.premiumRequestsUnlimited ?? false;
	const plan = details.plan;
	const org = details.organization;
	const reset = formatResetDate(details.quotaResetDate, i18n.language);

	const barColor =
		percentUsed >= 90
			? "bg-red-500"
			: percentUsed >= 75
				? "bg-orange-500"
				: "bg-blue-500";

	return (
		<div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
			<TrendingUp className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
			<div className="space-y-1.5 w-full min-w-0">
				<div className="flex items-center justify-between gap-2">
					<p className="text-xs font-medium text-blue-500">
						{t("common:usage.copilotPremiumTitle")}
					</p>
					{plan && (
						<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
							{plan}
						</span>
					)}
				</div>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{plan
						? t("common:usage.copilotPremiumDescPlan", { plan })
						: t("common:usage.copilotPremiumDescDefault")}
				</p>

				{unlimited ? (
					<div className="text-[10px] text-muted-foreground">
						<strong>{t("common:usage.copilotPremiumUnlimited")}</strong>
					</div>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-2 mt-1">
							<span className="text-[10px] text-muted-foreground">
								{t("common:usage.copilotPremiumPercentLabel")}
							</span>
							<span className="font-mono text-xs text-foreground">
								{percentUsed.toFixed(1)}%
							</span>
						</div>
						<div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
							<div
								className={`h-full ${barColor}`}
								style={{
									width: `${Math.min(Math.max(percentUsed, 0), 100)}%`,
								}}
							/>
						</div>
						<div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
							<div className="flex justify-between">
								<span>{t("common:usage.copilotPremiumUsedLabel")}</span>
								<span className="font-mono">{used}</span>
							</div>
							<div className="flex justify-between">
								<span>
									{t("common:usage.copilotPremiumEntitlementLabel")}
								</span>
								<span className="font-mono">{entitlement}</span>
							</div>
							<div className="flex justify-between col-span-2">
								<span>
									{t("common:usage.copilotPremiumRemainingLabel")}
								</span>
								<span className="font-mono">{remaining}</span>
							</div>
						</div>
					</>
				)}

				{(org || reset) && (
					<div className="flex flex-wrap items-center justify-between gap-x-3 pt-1 text-[10px] text-muted-foreground border-t border-blue-500/10">
						{org && <span>{org}</span>}
						{reset && (
							<span>
								{t("common:usage.copilotPremiumResetOn", { date: reset })}
							</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

interface CopilotMetricsProps {
	readonly usage: UsageSnapshot;
}

function CopilotMetrics({ usage }: CopilotMetricsProps) {
	const { t } = useTranslation(["common"]);

	return (
		<div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
			<TrendingUp className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
			<div className="space-y-1">
				<p className="text-xs font-medium text-blue-500">
					{t("common:usage.copilotMetricsTitle")}
				</p>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{t("common:usage.copilotMetricsDesc")}
				</p>
				{usage.copilotUsageDetails && (
					<div className="mt-2 space-y-1">
						{usage.copilotUsageDetails.suggestionsCount !== undefined && (
							<div className="flex justify-between text-[10px]">
								<span>{t("common:usage.copilotSuggestionsLabel")}:</span>
								<span className="font-mono">
									{usage.copilotUsageDetails.suggestionsCount}
								</span>
							</div>
						)}
						{usage.copilotUsageDetails.acceptancesCount !== undefined && (
							<div className="flex justify-between text-[10px]">
								<span>{t("common:usage.copilotAcceptancesLabel")}:</span>
								<span className="font-mono">
									{usage.copilotUsageDetails.acceptancesCount}
								</span>
							</div>
						)}
						{usage.copilotUsageDetails.acceptanceRate !== undefined && (
							<div className="flex justify-between text-[10px]">
								<span>{t("common:usage.copilotAcceptanceRateLabel")}:</span>
								<span className="font-mono">
									{usage.copilotUsageDetails.acceptanceRate.toFixed(1)}%
								</span>
							</div>
						)}
						{usage.copilotUsageDetails.totalTokens !== undefined &&
							usage.copilotUsageDetails.totalTokens > 0 && (
								<div className="flex justify-between text-[10px]">
									<span>{t("common:usage.copilotTokensUsedLabel")}:</span>
									<span className="font-mono">
										{usage.copilotUsageDetails.totalTokens}
									</span>
								</div>
							)}
					</div>
				)}
			</div>
		</div>
	);
}
