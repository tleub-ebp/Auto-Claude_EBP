"""Tests for the shared SKILL.md frontmatter parser.

The repo used to carry four hand-rolled parsers. Three of them located the
closing delimiter with ``content.find("---", 3)`` and stripped quotes off the
whole value, which silently truncated 32 of the BMAD skill descriptions. These
tests pin the behaviour that replaced them.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.frontmatter import (  # noqa: E402
    parse_frontmatter,
    split_frontmatter,
    workpilot_meta,
)


class TestSplitFrontmatter:
    def test_no_frontmatter_returns_whole_text_as_body(self):
        meta, body = split_frontmatter("# Just a heading\n\nbody")
        assert meta is None
        assert body == "# Just a heading\n\nbody"

    def test_unterminated_block_is_not_treated_as_frontmatter(self):
        # Guessing where the block ends would silently eat the document.
        meta, body = split_frontmatter("---\nname: x\n\nno closing delimiter")
        assert meta is None

    def test_closing_delimiter_must_be_alone_on_its_line(self):
        text = "---\ndescription: uses --- as a separator inline\n---\nbody here"
        raw, body = split_frontmatter(text)
        assert raw == "description: uses --- as a separator inline"
        assert body == "body here"


class TestParseFrontmatter:
    def test_trailing_quote_in_description_is_preserved(self):
        # The regression that motivated this module: `.strip('"')` on the whole
        # value ate the closing quote of a description ending in a citation.
        text = '---\nname: s\ndescription: Use when the user says "do the thing"\n---\nbody'
        meta, _ = parse_frontmatter(text)
        assert meta["description"] == 'Use when the user says "do the thing"'

    def test_colon_in_value_is_kept(self):
        text = '---\nname: s\ndescription: "Ratio: 3:1"\n---\nbody'
        meta, _ = parse_frontmatter(text)
        assert meta["description"] == "Ratio: 3:1"

    def test_body_excludes_frontmatter(self):
        meta, body = parse_frontmatter("---\nname: s\n---\n\n# Title\ntext")
        assert body == "# Title\ntext"
        assert meta["name"] == "s"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("triggers: [a, b, c]", ["a", "b", "c"]),
            ('triggers: ["a", "b"]', ["a", "b"]),
            ("triggers: a, b", ["a", "b"]),
            ("triggers:\n  - a\n  - b", ["a", "b"]),
            ("triggers: []", []),
        ],
    )
    def test_list_fields_always_come_back_as_lists(self, raw, expected):
        meta, _ = parse_frontmatter(f"---\nname: s\n{raw}\n---\nbody")
        assert meta["triggers"] == expected

    def test_nested_metadata_survives(self):
        text = (
            "---\n"
            "name: net-developer\n"
            "metadata:\n"
            "  workpilot:\n"
            "    pack: dotnet\n"
            "    version: '3.1.0'\n"
            "    targets:\n"
            "      dotnet: '>=10.0'\n"
            "---\n"
            "body"
        )
        meta, _ = parse_frontmatter(text)
        wp = workpilot_meta(meta)
        assert wp["pack"] == "dotnet"
        assert wp["version"] == "3.1.0"
        assert wp["targets"] == {"dotnet": ">=10.0"}

    def test_malformed_yaml_degrades_to_line_parser(self):
        # Hand-edited blocks exist in the wild; dropping their metadata whole
        # would be worse than reading what we can.
        text = '---\nname: s\ndescription: unbalanced "quote\n\tbad: [indent\n---\nbody'
        meta, _ = parse_frontmatter(text)
        assert meta.get("name") == "s"

    def test_workpilot_meta_is_empty_when_absent(self):
        meta, _ = parse_frontmatter("---\nname: s\n---\nbody")
        assert workpilot_meta(meta) == {}
        assert workpilot_meta({"metadata": "not-a-map"}) == {}


class TestAgainstRealSkillFiles:
    """Every SKILL.md committed in this repo must parse and carry a name."""

    @staticmethod
    def _skill_files() -> list[Path]:
        """Authored sources plus generated output — both must parse.

        `skills/` is the source of truth; `.agents/skills/` is what the backend
        actually serves, so a parser regression that only shows up after the
        build would still break the command palette.
        """
        return sorted(
            list((REPO_ROOT / "skills").glob("*/*/SKILL.md"))
            + list((REPO_ROOT / "skills").glob("*/agents/*.md"))
            + list((REPO_ROOT / ".agents" / "skills").glob("*/SKILL.md"))
            + list((REPO_ROOT / "apps" / "backend" / "skills").glob("*/SKILL.md"))
        )

    def test_repo_has_skill_files_to_check(self):
        assert len(self._skill_files()) > 50, "skill discovery globs went stale"

    def test_every_skill_parses_with_a_name_and_description(self):
        broken = []
        for f in self._skill_files():
            meta, body = parse_frontmatter(f.read_text(encoding="utf-8"))
            if not meta.get("name") or not meta.get("description") or not body.strip():
                broken.append(f.relative_to(REPO_ROOT))
        assert not broken, f"skills missing name/description/body: {broken}"
