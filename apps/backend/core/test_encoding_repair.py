"""Tests for the encoding-repair utility (U+FFFD restoration from base)."""

from __future__ import annotations

from core.encoding_repair import (
    decode_preserving_bom,
    encode_preserving_bom,
    has_replacement_chars,
    repair_line_from_base,
    repair_text,
)

FFFD = "�"


def test_has_replacement_chars() -> None:
    assert has_replacement_chars(f"Notes de cr{FFFD}dit")
    assert not has_replacement_chars("Notes de crédit")


def test_repair_line_restores_single_accent() -> None:
    base = ["    <value>Notes de crédit</value>", "    <value>Autre</value>"]
    corrupted = f"    <value>Notes de cr{FFFD}dit</value>"
    assert repair_line_from_base(corrupted, base) == base[0]


def test_repair_line_handles_consecutive_replacements() -> None:
    base = ["café déjà"]
    corrupted = f"caf{FFFD} d{FFFD}j{FFFD}"
    assert repair_line_from_base(corrupted, base) == "café déjà"


def test_repair_line_returns_none_when_ambiguous() -> None:
    # Two clean base lines both match "cr�dit" → refuse to guess.
    base = ["crédit", "crâdit"]
    assert repair_line_from_base(f"cr{FFFD}dit", base) is None


def test_repair_line_returns_none_when_no_match() -> None:
    base = ["completely unrelated"]
    assert repair_line_from_base(f"cr{FFFD}dit", base) is None


def test_repair_text_restores_corrupted_lines_keeps_new_lines() -> None:
    base = "\n".join(
        [
            "<root>",
            "  <value>Notes de crédit</value>",
            "  <value>Barèmes Recupel</value>",
            "</root>",
        ]
    )
    current = "\n".join(
        [
            "<root>",
            f"  <value>Notes de cr{FFFD}dit</value>",
            f"  <value>Bar{FFFD}mes Recupel</value>",
            "  <value>Nouvelle entrée</value>",  # agent-added, clean
            "</root>",
        ]
    )
    repaired, unrepaired = repair_text(current, base)

    assert unrepaired == []
    assert FFFD not in repaired
    assert "Notes de crédit" in repaired
    assert "Barèmes Recupel" in repaired
    assert "Nouvelle entrée" in repaired


def test_repair_text_reports_unrepairable_new_content() -> None:
    base = "<root>\n</root>"
    # A brand-new corrupted line that does not exist in base cannot be restored.
    current = f"<root>\n  <value>tr{FFFD}s neuf</value>\n</root>"
    repaired, unrepaired = repair_text(current, base)

    assert len(unrepaired) == 1
    assert FFFD in repaired  # left untouched, surfaced for manual handling


def test_repair_text_noop_without_corruption() -> None:
    text = "<root>\n  <value>crédit</value>\n</root>"
    repaired, unrepaired = repair_text(text, "anything")
    assert repaired == text
    assert unrepaired == []


def test_bom_round_trip() -> None:
    original = "crédit".encode()
    with_bom = b"\xef\xbb\xbf" + original

    text, had_bom = decode_preserving_bom(with_bom)
    assert had_bom is True
    assert text == "crédit"
    assert encode_preserving_bom(text, had_bom) == with_bom

    text2, had_bom2 = decode_preserving_bom(original)
    assert had_bom2 is False
    assert encode_preserving_bom(text2, had_bom2) == original
