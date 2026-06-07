/**
 * #3.5 Real-time Pair Programming panel.
 *
 * Create or join a room, see the live participant list, send chat
 * messages and watch operations stream in via SSE.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	setupPairRealtimeListeners,
	usePairRealtimeStore,
} from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

const ROLES = [
	{ value: "driver", labelKey: "pair.roleDriver" },
	{ value: "navigator", labelKey: "pair.roleNavigator" },
	{ value: "ai", labelKey: "pair.roleAi" },
] as const;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX_LEN = 64;
const MESSAGE_MAX_LEN = 2000;

type Role = (typeof ROLES)[number]["value"];

export function PairProgrammingPanel() {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		currentRoom,
		ops,
		isStreaming,
		createOrJoin,
		leave,
		sendChat,
		subscribe,
		unsubscribe,
	} = usePairRealtimeStore();
	const [roomId, setRoomId] = useState("demo-room");
	const [userId, setUserId] = useState("you");
	const [displayName, setDisplayName] = useState("You");
	const [role, setRole] = useState<Role>("driver");
	const [chatText, setChatText] = useState("");
	const [chatError, setChatError] = useState<string | null>(null);
	const opsScrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const teardown = setupPairRealtimeListeners();
		return teardown;
	}, []);

	useEffect(() => {
		if (currentRoom && !isStreaming) {
			void subscribe();
		}
		return () => {
			if (isStreaming) void unsubscribe();
		};
	}, [currentRoom, isStreaming, subscribe, unsubscribe]);

	useEffect(() => {
		if (opsScrollRef.current) {
			opsScrollRef.current.scrollTop = opsScrollRef.current.scrollHeight;
		}
	}, []);

	const isRunning = phase === "running";

	const roomIdError = useMemo(() => {
		const trimmed = roomId.trim();
		if (trimmed.length === 0) return t("pair.validation.roomIdRequired");
		if (!ROOM_ID_PATTERN.test(trimmed)) return t("pair.validation.roomIdInvalid");
		return null;
	}, [roomId, t]);

	const nameError = useMemo(
		() => (displayName.trim().length === 0 ? t("pair.validation.nameRequired") : null),
		[displayName, t],
	);

	const canJoin = !roomIdError && !nameError && userId.trim().length > 0;

	const safeStringify = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (value === null || value === undefined) return "";
		try {
			return JSON.stringify(value);
		} catch {
			return "[object]";
		}
	};

	const handleSubmitChat = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = chatText.trim();
		if (trimmed.length === 0) {
			setChatError(t("pair.validation.messageEmpty"));
			return;
		}
		if (chatText.length > MESSAGE_MAX_LEN) {
			setChatError(t("pair.validation.messageTooLong", { max: MESSAGE_MAX_LEN }));
			return;
		}
		setChatError(null);
		void sendChat(trimmed);
		setChatText("");
	};

	return (
		<PanelShell
			title={t("pair.title")}
			subtitle={t("pair.subtitle")}
			error={error}
			actions={
				currentRoom ? (
					<Button size="sm" variant="outline" onClick={() => leave()}>
						{t("pair.leave")}
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() =>
							createOrJoin(roomId.trim(), userId.trim(), displayName.trim(), role)
						}
						disabled={isRunning || !canJoin}
					>
						{t("pair.joinRoom")}
					</Button>
				)
			}
		>
			{currentRoom ? (
				<div className="space-y-3 text-sm">
					<div className="flex items-center gap-3">
						<Badge variant="outline">
							{t("pair.roomLabel")}: {currentRoom.room_id}
						</Badge>
						<Badge
							className={
								isStreaming
									? "bg-green-500/20 text-green-700 border-green-500/40"
									: "bg-muted"
							}
						>
							{isStreaming ? `● ${t("pair.streaming")}` : "○"}
						</Badge>
					</div>

					<div>
						<div className="font-medium mb-1">
							{t("pair.participants")} ({currentRoom.participants.length})
						</div>
						<ul className="flex flex-wrap gap-2">
							{currentRoom.participants.map((p) => (
								<li key={p.user_id} className="rounded border px-2 py-1 text-xs">
									{p.display_name}{" "}
									<span className="text-muted-foreground">({p.role})</span>
								</li>
							))}
						</ul>
					</div>

					<div>
						<div className="font-medium mb-1">{t("pair.recentOps")}</div>
						<div
							ref={opsScrollRef}
							className="rounded border p-2 max-h-64 overflow-auto space-y-1 text-xs font-mono bg-muted/20"
						>
							{ops.length === 0 ? (
								<p className="text-muted-foreground">—</p>
							) : (
								ops.map((op) => (
									<div key={op.op_id}>
										<span className="text-muted-foreground">
											#{op.sequence}
										</span>{" "}
										<Badge variant="outline" className="text-[10px]">
											{op.kind}
										</Badge>{" "}
										<span>{op.actor}</span>
										{op.kind === "chat" && (
											<span className="ml-2">{safeStringify(op.payload.text)}</span>
										)}
										{op.kind === "edit" && (
											<span className="ml-2">
												{safeStringify(op.payload.file_path)}:
												{safeStringify(op.payload.start_line)}
											</span>
										)}
									</div>
								))
							)}
						</div>
					</div>

					<form className="space-y-1" onSubmit={handleSubmitChat}>
						<div className="flex gap-2">
							<input
								value={chatText}
								onChange={(e) => {
									setChatText(e.target.value.slice(0, MESSAGE_MAX_LEN));
									if (chatError) setChatError(null);
								}}
								maxLength={MESSAGE_MAX_LEN}
								aria-invalid={Boolean(chatError) || undefined}
								aria-describedby={chatError ? "chat-error" : undefined}
								placeholder={t("pair.chatPlaceholder")}
								className="flex-1 rounded border bg-background p-2 text-sm"
							/>
							<Button type="submit" size="sm" disabled={chatText.trim().length === 0}>
								{t("pair.send")}
							</Button>
						</div>
						{chatError && (
							<p id="chat-error" className="text-xs text-destructive">
								{chatError}
							</p>
						)}
					</form>
				</div>
			) : (
				<div className="grid grid-cols-2 gap-3 text-sm">
					<div>
						<label htmlFor="room-id-input" className="block font-medium mb-1">
							{t("pair.roomId")}
						</label>
						<input
							id="room-id-input"
							value={roomId}
							onChange={(e) => setRoomId(e.target.value.slice(0, 64))}
							maxLength={64}
							aria-invalid={Boolean(roomIdError) || undefined}
							aria-describedby={roomIdError ? "room-id-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm"
						/>
						{roomIdError && (
							<p id="room-id-error" className="mt-1 text-xs text-destructive">
								{roomIdError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="display-name-input" className="block font-medium mb-1">
							{t("pair.yourName")}
						</label>
						<input
							id="display-name-input"
							value={displayName}
							onChange={(e) => {
								const v = e.target.value.slice(0, NAME_MAX_LEN);
								setDisplayName(v);
								setUserId(v.toLowerCase().replaceAll(/\s+/g, "-") || "you");
							}}
							maxLength={NAME_MAX_LEN}
							aria-invalid={Boolean(nameError) || undefined}
							aria-describedby={nameError ? "display-name-error" : undefined}
							className="w-full rounded border bg-background p-2 text-sm"
						/>
						{nameError && (
							<p id="display-name-error" className="mt-1 text-xs text-destructive">
								{nameError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="role-select" className="block font-medium mb-1">
							{t("pair.role")}
						</label>
						<select
							id="role-select"
							value={role}
							onChange={(e) => setRole(e.target.value as Role)}
							className="w-full rounded border bg-background p-2 text-sm"
						>
							{ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{t(r.labelKey as never)}
								</option>
							))}
						</select>
					</div>
				</div>
			)}
		</PanelShell>
	);
}
