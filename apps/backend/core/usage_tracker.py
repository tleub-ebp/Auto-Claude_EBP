"""
Usage Tracker — Records LLM token usage and costs from agent sessions.

Writes to three destinations:
  1. {project_dir}/.workpilot/cost_data.json       (CostEstimator IPC handler)
  2. analytics.db SQLite                              (AnalyticsDashboard REST API)
  3. {project_dir}/.workpilot/dashboard_snapshot.json (DashboardMetrics REST API)

Called from agents/session.py after each run_agent_session() call.
All writes are best-effort: errors are logged but never propagated to the caller.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-file locks — serialise concurrent read-modify-write on JSON snapshots
# within the same process (covers parallel subagents / async tasks).
# ---------------------------------------------------------------------------

_file_locks: dict[str, threading.Lock] = {}
_file_locks_mutex = threading.Lock()


def _get_file_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _file_locks_mutex:
        if key not in _file_locks:
            _file_locks[key] = threading.Lock()
        return _file_locks[key]


def _atomic_write(path: Path, content: str) -> None:
    """Write *content* to *path* atomically via a sibling .tmp file + rename."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# In-process build registry  (one entry per active spec_dir)
# ---------------------------------------------------------------------------

_active_builds: dict[str, dict] = {}  # str(spec_dir) -> build_info


def start_build(
    spec_dir: Path,
    project_dir: Path,
    spec_id: str,
    spec_name: str | None,
    model: str,
    provider: str,
) -> str:
    """Register a new build session. Returns a build_id UUID."""
    build_id = str(uuid.uuid4())
    _active_builds[str(spec_dir)] = {
        "build_id": build_id,
        "spec_id": spec_id,
        "spec_name": spec_name or spec_id,
        "project_dir": str(project_dir),
        "model": model,
        "provider": provider,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_creation_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_cost": 0.0,
    }
    logger.debug("[usage_tracker] Build started: %s (%s)", build_id, spec_id)
    return build_id


def finish_build(spec_dir: Path, status: str = "complete") -> None:
    """Finalize the build record and write it to analytics DB."""
    key = str(spec_dir)
    info = _active_builds.pop(key, None)
    if not info:
        return

    info["completed_at"] = datetime.now(timezone.utc).isoformat()
    info["status"] = status

    # Persist to analytics DB
    try:
        _write_build_to_analytics_db(info)
    except Exception as exc:
        logger.warning("[usage_tracker] Could not write build to analytics DB: %s", exc)

    logger.debug("[usage_tracker] Build finished: %s (%s)", info["build_id"], status)


