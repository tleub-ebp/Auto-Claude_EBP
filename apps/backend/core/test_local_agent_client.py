#!/usr/bin/env python3
"""
Tests for LocalAgentClient (OpenAI-compatible local LLM servers)
================================================================

Covers base-URL normalization, source-priority resolution, the optional-key
placeholder, provider identity, and the forced-off OpenAI-only payload params.
These are pure/offline checks — no local server is contacted.
"""

import pytest
from core.agent_client import (
    LocalAgentClient,
    _extract_text_tool_calls,
    _looks_like_waiting_for_human,
    _next_no_tool_action,
    _normalize_local_base_url,
    _resolve_local_base_url,
)


class TestExtractTextToolCalls:
    """Recovering tool calls that a local model emitted as JSON text."""

    KNOWN = {"read_file", "write_file", "run_command"}

    def test_bare_json_object(self):
        content = '{"name": "read_file", "arguments": {"path": "./spec.md"}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {"function": {"name": "read_file", "arguments": {"path": "./spec.md"}}}
        ]

    def test_fenced_json_block_in_prose(self):
        content = (
            "Sure, let me read the spec first:\n"
            '```json\n{"name": "read_file", "arguments": {"path": "spec.md"}}\n```\n'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert len(out) == 1
        assert out[0]["function"]["name"] == "read_file"

    def test_function_wrapper_shape(self):
        content = '{"function": {"name": "run_command", "arguments": {"cmd": "ls"}}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"cmd": "ls"}

    def test_unknown_tool_name_ignored(self):
        # A plain data object with a "name" key must NOT be taken as a tool call.
        out = _extract_text_tool_calls('{"name": "John", "age": 30}', self.KNOWN)
        assert out == []

    def test_string_arguments_are_parsed(self):
        content = '{"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"path": "a.txt"}

    def test_no_known_tools_returns_empty(self):
        out = _extract_text_tool_calls('{"name": "read_file"}', set())
        assert out == []

    # ── XML-style tool calls (Windsurf <tool_call>, qwen/llama <tool_use>) ──

    def test_xml_tool_use_with_json_body(self):
        # The exact shape llama3.1 emitted: <tool_use name="..."> + JSON args.
        content = (
            '<tool_use name="write_file">\n'
            '{"path": "./build-progress.txt", "content": "ok"}\n'
            "</tool_use>"
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {
                "function": {
                    "name": "write_file",
                    "arguments": {"path": "./build-progress.txt", "content": "ok"},
                }
            }
        ]

    def test_xml_tool_call_tag_and_prose_wrapper(self):
        content = (
            "Let me run the tests now.\n"
            '<tool_call name="run_command">{"command": "pytest -q"}</tool_call>\n'
            "Done."
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["name"] == "run_command"
        assert out[0]["function"]["arguments"] == {"command": "pytest -q"}

    def test_xml_unknown_tool_ignored(self):
        out = _extract_text_tool_calls(
            '<tool_use name="DropDatabase">{"x": 1}</tool_use>', self.KNOWN
        )
        assert out == []

    def test_xml_no_args_yields_empty_arguments(self):
        out = _extract_text_tool_calls(
            '<tool_use name="run_command"></tool_use>', self.KNOWN
        )
        assert out == [{"function": {"name": "run_command", "arguments": {}}}]

    def test_xml_and_json_deduplicated(self):
        # Same call expressed twice (XML + JSON) collapses to one.
        content = (
            '<tool_use name="read_file">{"path": "a.txt"}</tool_use>\n'
            '{"name": "read_file", "arguments": {"path": "a.txt"}}'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}
        ]


_LOCAL_ENV_VARS = (
    "OLLAMA_BASE_URL",
    "LOCAL_LLM_BASE_URL",
    "LMSTUDIO_BASE_URL",
    "OLLAMA_API_KEY",
    "LOCAL_LLM_API_KEY",
    "LMSTUDIO_API_KEY",
)


@pytest.fixture(autouse=True)
def _clear_local_env(monkeypatch):
    """Each test starts from a clean local-LLM env so results are deterministic."""
    for var in _LOCAL_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


class TestNormalizeLocalBaseUrl:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # bare root → append /v1/chat/completions; localhost pinned to IPv4
            ("http://localhost:11434", "http://127.0.0.1:11434/v1/chat/completions"),
            ("http://localhost:1234", "http://127.0.0.1:1234/v1/chat/completions"),
            # trailing slash tolerated
            ("http://localhost:1234/", "http://127.0.0.1:1234/v1/chat/completions"),
            # /v1 already present
            ("http://localhost:1234/v1", "http://127.0.0.1:1234/v1/chat/completions"),
            ("http://localhost:1234/v1/", "http://127.0.0.1:1234/v1/chat/completions"),
            # full path is idempotent (and still IPv4-pinned)
            (
                "http://localhost:1234/v1/chat/completions",
                "http://127.0.0.1:1234/v1/chat/completions",
            ),
            # an explicit 127.0.0.1 passes through unchanged
            (
                "http://127.0.0.1:11434",
                "http://127.0.0.1:11434/v1/chat/completions",
            ),
            # a non-loopback host is NOT rewritten
            (
                "http://192.168.1.50:11434",
                "http://192.168.1.50:11434/v1/chat/completions",
            ),
            # empty/None → IPv4 Ollama default
            ("", "http://127.0.0.1:11434/v1/chat/completions"),
            (None, "http://127.0.0.1:11434/v1/chat/completions"),
        ],
    )
    def test_normalization(self, raw, expected):
        assert _normalize_local_base_url(raw) == expected

    def test_localhost_without_port_is_pinned(self):
        # No explicit port: the loopback host is still rewritten to IPv4.
        assert (
            _normalize_local_base_url("http://localhost")
            == "http://127.0.0.1/v1/chat/completions"
        )

    def test_lookalike_host_not_rewritten(self):
        # "localhostfoo" is a different host — the boundary check must not touch it.
        assert _normalize_local_base_url("http://localhostfoo:11434").startswith(
            "http://localhostfoo:11434"
        )


