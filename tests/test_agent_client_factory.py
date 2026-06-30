#!/usr/bin/env python3
"""
Tests for Provider-Aware Agent Client Factory
===============================================

Unit tests for create_agent_client() and _get_active_provider() in core/client.py.
Covers:
- Provider detection from environment variables
- Provider detection from project-level .workpilot/.env
- Default provider fallback
- Claude provider path (wraps create_client)
- Copilot provider path (creates CopilotAgentClient)
- Invalid provider rejection
"""

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

# Mock claude_agent_sdk before any imports that transitively need it
if "claude_agent_sdk" not in sys.modules:
    _mock_sdk = MagicMock()
    _mock_sdk.ClaudeSDKClient = MagicMock()
    _mock_sdk.ClaudeAgentOptions = MagicMock()
    _mock_sdk.AgentDefinition = MagicMock()
    _mock_sdk.types = MagicMock()
    _mock_sdk.types.HookMatcher = MagicMock()
    sys.modules["claude_agent_sdk"] = _mock_sdk
    sys.modules["claude_agent_sdk.types"] = _mock_sdk.types

from core.agent_client import (
    AgentClient,
    ClaudeAgentClient,
    CopilotAgentClient,
    LocalAgentClient,
)
from core.client import _get_active_provider

# =============================================================================
# _get_active_provider() Tests
# =============================================================================


