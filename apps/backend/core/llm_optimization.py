"""
LLM Token Optimization — Common Trunk
=====================================

Provider-agnostic token optimizations shared by every (provider, model, effort)
pair used by the Kanban pipeline, plus small provider-specific parameter layers.

Design (matches industry guidance from Anthropic / OpenAI / Google docs):

1. **Stable prefix** — every provider with prompt caching (Anthropic explicit,
   OpenAI automatic >= 1024 tokens, Gemini implicit) caches on an exact prefix
   match. The shared system prompt is built once here so all providers send the
   same byte-stable text, and volatile data never leads the prompt.

2. **Single system prompt source** — `build_base_system_prompt()` replaces the
   four copies that used to live inline in `core/client.py` (Claude / Copilot /
   Windsurf / OpenAI branches). One source of truth, no drift.

3. **Effort mapping** — the Kanban thinking level (none/low/medium/high/
   ultrathink, stored as an Anthropic-style token budget) is translated to each
   provider's native effort control:
     - Anthropic: handled natively by the Claude Agent SDK (`max_thinking_tokens`)
     - OpenAI reasoning models (o-series, gpt-5*): `reasoning_effort`
     - others: no equivalent — omitted (the trunk never sends unknown params)

4. **Prompt-cache routing** — OpenAI's automatic caching benefits from a
   `prompt_cache_key` so requests of the same task/phase land on the same cache
   shard. Anthropic/Gemini need nothing (SDK / implicit).

5. **Tool-result truncation** — one shared head+tail truncation (errors usually
   sit at the END of a build/test output, so plain `[:N]` loses them).

6. **History compaction** — the generic multi-turn loops (OpenAI-style message
   lists used by Copilot / OpenAI / Windsurf) grow unbounded: old tool results
   are re-sent at full price on every turn. `compact_messages()` elides stale
   tool results once the conversation exceeds a char budget. It only triggers
   ABOVE the budget so the cacheable prefix stays byte-stable for normal-sized
   sessions (compacting early would invalidate the automatic prefix cache every
   turn, costing more than it saves).

The Claude path is intentionally untouched beyond the shared system prompt:
the Claude Agent SDK already performs prompt caching (1h TTL is enabled in
core/client.py), context management and dynamic tool loading.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# 1+2. Shared system prompt (single source of truth, byte-stable)
# ---------------------------------------------------------------------------

# Static instructions first (cache-friendly ordering); the working directory is
# appended after — it is stable for the lifetime of a task/worktree, so the
# whole prompt remains a stable prefix within a task.
_BASE_PROMPT_STATIC = (
    "You are an expert full-stack developer building production-quality software. "
)

_BASE_PROMPT_RULES = (
    "Your filesystem access is RESTRICTED to this directory only. "
    "Use relative paths (starting with ./) for all file operations. "
    "Never use absolute paths or try to access files outside your working directory.\n\n"
    "You follow existing code patterns, write clean maintainable code, and verify "
    "your work through thorough testing. You communicate progress through Git commits "
    "and build-progress.txt updates."
)

# Extra paragraph for providers whose tool calling needs an explicit nudge
# (Windsurf text-based tool calling, OpenAI REST loop).
_TOOL_USE_HINT = (
    "\n\n"
    "You MUST use the provided tools (read_file, write_file, list_files, run_command) "
    "to interact with the filesystem and execute commands. Do not just describe what to do — "
    "actually do it by calling the tools."
)


def build_base_system_prompt(
    project_dir: Path | str,
    *,
    tool_use_hint: bool = False,
) -> str:
    """Build the shared agent system prompt used by every provider branch.

    Args:
        project_dir: Working directory of the agent (resolved to absolute).
        tool_use_hint: Append the explicit "use the tools" paragraph required
            by providers without native agentic tool training (Windsurf gRPC
            text-mode, OpenAI generic loop).

    Returns:
        The system prompt string. Byte-stable for a given (project_dir,
        tool_use_hint) pair — never embed timestamps or per-request data here,
        it would invalidate provider-side prompt caches on every call.
    """
    resolved = Path(project_dir).resolve()
    prompt = (
        f"{_BASE_PROMPT_STATIC}"
        f"Your working directory is: {resolved}\n"
        f"{_BASE_PROMPT_RULES}"
    )
    if tool_use_hint:
        prompt += _TOOL_USE_HINT
    return prompt


# ---------------------------------------------------------------------------
# 3. Effort mapping (thinking budget -> provider-native effort)
# ---------------------------------------------------------------------------

# Budget thresholds mirror phase_config.THINKING_BUDGET_MAP
# (none=None, low=1024, medium=4096, high=16384, ultrathink=63999).
_OPENAI_EFFORT_BY_LEVEL: dict[str, str | None] = {
    "none": None,  # omit the parameter entirely
    "low": "low",
    "medium": "medium",
    "high": "high",
    # xhigh exists only on the newest OpenAI models; "high" is accepted by all
    # reasoning models, so it is the safe ceiling for ultrathink.
    "ultrathink": "high",
}

# Models that accept the `reasoning_effort` chat-completions parameter:
# o-series (o1, o3, o4-mini, ...) and gpt-5 family. gpt-4o/gpt-4.1 reject it.
_OPENAI_REASONING_MODEL_RE = re.compile(r"^(o\d|gpt-5)")


def _thinking_level_from_budget(budget: int | None) -> str:
    """Map an Anthropic-style thinking budget back to its effort level name."""
    try:
        from phase_config import thinking_level_from_budget

        level = thinking_level_from_budget(budget)
    except Exception:  # pragma: no cover - import edge case
        level = "none" if budget is None else "medium"
    return level if level in _OPENAI_EFFORT_BY_LEVEL else "medium"


def openai_reasoning_effort(
    model: str,
    thinking_budget: int | None,
) -> str | None:
    """Translate the Kanban thinking budget to OpenAI's `reasoning_effort`.

    Returns None when the parameter must be omitted (non-reasoning model, or
    effort level "none").
    """
    if not model or not _OPENAI_REASONING_MODEL_RE.match(model):
        return None
    level = _thinking_level_from_budget(thinking_budget)
    return _OPENAI_EFFORT_BY_LEVEL.get(level)


# ---------------------------------------------------------------------------
# 4. Prompt-cache routing key (OpenAI automatic caching)
# ---------------------------------------------------------------------------


def openai_prompt_cache_key(spec_dir: Path | str | None, agent_type: str) -> str | None:
    """Stable per-(task, phase) cache key for OpenAI's `prompt_cache_key`.

    OpenAI caches prompt prefixes automatically (>= 1024 tokens) but routes by
    prefix hash; a stable key makes consecutive sessions of the same task/phase
    land on the same cache shard, raising hit rates between coder sessions.
    """
    if spec_dir is None:
        return None
    task = Path(spec_dir).name or "task"
    return f"workpilot/{task}/{agent_type}"


# ---------------------------------------------------------------------------
# 5. Tool-result truncation (shared by all generic loops)
# ---------------------------------------------------------------------------

# Hard cap on a single tool result sent back to the model. Overridable for
# experimentation; 10_000 chars (~2.5k tokens) matches the previous per-client
# constants (10000 OpenAI/Copilot, 8000 Windsurf).
_DEFAULT_TOOL_RESULT_MAX_CHARS = 10_000


def tool_result_max_chars() -> int:
    """Max chars of a tool result kept in context (env: LLM_TOOL_RESULT_MAX_CHARS)."""
    try:
        return max(1000, int(os.environ.get("LLM_TOOL_RESULT_MAX_CHARS", "")))
    except (TypeError, ValueError):
        return _DEFAULT_TOOL_RESULT_MAX_CHARS


def truncate_tool_result(text: str, limit: int | None = None) -> str:
    """Truncate a tool result keeping the head AND the tail.

    Build/test outputs put the verdict (error, summary line) at the END; a
    plain `text[:N]` drops exactly the part the model needs. Keep 70% head /
    30% tail with an explicit elision marker so the model knows content is
    missing.
    """
    if text is None:
        return ""
    cap = limit if limit is not None else tool_result_max_chars()
    if len(text) <= cap:
        return text
    head = int(cap * 0.7)
    tail = cap - head
    omitted = len(text) - head - tail
    return (
        f"{text[:head]}\n"
        f"... [{omitted} chars omitted — output truncated to save context] ...\n"
        f"{text[-tail:]}"
    )


# ---------------------------------------------------------------------------
# 6. History compaction for OpenAI-style message lists
# ---------------------------------------------------------------------------

# Total conversation budget before old tool results get elided.
# ~300k chars ≈ 75k tokens — large enough that typical coder sessions never
# trigger compaction (preserving the provider-side prefix cache), small enough
# to keep runaway sessions inside every provider's context window.
_DEFAULT_HISTORY_CHAR_BUDGET = 300_000

# Recent messages always kept verbatim (the model needs the immediate context
# of the work in progress).
_KEEP_RECENT_MESSAGES = 8

_ELIDED_PLACEHOLDER = "[tool result elided to save context — re-run the tool if needed]"

# Windsurf text-mode embeds tool results in user messages with this prefix.
_TEXT_TOOL_RESULT_RE = re.compile(r"^<tool_result\b")


def history_char_budget() -> int:
    """Conversation char budget before compaction (env: LLM_HISTORY_CHAR_BUDGET)."""
    try:
        return max(50_000, int(os.environ.get("LLM_HISTORY_CHAR_BUDGET", "")))
    except (TypeError, ValueError):
        return _DEFAULT_HISTORY_CHAR_BUDGET


def _message_len(message: dict) -> int:
    content = message.get("content")
    return len(content) if isinstance(content, str) else 0


def should_inline_file_context(
    provider: str | None,
    thinking_budget: int | None,
) -> bool:
    """Decide whether the coder prompt should inline file contents.

    The subtask prompt can embed up to ~200 lines of every `files_to_modify`
    and `patterns_from` file. Whether that helps depends on the
    (provider, effort) pair:

    - **Claude/Anthropic** (or unresolved → defaults to Claude): the Agent SDK
      coder always re-reads files with its Read tool before editing (the
      prompt instructs it to), so inline content is duplicated input paid on
      every turn of the session. Skip it.
    - **Generic providers at none/low/medium effort**: the model is expected
      to minimize tool round-trips; guided inline context keeps it performant
      and one inline costs about the same as one read_file round-trip.
    - **Generic providers at high/ultrathink effort**: the model explores by
      itself (and must re-read any file longer than the 200-line inline cap
      anyway) — inline is mostly duplicated. Skip it.

    Env override: LLM_INLINE_FILE_CONTEXT = always | never | auto (default).

    Note for callers: resolve `provider` WITHOUT side effects (e.g.
    `phase_config.get_phase_provider`) — never via
    `core.client._get_active_provider`, which consumes the single-shot
    RESUME_WITH_PROVIDER marker.
    """
    policy = os.environ.get("LLM_INLINE_FILE_CONTEXT", "auto").strip().lower()
    if policy == "always":
        return True
    if policy == "never":
        return False

    if provider is None or provider in ("claude", "anthropic"):
        return False
    level = _thinking_level_from_budget(thinking_budget)
    return level in ("none", "low", "medium")


def compact_messages(
    messages: list[dict],
    *,
    char_budget: int | None = None,
    keep_recent: int = _KEEP_RECENT_MESSAGES,
) -> int:
    """Elide stale tool results in an OpenAI-style message list (in place).

    Only triggers when the total content size exceeds `char_budget`. Never
    touches: the system message(s), the first user message (the task prompt),
    assistant messages (they carry tool_calls structure), or the `keep_recent`
    most recent messages. Eligible messages are elided oldest-first until the
    conversation fits the budget.

    Returns the number of messages elided (0 when under budget).
    """
    budget = char_budget if char_budget is not None else history_char_budget()
    total = sum(_message_len(m) for m in messages)
    if total <= budget:
        return 0

    # Locate the first user message (task prompt) — protected.
    first_user_idx = next(
        (i for i, m in enumerate(messages) if m.get("role") == "user"), None
    )
    cutoff = max(0, len(messages) - keep_recent)

    elided = 0
    for idx, msg in enumerate(messages):
        if total <= budget:
            break
        if idx >= cutoff or idx == first_user_idx:
            continue
        role = msg.get("role")
        content = msg.get("content")
        if not isinstance(content, str) or len(content) <= len(_ELIDED_PLACEHOLDER):
            continue

        is_tool_message = role == "tool"
        is_text_tool_result = role == "user" and _TEXT_TOOL_RESULT_RE.match(content)
        if not (is_tool_message or is_text_tool_result):
            continue

        total -= len(content) - len(_ELIDED_PLACEHOLDER)
        msg["content"] = _ELIDED_PLACEHOLDER
        elided += 1

    return elided
