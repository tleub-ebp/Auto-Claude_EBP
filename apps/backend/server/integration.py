"""Wires multi-user server mode into the existing FastAPI app.

Called unconditionally from ``provider_api``; does nothing unless
``WORKPILOT_SERVER_MODE`` is enabled, so local mode keeps its exact
historical behavior (no auth, no DB).
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from server.config import get_settings

logger = logging.getLogger(__name__)

# Paths reachable without a bearer token in server mode.
PUBLIC_PATHS = {
    "/auth/login",
    "/auth/refresh",
    "/auth/logout",
    "/auth/oidc/exchange",
    "/auth/config",
    "/auth/invitations/lookup",
    "/auth/invitations/accept",
    "/health",
    "/docs",
    "/openapi.json",
}

_db_ready = False
_db_init_lock: asyncio.Lock | None = None


async def _ensure_db_ready() -> None:
    """Lazy one-time schema init, executed inside uvicorn's event loop.

    Production runs ``alembic upgrade head`` before boot; this makes
    ``create_all`` a cheap no-op while keeping dev/test setups zero-step.
    """
    global _db_ready, _db_init_lock
    if _db_ready:
        return
    if _db_init_lock is None:
        _db_init_lock = asyncio.Lock()
    async with _db_init_lock:
        if _db_ready:
            return
        from server.db.engine import init_db

        await init_db()
        _db_ready = True
        logger.info("Server-mode database initialized")


def mount_server_mode(app: FastAPI) -> bool:
    """Activate auth middleware + multi-user routers. Returns True if active."""
    settings = get_settings()
    if not settings.server_mode:
        return False

    from server.auth.jwt_tokens import TokenError, decode_access_token
    from server.routers.auth import router as auth_router

    app.include_router(auth_router)

    try:
        from server.routers.invitations import router as invitations_router

        app.include_router(invitations_router)
    except ImportError as e:
        logger.warning("Server mode: invitations router unavailable: %s", e)

    try:
        from server.routers.projects import router as projects_router

        app.include_router(projects_router)
    except ImportError as e:
        logger.warning("Server mode: projects router unavailable: %s", e)

    try:
        from server.routers.specs import router as specs_router

        app.include_router(specs_router)
    except ImportError as e:
        logger.warning("Server mode: specs router unavailable: %s", e)

    try:
        from server.routers.users import router as users_router

        app.include_router(users_router)
    except ImportError as e:
        logger.warning("Server mode: users router unavailable: %s", e)

    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next):
        await _ensure_db_ready()

        if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JSONResponse(
                status_code=401, content={"detail": "Authentication required"}
            )
        try:
            claims = decode_access_token(auth[len("Bearer ") :].strip())
        except TokenError as e:
            return JSONResponse(status_code=401, content={"detail": str(e)})

        # Make the principal available to legacy endpoints that want
        # attribution without depending on server.auth.deps.
        request.state.user_id = claims["sub"]
        request.state.user_email = claims.get("email", "")
        request.state.user_role = claims.get("role", "member")
        return await call_next(request)

    logger.info("WorkPilot server mode ACTIVE (multi-user, auth required)")
    return True
