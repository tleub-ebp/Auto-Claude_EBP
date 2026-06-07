/**
 * Zustand stores for the 12 Phase 3-5 backend feature modules.
 *
 * One slice per feature, all in one file because the features are simple
 * (status + result + error) and sharing the file keeps imports tight.
 */

import { create } from "zustand";
import type {
	AgentHealthScoreData,
	AnomalyReport,
	AnomalySignal,
	AuditEvent,
	DomainAgentBundle,
	DomainProfile,
	DomainSummary,
	DriftReport,
	I18nDict,
	I18nScalingReport,
	LicenseScanReport,
	LocaleDiffData,
	ModelChoice,
	OptimizedContext,
	PairOperation,
	PairRoomSnapshot,
	RegressionReport,
	RouteRequest,
	ArchitectureScanReport,
} from "../../preload/api/modules/phase35-features-api";
import type { LongevityReport } from "../../shared/types/longevity";

type Phase = "idle" | "running" | "ok" | "error";

interface BaseSlice {
	phase: Phase;
	error: string | null;
}

// ---------- helpers ----------

function unwrap<T>(
	res: { success: true } & T,
	fallback?: never,
): T;
function unwrap<_T>(res: { success: false; error: string }): never;
function unwrap<T>(res: { success: boolean; error?: string } & T): T {
	if (!res.success) throw new Error(res.error ?? "Unknown backend error");
	return res;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------- #3.8 Longevity ----------

interface LongevityState extends BaseSlice {
	report: LongevityReport | null;
	compute: (projectPath: string) => Promise<void>;
	reset: () => void;
}

export const useLongevityStore = create<LongevityState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	compute: async (projectPath) => {
		if (!projectPath) {
			set({ phase: "error", error: "projectPath is required" });
			return;
		}
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scoreLongevity(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report ?? null });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	reset: () => set({ phase: "idle", error: null, report: null }),
}));

// ---------- #3.11 Agent Health ----------

interface AgentHealthState extends BaseSlice {
	scores: AgentHealthScoreData[];
	knownAgents: string[];
	refresh: () => Promise<void>;
	resetMonitor: (agentName?: string) => Promise<void>;
}

export const useAgentHealthStore = create<AgentHealthState>((set) => ({
	phase: "idle",
	error: null,
	scores: [],
	knownAgents: [],
	refresh: async () => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scoreAllAgentHealth();
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({
				phase: "ok",
				scores: res.scores,
				knownAgents: res.agents_known,
			});
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	resetMonitor: async (agentName) => {
		await globalThis.electronAPI.resetAgentHealth(agentName);
		set({ scores: [], knownAgents: [] });
	},
}));

// ---------- #3.1 Model Router ----------

interface ModelRouterState extends BaseSlice {
	chosen: ModelChoice | null;
	comparison: Record<string, ModelChoice> | null;
	route: (req: RouteRequest) => Promise<void>;
	compare: (req: RouteRequest) => Promise<void>;
}

