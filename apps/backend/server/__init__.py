"""WorkPilot AI — multi-user server mode.

This package contains everything specific to the centrally-deployed,
multi-user variant of the backend:

- ``server.config``     — environment-driven settings (DB, JWT, Entra ID, repos root)
- ``server.db``         — SQLAlchemy async engine + ORM models + Alembic migrations
- ``server.auth``       — local accounts (argon2), Entra ID OIDC, JWT issuance
- ``server.routers``    — FastAPI routers (/auth, /users, /projects, /specs)
- ``server.services``   — spec indexer (FS <-> DB), repo manager, run manager

The classic single-user local mode is untouched: when ``WORKPILOT_SERVER_MODE``
is not enabled, none of this package is activated by ``provider_api``.
"""
