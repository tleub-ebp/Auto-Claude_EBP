"""Rebuild comparable per-LLM task logs from existing conversation transcripts.

Models that ran before per-LLM ``task_logs`` tracking (or whose ``task_logs``
entries were flushed) still have a full ``conversation.<provider>-<model>.jsonl``
transcript. This converts each transcript into:

- a per-LLM ``task_logs.<provider>-<model>.json`` (the new per-file architecture), and
- (optionally) merged-back entries in the shared ``task_logs.json`` so the
  existing per-model grouping / compare UI shows them immediately.

The conversion is best-effort and lossy by design: it keeps the model's
*actions* (assistant narration + tool calls/results) and drops the giant user
prompts. Each transcript entry already carries its ``phase``.
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import LogEntry, LogEntryType, LogPhase
from .storage import LogStorage

# Conversation phases → task-log phases (qa/spec aren't task-log phases).
_PHASE_MAP = {
    "spec": LogPhase.PLANNING.value,
    "planning": LogPhase.PLANNING.value,
    "coding": LogPhase.CODING.value,
    "qa": LogPhase.VALIDATION.value,
    "validation": LogPhase.VALIDATION.value,
}
_MAX_LEN = 4000  # truncate long content so the feed stays light


def _phase_of(conv_phase: str | None) -> str:
    return _PHASE_MAP.get((conv_phase or "planning").lower(), LogPhase.PLANNING.value)


def _read_jsonl(path: Path) -> list[dict]:
    out: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue  # skip partial/corrupt lines
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _entry_to_log_entries(conv: dict) -> list[LogEntry]:
    """Convert one transcript entry into 0+ feed LogEntry (skips user prompts)."""
    role = conv.get("role")
    phase = _phase_of(conv.get("phase"))
    ts = conv.get("ts", "")
    provider = conv.get("provider")
    model = conv.get("model")
    out: list[LogEntry] = []
    for block in conv.get("content", []):
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            if role != "assistant":
                continue  # drop the huge user/system prompts
            text = (block.get("text") or "").strip()
            if not text:
                continue
            out.append(
                LogEntry(
                    timestamp=ts,
                    type=LogEntryType.TEXT.value,
                    content=text[:_MAX_LEN],
                    phase=phase,
                    provider=provider,
                    model=model,
                )
            )
        elif btype in ("tool_use", "tool_call"):
            name = block.get("name") or block.get("tool_name") or "tool"
            args = block.get("input") or block.get("arguments") or {}
            out.append(
                LogEntry(
                    timestamp=ts,
                    type=LogEntryType.TOOL_START.value,
                    content=str(name),
                    phase=phase,
                    tool_name=str(name),
                    tool_input=json.dumps(args, ensure_ascii=False)[:_MAX_LEN],
                    provider=provider,
                    model=model,
                )
            )
        elif btype == "tool_result":
            content = block.get("content")
            detail = (
                content
                if isinstance(content, str)
                else json.dumps(content, ensure_ascii=False)
            )
            out.append(
                LogEntry(
                    timestamp=ts,
                    type=LogEntryType.TOOL_END.value,
                    content=str(block.get("tool_name") or "tool"),
                    phase=phase,
                    detail=(detail or "")[:_MAX_LEN],
                    provider=provider,
                    model=model,
                )
            )
    return out


def rebuild_task_logs_from_conversations(
    spec_dir: Path, *, update_combined: bool = True
) -> list[Path]:
    """Build per-LLM ``task_logs.<slug>.json`` from ``conversation.*.jsonl``.

    Idempotent: re-running rebuilds each per-LLM file and refreshes that model's
    slice of the shared ``task_logs.json``. Returns the per-LLM files written.
    """
    from core.conversation_log import _log_slug

    spec_dir = Path(spec_dir)
    written: list[Path] = []
    combined = LogStorage(spec_dir) if update_combined else None

    for conv in sorted(spec_dir.glob("conversation.*.jsonl")):
        if conv.name in ("conversation.jsonl", "conversation.jsonl.migrated"):
            continue  # legacy single-file / archive, not a per-model log
        conv_entries = _read_jsonl(conv)
        if not conv_entries:
            continue
        provider = next(
            (e.get("provider") for e in conv_entries if e.get("provider")), None
        )
        model = next((e.get("model") for e in conv_entries if e.get("model")), None)
        if not (provider or model):
            continue

        feed: list[LogEntry] = []
        for ce in conv_entries:
            feed.extend(_entry_to_log_entries(ce))
        if not feed:
            continue

        per = LogStorage(spec_dir, f"task_logs.{_log_slug(provider, model)}.json")
        for ph in LogPhase:
            per.clear_phase(ph.value)  # rebuild from scratch (idempotent)
        per.add_entries(feed)
        written.append(per.log_file)

        if combined is not None:
            combined.remove_model_entries(provider, model)
            combined.add_entries(feed)

    if combined is not None:
        combined.save()
    return written
