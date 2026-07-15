"""
Agent Coach — reconstruct run history from the usage ledger.

The Personal Coach reads ``<project>/.workpilot/agent-runs/*.json``, but nothing
ever wrote those files — a consumer without a producer (same shape as the carbon
ledger and the consensus arbiter). The data the coach needs already exists: every
LLM call is logged to ``.workpilot/cost_data.json`` by ``usage_tracker`` with
provider, model, tokens, cost, ``agent_type``, ``phase`` and ``spec_id``.

This module aggregates those per-call usages into one ``AgentRunRecord`` per
(task, agent) so the coach has real history to score — no new pipeline to wire.
It mirrors ``usage_tracker.backfill_carbon_ledger_from_cost_data``, which likewise
rebuilds from ``cost_data.json``.

Builds run inside worktrees, so ``cost_data.json`` exists under each worktree's
``.workpilot`` as well as the project root; we scan all of them.

Known limitation: ``cost_data.json`` records billing, not outcomes, so runs come
back ``success=True`` with ``duration_s=0`` and no retries/errors. The cost,
token and model-diversity tips are therefore accurate; the failure/latency tips
stay quiet until an outcome source (analytics ``BuildPhase``) is joined in.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from agent_coach.coach_engine import AgentRunRecord

logger = logging.getLogger(__name__)

COST_DATA_RELATIVE = Path(".workpilot") / "cost_data.json"


def _discover_cost_data_files(project_root: Path) -> list[Path]:
    """Every ``cost_data.json`` under the project: root plus all worktrees."""
    workpilot = project_root / ".workpilot"
    if not workpilot.exists():
        return []
    files: list[Path] = []
    root_file = workpilot / "cost_data.json"
    if root_file.is_file():
        files.append(root_file)
    files.extend(sorted(workpilot.glob("worktrees/**/cost_data.json")))
    return files


def _load_usages(path: Path) -> list[dict[str, Any]]:
    """Return the ``usages`` array from a cost_data.json file, or []."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    usages = data.get("usages") if isinstance(data, dict) else None
    if not isinstance(usages, list):
        return []
    return [u for u in usages if isinstance(u, dict)]


def aggregate_usages_to_runs(usages: list[dict[str, Any]]) -> list[AgentRunRecord]:
    """Collapse per-call usage records into one run per (task, agent).

    Tokens and cost are summed; the model is the one used most within the group;
    the run id ties back to the spec so the same agent on different tasks stays
    distinct.
    """
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for usage in usages:
        spec = str(usage.get("spec_id") or usage.get("task_id") or "")
        agent = str(usage.get("agent_type") or usage.get("phase") or "agent")
        group = groups.setdefault(
            (spec, agent),
            {"tokens": 0, "cost": 0.0, "models": {}, "calls": 0},
        )
        group["tokens"] += _as_int(usage.get("input_tokens")) + _as_int(
            usage.get("output_tokens")
        )
        group["cost"] += _as_float(usage.get("cost"))
        group["calls"] += 1
        model = str(usage.get("model") or "").strip()
        if model:
            group["models"][model] = group["models"].get(model, 0) + 1

    runs: list[AgentRunRecord] = []
    for (spec, agent), group in groups.items():
        models: dict[str, int] = group["models"]
        model = max(models, key=lambda k: models[k]) if models else ""
        runs.append(
            AgentRunRecord(
                agent_name=agent,
                run_id=f"{spec}:{agent}" if spec else agent,
                success=True,
                tokens_used=int(group["tokens"]),
                cost_usd=float(group["cost"]),
                model=model,
                metadata={
                    "spec_id": spec,
                    "source": "cost_data",
                    "llm_calls": group["calls"],
                },
            )
        )
    return runs


def load_agent_runs_from_usage(project_root: Path) -> list[AgentRunRecord]:
    """Build the coach's run history from every cost_data.json in the project."""
    usages: list[dict[str, Any]] = []
    for cost_file in _discover_cost_data_files(Path(project_root)):
        usages.extend(_load_usages(cost_file))
    return aggregate_usages_to_runs(usages)


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
