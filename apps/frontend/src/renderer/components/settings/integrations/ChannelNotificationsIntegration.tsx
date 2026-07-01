import {
	AlertCircle,
	CheckCircle2,
	ExternalLink,
	Eye,
	EyeOff,
	Hash,
	MessageCircle,
	MessageSquare,
	MessagesSquare,
	Webhook,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectEnvConfig } from "../../../../shared/types";
import { GUIDE_ANCHORS } from "../../guided-tour/anchors";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";

interface ChannelNotificationsIntegrationProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

/** Backend API base (same one used by hooks-store). */
const BACKEND_URL = "http://localhost:9000";

type ChannelKey = "teams" | "slack" | "discord" | "googleChat" | "webhook";

interface ChannelDef {
	key: ChannelKey;
	/** Channel id understood by POST /api/notifications/test */
	apiChannel: string;
	enabledField: keyof ProjectEnvConfig;
	urlField: keyof ProjectEnvConfig;
	icon: ReactNode;
	placeholder: string;
	docUrl?: string;
}

const CHANNELS: ChannelDef[] = [
	{
		key: "teams",
		apiChannel: "teams",
		enabledField: "teamsNotificationsEnabled",
		urlField: "teamsWebhookUrl",
		icon: <MessageSquare className="h-4 w-4 text-[#6264A7]" />,
		placeholder: "https://xxx.webhook.office.com/webhookb2/...",
		docUrl:
			"https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook",
	},
	{
		key: "slack",
		apiChannel: "slack",
		enabledField: "slackNotificationsEnabled",
		urlField: "slackWebhookUrl",
		icon: <Hash className="h-4 w-4 text-[#E01E5A]" />,
		placeholder: "https://hooks.slack.com/services/...",
		docUrl: "https://api.slack.com/messaging/webhooks",
	},
	{
		key: "discord",
		apiChannel: "discord",
		enabledField: "discordNotificationsEnabled",
		urlField: "discordWebhookUrl",
		icon: <MessageCircle className="h-4 w-4 text-[#5865F2]" />,
		placeholder: "https://discord.com/api/webhooks/...",
		docUrl:
			"https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
	},
	{
		key: "googleChat",
		apiChannel: "google_chat",
		enabledField: "googleChatNotificationsEnabled",
		urlField: "googleChatWebhookUrl",
		icon: <MessagesSquare className="h-4 w-4 text-[#34A853]" />,
		placeholder: "https://chat.googleapis.com/v1/spaces/...",
		docUrl:
			"https://developers.google.com/workspace/chat/quickstart/webhooks",
	},
	{
		key: "webhook",
		apiChannel: "webhook",
		enabledField: "notifyWebhookEnabled",
		urlField: "notifyWebhookUrl",
		icon: <Webhook className="h-4 w-4 text-muted-foreground" />,
		placeholder: "https://example.com/webhook",
	},
];

type TestStatus = "idle" | "testing" | "success" | "error";

