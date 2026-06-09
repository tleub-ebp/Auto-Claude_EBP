"""Tests du mapping outil -> événements de streaming live.

Régression : la frame de gauche du « Développement en streaming » restait
bloquée sur « En attente de modifications du code... » lorsque l'agent tournait
sur un provider non-Claude (Copilot, Windsurf...). Ces providers exposent les
outils définis dans ``core/runtimes/tool_executor.py`` (``write_file``,
``run_command``, ``list_files``...) au lieu des noms du SDK Claude
(``Edit``/``Write``/``Bash``). Le code de streaming ne reconnaissait que les
noms Claude, donc ``emit_file_change`` / ``emit_command`` / ``emit_command_output``
n'étaient jamais déclenchés.
"""

import sys
from pathlib import Path

import pytest

# Add backend to path for imports (même convention que tests/test_streaming.py)
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from agents.session import (  # noqa: E402
    _extract_streaming_command,
    _extract_streaming_file_change,
    _is_command_tool,
)


class TestExtractStreamingFileChange:
    """_extract_streaming_file_change doit être agnostique au provider."""

    @pytest.mark.parametrize(
        ("tool_name", "inp", "expected"),
        [
            # Claude SDK
            ("Write", {"file_path": "a.py", "content": "data"}, ("a.py", "data")),
            ("Edit", {"file_path": "b.py", "new_string": "edited"}, ("b.py", "edited")),
            # Provider non-Claude (tool_executor.py)
            ("write_file", {"path": "c.py", "content": "x"}, ("c.py", "x")),
            ("create_file", {"path": "d.py", "content": "y"}, ("d.py", "y")),
            # Variantes d'éditeurs
            ("str_replace", {"file_path": "e.py", "new_str": "z"}, ("e.py", "z")),
            ("edit_file", {"file_path": "f.py", "content": "w"}, ("f.py", "w")),
            # Alias Write du planner (CodeContent)
            ("Write", {"file_path": "g.py", "CodeContent": "code"}, ("g.py", "code")),
            # Casse insensible
            ("WRITE_FILE", {"path": "h.py", "content": "c"}, ("h.py", "c")),
        ],
    )
    def test_recognises_file_write_tools(self, tool_name, inp, expected):
        assert _extract_streaming_file_change(tool_name, inp) == expected

    def test_path_without_content_returns_none_content(self):
        result = _extract_streaming_file_change("write_file", {"path": "a.py"})
        assert result == ("a.py", None)

    @pytest.mark.parametrize(
        ("tool_name", "inp"),
        [
            ("list_files", {"directory": "."}),
            ("read_file", {"path": "a.py"}),
            ("run_command", {"command": "ls"}),
            ("Bash", {"command": "pytest"}),
            ("write_file", None),
            ("write_file", {}),  # pas de chemin
            (None, {"path": "a.py"}),
        ],
    )
    def test_ignores_non_file_write_tools(self, tool_name, inp):
        assert _extract_streaming_file_change(tool_name, inp) is None


class TestExtractStreamingCommand:
    """_extract_streaming_command doit reconnaître tous les outils commande."""

    @pytest.mark.parametrize(
        ("tool_name", "inp", "expected"),
        [
            ("Bash", {"command": "pytest"}, "pytest"),
            ("run_command", {"command": "npm test"}, "npm test"),
            ("shell", {"cmd": "ls -la"}, "ls -la"),
            ("RUN_COMMAND", {"command": "echo hi"}, "echo hi"),
        ],
    )
    def test_recognises_command_tools(self, tool_name, inp, expected):
        assert _extract_streaming_command(tool_name, inp) == expected

    @pytest.mark.parametrize(
        ("tool_name", "inp"),
        [
            ("write_file", {"path": "a.py", "content": "x"}),
            ("list_files", {"directory": "."}),
            ("run_command", {}),  # pas de commande
            ("run_command", None),
            (None, {"command": "ls"}),
        ],
    )
    def test_ignores_non_command_tools(self, tool_name, inp):
        assert _extract_streaming_command(tool_name, inp) is None


class TestIsCommandTool:
    @pytest.mark.parametrize(
        ("tool_name", "expected"),
        [
            ("Bash", True),
            ("run_command", True),
            ("shell", True),
            ("RUN_COMMAND", True),
            ("list_files", False),
            ("write_file", False),
            ("Edit", False),
            (None, False),
            ("", False),
        ],
    )
    def test_is_command_tool(self, tool_name, expected):
        assert _is_command_tool(tool_name) is expected
