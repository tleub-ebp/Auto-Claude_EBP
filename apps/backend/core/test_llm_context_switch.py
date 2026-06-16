"""Tests for LLM context-switch tracing (`_log_llm_context_switch`).

Every execution phase resolves its agent client through `create_agent_client`,
which records the active (provider, model, effort) in `.llm_context.json` and,
when it changes, writes a human-readable trace into the task activity feed. These
tests cover the change-detection logic and the per-spec activity-feed attribution.
"""

from __future__ import annotations

import json
from pathlib import Path

from core.client import LLM_CONTEXT_STATE_FILE, _log_llm_context_switch
from task_logger import LogPhase, clear_task_logger, get_task_logger


def _feed_entries(spec_dir: Path) -> list[dict]:
    """Flatten all activity-feed entries across phases for assertions."""
    tl = get_task_logger(spec_dir, emit_markers=False)
    assert tl is not None
    entries: list[dict] = []
    for phase in tl.get_logs().get("phases", {}).values():
        entries.extend(phase.get("entries", []))
    return entries


def _state(spec_dir: Path) -> dict:
    return json.loads((spec_dir / LLM_CONTEXT_STATE_FILE).read_text(encoding="utf-8"))


def test_first_call_writes_baseline_state(tmp_path: Path) -> None:
    clear_task_logger()
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    assert _state(tmp_path) == {
        "provider": "anthropic",
        "model": "claude-opus-4-8",
        "thinking": "medium",
    }


def test_baseline_is_traced_with_effort(tmp_path: Path) -> None:
    clear_task_logger()
    tl = get_task_logger(tmp_path, emit_markers=False)
    tl.start_phase(LogPhase.VALIDATION)

    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")

    infos = [e for e in _feed_entries(tmp_path) if e.get("type") == "info"]
    baseline = [e for e in infos if "Contexte LLM initial" in e["content"]]
    assert len(baseline) == 1
    assert "anthropic" in baseline[0]["content"]
    # The thinking effort is now part of the trace.
    assert "Effort : medium" in baseline[0]["content"]


def test_provider_change_is_traced(tmp_path: Path) -> None:
    clear_task_logger()
    tl = get_task_logger(tmp_path, emit_markers=False)
    tl.start_phase(LogPhase.VALIDATION)

    # Isolate a provider-only switch by keeping model + effort identical.
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    _log_llm_context_switch(tmp_path, "copilot", "claude-opus-4-8", "medium")

    infos = [e for e in _feed_entries(tmp_path) if e.get("type") == "info"]
    switch = [e for e in infos if "Changement de contexte LLM" in e["content"]]
    assert len(switch) == 1
    assert "Fournisseur : anthropic → copilot" in switch[0]["content"]
    # Only the provider changed — model/effort lines must be omitted.
    assert "Modèle" not in switch[0]["content"]
    assert "Effort" not in switch[0]["content"]
    assert _state(tmp_path) == {
        "provider": "copilot",
        "model": "claude-opus-4-8",
        "thinking": "medium",
    }


def test_effort_only_change_is_traced(tmp_path: Path) -> None:
    clear_task_logger()
    tl = get_task_logger(tmp_path, emit_markers=False)
    tl.start_phase(LogPhase.VALIDATION)

    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "ultrathink")

    infos = [e for e in _feed_entries(tmp_path) if e.get("type") == "info"]
    switch = [e for e in infos if "Changement de contexte LLM" in e["content"]]
    assert len(switch) == 1
    assert "Effort : medium → ultrathink" in switch[0]["content"]
    # Provider/model unchanged — only the effort line is present.
    assert "Fournisseur" not in switch[0]["content"]
    assert "Modèle" not in switch[0]["content"]


def test_model_and_effort_change_listed_together(tmp_path: Path) -> None:
    clear_task_logger()
    tl = get_task_logger(tmp_path, emit_markers=False)
    tl.start_phase(LogPhase.CODING)

    _log_llm_context_switch(tmp_path, "anthropic", "claude-sonnet-4-6", "low")
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "high")

    infos = [e for e in _feed_entries(tmp_path) if e.get("type") == "info"]
    switch = [e for e in infos if "Changement de contexte LLM" in e["content"]]
    assert len(switch) == 1
    assert "Modèle : claude-sonnet-4-6 → claude-opus-4-8" in switch[0]["content"]
    assert "Effort : low → high" in switch[0]["content"]


def test_unchanged_context_emits_nothing_new(tmp_path: Path) -> None:
    clear_task_logger()
    tl = get_task_logger(tmp_path, emit_markers=False)
    tl.start_phase(LogPhase.CODING)

    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    before = len(_feed_entries(tmp_path))
    # Repeated identical calls (e.g. one client per subtask) must stay quiet.
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    _log_llm_context_switch(tmp_path, "anthropic", "claude-opus-4-8", "medium")
    after = len(_feed_entries(tmp_path))
    assert after == before


def test_no_active_feed_does_not_crash_and_still_persists(tmp_path: Path) -> None:
    """When no global task logger is registered (e.g. non-kanban runners), the
    trace is still recorded to state without raising."""
    clear_task_logger()
    _log_llm_context_switch(tmp_path, "openai", "gpt-5.5", "high")
    assert _state(tmp_path) == {
        "provider": "openai",
        "model": "gpt-5.5",
        "thinking": "high",
    }


def test_feed_not_contaminated_for_other_spec(tmp_path: Path) -> None:
    """A switch for spec B must not be written into spec A's active feed."""
    clear_task_logger()
    spec_a = tmp_path / "a"
    spec_b = tmp_path / "b"
    spec_a.mkdir()
    spec_b.mkdir()

    # Global logger is bound to spec A.
    tl_a = get_task_logger(spec_a, emit_markers=False)
    tl_a.start_phase(LogPhase.CODING)

    # ...but the switch is for spec B.
    _log_llm_context_switch(spec_b, "anthropic", "claude-opus-4-8", "medium")

    # spec A's feed must contain no LLM-context trace (only its own phase entry).
    contamination = [
        e
        for e in _feed_entries(spec_a)
        if "Contexte LLM" in e.get("content", "")
        or "Changement" in e.get("content", "")
    ]
    assert contamination == []
    assert (spec_b / LLM_CONTEXT_STATE_FILE).exists()
    clear_task_logger()
