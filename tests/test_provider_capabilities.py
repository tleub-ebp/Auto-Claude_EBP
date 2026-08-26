"""Tests for the provider capability matrix and the degradation it makes visible.

WorkPilot advertises itself as provider-agnostic. Before this matrix existed,
picking Mistral, DeepSeek, Grok, Meta or AWS silently ran the task on Claude:
`create_agent_client`'s else-branch logged a warning and called `create_client`,
which has no provider parameter at all. The degradation still happens — writing
five agentic adapters is separate work — but it must be stated, not hidden.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.providers import (  # noqa: E402
    get_provider_capabilities,
    load_providers,
)


class TestMatrix:
    def test_matrix_covers_every_configured_provider(self):
        """A provider the user can pick in the UI must have a declared capability."""
        import json

        configured = {
            p["name"]
            for p in json.loads(
                (REPO_ROOT / "config" / "configured_providers.json").read_text(
                    encoding="utf-8"
                )
            )["providers"]
        }
        # `anthropic` is the UI label; the runtime name is `claude`.
        configured = {"claude" if n == "anthropic" else n for n in configured}
        declared = set(load_providers(REPO_ROOT))
        missing = configured - declared
        assert not missing, f"providers with no declared capabilities: {missing}"

    @pytest.mark.parametrize("name", ["claude", "copilot"])
    def test_only_claude_and_copilot_run_subagents(self, name):
        assert get_provider_capabilities(name).supports_subagents

    @pytest.mark.parametrize(
        "name", ["openai", "google", "ollama", "windsurf", "mistral", "deepseek"]
    )
    def test_everything_else_does_not(self, name):
        assert not get_provider_capabilities(name).supports_subagents

    @pytest.mark.parametrize("name", ["mistral", "deepseek", "grok", "meta"])
    def test_adapterless_providers_declare_what_they_degrade_to(self, name):
        caps = get_provider_capabilities(name)
        assert not caps.has_adapter
        assert caps.degrades_to == "claude"

    def test_an_unlisted_provider_gets_the_conservative_answer(self):
        # Assuming a capability a provider lacks fails confusingly at run time;
        # assuming the opposite only costs parallelism.
        caps = get_provider_capabilities("some-new-provider")
        assert not caps.supports_subagents
        assert not caps.has_adapter
        assert caps.degrades_to == "claude"

    def test_every_provider_with_an_adapter_names_a_real_class(self):
        """Guards against the matrix drifting away from core/client.py."""
        source = (
            REPO_ROOT / "apps" / "backend" / "core" / "agent_client.py"
        ).read_text(encoding="utf-8")
        for name, caps in load_providers(REPO_ROOT).items():
            if caps.adapter:
                assert f"class {caps.adapter}" in source, (
                    f"{name} declares adapter {caps.adapter}, "
                    "which does not exist in core/agent_client.py"
                )


class TestDegradationIsVisible:
    def test_degradation_writes_to_the_task_feed(self, tmp_path, monkeypatch):
        from core import client as client_module

        seen: list[str] = []

        class FakeLogger:
            spec_dir = tmp_path

            def log_info(self, message):
                seen.append(message)

        import task_logger

        monkeypatch.setattr(task_logger, "get_task_logger", lambda: FakeLogger())
        client_module._log_provider_degradation(tmp_path, "mistral", "claude")

        assert len(seen) == 1
        assert "mistral" in seen[0] and "claude" in seen[0]
        assert "Subagents are disabled" in seen[0]

    def test_degradation_never_breaks_client_creation(self, tmp_path, monkeypatch):
        import task_logger
        from core import client as client_module

        def boom():
            raise RuntimeError("task logger exploded")

        monkeypatch.setattr(task_logger, "get_task_logger", boom)
        # Must not raise.
        client_module._log_provider_degradation(tmp_path, "mistral", "claude")

    def test_it_does_not_write_into_an_unrelated_task_feed(self, tmp_path, monkeypatch):
        from core import client as client_module

        seen: list[str] = []

        class OtherTaskLogger:
            spec_dir = tmp_path / "some-other-spec"

            def log_info(self, message):
                seen.append(message)

        import task_logger

        monkeypatch.setattr(task_logger, "get_task_logger", lambda: OtherTaskLogger())
        client_module._log_provider_degradation(tmp_path, "mistral", "claude")
        assert seen == []
