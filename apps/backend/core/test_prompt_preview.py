"""Tests for the system prompt preview helper."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.prompt_preview import _phase_for, build_prompt_preview

# ---------------------------------------------------------------------------
# Smoke / shape


class TestSmoke:
    def test_returns_a_snapshot_for_minimal_inputs(self, tmp_path: Path) -> None:
        project = tmp_path / "proj"
        spec = tmp_path / "proj" / ".workpilot" / "specs" / "001"
        spec.mkdir(parents=True)
        snap = build_prompt_preview(project, spec)
        assert snap.project_dir == str(project)
        assert snap.spec_dir == str(spec)
        assert snap.agent_type == "coder"
        assert snap.system_prompt
        assert snap.system_prompt_length == len(snap.system_prompt)

    def test_to_dict_is_json_serialisable(self, tmp_path: Path) -> None:
        snap = build_prompt_preview(tmp_path, tmp_path)
        payload = json.dumps(snap.to_dict())
        decoded = json.loads(payload)
        assert "system_prompt" in decoded
        assert "allowed_tools" in decoded


# ---------------------------------------------------------------------------
# CLAUDE.md inclusion


class TestClaudeMd:
    def test_disabled_when_env_var_unset(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("USE_CLAUDE_MD", raising=False)
        (tmp_path / "CLAUDE.md").write_text("hello", encoding="utf-8")
        snap = build_prompt_preview(tmp_path, tmp_path)
        assert snap.claude_md_included is False
        assert "hello" not in snap.system_prompt

    def test_included_when_flag_on_and_file_present(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("USE_CLAUDE_MD", "true")
        (tmp_path / "CLAUDE.md").write_text("custom rules here", encoding="utf-8")
        snap = build_prompt_preview(tmp_path, tmp_path)
        assert snap.claude_md_included is True
        assert "custom rules here" in snap.system_prompt
        assert "Project Instructions" in snap.system_prompt

    def test_flag_on_but_no_file_yields_note(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("USE_CLAUDE_MD", "true")
        snap = build_prompt_preview(tmp_path, tmp_path)
        assert snap.claude_md_included is False
        assert any("file not found" in n for n in snap.notes)


# ---------------------------------------------------------------------------
# Domain addendum


class TestDomainAddendum:
    def test_no_addendum_when_no_domain(self, tmp_path: Path) -> None:
        snap = build_prompt_preview(tmp_path, tmp_path)
        assert snap.domain_addendum_included is False
        assert snap.domain_addendum_chars == 0

    def test_addendum_appended_when_spec_has_domain(self, tmp_path: Path) -> None:
        (tmp_path / "requirements.json").write_text(
            json.dumps({"domain": "fintech"}), encoding="utf-8"
        )
        snap = build_prompt_preview(tmp_path, tmp_path)
        assert snap.domain_addendum_included is True
        assert snap.domain_addendum_chars > 0
        assert "Domain-Specific Guidance" in snap.system_prompt

    def test_unknown_agent_type_skips_addendum(self, tmp_path: Path) -> None:
        (tmp_path / "requirements.json").write_text(
            json.dumps({"domain": "fintech"}), encoding="utf-8"
        )
        snap = build_prompt_preview(tmp_path, tmp_path, agent_type="spec_gatherer")
        assert snap.domain_addendum_included is False


# ---------------------------------------------------------------------------
# Model / provider / tools resolution


class TestModelAndTools:
    def test_default_model_is_resolved(self, tmp_path: Path) -> None:
        snap = build_prompt_preview(tmp_path, tmp_path, agent_type="coder")
        # Without any per-spec config, falls back to the default.
        assert snap.model
        # Anthropic by default unless CLI override.
        assert snap.provider in ("anthropic", "")  # empty if resolution failed

    @pytest.mark.parametrize(
        "agent_type,expected_phase",
        [
            ("planner", "planning"),
            ("coder", "coding"),
            ("qa_reviewer", "qa"),
            ("qa_fixer", "qa"),
            ("documenter", "coding"),
            ("totally-unknown", "coding"),
        ],
    )
    def test_phase_mapping(self, agent_type: str, expected_phase: str) -> None:
        assert _phase_for(agent_type) == expected_phase


# ---------------------------------------------------------------------------
# Robustness


class TestRobustness:
    def test_does_not_raise_when_modules_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force phase_config import to fail.
        import builtins

        original_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "phase_config":
                raise ImportError("simulated")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        snap = build_prompt_preview(tmp_path, tmp_path)
        # Function returned a snapshot, recorded the failure as a note.
        assert any("Phase model resolution failed" in n for n in snap.notes)
        # Sensible defaults applied.
        assert snap.provider == "anthropic"
        assert snap.model == ""


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
