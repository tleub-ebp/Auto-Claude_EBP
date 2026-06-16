"""Shared slowapi rate limiter.

A single :class:`~slowapi.Limiter` instance is used across the whole app so
that ``@limiter.limit(...)`` decorators on routers defined in different
modules (provider_api, server.routers.*) all share the same state. Kept in
its own module with no project imports to avoid import cycles.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
