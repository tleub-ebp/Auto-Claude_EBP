"""Tests for toolchain version ranges.

These decide whether a project on .NET Framework 4.8 gets guidance written for
C# 14. A false positive here ships wrong instructions silently, so the edges
are pinned rather than assumed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "backend"))

from skills_registry.targets import (  # noqa: E402
    parse_version,
    satisfies,
    targets_match,
)


class TestParseVersion:
    @pytest.mark.parametrize(
        "text,expected",
        [
            ("10", (10, 0, 0)),
            ("10.1", (10, 1, 0)),
            ("10.1.2", (10, 1, 2)),
            ("v10.1.2", (10, 1, 2)),
            ("10.0.0-preview.3", (10, 0, 0)),
            ("1.2.3+build5", (1, 2, 3)),
        ],
    )
    def test_parses(self, text, expected):
        assert tuple(parse_version(text)) == expected

    @pytest.mark.parametrize("text", ["", "latest", "net10.0", "abc", "10.x"])
    def test_rejects_garbage(self, text):
        with pytest.raises(ValueError):
            parse_version(text)


class TestSatisfies:
    @pytest.mark.parametrize(
        "version,spec,expected",
        [
            # Comparators
            ("10.0", ">=10.0", True),
            ("9.9", ">=10.0", False),
            ("10.0", ">10.0", False),
            ("10.0.1", ">10.0", True),
            ("4.8", "<=5.0", True),
            # Compound: this is the .NET Framework window
            ("4.8", ">=4.8 <5.0", True),
            ("4.7.2", ">=4.8 <5.0", False),
            ("5.0", ">=4.8 <5.0", False),
            ("10.0", ">=4.8 <5.0", False),
            # Caret / tilde
            ("2.9.9", "^2", True),
            ("3.0.0", "^2", False),
            ("2.1.0", "^2.1", True),
            ("2.0.9", "^2.1", False),
            ("2.1.9", "~2.1", True),
            ("2.2.0", "~2.1", False),
            # Exact and wildcards
            ("1.2.3", "1.2.3", True),
            ("1.2.3", "=1.2.3", True),
            ("1.2.4", "1.2.3", False),
            ("99.0", "*", True),
            ("99.0", "", True),
        ],
    )
    def test_ranges(self, version, spec, expected):
        assert satisfies(version, spec) is expected

    def test_a_typo_in_a_range_raises_instead_of_matching(self):
        # Silently treating a malformed range as "anything" would ship every
        # skill everywhere. Fail the build instead.
        with pytest.raises(ValueError):
            satisfies("1.0", ">=notaversion")


class TestTargetsMatch:
    def test_no_declared_targets_applies_everywhere(self):
        ok, reason = targets_match({}, {"dotnet": "8.0"})
        assert ok and reason == ""

    def test_unknown_toolchain_is_not_a_match(self):
        # A .NET skill must not land in a project with no .NET at all.
        ok, reason = targets_match({"dotnet": ">=10"}, {"node": "20"})
        assert not ok
        assert "declares no 'dotnet'" in reason

    def test_every_declared_target_must_hold(self):
        declared = {"dotnet": ">=10.0", "node": ">=20"}
        assert targets_match(declared, {"dotnet": "10.0", "node": "22"})[0]
        assert not targets_match(declared, {"dotnet": "10.0", "node": "18"})[0]

    def test_reason_names_the_mismatch(self):
        ok, reason = targets_match({"dotnet": ">=10.0"}, {"dotnet": "8.0"})
        assert not ok
        assert "dotnet 8.0" in reason and ">=10.0" in reason