class TestGetActiveProvider:
    """Tests for _get_active_provider() resolution logic."""

    def test_default_is_claude(self, monkeypatch):
        """Default provider should be 'claude' when no env or project setting."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
        assert _get_active_provider(spec_dir=None) == "claude"

    def test_env_override_claude(self, monkeypatch):
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "claude")
        assert _get_active_provider(spec_dir=None) == "claude"

    def test_env_override_copilot(self, monkeypatch):
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "copilot")
        assert _get_active_provider(spec_dir=None) == "copilot"

    def test_env_override_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "COPILOT")
        assert _get_active_provider(spec_dir=None) == "copilot"

    def test_env_override_with_whitespace(self, monkeypatch):
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "  copilot  ")
        assert _get_active_provider(spec_dir=None) == "copilot"

    def test_env_invalid_value_falls_through(self, monkeypatch):
        """Invalid env value should fall through to default."""
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "invalid_provider")
        assert _get_active_provider(spec_dir=None) == "claude"

    def test_project_env_file_copilot(self, tmp_path, monkeypatch):
        """Provider detected from .workpilot/.env AI_PROVIDER=copilot."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("AI_PROVIDER=copilot\nSOME_OTHER=value\n")

        assert _get_active_provider(spec_dir=tmp_path) == "copilot"

    def test_project_env_file_claude(self, tmp_path, monkeypatch):
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("AI_PROVIDER=claude\n")

        assert _get_active_provider(spec_dir=tmp_path) == "claude"

    def test_project_env_file_quoted_value(self, tmp_path, monkeypatch):
        """Quoted values in .env should be handled."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text('AI_PROVIDER="copilot"\n')

        assert _get_active_provider(spec_dir=tmp_path) == "copilot"

    def test_project_env_file_missing(self, tmp_path, monkeypatch):
        """No .workpilot/.env -> default."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
        assert _get_active_provider(spec_dir=tmp_path) == "claude"

    def test_project_env_file_no_ai_provider_key(self, tmp_path, monkeypatch):
        """File exists but no AI_PROVIDER key -> default."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("GITHUB_TOKEN=ghp_test\n")

        assert _get_active_provider(spec_dir=tmp_path) == "claude"

    def test_env_override_takes_precedence_over_file(self, tmp_path, monkeypatch):
        """Env var should override project file."""
        monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "claude")

        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("AI_PROVIDER=copilot\n")

        assert _get_active_provider(spec_dir=tmp_path) == "claude"

    def test_parent_directory_traversal(self, tmp_path, monkeypatch):
        """Spec dir inside .workpilot should find .env in parent."""
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

        # Create structure: tmp_path/.workpilot/.env and tmp_path/.workpilot/spec/
        auto_claude_dir = tmp_path / ".workpilot"
        auto_claude_dir.mkdir()
        env_file = auto_claude_dir / ".env"
        env_file.write_text("AI_PROVIDER=copilot\n")

        spec_dir = auto_claude_dir / "spec"
        spec_dir.mkdir()

        # spec_dir is tmp_path/.workpilot/spec — parent traversal should
        # find tmp_path/.workpilot/.env
        assert _get_active_provider(spec_dir=spec_dir) == "copilot"


# =============================================================================
# create_agent_client() Tests
# =============================================================================


class TestCreateAgentClient:
    """Tests for the create_agent_client() factory."""

    @patch("core.client.create_client")
    def test_claude_provider_wraps_sdk_client(self, mock_create_client, tmp_path):
        """provider='claude' should call create_client and wrap result."""
        from core.client import create_agent_client

        mock_sdk = MagicMock()
        mock_create_client.return_value = mock_sdk

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
            agent_type="coder",
            provider="claude",
        )

        assert isinstance(client, ClaudeAgentClient)
        assert isinstance(client, AgentClient)
        assert client.inner is mock_sdk
        mock_create_client.assert_called_once()

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_copilot_provider_creates_copilot_client(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """provider='copilot' should create a CopilotAgentClient."""
        from core.client import create_agent_client

        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test_token")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = ["Read", "Write"]

        # Mock is_linear_enabled
        monkeypatch.setattr(
            "core.client.is_linear_enabled", lambda: False
        )

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
            agent_type="coder",
            provider="copilot",
        )

        assert isinstance(client, CopilotAgentClient)
        assert isinstance(client, AgentClient)
        assert client.model == "gpt-4o"
        assert client.provider_name() == "copilot"

    @patch("core.client.create_client")
    def test_invalid_provider_falls_back_to_claude(self, mock_create_client, tmp_path):
        """Invalid provider should fall back to Claude SDK."""
        from core.client import create_agent_client

        mock_create_client.return_value = MagicMock()

        # Should not raise an error, but fall back to Claude
        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="test",
            provider="invalid_provider",
        )

        # Should return a ClaudeAgentClient due to fallback
        assert isinstance(client, ClaudeAgentClient)

    @patch("core.client.create_client")
    def test_ollama_provider_creates_local_client(
        self, mock_create_client, tmp_path, monkeypatch
    ):
        """provider='ollama' should create a LocalAgentClient (not fall back to Claude)."""
        from core.client import create_agent_client

        # If the local branch were missing, the factory would call create_client
        # (Claude fallback). Mock it so an accidental fallback is detectable.
        mock_create_client.return_value = MagicMock()
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="qwen2.5-coder",
            agent_type="coder",
            provider="ollama",
        )

        assert isinstance(client, LocalAgentClient)
        assert isinstance(client, AgentClient)
        assert client.provider_name() == "ollama"
        assert client.model == "qwen2.5-coder"
        # The loopback host is pinned to IPv4 (localhost → 127.0.0.1) so the
        # client reaches the IPv4-bound Ollama daemon.
        assert client._api_base == "http://127.0.0.1:1234/v1/chat/completions"
        mock_create_client.assert_not_called()

    @patch("core.client.create_client")
    def test_lmstudio_alias_creates_local_client(
        self, mock_create_client, tmp_path, monkeypatch
    ):
        """The 'lmstudio'/'local' aliases also route to LocalAgentClient."""
        from core.client import create_agent_client

        mock_create_client.return_value = MagicMock()
        monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
        monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://localhost:1234")

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="local-model",
            agent_type="coder",
            provider="lmstudio",
        )

        assert isinstance(client, LocalAgentClient)
        mock_create_client.assert_not_called()

    @patch("core.client._get_active_provider")
    @patch("core.client.create_client")
    def test_auto_detect_uses_get_active_provider(
        self, mock_create_client, mock_detect, tmp_path
    ):
        """provider=None should auto-detect via _get_active_provider."""
        from core.client import create_agent_client

        mock_detect.return_value = "claude"
        mock_create_client.return_value = MagicMock()

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
            provider=None,
        )

        mock_detect.assert_called_once_with(tmp_path)
        assert isinstance(client, ClaudeAgentClient)

    @patch("core.client.create_client")
    def test_claude_passes_all_params(self, mock_create_client, tmp_path):
        """Verify all params are forwarded to create_client for Claude path."""
        from core.client import create_agent_client

        mock_create_client.return_value = MagicMock()

        agents = {"test": MagicMock()}
        output_format = {"type": "json_schema", "schema": {}}

        create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-5-20250929",
            agent_type="pr_reviewer",
            max_thinking_tokens=8000,
            output_format=output_format,
            agents=agents,
            provider="claude",
        )

        call_kwargs = mock_create_client.call_args[1]
        assert call_kwargs["project_dir"] == tmp_path
        assert call_kwargs["model"] == "claude-sonnet-4-5-20250929"
        assert call_kwargs["agent_type"] == "pr_reviewer"
        assert call_kwargs["max_thinking_tokens"] == 8000
        assert call_kwargs["output_format"] == output_format
        assert call_kwargs["agents"] is agents

    @patch("core.client._get_cached_project_data")
    @patch("core.client.load_project_mcp_config")
    @patch("core.client.get_allowed_tools")
    def test_copilot_converts_agent_definitions(
        self, mock_tools, mock_mcp, mock_cache, tmp_path, monkeypatch
    ):
        """Copilot path should convert AgentDefinition-like objects to SubagentDefinition."""
        from core.client import create_agent_client

        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        mock_cache.return_value = ({}, {})
        mock_mcp.return_value = {}
        mock_tools.return_value = []
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: False)

        # Simulate an AgentDefinition-like object (has .description, .prompt, etc.)
        mock_agent_def = MagicMock()
        mock_agent_def.description = "Security checker"
        mock_agent_def.prompt = "Check for vulnerabilities"
        mock_agent_def.tools = ["Read"]
        mock_agent_def.model = "gpt-4o"

        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gpt-4o",
            agents={"security": mock_agent_def},
            provider="copilot",
        )

        assert isinstance(client, CopilotAgentClient)
        assert "security" in client.agents
        assert client.agents["security"].description == "Security checker"
        assert client.agents["security"].prompt == "Check for vulnerabilities"
