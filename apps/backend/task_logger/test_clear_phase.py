"""clear_phase flushes a phase's entries so a fresh planning run starts clean
(re-planning with a different LLM no longer stacks the previous model's logs)."""

from pathlib import Path

from task_logger.logger import TaskLogger
from task_logger.models import LogPhase
from task_logger.storage import load_task_logs


def test_clear_phase_flushes_only_that_phase(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.PLANNING)
    logger.set_llm("anthropic", "claude-haiku-4-5")
    logger.log("old plan from haiku", print_to_console=False)
    logger.start_phase(LogPhase.CODING)
    logger.log("coding entry", print_to_console=False)

    logger.clear_phase(LogPhase.PLANNING)

    data = load_task_logs(tmp_path)
    assert data is not None
    planning = data["phases"][LogPhase.PLANNING.value]
    assert planning["entries"] == []
    assert planning["status"] == "pending"
    # Other phases are untouched.
    assert len(data["phases"][LogPhase.CODING.value]["entries"]) >= 1


def test_fresh_run_flushes_previous_llm(tmp_path: Path) -> None:
    logger = TaskLogger(tmp_path, emit_markers=False)
    logger.start_phase(LogPhase.PLANNING)
    logger.set_llm("anthropic", "claude-haiku-4-5")
    logger.log("haiku plan", print_to_console=False)

    # A fresh planning run with a different LLM flushes first (what coder.py does).
    logger.clear_phase(LogPhase.PLANNING)
    logger.set_llm("ollama", "llama3.1:latest")
    logger.start_phase(LogPhase.PLANNING)
    logger.log("llama plan", print_to_console=False)

    data = load_task_logs(tmp_path)
    entries = data["phases"][LogPhase.PLANNING.value]["entries"]
    assert len(entries) >= 1
    # Only the new model's attribution remains; haiku is gone.
    models = {e.get("model") for e in entries if e.get("model")}
    assert models == {"llama3.1:latest"}
