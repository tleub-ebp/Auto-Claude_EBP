/**
 * Event-Driven Hooks System — Zustand Store
 *
 * Manages hooks state: CRUD, templates, executions, visual editor state.
 */

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerType =
	| "file_saved"
	| "file_created"
	| "file_deleted"
	| "test_failed"
	| "test_passed"
	| "pr_opened"
	| "pr_merged"
	| "pr_review_requested"
	| "build_started"
	| "build_completed"
	| "build_failed"
	| "dependency_outdated"
	| "code_pattern_detected"
	| "lint_error"
	| "branch_created"
	| "commit_pushed"
	| "agent_completed"
	| "agent_failed"
	| "schedule"
	| "manual"
	| "webhook"
	| "custom";

export type ActionType =
	| "run_agent"
	| "send_notification"
	| "create_spec"
	| "trigger_pipeline"
	| "run_command"
	| "run_lint"
	| "run_tests"
	| "generate_tests"
	| "update_docs"
	| "create_pr"
	| "send_slack"
	| "send_teams"
	| "send_discord"
	| "send_google_chat"
	| "send_webhook"
	| "log_event"
	| "chain_hook"
	| "custom";

export type HookStatus = "active" | "paused" | "disabled" | "error";
export type ExecutionStatus =
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "skipped"
	| "timeout";

export interface TriggerCondition {
	field: string;
	operator: string;
	value: string;
}

export interface Trigger {
	id: string;
	type: TriggerType;
	conditions: TriggerCondition[];
	config: Record<string, unknown>;
	cron_expression?: string;
	position: { x: number; y: number };
}

export interface Action {
	id: string;
	type: ActionType;
	config: Record<string, unknown>;
	delay_ms: number;
	max_retries: number;
	retry_delay_ms: number;
	timeout_ms: number;
	position: { x: number; y: number };
}

export interface HookConnection {
	source_id: string;
	target_id: string;
	source_handle: string;
	target_handle: string;
	condition?: string | null;
}

export interface Hook {
	id: string;
	name: string;
	description: string;
	project_id?: string | null;
	cross_project: boolean;
	status: HookStatus;
	triggers: Trigger[];
	actions: Action[];
	connections: HookConnection[];
	created_at: string;
	updated_at: string;
	last_triggered?: string | null;
	execution_count: number;
	error_count: number;
	template_id?: string | null;
	tags: string[];
}

export interface HookTemplate {
	id: string;
	name: string;
	description: string;
	category: string;
	icon: string;
	tags: string[];
	triggers: Trigger[];
	actions: Action[];
	connections: HookConnection[];
	popularity: number;
}

export interface HookExecution {
	id: string;
	hook_id: string;
	hook_name: string;
	trigger_type: string;
	status: ExecutionStatus;
	started_at: string;
	completed_at?: string | null;
	duration_ms?: number | null;
	trigger_event: Record<string, unknown>;
	action_results: Array<Record<string, unknown>>;
	error?: string | null;
}

