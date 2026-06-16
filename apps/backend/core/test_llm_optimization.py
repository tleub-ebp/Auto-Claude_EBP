"""Tests for the LLM token-optimization common trunk (core/llm_optimization.py)."""

from pathlib import Path

import pytest
from core.llm_optimization import (
    _ELIDED_PLACEHOLDER,
    build_base_system_prompt,
    compact_messages,
    openai_prompt_cache_key,
    openai_reasoning_effort,
    should_inline_file_context,
    truncate_tool_result,
)

# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------


class TestBuildBaseSystemPrompt:
    def test_contains_working_directory(self, tmp_path: Path):
        prompt = build_base_system_prompt(tmp_path)
        assert str(tmp_path.resolve()) in prompt
        assert "expert full-stack developer" in prompt

    def test_byte_stable_for_same_inputs(self, tmp_path: Path):
        # Prompt caching is a prefix match — the builder must be deterministic.
        assert build_base_system_prompt(tmp_path) == build_base_system_prompt(tmp_path)

    def test_tool_use_hint_appended(self, tmp_path: Path):
        without = build_base_system_prompt(tmp_path)
        with_hint = build_base_system_prompt(tmp_path, tool_use_hint=True)
        assert "You MUST use the provided tools" not in without
        assert "You MUST use the provided tools" in with_hint
        # The hint is appended AFTER the stable base (cache-friendly ordering)
        assert with_hint.startswith(without)

    def test_accepts_string_path(self, tmp_path: Path):
        assert build_base_system_prompt(str(tmp_path)) == build_base_system_prompt(
            tmp_path
        )


# ---------------------------------------------------------------------------
# OpenAI effort mapping
# ---------------------------------------------------------------------------


class TestOpenAIReasoningEffort:
    @pytest.mark.parametrize(
        ("budget", "expected"),
        [
            (None, None),  # thinking "none" → omit the parameter
            (1024, "low"),
            (4096, "medium"),
            (16384, "high"),
            (63999, "high"),  # ultrathink capped at "high" (xhigh not universal)
        ],
    )
    def test_budget_mapping_on_reasoning_models(self, budget, expected):
        assert openai_reasoning_effort("gpt-5.5", budget) == expected
        assert openai_reasoning_effort("o3", budget) == expected

    def test_non_reasoning_models_get_no_effort(self):
        # gpt-4o / gpt-4.1 reject reasoning_effort — must be omitted
        assert openai_reasoning_effort("gpt-4o", 16384) is None
        assert openai_reasoning_effort("gpt-4.1-mini", 16384) is None

    def test_unknown_budget_falls_back_to_medium(self):
        assert openai_reasoning_effort("gpt-5.5", 12345) == "medium"

    def test_empty_model(self):
        assert openai_reasoning_effort("", 16384) is None


# ---------------------------------------------------------------------------
# OpenAI prompt cache key
# ---------------------------------------------------------------------------


class TestOpenAIPromptCacheKey:
    def test_stable_per_task_and_phase(self, tmp_path: Path):
        spec = tmp_path / "001-my-task"
        key1 = openai_prompt_cache_key(spec, "coder")
        key2 = openai_prompt_cache_key(spec, "coder")
        assert key1 == key2 == "workpilot/001-my-task/coder"

    def test_differs_per_agent_type(self, tmp_path: Path):
        spec = tmp_path / "001-my-task"
        assert openai_prompt_cache_key(spec, "coder") != openai_prompt_cache_key(
            spec, "qa_reviewer"
        )

    def test_none_spec_dir(self):
        assert openai_prompt_cache_key(None, "coder") is None


# ---------------------------------------------------------------------------
# Tool-result truncation
# ---------------------------------------------------------------------------


class TestTruncateToolResult:
    def test_short_text_unchanged(self):
        assert truncate_tool_result("hello", limit=100) == "hello"

    def test_none_returns_empty(self):
        assert truncate_tool_result(None) == ""

    def test_keeps_head_and_tail(self):
        # Build/test verdicts sit at the END — both ends must survive.
        text = "HEAD-" + ("x" * 50_000) + "-TAIL"
        out = truncate_tool_result(text, limit=1000)
        assert out.startswith("HEAD-")
        assert out.endswith("-TAIL")
        assert "omitted" in out
        # Stays within the cap + marker overhead
        assert len(out) < 1200

    def test_default_limit_from_env(self, monkeypatch):
        monkeypatch.setenv("LLM_TOOL_RESULT_MAX_CHARS", "2000")
        out = truncate_tool_result("y" * 10_000)
        assert len(out) < 2300

    def test_invalid_env_falls_back(self, monkeypatch):
        monkeypatch.setenv("LLM_TOOL_RESULT_MAX_CHARS", "not-a-number")
        assert truncate_tool_result("z" * 5000) == "z" * 5000  # under 10k default


# ---------------------------------------------------------------------------
# File-context inlining policy
# ---------------------------------------------------------------------------


