"""Tests for the deterministic pieces of the Voice Control runner.

The LLM-driven path (``_process_with_ai``) needs the Claude SDK and is
exercised by the integration suite. This file pins the keyword
classifier, prompt builders, and JSON-response parser — all pure
functions on transcripts and strings.
"""

from __future__ import annotations

import json

import pytest
from runners.voice_control_runner import VoiceControlProcessor


@pytest.fixture
def processor() -> VoiceControlProcessor:
    # model_id / thinking_budget are required by the constructor but unused
    # by the deterministic code paths under test. setup_client() either
    # initialises a real client (no token needed for that part) or logs a
    # warning — either way the instance is usable for the methods below.
    return VoiceControlProcessor(model_id="ignored", thinking_budget=0)


# ---------------------------------------------------------------------------
# _classify_command — keyword router


class TestClassifyCommand:
    @pytest.mark.parametrize(
        "transcript,expected_destination",
        [
            ("Show me the kanban board", "kanban"),
            ("Open the terminal view", "terminals"),
            ("Show me the analytics dashboard", "analytics"),
            ("Open the project settings", "settings"),
            ("Navigate to the code review", "code-review"),
            ("Open the documentation", "documentation"),
        ],
    )
    def test_english_navigation_phrases_route_correctly(
        self,
        processor: VoiceControlProcessor,
        transcript: str,
        expected_destination: str,
    ) -> None:
        result = processor._classify_command(transcript)
        assert result["action"] == "navigate"
        assert result["parameters"]["destination"] == expected_destination
        assert result["confidence"] >= 0.75

    @pytest.mark.parametrize(
        "transcript,expected_destination",
        [
            ("Ouvre le tableau de tâches", "kanban"),
            ("Va dans les paramètres", "settings"),
            ("Montre-moi les statistiques", "analytics"),
            ("Affiche la documentation", "documentation"),
        ],
    )
    def test_french_navigation_phrases_route_correctly(
        self,
        processor: VoiceControlProcessor,
        transcript: str,
        expected_destination: str,
    ) -> None:
        result = processor._classify_command(transcript)
        assert result["action"] == "navigate"
        assert result["parameters"]["destination"] == expected_destination

    def test_navigation_verb_boosts_confidence(
        self, processor: VoiceControlProcessor
    ) -> None:
        with_verb = processor._classify_command("Open the kanban board")
        bare = processor._classify_command("kanban")
        assert with_verb["confidence"] == 0.9
        assert bare["confidence"] == 0.75

    def test_unrecognised_command_returns_unknown(
        self, processor: VoiceControlProcessor
    ) -> None:
        result = processor._classify_command("Tell me a joke about quantum physics")
        assert result["action"] == "unknown"
        assert result["parameters"] == {}
        assert result["confidence"] == 0.3

    def test_transcript_preserved_verbatim(
        self, processor: VoiceControlProcessor
    ) -> None:
        original = "Show me the KaNbAn board NOW"
        result = processor._classify_command(original)
        # Original casing kept in transcript/command, lowered only for matching.
        assert result["transcript"] == original
        assert result["command"] == original

    def test_empty_transcript_is_unknown(
        self, processor: VoiceControlProcessor
    ) -> None:
        result = processor._classify_command("")
        assert result["action"] == "unknown"
        assert result["confidence"] == 0.3


# ---------------------------------------------------------------------------
# Error result helper


class TestCreateErrorResult:
    def test_basic_shape(self, processor: VoiceControlProcessor) -> None:
        result = processor._create_error_result("hi", "msg")
        assert result == {
            "transcript": "hi",
            "command": "hi",
            "action": "error",
            "parameters": {},
            "confidence": 0.0,
        }

    def test_includes_error_field_when_provided(
        self, processor: VoiceControlProcessor
    ) -> None:
        result = processor._create_error_result("hi", "msg", error="boom")
        assert result["error"] == "boom"


# ---------------------------------------------------------------------------
# Prompt builders


class TestPromptBuilders:
    def test_user_prompt_embeds_transcript(
        self, processor: VoiceControlProcessor
    ) -> None:
        prompt = processor._build_user_prompt("open settings")
        assert '"open settings"' in prompt
        assert "navigate" in prompt
        assert "destinations" in prompt.lower()

    def test_system_prompt_default(self, processor: VoiceControlProcessor) -> None:
        prompt = processor._build_system_prompt()
        assert "voice command classifier" in prompt.lower()
        assert "json" in prompt.lower()

    def test_system_prompt_includes_project_dir_when_set(self) -> None:
        p = VoiceControlProcessor(
            model_id="m", thinking_budget=0, project_dir="/repo/x"
        )
        assert "/repo/x" in p._build_system_prompt()


# ---------------------------------------------------------------------------
# AI response parser


class TestParseAiResponse:
    def test_parses_valid_json_response(self, processor: VoiceControlProcessor) -> None:
        raw = json.dumps(
            {
                "command": "open settings",
                "action": "navigate",
                "parameters": {"destination": "settings"},
                "confidence": 0.92,
            }
        )
        parsed = processor._parse_ai_response(raw, "open settings")
        assert parsed["action"] == "navigate"
        assert parsed["parameters"] == {"destination": "settings"}
        assert parsed["confidence"] == pytest.approx(0.92)

    def test_extracts_json_from_surrounding_text(
        self, processor: VoiceControlProcessor
    ) -> None:
        raw = (
            "Sure, here you go:\n"
            '{"command":"x","action":"navigate","parameters":{"destination":"kanban"},'
            '"confidence":0.8}\n'
            "Hope this helps."
        )
        parsed = processor._parse_ai_response(raw, "x")
        assert parsed["action"] == "navigate"
        assert parsed["parameters"]["destination"] == "kanban"

    def test_clamps_confidence_to_unit_interval(
        self, processor: VoiceControlProcessor
    ) -> None:
        too_high = processor._parse_ai_response('{"confidence": 12.5}', "x")
        too_low = processor._parse_ai_response('{"confidence": -3}', "x")
        assert too_high["confidence"] == 1.0
        assert too_low["confidence"] == 0.0

    def test_uses_transcript_as_fallback_command(
        self, processor: VoiceControlProcessor
    ) -> None:
        # No "command" field in the AI response → falls back to transcript.
        parsed = processor._parse_ai_response(
            '{"action":"navigate","parameters":{},"confidence":0.7}', "fallback"
        )
        assert parsed["command"] == "fallback"
        assert parsed["transcript"] == "fallback"

    def test_invalid_json_returns_unknown_fallback(
        self, processor: VoiceControlProcessor
    ) -> None:
        parsed = processor._parse_ai_response("not json at all", "hello")
        assert parsed["action"] == "unknown"
        assert parsed["confidence"] == 0.3
        assert parsed["transcript"] == "hello"

    def test_response_with_no_braces_returns_fallback(
        self, processor: VoiceControlProcessor
    ) -> None:
        parsed = processor._parse_ai_response("plain text reply", "hello")
        assert parsed["action"] == "unknown"
        assert parsed["confidence"] == 0.3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
