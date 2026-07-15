"""Live-streaming plumbing for test generation.

Covers the pieces that turn a long, silent LLM call into a real-time UI:

* ``StreamingJsonFieldExtractor`` — un-escapes ``test_file_content`` on the fly
  so the UI shows clean code instead of raw JSON, regardless of chunk boundaries.
* ``_slice_test_block`` — fills each ``GeneratedTest.test_code`` (the fix for the
  empty white boxes in the result cards).
* ``generate_unit_tests(..., on_event=...)`` — emits pipeline ``stage`` events and
  clean ``code`` chunks end-to-end.
"""

from __future__ import annotations

import json
from unittest.mock import patch

from agents.test_generator import (
    StreamingJsonFieldExtractor,
    TestGeneratorAgent,
    _decode_json_string_prefix,
    _slice_test_block,
)

# ── _decode_json_string_prefix ───────────────────────────────────────


def test_decode_handles_escapes_and_closing_quote() -> None:
    raw = '{"k": "line1\\nline2\\t\\"q\\""}'
    start = raw.index('"line1') + 1
    decoded, closed = _decode_json_string_prefix(raw, start)
    assert decoded == 'line1\nline2\t"q"'
    assert closed is True


def test_decode_holds_back_incomplete_trailing_escape() -> None:
    # A lone trailing backslash must not be emitted as a broken char.
    raw = '{"k": "abc\\'
    start = raw.index('"abc') + 1
    decoded, closed = _decode_json_string_prefix(raw, start)
    assert decoded == "abc"
    assert closed is False


# ── StreamingJsonFieldExtractor ──────────────────────────────────────


def _feed_in_chunks(text: str, size: int) -> str:
    ex = StreamingJsonFieldExtractor("test_file_content")
    out = []
    for i in range(0, len(text), size):
        out.append(ex.feed(text[i : i + size]))
    return "".join(out)


def test_extractor_reconstructs_content_across_any_chunking() -> None:
    content = 'using System;\n\nclass T\n{\n    // "quoted"\n\tvoid A() {}\n}\n'
    payload = json.dumps(
        {
            "test_file_content": content,
            "test_file_path": "T.cs",
            "tests_generated": 1,
            "generated_tests": [],
        }
    )
    # Whatever the chunk size, the concatenated deltas equal the exact content.
    for size in (1, 3, 7, 20, 999):
        assert _feed_in_chunks(payload, size) == content


def test_extractor_single_feed_returns_whole_field() -> None:
    content = "def test_x():\n    assert True\n"
    payload = json.dumps({"a": 1, "test_file_content": content, "b": 2})
    ex = StreamingJsonFieldExtractor()
    assert ex.feed(payload) == content
    # Field is closed — further feeds yield nothing.
    assert ex.feed('{"more": "stuff"}') == ""


def test_extractor_yields_nothing_when_field_absent() -> None:
    ex = StreamingJsonFieldExtractor()
    assert ex.feed('{"other": "value"}') == ""


# ── _slice_test_block ────────────────────────────────────────────────


def test_slice_python_block_by_indentation() -> None:
    content = (
        "import pytest\n\n"
        "def test_add():\n"
        "    assert add(1, 2) == 3\n"
        "    assert add(0, 0) == 0\n\n"
        "def test_sub():\n"
        "    assert sub(3, 1) == 2\n"
    )
    block = _slice_test_block(content, "test_add", "python")
    assert "def test_add():" in block
    assert "add(1, 2) == 3" in block
    assert "def test_sub" not in block


def test_slice_csharp_block_by_braces() -> None:
    content = (
        "public class Tests\n{\n"
        "    [Fact]\n"
        "    public void Does_Thing()\n"
        "    {\n"
        "        Assert.True(true);\n"
        "    }\n"
        "}\n"
    )
    block = _slice_test_block(content, "Does_Thing", "csharp")
    assert "public void Does_Thing()" in block
    assert "Assert.True(true);" in block
    assert block.rstrip().endswith("}")


def test_slice_returns_empty_when_not_found() -> None:
    assert _slice_test_block("nothing here", "missing", "python") == ""


# ── end-to-end on_event plumbing ─────────────────────────────────────


def test_generate_unit_emits_stages_and_streams_clean_code(tmp_path) -> None:
    src = tmp_path / "calc.py"
    src.write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")

    payload = {
        "test_file_content": (
            "import calc\n\n\ndef test_add():\n    assert calc.add(1, 2) == 3\n"
        ),
        "test_file_path": "tests/test_calc.py",
        "tests_generated": 1,
        "functions_analyzed": 1,
        "generated_tests": [{"test_name": "test_add", "description": "adds two ints"}],
    }
    raw = json.dumps(payload)

    async def fake_oneshot(prompt, system_prompt=None, project_dir=None, on_delta=None):
        if on_delta is not None:  # stream in small chunks to exercise the extractor
            for i in range(0, len(raw), 16):
                on_delta(raw[i : i + 16])
        return raw

    events: list[dict] = []
    agent = TestGeneratorAgent()
    with patch("core.oneshot.oneshot_completion", side_effect=fake_oneshot):
        result = agent.generate_unit_tests(
            str(src), project_path=str(tmp_path), on_event=events.append
        )

    stages = [e["stage"] for e in events if e.get("type") == "stage"]
    streamed = "".join(e["delta"] for e in events if e.get("type") == "code")

    assert "detect" in stages
    assert "generate" in stages
    # The live code stream reconstructs the exact file content — clean, no JSON.
    assert streamed == payload["test_file_content"]
    # Empty-card fix: each test carries real source, not "".
    assert result.generated_tests[0].test_code.strip()
    assert "test_add" in result.generated_tests[0].test_code
