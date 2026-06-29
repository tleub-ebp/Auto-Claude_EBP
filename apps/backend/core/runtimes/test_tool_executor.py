"""Tests for ToolExecutor argument-alias resolution.

Local models are inconsistent about tool argument names (cmd vs command,
file_path vs path, Content vs content). The executor resolves a set of aliases
so those variants work instead of failing with "X is required" — the exact
"run_command ne fonctionne pas" / Write-Content bugs seen with qwen/llama.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from core.runtimes.tool_executor import ToolExecutor, _pick_arg


class TestPickArg:
    def test_exact_match(self):
        assert _pick_arg({"command": "ls"}, "command", "cmd") == "ls"

    def test_alias_match(self):
        assert _pick_arg({"cmd": "ls"}, "command", "cmd") == "ls"

    def test_case_insensitive(self):
        # The real bug: llama3.1 emitted "Content" for a Write.
        assert _pick_arg({"Content": "hi"}, "content") == "hi"

    def test_first_alias_wins(self):
        assert _pick_arg({"command": "a", "cmd": "b"}, "command", "cmd") == "a"

    def test_empty_string_skipped(self):
        assert _pick_arg({"command": ""}, "command", default="fallback") == "fallback"

    def test_default_when_missing(self):
        assert _pick_arg({}, "command", default=".") == "."

    def test_non_dict_returns_default(self):
        assert _pick_arg(None, "command", default="x") == "x"  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_run_command_accepts_cmd_alias(tmp_path: Path) -> None:
    """run_command must work when the model names the arg 'cmd' (not 'command')."""
    ex = ToolExecutor(str(tmp_path))
    ex._run_command = AsyncMock(return_value="ok")  # type: ignore[method-assign]
    await ex.execute("run_command", {"cmd": "echo hi"})
    ex._run_command.assert_awaited_once()
    assert ex._run_command.await_args.args[0] == "echo hi"


@pytest.mark.asyncio
async def test_write_file_accepts_filepath_and_capital_content(tmp_path: Path) -> None:
    """The exact llama3.1 shape: {"file_path": ..., "Content": ...}."""
    ex = ToolExecutor(str(tmp_path))
    ex._write_file = AsyncMock(return_value="ok")  # type: ignore[method-assign]
    await ex.execute("write_file", {"file_path": "./out.txt", "Content": "hello"})
    ex._write_file.assert_awaited_once()
    args = ex._write_file.await_args.args
    assert args[0] == "./out.txt"
    assert args[1] == "hello"


@pytest.mark.asyncio
async def test_write_tool_alias_with_codecontent(tmp_path: Path) -> None:
    ex = ToolExecutor(str(tmp_path))
    ex._write_file = AsyncMock(return_value="ok")  # type: ignore[method-assign]
    await ex.execute("Write", {"file_path": "p", "CodeContent": "c"})
    args = ex._write_file.await_args.args
    assert args[0] == "p" and args[1] == "c"


@pytest.mark.asyncio
async def test_read_file_accepts_file_path_alias(tmp_path: Path) -> None:
    ex = ToolExecutor(str(tmp_path))
    ex._read_file = AsyncMock(return_value="data")  # type: ignore[method-assign]
    await ex.execute("read_file", {"file_path": "x.py"})
    assert ex._read_file.await_args.args[0] == "x.py"


@pytest.mark.asyncio
async def test_run_command_truly_empty_still_errors(tmp_path: Path) -> None:
    """No command under any alias → the clear 'required' error is preserved."""
    ex = ToolExecutor(str(tmp_path))
    with pytest.raises(ValueError, match="Command is required"):
        await ex.execute("run_command", {})


@pytest.mark.asyncio
async def test_run_command_executes_real_echo(tmp_path: Path) -> None:
    """End-to-end sanity: a real shell echo runs cross-platform."""
    ex = ToolExecutor(str(tmp_path))
    out = await ex.execute("run_command", {"command": "echo wp_ok"})
    assert "wp_ok" in out
