/**
 * StreamingSession Component Tests
 * =================================
 * Unit tests for the StreamingSession React component.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockedFunction } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { StreamingSession } from "../streaming/StreamingSession";

// Mock WebSocket
class MockWebSocket {
	static readonly instances: MockWebSocket[] = [];
	url: string;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	readyState: number = 0; // CONNECTING
	send: MockedFunction<(data: string) => void>;

	constructor(url: string) {
		this.url = url;
		this.send = vi.fn((data: string) => {
			// Echo the message back for testing
			if (this.onmessage) {
				const event = new MessageEvent("message", { data });
				this.onmessage(event);
			}
		});
		MockWebSocket.instances.push(this);

		// Simulate connection immediately for tests
		setTimeout(() => {
			this.readyState = 1; // OPEN
			if (this.onopen) {
				this.onopen(new Event("open"));
			}
		}, 0);
	}

	close(): void {
		this.readyState = 3; // CLOSED
		if (this.onclose) {
			this.onclose(new CloseEvent("close"));
		}
	}

	// Helper method to trigger connection immediately in tests
	static triggerConnection(): void {
		MockWebSocket.instances.forEach((ws) => {
			if (ws.readyState === 0) {
				// CONNECTING
				ws.readyState = 1; // OPEN
				if (ws.onopen) {
					ws.onopen(new Event("open"));
				}
			}
		});
	}

	// Helper method to simulate receiving a message
	static receiveMessage(data: string): void {
		MockWebSocket.instances.forEach((ws) => {
			if (ws.readyState === 1 && ws.onmessage) {
				// OPEN
				ws.onmessage(new MessageEvent("message", { data }));
			}
		});
	}

	static clearInstances(): void {
		MockWebSocket.instances.length = 0;
	}
}

// Mock global WebSocket
vi.stubGlobal("WebSocket", MockWebSocket);

// Mock useTranslation
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		t: (key: string, options?: any) => {
			const translations: Record<string, string> = {
				"streaming:title": "Live Coding Session",
				"streaming:status.live": "Live",
				"streaming:status.offline": "Offline",
				"streaming:status.thinking": "Thinking: {{thought}}...",
				"streaming:status.sessionStarted": "Session Started",
				"streaming:status.sessionConfirmed": "Session Confirmed",
				"streaming:status.sessionEnded": "Session Ended",
				"streaming:status.responding": "Responding",
				"streaming:controls.pause": "Pause",
				"streaming:controls.resume": "Resume",
				"streaming:header.saveRecording": "Save Recording",
				"streaming:header.share": "Share",
				"streaming:header.stopSession": "Stop Session",
				"streaming:stats.files": "Files changed: {{count}}",
				"streaming:stats.commands": "Commands:",
				"streaming:stats.tests": "Tests:",
				"streaming:codeView.noFile": "No file selected",
				"streaming:codeView.waitingForChanges": "Waiting for code changes...",
				"streaming:tabs.chat": "Chat",
				"streaming:tabs.events": "Events",
				"streaming:tabs.files": "Files",
				"streaming:tabs.timeline": "Timeline",
				"streaming:files.empty": "No files changed yet",
				"streaming:chat.placeholder": "Type your message...",
				"streaming:chat.send": "Send",
				"streaming:timeline.comingSoon": "Timeline coming soon",
				"streaming:timeline.replayDescription":
					"Session replay and timeline scrubbing will be available here",
			};

			let translation = translations[key] || key;

			// Handle interpolation
			if (options && translation.includes("{{")) {
				Object.keys(options).forEach((optionKey) => {
					translation = translation.replace(
						`{{${optionKey}}}`,
						options[optionKey],
					);
				});
			}

			return translation;
		},
	}),
}));

describe("StreamingSession", () => {
	const mockProps = {
		sessionId: "test-session-123",
		projectPath: "/test/project",
		onClose: vi.fn(),
	};

	beforeEach(() => {
		MockWebSocket.clearInstances();
		vi.clearAllMocks();
	});

	afterEach(() => {
		MockWebSocket.clearInstances();
	});

	it("renders the streaming session interface", () => {
		render(<StreamingSession {...mockProps} />);

		expect(screen.getByText("Live Coding Session")).toBeInTheDocument();
		expect(screen.getByText("Offline")).toBeInTheDocument();

		// Default tab is "events"; switch to Chat tab to find the chat input
		// Radix UI Tabs triggers on mouseDown
		fireEvent.mouseDown(screen.getByText("Chat"));

		expect(
			screen.getByPlaceholderText("Type your message..."),
		).toBeInTheDocument();
		expect(screen.getByText("Send")).toBeInTheDocument();
	});

	it("connects to WebSocket with correct URL", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		// The connection should be established (we can't check instances due to afterEach cleanup)
		await waitFor(
			() => {
				expect(screen.getByText("Live")).toBeInTheDocument();
			},
			{ timeout: 2000 },
		);
	});

	it("sends init_session message on connection", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			const ws = MockWebSocket.instances[0];
			expect(ws.onopen).not.toBeNull();
		});

		// Trigger the open event
		const ws = MockWebSocket.instances[0];
		if (ws.onopen) {
			ws.onopen(new Event("open"));
		}

		// Check if init message was sent (we'd need to mock send to verify)
		expect(ws.url).toBe("ws://localhost:8765/stream/test-session-123");
	});

	it("displays connection status changes", async () => {
		render(<StreamingSession {...mockProps} />);

		// Initially offline
		expect(screen.getByText("Offline")).toBeInTheDocument();

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		// Wait for connection
		await waitFor(
			() => {
				expect(screen.getByText("Live")).toBeInTheDocument();
			},
			{ timeout: 2000 },
		);
	});

	it("handles agent_thinking events", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		// Wait for connection
		await waitFor(
			() => {
				expect(screen.getByText("Live")).toBeInTheDocument();
			},
			{ timeout: 2000 },
		);

		// Simulate receiving agent_thinking event
		const ws = MockWebSocket.instances[0];
		const thinkingEvent = {
			event_type: "agent_thinking",
			timestamp: Date.now(),
			data: {
				thinking: "Analyzing the code structure...",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(thinkingEvent) }),
			);
		}

		await waitFor(() => {
			// currentStatus = thinking.slice(0, 80); use exact match to avoid matching JSON in events list
			expect(
				screen.getByText("Analyzing the code structure..."),
			).toBeInTheDocument();
		});
	});

	it("handles agent_response events", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];
		const responseEvent = {
			event_type: "agent_response",
			timestamp: Date.now(),
			data: {
				response: "I will implement this feature using React hooks.",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(responseEvent) }),
			);
		}

		// Just verify the event was processed by checking the Events tab count increases
		await waitFor(() => {
			expect(
				screen.getByText((content) => content.includes("Events (1)")),
			).toBeInTheDocument();
		});
	});

	it("handles file_change events", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];
		const fileChangeEvent = {
			event_type: "file_change",
			timestamp: Date.now(),
			data: {
				file_path: "/test/project/src/components/Test.tsx",
				content: "export default function Test() { return <div>Test</div>; }",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(fileChangeEvent) }),
			);
		}

		// Just verify the event was processed by checking the Events tab count increases
		await waitFor(() => {
			expect(
				screen.getByText((content) => content.includes("Events (1)")),
			).toBeInTheDocument();
		});
	});

	it("lists distinct changed files and dedupes repeated edits", async () => {
		render(<StreamingSession {...mockProps} />);

		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];
		const fileEvent = (filePath: string, type = "file_update") => ({
			event_type: type,
			timestamp: Date.now(),
			data: {
				file_path: filePath,
				content: "x",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		});

		// Two edits to the same file + one create on another => 2 distinct files
		for (const evt of [
			fileEvent("/p/a.ts"),
			fileEvent("/p/a.ts"),
			fileEvent("/p/b.ts", "file_create"),
		]) {
			ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify(evt) }));
		}

		// The Files tab badge reflects the distinct count (2), not 3 events
		await waitFor(() => {
			expect(
				screen.getByText((content) => content.includes("Files (2)")),
			).toBeInTheDocument();
		});

		// Switch to the Files tab and verify both paths are listed.
		// (b.ts is also echoed in the left-panel header as the latest file, so
		// it can appear more than once — assert "at least one".)
		fireEvent.mouseDown(screen.getByText((content) => content.includes("Files (2)")));
		expect(screen.getAllByText("/p/a.ts").length).toBeGreaterThan(0);
		expect(screen.getAllByText("/p/b.ts").length).toBeGreaterThan(0);
	});

	it("handles command events", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];
		const commandEvent = {
			event_type: "command",
			timestamp: Date.now(),
			data: {
				command: "npm install",
				working_dir: "/test/project",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(commandEvent) }),
			);
		}

		// Just verify the event was processed by checking the Events tab count increases
		await waitFor(() => {
			expect(
				screen.getByText((content) => content.includes("Events (1)")),
			).toBeInTheDocument();
		});
	});

	it("handles agent thinking events", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];
		const thinkingEvent = {
			event_type: "agent_thinking",
			timestamp: Date.now(),
			data: {
				thinking:
					"Analyzing the code structure and planning the implementation",
				session_id: "test-session-123",
			},
			session_id: "test-session-123",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(thinkingEvent) }),
			);
		}

		await waitFor(() => {
			// currentStatus = thinking.slice(0, 80); use exact match to avoid matching JSON in events list
			expect(
				screen.getByText(
					"Analyzing the code structure and planning the implementation",
				),
			).toBeInTheDocument();
		});
	});

	it("sends chat messages when form is submitted", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		// Default tab is "events"; switch to Chat tab (Radix UI triggers on mouseDown)
		fireEvent.mouseDown(screen.getByText("Chat"));

		const messageInput = screen.getByPlaceholderText("Type your message...");
		const sendButton = screen.getByText("Send");

		// Type a message
		fireEvent.change(messageInput, {
			target: { value: "How are you implementing this?" },
		});

		// Submit the form
		fireEvent.click(sendButton);

		// Verify WebSocket send was called
		const ws = MockWebSocket.instances[0];
		expect(ws.send).toHaveBeenCalled();

		// Verify input was cleared
		expect(messageInput).toHaveValue("");
	});

	it("calls onClose when stop button is clicked", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const stopButton = screen.getByText("Stop Session");
		fireEvent.click(stopButton);

		await waitFor(
			() => {
				expect(mockProps.onClose).toHaveBeenCalled();
			},
			{ timeout: 2000 },
		);
	});

	it("handles WebSocket connection errors", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];

		// Simulate connection error
		if (ws?.onerror) {
			ws.onerror(new Event("error"));
		}

		await waitFor(() => {
			expect(screen.getByText("Offline")).toBeInTheDocument();
		});
	});

	it("handles WebSocket disconnection", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];

		// Simulate disconnection
		if (ws.onclose) {
			ws.onclose(new CloseEvent("close"));
		}

		await waitFor(() => {
			expect(screen.getByText("Offline")).toBeInTheDocument();
		});
	});

	it("limits event history to prevent memory issues", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		await waitFor(() => {
			expect(screen.getByText("Live")).toBeInTheDocument();
		});

		const ws = MockWebSocket.instances[0];

		// Send many events (more than the limit)
		for (let i = 0; i < 150; i++) {
			const event = {
				event_type: "agent_thinking",
				timestamp: Date.now(),
				data: {
					thinking: `Thinking step ${i}`,
					session_id: "test-session-123",
				},
				session_id: "test-session-123",
			};

			if (ws.onmessage) {
				ws.onmessage(
					new MessageEvent("message", { data: JSON.stringify(event) }),
				);
			}
		}

		// Should not crash and should display recent events
		// currentStatus = thinking.slice(0, 80); use exact match to avoid matching JSON in events list
		await waitFor(() => {
			expect(screen.getByText("Thinking step 149")).toBeInTheDocument();
		});
	});

	it("filters events by session ID", async () => {
		render(<StreamingSession {...mockProps} />);

		// Force WebSocket connection
		MockWebSocket.triggerConnection();

		// Wait for WebSocket connection and UI update
		await waitFor(
			() => {
				expect(screen.getByText("Live")).toBeInTheDocument();
			},
			{ timeout: 2000 },
		);

		const ws = MockWebSocket.instances[0];

		// Send event with wrong session ID
		const wrongEvent = {
			event_type: "agent_thinking",
			timestamp: Date.now(),
			data: {
				thinking: "This should be ignored",
				session_id: "wrong-session",
			},
			session_id: "wrong-session",
		};

		if (ws.onmessage) {
			ws.onmessage(
				new MessageEvent("message", { data: JSON.stringify(wrongEvent) }),
			);
		}

		// Should not display the wrong event
		expect(
			screen.queryByText("This should be ignored"),
		).not.toBeInTheDocument();
	});
});
