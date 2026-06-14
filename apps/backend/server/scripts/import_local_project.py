"""Import an existing local project into the multi-user server.

Registers the project in the DB, clones its remote into REPOS_ROOT, then
copies the local ``.workpilot/`` state (specs, plans, logs) into the clone
and indexes it — so a team can pick up exactly where the single-user
install left off.

Usage (from apps/backend, with server-mode env vars set):

    python -m server.scripts.import_local_project \
        --name "MeCa" \
        --repo-url https://dev.azure.com/ebp/MeCa/_git/MeCa \
        --local-path C:/Users/me/Repositories/MeCa \
        --owner-email admin@ebp.fr \
        [--default-branch develop]

Prerequisite: the local repo's work (branches, commits) must already be
pushed to the remote; only ``.workpilot/`` metadata is copied here.
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
from pathlib import Path


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--repo-url", required=True)
    parser.add_argument("--local-path", required=True, type=Path)
    parser.add_argument("--owner-email", required=True)
    parser.add_argument("--default-branch", default="main")
    args = parser.parse_args()

    from server.db.engine import dispose_engine, get_session_factory, init_db
    from server.db.models import Project, ProjectMember, ProjectRole, User
    from server.services.repos import RepoError, clone_project
    from server.services.spec_indexer import reindex_project
    from sqlalchemy import select

    local_workpilot = args.local_path / ".workpilot"
    if not local_workpilot.is_dir():
        print(f"Error: {local_workpilot} not found", file=sys.stderr)
        return 1

    await init_db()
    try:
        async with get_session_factory()() as db:
            owner = await db.scalar(select(User).where(User.email == args.owner_email))
            if owner is None:
                print(
                    f"Error: no user {args.owner_email} (create the admin first)",
                    file=sys.stderr,
                )
                return 1

            project = Project(
                name=args.name,
                repo_url=args.repo_url,
                default_branch=args.default_branch,
                server_path="",
                created_by=owner.id,
            )
            db.add(project)
            await db.flush()

            try:
                dest = await clone_project(
                    project.id, args.repo_url, args.default_branch
                )
            except RepoError as e:
                print(f"Clone failed: {e}", file=sys.stderr)
                await db.rollback()
                return 1

            project.server_path = str(dest)
            db.add(
                ProjectMember(
                    project_id=project.id,
                    user_id=owner.id,
                    role=ProjectRole.OWNER.value,
                )
            )

            # Copy .workpilot state (specs/plans/logs), excluding worktrees
            # and locks which are machine-specific.
            dest_workpilot = dest / ".workpilot"
            shutil.copytree(
                local_workpilot,
                dest_workpilot,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("worktrees", ".locks"),
            )

            await db.commit()
            rows = await reindex_project(db, project)
            print(f"Project imported: {project.name} (id={project.id})")
            print(f"  clone: {dest}")
            print(f"  specs indexed: {len(rows)}")
        return 0
    finally:
        await dispose_engine()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
