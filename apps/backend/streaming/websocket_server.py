"""
WebSocket Server for Streaming Development Mode.

Provides real-time event broadcasting to frontend clients.
"""

import json
import logging
import os
import socket
import time
from typing import Any

import psutil

try:
    import warnings

    import websockets

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from websockets.server import WebSocketServerProtocol

    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    WebSocketServerProtocol = None

from .session_recorder import SessionRecorder
from .streaming_manager import get_streaming_manager

logger = logging.getLogger(__name__)


def _is_port_available(port: int) -> bool:
    """Check if port is available."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        result = sock.connect_ex(("localhost", port))
        return result != 0
    finally:
        sock.close()


def _should_kill_process(
    pid: int, name: str, cmdline: list, create_time: float, port: int
) -> tuple[bool, str]:
    """Determine if a process should be killed."""
    current_pid = os.getpid()

    # NEVER kill our own process
    if pid == current_pid:
        return False, "Skipping our own process"

    process_age = time.time() - create_time
    cmdline_str = " ".join(cmdline).lower()

    # Check for stale WebSocket server processes
    is_stale_websocket = (
        "websocket_server.py" in cmdline_str
        and process_age > 30
        and "workpilot" not in cmdline_str.lower()
    )

    # Check for orphaned processes
    is_orphaned = (
        name.lower().startswith("python")
        and process_age > 300  # 5 minutes
        and port == 8765
    )

    if is_stale_websocket:
        return True, f"Killing stale WebSocket process (age: {process_age:.1f}s)"
    elif is_orphaned:
        return True, f"Killing orphaned process (age: {process_age:.1f}s)"
    else:
        return False, f"Preserving active process (age: {process_age:.1f}s)"


def _kill_process_safely(proc: psutil.Process, pid: int, name: str) -> None:
    """Kill a process safely with graceful termination."""
    logger.info(f"Terminating process {pid} ({name})")
    proc.terminate()

    # Wait for graceful termination — use psutil.wait so we actually reap
    # the child instead of polling and leaving a zombie behind.
    try:
        proc.wait(timeout=1)
        return
    except psutil.TimeoutExpired:
        pass
    except psutil.NoSuchProcess:
        return

    # Force kill if still running
    if proc.is_running():
        logger.warning(f"Force killing process {pid}")
        proc.kill()
        try:
            proc.wait(timeout=2)
        except (psutil.TimeoutExpired, psutil.NoSuchProcess):
            pass


def _is_target_connection(conn, port: int) -> bool:
    """Check if connection matches our target port and IP criteria."""
    return (
        conn.status == "LISTEN"
        and conn.laddr.port == port
        and (
            conn.laddr.ip == "127.0.0.1"
            or conn.laddr.ip == "0.0.0.0"
            or conn.laddr.ip == "::1"
        )
    )


def _process_single_process(proc, port: int) -> bool:
    """Process a single process and return True if it was killed."""
    try:
        connections = proc.connections()
        for conn in connections:
            if not _is_target_connection(conn, port):
                continue

        pid = proc.info["pid"]
        name = proc.info["name"]
        cmdline = proc.info.get("cmdline", [])
        create_time = proc.info.get("create_time", 0)

        should_kill, reason = _should_kill_process(
            pid, name, cmdline, create_time, port
        )
        logger.info(f"Process {pid} ({name}): {reason}")

        if should_kill:
            _kill_process_safely(proc, pid, name)
            return True
        return False

    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def _handle_post_kill_cleanup(port: int) -> bool:
    """Handle cleanup after killing processes."""
    # Wait for processes to fully terminate
    time.sleep(2)

    if not _is_port_available(port):
        logger.error(f"Port {port} is still occupied after killing stale processes")
        return False
    else:
        logger.info(f"Port {port} is now available after cleaning stale processes")
        return True


def kill_processes_on_port(port: int) -> bool:
    """Kill only stale WebSocket server processes, preserving active live coding sessions."""
    try:
        if _is_port_available(port):
            logger.info(f"Port {port} is already available")
            return True

        logger.warning(f"Port {port} is occupied, checking for stale processes...")

        killed_any = False

        for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
            if _process_single_process(proc, port):
                killed_any = True

        if killed_any:
            return _handle_post_kill_cleanup(port)
        else:
            logger.info(
                f"No stale processes found on port {port}, preserving existing processes"
            )
            return True

    except Exception as e:
        logger.error(f"Error checking processes on port {port}: {e}")
        return False


class StreamingWebSocketServer:
    """
    WebSocket server for streaming development sessions.

    Handles client connections and message routing for the streaming mode.
    """

    def __init__(self, host: str = "localhost", port: int = 8765):
        self.host = host
        self.port = port
        self.streaming_manager = get_streaming_manager()
        self.session_recorder = SessionRecorder()
        self._server = None
        self._clients: dict[str, set[Any]] = {}
        self._connection_paths: dict[int, str] = {}  # Store path by connection ID

    async def start(self):
        """Start the WebSocket server."""
        if not WEBSOCKETS_AVAILABLE:
            logger.warning(
                "websockets package not installed. "
                "Streaming mode will not be available. "
                "Install with: pip install websockets"
            )
            return

        # Try to kill processes using the port if it's occupied
        if not kill_processes_on_port(self.port):
            logger.error(
                f"Could not free port {self.port}, WebSocket server will not start"
            )
            return

        try:
            # In websockets v16, we need to use a different approach
            # The handler receives only the websocket connection
            self._server = await websockets.serve(
                self._handle_client,
                self.host,
                self.port,
                # Add error handling at the server level
                process_request=self._process_request,
                # Set reasonable limits to prevent abuse
                max_size=10_000_000,  # 10MB max message size
                ping_interval=20,  # Send ping every 20 seconds
                ping_timeout=10,  # Wait 10 seconds for pong response
                close_timeout=10,  # Wait 10 seconds for close handshake
            )
            logger.info(
                f"Streaming WebSocket server started on ws://{self.host}:{self.port}"
            )
        except Exception as e:
            logger.error(f"Failed to start WebSocket server: {e}")
            # Don't re-raise, just log and continue without WebSocket support

    async def stop(self):
        """Stop the WebSocket server."""
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            logger.info("Streaming WebSocket server stopped")

    # Origins allowed to connect to the streaming WebSocket. Bound to
    # localhost by default (see __init__), but a malicious page in any
    # browser the user opens can still attempt cross-origin WS to localhost
    # and subscribe to live coding sessions, exfiltrating file paths /
    # command output / agent thinking. Restrict to known dev/prod URLs.
    _ALLOWED_ORIGINS = frozenset(
        os.environ.get(
            "WORKPILOT_WS_ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,"
            "http://localhost:3000,http://127.0.0.1:3000,"
            "file://",
        ).split(",")
    )

    def _process_request(self, *args, **kwargs):
        """Process incoming WebSocket connection requests.

        Reject any handshake whose `Origin` header is not on the allowlist.
        Variable signature handles multiple websockets-library versions:
        v10-v12 pass `(path, headers)`, v13+ pass `(connection, request)`.
        """
        # Locate the headers regardless of which positional shape was used.
        headers = None
        for arg in args:
            if hasattr(arg, "headers"):
                headers = arg.headers
                break
            if hasattr(arg, "get"):
                # Plain Headers / dict-like
                headers = arg
                break
        if headers is None:
            # Cannot identify headers — fail open ONLY for tests; in prod the
            # signature should always match. Return None to accept (legacy
            # behavior) so unknown library versions don't lock us out.
            return None

        origin = ""
        try:
            origin = headers.get("Origin", "") or headers.get("origin", "")
        except Exception:
            return None

        if origin and origin not in self._ALLOWED_ORIGINS:
            logger.warning(
                "Rejecting WebSocket connection from disallowed origin: %s",
                origin,
            )
            # Return a tuple/response to abort; library version-dependent.
            try:
                from http import HTTPStatus

                return (HTTPStatus.FORBIDDEN, [], b"forbidden origin\n")
            except Exception:
                return None
        return None

    def _extract_websocket_path(self, websocket: WebSocketServerProtocol) -> str:
        """Extract path from websocket connection."""
        path = "/stream/default"  # Default fallback

        try:
            if hasattr(websocket, "path"):
                path = websocket.path
            elif hasattr(websocket, "scope"):
                scope = websocket.scope
                if scope and "path" in scope:
                    path = scope["path"]
        except Exception as e:
            logger.error(f"Error extracting path: {e}")

        return path

    def _extract_session_id(self, path: str, websocket: WebSocketServerProtocol) -> str:
        """Extract session ID from path and websocket."""
        connection_id = id(websocket)
        session_id = f"session-{connection_id}"

        # Try to extract a more meaningful session ID if possible
        if path != "/stream/default":
            path_parts = path.strip("/").split("/")
            if len(path_parts) >= 2 and path_parts[0] == "stream":
                session_id = path_parts[1]

        return session_id

    async def _setup_session(self, session_id: str) -> None:
        """Setup streaming session if it doesn't exist."""
        session_info = self.streaming_manager.get_session_info(session_id)
        if not session_info:
            await self.streaming_manager.start_session(
                session_id,
                {
                    "session_id": session_id,
                    "task": "Live Coding Session",
                    "project_path": "unknown",
                    "auto_created": True,
                    "status": "watching",
                },
            )
            logger.info(f"Auto-created session {session_id} for client connection")

    def _register_client(
        self, session_id: str, websocket: WebSocketServerProtocol
    ) -> None:
        """Register client with session and streaming manager."""
        if session_id not in self._clients:
            self._clients[session_id] = set()
        self._clients[session_id].add(websocket)
        self.streaming_manager.subscribe(session_id, websocket)
        logger.info(f"Client connected to session {session_id}")

    async def _send_welcome_message(
        self, session_id: str, websocket: WebSocketServerProtocol, session_info
    ) -> None:
        """Send welcome message to client."""
        try:
            welcome_event = {
                "event_type": "session_start",
                "timestamp": time.time(),
                "data": {
                    "session_id": session_id,
                    "message": "Connected to streaming session",
                    "auto_created": session_info is None,
                },
                "session_id": session_id,
            }
            await websocket.send(json.dumps(welcome_event))
        except Exception as e:
            logger.warning(f"Failed to send welcome message: {e}")

    def _cleanup_client(
        self, session_id: str, websocket: WebSocketServerProtocol
    ) -> None:
        """Clean up client connection.

        Tolerate the case where the session_id was never registered (e.g.,
        an exception during `_setup_session` reaches the `finally` cleanup
        before `_register_client` ran). Previously raised KeyError, which
        masked the original setup error.
        """
        clients = self._clients.get(session_id)
        if clients is not None:
            clients.discard(websocket)
        self.streaming_manager.unsubscribe(session_id, websocket)
        logger.info(f"Client cleanup completed for session {session_id}")

    async def _handle_client(self, websocket: WebSocketServerProtocol):
        """Handle a client connection."""
        # Use a mutable container for session_id so _handle_message can update it
        # when init_session changes the session. A plain string variable would not
        # be updated by the child method due to Python scoping rules.
        ctx = {"session_id": None}

        try:
            await self._setup_client_connection(websocket, ctx)
            await self._handle_client_messages(websocket, ctx)
        except Exception as e:
            logger.error(f"Critical error in _handle_client: {e}")
            self._handle_critical_error(ctx, websocket, e)
        finally:
            self._ensure_cleanup(ctx, websocket)

    async def _setup_client_connection(
        self, websocket: WebSocketServerProtocol, ctx: dict
    ):
        """Setup initial client connection and session."""
        # Extract path and session ID
        path = self._extract_websocket_path(websocket)
        ctx["session_id"] = self._extract_session_id(path, websocket)
        logger.info(
            f"New connection for session {ctx['session_id']} from {websocket.remote_address}"
        )

        # Setup session if needed
        await self._setup_session(ctx["session_id"])

        # Register client
        self._register_client(ctx["session_id"], websocket)

        # Send welcome message
        session_info = self.streaming_manager.get_session_info(ctx["session_id"])
        await self._send_welcome_message(ctx["session_id"], websocket, session_info)

    async def _handle_client_messages(
        self, websocket: WebSocketServerProtocol, ctx: dict
    ):
        """Handle incoming messages from client."""
        try:
            async for message in websocket:
                await self._handle_message(ctx, websocket, message)
        except websockets.exceptions.ConnectionClosed:
            logger.info(f"Client disconnected from session {ctx['session_id']}")
        except websockets.exceptions.ConnectionClosedOK:
            logger.info(f"Client cleanly disconnected from session {ctx['session_id']}")
        except websockets.exceptions.ConnectionClosedError as e:
            logger.warning(
                f"Client connection closed with error from session {ctx['session_id']}: {e}"
            )
        except websockets.exceptions.InvalidMessage as e:
            logger.warning(
                f"Invalid message received from session {ctx['session_id']}: {e}"
            )
        except Exception as e:
            logger.error(
                f"Unexpected error in client handler for session {ctx['session_id']}: {e}"
            )
        finally:
            self._cleanup_client(ctx["session_id"], websocket)

    def _handle_critical_error(
        self, ctx: dict, websocket: WebSocketServerProtocol, _error: Exception
    ):
        """Handle critical errors during client setup."""
        # Ensure cleanup even if connection fails early
        try:
            if ctx["session_id"]:
                self._cleanup_client(ctx["session_id"], websocket)
        except Exception as cleanup_error:
            logger.error(f"Error during cleanup: {cleanup_error}")

    def _ensure_cleanup(self, ctx: dict, websocket: WebSocketServerProtocol):
        """Ensure cleanup is performed if not already done."""
        # Only cleanup if we haven't already done so in the message handler
        if ctx.get("session_id") and not ctx.get("cleaned_up", False):
            try:
                self._cleanup_client(ctx["session_id"], websocket)
                ctx["cleaned_up"] = True
            except Exception as cleanup_error:
                logger.error(f"Error during final cleanup: {cleanup_error}")

    async def _handle_message(
        self, ctx: dict, websocket: WebSocketServerProtocol, message: str
    ):
        """Handle incoming message from client.

        Args:
            ctx: Mutable dict with 'session_id' key — updated by init_session so
                 subsequent messages use the correct session.
        """
        try:
            data = json.loads(message)
            # Reject non-object payloads early — `data.get(...)` below would
            # raise AttributeError on a JSON string/array/number, producing
            # error-level log spam (and no rate limit).
            if not isinstance(data, dict):
                logger.debug("Ignoring non-object WS message: %r", type(data).__name__)
                return
            msg_type = data.get("type")
            session_id = ctx["session_id"]

            # Route message to appropriate handler
            if msg_type == "init_session":
                await self._handle_init_session(ctx, websocket, data)
            elif msg_type == "agent_event":
                await self._handle_agent_event(session_id, data, websocket)
            elif msg_type == "chat_message":
                await self._handle_chat_message(session_id, data)
            elif msg_type == "control":
                await self._handle_control(session_id, data.get("action"))
            # Unknown message types are ignored gracefully

        except json.JSONDecodeError:
            # Don't echo the full message back to logs — it can be large.
            logger.debug("Invalid JSON message dropped (size=%d)", len(message))
        except Exception as e:
            logger.error(f"Error handling message: {e}")

    async def _handle_init_session(
        self, ctx: dict, websocket: WebSocketServerProtocol, data: dict
    ):
        """Handle session initialization message."""
        actual_session_id = data.get("session_id")
        current_session_id = ctx["session_id"]

        if not actual_session_id or actual_session_id == current_session_id:
            return

        logger.info(
            f"Client requested session change: {current_session_id} -> {actual_session_id}"
        )

        await self._move_client_to_session(
            ctx, websocket, current_session_id, actual_session_id
        )
        await self._send_session_confirmation(websocket, actual_session_id)

    async def _move_client_to_session(
        self,
        ctx: dict,
        websocket: WebSocketServerProtocol,
        old_session_id: str,
        new_session_id: str,
    ):
        """Move client from old session to new session."""
        # Remove from old session
        if old_session_id in self._clients:
            self._clients[old_session_id].discard(websocket)
        self.streaming_manager.unsubscribe(old_session_id, websocket)
        logger.info(f"Unsubscribed from old session: {old_session_id}")

        # Update context
        ctx["session_id"] = new_session_id

        # Ensure new session exists
        await self._ensure_session_exists(new_session_id)

        # Register with new session
        if new_session_id not in self._clients:
            self._clients[new_session_id] = set()
        self._clients[new_session_id].add(websocket)
        self.streaming_manager.subscribe(new_session_id, websocket)
        logger.info(f"Subscribed to new session: {new_session_id}")

    async def _ensure_session_exists(self, session_id: str):
        """Create session if it doesn't exist."""
        session_info = self.streaming_manager.get_session_info(session_id)
        if not session_info:
            await self.streaming_manager.start_session(
                session_id,
                {
                    "session_id": session_id,
                    "task": "Live Coding Session",
                    "project_path": "unknown",
                    "auto_created": True,
                    "status": "watching",
                },
            )
            logger.info(f"Auto-created session {session_id}")

    async def _send_session_confirmation(
        self, websocket: WebSocketServerProtocol, session_id: str
    ):
        """Send session confirmation message to client."""
        confirmation = {
            "event_type": "session_confirmed",
            "timestamp": time.time(),
            "data": {
                "session_id": session_id,
                "message": f"Connected to session {session_id}",
            },
            "session_id": session_id,
        }
        await websocket.send(json.dumps(confirmation))
        logger.info(f"Sent confirmation for session: {session_id}")

    async def _handle_agent_event(
        self, session_id: str, data: dict, websocket: WebSocketServerProtocol
    ):
        """Handle agent event message."""
        event_data = data.get("event")
        if not event_data:
            return

        from .streaming_manager import EventType, StreamingEvent

        # Use session_id from event data as authoritative source
        event_session = event_data.get("session_id", session_id)
        try:
            event = StreamingEvent(
                event_type=EventType(event_data.get("event_type", "agent_thinking")),
                timestamp=event_data.get("timestamp", time.time()),
                data=event_data.get("data", {}),
                session_id=event_session,
            )
            logger.info(
                f"Broadcasting agent event '{event_data.get('event_type')}' to session {event_session} ({len(self._clients.get(event_session, set()))} subscribers)"
            )
            await self._broadcast_to_subscribers(
                event_session, event, exclude=websocket
            )
        except (ValueError, KeyError) as e:
            logger.warning(f"Invalid agent event: {e}")

    async def _handle_chat_message(self, session_id: str, data: dict):
        """Handle chat message."""
        await self.streaming_manager.emit_chat_message(
            session_id=session_id,
            message=data.get("message", ""),
            author="User",
            author_type="user",
        )

    async def _broadcast_to_subscribers(self, session_id: str, event, exclude=None):
        """Broadcast an event to all subscribers of a session, optionally excluding the sender."""
        subscribers = self._clients.get(session_id, set())
        event_json = json.dumps(event.to_dict())
        disconnected = set()

        for ws in subscribers:
            if ws is exclude:
                continue
            try:
                await ws.send(event_json)
            except Exception as e:
                logger.warning(f"Failed to send event to subscriber: {e}")
                disconnected.add(ws)

        for ws in disconnected:
            subscribers.discard(ws)
            self.streaming_manager.unsubscribe(session_id, ws)

    async def _handle_control(self, session_id: str, action: str):
        """Handle control commands."""
        if action == "toggle_pause":
            # Get current session status
            session_info = self.streaming_manager.get_session_info(session_id)

            if not session_info:
                logger.warning(f"Session not found: {session_id}")
                return

            # Toggle pause/resume based on current status
            if session_info.get("status") == "paused":
                await self.streaming_manager.resume_session(session_id)
                logger.info(f"Session resumed: {session_id}")
            else:
                await self.streaming_manager.pause_session(session_id)
                logger.info(f"Session paused: {session_id}")

        elif action == "stop":
            # Stop the session
            await self.streaming_manager.end_session(session_id)
            logger.info(f"Stop requested for session {session_id}")

    def get_active_sessions(self):
        """Get list of active streaming sessions."""
        return self.streaming_manager.get_active_sessions()


# Global server instance
_websocket_server: StreamingWebSocketServer | None = None


def get_websocket_server() -> StreamingWebSocketServer:
    """Get or create the global WebSocket server instance."""
    global _websocket_server
    if _websocket_server is None:
        _websocket_server = StreamingWebSocketServer()
    return _websocket_server


async def start_streaming_server():
    """Start the streaming WebSocket server."""
    server = get_websocket_server()
    await server.start()


async def stop_streaming_server():
    """Stop the streaming WebSocket server."""
    server = get_websocket_server()
    await server.stop()
