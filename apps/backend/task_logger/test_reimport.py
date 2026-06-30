"""Tests for rebuilding per-LLM task_logs from conversation transcripts."""

import json
from pathlib import Path

from task_logger.reimport import rebuild_task_logs_from_conversations
from task_logger.storage import load_task_logs


def _write_conv(spec_dir: Path, slug: str, entries: list[dict]) -> Path:
    p = spec_dir / f"conversation.{slug}.jsonl"
    p.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")
    return p


def test_rebuild_per_llm_and_combined(tmp_path: Path) -> None:
    _write_conv(
        tmp_path,
        "ollama-llama3.1-latest",
        [
            # A huge user prompt must be dropped.
            {
                "phase": "planning",
                "provider": "ollama",
                "model": "llama3.1:latest",
                "role": "user",
                "content": [{"type": "text", "text": "HUGE PROMPT" * 500}],
            },
            # Assistant narration + a tool call are kept.
            {
                "phase": "planning",
                "provider": "ollama",
                "model": "llama3.1:latest",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me read the spec."},
                    {
                        "type": "tool_use",
                        "name": "read_file",
                        "input": {"path": "spec.md"},
                    },
                ],
            },
        ],
    )

    written = rebuild_task_logs_from_conversations(tmp_path)
    assert len(written) == 1
    assert written[0].name == "task_logs.ollama-llama3.1-latest.json"

    per = json.loads(written[0].read_text(encoding="utf-8"))
    entries = per["phases"]["planning"]["entries"]
    assert [e["type"] for e in entries] == ["text", "tool_start"]
    assert entries[0]["content"] == "Let me read the spec."
    assert entries[1]["tool_name"] == "read_file"
    assert all(e["model"] == "llama3.1:latest" for e in entries)

    # The shared task_logs.json gets the same entries, tagged, for the existing UI.
    combined = load_task_logs(tmp_path)
    cplan = combined["phases"]["planning"]["entries"]
    assert len(cplan) == 2
    assert all(e["provider"] == "ollama" for e in cplan)


def test_multiple_models_idempotent(tmp_path: Path) -> None:
    _write_conv(
        tmp_path,
        "ollama-llama3.1-latest",
        [
            {
                "phase": "planning",
                "provider": "ollama",
                "model": "llama3.1:latest",
                "role": "assistant",
                "content": [{"type": "text", "text": "plan A"}],
            }
        ],
    )
    _write_conv(
        tmp_path,
        "claude-unknown",
        [
            {
                "phase": "coding",
                "provider": "claude",
                "model": "unknown",
                "role": "assistant",
                "content": [{"type": "text", "text": "code B"}],
            }
        ],
    )

    rebuild_task_logs_from_conversations(tmp_path)
    rebuild_task_logs_from_conversations(tmp_path)  # second run must not duplicate

    combined = load_task_logs(tmp_path)
    plan = combined["phases"]["planning"]["entries"]
    coding = combined["phases"]["coding"]["entries"]
    assert len(plan) == 1 and plan[0]["model"] == "llama3.1:latest"
    assert len(coding) == 1 and coding[0]["provider"] == "claude"


def test_qa_phase_maps_to_validation(tmp_path: Path) -> None:
    _write_conv(
        tmp_path,
        "ollama-x",
        [
            {
                "phase": "qa",
                "provider": "ollama",
                "model": "x",
                "role": "assistant",
                "content": [{"type": "text", "text": "validating"}],
            }
        ],
    )
    rebuild_task_logs_from_conversations(tmp_path, update_combined=False)
    per = json.loads((tmp_path / "task_logs.ollama-x.json").read_text(encoding="utf-8"))
    assert per["phases"]["validation"]["entries"][0]["content"] == "validating"
