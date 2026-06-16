"""Board-event emission toward the streaming WebSocket server.

The WS server runs in a separate process, so the REST API publishes by
connecting as a short-lived WS client on the project channel
(``project:{project_id}``) and sending an ``agent_event`` message — the
exact mechanism agents already use. Fire-and-forget: a board event must
never fail the originating REST request.

The API authenticates with a self-minted service token (it owns the JWT
secret), so this works with WS auth enabled.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)

WS_URL = os.environ.get("WORKPILOT_WS_URL", "ws://127.0.0.1:8765")
_SEND_TIMEOUT = 5.0


def _mint_service_token() -> str:
    import jwt as pyjwt
    from server.config import get_settings

    settings = get_settings()
    now = datetime.now(UTC)
    return pyjwt.encode(
        {
            "iss": settings.jwt_issuer,
            "sub": "service:api",
            "name": "WorkPilot API",
            "role": "service",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=2)).timestamp()),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


async def _send(channel: str, event_type: str, data: dict) -> None:
    try:
        import websockets

        url = f"{WS_URL}/stream/{channel}?token={_mint_service_token()}"
        async with asyncio.timeout(_SEND_TIMEOUT):
            async with websockets.connect(url) as ws:
                await ws.send(
                    json.dumps({"type": "init_session", "session_id": channel})
                )
                await ws.send(
                    json.dumps(
                        {
                            "type": "agent_event",
                            "event": {
                                "event_type": event_type,
                                "timestamp": time.time(),
                                "session_id": channel,
                                "data": data,
                            },
                        }
                    )
                )
    except Exception as e:  # noqa: BLE001 — never propagate to the REST request
        logger.debug("Board event %s not delivered (%s)", event_type, e)


def emit_board_event(project_id: str, event_type: str, data: dict) -> None:
    """Schedule a board event broadcast on the project channel (non-blocking)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (sync context/tests) — board sync is best-effort
    loop.create_task(_send(f"project:{project_id}", event_type, data))