export interface HookStats {
	total_hooks: number;
	active_hooks: number;
	paused_hooks: number;
	total_executions: number;
	total_errors: number;
	success_rate: number;
	recent_executions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_URL = "http://localhost:9000";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BACKEND_URL}${path}`, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

export type HooksTab = "hooks" | "templates" | "history" | "editor";
export type TemplateCategory =
	| "all"
	| "automation"
	| "quality"
	| "notification"
	| "ci_cd"
	| "documentation";

interface HooksState {
	// Dialog
	isOpen: boolean;
	openDialog: () => void;
	closeDialog: () => void;

	// Active tab
	activeTab: HooksTab;
	setActiveTab: (tab: HooksTab) => void;

	// Hooks data
	hooks: Hook[];
	templates: HookTemplate[];
	executions: HookExecution[];
	stats: HookStats | null;
	loading: boolean;
	error: string | null;

	// Filters
	templateCategory: TemplateCategory;
	setTemplateCategory: (cat: TemplateCategory) => void;
	searchQuery: string;
	setSearchQuery: (q: string) => void;

	// Editor
	editingHook: Hook | null;
	setEditingHook: (hook: Hook | null) => void;

	// Selected hook for detail view
	selectedHookId: string | null;
	setSelectedHookId: (id: string | null) => void;

	// CRUD
	fetchHooks: () => Promise<void>;
	fetchTemplates: () => Promise<void>;
	fetchExecutions: (hookId?: string) => Promise<void>;
	fetchStats: () => Promise<void>;
	createHook: (hook: Partial<Hook>) => Promise<Hook | null>;
	updateHook: (id: string, data: Partial<Hook>) => Promise<Hook | null>;
	deleteHook: (id: string) => Promise<boolean>;
	toggleHook: (id: string) => Promise<void>;
	duplicateHook: (id: string) => Promise<void>;
	createFromTemplate: (
		templateId: string,
		projectId?: string,
	) => Promise<Hook | null>;
	emitEvent: (
		type: TriggerType,
		data?: Record<string, unknown>,
		projectId?: string,
	) => Promise<void>;

	// Editor helpers
	openEditor: (hook?: Hook) => void;
	closeEditor: () => void;
	saveEditorHook: () => Promise<void>;
	addTriggerToEditor: (type: TriggerType) => void;
	addActionToEditor: (type: ActionType) => void;
	removeTriggerFromEditor: (triggerId: string) => void;
	removeActionFromEditor: (actionId: string) => void;
	addConnectionToEditor: (conn: HookConnection) => void;
	removeConnectionFromEditor: (sourceId: string, targetId: string) => void;
	updateNodePosition: (
		nodeId: string,
		position: { x: number; y: number },
	) => void;
}

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useHooksStore = create<HooksState>((set, get) => ({
	// Dialog
	isOpen: false,
	openDialog: () => {
		set({ isOpen: true });
		get().fetchHooks();
		get().fetchTemplates();
		get().fetchStats();
	},
	closeDialog: () => set({ isOpen: false, editingHook: null }),

	// Tab
	activeTab: "hooks",
	setActiveTab: (tab) => {
		set({ activeTab: tab });
		if (tab === "history") get().fetchExecutions();
	},

	// Data
	hooks: [],
	templates: [],
	executions: [],
	stats: null,
	loading: false,
	error: null,

	// Filters
	templateCategory: "all",
	setTemplateCategory: (cat) => set({ templateCategory: cat }),
	searchQuery: "",
	setSearchQuery: (q) => set({ searchQuery: q }),

	// Editor
	editingHook: null,
	setEditingHook: (hook) => set({ editingHook: hook }),
	selectedHookId: null,
	setSelectedHookId: (id) => set({ selectedHookId: id }),

	// ── CRUD ─────────────────────────────────────────────────────────────

	fetchHooks: async () => {
		set({ loading: true, error: null });
		try {
			const res = await api<{ success: boolean; hooks: Hook[] }>("/api/hooks");
			if (res.success) set({ hooks: res.hooks });
		} catch (e) {
			set({ error: String(e) });
		} finally {
			set({ loading: false });
		}
	},

	fetchTemplates: async () => {
		try {
			const res = await api<{ success: boolean; templates: HookTemplate[] }>(
				"/api/hooks/templates",
			);
			if (res.success) set({ templates: res.templates });
		} catch {
			// silent
		}
	},

	fetchExecutions: async (hookId) => {
		try {
			const qs = hookId ? `?hook_id=${hookId}` : "";
			const res = await api<{ success: boolean; executions: HookExecution[] }>(
				`/api/hooks/executions/history${qs}`,
			);
			if (res.success) set({ executions: res.executions });
		} catch {
			// silent
		}
	},

	fetchStats: async () => {
		try {
			const res = await api<{ success: boolean; stats: HookStats }>(
				"/api/hooks/stats",
			);
			if (res.success) set({ stats: res.stats });
		} catch {
			// silent
		}
	},

	createHook: async (data) => {
		try {
			const res = await api<{ success: boolean; hook: Hook }>("/api/hooks", {
				method: "POST",
				body: JSON.stringify(data),
			});
			if (res.success) {
				await get().fetchHooks();
				await get().fetchStats();
				return res.hook;
			}
		} catch {
			// silent
		}
		return null;
	},

	updateHook: async (id, data) => {
		try {
			const res = await api<{ success: boolean; hook: Hook }>(
				`/api/hooks/${id}`,
				{
					method: "PUT",
					body: JSON.stringify(data),
				},
			);
			if (res.success) {
				await get().fetchHooks();
				return res.hook;
			}
		} catch {
			// silent
		}
		return null;
	},

	deleteHook: async (id) => {
		try {
			const res = await api<{ success: boolean }>(`/api/hooks/${id}`, {
				method: "DELETE",
			});
			if (res.success) {
				await get().fetchHooks();
				await get().fetchStats();
				return true;
			}
		} catch {
			// silent
		}
		return false;
	},

	toggleHook: async (id) => {
		try {
			const res = await api<{ success: boolean; hook: Hook }>(
				`/api/hooks/${id}/toggle`,
				{ method: "POST" },
			);
			if (res.success) {
				set((s) => ({
					hooks: s.hooks.map((h) => (h.id === id ? res.hook : h)),
				}));
				await get().fetchStats();
			}
		} catch {
			// silent
		}
	},

	duplicateHook: async (id) => {
		try {
			await api<{ success: boolean; hook: Hook }>(
				`/api/hooks/${id}/duplicate`,
				{ method: "POST" },
			);
			await get().fetchHooks();
			await get().fetchStats();
		} catch {
			// silent
		}
	},

	createFromTemplate: async (templateId, projectId) => {
		try {
			const res = await api<{ success: boolean; hook: Hook }>(
				"/api/hooks/from-template",
				{
					method: "POST",
					body: JSON.stringify({
						template_id: templateId,
						project_id: projectId,
					}),
				},
			);
			if (res.success) {
				await get().fetchHooks();
				await get().fetchStats();
				return res.hook;
			}
		} catch {
			// silent
		}
		return null;
	},

	emitEvent: async (type, data, projectId) => {
		try {
			await api("/api/hooks/emit", {
				method: "POST",
				body: JSON.stringify({ type, data: data || {}, project_id: projectId }),
			});
			await get().fetchExecutions();
			await get().fetchStats();
		} catch {
			// silent
		}
	},

	// ── Visual editor ────────────────────────────────────────────────────

	openEditor: (hook) => {
		const newHook: Hook = hook || {
			id: "",
			name: "",
			description: "",
			project_id: null,
			cross_project: false,
			status: "active",
			triggers: [],
			actions: [],
			connections: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			last_triggered: null,
			execution_count: 0,
			error_count: 0,
			template_id: null,
			tags: [],
		};
		set({ editingHook: newHook, activeTab: "editor" });
	},

	closeEditor: () => set({ editingHook: null, activeTab: "hooks" }),

	saveEditorHook: async () => {
		const hook = get().editingHook;
		if (!hook) return;
		if (hook.id) {
			await get().updateHook(hook.id, hook);
		} else {
			await get().createHook(hook);
		}
		set({ editingHook: null, activeTab: "hooks" });
	},

	addTriggerToEditor: (type) => {
		const hook = get().editingHook;
		if (!hook) return;
		const yOffset = hook.triggers.length * 120;
		const trigger: Trigger = {
			id: generateId(),
			type,
			conditions: [],
			config: {},
			position: { x: 50, y: 100 + yOffset },
		};
		set({ editingHook: { ...hook, triggers: [...hook.triggers, trigger] } });
	},

	addActionToEditor: (type) => {
		const hook = get().editingHook;
		if (!hook) return;
		const yOffset = hook.actions.length * 120;
		const action: Action = {
			id: generateId(),
			type,
			config: {},
			delay_ms: 0,
			max_retries: 0,
			retry_delay_ms: 1000,
			timeout_ms: 30000,
			position: { x: 400, y: 100 + yOffset },
		};
		set({ editingHook: { ...hook, actions: [...hook.actions, action] } });
	},

	removeTriggerFromEditor: (triggerId) => {
		const hook = get().editingHook;
		if (!hook) return;
		set({
			editingHook: {
				...hook,
				triggers: hook.triggers.filter((t) => t.id !== triggerId),
				connections: hook.connections.filter(
					(c) => c.source_id !== triggerId && c.target_id !== triggerId,
				),
			},
		});
	},

	removeActionFromEditor: (actionId) => {
		const hook = get().editingHook;
		if (!hook) return;
		set({
			editingHook: {
				...hook,
				actions: hook.actions.filter((a) => a.id !== actionId),
				connections: hook.connections.filter(
					(c) => c.source_id !== actionId && c.target_id !== actionId,
				),
			},
		});
	},

	addConnectionToEditor: (conn) => {
		const hook = get().editingHook;
		if (!hook) return;
		const exists = hook.connections.some(
			(c) => c.source_id === conn.source_id && c.target_id === conn.target_id,
		);
		if (!exists) {
			set({
				editingHook: { ...hook, connections: [...hook.connections, conn] },
			});
		}
	},

	removeConnectionFromEditor: (sourceId, targetId) => {
		const hook = get().editingHook;
		if (!hook) return;
		set({
			editingHook: {
				...hook,
				connections: hook.connections.filter(
					(c) => !(c.source_id === sourceId && c.target_id === targetId),
				),
			},
		});
	},

	updateNodePosition: (nodeId, position) => {
		const hook = get().editingHook;
		if (!hook) return;
		const triggers = hook.triggers.map((t) =>
			t.id === nodeId ? { ...t, position } : t,
		);
		const actions = hook.actions.map((a) =>
			a.id === nodeId ? { ...a, position } : a,
		);
		set({ editingHook: { ...hook, triggers, actions } });
	},
}));