export const useModelRouterStore = create<ModelRouterState>((set) => ({
	phase: "idle",
	error: null,
	chosen: null,
	comparison: null,
	route: async (req) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.routeModel(req);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", chosen: res.choice });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	compare: async (req) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.compareModels(req);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", comparison: res.by_tier });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.6 Domain Agents ----------

interface DomainAgentsState extends BaseSlice {
	domains: DomainSummary[];
	selectedDomain: string | null;
	profile: DomainProfile | null;
	bundle: DomainAgentBundle | null;
	loadDomains: () => Promise<void>;
	loadProfile: (domain: string) => Promise<void>;
	build: (domain: string, role: string) => Promise<void>;
}

export const useDomainAgentsStore = create<DomainAgentsState>((set) => ({
	phase: "idle",
	error: null,
	domains: [],
	selectedDomain: null,
	profile: null,
	bundle: null,
	loadDomains: async () => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.listDomains();
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", domains: res.domains });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	loadProfile: async (domain) => {
		set({ phase: "running", error: null, selectedDomain: domain });
		try {
			const res = await globalThis.electronAPI.getDomainProfile(domain);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", profile: res.profile });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	build: async (domain, role) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.buildDomainBundle(domain, role);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", bundle: res.bundle });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.4 CICD Anomaly ----------

interface CicdAnomalyState extends BaseSlice {
	signals: AnomalySignal[];
	report: AnomalyReport | null;
	scan: (log: string, label?: string) => Promise<void>;
	analyse: (samples: { label: string; text: string }[]) => Promise<void>;
}

export const useCicdAnomalyStore = create<CicdAnomalyState>((set) => ({
	phase: "idle",
	error: null,
	signals: [],
	report: null,
	scan: async (log, label) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanCicdLog(log, label);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", signals: res.signals });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	analyse: async (samples) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.analyseCicdLogs(samples);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.7 License Governance ----------

interface LicenseState extends BaseSlice {
	report: LicenseScanReport | null;
	scan: (
		projectPath: string,
		policy?: "permissive_only" | "open_source_friendly" | "saas_safe",
	) => Promise<void>;
}

export const useLicenseStore = create<LicenseState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	scan: async (projectPath, policy) => {
		if (!projectPath) {
			set({ phase: "error", error: "projectPath is required" });
			return;
		}
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanLicenses(projectPath, policy);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.9 Architecture Drift ----------

interface ArchDriftState extends BaseSlice {
	scanReport: ArchitectureScanReport | null;
	driftReport: DriftReport | null;
	configSource: string | null;
	scan: (projectPath: string) => Promise<void>;
	saveBaseline: (projectPath: string) => Promise<void>;
	compare: (projectPath: string) => Promise<void>;
}

export const useArchDriftStore = create<ArchDriftState>((set) => ({
	phase: "idle",
	error: null,
	scanReport: null,
	driftReport: null,
	configSource: null,
	scan: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanArchitecture(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", scanReport: res.report, configSource: res.config_source });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	saveBaseline: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.saveArchBaseline(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok" });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	compare: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.compareArchDrift(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", driftReport: res.drift });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.10 Generational Tests ----------

interface GenTestsState extends BaseSlice {
	generations: string[];
	regression: RegressionReport | null;
	listGenerations: (projectPath: string) => Promise<void>;
	capture: (projectPath: string, label: string, junitXml: string) => Promise<void>;
	compare: (projectPath: string, baseline: string, junitXml: string) => Promise<void>;
	deleteGen: (projectPath: string, label: string) => Promise<void>;
}

export const useGenTestsStore = create<GenTestsState>((set, get) => ({
	phase: "idle",
	error: null,
	generations: [],
	regression: null,
	listGenerations: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.listGenerations(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", generations: res.generations });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	capture: async (projectPath, label, junitXml) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.captureGeneration(
				projectPath,
				label,
				junitXml,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			await get().listGenerations(projectPath);
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	compare: async (projectPath, baseline, junitXml) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.compareGeneration(
				projectPath,
				baseline,
				junitXml,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", regression: res.report });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	deleteGen: async (projectPath, label) => {
		await globalThis.electronAPI.deleteGeneration(projectPath, label);
		await get().listGenerations(projectPath);
	},
}));

// ---------- #3.12 i18n Scaler ----------

interface I18nScalerState extends BaseSlice {
	report: I18nScalingReport | null;
	skeleton: I18nDict | null;
	diff: LocaleDiffData | null;
	runReport: (localesDir: string, sourceLocale?: string) => Promise<void>;
}

export const useI18nScalerStore = create<I18nScalerState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	skeleton: null,
	diff: null,
	runReport: async (localesDir, sourceLocale) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.reportI18nFromDir(
				localesDir,
				sourceLocale,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.2 Cognitive Context ----------

interface CogContextState extends BaseSlice {
	context: OptimizedContext | null;
	optimize: (
		prompt: string,
		candidateFiles: string[],
		tokenBudget: number,
	) => Promise<void>;
}

export const useCogContextStore = create<CogContextState>((set) => ({
	phase: "idle",
	error: null,
	context: null,
	optimize: async (prompt, candidateFiles, tokenBudget) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.optimizeContext(
				prompt,
				candidateFiles,
				tokenBudget,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", context: res.context });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.3 Audit Trail ----------

interface AuditTrailState extends BaseSlice {
	events: AuditEvent[];
	replayEvents: AuditEvent[];
	integrity: { is_intact: boolean; events_checked: number; first_broken_sequence: number | null; breakage_reason: string | null } | null;
	loadEvents: (storageDir: string, trailName?: string) => Promise<void>;
	replay: (correlationId: string, storageDir: string, trailName?: string) => Promise<void>;
	verify: (storageDir: string, trailName?: string) => Promise<void>;
}

export const useAuditTrailStore = create<AuditTrailState>((set) => ({
	phase: "idle",
	error: null,
	events: [],
	replayEvents: [],
	integrity: null,
	loadEvents: async (storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditEvents({
				storageDir,
				trailName,
			});
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", events: res.events });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	replay: async (correlationId, storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditReplay(
				correlationId,
				storageDir,
				trailName,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", replayEvents: res.bundle.events });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	verify: async (storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditVerify(storageDir, trailName);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", integrity: res.integrity });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.5 Pair Realtime ----------

interface PairRealtimeState extends BaseSlice {
	currentRoom: PairRoomSnapshot | null;
	ops: PairOperation[];
	subscriptionId: string | null;
	isStreaming: boolean;
	createOrJoin: (
		roomId: string,
		userId: string,
		displayName: string,
		role?: "driver" | "navigator" | "ai",
	) => Promise<void>;
	leave: () => Promise<void>;
	sendChat: (text: string) => Promise<void>;
	sendEdit: (
		filePath: string,
		startLine: number,
		endLine: number,
		newText: string,
	) => Promise<void>;
	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
	_appendOp: (op: PairOperation) => void;
}

export const usePairRealtimeStore = create<PairRealtimeState>((set, get) => ({
	phase: "idle",
	error: null,
	currentRoom: null,
	ops: [],
	subscriptionId: null,
	isStreaming: false,
	createOrJoin: async (roomId, userId, displayName, role) => {
		set({ phase: "running", error: null });
		try {
			// Try create; if it already exists, just join.
			await globalThis.electronAPI.createPairRoom(roomId);
			const joinRes = await globalThis.electronAPI.pairJoin(
				roomId,
				userId,
				displayName,
				role,
			);
			if (!joinRes.success) throw new Error(joinRes.error ?? "join failed");
			const snapRes = await globalThis.electronAPI.getPairRoom(roomId);
			if (!snapRes.success) throw new Error(snapRes.error ?? "snapshot failed");
			set({ phase: "ok", currentRoom: snapRes.room, ops: [] });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	leave: async () => {
		const room = get().currentRoom;
		if (!room) return;
		await get().unsubscribe();
		set({ currentRoom: null, ops: [] });
	},
	sendChat: async (text) => {
		const room = get().currentRoom;
		if (!room) return;
		const me = room.participants[0]?.user_id ?? "anon";
		await globalThis.electronAPI.pairChat(room.room_id, me, text);
	},
	sendEdit: async (filePath, startLine, endLine, newText) => {
		const room = get().currentRoom;
		if (!room) return;
		const me = room.participants[0]?.user_id ?? "anon";
		await globalThis.electronAPI.pairEdit(
			room.room_id,
			me,
			filePath,
			startLine,
			endLine,
			newText,
		);
	},
	subscribe: async () => {
		const room = get().currentRoom;
		if (!room) return;
		const lastSeq = get().ops.length
			? get().ops[get().ops.length - 1].sequence + 1
			: 0;
		const res = await globalThis.electronAPI.subscribePairRoom(
			room.room_id,
			lastSeq,
		);
		if (!res.success) {
			set({ error: res.error ?? "subscribe failed" });
			return;
		}
		set({ subscriptionId: res.subscriptionId, isStreaming: true });
	},
	unsubscribe: async () => {
		const sid = get().subscriptionId;
		if (!sid) return;
		await globalThis.electronAPI.unsubscribePairRoom(sid);
		set({ subscriptionId: null, isStreaming: false });
	},
	_appendOp: (op) => set((s) => ({ ops: [...s.ops, op] })),
}));

// Listener helper to wire the SSE stream into the store.
export function setupPairRealtimeListeners(): () => void {
	const offEvent = globalThis.electronAPI.onPairOpEvent(({ subscriptionId, op }) => {
		const state = usePairRealtimeStore.getState();
		if (state.subscriptionId !== subscriptionId) return;
		state._appendOp(op);
	});
	const offError = globalThis.electronAPI.onPairStreamError(({ subscriptionId, error }) => {
		const state = usePairRealtimeStore.getState();
		if (state.subscriptionId !== subscriptionId) return;
		usePairRealtimeStore.setState({ error, isStreaming: false });
	});
	return () => {
		offEvent();
		offError();
	};
}

// Re-export the helpers some components might want.
export { unwrap, errorMessage };
