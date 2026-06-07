"""Tests for the domain addendum injection helper used by create_client."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.client import _DOMAIN_ROLE_BY_AGENT_TYPE, _inject_domain_addendum


def _seed_spec_with_domain(spec_dir: Path, domain: str) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "requirements.json").write_text(
        json.dumps({"domain": domain}), encoding="utf-8"
    )


BASE = "You are an expert developer."


class TestRoleMap:
    def test_known_agent_types(self) -> None:
        # All four pipeline agent types must map to a domain role.
        for agent_type in ("coder", "planner", "qa_reviewer", "qa_fixer"):
            assert agent_type in _DOMAIN_ROLE_BY_AGENT_TYPE

    def test_qa_agents_share_reviewer_role(self) -> None:
        assert _DOMAIN_ROLE_BY_AGENT_TYPE["qa_reviewer"] == "reviewer"
        assert _DOMAIN_ROLE_BY_AGENT_TYPE["qa_fixer"] == "reviewer"


class TestInjectDomainAddendum:
    def test_no_change_when_spec_dir_is_none(self) -> None:
        result = _inject_domain_addendum(BASE, "coder", None)
        assert result == BASE

    def test_no_change_when_unknown_agent_type(self, tmp_path: Path) -> None:
        _seed_spec_with_domain(tmp_path, "fintech")
        result = _inject_domain_addendum(BASE, "spec_gatherer", tmp_path)
        # spec_gatherer not in role map → no addendum.
        assert result == BASE

    def test_no_change_when_no_requirements_file(self, tmp_path: Path) -> None:
        result = _inject_domain_addendum(BASE, "coder", tmp_path)
        assert result == BASE

    def test_no_change_when_no_domain_field(self, tmp_path: Path) -> None:
        (tmp_path / "requirements.json").write_text(
            json.dumps({"name": "spec-1"}), encoding="utf-8"
        )
        result = _inject_domain_addendum(BASE, "coder", tmp_path)
        assert result == BASE

    def test_no_change_when_unknown_domain(self, tmp_path: Path) -> None:
        _seed_spec_with_domain(tmp_path, "no_such_domain")
        result = _inject_domain_addendum(BASE, "coder", tmp_path)
        assert result == BASE

    def test_appends_addendum_for_known_domain(self, tmp_path: Path) -> None:
        _seed_spec_with_domain(tmp_path, "fintech")
        result = _inject_domain_addendum(BASE, "coder", tmp_path)
        assert result.startswith(BASE)
        assert "Domain-Specific Guidance" in result
        # Some fintech-relevant marker must be present in the appended text.
        addendum = result[len(BASE) :]
        assert any(
            kw in addendum.lower()
            for kw in ("fintech", "audit", "transaction", "money", "decimal")
        )

    @pytest.mark.parametrize(
        "agent_type,expected_role",
        [
            ("coder", "coder"),
            ("planner", "planner"),
            ("qa_reviewer", "reviewer"),
            ("qa_fixer", "reviewer"),
            ("documenter", "documenter"),
        ],
    )
    def test_role_used_matches_role_map(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        agent_type: str,
        expected_role: str,
    ) -> None:
        # Spy on load_domain_addendum to confirm we always pass the right role.
        from agents import feature_wiring

        seen: dict[str, str] = {}

        def spy(spec_dir, *, role):
            seen["role"] = role
            return f"ADDENDUM-FOR-{role}"

        monkeypatch.setattr(feature_wiring, "load_domain_addendum", spy)
        _seed_spec_with_domain(tmp_path, "fintech")
        result = _inject_domain_addendum(BASE, agent_type, tmp_path)
        assert seen["role"] == expected_role
        assert f"ADDENDUM-FOR-{expected_role}" in result

    def test_loader_exception_does_not_break(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from agents import feature_wiring

        def boom(*_a, **_kw):
            raise RuntimeError("simulated")

        monkeypatch.setattr(feature_wiring, "load_domain_addendum", boom)
        _seed_spec_with_domain(tmp_path, "fintech")
        # Must not raise; falls back to the base prompt.
        assert _inject_domain_addendum(BASE, "coder", tmp_path) == BASE


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
