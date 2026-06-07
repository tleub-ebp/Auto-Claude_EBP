/**
 * #3.10 Generational Testing panel.
 *
 * Capture a JUnit XML as a labelled generation, then compare a fresh run
 * to a stored baseline → see regressions, vanished tests, slowdowns.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGenTestsStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

interface GenTestsPanelProps {
	projectPath: string;
}

const LABEL_MAX_LEN = 64;
const JUNIT_MAX_LEN = 5_000_000;

const looksLikeJunit = (xml: string): boolean => {
	const trimmed = xml.trim();
	if (!trimmed.startsWith("<")) return false;
	return /<testsuite[\s>]|<testsuites[\s>]/.test(trimmed);
};

export function GenTestsPanel({ projectPath }: GenTestsPanelProps) {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		generations,
		regression,
		listGenerations,
		capture,
		compare,
		deleteGen,
	} = useGenTestsStore();
	const [label, setLabel] = useState("");
	const [junit, setJunit] = useState("");
	const [baseline, setBaseline] = useState("");
	const [currentJunit, setCurrentJunit] = useState("");

	useEffect(() => {
		if (projectPath) listGenerations(projectPath);
	}, [projectPath, listGenerations]);

	const isRunning = phase === "running";

	const labelError = useMemo(
		() => (label.trim().length === 0 ? t("genTests.validation.labelRequired") : null),
		[label, t],
	);
	const junitError = useMemo(() => {
		if (junit.trim().length === 0) return t("genTests.validation.junitRequired");
		if (!looksLikeJunit(junit)) return t("genTests.validation.junitInvalid");
		if (junit.length > JUNIT_MAX_LEN)
			return t("common.tooLong", { max: JUNIT_MAX_LEN });
		return null;
	}, [junit, t]);
	const baselineError = useMemo(
		() => (baseline.trim().length === 0 ? t("genTests.validation.baselineRequired") : null),
		[baseline, t],
	);
	const currentJunitError = useMemo(() => {
		if (currentJunit.trim().length === 0) return t("genTests.validation.junitRequired");
		if (!looksLikeJunit(currentJunit)) return t("genTests.validation.junitInvalid");
		if (currentJunit.length > JUNIT_MAX_LEN)
			return t("common.tooLong", { max: JUNIT_MAX_LEN });
		return null;
	}, [currentJunit, t]);

	const captureDisabled = isRunning || Boolean(labelError) || Boolean(junitError);
	const compareDisabled =
		isRunning || Boolean(baselineError) || Boolean(currentJunitError);

	return (
		<PanelShell
			title={t("genTests.title")}
			subtitle={t("genTests.subtitle")}
			error={error}
		>
			{!projectPath && (
				<p className="text-sm text-muted-foreground">
					{t("common.projectPathRequired")}
				</p>
			)}
			<div className="space-y-4 text-sm">
				<details open={generations.length === 0}>
					<summary className="font-medium cursor-pointer">
						{t("genTests.capture")}
					</summary>
					<div className="mt-2 space-y-2">
						<div>
							<input
								value={label}
								onChange={(e) => setLabel(e.target.value.slice(0, LABEL_MAX_LEN))}
								maxLength={LABEL_MAX_LEN}
								aria-invalid={Boolean(labelError) || undefined}
								aria-describedby={labelError ? "label-error" : undefined}
								placeholder={t("genTests.label")}
								className="w-full rounded border bg-background p-2 text-sm"
							/>
							{labelError && (
								<p id="label-error" className="mt-1 text-xs text-destructive">
									{labelError}
								</p>
							)}
						</div>
						<div>
							<textarea
								value={junit}
								onChange={(e) => setJunit(e.target.value.slice(0, JUNIT_MAX_LEN))}
								rows={4}
								maxLength={JUNIT_MAX_LEN}
								aria-invalid={Boolean(junitError) || undefined}
								aria-describedby={junitError ? "junit-error" : undefined}
								placeholder={t("genTests.junitXml")}
								className="w-full rounded border bg-background p-2 font-mono text-xs"
							/>
							{junitError && (
								<p id="junit-error" className="mt-1 text-xs text-destructive">
									{junitError}
								</p>
							)}
						</div>
						<Button
							size="sm"
							onClick={() => capture(projectPath, label.trim(), junit)}
							disabled={captureDisabled || !projectPath}
						>
							{t("genTests.capture")}
						</Button>
					</div>
				</details>

				<div>
					<div className="font-medium mb-1">
						{t("genTests.generations")} ({generations.length})
					</div>
					{generations.length === 0 ? (
						<p className="text-muted-foreground">—</p>
					) : (
						<ul className="space-y-1">
							{generations.map((g) => (
								<li
									key={g}
									className="flex items-center justify-between rounded border px-2 py-1"
								>
									<code>{g}</code>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => deleteGen(projectPath, g)}
									>
										×
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>

				<details>
					<summary className="font-medium cursor-pointer">
						{t("genTests.compare")}
					</summary>
					<div className="mt-2 space-y-2">
						<div>
							<input
								value={baseline}
								onChange={(e) =>
									setBaseline(e.target.value.slice(0, LABEL_MAX_LEN))
								}
								maxLength={LABEL_MAX_LEN}
								aria-invalid={Boolean(baselineError) || undefined}
								aria-describedby={baselineError ? "baseline-error" : undefined}
								placeholder={t("genTests.baseline")}
								className="w-full rounded border bg-background p-2 text-sm"
							/>
							{baselineError && (
								<p id="baseline-error" className="mt-1 text-xs text-destructive">
									{baselineError}
								</p>
							)}
						</div>
						<div>
							<textarea
								value={currentJunit}
								onChange={(e) =>
									setCurrentJunit(e.target.value.slice(0, JUNIT_MAX_LEN))
								}
								rows={4}
								maxLength={JUNIT_MAX_LEN}
								aria-invalid={Boolean(currentJunitError) || undefined}
								aria-describedby={
									currentJunitError ? "current-junit-error" : undefined
								}
								placeholder={t("genTests.current")}
								className="w-full rounded border bg-background p-2 font-mono text-xs"
							/>
							{currentJunitError && (
								<p
									id="current-junit-error"
									className="mt-1 text-xs text-destructive"
								>
									{currentJunitError}
								</p>
							)}
						</div>
						<Button
							size="sm"
							onClick={() => compare(projectPath, baseline.trim(), currentJunit)}
							disabled={compareDisabled || !projectPath}
						>
							{t("genTests.compare")}
						</Button>
					</div>
				</details>

				{regression && (
					<div className="rounded border p-3">
						<div className="flex flex-wrap gap-2 mb-2">
							<Badge variant="outline">
								{t("genTests.regressions")}: {regression.summary.regressed ?? 0}
							</Badge>
							<Badge variant="outline">
								{t("genTests.slowdowns")}: {regression.summary.slowed_down ?? 0}
							</Badge>
							<Badge variant="outline">
								{t("genTests.newFailures")}: {regression.summary.new_failure ?? 0}
							</Badge>
							<Badge variant="outline">
								{t("genTests.vanished")}: {regression.summary.vanished ?? 0}
							</Badge>
							<Badge variant="outline">
								{t("genTests.added")}: {regression.summary.added ?? 0}
							</Badge>
						</div>
						<ul className="space-y-1 text-xs max-h-64 overflow-auto">
							{regression.items.map((it) => (
								<li
									key={it.test_id}
									className="font-mono flex justify-between gap-3"
								>
									<span className="truncate">{it.test_id}</span>
									<span className="text-muted-foreground whitespace-nowrap">
										{it.kind}
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
