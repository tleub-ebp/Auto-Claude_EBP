/**
 * Cost Estimator IPC Handlers
 *
 * Reads/writes {projectPath}/.workpilot/cost_data.json directly in Node.js
 * to expose cost summary and budget info to the renderer without needing a
 * Python HTTP server.
 */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { logger } from "../app-logger";

// ---------------------------------------------------------------------------
// Load all configured provider IDs from configured_providers.json
// so we can show $0 entries for providers with no usage.
// ---------------------------------------------------------------------------

function loadConfiguredProviderIds(): string[] {
	// configured_providers.json is at the repo root.
	// app.getAppPath() can point to different directories depending on dev vs packaged mode,
	// so we try multiple candidates including process.cwd() for dev mode.
	const appPath = app.getAppPath();
	const cwd = process.cwd();
	const candidates = [
		// Dev mode: process.cwd() is typically apps/frontend
		path.join(cwd, "..", "..", "config", "configured_providers.json"),
		path.join(cwd, "..", "config", "configured_providers.json"),
		path.join(cwd, "config", "configured_providers.json"),
		// app.getAppPath()-based (works in various electron-vite configurations)
		path.join(appPath, "..", "..", "..", "config", "configured_providers.json"),
		path.join(appPath, "..", "..", "config", "configured_providers.json"),
		path.join(appPath, "..", "config", "configured_providers.json"),
		path.join(appPath, "config", "configured_providers.json"),
		// Fallback: src dir
		path.join(appPath, "src", "config", "configured_providers.json"),
	];
	for (const p of candidates) {
		try {
			if (!fs.existsSync(p)) continue;
			const raw = fs.readFileSync(p, "utf-8");
			const parsed = JSON.parse(raw) as {
				providers?: { id?: string; name?: string }[];
			};
			const ids = (parsed.providers ?? [])
				.map((pv) => pv.id ?? pv.name ?? "")
				.filter(Boolean);
			if (ids.length > 0) return ids;
		} catch {
			// try next
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// File watchers — push COSTS_DATA_UPDATED when cost_data.json changes
// ---------------------------------------------------------------------------

const _watchers = new Map<string, fs.FSWatcher>();
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function watchCostData(projectPath: string): void {
	if (_watchers.has(projectPath)) return;

	const filePath = getCostDataPath(projectPath);
	if (!fs.existsSync(filePath)) return;

	try {
		const watcher = fs.watch(filePath, { persistent: false }, () => {
			// Debounce: coalesce rapid events (e.g. atomic rename fires twice on Windows)
			const existing = _debounceTimers.get(projectPath);
			if (existing) clearTimeout(existing);
			_debounceTimers.set(
				projectPath,
				setTimeout(() => {
					_debounceTimers.delete(projectPath);
					for (const win of BrowserWindow.getAllWindows()) {
						if (!win.isDestroyed()) {
							win.webContents.send(
								IPC_CHANNELS.COSTS_DATA_UPDATED,
								projectPath,
							);
						}
					}
				}, 400),
			);
		});

		watcher.on("error", () => {
			watcher.close();
			_watchers.delete(projectPath);
		});

		_watchers.set(projectPath, watcher);
	} catch {
		// Silently ignore — watcher is best-effort
	}
}

// ---------------------------------------------------------------------------
// File watchers — push DASHBOARD_SNAPSHOT_UPDATED when dashboard_snapshot.json changes
// ---------------------------------------------------------------------------

const _snapshotWatchers = new Map<string, fs.FSWatcher>();
const _snapshotDebounceTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();

function watchDashboardSnapshot(projectPath: string): void {
	if (_snapshotWatchers.has(projectPath)) return;

	const filePath = path.join(
		projectPath,
		".workpilot",
		"dashboard_snapshot.json",
	);
	if (!fs.existsSync(filePath)) return;

	try {
		const watcher = fs.watch(filePath, { persistent: false }, () => {
			const existing = _snapshotDebounceTimers.get(projectPath);
			if (existing) clearTimeout(existing);
			_snapshotDebounceTimers.set(
				projectPath,
				setTimeout(() => {
					_snapshotDebounceTimers.delete(projectPath);
					for (const win of BrowserWindow.getAllWindows()) {
						if (!win.isDestroyed()) {
							win.webContents.send(
								IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED,
								projectPath,
							);
						}
					}
				}, 400),
			);
		});

		watcher.on("error", () => {
			watcher.close();
			_snapshotWatchers.delete(projectPath);
		});

		_snapshotWatchers.set(projectPath, watcher);
	} catch {
		// Silently ignore — watcher is best-effort
	}
}

// ---------------------------------------------------------------------------
// JSON file shape (mirrors Python CostEstimator.save_to_file)
// ---------------------------------------------------------------------------

interface RawUsage {
	project_id: string;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cost: number;
	task_id: string;
	agent_type: string;
	phase: string;
	spec_id: string;
	timestamp: string;
}

interface RawBudget {
	project_id: string;
	limit: number;
	currency: string;
	warning_threshold: number;
	critical_threshold: number;
	period: string;
}

interface CostDataFile {
	usages: RawUsage[];
	budgets: Record<string, RawBudget>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCostDataPath(projectPath: string): string {
	return path.join(projectPath, ".workpilot", "cost_data.json");
}

function loadCostData(projectPath: string): CostDataFile {
	const filePath = getCostDataPath(projectPath);
	if (!fs.existsSync(filePath)) {
		return { usages: [], budgets: {} };
	}
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as CostDataFile;
	} catch (err) {
		logger.warn("[costs] Failed to parse cost_data.json", err);
		return { usages: [], budgets: {} };
	}
}

function saveCostData(projectPath: string, data: CostDataFile): void {
	const filePath = getCostDataPath(projectPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getPeriodStart(period: string): Date | null {
	const now = new Date();
	if (period === "monthly") {
		return new Date(now.getFullYear(), now.getMonth(), 1);
	}
	if (period === "weekly") {
		const start = new Date(now);
		start.setDate(now.getDate() - now.getDay());
		start.setHours(0, 0, 0, 0);
		return start;
	}
	return null; // 'total' — no filter
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerCostHandlers(): void {
	/**
	 * costs:getSummary — returns cost summary for the last 30 days
	 */
	ipcMain.handle("costs:getSummary", async (_, projectPath: string) => {
		try {
			watchCostData(projectPath); // Start watching on first access
			const data = loadCostData(projectPath);
			const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
			const since60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

			const recent = data.usages.filter(
				(u) => new Date(u.timestamp) >= since30,
			);
			const previous = data.usages.filter(
				(u) =>
					new Date(u.timestamp) >= since60 && new Date(u.timestamp) < since30,
			);

			const totalCost = recent.reduce((s, u) => s + u.cost, 0);
			const prevCost = previous.reduce((s, u) => s + u.cost, 0);
			const tokensInput = recent.reduce((s, u) => s + u.input_tokens, 0);
			const tokensOutput = recent.reduce((s, u) => s + u.output_tokens, 0);

			const byProvider: Record<string, number> = {};
			const byModel: Record<string, number> = {};
			for (const u of recent) {
				byProvider[u.provider] = (byProvider[u.provider] ?? 0) + u.cost;
				const modelKey = `${u.provider}/${u.model}`;
				byModel[modelKey] = (byModel[modelKey] ?? 0) + u.cost;
			}

			// Add all configured providers with $0 if they have no usage yet
			for (const pid of loadConfiguredProviderIds()) {
				if (!(pid in byProvider)) byProvider[pid] = 0;
			}

			// Compute actual span of data in the window (more accurate than a hardcoded 30)
			let periodDays = 30;
			if (recent.length > 0) {
				const timestamps = recent.map((u) => new Date(u.timestamp).getTime());
				const oldest = Math.min(...timestamps);
				const newest = Math.max(...timestamps);
				const spanDays =
					Math.ceil((newest - oldest) / (24 * 60 * 60 * 1000)) + 1;
				periodDays = Math.max(1, Math.min(30, spanDays));
			}
			const dailyAvg = totalCost / periodDays;
			const trendPct =
				prevCost > 0 ? ((totalCost - prevCost) / prevCost) * 100 : 0;

			return {
				success: true,
				summary: {
					total_cost: totalCost,
					cost_by_provider: byProvider,
					cost_by_model: byModel,
					total_tokens: tokensInput + tokensOutput,
					tokens_input: tokensInput,
					tokens_output: tokensOutput,
					period_days: periodDays,
					daily_avg: dailyAvg,
					trend_pct: trendPct,
				},
			};
		} catch (err) {
			logger.error("[costs] getSummary failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * costs:getContextUsage — retourne le remplissage de fenêtre de contexte de
	 * la dernière requête d'un provider (proxy de la « session courante »).
	 *
	 * `contextTokens` = input_tokens du dernier enregistrement (les tokens
	 * effectivement envoyés au modèle = remplissage du contexte au dernier tour).
	 * Sert à afficher un « % de contexte consommé » façon Claude Code.
	 */
	ipcMain.handle(
		"costs:getContextUsage",
		async (_, projectPath: string, provider: string) => {
			try {
				watchCostData(projectPath);
				const data = loadCostData(projectPath);

				let latest: RawUsage | null = null;
				for (const u of data.usages) {
					if (u.provider !== provider) continue;
					if (
						latest === null ||
						new Date(u.timestamp) > new Date(latest.timestamp)
					) {
						latest = u;
					}
				}

				if (!latest) {
					return { success: true, contextUsage: null };
				}

				return {
					success: true,
					contextUsage: {
						provider: latest.provider,
						model: latest.model,
						contextTokens: latest.input_tokens,
						outputTokens: latest.output_tokens,
						timestamp: latest.timestamp,
					},
				};
			} catch (err) {
				logger.error("[costs] getContextUsage failed", err);
				return { success: false, error: String(err) };
			}
		},
	);

	/**
	 * costs:getBudget — returns budget info for the current period
	 */
	ipcMain.handle("costs:getBudget", async (_, projectPath: string) => {
		try {
			const data = loadCostData(projectPath);
			// Use project path as key (same convention as Python CostEstimator)
			const budget = data.budgets[projectPath];
			if (!budget) {
				return { success: false, error: "No budget configured" };
			}

			const periodStart = getPeriodStart(budget.period);
			const relevant = periodStart
				? data.usages.filter((u) => new Date(u.timestamp) >= periodStart)
				: data.usages;

			const spent = relevant.reduce((s, u) => s + u.cost, 0);
			const remaining = Math.max(0, budget.limit - spent);
			const utilizationPct =
				budget.limit > 0 ? (spent / budget.limit) * 100 : 0;

			// Forecast end-of-month
			let forecastEndOfMonth = 0;
			if (budget.period === "monthly") {
				const now = new Date();
				const daysInMonth = new Date(
					now.getFullYear(),
					now.getMonth() + 1,
					0,
				).getDate();
				const dayOfMonth = now.getDate();
				forecastEndOfMonth =
					dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0;
			}

			// Build alert messages
			const alerts: string[] = [];
			const pct = utilizationPct / 100;
			if (pct >= 1) {
				alerts.push(
					`Budget dépassé ! Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)}`,
				);
			} else if (pct >= budget.critical_threshold) {
				alerts.push(
					`Critique : proche du plafond. Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)} (${utilizationPct.toFixed(0)}%)`,
				);
			} else if (pct >= budget.warning_threshold) {
				alerts.push(
					`Attention : utilisation élevée. Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)} (${utilizationPct.toFixed(0)}%)`,
				);
			}

			return {
				success: true,
				budget: {
					monthly_budget: budget.limit,
					spent_this_month: spent,
					remaining,
					utilization_pct: utilizationPct,
					alerts,
					forecast_end_of_month: forecastEndOfMonth,
				},
			};
		} catch (err) {
			logger.error("[costs] getBudget failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * dashboard:getSnapshot — reads {projectPath}/.workpilot/dashboard_snapshot.json
	 */
	ipcMain.handle("dashboard:getSnapshot", async (_, projectPath: string) => {
		try {
			watchDashboardSnapshot(projectPath); // Start watching on first access
			const snapPath = path.join(
				projectPath,
				".workpilot",
				"dashboard_snapshot.json",
			);
			if (!fs.existsSync(snapPath)) {
				return {
					success: true,
					snapshot: {
						tasks_by_status: {},
						avg_completion_by_complexity: {},
						qa_first_pass_rate: 0,
						qa_avg_score: 0,
						total_tokens: 0,
						tokens_by_provider: {},
						total_cost: 0,
						cost_by_model: {},
						merge_auto_count: 0,
						merge_manual_count: 0,
					},
				};
			}
			const raw = fs.readFileSync(snapPath, "utf-8");
			const snap = JSON.parse(raw);

			// avg_completion_by_complexity may store arrays (list of durations) — convert to means
			const avgCompletion: Record<string, number> = {};
			for (const [complexity, val] of Object.entries(
				snap.avg_completion_by_complexity || {},
			)) {
				if (Array.isArray(val)) {
					const arr = val as number[];
					avgCompletion[complexity] =
						arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
				} else {
					avgCompletion[complexity] = val as number;
				}
			}

			return {
				success: true,
				snapshot: {
					tasks_by_status: snap.tasks_by_status || {},
					avg_completion_by_complexity: avgCompletion,
					qa_first_pass_rate: snap.qa_first_pass_rate || 0,
					qa_avg_score: snap.qa_avg_score || 0,
					total_tokens: snap.total_tokens || 0,
					tokens_by_provider: snap.tokens_by_provider || {},
					total_cost: snap.total_cost || 0,
					cost_by_model: snap.cost_by_model || {},
					merge_auto_count: snap.merge_auto_count || 0,
					merge_manual_count: snap.merge_manual_count || 0,
				},
			};
		} catch (err) {
			logger.error("[dashboard] getSnapshot failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * costs:setBudget — create/update budget for a project
	 */
	ipcMain.handle(
		"costs:setBudget",
		async (
			_,
			projectPath: string,
			limit: number,
			period: string = "monthly",
		) => {
			try {
				const data = loadCostData(projectPath);
				data.budgets[projectPath] = {
					project_id: projectPath,
					limit,
					currency: "USD",
					warning_threshold: 0.75,
					critical_threshold: 0.9,
					period,
				};
				saveCostData(projectPath, data);
				return { success: true };
			} catch (err) {
				logger.error("[costs] setBudget failed", err);
				return { success: false, error: String(err) };
			}
		},
	);
}