class TestShouldInlineFileContext:
    def test_claude_never_inlines(self):
        # The Claude Agent SDK coder re-reads files via its Read tool — inline
        # content would be duplicated input paid on every turn.
        assert should_inline_file_context("claude", None) is False
        assert should_inline_file_context("anthropic", 16384) is False

    def test_unresolved_provider_defaults_to_claude_behavior(self):
        assert should_inline_file_context(None, 1024) is False

    @pytest.mark.parametrize("budget", [None, 1024, 4096])  # none/low/medium
    def test_generic_providers_inline_at_low_effort(self, budget):
        assert should_inline_file_context("copilot", budget) is True
        assert should_inline_file_context("openai", budget) is True
        assert should_inline_file_context("windsurf", budget) is True

    @pytest.mark.parametrize("budget", [16384, 63999])  # high/ultrathink
    def test_generic_providers_skip_at_high_effort(self, budget):
        assert should_inline_file_context("copilot", budget) is False
        assert should_inline_file_context("openai", budget) is False

    def test_env_override_always(self, monkeypatch):
        monkeypatch.setenv("LLM_INLINE_FILE_CONTEXT", "always")
        assert should_inline_file_context("claude", 63999) is True

    def test_env_override_never(self, monkeypatch):
        monkeypatch.setenv("LLM_INLINE_FILE_CONTEXT", "never")
        assert should_inline_file_context("copilot", None) is False

    def test_invalid_env_falls_back_to_auto(self, monkeypatch):
        monkeypatch.setenv("LLM_INLINE_FILE_CONTEXT", "whatever")
        assert should_inline_file_context("copilot", 1024) is True
        assert should_inline_file_context("claude", 1024) is False


# ---------------------------------------------------------------------------
# History compaction
# ---------------------------------------------------------------------------


def _conversation(n_tool_results: int, result_size: int = 5000) -> list[dict]:
    """Build an OpenAI-style conversation with n tool results."""
    messages: list[dict] = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "task prompt — implement the feature"},
    ]
    for i in range(n_tool_results):
        messages.append({"role": "assistant", "content": f"calling tool {i}"})
        messages.append(
            {"role": "tool", "tool_call_id": f"call_{i}", "content": "r" * result_size}
        )
    return messages


class TestCompactMessages:
    def test_noop_under_budget(self):
        messages = _conversation(3)
        before = [dict(m) for m in messages]
        assert compact_messages(messages, char_budget=1_000_000) == 0
        assert messages == before  # prefix untouched → provider cache preserved

    def test_elides_oldest_tool_results_first(self):
        messages = _conversation(20, result_size=10_000)
        elided = compact_messages(messages, char_budget=100_000, keep_recent=4)
        assert elided > 0
        # The OLDEST tool result was elided
        assert messages[3]["content"] == _ELIDED_PLACEHOLDER
        # tool_call_id structure preserved (API requires it)
        assert messages[3]["tool_call_id"] == "call_0"
        # The most recent tool result is intact
        assert messages[-1]["content"] == "r" * 10_000

    def test_protects_system_and_first_user_message(self):
        messages = _conversation(20, result_size=10_000)
        compact_messages(messages, char_budget=1, keep_recent=2)
        assert messages[0]["content"] == "system prompt"
        assert messages[1]["content"] == "task prompt — implement the feature"

    def test_protects_recent_messages(self):
        messages = _conversation(10, result_size=10_000)
        compact_messages(messages, char_budget=1, keep_recent=4)
        for msg in messages[-4:]:
            assert msg["content"] != _ELIDED_PLACEHOLDER

    def test_assistant_messages_never_elided(self):
        messages = _conversation(10, result_size=10_000)
        compact_messages(messages, char_budget=1, keep_recent=2)
        for msg in messages:
            if msg["role"] == "assistant":
                assert msg["content"].startswith("calling tool")

    def test_windsurf_text_mode_tool_results(self):
        # Windsurf gRPC text mode embeds results in user messages
        messages = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "task prompt"},
            {"role": "assistant", "content": "doing work"},
            {"role": "user", "content": "<tool_result name='run'>" + "x" * 50_000},
            {"role": "assistant", "content": "more work"},
            {"role": "user", "content": "<tool_result name='run2'>recent result"},
        ]
        elided = compact_messages(messages, char_budget=10_000, keep_recent=2)
        assert elided == 1
        assert messages[3]["content"] == _ELIDED_PLACEHOLDER
        # Recent text-mode result protected
        assert "recent result" in messages[5]["content"]

    def test_stops_once_under_budget(self):
        messages = _conversation(20, result_size=10_000)
        # Budget large enough that only ~2 elisions are needed
        compact_messages(messages, char_budget=190_000, keep_recent=2)
        elided_count = sum(
            1 for m in messages if m.get("content") == _ELIDED_PLACEHOLDER
        )
        assert 1 <= elided_count <= 3