function ChannelRow({
	def,
	envConfig,
	updateEnvConfig,
}: {
	readonly def: ChannelDef;
	readonly envConfig: ProjectEnvConfig;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [showUrl, setShowUrl] = useState(false);
	const [testStatus, setTestStatus] = useState<TestStatus>("idle");

	const enabled = Boolean(envConfig[def.enabledField]);
	const webhookUrl = String(envConfig[def.urlField] ?? "");

	const handleTest = async () => {
		if (!webhookUrl) return;
		setTestStatus("testing");
		try {
			// Server-side test: browser fetch to webhook providers is blocked by CORS
			const res = await fetch(`${BACKEND_URL}/api/notifications/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ channel: def.apiChannel, url: webhookUrl }),
			});
			const data = (await res.json()) as { success?: boolean };
			setTestStatus(data.success ? "success" : "error");
		} catch {
			setTestStatus("error");
		}
		setTimeout(() => setTestStatus("idle"), 3000);
	};

	return (
		<div className="space-y-3 rounded-lg border border-border p-4">
			{/* Channel header + enable toggle */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					{def.icon}
					<div>
						<Label className="font-medium text-foreground">
							{t(`settings:channelNotifications.channels.${def.key}.name`)}
						</Label>
						<p className="text-xs text-muted-foreground mt-0.5">
							{t(`settings:channelNotifications.channels.${def.key}.hint`)}
						</p>
					</div>
				</div>
				<Switch
					data-guide={GUIDE_ANCHORS.notifications.enable(def.key)}
					checked={enabled}
					onCheckedChange={(checked) =>
						updateEnvConfig({ [def.enabledField]: checked })
					}
				/>
			</div>

			{enabled && (
				<>
					{/* Webhook URL */}
					<div className="relative">
						<Input
							id={`${def.key}-webhook`}
							data-guide={GUIDE_ANCHORS.notifications.webhook(def.key)}
							type={showUrl ? "text" : "password"}
							value={webhookUrl}
							onChange={(e) =>
								updateEnvConfig({ [def.urlField]: e.target.value })
							}
							placeholder={def.placeholder}
							className="pr-10 font-mono text-sm"
						/>
						<button
							type="button"
							onClick={() => setShowUrl(!showUrl)}
							className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
						>
							{showUrl ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</button>
					</div>

					{/* Test + doc link */}
					<div className="flex items-center gap-3">
						<Button
							variant="outline"
							size="sm"
							disabled={!webhookUrl || testStatus === "testing"}
							onClick={handleTest}
						>
							{testStatus === "testing"
								? t("common:testing")
								: t("settings:channelNotifications.testWebhook")}
						</Button>

						{testStatus === "success" && (
							<span className="flex items-center gap-1 text-sm text-emerald-600">
								<CheckCircle2 className="h-4 w-4" />
								{t("settings:channelNotifications.testSuccess")}
							</span>
						)}
						{testStatus === "error" && (
							<span className="flex items-center gap-1 text-sm text-destructive">
								<AlertCircle className="h-4 w-4" />
								{t("settings:channelNotifications.testError")}
							</span>
						)}

						{def.docUrl && (
							<a
								href={def.docUrl}
								target="_blank"
								rel="noreferrer"
								className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors ml-auto"
							>
								<ExternalLink className="h-3 w-3" />
								{t("settings:channelNotifications.howToCreate")}
							</a>
						)}
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Channel notification settings (Teams, Slack, Discord, Google Chat, webhook).
 * Announces on the configured channels when:
 * - A Kanban task is completed (moved to done)
 * - A PR is automatically created for human review
 */
export function ChannelNotificationsIntegration({
	envConfig,
	updateEnvConfig,
}: ChannelNotificationsIntegrationProps) {
	const { t } = useTranslation(["settings", "common"]);

	if (!envConfig) return null;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<div className="p-2 rounded-lg bg-primary/10">
					<MessagesSquare className="h-5 w-5 text-primary" />
				</div>
				<div>
					<h3 className="font-medium text-foreground">
						{t("settings:channelNotifications.title")}
					</h3>
					<p className="text-sm text-muted-foreground">
						{t("settings:channelNotifications.description")}
					</p>
				</div>
			</div>

			<Separator />

			{/* Channels */}
			<div className="space-y-3">
				{CHANNELS.map((def) => (
					<ChannelRow
						key={def.key}
						def={def}
						envConfig={envConfig}
						updateEnvConfig={updateEnvConfig}
					/>
				))}
			</div>

			<Separator />

			{/* What triggers a notification */}
			<div className="space-y-2">
				<Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
					{t("settings:channelNotifications.triggers")}
				</Label>
				<ul className="space-y-1.5 text-sm text-muted-foreground">
					<li className="flex items-center gap-2">
						<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
						{t("settings:channelNotifications.triggerTaskDone")}
					</li>
					<li className="flex items-center gap-2">
						<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
						{t("settings:channelNotifications.triggerPrCreated")}
					</li>
				</ul>
			</div>
		</div>
	);
}
