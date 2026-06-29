"""Tests for per-LLM plan snapshots (snapshot_plan_for_model).

Each planning run archives the plan under plans/<provider>-<model>.json so plans
from different LLMs can be compared. Survives a task reset (plans/ is not a run
artifact).
"""

from __future__ import annotations

import json
from pathlib import Path

from qa.criteria import plan_snapshot_slug, snapshot_plan_for_model


def _write_plan(spec_dir: Path, plan: dict) -> None:
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def test_snapshot_writes_per_model_file(tmp_path: Path) -> None:
    _write_plan(tmp_path, {"feature": "x", "phases": [{"id": "p1"}]})
    out = snapshot_plan_for_model(tmp_path, "ollama", "llama3.1:latest", valid=True)
    assert out is not None and out.parent.name == "plans"
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["provider"] == "ollama"
    assert data["model"] == "llama3.1:latest"
    assert data["valid"] is True
    assert data["plan"]["phases"] == [{"id": "p1"}]
    assert "captured_at" in data


def test_one_file_per_model_latest_wins(tmp_path: Path) -> None:
    _write_plan(tmp_path, {"phases": [{"id": "a"}]})
    first = snapshot_plan_for_model(tmp_path, "ollama", "llama3.1", valid=False)
    _write_plan(tmp_path, {"phases": [{"id": "b"}]})
    second = snapshot_plan_for_model(tmp_path, "ollama", "llama3.1", valid=True)
    # Same (provider, model) → same file, overwritten with the latest run.
    assert first == second
    data = json.loads(second.read_text(encoding="utf-8"))
    assert data["plan"]["phases"] == [{"id": "b"}]
    assert data["valid"] is True


def test_distinct_models_get_distinct_files(tmp_path: Path) -> None:
    _write_plan(tmp_path, {"phases": []})
    a = snapshot_plan_for_model(tmp_path, "ollama", "llama3.1", valid=False)
    b = snapshot_plan_for_model(tmp_path, "anthropic", "claude-opus-4-8", valid=True)
    assert a != b
    files = sorted(p.name for p in (tmp_path / "plans").iterdir())
    assert len(files) == 2


def test_no_plan_returns_none(tmp_path: Path) -> None:
    assert snapshot_plan_for_model(tmp_path, "ollama", "llama3.1", valid=True) is None


def test_unparseable_plan_returns_none(tmp_path: Path) -> None:
    # The exact "{" truncation case must not crash or snapshot garbage.
    (tmp_path / "implementation_plan.json").write_text("{", encoding="utf-8")
    assert snapshot_plan_for_model(tmp_path, "ollama", "llama3.1", valid=False) is None


def test_slug_is_filename_safe(tmp_path: Path) -> None:
    assert plan_snapshot_slug("ollama", "llama3.1:latest") == "ollama-llama3-1-latest"
    assert plan_snapshot_slug("", "") == "unknown"