class TestResolveLocalBaseUrl:
    def test_explicit_arg_wins(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:9999")
        assert (
            _resolve_local_base_url("http://localhost:1234")
            == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_env_used_when_no_arg(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        assert (
            _resolve_local_base_url(None) == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_lmstudio_env_supported(self, monkeypatch):
        monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234")
        assert (
            _resolve_local_base_url(None) == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_default_when_nothing_set(self, monkeypatch):
        # No env, and force the saved-config lookup to yield nothing.
        monkeypatch.setattr(
            "core.agent_client._resolve_local_base_url",
            _resolve_local_base_url,
        )
        # load_provider_config may or may not exist on the host; the result must
        # still fall back to the Ollama default rather than raise.
        result = _resolve_local_base_url(None)
        assert result.endswith("/v1/chat/completions")


class TestLocalAgentClient:
    def test_provider_name_is_ollama(self):
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client.provider_name() == "ollama"

    def test_tool_calling_unsupported_defaults_false(self):
        # The "this model can't tool-call" verdict starts unset; receive_response
        # flips it only after a turn-0 no-tool-call. handle_local_model_no_tools
        # reads it to halt agentic phases fast.
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client.tool_calling_unsupported is False

    def test_base_url_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client._api_base == "http://127.0.0.1:1234/v1/chat/completions"

    def test_explicit_base_url_arg(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:8080/v1")
        assert client._api_base == "http://127.0.0.1:8080/v1/chat/completions"

    def test_api_key_placeholder_when_unset(self):
        client = LocalAgentClient(model="m")
        # Non-empty so the inherited missing-key guard doesn't abort the loop.
        assert client._api_key == "local"

    def test_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_API_KEY", "secret-token")
        client = LocalAgentClient(model="m")
        assert client._api_key == "secret-token"

    def test_openai_only_params_forced_off(self):
        client = LocalAgentClient(
            model="m", reasoning_effort="high", prompt_cache_key="abc"
        )
        assert client._reasoning_effort is None
        assert client._prompt_cache_key is None

    def test_default_model(self):
        client = LocalAgentClient()
        assert client.model == "llama3.3"

    def test_native_chat_url_derived_from_base(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        assert client._native_chat_url() == "http://127.0.0.1:11434/api/chat"

    def test_native_chat_url_with_custom_port(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:1234/v1")
        assert client._native_chat_url() == "http://127.0.0.1:1234/api/chat"

    def test_num_ctx_default_and_env(self, monkeypatch):
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        assert LocalAgentClient(model="m")._num_ctx() == 8192
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "16384")
        assert LocalAgentClient(model="m")._num_ctx() == 16384

    def test_connection_error_message_is_friendly(self):
        """A connection failure is rephrased into an actionable Ollama hint."""
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        msg = client._describe_request_error(
            OSError("Cannot connect to host localhost:11434 ssl:default")
        )
        assert "Ollama ne répond pas" in msg
        # The hint shows the IPv4-pinned root the client actually dials.
        assert "http://127.0.0.1:11434" in msg
        assert "Télécharger" in msg
        # The raw aiohttp text must not leak through.
        assert "ssl:default" not in msg

    def test_non_connection_error_passthrough(self):
        """A genuine API error (not a connection failure) keeps its detail."""
        client = LocalAgentClient(model="m")
        msg = client._describe_request_error(ValueError("model not found"))
        assert "model not found" in msg
        assert "Ollama ne répond pas" not in msg


class TestNextNoToolAction:
    """The decision for a turn that returned no tool call: end / nudge / give_up."""

    def test_empty_reply_ends(self):
        # No content at all → nothing to nudge against, just stop.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=False,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "end"
        )

    def test_finished_after_using_tools_ends(self):
        # The model acted earlier and now stops with prose (not waiting on a
        # human) → legitimately done.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=5,
                max_turns=50,
            )
            == "end"
        )

    def test_no_tools_offered_ends(self):
        # A text-only session (no tools) ending with prose is not a failure.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=False,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "end"
        )

    def test_first_narration_triggers_nudge(self):
        # Tools offered, model narrated, never acted, not yet nudged → nudge once.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "nudge"
        )

    def test_waiting_for_human_after_acting_triggers_nudge(self):
        # Even after calling a tool, asking a human to run commands is a stall —
        # there is no human to answer, so nudge it to act on its own.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=True,
                nudge_sent=False,
                turn=2,
                max_turns=50,
            )
            == "nudge"
        )

    def test_waiting_for_human_after_nudge_gives_up(self):
        # Already nudged and still deferring to a human → unable to self-drive.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=True,
                nudge_sent=True,
                turn=3,
                max_turns=50,
            )
            == "give_up"
        )

    def test_narration_after_nudge_gives_up(self):
        # Already nudged and still only narrating → unable to drive tools.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=True,
                turn=1,
                max_turns=50,
            )
            == "give_up"
        )

    def test_no_nudge_on_last_turn(self):
        # No room left to retry → give up rather than nudge into nothing.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=49,
                max_turns=50,
            )
            == "give_up"
        )


class TestLooksLikeWaitingForHuman:
    """Detecting a model that defers to a human instead of acting."""

    @pytest.mark.parametrize(
        "text",
        [
            "Please execute this command and provide the output.",
            "```bash\nls ./Sources/\n```\nPlease execute this command and provide the output.",
            "Could you run the tests and let me know the result?",
            "Please provide the directory structure of the project.",
            "Paste the output here so I can continue.",
        ],
    )
    def test_detects_deferral(self, text):
        assert _looks_like_waiting_for_human(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "I created the plan and wrote implementation_plan.json.",
            "Please review the implementation plan before merging.",
            "The investigation is complete; all files are in place.",
        ],
    )
    def test_ignores_normal_prose(self, text):
        assert _looks_like_waiting_for_human(text) is False
