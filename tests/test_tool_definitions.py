#!/usr/bin/env python3
"""
Tests for agent tool definitions
================================

Vérifie que les agents de la pipeline spec exposent bien l'outil `Write`
attendu par les prompts (planner.md / spec_writer.md). Sans cet outil, les
fournisseurs non-Claude (Copilot, Windsurf, ...) ne peuvent pas créer
`implementation_plan.json`, ce qui faisait échouer la phase de planification
avec "Did not create plan file".
"""

import sys
from pathlib import Path

# Add backend path to sys.path
backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from core.runtimes.tool_executor import get_tool_definitions  # noqa: E402


def _tool_names(agent_type: str) -> set[str]:
    return {tool["name"] for tool in get_tool_definitions(agent_type)}


def test_spec_writer_exposes_write_tool():
    """spec_writer (utilisé pour planner.md) doit exposer l'outil Write."""
    names = _tool_names("spec_writer")
    assert "Write" in names, (
        "L'agent spec_writer doit exposer l'outil 'Write' attendu par planner.md"
    )


def test_planner_exposes_write_tool():
    """planner doit continuer d'exposer l'outil Write."""
    assert "Write" in _tool_names("planner")


def test_base_tools_always_present():
    """Les outils de base doivent rester disponibles pour tout agent."""
    for agent_type in ("planner", "spec_writer", "coder", "unknown"):
        names = _tool_names(agent_type)
        assert {"read_file", "write_file", "list_files", "run_command"} <= names


def test_coder_does_not_get_write_alias():
    """L'agent coder ne reçoit pas l'alias Write (il utilise write_file)."""
    names = _tool_names("coder")
    assert "Write" not in names
    assert "create_directory" in names