def record_session_usage(
    spec_dir: Path,
    project_dir: Path,
    phase: str,
    agent_type: str,
    model: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> None:
    """
    Record usage from one agent session. All writes are best-effort.

    Args:
        spec_dir:                     Spec directory (.workpilot/specs/001-name/)
        project_dir:                  Project root directory
        phase:                        Phase name ("planning", "coding", "qa_review", etc.)
        agent_type:                   Agent type ("planner", "coder", "qa_reviewer", etc.)
        model:                        Model name used (e.g. "claude-sonnet-4-6")
        provider:                     Provider name (e.g. "anthropic")
        input_tokens:                 Non-cached input tokens billed at full rate
        output_tokens:                Output tokens consumed
        cost_usd:                     Total cost in USD (SDK estimate)
        cache_creation_input_tokens:  Tokens written to a new cache entry (premium rate)
        cache_read_input_tokens:      Tokens read from an existing cache entry (reduced rate)
    """
    spec_id = spec_dir.name

    # Update in-process build totals
    key = str(spec_dir)
    if key in _active_builds:
        _active_builds[key]["total_input_tokens"] += input_tokens
        _active_builds[key]["total_output_tokens"] += output_tokens
        _active_builds[key]["total_cache_creation_tokens"] = (
            _active_builds[key].get("total_cache_creation_tokens", 0)
            + cache_creation_input_tokens
        )
        _active_builds[key]["total_cache_read_tokens"] = (
            _active_builds[key].get("total_cache_read_tokens", 0)
            + cache_read_input_tokens
        )
        _active_builds[key]["total_cost"] += cost_usd

    # 1 — cost_data.json (for CostEstimator IPC handler)
    try:
        _append_cost_data(
            project_dir,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            agent_type,
            phase,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] cost_data.json write failed: %s", exc)

    # 2 — analytics.db (for AnalyticsDashboard REST API)
    try:
        _append_token_usage_to_db(
            key,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            phase,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] analytics DB write failed: %s", exc)

    # 3 — dashboard_snapshot.json (for DashboardMetrics REST API)
    try:
        _update_dashboard_snapshot(
            project_dir,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] dashboard_snapshot write failed: %s", exc)


# ---------------------------------------------------------------------------
# Destination 1: cost_data.json
# ---------------------------------------------------------------------------


def _append_cost_data(
    project_dir: Path,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    agent_type: str,
    phase: str,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> None:
    """Append a usage record to {project_dir}/.workpilot/cost_data.json."""
    data_path = project_dir / ".workpilot" / "cost_data.json"
    data_path.parent.mkdir(parents=True, exist_ok=True)

    with _get_file_lock(data_path):
        if data_path.exists():
            try:
                data = json.loads(data_path.read_text(encoding="utf-8"))
            except Exception:
                data = {"usages": [], "budgets": {}}
        else:
            data = {"usages": [], "budgets": {}}

        data.setdefault("usages", [])
        data["usages"].append(
            {
                "project_id": str(project_dir),
                "provider": provider,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation_input_tokens,
                "cache_read_input_tokens": cache_read_input_tokens,
                "cost": cost_usd,
                "task_id": spec_id,
                "agent_type": agent_type,
                "phase": phase,
                "spec_id": spec_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

        _atomic_write(data_path, json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Destination 2: analytics.db  (SQLite via SQLAlchemy)
# ---------------------------------------------------------------------------


def _get_analytics_db_session():
    """Return an analytics DB session, or None if unavailable."""
    try:
        from analytics.database import SessionLocal, create_tables

        create_tables()
        return SessionLocal()
    except Exception:
        return None


def _append_token_usage_to_db(
    build_key: str,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    phase: str,
) -> None:
    """Append a TokenUsage row to analytics.db.
    Also creates/updates the parent Build row if the build is known."""
    db = _get_analytics_db_session()
    if db is None:
        return

    try:
        from analytics.database_schema import Build, BuildStatus, TokenUsage

        build_info = _active_builds.get(build_key)
        build_id = build_info["build_id"] if build_info else str(uuid.uuid4())

        # Upsert Build row
        build = db.query(Build).filter(Build.build_id == build_id).first()
        if not build:
            build = Build(
                build_id=build_id,
                spec_id=spec_id,
                spec_name=build_info.get("spec_name", spec_id)
                if build_info
                else spec_id,
                project_path=build_info.get("project_dir") if build_info else None,
                started_at=datetime.now(timezone.utc),
                status=BuildStatus.CODING,
                llm_provider=provider,
                llm_model=model,
                total_tokens_used=0,
                total_cost_usd=0.0,
            )
            db.add(build)

        build.total_tokens_used = (
            (build.total_tokens_used or 0) + input_tokens + output_tokens
        )
        build.total_cost_usd = (build.total_cost_usd or 0.0) + cost_usd

        # Insert TokenUsage row
        token_row = TokenUsage(
            build_id=build_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            cost_usd=cost_usd,
            operation_type=phase,
            llm_provider=provider,
            llm_model=model,
            timestamp=datetime.now(timezone.utc),
        )
        db.add(token_row)
        db.commit()

    except Exception as exc:
        db.rollback()
        raise exc
    finally:
        db.close()


def _write_build_to_analytics_db(info: dict) -> None:
    """Finalize a Build row in analytics.db when the build ends."""
    db = _get_analytics_db_session()
    if db is None:
        return

    try:
        from analytics.database_schema import Build, BuildStatus

        build = db.query(Build).filter(Build.build_id == info["build_id"]).first()
        if build:
            build.completed_at = datetime.now(timezone.utc)
            build.status = (
                BuildStatus.COMPLETE
                if info["status"] == "complete"
                else BuildStatus.FAILED
            )
            if build.started_at:
                build.total_duration_seconds = (
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    - build.started_at.replace(tzinfo=None)
                ).total_seconds()
            db.commit()
    except Exception as exc:
        db.rollback()
        raise exc
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Destination 3: dashboard_snapshot.json
# ---------------------------------------------------------------------------


def _update_dashboard_snapshot(
    project_dir: Path,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> None:
    """Update {project_dir}/.workpilot/dashboard_snapshot.json.
    Accumulates token/cost totals and per-provider/model breakdowns."""
    snap_path = project_dir / ".workpilot" / "dashboard_snapshot.json"
    snap_path.parent.mkdir(parents=True, exist_ok=True)

    with _get_file_lock(snap_path):
        try:
            snap: dict = (
                json.loads(snap_path.read_text(encoding="utf-8"))
                if snap_path.exists()
                else {}
            )
        except Exception:
            snap = {}

        snap.setdefault("total_tokens", 0)
        snap.setdefault("total_cost", 0.0)
        snap.setdefault("total_cache_creation_tokens", 0)
        snap.setdefault("total_cache_read_tokens", 0)
        snap.setdefault("tokens_by_provider", {})
        snap.setdefault("cost_by_model", {})
        snap.setdefault("tasks_by_status", {})
        snap.setdefault("qa_first_pass_rate", 0.0)
        snap.setdefault("qa_avg_score", 0.0)
        snap.setdefault("merge_auto_count", 0)
        snap.setdefault("merge_manual_count", 0)
        snap.setdefault("avg_completion_by_complexity", {})

        total = input_tokens + output_tokens
        snap["total_tokens"] += total
        snap["total_cost"] = (snap["total_cost"] or 0.0) + cost_usd
        snap["total_cache_creation_tokens"] = (
            snap.get("total_cache_creation_tokens") or 0
        ) + cache_creation_input_tokens
        snap["total_cache_read_tokens"] = (
            snap.get("total_cache_read_tokens") or 0
        ) + cache_read_input_tokens
        snap["tokens_by_provider"][provider] = (
            snap["tokens_by_provider"].get(provider, 0) + total
        )
        model_key = f"{provider}/{model}"
        snap["cost_by_model"][model_key] = (
            snap["cost_by_model"].get(model_key) or 0.0
        ) + cost_usd
        snap["last_updated"] = datetime.now(timezone.utc).isoformat()

        _atomic_write(snap_path, json.dumps(snap, indent=2))


# ---------------------------------------------------------------------------
# Dashboard snapshot: task/QA/merge helpers (called from run.py / qa runners)
# ---------------------------------------------------------------------------


def record_task_status(
    project_dir: Path,
    spec_id: str,
    status: str,
    complexity: str = "medium",
    completion_seconds: float = 0.0,
) -> None:
    """Increment tasks_by_status counter in dashboard_snapshot.json."""
    try:
        snap_path = project_dir / ".workpilot" / "dashboard_snapshot.json"
        snap_path.parent.mkdir(parents=True, exist_ok=True)

        with _get_file_lock(snap_path):
            try:
                snap: dict = (
                    json.loads(snap_path.read_text(encoding="utf-8"))
                    if snap_path.exists()
                    else {}
                )
            except Exception:
                snap = {}

            snap.setdefault("tasks_by_status", {})
            snap["tasks_by_status"][status] = snap["tasks_by_status"].get(status, 0) + 1

            if status == "completed" and completion_seconds > 0:
                snap.setdefault("avg_completion_by_complexity", {})
                existing = snap["avg_completion_by_complexity"].get(complexity, [])
                if isinstance(existing, list):
                    existing.append(completion_seconds)
                else:
                    existing = [completion_seconds]
                snap["avg_completion_by_complexity"][complexity] = existing

            snap["last_updated"] = datetime.now(timezone.utc).isoformat()
            _atomic_write(snap_path, json.dumps(snap, indent=2))
    except Exception as exc:
        logger.warning("[usage_tracker] record_task_status failed: %s", exc)


def record_qa_result(
    project_dir: Path,
    spec_id: str,
    passed: bool,
    score: float = 0.0,
) -> None:
    """Update QA first-pass rate in dashboard_snapshot.json (running average)."""
    try:
        snap_path = project_dir / ".workpilot" / "dashboard_snapshot.json"
        snap_path.parent.mkdir(parents=True, exist_ok=True)

        with _get_file_lock(snap_path):
            try:
                snap: dict = (
                    json.loads(snap_path.read_text(encoding="utf-8"))
                    if snap_path.exists()
                    else {}
                )
            except Exception:
                snap = {}

            snap.setdefault("_qa_total", 0)
            snap.setdefault("_qa_passed", 0)
            snap.setdefault("_qa_score_sum", 0.0)
            snap["_qa_total"] += 1
            if passed:
                snap["_qa_passed"] += 1
            snap["_qa_score_sum"] += score

            snap["qa_first_pass_rate"] = snap["_qa_passed"] / snap["_qa_total"] * 100
            snap["qa_avg_score"] = snap["_qa_score_sum"] / snap["_qa_total"]
            snap["last_updated"] = datetime.now(timezone.utc).isoformat()
            _atomic_write(snap_path, json.dumps(snap, indent=2))
    except Exception as exc:
        logger.warning("[usage_tracker] record_qa_result failed: %s", exc)


def record_merge(project_dir: Path, automatic: bool) -> None:
    """Increment merge counters in dashboard_snapshot.json."""
    try:
        snap_path = project_dir / ".workpilot" / "dashboard_snapshot.json"
        snap_path.parent.mkdir(parents=True, exist_ok=True)

        with _get_file_lock(snap_path):
            try:
                snap: dict = (
                    json.loads(snap_path.read_text(encoding="utf-8"))
                    if snap_path.exists()
                    else {}
                )
            except Exception:
                snap = {}

            snap.setdefault("merge_auto_count", 0)
            snap.setdefault("merge_manual_count", 0)
            if automatic:
                snap["merge_auto_count"] += 1
            else:
                snap["merge_manual_count"] += 1
            snap["last_updated"] = datetime.now(timezone.utc).isoformat()
            _atomic_write(snap_path, json.dumps(snap, indent=2))
    except Exception as exc:
        logger.warning("[usage_tracker] record_merge failed: %s", exc)
