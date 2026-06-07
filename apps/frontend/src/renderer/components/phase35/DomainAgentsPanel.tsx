/**
 * #3.6 Domain-Specific Agent Factory panel.
 *
 * Pick a domain + an agent role, see the generated bundle (guardrails,
 * skills, prompt addendum). The output can be copied into a project's
 * config to inject domain awareness into every agent.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDomainAgentsStore } from "../../stores/phase35-stores";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

const ROLES = [
	{ value: "coder", labelKey: "domainAgents.roleCoder" },
	{ value: "planner", labelKey: "domainAgents.rolePlanner" },
	{ value: "reviewer", labelKey: "domainAgents.roleReviewer" },
	{ value: "documenter", labelKey: "domainAgents.roleDocumenter" },
] as const;

type Role = (typeof ROLES)[number]["value"];

export function DomainAgentsPanel() {
	const { t } = useTranslation("phase35");
	const { phase, error, domains, bundle, loadDomains, build } = useDomainAgentsStore();
	const [selected, setSelected] = useState<string>("");
	const [role, setRole] = useState<Role>("coder");

	useEffect(() => {
		loadDomains();
	}, [loadDomains]);

	useEffect(() => {
		if (!selected && domains.length > 0) setSelected(domains[0].tag);
	}, [selected, domains]);

	const isRunning = phase === "running";

	const domainError = useMemo(() => {
		if (domains.length === 0) return null;
		if (!selected) return t("domainAgents.validation.domainRequired");
		return null;
	}, [domains, selected, t]);

	const noDomains = !isRunning && domains.length === 0;

	return (
		<PanelShell
			title={t("domainAgents.title")}
			subtitle={t("domainAgents.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => build(selected, role)}
					disabled={isRunning || Boolean(domainError) || noDomains}
				>
					{isRunning ? t("common.running") : t("domainAgents.build")}
				</Button>
			}
		>
			<div className="space-y-3">
				{noDomains && (
					<p className="text-sm text-muted-foreground">
						{t("domainAgents.validation.noDomainsLoaded")}
					</p>
				)}
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="domain-select" className="block text-sm font-medium mb-1">
							{t("domainAgents.domain")}
						</label>
						<select
							id="domain-select"
							value={selected}
							onChange={(e) => setSelected(e.target.value)}
							disabled={domains.length === 0}
							aria-invalid={Boolean(domainError) || undefined}
							aria-describedby={domainError ? "domain-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm disabled:opacity-50"
						>
							{domains.length === 0 && <option value="">—</option>}
							{domains.map((d) => (
								<option key={d.tag} value={d.tag}>
									{d.label}
								</option>
							))}
						</select>
						{domainError && (
							<p id="domain-error" className="mt-1 text-xs text-destructive">
								{domainError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="role-select" className="block text-sm font-medium mb-1">
							{t("domainAgents.role")}
						</label>
						<select
							id="role-select"
							value={role}
							onChange={(e) => setRole(e.target.value as Role)}
							className="w-full rounded border bg-background p-2 text-sm"
						>
							{ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{t(r.labelKey as never)}
								</option>
							))}
						</select>
					</div>
				</div>

				{bundle && (
					<div className="space-y-3 text-sm">
						{bundle.guardrails.length > 0 && (
							<details open>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.guardrails")} ({bundle.guardrails.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc space-y-1 text-muted-foreground">
									{bundle.guardrails.map((g) => (
										<li key={g}>{g}</li>
									))}
								</ul>
							</details>
						)}
						{bundle.required_skills.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.requiredSkills")} ({bundle.required_skills.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.required_skills.map((s) => (
										<li key={s} className="font-mono">
											{s}
										</li>
									))}
								</ul>
							</details>
						)}
						{bundle.forbidden_patterns.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.forbidden")} ({bundle.forbidden_patterns.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.forbidden_patterns.map((p) => (
										<li key={p} className="font-mono text-xs">
											{p}
										</li>
									))}
								</ul>
							</details>
						)}
						{bundle.validation_rules.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.validationRules")} ({bundle.validation_rules.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.validation_rules.map((r) => (
										<li key={r}>{r}</li>
									))}
								</ul>
							</details>
						)}
						<details>
							<summary className="font-medium cursor-pointer">
								{t("domainAgents.prompt")}
							</summary>
							<pre className="mt-1 max-h-64 overflow-auto rounded border bg-muted/30 p-2 text-xs font-mono whitespace-pre-wrap">
								{bundle.prompt_addendum}
							</pre>
						</details>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
