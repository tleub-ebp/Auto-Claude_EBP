"""Dashboard + Session History endpoints.

Extracted from provider_api.py. Mounted via app.include_router(router).

Frontend traffic: GET /api/sessions/{projectId} is called by
SessionHistory.tsx. Path/method/response shape are preserved verbatim
to avoid breaking that caller.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from fastapi import APIRouter

try:
    from provider_api import _safe_error_message
except ImportError:
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


def _load_dashboard_snapshot(project_id: str) -> dict:
    """Load dashboard_snapshot.json written by core.usage_tracker.

    project_id is the project path (URL-decoded by FastAPI).
    """
    base_dir = Path.cwd().resolve()
    try:
        project_path = (base_dir / project_id).resolve()
        project_path.relative_to(base_dir)
    except Exception:
        return {}

    if not project_path.is_dir():
        return {}
    snap_path = project_path / ".workpilot" / "dashboard_snapshot.json"
    if snap_path.is_file() and str(snap_path.resolve()).startswith(str(project_path)):
        try:
            return json.loads(snap_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "tasks_by_status": {},
        "avg_completion_by_complexity": {},
        "qa_first_pass_rate": 0.0,
        "qa_avg_score": 0.0,
        "total_tokens": 0,
        "tokens_by_provider": {},
        "total_cost": 0.0,
        "cost_by_model": {},
        "merge_auto_count": 0,
        "merge_manual_count": 0,
    }


@router.get("/api/dashboard/snapshot/{project_id:path}")
def get_dashboard_snapshot(project_id: str):
    try:
        snap = _load_dashboard_snapshot(project_id)
        auto = snap.get("merge_auto_count", 0)
        manual = snap.get("merge_manual_count", 0)
        total_merges = auto + manual
        merge_rate = (auto / total_merges * 100) if total_merges > 0 else 0.0
        snap["merge_auto_rate"] = merge_rate
        avg_compl = {}
        for k, v in snap.get("avg_completion_by_complexity", {}).items():
            if isinstance(v, list) and v:
                avg_compl[k] = sum(v) / len(v)
            else:
                avg_compl[k] = v or 0.0
        snap["avg_completion_by_complexity"] = avg_compl
        return {"success": True, "snapshot": snap}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/dashboard/stats")
def get_dashboard_stats():
    return {"success": True, "stats": {}}


@router.get("/api/dashboard/export/{project_id:path}")
def export_dashboard(project_id: str, fmt: str = "json"):
    try:
        snap = _load_dashboard_snapshot(project_id)
        if fmt == "csv":
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(["metric", "value"])
            for k, v in snap.items():
                if not k.startswith("_"):
                    writer.writerow([k, v])
            return {"success": True, "report": buf.getvalue(), "format": "csv"}
        return {"success": True, "report": snap, "format": "json"}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- Session History ---
@router.get("/api/sessions/{project_id}")
def get_sessions(project_id: str):
    """Frontend caller: SessionHistory.tsx — preserve shape verbatim."""
    try:
        from agents.session_history import SessionRecorder

        sh = SessionRecorder(project_id=project_id)
        sessions = sh.list_sessions()
        return {
            "success": True,
            "sessions": [
                s.to_dict() if hasattr(s, "to_dict") else s.__dict__ for s in sessions
            ],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
