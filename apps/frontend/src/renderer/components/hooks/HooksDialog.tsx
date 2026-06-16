/**
 * Event-Driven Hooks System — Visual Hook Editor & Manager
 *
 * n8n/Zapier-style visual workflow editor with template library,
 * hook management, and execution history.
 */

import {
	Activity,
	AlertTriangle,
	ArrowRight,
	Bell,
	BookTemplate,
	CheckCircle2,
	ChevronDown,
	Clock,
	Code2,
	Copy,
	Edit3,
	FileCode,
	GitBranch,
	GitPullRequest,
	Hammer,
	History,
	Layers,
	LayoutGrid,
	Link2,
	Loader2,
	MoreVertical,
	Pause,
	Play,
	Plus,
	Puzzle,
	Search,
	Settings2,
	Slash,
	Sparkles,
	Terminal,
	TestTube2,
	Trash2,
	TrendingUp,
	Webhook,
	X,
	Zap,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../components/ui/tabs";

import {
	type ActionType,
	type Hook,
	type HookExecution,
	type HooksTab,
	type HookTemplate,
	type TemplateCategory,
	type TriggerType,
	useHooksStore,
} from "../../stores/hooks-store";

// ─────────────────────────────────────────────────────────────────────────────
// Icon helpers
// ─────────────────────────────────────────────────────────────────────────────

const TRIGGER_ICONS: Record<string, React.ReactNode> = {
	file_saved: <FileCode className="h-4 w-4" />,
	file_created: <FileCode className="h-4 w-4" />,
	file_deleted: <Trash2 className="h-4 w-4" />,
	test_failed: <AlertTriangle className="h-4 w-4" />,
	test_passed: <CheckCircle2 className="h-4 w-4" />,
	pr_opened: <GitPullRequest className="h-4 w-4" />,
	pr_merged: <GitBranch className="h-4 w-4" />,
	pr_review_requested: <GitPullRequest className="h-4 w-4" />,
	build_started: <Hammer className="h-4 w-4" />,
	build_completed: <CheckCircle2 className="h-4 w-4" />,
	build_failed: <AlertTriangle className="h-4 w-4" />,
	dependency_outdated: <Layers className="h-4 w-4" />,
	code_pattern_detected: <Code2 className="h-4 w-4" />,
	lint_error: <Slash className="h-4 w-4" />,
	branch_created: <GitBranch className="h-4 w-4" />,
	commit_pushed: <GitBranch className="h-4 w-4" />,
	agent_completed: <Sparkles className="h-4 w-4" />,
	agent_failed: <AlertTriangle className="h-4 w-4" />,
	schedule: <Clock className="h-4 w-4" />,
	manual: <Play className="h-4 w-4" />,
	webhook: <Webhook className="h-4 w-4" />,
	custom: <Settings2 className="h-4 w-4" />,
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
	run_agent: <Sparkles className="h-4 w-4" />,
	send_notification: <Bell className="h-4 w-4" />,
	create_spec: <FileCode className="h-4 w-4" />,
	trigger_pipeline: <Activity className="h-4 w-4" />,
	run_command: <Terminal className="h-4 w-4" />,
	run_lint: <Code2 className="h-4 w-4" />,
	run_tests: <TestTube2 className="h-4 w-4" />,
	generate_tests: <TestTube2 className="h-4 w-4" />,
	update_docs: <FileCode className="h-4 w-4" />,
	create_pr: <GitPullRequest className="h-4 w-4" />,
	send_slack: <Bell className="h-4 w-4" />,
	send_teams: <Bell className="h-4 w-4" />,
	send_discord: <Bell className="h-4 w-4" />,
	send_google_chat: <Bell className="h-4 w-4" />,
	send_webhook: <Webhook className="h-4 w-4" />,
	log_event: <History className="h-4 w-4" />,
	chain_hook: <Link2 className="h-4 w-4" />,
	custom: <Puzzle className="h-4 w-4" />,
};

function StatusBadge({ status }: { readonly status: string }) {
	const { t } = useTranslation("hooks");
	const colors: Record<string, string> = {
		active: "bg-green-500/20 text-green-400 border-green-500/30",
		paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
		disabled: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
		error: "bg-red-500/20 text-red-400 border-red-500/30",
		success: "bg-green-500/20 text-green-400 border-green-500/30",
		failed: "bg-red-500/20 text-red-400 border-red-500/30",
		running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
		pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
		timeout: "bg-orange-500/20 text-orange-400 border-orange-500/30",
		skipped: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
	};
	return (
		<Badge
			variant="outline"
			className={`text-xs ${colors[status] || "bg-zinc-500/20 text-zinc-400"}`}
		>
			{t(`hookList.status.${status}`, { defaultValue: status })}
		</Badge>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats Bar
// ─────────────────────────────────────────────────────────────────────────────

function StatsBar() {
	const { t } = useTranslation("hooks");
	const stats = useHooksStore((s) => s.stats);

	if (!stats) return null;

	const items = [
		{
			label: t("stats.totalHooks"),
			value: stats.total_hooks,
			icon: <Zap className="h-4 w-4 text-purple-400" />,
		},
		{
			label: t("stats.activeHooks"),
			value: stats.active_hooks,
			icon: <Play className="h-4 w-4 text-green-400" />,
		},
		{
			label: t("stats.pausedHooks"),
			value: stats.paused_hooks,
			icon: <Pause className="h-4 w-4 text-yellow-400" />,
		},
		{
			label: t("stats.totalExecutions"),
			value: stats.total_executions,
			icon: <Activity className="h-4 w-4 text-blue-400" />,
		},
		{
			label: t("stats.successRate"),
			value: `${stats.success_rate}%`,
			icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
		},
	];

	return (
		<div className="grid grid-cols-5 gap-2 mb-4">
			{items.map((item) => (
				<div
					key={item.label}
					className="flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-800/50 px-3 py-2"
				>
					{item.icon}
					<div>
						<div className="text-sm font-semibold text-zinc-100">
							{item.value}
						</div>
						<div className="text-xs text-zinc-500">{item.label}</div>
					</div>
				</div>
			))}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook List Tab
// ─────────────────────────────────────────────────────────────────────────────

function HookListTab() {
	const { t } = useTranslation("hooks");
	const hooks = useHooksStore((s) => s.hooks);
	const loading = useHooksStore((s) => s.loading);
	const searchQuery = useHooksStore((s) => s.searchQuery);
	const setSearchQuery = useHooksStore((s) => s.setSearchQuery);
	const openEditor = useHooksStore((s) => s.openEditor);
	const toggleHook = useHooksStore((s) => s.toggleHook);
	const deleteHook = useHooksStore((s) => s.deleteHook);
	const duplicateHook = useHooksStore((s) => s.duplicateHook);

	const filtered = useMemo(() => {
		if (!searchQuery) return hooks;
		const q = searchQuery.toLowerCase();
		return hooks.filter(
			(h) =>
				h.name.toLowerCase().includes(q) ||
				h.description.toLowerCase().includes(q) ||
				h.tags.some((tag) => tag.toLowerCase().includes(q)),
		);
	}, [hooks, searchQuery]);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="h-8 w-8 animate-spin text-purple-400" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
					<input
						type="text"
						placeholder={t("hookList.search")}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-2 pl-10 pr-4 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-purple-500 focus:outline-none"
					/>
				</div>
				<Button
					onClick={() => openEditor()}
					className="bg-purple-600 hover:bg-purple-700 text-white gap-1.5"
				>
					<Plus className="h-4 w-4" />
					{t("hookList.createNew")}
				</Button>
			</div>

			{filtered.length === 0 ? (
				<div className="text-center py-16">
					<Zap className="h-12 w-12 text-zinc-600 mx-auto mb-3" />
					<p className="text-zinc-400 font-medium">{t("hookList.empty")}</p>
					<p className="text-zinc-500 text-sm mt-1">
						{t("hookList.emptyDescription")}
					</p>
				</div>
			) : (
				<ScrollArea className="h-[420px]">
					<div className="space-y-2 pr-2">
						{filtered.map((hook) => (
							<HookCard
								key={hook.id}
								hook={hook}
								onEdit={() => openEditor(hook)}
								onToggle={() => toggleHook(hook.id)}
								onDelete={() => deleteHook(hook.id)}
								onDuplicate={() => duplicateHook(hook.id)}
							/>
						))}
					</div>
				</ScrollArea>
			)}
		</div>
	);
}

function HookCard({
	hook,
	onEdit,
	onToggle,
	onDelete,
	onDuplicate,
}: {
	readonly hook: Hook;
	readonly onEdit: () => void;
	readonly onToggle: () => void;
	readonly onDelete: () => void;
	readonly onDuplicate: () => void;
}) {
	const { t } = useTranslation("hooks");
	const [showActions, setShowActions] = useState(false);

	return (
		<div className="group relative rounded-lg border border-zinc-700/50 bg-zinc-800/30 p-3 hover:border-purple-500/30 hover:bg-zinc-800/50 transition-all">
			<div className="flex items-start justify-between">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4 text-purple-400 shrink-0" />
						<span className="font-medium text-zinc-100 truncate">
							{hook.name || "Unnamed Hook"}
						</span>
						<StatusBadge status={hook.status} />
						{hook.cross_project && (
							<Badge
								variant="outline"
								className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/20"
							>
								🌐
							</Badge>
						)}
					</div>
					{hook.description && (
						<p className="text-xs text-zinc-500 mt-1 truncate">
							{hook.description}
						</p>
					)}
					<div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
						<span className="flex items-center gap-1">
							<Zap className="h-3 w-3" />
							{hook.triggers.length} {t("hookList.triggers")}
						</span>
						<span className="flex items-center gap-1">
							<Activity className="h-3 w-3" />
							{hook.actions.length} {t("hookList.actions")}
						</span>
						<span className="flex items-center gap-1">
							<Clock className="h-3 w-3" />
							{t("hookList.lastTriggered")}:{" "}
							{hook.last_triggered
								? new Date(hook.last_triggered).toLocaleString()
								: t("hookList.never")}
						</span>
						<span>
							{hook.execution_count} {t("hookList.executions")}
						</span>
						{hook.error_count > 0 && (
							<span className="text-red-400">
								{hook.error_count} {t("hookList.errors")}
							</span>
						)}
					</div>
					{hook.tags.length > 0 && (
						<div className="flex items-center gap-1 mt-1.5">
							{hook.tags.map((tag) => (
								<Badge
									key={tag}
									variant="outline"
									className="text-[10px] py-0 px-1.5 bg-zinc-700/30 text-zinc-400 border-zinc-600/30"
								>
									{tag}
								</Badge>
							))}
						</div>
					)}
				</div>
				<div className="relative">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300"
						onClick={() => setShowActions(!showActions)}
					>
						<MoreVertical className="h-4 w-4" />
					</Button>
					{showActions && (
						<div className="absolute right-0 top-8 z-50 w-40 rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl py-1">
							<button
								type="button"
								onClick={() => {
									onEdit();
									setShowActions(false);
								}}
								className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
							>
								<Edit3 className="h-3 w-3" /> {t("actions.edit")}
							</button>
							<button
								type="button"
								onClick={() => {
									onToggle();
									setShowActions(false);
								}}
								className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
							>
								{hook.status === "active" ? (
									<Pause className="h-3 w-3" />
								) : (
									<Play className="h-3 w-3" />
								)}
								{hook.status === "active"
									? t("actions.pause")
									: t("actions.resume")}
							</button>
							<button
								type="button"
								onClick={() => {
									onDuplicate();
									setShowActions(false);
								}}
								className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
							>
								<Copy className="h-3 w-3" /> {t("actions.duplicate")}
							</button>
							<button
								type="button"
								onClick={() => {
									onDelete();
									setShowActions(false);
								}}
								className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700"
							>
								<Trash2 className="h-3 w-3" /> {t("actions.delete")}
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates Tab
// ─────────────────────────────────────────────────────────────────────────────

function TemplatesTab() {
	const { t } = useTranslation("hooks");
	const templates = useHooksStore((s) => s.templates);
	const templateCategory = useHooksStore((s) => s.templateCategory);
	const setTemplateCategory = useHooksStore((s) => s.setTemplateCategory);
	const createFromTemplate = useHooksStore((s) => s.createFromTemplate);
	const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

	const categories: TemplateCategory[] = [
		"all",
		"automation",
		"quality",
		"notification",
		"ci_cd",
		"documentation",
	];

	const filtered = useMemo(() => {
		if (templateCategory === "all") return templates;
		return templates.filter((tpl) => tpl.category === templateCategory);
	}, [templates, templateCategory]);

	const handleInstall = async (tpl: HookTemplate) => {
		await createFromTemplate(tpl.id);
		setInstalledIds((prev) => new Set(prev).add(tpl.id));
	};

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-sm font-medium text-zinc-200">
					{t("templates.title")}
				</h3>
				<p className="text-xs text-zinc-500 mt-0.5">
					{t("templates.description")}
				</p>
			</div>

			<div className="flex items-center gap-1.5 flex-wrap">
				{categories.map((cat) => (
					<Button
						key={cat}
						variant={templateCategory === cat ? "default" : "outline"}
						size="sm"
						className={`text-xs h-7 ${
							templateCategory === cat
								? "bg-purple-600 hover:bg-purple-700 text-white"
								: "bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:text-zinc-200"
						}`}
						onClick={() => setTemplateCategory(cat)}
					>
						{t(`templates.categories.${cat}`)}
					</Button>
				))}
			</div>

			<ScrollArea className="h-[380px]">
				<div className="grid grid-cols-2 gap-2 pr-2">
					{filtered.map((tpl) => (
						<div
							key={tpl.id}
							className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 p-3 hover:border-purple-500/30 transition-all"
						>
							<div className="flex items-start justify-between">
								<div className="flex items-center gap-2">
									<span className="text-lg">{tpl.icon}</span>
									<div>
										<div className="text-sm font-medium text-zinc-200">
											{tpl.name}
										</div>
										<div className="text-xs text-zinc-500">{tpl.category}</div>
									</div>
								</div>
							</div>
							<p className="text-xs text-zinc-400 mt-2 line-clamp-2">
								{tpl.description}
							</p>
							<div className="flex items-center gap-1 mt-2">
								{tpl.tags.slice(0, 3).map((tag) => (
									<Badge
										key={tag}
										variant="outline"
										className="text-[10px] py-0 px-1.5 bg-zinc-700/30 text-zinc-500 border-zinc-600/30"
									>
										{tag}
									</Badge>
								))}
							</div>
							<div className="flex items-center justify-between mt-3">
								<span className="text-xs text-zinc-500 flex items-center gap-1">
									<TrendingUp className="h-3 w-3" /> {tpl.popularity}%{" "}
									{t("templates.popularity")}
								</span>
								<Button
									size="sm"
									className={`text-xs h-6 px-2 ${
										installedIds.has(tpl.id)
											? "bg-green-600/20 text-green-400 hover:bg-green-600/30"
											: "bg-purple-600 hover:bg-purple-700 text-white"
									}`}
									onClick={() => handleInstall(tpl)}
									disabled={installedIds.has(tpl.id)}
								>
									{installedIds.has(tpl.id) ? (
										<>
											<CheckCircle2 className="h-3 w-3 mr-1" />{" "}
											{t("templates.installed")}
										</>
									) : (
										<>
											<Plus className="h-3 w-3 mr-1" /> {t("templates.install")}
										</>
									)}
								</Button>
							</div>
						</div>
					))}
				</div>
			</ScrollArea>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// History Tab
// ─────────────────────────────────────────────────────────────────────────────

function HistoryTab() {
	const { t } = useTranslation("hooks");
	const executions = useHooksStore((s) => s.executions);

	if (executions.length === 0) {
		return (
			<div className="text-center py-16">
				<History className="h-12 w-12 text-zinc-600 mx-auto mb-3" />
				<p className="text-zinc-400">{t("history.empty")}</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-medium text-zinc-200">
					{t("history.title")}
				</h3>
				<p className="text-xs text-zinc-500 mt-0.5">
					{t("history.description")}
				</p>
			</div>
			<ScrollArea className="h-[420px]">
				<div className="space-y-2 pr-2">
					{[...executions].reverse().map((exec) => (
						<ExecutionCard key={exec.id} execution={exec} />
					))}
				</div>
			</ScrollArea>
		</div>
	);
}

function ExecutionCard({ execution }: { readonly execution: HookExecution }) {
	const { t } = useTranslation("hooks");

	return (
		<div className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 p-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<StatusBadge status={execution.status} />
					<span className="text-sm font-medium text-zinc-200">
						{execution.hook_name || "Unknown Hook"}
					</span>
				</div>
				<span className="text-xs text-zinc-500">
					{execution.duration_ms != null && `${execution.duration_ms}ms`}
				</span>
			</div>
			<div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-500">
				<span className="flex items-center gap-1">
					<Zap className="h-3 w-3" />
					{t("history.triggeredBy")}: {execution.trigger_type}
				</span>
				<span>
					{execution.action_results.length} {t("history.actionsExecuted")}
				</span>
				<span>{new Date(execution.started_at).toLocaleString()}</span>
			</div>
			{execution.error && (
				<p className="text-xs text-red-400 mt-1.5 bg-red-500/10 rounded px-2 py-1">
					{execution.error}
				</p>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual Editor Tab
// ─────────────────────────────────────────────────────────────────────────────

function EditorTab() {
	const { t } = useTranslation("hooks");
	const editingHook = useHooksStore((s) => s.editingHook);
	const setEditingHook = useHooksStore((s) => s.setEditingHook);
	const saveEditorHook = useHooksStore((s) => s.saveEditorHook);
	const closeEditor = useHooksStore((s) => s.closeEditor);
	const addTriggerToEditor = useHooksStore((s) => s.addTriggerToEditor);
	const addActionToEditor = useHooksStore((s) => s.addActionToEditor);
	const removeTriggerFromEditor = useHooksStore(
		(s) => s.removeTriggerFromEditor,
	);
	const removeActionFromEditor = useHooksStore((s) => s.removeActionFromEditor);
	const addConnectionToEditor = useHooksStore((s) => s.addConnectionToEditor);
	const removeConnectionFromEditor = useHooksStore(
		(s) => s.removeConnectionFromEditor,
	);

	const [showTriggerMenu, setShowTriggerMenu] = useState(false);
	const [showActionMenu, setShowActionMenu] = useState(false);
	const [connectingFrom, setConnectingFrom] = useState<string | null>(null);

	if (!editingHook) {
		return (
			<div className="text-center py-16">
				<Edit3 className="h-12 w-12 text-zinc-600 mx-auto mb-3" />
				<p className="text-zinc-400">{t("editor.description")}</p>
			</div>
		);
	}

	const triggerTypes: TriggerType[] = [
		"file_saved",
		"file_created",
		"file_deleted",
		"test_failed",
		"test_passed",
		"pr_opened",
		"pr_merged",
		"build_completed",
		"build_failed",
		"dependency_outdated",
		"code_pattern_detected",
		"lint_error",
		"commit_pushed",
		"agent_completed",
		"schedule",
		"manual",
		"webhook",
	];

	const actionTypes: ActionType[] = [
		"run_agent",
		"send_notification",
		"run_command",
		"run_lint",
		"run_tests",
		"generate_tests",
		"update_docs",
		"create_pr",
		"create_spec",
		"trigger_pipeline",
		"send_slack",
		"send_teams",
		"send_discord",
		"send_google_chat",
		"send_webhook",
		"log_event",
		"chain_hook",
	];

	const handleNodeClick = (nodeId: string) => {
		if (connectingFrom && connectingFrom !== nodeId) {
			addConnectionToEditor({
				source_id: connectingFrom,
				target_id: nodeId,
				source_handle: "output",
				target_handle: "input",
				condition: "always",
			});
			setConnectingFrom(null);
		}
	};

	return (
		<div className="space-y-4">
			{/* Hook metadata */}
			<div className="grid grid-cols-2 gap-3">
				<div>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
					<label className="text-xs text-zinc-400 block mb-1">
						{t("editor.hookName")}
					</label>
					<input
						type="text"
						value={editingHook.name}
						onChange={(e) =>
							setEditingHook({ ...editingHook, name: e.target.value })
						}
						placeholder={t("editor.hookNamePlaceholder")}
						className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-1.5 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-purple-500 focus:outline-none"
					/>
				</div>
				<div>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
					<label className="text-xs text-zinc-400 block mb-1">
						{t("editor.hookDescription")}
					</label>
					<input
						type="text"
						value={editingHook.description}
						onChange={(e) =>
							setEditingHook({ ...editingHook, description: e.target.value })
						}
						placeholder={t("editor.hookDescriptionPlaceholder")}
						className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-1.5 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-purple-500 focus:outline-none"
					/>
				</div>
			</div>

			{/* Toolbar */}
			<div className="flex items-center gap-2">
				<div className="relative">
					<Button
						variant="outline"
						size="sm"
						className="text-xs border-emerald-600/30 text-emerald-400 hover:bg-emerald-600/10 gap-1"
						onClick={() => {
							setShowTriggerMenu(!showTriggerMenu);
							setShowActionMenu(false);
						}}
					>
						<Zap className="h-3.5 w-3.5" /> {t("editor.addTrigger")}
						<ChevronDown className="h-3 w-3" />
					</Button>
					{showTriggerMenu && (
						<div className="absolute left-0 top-9 z-50 w-56 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl py-1">
							{triggerTypes.map((tt) => (
								<button
									type="button"
									key={tt}
									onClick={() => {
										addTriggerToEditor(tt);
										setShowTriggerMenu(false);
									}}
									className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
								>
									{TRIGGER_ICONS[tt]} {t(`editor.triggerTypes.${tt}`)}
								</button>
							))}
						</div>
					)}
				</div>

				<div className="relative">
					<Button
						variant="outline"
						size="sm"
						className="text-xs border-blue-600/30 text-blue-400 hover:bg-blue-600/10 gap-1"
						onClick={() => {
							setShowActionMenu(!showActionMenu);
							setShowTriggerMenu(false);
						}}
					>
						<Activity className="h-3.5 w-3.5" /> {t("editor.addAction")}
						<ChevronDown className="h-3 w-3" />
					</Button>
					{showActionMenu && (
						<div className="absolute left-0 top-9 z-50 w-56 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl py-1">
							{actionTypes.map((at) => (
								<button
									type="button"
									key={at}
									onClick={() => {
										addActionToEditor(at);
										setShowActionMenu(false);
									}}
									className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
								>
									{ACTION_ICONS[at]} {t(`editor.actionTypes.${at}`)}
								</button>
							))}
						</div>
					)}
				</div>

				{connectingFrom && (
					<Badge
						variant="outline"
						className="text-xs bg-purple-500/10 text-purple-400 border-purple-500/20 gap-1"
					>
						<Link2 className="h-3 w-3" /> Click a target node to connect...
						<button
							type="button"
							onClick={() => setConnectingFrom(null)}
							className="ml-1"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				)}

				<div className="flex-1" />

				<label className="flex items-center gap-1.5 text-xs text-zinc-400">
					<input
						type="checkbox"
						checked={editingHook.cross_project}
						onChange={(e) =>
							setEditingHook({
								...editingHook,
								cross_project: e.target.checked,
							})
						}
						className="rounded border-zinc-600"
					/>
					{t("editor.crossProject")}
				</label>
			</div>

			{/* Visual canvas */}
			<div className="relative rounded-xl border border-zinc-700/50 bg-zinc-900/60 min-h-[300px] overflow-auto p-4">
				{/* Connections (SVG lines) */}
				{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative, intentional  */}
				<svg
					className="absolute inset-0 w-full h-full pointer-events-none"
					style={{ zIndex: 0 }}
				>
					{editingHook.connections.map((conn) => {
						const sourceNode =
							editingHook.triggers.find((t) => t.id === conn.source_id) ||
							editingHook.actions.find((a) => a.id === conn.source_id);
						const targetNode =
							editingHook.triggers.find((t) => t.id === conn.target_id) ||
							editingHook.actions.find((a) => a.id === conn.target_id);

						if (!sourceNode || !targetNode) return null;

						const sx = sourceNode.position.x + 160;
						const sy = sourceNode.position.y + 25;
						const tx = targetNode.position.x;
						const ty = targetNode.position.y + 25;
						const mx = (sx + tx) / 2;

						let strokeColor: string;
						if (conn.condition === "on_failure") {
							strokeColor = "#ef4444";
						} else if (conn.condition === "on_success") {
							strokeColor = "#22c55e";
						} else {
							strokeColor = "#8b5cf6";
						}

						return (
							<g key={`${conn.source_id}-${conn.target_id}`}>
								<path
									d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
									fill="none"
									stroke={strokeColor}
									strokeWidth={2}
									strokeDasharray={
										conn.condition === "on_failure" ? "4 2" : "none"
									}
									opacity={0.6}
								/>
								<circle
									cx={tx}
									cy={ty}
									r={3}
									fill={conn.condition === "on_failure" ? "#ef4444" : "#8b5cf6"}
								/>
							</g>
						);
					})}
				</svg>

				{/* Trigger nodes */}
				{editingHook.triggers.map((trigger) => (
					// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
					// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events handled elsewhere
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: visual graph node
					<div
						key={trigger.id}
						className={`absolute cursor-pointer rounded-lg border-2 px-3 py-2 w-[160px] transition-all ${
							connectingFrom === trigger.id
								? "border-purple-500 bg-emerald-900/50 shadow-lg shadow-purple-500/20"
								: "border-emerald-600/40 bg-emerald-900/30 hover:border-emerald-500/60"
						}`}
						style={{
							left: trigger.position.x,
							top: trigger.position.y,
							zIndex: 10,
						}}
						onClick={() => handleNodeClick(trigger.id)}
					>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-1.5">
								{TRIGGER_ICONS[trigger.type]}
								<span className="text-xs font-medium text-emerald-300 truncate">
									{t(`editor.triggerTypes.${trigger.type}`)}
								</span>
							</div>
							<div className="flex items-center gap-0.5">
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setConnectingFrom(trigger.id);
									}}
									className="text-zinc-500 hover:text-purple-400"
									title="Connect"
								>
									<ArrowRight className="h-3 w-3" />
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										removeTriggerFromEditor(trigger.id);
									}}
									className="text-zinc-500 hover:text-red-400"
								>
									<X className="h-3 w-3" />
								</button>
							</div>
						</div>
						<div className="text-[10px] text-zinc-500 mt-0.5">
							{trigger.conditions.length > 0
								? `${trigger.conditions.length} condition(s)`
								: "No conditions"}
						</div>
					</div>
				))}

				{/* Action nodes */}
				{editingHook.actions.map((action) => (
					// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
					// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events handled elsewhere
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: visual graph node
					<div
						key={action.id}
						className={`absolute cursor-pointer rounded-lg border-2 px-3 py-2 w-[160px] transition-all ${
							connectingFrom === action.id
								? "border-purple-500 bg-blue-900/50 shadow-lg shadow-purple-500/20"
								: "border-blue-600/40 bg-blue-900/30 hover:border-blue-500/60"
						}`}
						style={{
							left: action.position.x,
							top: action.position.y,
							zIndex: 10,
						}}
						onClick={() => handleNodeClick(action.id)}
					>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-1.5">
								{ACTION_ICONS[action.type]}
								<span className="text-xs font-medium text-blue-300 truncate">
									{t(`editor.actionTypes.${action.type}`)}
								</span>
							</div>
							<div className="flex items-center gap-0.5">
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setConnectingFrom(action.id);
									}}
									className="text-zinc-500 hover:text-purple-400"
									title="Connect"
								>
									<ArrowRight className="h-3 w-3" />
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										removeActionFromEditor(action.id);
									}}
									className="text-zinc-500 hover:text-red-400"
								>
									<X className="h-3 w-3" />
								</button>
							</div>
						</div>
						<div className="text-[10px] text-zinc-500 mt-0.5">
							{action.timeout_ms > 0 && `timeout: ${action.timeout_ms / 1000}s`}
							{action.delay_ms > 0 && ` • delay: ${action.delay_ms}ms`}
						</div>
					</div>
				))}

				{/* Empty state */}
				{editingHook.triggers.length === 0 &&
					editingHook.actions.length === 0 && (
						<div className="flex items-center justify-center h-[260px] text-zinc-600">
							<div className="text-center">
								<LayoutGrid className="h-10 w-10 mx-auto mb-2" />
								<p className="text-sm">{t("editor.description")}</p>
							</div>
						</div>
					)}
			</div>

			{/* Connections list */}
			{editingHook.connections.length > 0 && (
				<div className="space-y-1">
					<span className="text-xs text-zinc-500 font-medium">
						Connections:
					</span>
					<div className="flex flex-wrap gap-1">
						{editingHook.connections.map((conn) => {
							const sourceName =
								editingHook.triggers.find((t) => t.id === conn.source_id)
									?.type ||
								editingHook.actions.find((a) => a.id === conn.source_id)
									?.type ||
								"?";
							const targetName =
								editingHook.triggers.find((t) => t.id === conn.target_id)
									?.type ||
								editingHook.actions.find((a) => a.id === conn.target_id)
									?.type ||
								"?";
							return (
								<Badge
									key={`${conn.source_id}-${conn.target_id}`}
									variant="outline"
									className="text-[10px] py-0 px-1.5 bg-zinc-800/50 text-zinc-400 border-zinc-600/30 gap-1"
								>
									{sourceName} → {targetName}
									<span className="text-purple-400">
										({conn.condition || "always"})
									</span>
									<button
										type="button"
										onClick={() =>
											removeConnectionFromEditor(conn.source_id, conn.target_id)
										}
										className="hover:text-red-400 ml-0.5"
									>
										<X className="h-2.5 w-2.5" />
									</button>
								</Badge>
							);
						})}
					</div>
				</div>
			)}

			{/* Footer actions */}
			<div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-700/50">
				<Button
					variant="outline"
					size="sm"
					className="text-xs"
					onClick={closeEditor}
				>
					{t("editor.cancel")}
				</Button>
				<Button
					size="sm"
					className="text-xs bg-purple-600 hover:bg-purple-700 text-white gap-1"
					onClick={saveEditorHook}
					disabled={!editingHook.name}
				>
					<CheckCircle2 className="h-3.5 w-3.5" />
					{t("editor.save")}
				</Button>
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Dialog
// ─────────────────────────────────────────────────────────────────────────────

export function HooksDialog() {
	const { t } = useTranslation("hooks");
	const isOpen = useHooksStore((s) => s.isOpen);
	const closeDialog = useHooksStore((s) => s.closeDialog);
	const activeTab = useHooksStore((s) => s.activeTab);
	const setActiveTab = useHooksStore((s) => s.setActiveTab);

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
			<DialogContent className="max-w-4xl max-h-[85vh] bg-zinc-900 border-zinc-700">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-zinc-100">
						<Zap className="h-5 w-5 text-purple-400" />
						{t("title")}
					</DialogTitle>
					<DialogDescription className="text-zinc-400 text-sm">
						{t("description")}
					</DialogDescription>
				</DialogHeader>

				<StatsBar />

				<Tabs
					value={activeTab}
					onValueChange={(v) => setActiveTab(v as HooksTab)}
				>
					<TabsList className="bg-zinc-800/50 border border-zinc-700/50">
						<TabsTrigger
							value="hooks"
							className="text-xs gap-1.5 data-[state=active]:bg-purple-600/20 data-[state=active]:text-purple-300"
						>
							<Zap className="h-3.5 w-3.5" /> {t("tabs.hooks")}
						</TabsTrigger>
						<TabsTrigger
							value="templates"
							className="text-xs gap-1.5 data-[state=active]:bg-purple-600/20 data-[state=active]:text-purple-300"
						>
							<BookTemplate className="h-3.5 w-3.5" /> {t("tabs.templates")}
						</TabsTrigger>
						<TabsTrigger
							value="history"
							className="text-xs gap-1.5 data-[state=active]:bg-purple-600/20 data-[state=active]:text-purple-300"
						>
							<History className="h-3.5 w-3.5" /> {t("tabs.history")}
						</TabsTrigger>
						<TabsTrigger
							value="editor"
							className="text-xs gap-1.5 data-[state=active]:bg-purple-600/20 data-[state=active]:text-purple-300"
						>
							<Edit3 className="h-3.5 w-3.5" /> {t("tabs.editor")}
						</TabsTrigger>
					</TabsList>

					<TabsContent value="hooks" className="mt-4">
						<HookListTab />
					</TabsContent>
					<TabsContent value="templates" className="mt-4">
						<TemplatesTab />
					</TabsContent>
					<TabsContent value="history" className="mt-4">
						<HistoryTab />
					</TabsContent>
					<TabsContent value="editor" className="mt-4">
						<EditorTab />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

export default HooksDialog;
