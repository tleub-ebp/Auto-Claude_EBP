import { Play, Wifi, WifiOff } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC_CHANNELS } from "../../shared/constants";
import type { ElectronAPI, Task } from "../../shared/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";

// Extend global interface for electronAPI
declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}

interface StreamingTestProps {
	readonly tasks: Task[];
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly onTaskStart?: (taskId: string, options?: any) => void;
}

export function StreamingTest({ tasks, onTaskStart }: StreamingTestProps) {
	const { t } = useTranslation(["streaming", "common"]);
	const [isStreamingServerRunning, setIsStreamingServerRunning] =
		useState(false);
	const [sessionId, setSessionId] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState("");
	const [isConnected, setIsConnected] = useState(false);

	// Check if streaming server is running
	const checkStreamingServer = async (signal?: AbortSignal) => {
		try {
			const response = await fetch("http://localhost:8765/health", { signal });
			setIsStreamingServerRunning(response.ok);
		} catch (error) {
			if ((error as { name?: string })?.name === "AbortError") return;
			console.error("Failed to check streaming server health:", error);
			setIsStreamingServerRunning(false);
		}
	};

	// Start streaming server
	const startStreamingServer = async () => {
		try {
			await globalThis.electronAPI.invoke("streaming-server-start", {
				port: 8765,
			});
			setIsStreamingServerRunning(true);
		} catch (error) {
			console.error("Failed to start streaming server:", error);
		}
	};

	// Generate a unique session ID using cryptographically secure randomness
	const generateSessionId = () => {
		const id = `session-${Date.now()}-${crypto.randomUUID().slice(0, 9)}`;
		setSessionId(id);
		return id;
	};

	// Start task with streaming
	const startTaskWithStreaming = () => {
		if (!selectedTaskId) {
			alert(t("streaming:test.pleaseSelectTask"));
			return;
		}

		const streamingSessionId = sessionId || generateSessionId();

		if (onTaskStart) {
			onTaskStart(selectedTaskId, {
				enableStreaming: true,
				streamingSessionId: streamingSessionId,
			});
		} else {
			// Fallback: direct IPC call
			globalThis.electronAPI.invoke(IPC_CHANNELS.TASK_START, selectedTaskId, {
				enableStreaming: true,
				streamingSessionId: streamingSessionId,
			});
		}
	};

	// Check connection status
	const checkConnection = async () => {
		if (!sessionId) return;

		try {
			const ws = new WebSocket(`ws://localhost:8765/stream/${sessionId}`);
			ws.onopen = () => {
				setIsConnected(true);
				ws.close();
			};
			ws.onerror = () => {
				setIsConnected(false);
			};
		} catch (error) {
			console.error("Failed to establish WebSocket connection:", error);
			setIsConnected(false);
		}
	};

	React.useEffect(() => {
		const controller = new AbortController();
		checkStreamingServer(controller.signal);
		const interval = setInterval(
			() => checkStreamingServer(controller.signal),
			5000,
		);
		return () => {
			clearInterval(interval);
			controller.abort();
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [checkStreamingServer]);

	React.useEffect(() => {
		if (sessionId) {
			checkConnection();
			const interval = setInterval(checkConnection, 3000);
			return () => clearInterval(interval);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [sessionId, checkConnection]);

	const availableTasks = tasks.filter(
		(task) => task.status === "backlog" || task.status === "queue",
	);

	return (
		<Card className="p-6">
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold">{t("streaming:test.title")}</h3>
					<div className="flex items-center gap-2">
						<Badge variant={isStreamingServerRunning ? "default" : "secondary"}>
							{isStreamingServerRunning ? (
								<>
									<Wifi className="w-3 h-3 mr-1" />
									{t("streaming:test.serverRunning")}
								</>
							) : (
								<>
									<WifiOff className="w-3 h-3 mr-1" />
									{t("streaming:test.serverStopped")}
								</>
							)}
						</Badge>
					</div>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="space-y-4">
						<div>
							<label
								htmlFor="session-id"
								className="block text-sm font-medium mb-2"
							>
								{t("streaming:test.sessionId")}
							</label>
							<div className="flex gap-2">
								<Input
									id="session-id"
									value={sessionId}
									onChange={(e) => setSessionId(e.target.value)}
									placeholder={t("streaming:test.sessionIdPlaceholder")}
								/>
								<Button
									variant="outline"
									onClick={generateSessionId}
									disabled={!isStreamingServerRunning}
								>
									{t("streaming:test.generate")}
								</Button>
							</div>
						</div>

						<div>
							<div
								className="block text-sm font-medium mb-2"
								role="status"
								aria-live="polite"
							>
								{t("streaming:test.connectionStatus")}
							</div>
							<Badge variant={isConnected ? "default" : "secondary"}>
								{isConnected
									? t("streaming:test.connected")
									: t("streaming:test.disconnected")}
							</Badge>
						</div>
					</div>

					<div className="space-y-4">
						<div>
							<label
								htmlFor="task-select"
								className="block text-sm font-medium mb-2"
							>
								{t("streaming:test.selectTask")}
							</label>
							<select
								id="task-select"
								value={selectedTaskId}
								onChange={(e) => setSelectedTaskId(e.target.value)}
								className="w-full p-2 border rounded-md"
								disabled={availableTasks.length === 0}
							>
								<option value="">
									{t("streaming:test.selectTaskPlaceholder")}
								</option>
								{availableTasks.map((task) => (
									<option key={task.id} value={task.id}>
										{task.title} ({task.id})
									</option>
								))}
							</select>
						</div>

						<Button
							onClick={startTaskWithStreaming}
							disabled={
								!isStreamingServerRunning || !selectedTaskId || !sessionId
							}
							className="w-full"
						>
							<Play className="w-4 h-4 mr-2" />
							{t("streaming:test.startTaskWithStreaming")}
						</Button>
					</div>
				</div>

				{!isStreamingServerRunning && (
					<div className="text-center py-4">
						<Button onClick={startStreamingServer} variant="outline">
							{t("streaming:test.startStreamingServer")}
						</Button>
					</div>
				)}

				<div className="text-xs text-muted-foreground">
					<p>{t("streaming:test.instructions")}</p>
					<ol className="list-decimal list-inside space-y-1">
						<li>{t("streaming:test.instruction1")}</li>
						<li>{t("streaming:test.instruction2")}</li>
						<li>{t("streaming:test.instruction3")}</li>
						<li>{t("streaming:test.instruction4")}</li>
						<li>{t("streaming:test.instruction5")}</li>
					</ol>
				</div>
			</div>
		</Card>
	);
}
