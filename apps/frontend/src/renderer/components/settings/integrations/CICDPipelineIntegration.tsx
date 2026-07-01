import { Eye, EyeOff, Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectEnvConfig } from "../../../../shared/types";
import { GUIDE_ANCHORS } from "../../guided-tour/anchors";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";

interface CICDPipelineIntegrationProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

/**
 * CI/CD pipeline loop settings (« Build rouge » column + auto-repair).
 *
 * Provider-agnostic: Azure DevOps, GitHub Actions, GitLab CI or Jenkins.
 * Azure/GitHub/GitLab credentials are reused from their own integration
 * sections — only the provider choice, the loop knobs and the Jenkins
 * connection live here. Everything is persisted to the project .env
 * (CICD_* variables) through the standard updateEnvConfig flow.
 */
export function CICDPipelineIntegration({
	envConfig,
	updateEnvConfig,
}: CICDPipelineIntegrationProps) {
	const { t } = useTranslation("settings");
	const [showJenkinsToken, setShowJenkinsToken] = useState(false);

	if (!envConfig) return null;

	// Radix Select forbids empty-string item values: "auto" is the UI sentinel
	// for the stored "" (auto-detect) value.
	const providerValue = envConfig.cicdProvider || "auto";
	const setProvider = (value: string) => {
		updateEnvConfig({
			cicdProvider: (value === "auto"
				? ""
				: value) as ProjectEnvConfig["cicdProvider"],
		});
	};

	const reusedCredsSection: Record<string, string> = {
		azure: "Azure DevOps",
		github: "GitHub",
		gitlab: "GitLab",
	};

	const enabled = providerValue !== "none";

	return (
		<div className="space-y-4">
			<p className="text-xs text-muted-foreground">
				{t("cicd.introDescription")}
			</p>

			{/* Provider selection */}
			<div className="space-y-2">
				<Label className="text-sm font-medium text-foreground">
					{t("cicd.providerLabel")}
				</Label>
				<p className="text-xs text-muted-foreground">
					{t("cicd.providerDescription")}
				</p>
				<Select value={providerValue} onValueChange={setProvider}>
					<SelectTrigger data-guide={GUIDE_ANCHORS.cicd.provider}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="auto">{t("cicd.providerAuto")}</SelectItem>
						<SelectItem value="azure">Azure DevOps Pipelines</SelectItem>
						<SelectItem value="github">GitHub Actions</SelectItem>
						<SelectItem value="gitlab">GitLab CI</SelectItem>
						<SelectItem value="jenkins">Jenkins</SelectItem>
						<SelectItem value="none">{t("cicd.providerNone")}</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{/* Credentials note for providers configured in their own section */}
			{reusedCredsSection[providerValue] && (
				<div className="rounded-lg border border-info/30 bg-info/5 p-3 flex items-start gap-2">
					<Info className="h-4 w-4 text-info mt-0.5 shrink-0" />
					<p className="text-xs text-muted-foreground">
						{t("cicd.reusedCredentials", {
							section: reusedCredsSection[providerValue],
						})}
					</p>
				</div>
			)}
			{providerValue === "auto" && (
				<div className="rounded-lg border border-border bg-muted/30 p-3 flex items-start gap-2">
					<Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
					<p className="text-xs text-muted-foreground">
						{t("cicd.autoDetectNote")}
					</p>
				</div>
			)}

			{/* Jenkins connection (the only provider without its own section) */}
			{providerValue === "jenkins" && (
				<>
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("cicd.jenkinsUrlLabel")}
						</Label>
						<Input
							type="url"
							placeholder="https://jenkins.example.com"
							value={envConfig.cicdJenkinsUrl || ""}
							onChange={(e) =>
								updateEnvConfig({ cicdJenkinsUrl: e.target.value })
							}
						/>
					</div>
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("cicd.jenkinsJobLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("cicd.jenkinsJobDescription")}
						</p>
						<Input
							placeholder="my-multibranch-job"
							value={envConfig.cicdJenkinsJob || ""}
							onChange={(e) =>
								updateEnvConfig({ cicdJenkinsJob: e.target.value })
							}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label className="text-sm font-medium text-foreground">
								{t("cicd.jenkinsUserLabel")}
							</Label>
							<Input
								placeholder="admin"
								value={envConfig.cicdJenkinsUser || ""}
								onChange={(e) =>
									updateEnvConfig({ cicdJenkinsUser: e.target.value })
								}
							/>
						</div>
						<div className="space-y-2">
							<Label className="text-sm font-medium text-foreground">
								{t("cicd.jenkinsTokenLabel")}
							</Label>
							<div className="relative">
								<Input
									type={showJenkinsToken ? "text" : "password"}
									value={envConfig.cicdJenkinsToken || ""}
									onChange={(e) =>
										updateEnvConfig({ cicdJenkinsToken: e.target.value })
									}
									className="pr-9"
								/>
								<button
									type="button"
									onClick={() => setShowJenkinsToken(!showJenkinsToken)}
									className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								>
									{showJenkinsToken ? (
										<EyeOff className="h-4 w-4" />
									) : (
										<Eye className="h-4 w-4" />
									)}
								</button>
							</div>
						</div>
					</div>
				</>
			)}

			{enabled && (
				<>
					<Separator />

					{/* Auto-repair toggle */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="font-normal text-foreground">
								{t("cicd.autoFixLabel")}
							</Label>
							<p className="text-xs text-muted-foreground">
								{t("cicd.autoFixDescription")}
							</p>
						</div>
						<Switch
							checked={envConfig.cicdAutoFix !== false}
							onCheckedChange={(checked) =>
								updateEnvConfig({ cicdAutoFix: checked })
							}
						/>
					</div>

					{/* Poll interval */}
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("cicd.pollLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("cicd.pollDescription")}
						</p>
						<Input
							type="number"
							min={15}
							placeholder="60"
							value={envConfig.cicdPollSeconds ?? ""}
							onChange={(e) => {
								const parsed = Number.parseInt(e.target.value, 10);
								updateEnvConfig({
									cicdPollSeconds: Number.isFinite(parsed) ? parsed : 0,
								});
							}}
							className="max-w-[140px]"
						/>
					</div>
				</>
			)}
		</div>
	);
}
