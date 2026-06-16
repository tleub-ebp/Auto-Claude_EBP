"""Tests for the AI refine parsing helpers (no live LLM calls)."""

from __future__ import annotations

import asyncio

from cost_intelligence.formula_refine import (
    _build_prompt,
    _loose_json,
    _parse_assessments,
    refine_formulas,
)


class TestParseAssessments:
    def test_parses_valid_payload(self):
        payload = {
            "assessments": [
                {
                    "key": "anthropic::opus::high",
                    "success_probability": 92,
                    "reason": "strong",
                },
                {
                    "key": "ollama::llama::low",
                    "success_probability": 40,
                    "reason": "weak",
                },
            ]
        }
        valid = {"anthropic::opus::high", "ollama::llama::low"}
        out = _parse_assessments(payload, valid)
        assert len(out) == 2
        assert out[0].success_probability == 0.92
        assert out[1].success_probability == 0.40

    def test_drops_unknown_keys(self):
        payload = {
            "assessments": [
                {"key": "ghost::x::y", "success_probability": 50, "reason": "r"}
            ]
        }
        assert _parse_assessments(payload, {"real::a::b"}) == []

    def test_clamps_out_of_range(self):
        payload = {
            "assessments": [{"key": "k", "success_probability": 150, "reason": "r"}]
        }
        out = _parse_assessments(payload, {"k"})
        assert out[0].success_probability == 1.0

    def test_handles_garbage(self):
        assert _parse_assessments(None, {"k"}) == []
        assert _parse_assessments({"assessments": "nope"}, {"k"}) == []
        assert _parse_assessments({}, {"k"}) == []

    def test_skips_non_numeric_probability(self):
        payload = {
            "assessments": [{"key": "k", "success_probability": "high", "reason": "r"}]
        }
        assert _parse_assessments(payload, {"k"}) == []


class TestLooseJson:
    def test_extracts_embedded_json(self):
        text = 'Sure! Here: {"assessments": []} hope that helps'
        assert _loose_json(text) == {"assessments": []}

    def test_returns_none_on_no_json(self):
        assert _loose_json("no json here") is None
        assert _loose_json("") is None


class TestBuildPrompt:
    def test_includes_each_candidate_key(self):
        candidates = [
            {
                "key": "a::b::c",
                "provider": "a",
                "model": "b",
                "effort": "c",
                "tier": "mid",
                "base_probability": 0.8,
            },
        ]
        prompt = _build_prompt("Do the thing", candidates)
        assert "a::b::c" in prompt
        assert "Do the thing" in prompt
        assert "80%" in prompt


class TestRefineNoCandidates:
    def test_empty_candidates_short_circuits(self):
        # Must return [] without touching the LLM client.
        out = asyncio.run(refine_formulas("desc", []))
        assert out == []
