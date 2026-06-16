/**
 * Streaming Session Component - "Twitch-style" real-time coding view
 *
 * Features:
 * - Real-time code changes display
 * - Live chat with Claude
 * - Ability to pause/intervene in the session
 * - Session recording and replay
 * - Timeline scrubbing
 */

import {
	Clock,
	Code2,
	Download,
	Film,
	MessageSquare,
	Pause,
	Play,
	RefreshCw,
	Share2,
	Square,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Progress } from "../ui/progress";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface StreamingEvent {
	event_type: string;
	timestamp: number;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	data: Record<string, any>;
	session_id: string;
}

interface StreamingSessionProps {
	readonly sessionId: string;
	readonly projectPath: string;
	readonly onClose?: () => void;
}

export function StreamingSession({
	sessionId,
	projectPath,
	onClose,
}: StreamingSessionProps) {
	const { t } = useTranslation(["streaming"]);
	const [isConnected, setIsConnected] = useState(false);
	const [isPaused, setIsPaused] = useState(false);
	const [events, setEvents] = useState<StreamingEvent[]>([]);
	const [chatMessages, setChatMessages] = useState<
		Array<{
			author: string;
			message: string;
			timestamp: number;
			author_type: "user" | "agent";
		}>
	>([]);
	const [currentCode, setCurrentCode] = useState<string>("");
	const [currentFile, setCurrentFile] = useState<string>("");
	const [changedFiles, setChangedFiles] = useState<
		Array<{ path: string; operation: string; content?: string }>
	>([]);
	const [sessionStats, setSessionStats] = useState({
		duration: 0,
		filesChanged: 0,
		linesAdded: 0,
		commandsRun: 0,
		testsRun: 0,
	});
	const [progress, setProgress] = useState(0);
	const [currentStatus, setCurrentStatus] = useState("");
	const [chatInput, setChatInput] = useState("");
	const [retryCount, setRetryCount] = useState(0);
	const [isRetrying, setIsRetrying] = useState(false);
	const [selectedEvent, setSelectedEvent] = useState<StreamingEvent | null>(
		null,
	);

	const wsRef = useRef<WebSocket | null>(null);
	const chatScrollRef = useRef<HTMLDivElement>(null);
	const eventScrollRef = useRef<HTMLDivElement>(null);
	const startTimeRef = useRef<number>(Date.now());
	const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
	const isMountedRef = useRef(true);

	const MAX_AUTO_RETRIES = 5;
	const RETRY_DELAY_MS = 3000;

	// Handle event selection
	const handleEventSelect = useCallback((event: StreamingEvent) => {
		setSelectedEvent(event);
	}, []);

	// Format event content for display
	const formatEventContent = useCallback((event: StreamingEvent): string => {
		const { event_type, data, timestamp } = event;

		let content = `Event Type: ${event_type}\n`;
		content += `Timestamp: ${new Date(timestamp * 1000).toLocaleString()}\n\n`;
		content += `Data:\n${JSON.stringify(data, null, 2)}`;

		return content;
	}, []);

	// Handle streaming events - defined before connectWebSocket since it's referenced in ws.onmessage
	const handleStreamingEvent = useCallback(
		(event: StreamingEvent) => {
			setEvents((prev) => [...prev, event]);

			switch (event.event_type) {
				case "session_start":
					setCurrentStatus(t("streaming:status.sessionStarted"));
					break;

				case "session_confirmed":
					setCurrentStatus(t("streaming:status.sessionConfirmed"));
					break;

				case "code_change":
				case "file_update":
				case "file_create":
				case "file_delete":
				case "file_operation": {
					const filePath = event.data.file_path;
					if (event.data.content) {
						setCurrentCode(event.data.content);
					}
					if (filePath) {
						setCurrentFile(filePath);
						const operation =
							event.event_type === "file_create"
								? "create"
								: event.event_type === "file_delete"
									? "delete"
									: "update";
						// Track a deduplicated list of touched files (latest content
						// wins) so the view shows WHICH files changed, not just a count.
						setChangedFiles((prev) => {
							const idx = prev.findIndex((f) => f.path === filePath);
							if (idx === -1) {
								return [...prev, { path: filePath, operation, content: event.data.content }];
							}
							return prev.map((f, i) =>
								i === idx
									? {
											...f,
											operation,
											content: event.data.content ?? f.content,
										}
									: f,
							);
						});
					}
					break;
				}

				case "command":
				case "command_run":
					setCurrentStatus(
						`⚡ ${event.data.command?.slice(0, 60) || "Running command..."}`,
					);
					setSessionStats((prev) => ({
						...prev,
						commandsRun: prev.commandsRun + 1,
					}));
					break;

				case "command_output":
					// Show command output in the code view
					if (event.data.output) {
						setCurrentFile("Terminal output");
						setCurrentCode(event.data.output);
					}
					break;

				case "test_run":
					setSessionStats((prev) => ({
						...prev,
						testsRun: prev.testsRun + 1,
					}));
					break;

				case "test_result":
					break;

				case "tool_use": {
					const toolInput = event.data.tool_input
						? `: ${event.data.tool_input}`
						: "";
					setCurrentStatus(`🔧 ${event.data.tool_name}${toolInput}`);
					break;
				}

				case "agent_thinking":
					setCurrentStatus(
						event.data.thinking?.slice(0, 80) ||
							t("streaming:status.thinking", { thought: "..." }),
					);
					break;

				case "agent_response":
					setCurrentStatus(t("streaming:status.responding"));
					break;

				case "chat_message":
					setChatMessages((prev) => [
						...prev,
						{
							author: event.data.author,
							message: event.data.message,
							timestamp: event.timestamp,
							author_type: event.data.author_type,
						},
					]);
					break;

				case "progress_update":
					setProgress(event.data.progress);
					setCurrentStatus(event.data.status);
					if (typeof event.data.is_paused === "boolean") {
						setIsPaused(event.data.is_paused);
					}
					break;
			}

			// Auto-scroll to bottom of event feed
			if (eventScrollRef.current) {
				eventScrollRef.current.scrollTop = eventScrollRef.current.scrollHeight;
			}
		},
		[t],
	);

	// WebSocket connection function
	const connectWebSocket = useCallback(() => {
		if (!isMountedRef.current) return;

		// Close existing connection if any
		if (wsRef.current) {
			wsRef.current.close(1000, "Reconnecting");
			wsRef.current = null;
		}

		setIsRetrying(true);
		const wsUrl = `ws://localhost:8765/stream/${sessionId}`;
		const ws = new WebSocket(wsUrl);

		// Set a timeout for connection attempt
		const connectionTimeout = setTimeout(() => {
			if (!isMountedRef.current) return;
			if (ws.readyState === WebSocket.CONNECTING) {
				ws.close(1006, "Connection timeout");
			}
		}, 5000);

		ws.onopen = () => {
			if (!isMountedRef.current) return;

			clearTimeout(connectionTimeout);
			setIsConnected(true);
			setIsRetrying(false);
			setRetryCount(0);
			startTimeRef.current = Date.now();

			// Send session initialization message to ensure correct session ID
			const initMessage = {
				type: "init_session",
				session_id: sessionId,
			};
			ws.send(JSON.stringify(initMessage));
		};

		ws.onmessage = (event) => {
			if (!isMountedRef.current) return;

			try {
				const streamEvent: StreamingEvent = JSON.parse(event.data);
				handleStreamingEvent(streamEvent);
			} catch (error) {
				console.error(
					"[StreamingSession] Error parsing WebSocket message:",
					error,
				);
			}
		};

		ws.onerror = () => {
			if (!isMountedRef.current) return;
			clearTimeout(connectionTimeout);
			setIsConnected(false);
			setIsRetrying(false);
		};

		ws.onclose = () => {
			if (!isMountedRef.current) return;

			clearTimeout(connectionTimeout);
			setIsConnected(false);
			setIsRetrying(false);

			// Auto-retry if under the limit
			setRetryCount((prev) => {
				const newCount = prev + 1;
				if (newCount <= MAX_AUTO_RETRIES) {
					retryTimerRef.current = setTimeout(() => {
						if (isMountedRef.current) {
							connectWebSocket();
						}
					}, RETRY_DELAY_MS);
				}
				return newCount;
			});
		};

		wsRef.current = ws;
	}, [sessionId, handleStreamingEvent]);

	// Manual reconnect handler
	const handleReconnect = useCallback(() => {
		setRetryCount(0);
		connectWebSocket();
	}, [connectWebSocket]);

	const initializeConnection = useCallback(() => {
		if (isMountedRef.current) {
			connectWebSocket();
		}
	}, [connectWebSocket]);

	// Initial WebSocket connection
	useEffect(() => {
		isMountedRef.current = true;

		// Wait a bit before connecting to ensure dialog is fully rendered
		const initialTimeout = setTimeout(initializeConnection, 500);

		return () => {
			isMountedRef.current = false;
			if (initialTimeout) clearTimeout(initialTimeout);
			if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
			if (wsRef.current) {
				wsRef.current.close(1000, "Component unmounted");
			}
		};
	}, [initializeConnection]);

	// Send chat message
	const sendChatMessage = useCallback(() => {
		if (!chatInput.trim() || !wsRef.current) return;

		const message = {
			type: "chat_message",
			message: chatInput,
			session_id: sessionId,
		};

		wsRef.current.send(JSON.stringify(message));
		setChatInput("");
	}, [chatInput, sessionId]);

	// Pause/resume session
	const togglePause = useCallback(() => {
		if (!wsRef.current) return;

		const message = {
			type: "control",
			action: "toggle_pause",
			session_id: sessionId,
		};

		wsRef.current.send(JSON.stringify(message));
	}, [sessionId]);

	// Stop session
	const stopSession = useCallback(() => {
		if (!wsRef.current) return;

		const message = {
			type: "control",
			action: "stop",
			session_id: sessionId,
		};

		wsRef.current.send(JSON.stringify(message));

		setTimeout(() => {
			onClose?.();
		}, 1000);
	}, [sessionId, onClose]);

	// Download recording
	const downloadRecording = useCallback(() => {
		const recording = {
			session_id: sessionId,
			events: events,
			stats: sessionStats,
			changed_files: changedFiles,
		};

		const blob = new Blob([JSON.stringify(recording, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `streaming-session-${sessionId}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [sessionId, events, sessionStats, changedFiles]);

	// Format duration
	const formatDuration = useCallback((seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	}, []);

	// Share session
	const shareSession = useCallback(async () => {
		const recording = {
			session_id: sessionId,
			events: events,
			stats: sessionStats,
			changed_files: changedFiles,
			project_path: projectPath,
			timestamp: new Date().toISOString(),
		};

		try {
			// Try to use Web Share API if available
			if (navigator.share) {
				const shareData = {
					title: `Streaming Session - ${sessionId}`,
					text: `Session duration: ${formatDuration(sessionStats.duration)}, Files changed: ${sessionStats.filesChanged}`,
					url: globalThis.location?.href || "",
				};

				await navigator.share(shareData);
			} else {
				// Fallback: copy session data to clipboard
				const sessionText = JSON.stringify(recording, null, 2);
				await navigator.clipboard.writeText(sessionText);
			}
		} catch (error) {
			console.error("Error sharing session:", error);
			// Fallback: download the file
			downloadRecording();
		}
	}, [
		sessionId,
		events,
		sessionStats,
		changedFiles,
		projectPath,
		formatDuration,
		downloadRecording,
	]);

	// Update duration every second
	useEffect(() => {
		const interval = setInterval(() => {
			setSessionStats((prev) => ({
				...prev,
				duration: Math.floor((Date.now() - startTimeRef.current) / 1000),
			}));
		}, 1000);

		return () => clearInterval(interval);
	}, []);

	// Keep the "files changed" stat in sync with the distinct file count.
	useEffect(() => {
		setSessionStats((prev) => ({ ...prev, filesChanged: changedFiles.length }));
	}, [changedFiles]);

	const getStatusBadgeContent = () => {
		if (isConnected) {
			return (
				<>
					<div className="w-2 h-2 bg-green-500 rounded-full animate-pulse mr-2" />
					{t("streaming:status.live")}
				</>
			);
		}

		if (isRetrying) {
			return (
				<>
					<RefreshCw className="w-3 h-3 mr-2 animate-spin" />
					{t("streaming:status.connecting")}
				</>
			);
		}

		return t("streaming:status.offline");
	};

	return (
		<div className="flex flex-col h-full bg-background min-h-0">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 border-b">
				<div className="flex items-center gap-4">
					<Film className="w-6 h-6 text-primary" />
					<div>
						<h2 className="text-xl font-bold">{t("streaming:title")}</h2>
						<p className="text-sm text-muted-foreground">{projectPath}</p>
					</div>
					<Badge variant={isConnected ? "default" : "secondary"}>
						{getStatusBadgeContent()}
					</Badge>
					{!isConnected && !isRetrying && retryCount > MAX_AUTO_RETRIES && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleReconnect}
							className="gap-1"
						>
							<RefreshCw className="w-3 h-3" />
							{t("streaming:status.reconnect")}
						</Button>
					)}
				</div>

				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={downloadRecording}>
						<Download className="w-4 h-4 mr-2" />
						{t("streaming:header.saveRecording")}
					</Button>
					<Button variant="outline" size="sm" onClick={shareSession}>
						<Share2 className="w-4 h-4 mr-2" />
						{t("streaming:header.share")}
					</Button>
					<Button
						variant="destructive"
						size="sm"
						onClick={stopSession}
						className="mr-6"
					>
						<Square className="w-4 h-4 mr-2" />
						{t("streaming:header.stopSession")}
					</Button>
				</div>
			</div>

			{/* Stats Bar */}
			<div className="flex items-center justify-between px-6 py-3 bg-muted/30 border-b">
				<div className="flex items-center gap-6 text-sm">
					<div className="flex items-center gap-2">
						<Clock className="w-4 h-4 text-muted-foreground" />
						<span className="font-mono">
							{formatDuration(sessionStats.duration)}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Code2 className="w-4 h-4 text-muted-foreground" />
						<span>
							{t("streaming:stats.files", { count: sessionStats.filesChanged })}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground">
							{t("streaming:stats.commands")}
						</span>
						<span className="font-mono">{sessionStats.commandsRun}</span>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground">
							{t("streaming:stats.tests")}
						</span>
						<span className="font-mono">{sessionStats.testsRun}</span>
					</div>
				</div>

				<div className="flex items-center gap-3">
					<span className="text-sm text-muted-foreground">{currentStatus}</span>
					<Progress value={progress} className="w-32" />
				</div>
			</div>

			{/* Main Content */}
			<div className="flex-1 flex overflow-hidden min-h-0">
				{/* Left: Code/Event View */}
				<div className="flex-1 flex flex-col border-r">
					<div className="px-4 py-2 border-b bg-muted/20">
						<p className="text-sm font-mono text-muted-foreground truncate">
							{selectedEvent
								? `Event: ${selectedEvent.event_type} - ${new Date(selectedEvent.timestamp * 1000).toLocaleTimeString()}`
								: currentFile || t("streaming:codeView.noFile")}
						</p>
					</div>
					<ScrollArea className="flex-1 p-4">
						<pre className="text-sm font-mono">
							<code>
								{selectedEvent
									? formatEventContent(selectedEvent)
									: currentCode || t("streaming:codeView.waitingForChanges")}
							</code>
						</pre>
					</ScrollArea>
				</div>

				{/* Right: Tabs (Chat, Events, Timeline) */}
				<div
					className="w-96 flex flex-col border-l"
					style={{ height: "calc(95vh - 200px)" }}
				>
					<Tabs defaultValue="events" className="flex-1 flex flex-col">
						<TabsList className="w-full rounded-none border-b shrink-0">
							<TabsTrigger value="chat" className="flex-1">
								<MessageSquare className="w-4 h-4 mr-2" />
								{t("streaming:tabs.chat")}
							</TabsTrigger>
							<TabsTrigger value="events" className="flex-1">
								{t("streaming:tabs.events")} ({events.length})
							</TabsTrigger>
							<TabsTrigger value="files" className="flex-1">
								{t("streaming:tabs.files")} ({changedFiles.length})
							</TabsTrigger>
							<TabsTrigger value="timeline" className="flex-1">
								{t("streaming:tabs.timeline")}
							</TabsTrigger>
						</TabsList>

						{/* Chat Tab */}
						<TabsContent
							value="chat"
							className="flex-1 flex flex-col m-0 min-h-0"
						>
							<ScrollArea className="flex-1 p-4" ref={chatScrollRef}>
								<div className="space-y-3">
									<AnimatePresence>
										{chatMessages.map((msg) => (
											<motion.div
												key={`${msg.timestamp}-${msg.author}`}
												initial={{ opacity: 0, y: 10 }}
												animate={{ opacity: 1, y: 0 }}
												className={cn(
													"p-3 rounded-lg",
													msg.author_type === "agent"
														? "bg-primary/10 text-primary"
														: "bg-muted",
												)}
											>
												<div className="flex items-center gap-2 mb-1">
													<span className="text-xs font-semibold">
														{msg.author}
													</span>
													<span className="text-xs text-muted-foreground">
														{new Date(
															msg.timestamp * 1000,
														).toLocaleTimeString()}
													</span>
												</div>
												<p className="text-sm">{msg.message}</p>
											</motion.div>
										))}
									</AnimatePresence>
								</div>
							</ScrollArea>

							<div className="p-4 border-t">
								<div className="flex gap-2">
									<input
										type="text"
										value={chatInput}
										onChange={(e) => setChatInput(e.target.value)}
										onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
										placeholder={t("streaming:chat.placeholder")}
										className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
									/>
									<Button size="sm" onClick={sendChatMessage}>
										{t("streaming:chat.send")}
									</Button>
								</div>
							</div>
						</TabsContent>

						{/* Events Tab */}
						<TabsContent value="events" className="flex-1 m-0">
							<div
								className="p-4 overflow-y-auto"
								ref={eventScrollRef}
								style={{ height: "calc(95vh - 280px)" }}
							>
								<div className="space-y-2">
									{events.map((event) => (
										<Card
											key={`${event.timestamp}-${event.event_type}`}
											className={cn(
												"p-3 cursor-pointer transition-colors hover:bg-muted/50",
												selectedEvent?.timestamp === event.timestamp &&
													selectedEvent?.event_type === event.event_type
													? "bg-primary/10 border-primary/30"
													: "",
											)}
											onClick={() => handleEventSelect(event)}
										>
											<div className="flex items-start justify-between gap-2">
												<div className="flex-1">
													<div className="flex items-center gap-2 mb-1">
														<Badge variant="outline" className="text-xs">
															{event.event_type}
														</Badge>
														<span className="text-xs text-muted-foreground">
															{new Date(
																event.timestamp * 1000,
															).toLocaleTimeString()}
														</span>
														{selectedEvent?.timestamp === event.timestamp &&
															selectedEvent?.event_type ===
																event.event_type && (
																<Badge variant="default" className="text-xs">
																	Selected
																</Badge>
															)}
													</div>
													<p className="text-xs text-muted-foreground wrap-break-word">
														{JSON.stringify(event.data || {}).slice(0, 100)}...
													</p>
												</div>
											</div>
										</Card>
									))}
								</div>
							</div>
						</TabsContent>

						{/* Files Tab — deduplicated list of created/modified files */}
						<TabsContent value="files" className="flex-1 m-0">
							<div
								className="p-4 overflow-y-auto"
								style={{ height: "calc(95vh - 280px)" }}
							>
								{changedFiles.length === 0 ? (
									<p className="text-sm text-muted-foreground text-center mt-8">
										{t("streaming:files.empty")}
									</p>
								) : (
									<div className="space-y-1">
										{changedFiles.map((file) => (
											<button
												type="button"
												key={file.path}
												onClick={() => {
													setSelectedEvent(null);
													setCurrentFile(file.path);
													if (file.content) setCurrentCode(file.content);
												}}
												className={cn(
													"w-full text-left px-3 py-2 rounded-md text-xs font-mono flex items-center gap-2 transition-colors hover:bg-muted/50",
													currentFile === file.path && !selectedEvent
														? "bg-primary/10 border border-primary/30"
														: "",
												)}
												title={file.path}
											>
												<Code2 className="w-3 h-3 shrink-0 text-muted-foreground" />
												<span className="truncate flex-1">{file.path}</span>
												<Badge variant="outline" className="text-[10px]">
													{file.operation}
												</Badge>
											</button>
										))}
									</div>
								)}
							</div>
						</TabsContent>

						{/* Timeline Tab */}
						<TabsContent value="timeline" className="flex-1 m-0 p-4 min-h-0">
							<div className="text-sm text-muted-foreground text-center mt-8">
								<Film className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
								<p>{t("streaming:timeline.comingSoon")}</p>
								<p className="text-xs mt-2">
									{t("streaming:timeline.replayDescription")}
								</p>
							</div>
						</TabsContent>
					</Tabs>
				</div>
			</div>

			{/* Bottom: Controls */}
			<div className="flex items-center justify-center gap-4 px-6 py-0 border-t bg-muted/20">
				<Button
					variant="outline"
					size="lg"
					onClick={togglePause}
					disabled={!isConnected}
					title={
						isPaused
							? t("streaming:controls.resume")
							: t("streaming:controls.pause")
					}
				>
					{isPaused ? (
						<Play className="w-5 h-5" />
					) : (
						<Pause className="w-5 h-5" />
					)}
				</Button>
				<div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
					<motion.div
						className="h-full bg-primary"
						style={{ width: `${progress}%` }}
						initial={{ width: 0 }}
						animate={{ width: `${progress}%` }}
					/>
				</div>
			</div>
		</div>
	);
}
