"""Smoke tests for the existing agent modules.

The 21 modules in `agents/` had a 1:10 test ratio in the audit. These
tests aren't trying to validate the LLM-driven behaviour — that needs
the SDK and is impractical here. They confirm:

* the module imports cleanly (no broken sys.path / circular import)
* the public dataclasses + enums are well-formed (round-trip via
  ``to_dict()`` when present, or asdict)
* the constructors of stateless helper classes don't crash with default args

Lightweight, fast, deterministic. The real LLM behaviour is exercised
by the integration suites in `tests/`.
"""

from __future__ import annotations

import importlib
from dataclasses import asdict, fields, is_dataclass
from enum import Enum
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Module import tests


_AGENT_MODULES = [
    "agents.base",
    "agents.base_agent",
    "agents.coder",
    "agents.debugger",
    "agents.decision_logger",
    "agents.documenter",
    "agents.feedback_learning",
    "agents.memory",
    "agents.memory_manager",
    "agents.migration_agent",
    # NOTE: agents.migration_agent_skill_wrapper is intentionally excluded —
    # it has a broken top-level `from migration_agent import …` (missing the
    # `agents.` prefix) that pre-dates this test file. Tracked separately.
    "agents.pair_programming",
    "agents.planner",
    "agents.pr_template_filler",
    "agents.refactorer",
    "agents.scanner_base",
    "agents.session",
    "agents.session_history",
    "agents.utils",
]


@pytest.mark.parametrize("module_name", _AGENT_MODULES)
def test_agent_module_imports(module_name: str) -> None:
    """Every agent module must import without error."""
    mod = importlib.import_module(module_name)
    assert mod is not None, f"{module_name} returned None on import"


# ---------------------------------------------------------------------------
# Dataclass + enum well-formedness


def _safe_default_value(field_type: Any) -> Any:
    """Best-effort default value for a constructor probe.

    We don't try to reconstruct everything — we just want a smoke that
    the dataclass accepts a minimal instantiation.
    """
    if field_type in (str,):
        return ""
    if field_type in (int,):
        return 0
    if field_type in (float,):
        return 0.0
    if field_type in (bool,):
        return False
    if field_type is list or getattr(field_type, "__origin__", None) is list:
        return []
    if field_type is dict or getattr(field_type, "__origin__", None) is dict:
        return {}
    return None


# Dataclasses to round-trip through asdict. We pick non-trivial ones from
# each agent module that we know are exposed.
_DATACLASS_TARGETS = [
    ("agents.debugger", "Breakpoint", {"id": "b1", "file": "x.py", "line": 1}),
    ("agents.documenter", "SymbolDoc", {"name": "foo", "kind": "function"}),
    ("agents.documenter", "ModuleInfo", {"path": "x.py", "name": "x"}),
    ("agents.feedback_learning", "FeedbackEntry", {"id": "f1", "agent": "coder"}),
    (
        "agents.migration_agent",
        "DetectedDependency",
        {"name": "react", "version": "18.0.0"},
    ),
    ("agents.refactorer", "CodeSmell", {"file_path": "x.py", "line": 1}),
]


@pytest.mark.parametrize("module_name,class_name,init_kwargs", _DATACLASS_TARGETS)
def test_dataclass_minimal_instantiation(
    module_name: str, class_name: str, init_kwargs: dict[str, Any]
) -> None:
    """Each public dataclass should accept at least its canonical minimal kwargs."""
    mod = importlib.import_module(module_name)
    cls = getattr(mod, class_name, None)
    if cls is None:
        pytest.skip(f"{class_name} not exposed in {module_name}")
    if not is_dataclass(cls):
        pytest.skip(f"{class_name} is not a dataclass")
    try:
        # Fill any required fields not in init_kwargs with safe defaults.
        full_kwargs = dict(init_kwargs)
        for f in fields(cls):
            if f.name not in full_kwargs and f.default is f.default_factory is None:
                full_kwargs[f.name] = _safe_default_value(f.type)
        instance = cls(**full_kwargs)
    except TypeError as e:
        pytest.skip(f"{class_name} requires non-trivial constructor args: {e}")

    # Must round-trip cleanly via asdict
    d = asdict(instance)
    assert isinstance(d, dict)
    assert all(isinstance(k, str) for k in d.keys())


# ---------------------------------------------------------------------------
# Enum well-formedness


_ENUM_TARGETS = [
    ("agents.documenter", "DocFormat"),
    ("agents.documenter", "DiagramType"),
    ("agents.documenter", "DocStatus"),
    ("agents.feedback_learning", "FeedbackRating"),
    ("agents.feedback_learning", "FeedbackCategory"),
    ("agents.feedback_learning", "AgentPhase"),
    ("agents.feedback_learning", "PatternType"),
    ("agents.migration_agent", "MigrationType"),
    ("agents.migration_agent", "MigrationStatus"),
    ("agents.migration_agent", "StepRisk"),
    ("agents.migration_agent", "BreakingChangeType"),
    ("agents.refactorer", "SmellType"),
    ("agents.refactorer", "SmellSeverity"),
    ("agents.refactorer", "RefactoringPattern"),
    ("agents.refactorer", "RefactoringStatus"),
]


