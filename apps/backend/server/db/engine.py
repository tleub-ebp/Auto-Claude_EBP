"""Async SQLAlchemy engine + session factory for server mode.

The engine is created lazily from :func:`server.config.get_settings` so that
importing this module in local mode has zero side effects.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from server.config import get_settings
from server.db.models import Base
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

logger = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        kwargs: dict = {"pool_pre_ping": True}
        if settings.database_url.startswith("sqlite"):
            # SQLite has no real pool; pre_ping is pointless and the file
            # may live in a directory that doesn't exist yet in dev.
            kwargs = {}
        _engine = create_async_engine(settings.database_url, **kwargs)
        logger.info(
            "Server DB engine created (%s)", settings.database_url.split("://")[0]
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding one session per request."""
    async with get_session_factory()() as session:
        yield session


async def init_db() -> None:
    """Create all tables if they don't exist.

    Used at startup as a safety net and by tests. Production deployments
    run ``alembic upgrade head`` first; ``create_all`` is a no-op then.
    """
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def dispose_engine() -> None:
    """Close the engine (shutdown / test teardown) and reset the cache."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
