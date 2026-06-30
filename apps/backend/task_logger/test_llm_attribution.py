"""Tests for per-model attribution of task-log entries (TaskLogger.set_llm).

Each phase resolves its agent client for a (provider, model); ``set_llm()``
stamps that identity onto every subsequent entry so the UI can group a phase's
log by model and compare plans from different LLMs (e.g. after a mid-phase
switch).
"""

from __future__ import annotations

from pathlib import Path

from task_logger import LogEntryType, LogPhase, TaskLogger


def _entries(logger: TaskLogger, phase: LogPhase) -> list[dict]:
    return logger.get_logs()["phases"][phase.value]["entries"]


def test_set_llm_stamps_subsequent_entries(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.PLANNING)
    logger.set_llm("ollama", "llama3.1:latest")
    logger.log("analyse du depot", LogEntryType.TEXT, print_to_console=False)
    logger.tool_start("Read", "spec.md", print_to_console=False)
    logger.tool_end("Read", success=True, print_to_console=False)

    stamped = [e for e in _entries(logger, LogPhase.PLANNING) if e.get("model")]
    assert stamped, "expected at least one stamped entry"
    for e in stamped:
        assert e["provider"] == "ollama"
        assert e["model"] == "llama3.1:latest"


def test_entries_before_set_llm_are_unattributed(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.PLANNING)  # before any set_llm

    # to_dict() drops None fields, so unattributed entries carry neither key.
    entries = _entries(logger, LogPhase.PLANNING)
    assert entries  # phase-start entry exists
    assert all("model" not in e and "provider" not in e for e in entries)


def test_mid_phase_switch_attributes_each_run(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.PLANNING)

    logger.set_llm("anthropic", "claude-haiku-4-5")
    logger.log("plan A", LogEntryType.TEXT, print_to_console=False)

    logger.set_llm("ollama", "llama3.1:latest")
    logger.log("plan B", LogEntryType.TEXT, print_to_console=False)

    by_content = {e["content"]: e for e in _entries(logger, LogPhase.PLANNING)}
    assert by_content["plan A"]["provider"] == "anthropic"
    assert by_content["plan A"]["model"] == "claude-haiku-4-5"
    assert by_content["plan B"]["provider"] == "ollama"
    assert by_content["plan B"]["model"] == "llama3.1:latest"


def test_set_llm_none_clears_attribution(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.CODING)
    logger.set_llm("ollama", "llama3.1:latest")
    logger.set_llm(None, None)
    logger.log("unattributed", LogEntryType.TEXT, print_to_console=False)

    entry = next(
        e for e in _entries(logger, LogPhase.CODING) if e["content"] == "unattributed"
    )
    assert "model" not in entry
    assert "provider" not in entry


def test_log_with_detail_is_also_stamped(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.VALIDATION)
    logger.set_llm("copilot", "claude-opus-4-8")
    logger.log_with_detail("résumé", "détail complet", print_to_console=False)

    entry = next(e for e in _entries(logger, LogPhase.VALIDATION) if e.get("detail"))
    assert entry["provider"] == "copilot"
    assert entry["model"] == "claude-opus-4-8"
