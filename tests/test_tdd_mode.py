"""
Tests for strict TDD (Red-Green-Refactor) mode injection in prompts.

Covers:
- is_tdd_enabled() reading the TDD_MODE env var
- subtask_is_tdd_eligible() gating logic
- generate_subtask_prompt() injecting the TDD cycle only when enabled + eligible
- generate_planner_prompt() appending the test-first addendum only when enabled
"""

from pathlib import Path

# Note: sys.path manipulation is handled by conftest.py
from prompts_pkg.prompt_generator import (
    generate_planner_prompt,
    generate_subtask_prompt,
    is_tdd_enabled,
    subtask_is_tdd_eligible,
)


def _command_subtask() -> dict:
    return {
        "id": "sub-1",
        "description": "Add a slugify() helper",
        "service": "backend",
        "files_to_modify": ["src/utils.py"],
        "files_to_create": ["tests/test_utils.py"],
        "verification": {
            "type": "command",
            "command": "pytest tests/test_utils.py -q",
            "expected": "All tests pass",
        },
    }


def _impl_phase() -> dict:
    return {"id": "phase-1", "name": "Implementation", "type": "implementation"}


# ---------------------------------------------------------------------------
# is_tdd_enabled
# ---------------------------------------------------------------------------
class TestIsTddEnabled:
    def test_true_when_env_true(self, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "true")
        assert is_tdd_enabled() is True

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "TRUE")
        assert is_tdd_enabled() is True

    def test_false_when_unset(self, monkeypatch):
        monkeypatch.delenv("TDD_MODE", raising=False)
        assert is_tdd_enabled() is False

    def test_false_when_other_value(self, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "1")
        assert is_tdd_enabled() is False


# ---------------------------------------------------------------------------
# subtask_is_tdd_eligible
# ---------------------------------------------------------------------------
class TestSubtaskEligibility:
    def test_command_verification_is_eligible(self):
        assert subtask_is_tdd_eligible(_command_subtask(), _impl_phase()) is True

    def test_api_and_e2e_are_eligible(self):
        for v in ("api", "e2e"):
            subtask = {"verification": {"type": v}}
            assert subtask_is_tdd_eligible(subtask, _impl_phase()) is True

    def test_manual_and_none_and_browser_not_eligible(self):
        for v in ("manual", "none", "browser"):
            subtask = {"verification": {"type": v}}
            assert subtask_is_tdd_eligible(subtask, _impl_phase()) is False

    def test_missing_verification_not_eligible(self):
        assert subtask_is_tdd_eligible({}, _impl_phase()) is False

    def test_investigation_setup_cleanup_phases_not_eligible(self):
        for phase_type in ("investigation", "setup", "cleanup"):
            phase = {"type": phase_type}
            assert subtask_is_tdd_eligible(_command_subtask(), phase) is False


# ---------------------------------------------------------------------------
# generate_subtask_prompt
# ---------------------------------------------------------------------------
class TestSubtaskPromptTdd:
    def _prompt(self, tmp_path: Path, subtask: dict, phase: dict) -> str:
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        return generate_subtask_prompt(
            spec_dir=spec_dir,
            project_dir=tmp_path,
            subtask=subtask,
            phase=phase,
        )

    def test_tdd_sections_present_when_enabled_and_eligible(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("TDD_MODE", "true")
        prompt = self._prompt(tmp_path, _command_subtask(), _impl_phase())
        assert "TDD Cycle (Red-Green-Refactor)" in prompt
        assert "RED" in prompt and "GREEN" in prompt and "REFACTOR" in prompt
        assert "Write the failing test FIRST" in prompt
        # Classic instruction header should be replaced
        assert "## Instructions" not in prompt

    def test_tdd_sections_absent_when_disabled(self, tmp_path, monkeypatch):
        monkeypatch.delenv("TDD_MODE", raising=False)
        prompt = self._prompt(tmp_path, _command_subtask(), _impl_phase())
        assert "TDD Cycle (Red-Green-Refactor)" not in prompt
        assert "## Instructions" in prompt

    def test_tdd_sections_absent_for_manual_verification(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "true")
        subtask = {
            "id": "sub-m",
            "description": "Manual QA",
            "verification": {"type": "manual", "instructions": "Eyeball it"},
        }
        prompt = self._prompt(tmp_path, subtask, _impl_phase())
        assert "TDD Cycle (Red-Green-Refactor)" not in prompt

    def test_tdd_sections_absent_for_investigation_phase(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "true")
        phase = {"id": "phase-x", "name": "Investigate", "type": "investigation"}
        prompt = self._prompt(tmp_path, _command_subtask(), phase)
        assert "TDD Cycle (Red-Green-Refactor)" not in prompt


# ---------------------------------------------------------------------------
# generate_planner_prompt
# ---------------------------------------------------------------------------
class TestPlannerPromptTdd:
    # Marker unique to the injected addendum (planner.md itself mentions
    # "TDD MODE ENABLED" / "pre_implementation" in its static guidance note).
    ADDENDUM_MARKER = "OVERRIDES DEFAULTS"

    def test_addendum_present_when_enabled(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TDD_MODE", "true")
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        prompt = generate_planner_prompt(spec_dir, tmp_path)
        assert self.ADDENDUM_MARKER in prompt
        assert "pre_implementation" in prompt

    def test_addendum_absent_when_disabled(self, tmp_path, monkeypatch):
        monkeypatch.delenv("TDD_MODE", raising=False)
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        prompt = generate_planner_prompt(spec_dir, tmp_path)
        assert self.ADDENDUM_MARKER not in prompt
