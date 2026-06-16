"""FS <-> DB reconciliation for specs.

The ``.workpilot/specs/`` folders in the server-side clone remain the source
of truth for spec *content and status*; ``specs_index`` rows carry what the
FS cannot (attribution, claims) and make board queries cheap.

Rules:
- A spec dir present on FS but absent from the DB  -> row created.
- Status on FS differs from the row               -> row updated (FS wins).
- Row exists but the spec dir vanished             -> row deleted.
- ``claimed_by`` / ``created_by`` are DB-only and never touched by the
  indexer, except that terminal statuses release stale claims.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from server.db.models import Project, SpecIndex
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

#: Statuses after which an exclusive claim no longer makes sense.
RELEASING_STATUSES = {"human_review", "done"}

DEFAULT_STATUS = "backlog"


def _read_spec_status(spec_dir: Path) -> str:
    """Status of one spec dir, as the UI understands it.

    ``implementation_plan.json`` carries a ``status`` field synced with the
    kanban (backlog / in_progress / ai_review / human_review / done). A spec
    without a plan yet is in backlog.
    """
    plan_path = spec_dir / "implementation_plan.json"
    if not plan_path.exists():
        return DEFAULT_STATUS
    try:
        with open(plan_path, encoding="utf-8") as f:
            plan = json.load(f)
        return plan.get("status") or DEFAULT_STATUS
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("Unreadable plan %s: %s", plan_path, e)
        return DEFAULT_STATUS


def scan_specs_on_disk(server_path: str) -> dict[str, str]:
    """Map spec_name -> status for every spec dir in the clone."""
    specs_root = Path(server_path) / ".workpilot" / "specs"
    if not specs_root.is_dir():
        return {}
    result: dict[str, str] = {}
    for spec_dir in sorted(specs_root.iterdir()):
        if spec_dir.is_dir() and not spec_dir.name.startswith("."):
            result[spec_dir.name] = _read_spec_status(spec_dir)
    return result


async def reindex_project(db: AsyncSession, project: Project) -> list[SpecIndex]:
    """Reconcile specs_index with the FS for one project; returns fresh rows."""
    on_disk = scan_specs_on_disk(project.server_path)
    rows = list(
        await db.scalars(select(SpecIndex).where(SpecIndex.project_id == project.id))
    )
    by_name = {row.spec_name: row for row in rows}

    changed = False

    # New or updated specs
    for spec_name, status in on_disk.items():
        row = by_name.get(spec_name)
        if row is None:
            row = SpecIndex(project_id=project.id, spec_name=spec_name, status=status)
            db.add(row)
            by_name[spec_name] = row
            changed = True
        elif row.status != status:
            row.status = status
            changed = True
        if row.claimed_by and row.status in RELEASING_STATUSES:
            row.claimed_by = None
            row.claimed_at = None
            changed = True

    # Vanished specs
    for spec_name, row in list(by_name.items()):
        if spec_name not in on_disk:
            await db.delete(row)
            del by_name[spec_name]
            changed = True

    if changed:
        await db.commit()
    return list(by_name.values())
