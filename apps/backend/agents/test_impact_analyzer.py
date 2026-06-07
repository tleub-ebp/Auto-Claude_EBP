"""Tests for impact_analyzer pure functions (no Claude calls)."""

from agents.impact_analyzer import (
    IMPACT_BLOCK_MARKER,
    ImpactAnalysis,
    _parse_response,
    append_impact_block,
    fallback_analysis,
    render_impact_block,
    strip_existing_impact_block,
)


def test_render_impact_block_uses_french_labels():
    block = render_impact_block(ImpactAnalysis(rating="3", features="Fiche vehicule"))
    assert "Note de l'impact (1 à 5) : 3" in block
    assert "Fonctionnalité(s) impactée(s) : Fiche vehicule" in block
    assert IMPACT_BLOCK_MARKER in block
    assert block.startswith("---\n")


def test_fallback_analysis_renders_na():
    block = render_impact_block(fallback_analysis())
    assert "N/A" in block
    assert "Non evalue" in block


def test_append_to_empty_body():
    result = append_impact_block("", ImpactAnalysis(rating="2", features="API auth"))
    assert result.startswith("---\n")
    assert "Note de l'impact (1 à 5) : 2" in result
    assert result.endswith("\n")


def test_append_to_existing_body_keeps_original_content():
    body = "## Summary\n\nFix the bug."
    result = append_impact_block(body, ImpactAnalysis(rating="1", features="None"))
    assert "## Summary" in result
    assert "Fix the bug." in result
    # Original content stays first, impact block at end
    summary_idx = result.find("## Summary")
    block_idx = result.find(IMPACT_BLOCK_MARKER)
    assert summary_idx < block_idx


def test_append_is_idempotent_replaces_previous_block():
    body = "## Summary\n\nDo a thing."
    first = append_impact_block(body, ImpactAnalysis(rating="1", features="A"))
    second = append_impact_block(first, ImpactAnalysis(rating="4", features="B"))
    # Should contain new values, not old
    assert "4" in second
    assert "B" in second
    # Only one marker present
    assert second.count(IMPACT_BLOCK_MARKER) == 1
    # Original summary preserved
    assert "Do a thing." in second
    # Old rating gone
    assert "(1 à 5) : 1" not in second


def test_strip_existing_block_removes_marker_and_separator():
    body = "## Summary\n\nDo a thing.\n\n---\n" + IMPACT_BLOCK_MARKER + "\nNote..."
    stripped = strip_existing_impact_block(body)
    assert IMPACT_BLOCK_MARKER not in stripped
    assert "Do a thing." in stripped


def test_strip_no_op_when_no_marker():
    body = "## Summary\nNothing to strip."
    assert strip_existing_impact_block(body) == body


def test_parse_valid_json():
    response = '{"rating": 3, "features": "Fiche véhicule, doc de vente"}'
    analysis = _parse_response(response)
    assert analysis is not None
    assert analysis.rating == "3"
    assert "Fiche véhicule" in analysis.features


def test_parse_tolerates_markdown_fences():
    response = '```json\n{"rating": 2, "features": "Authentification"}\n```'
    analysis = _parse_response(response)
    assert analysis is not None
    assert analysis.rating == "2"


def test_parse_tolerates_preamble():
    response = 'Sure, here is the analysis:\n{"rating": 5, "features": "Everything"}'
    analysis = _parse_response(response)
    assert analysis is not None
    assert analysis.rating == "5"


def test_parse_rejects_out_of_range_rating():
    assert _parse_response('{"rating": 7, "features": "X"}') is None
    assert _parse_response('{"rating": 0, "features": "X"}') is None


def test_parse_rejects_missing_features():
    assert _parse_response('{"rating": 3}') is None
    assert _parse_response('{"rating": 3, "features": ""}') is None


def test_parse_rejects_garbage():
    assert _parse_response("") is None
    assert _parse_response("not json at all") is None
    assert _parse_response("{rating: 3}") is None  # invalid JSON


def test_parse_collapses_whitespace_in_features():
    response = '{"rating": 2, "features": "Fiche\\n  véhicule,   doc"}'
    analysis = _parse_response(response)
    assert analysis is not None
    assert "\n" not in analysis.features
    assert "  " not in analysis.features
