import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	FileCode2,
	Loader2,
	Pause,
	Play,
	RefreshCw,
	Timer,
	XCircle,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionEntry {
	session_id: string;
	task_id?: string;
	task_title?: string;
	status: string;
	started_at: string;
	ended_at?: string;
	duration_seconds?: number;
	tokens_used?: number;
	cost?: number;
	files_changed?: number;
	error?: string;
	phases?: SessionPhase[];
}

interface SessionPhase {
	name: string;
	status: string;
	duration_seconds?: number;
	tokens?: number;
}

interface SessionHistoryProps {
	readonly projectId: string;
}

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { readonly status: string }) {
	switch (status.toLowerCase()) {
		case "completed":
		case "success":
			return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
		case "failed":
		case "error":
			return <XCircle className="h-4 w-4 text-red-500" />;
		case "running":
		case "in_progress":
			return <Play className="h-4 w-4 text-blue-500" />;
		case "paused":
			return <Pause className="h-4 w-4 text-amber-500" />;
		default:
			return <Clock className="h-4 w-4 text-muted-foreground" />;
	}
}

// ---------------------------------------------------------------------------
// Duration formatter
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function formatDateTime(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

// ---------------------------------------------------------------------------
// Session card
// ---------------------------------------------------------------------------

function SessionCard({ session }: { readonly session: SessionEntry }) {
	const { t } = useTranslation("sessionHistory");
	const [expanded, setExpanded] = useState(false);

	const statusColor: Record<string, string> = {
		completed: "border-emerald-500/30",
		success: "border-emerald-500/30",
		failed: "border-red-500/30",
		error: "border-red-500/30",
		running: "border-blue-500/30",
		in_progress: "border-blue-500/30",
	};

	return (
		<div
			className={cn(
				"rounded-lg border p-4 transition-colors hover:bg-accent/20",
				statusColor[session.status.toLowerCase()] || "border-border",
			)}
		>
			{/* Header row */}
			<button
				type="button"
				className="w-full flex items-center gap-3 text-left"
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					<ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
				) : (
					<ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
				)}
				<StatusIcon status={session.status} />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium text-foreground truncate">
							{session.task_title || session.task_id || session.session_id}
						</span>
						<Badge variant="outline" className="text-[10px] capitalize">
							{session.status}
						</Badge>
					</div>
					<div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
						<span>{formatDateTime(session.started_at)}</span>
						{session.duration_seconds !== undefined && (
							<span className="flex items-center gap-1">
								<Timer className="h-3 w-3" />
								{formatDuration(session.duration_seconds)}
							</span>
						)}
						{session.tokens_used !== undefined && (
							<span className="flex items-center gap-1">
								<Zap className="h-3 w-3" />
								{session.tokens_used.toLocaleString()} tokens
							</span>
						)}
						{session.files_changed !== undefined && (
							<span className="flex items-center gap-1">
								<FileCode2 className="h-3 w-3" />
								{session.files_changed} files
							</span>
						)}
						{session.cost !== undefined && (
							<span>${session.cost.toFixed(4)}</span>
						)}
					</div>
				</div>
			</button>

			{/* Expanded details */}
			{expanded && (
				<div className="mt-3 pl-9 space-y-3">
					{session.error && (
						<div className="rounded-md bg-red-500/10 p-3 text-xs text-red-500">
							<span className="font-medium">{t("error")}: </span>
							{session.error}
						</div>
					)}

					{session.phases && session.phases.length > 0 && (
						<div className="space-y-1.5">
							<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
								{t("phases")}
							</p>
							{session.phases.map((phase) => (
								<div
									key={`${session.session_id}-${phase.name}`}
									className="flex items-center gap-2 text-xs"
								>
									<StatusIcon status={phase.status} />
									<span className="text-foreground capitalize flex-1">
										{phase.name}
									</span>
									{phase.duration_seconds !== undefined && (
										<span className="text-muted-foreground">
											{formatDuration(phase.duration_seconds)}
										</span>
									)}
									{phase.tokens !== undefined && (
										<span className="text-muted-foreground font-mono">
											{phase.tokens.toLocaleString()} tok
										</span>
									)}
								</div>
							))}
						</div>
					)}

					<div className="flex gap-4 text-xs text-muted-foreground">
						<span>
							{t("session.session")}:{" "}
							<span className="font-mono text-foreground">
								{session.session_id}
							</span>
						</span>
						{session.ended_at && (
							<span>
								{t("session.ended")}: {formatDateTime(session.ended_at)}
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SessionHistory({ projectId }: SessionHistoryProps) {
	const { t } = useTranslation("sessionHistory");
	const [sessions, setSessions] = useState<SessionEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<
		"all" | "completed" | "failed" | "running"
	>("all");

	const fetchSessions = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			try {
				const backendUrl = import.meta.env?.VITE_BACKEND_URL || "";
				const res = await fetch(
					`${backendUrl}/api/sessions/${projectId}`,
					{ signal },
				);
				const data = await res.json();
				if (data.success) {
					setSessions(data.sessions || []);
				} else {
					setError(data.error || "Failed to load sessions");
				}
			} catch (e) {
				if ((e as { name?: string })?.name === "AbortError") return;
				setError(e instanceof Error ? e.message : "Network error");
			} finally {
				setLoading(false);
			}
		},
		[projectId],
	);

	useEffect(() => {
		const controller = new AbortController();
		fetchSessions(controller.signal);
		return () => controller.abort();
	}, [fetchSessions]);

	const filtered = sessions.filter((s) => {
		if (filter === "all") return true;
		const status = s.status.toLowerCase();
		if (filter === "completed")
			return status === "completed" || status === "success";
		if (filter === "failed") return status === "failed" || status === "error";
		if (filter === "running")
			return status === "running" || status === "in_progress";
		return true;
	});

	const stats = {
		total: sessions.length,
		completed: sessions.filter((s) =>
			["completed", "success"].includes(s.status.toLowerCase()),
		).length,
		failed: sessions.filter((s) =>
			["failed", "error"].includes(s.status.toLowerCase()),
		).length,
		running: sessions.filter((s) =>
			["running", "in_progress"].includes(s.status.toLowerCase()),
		).length,
		totalTokens: sessions.reduce((sum, s) => sum + (s.tokens_used || 0), 0),
		totalCost: sessions.reduce((sum, s) => sum + (s.cost || 0), 0),
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-6 space-y-6 max-w-5xl mx-auto">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<Clock className="h-6 w-6 text-primary" />
						<div>
							<h1 className="text-xl font-bold text-foreground">
								{t("title")}
							</h1>
							<p className="text-sm text-muted-foreground">{t("subtitle")}</p>
						</div>
					</div>
					<Button variant="outline" size="sm" onClick={() => fetchSessions()}>
						<RefreshCw className="h-3.5 w-3.5 mr-2" />
						{t("refresh")}
					</Button>
				</div>

				{/* Stats */}
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<Card>
						<CardContent className="p-3 text-center">
							<p className="text-lg font-bold text-foreground">{stats.total}</p>
							<p className="text-xs text-muted-foreground">
								{t("stats.total")}
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="p-3 text-center">
							<p className="text-lg font-bold text-emerald-500">
								{stats.completed}
							</p>
							<p className="text-xs text-muted-foreground">
								{t("stats.completed")}
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="p-3 text-center">
							<p className="text-lg font-bold text-red-500">{stats.failed}</p>
							<p className="text-xs text-muted-foreground">
								{t("stats.failed")}
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="p-3 text-center">
							<p className="text-lg font-bold text-foreground">
								{stats.totalTokens.toLocaleString()}
							</p>
							<p className="text-xs text-muted-foreground">
								{t("stats.tokens")}
							</p>
						</CardContent>
					</Card>
				</div>

				{/* Filter tabs */}
				<div className="flex gap-2">
					{(["all", "completed", "failed", "running"] as const).map((f) => {
						const getFilterCount = () => {
							switch (f) {
								case "all":
									return stats.total;
								case "completed":
									return stats.completed;
								case "failed":
									return stats.failed;
								case "running":
									return stats.running;
								default:
									return 0;
							}
						};

						return (
							<Button
								key={f}
								variant={filter === f ? "default" : "outline"}
								size="sm"
								onClick={() => setFilter(f)}
								className="capitalize"
							>
								{t(`filters.${f}`)} ({getFilterCount()})
							</Button>
						);
					})}
				</div>

				{/* Error */}
				{error && (
					<Card className="border-red-500/30">
						<CardContent className="p-4 flex items-center gap-3 text-red-500">
							<AlertTriangle className="h-5 w-5 shrink-0" />
							<p className="text-sm">{error}</p>
						</CardContent>
					</Card>
				)}

				{/* Sessions list */}
				{filtered.length === 0 ? (
					<div className="text-center py-12 text-muted-foreground">
						<Clock className="h-8 w-8 mx-auto mb-3 opacity-50" />
						<p className="text-sm">{t("noSessions")}</p>
					</div>
				) : (
					<div className="space-y-2">
						{filtered.map((session) => (
							<SessionCard key={session.session_id} session={session} />
						))}
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
