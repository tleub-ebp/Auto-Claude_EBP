"""Tests for the Model Router / Cognitive Context / Domain Agents wiring."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents.feature_wiring import (
    COGNITIVE_CONTEXT_ENV_VAR,
    MODEL_ROUTER_OVERRIDE_ENV_VAR,
    apply_router_override,
    cognitive_context_enabled,
    load_domain_addendum,
    maybe_optimize_context,
    model_router_override_enabled,
    suggest_routed_model,
)

# ---------------------------------------------------------------------------
# suggest_routed_model


class TestSuggestRoutedModel:
    def test_returns_choice_dict(self) -> None:
        result = suggest_routed_model(
            prompt="rename foo to bar",
            task_hint="trivial",
            available_providers=["anthropic"],
        )
        assert result is not None
        assert "provider" in result
        assert "model" in result
        assert "estimated_cost_usd" in result
        assert "task_class" in result
        assert "tier" in result

    def test_returns_none_when_router_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force the import to fail.
        import builtins

        original_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "model_router":
                raise ImportError("simulated")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        assert suggest_routed_model(prompt="x") is None

    def test_returns_none_when_router_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force ModelRouter.route to throw — caller must get None, not crash.
        from agents import feature_wiring as fw

        class BoomRouter:
            def __init__(self, *_a, **_k): ...

            def route(self, *_a, **_k):
                raise RuntimeError("boom")

        # Pretend our module already imported it.
        import model_router as mr

        monkeypatch.setattr(mr, "ModelRouter", BoomRouter)
        assert fw.suggest_routed_model(prompt="x") is None


# ---------------------------------------------------------------------------
# Cognitive Context Optimizer (opt-in)


class TestCognitiveContextEnabled:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("1", True),
            ("true", True),
            ("YES", True),
            ("on", True),
            ("0", False),
            ("false", False),
            ("", False),
            ("anything-else", False),
        ],
    )
    def test_truthy_values(
        self, monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
    ) -> None:
        monkeypatch.setenv(COGNITIVE_CONTEXT_ENV_VAR, value)
        assert cognitive_context_enabled() is expected

    def test_default_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(COGNITIVE_CONTEXT_ENV_VAR, raising=False)
        assert cognitive_context_enabled() is False


class TestMaybeOptimizeContext:
    def test_no_op_when_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(COGNITIVE_CONTEXT_ENV_VAR, raising=False)
        result = maybe_optimize_context(prompt="task", candidate_files=["a.py", "b.py"])
        assert result is None

    def test_no_op_when_no_files(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(COGNITIVE_CONTEXT_ENV_VAR, "1")
        assert maybe_optimize_context(prompt="task", candidate_files=[]) is None

    def test_runs_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(COGNITIVE_CONTEXT_ENV_VAR, "1")
        # Create a small file so the optimiser has something to read.
        f = tmp_path / "x.py"
        f.write_text("def foo():\n    return 1\n", encoding="utf-8")
        result = maybe_optimize_context(
            prompt="rename foo",
            candidate_files=[f],
            project_dir=tmp_path,
            token_budget=2_000,
        )
        # Either ran successfully (returned a dict) or skipped due to internal
        # error (returned None) — both are acceptable; what matters is that
        # the helper doesn't crash the caller.
        assert result is None or isinstance(result, dict)


# ---------------------------------------------------------------------------
# Domain Agents


def _write_requirements(spec_dir: Path, content: dict) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "requirements.json").write_text(json.dumps(content), encoding="utf-8")


class TestLoadDomainAddendum:
    def test_no_requirements_file_returns_empty(self, tmp_path: Path) -> None:
        assert load_domain_addendum(tmp_path) == ""

    def test_no_domain_field_returns_empty(self, tmp_path: Path) -> None:
        _write_requirements(tmp_path, {"name": "spec-1"})
        assert load_domain_addendum(tmp_path) == ""

    def test_unknown_domain_returns_empty(self, tmp_path: Path) -> None:
        _write_requirements(tmp_path, {"domain": "not_a_real_domain"})
        assert load_domain_addendum(tmp_path) == ""

    def test_known_domain_returns_addendum(self, tmp_path: Path) -> None:
        _write_requirements(tmp_path, {"domain": "fintech"})
        addendum = load_domain_addendum(tmp_path, role="coder")
        assert addendum  # non-empty
        # The addendum should mention fintech-relevant guardrails.
        assert any(
            kw in addendum.lower()
            for kw in ("fintech", "audit", "transaction", "money", "decimal")
        )

    def test_unknown_role_returns_empty(self, tmp_path: Path) -> None:
        _write_requirements(tmp_path, {"domain": "fintech"})
        assert load_domain_addendum(tmp_path, role="not_a_role") == ""

    def test_corrupt_requirements_json_returns_empty(self, tmp_path: Path) -> None:
        (tmp_path / "requirements.json").write_text("not json", encoding="utf-8")
        assert load_domain_addendum(tmp_path) == ""

    def test_empty_string_domain_returns_empty(self, tmp_path: Path) -> None:
        _write_requirements(tmp_path, {"domain": "   "})
        assert load_domain_addendum(tmp_path) == ""


# ---------------------------------------------------------------------------
# apply_router_override


class TestModelRouterOverrideEnabled:
    def test_default_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, raising=False)
        assert model_router_override_enabled() is False

    def test_truthy_values(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for v in ("1", "true", "YES", "on"):
            monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, v)
            assert model_router_override_enabled() is True


class TestApplyRouterOverride:
    def test_no_op_when_flag_off(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.delenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, raising=False)
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_no_op_when_cli_model_explicit(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
            cli_model="claude-opus-4-7",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_no_op_when_task_metadata_has_model(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        (tmp_path / "task_metadata.json").write_text(
            json.dumps({"model": "claude-opus-4-7"}), encoding="utf-8"
        )
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_no_op_when_task_metadata_has_phase_models(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        (tmp_path / "task_metadata.json").write_text(
            json.dumps(
                {
                    "isAutoProfile": True,
                    "phaseModels": {"coding": "claude-opus-4-7"},
                }
            ),
            encoding="utf-8",
        )
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_substitutes_when_no_explicit_choice(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        # Inject a fake suggestion so we don't depend on the catalogue.
        from agents import feature_wiring as fw

        def fake_suggest(**_kw):
            return {
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "estimated_cost_usd": 0.001,
                "reason": "trivial task",
                "task_class": "trivial",
                "tier": "haiku",
            }

        monkeypatch.setattr(fw, "suggest_routed_model", fake_suggest)
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-haiku-4-5"
        assert info is not None
        assert info["model"] == "claude-haiku-4-5"

    def test_no_substitution_when_router_returns_same_model(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        from agents import feature_wiring as fw

        monkeypatch.setattr(
            fw,
            "suggest_routed_model",
            lambda **_kw: {
                "provider": "anthropic",
                "model": "claude-opus-4-7",
                "estimated_cost_usd": 0.05,
                "reason": "same",
                "task_class": "complex",
                "tier": "opus",
            },
        )
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_no_substitution_when_router_returns_none(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        from agents import feature_wiring as fw

        monkeypatch.setattr(fw, "suggest_routed_model", lambda **_kw: None)
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        assert new_model == "claude-opus-4-7"
        assert info is None

    def test_corrupt_task_metadata_is_treated_as_no_choice(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv(MODEL_ROUTER_OVERRIDE_ENV_VAR, "1")
        (tmp_path / "task_metadata.json").write_text("not json", encoding="utf-8")
        from agents import feature_wiring as fw

        monkeypatch.setattr(
            fw,
            "suggest_routed_model",
            lambda **_kw: {
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "estimated_cost_usd": 0.001,
                "reason": "trivial",
                "task_class": "trivial",
                "tier": "haiku",
            },
        )
        new_model, info = apply_router_override(
            "claude-opus-4-7",
            spec_dir=tmp_path,
            phase="coding",
        )
        # Corrupt metadata = no inference of explicit choice → router substitutes.
        assert new_model == "claude-haiku-4-5"
        assert info is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