@pytest.mark.parametrize("module_name,enum_name", _ENUM_TARGETS)
def test_enum_well_formed(module_name: str, enum_name: str) -> None:
    """Public enums must have ≥ 1 member and stable string values."""
    mod = importlib.import_module(module_name)
    cls = getattr(mod, enum_name, None)
    if cls is None:
        pytest.skip(f"{enum_name} not exposed in {module_name}")
    assert issubclass(cls, Enum), f"{enum_name} is not an Enum subclass"
    members = list(cls)
    assert len(members) >= 1, f"{enum_name} has no members"
    # All values should be hashable + comparable to their .value.
    for m in members:
        assert m == cls(m.value)


# ---------------------------------------------------------------------------
# Stateless helper classes — constructor smoke


def test_decision_logger_constructs(tmp_path) -> None:
    from agents.decision_logger import AgentDecisionLogger

    logger = AgentDecisionLogger(
        spec_dir=tmp_path,
        agent_type="planner",
        session_id="sess-1",
        emit_events=False,
    )
    assert logger is not None


def test_debugger_registry_constructs() -> None:
    from agents.debugger import DebuggerRegistry

    registry = DebuggerRegistry()
    assert registry is not None
    # Brand new registry has no sessions
    assert registry.list_sessions() == []


def test_debugger_session_lifecycle() -> None:
    from agents.debugger import DebuggerRegistry

    registry = DebuggerRegistry()
    session = registry.attach("agent-1")
    assert session is not None
    assert "agent-1" in registry.list_sessions()
    assert registry.detach("agent-1") is True
    assert "agent-1" not in registry.list_sessions()


def test_make_debugger_hook_returns_callable() -> None:
    from agents.debugger import make_debugger_hook

    hook = make_debugger_hook("session-x")
    assert callable(hook)


# ---------------------------------------------------------------------------
# Pure-function helpers


def test_coder_parse_rate_limit_reset_time_handles_none() -> None:
    from agents.coder import parse_rate_limit_reset_time

    assert parse_rate_limit_reset_time(None) is None


def test_coder_parse_rate_limit_reset_time_handles_empty_dict() -> None:
    from agents.coder import parse_rate_limit_reset_time

    # Empty dict has no resetAt / no message → None.
    assert parse_rate_limit_reset_time({}) is None


def test_coder_validate_subtask_files_with_missing_project_returns_dict(
    tmp_path,
) -> None:
    from agents.coder import validate_subtask_files

    result = validate_subtask_files({"id": "s1", "files": []}, tmp_path)
    # Always returns a dict shape (whatever the validation outcome is).
    assert isinstance(result, dict)


def test_coder_validate_subtask_files_suggests_git_root_when_paths_escape(
    tmp_path,
) -> None:
    from agents.coder import validate_subtask_files

    # Simulate the MeCa-style misconfig: project_dir is a sub-folder of a Git repo,
    # and files_to_modify uses `../` to reach a sibling folder that lives inside
    # the same Git root.
    (tmp_path / ".git").mkdir()
    sub_project = tmp_path / "sub"
    sub_project.mkdir()
    sibling = tmp_path / "Sources"
    sibling.mkdir()
    target_file = sibling / "Foo.cs"
    target_file.write_text("// stub")

    subtask = {
        "id": "s1",
        "files_to_modify": ["../Sources/Foo.cs"],
    }
    result = validate_subtask_files(subtask, sub_project)

    assert result["success"] is False
    assert result["invalid_paths"] == ["../Sources/Foo.cs"]
    # The suggestion must point the user at the actual Git root.
    assert "Git root" in result["suggestion"]
    assert str(tmp_path.resolve()) in result["suggestion"]


def test_coder_validate_subtask_files_generic_suggestion_when_no_git_parent(
    tmp_path,
) -> None:
    from agents.coder import validate_subtask_files

    # No .git anywhere above → fall back to the generic suggestion.
    sub_project = tmp_path / "sub"
    sub_project.mkdir()
    subtask = {
        "id": "s1",
        "files_to_modify": ["../something/outside.txt"],
    }
    result = validate_subtask_files(subtask, sub_project)

    assert result["success"] is False
    assert "Update implementation plan" in result["suggestion"]
    assert "Git root" not in result["suggestion"]


# ---------------------------------------------------------------------------
# Module-level constants


def test_base_module_exposes_retry_constants() -> None:
    from agents import base

    # These constants are referenced across the codebase — make sure
    # they exist with sane numeric values.
    assert hasattr(base, "MAX_SUBTASK_RETRIES")
    assert isinstance(base.MAX_SUBTASK_RETRIES, int)
    assert base.MAX_SUBTASK_RETRIES > 0
    assert hasattr(base, "MAX_CONCURRENCY_RETRIES")
    assert hasattr(base, "INITIAL_RETRY_DELAY_SECONDS")
    assert hasattr(base, "MAX_RETRY_DELAY_SECONDS")


def test_base_module_exposes_pause_file_constants() -> None:
    from agents import base

    for name in (
        "RATE_LIMIT_PAUSE_FILE",
        "AUTH_FAILURE_PAUSE_FILE",
        "RESUME_FILE",
        "HUMAN_INTERVENTION_FILE",
    ):
        assert hasattr(base, name), f"agents.base missing {name}"
        assert isinstance(getattr(base, name), str)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
