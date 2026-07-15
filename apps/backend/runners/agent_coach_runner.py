"""
Agent Coach Runner

Discovers persisted agent run records under
``<project>/.workpilot/agent-runs/*.json``, feeds them into the CoachEngine,
and returns a personalised coaching report.

Record files should contain either a single run object or an array of run
objects with the keys documented in ``AgentRunRecord``.

Output protocol (one JSON object per line, prefixed):
    AGENT_COACH_EVENT:{"type": "progress", "data": {"status": "..."}}
    AGENT_COACH_RESULT:{"report": {...}}
    AGENT_COACH_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agent_coach import (  # noqa: E402
    AgentRunRecord,
    CoachEngine,
    CoachReport,
    CoachTip,
)

RUNS_SUBDIR = Path(".workpilot") / "agent-runs"


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("AGENT_COACH_EVENT", {"type": event_type, "data": data})


def _tip_to_dict(tip: CoachTip) -> dict[str, Any]:
    return {
        "category": tip.category.value,
        "priority": tip.priority.value,
        "title": tip.title,
        "description": tip.description,
        "evidence": tip.evidence,
        "action": tip.action,
    }


def _report_to_dict(report: CoachReport) -> dict[str, Any]:
    return {
        "tips": [_tip_to_dict(t) for t in report.tips],
        "totalRuns": report.total_runs,
        "successRate": report.success_rate,
        "avgCostUsd": report.avg_cost_usd,
        "totalCostUsd": report.total_cost_usd,
        "mostUsedModel": report.most_used_model,
        "mostFailingAgent": report.most_failing_agent,
        "summary": report.summary,
    }


def _parse_record(raw: dict[str, Any]) -> AgentRunRecord | None:
    agent_name = raw.get("agentName") or raw.get("agent_name")
    if not agent_name:
        return None
    return AgentRunRecord(
        agent_name=str(agent_name),
        run_id=str(raw.get("runId", raw.get("run_id", ""))),
        success=bool(raw.get("success", True)),
        duration_s=float(raw.get("durationS", raw.get("duration_s", 0.0))),
        tokens_used=int(raw.get("tokensUsed", raw.get("tokens_used", 0))),
        cost_usd=float(raw.get("costUsd", raw.get("cost_usd", 0.0))),
        errors=list(raw.get("errors", [])),
        retries=int(raw.get("retries", 0)),
        model=str(raw.get("model", "")),
    )


def _load_records(file_path: Path) -> list[AgentRunRecord]:
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []

    if isinstance(data, list):
        return [r for r in (_parse_record(item) for item in data) if r is not None]
    if isinstance(data, dict):
        parsed = _parse_record(data)
        return [parsed] if parsed else []
    return []


def _discover_run_files(project_path: Path) -> list[Path]:
    runs_dir = project_path / RUNS_SUBDIR
    if not runs_dir.exists():
        return []
    return sorted(p for p in runs_dir.glob("*.json") if p.is_file())


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering agent run records..."})
    run_files = _discover_run_files(project_path)

    engine = CoachEngine()
    total_records = 0
    for file_path in run_files:
        records = _load_records(file_path)
        if records:
            engine.record_batch(records)
            total_records += len(records)

    # No explicit agent-runs/*.json are written by the pipeline, so rebuild the
    # coach's history from the usage ledger (cost_data.json) that usage_tracker
    # already persists for every LLM call. Without this the panel is always
    # empty ("Aucun enregistrement d'exécution d'agent trouvé").
    try:
        from agent_coach.usage_ingest import load_agent_runs_from_usage

        usage_runs = load_agent_runs_from_usage(project_path)
        if usage_runs:
            engine.record_batch(usage_runs)
            total_records += len(usage_runs)
    except Exception as exc:  # pragma: no cover - best-effort ingest
        _emit_event("progress", {"status": f"Usage ledger ingest skipped: {exc}"})

    _emit_event(
        "progress",
        {"status": f"Loaded {total_records} run record(s), generating report..."},
    )

    report = engine.generate_report()
    _emit_event(
        "complete",
        {"totalRuns": report.total_runs, "tips": len(report.tips)},
    )
    return {"report": _report_to_dict(report)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent Coach Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("AGENT_COACH_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        result = run_scan(project_path)
        _emit("AGENT_COACH_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("AGENT_COACH_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
