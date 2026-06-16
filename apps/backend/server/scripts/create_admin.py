"""Seed the first admin account.

Usage (from apps/backend, with server-mode env vars set):

    python -m server.scripts.create_admin admin@ebp.fr [--name "Admin"]

The password is read from WORKPILOT_ADMIN_PASSWORD or prompted.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import sys


async def _main() -> int:
    parser = argparse.ArgumentParser(description="Create a WorkPilot admin account")
    parser.add_argument("email", help="Admin email address")
    parser.add_argument("--name", default="Administrator", help="Display name")
    args = parser.parse_args()

    password = os.environ.get("WORKPILOT_ADMIN_PASSWORD") or getpass.getpass(
        "Admin password (min 12 chars): "
    )

    from server.auth.local import LocalAuthError, create_local_user
    from server.db.engine import dispose_engine, get_session_factory, init_db

    await init_db()
    try:
        async with get_session_factory()() as db:
            user = await create_local_user(
                db,
                email=args.email,
                password=password,
                display_name=args.name,
                role="admin",
            )
        print(f"Admin created: {user.email} (id={user.id})")
        return 0
    except LocalAuthError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        await dispose_engine()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
