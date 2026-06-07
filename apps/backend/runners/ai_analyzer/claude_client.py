"""
Claude SDK client wrapper for AI analysis.

Thin adapter on top of the canonical core.client.create_client() factory so
the analyzer benefits from the project-wide optimisations (prompt caching,
setting_sources, hooks, budget caps, effort tuning, MCP servers, etc.)
without duplicating their wiring here.
"""

from pathlib import Path
from typing import Any

try:
    from claude_agent_sdk import (
        ClaudeSDKClient,  # noqa: F401  (kept for type hints / availability check)
    )
    from phase_config import resolve_model_id

    CLAUDE_SDK_AVAILABLE = True
except ImportError:
    CLAUDE_SDK_AVAILABLE = False


class ClaudeAnalysisClient:
    """Wrapper for Claude SDK client with analysis-specific configuration."""

    DEFAULT_MODEL = "sonnet"  # Shorthand - resolved via API Profile if configured
    AGENT_TYPE = "analyzer"

    def __init__(self, project_dir: Path, spec_dir: Path | None = None):
        """
        Initialize Claude client.

        Args:
            project_dir: Root directory of project being analyzed.
            spec_dir:    Optional spec directory for usage tracking and per-card
                         persistence. When omitted, a synthetic spec dir under
                         <project>/.workpilot/analyzer/ is used so the factory
                         has somewhere to write .session.json and usage data.
        """
        if not CLAUDE_SDK_AVAILABLE:
            raise RuntimeError(
                "claude-agent-sdk not available. Install with: pip install claude-agent-sdk"
            )

        self.project_dir = project_dir
        # Synthetic spec dir keeps the analyzer addressable in usage_tracker
        # without forcing every caller to invent one.
        self.spec_dir = spec_dir or (project_dir / ".workpilot" / "analyzer")
        self.spec_dir.mkdir(parents=True, exist_ok=True)
        self._validate_oauth_token()

    def _validate_oauth_token(self) -> None:
        """Validate that an authentication token is available."""
        from core.auth import require_auth_token

        require_auth_token()  # Raises ValueError if no token found

    async def run_analysis_query(self, prompt: str) -> str:
        """
        Run a Claude query for analysis.

        Args:
            prompt: The analysis prompt

        Returns:
            Claude's response text
        """
        client = self._create_client()

        async with client:
            await client.query(prompt)
            return await self._collect_response(client)

    def _create_client(self) -> Any:
        """
        Create a Claude SDK client via the canonical factory so the analyzer
        inherits cache settings, hooks, MCP servers, budget caps, etc.
        """
        from core.client import create_client

        return create_client(
            project_dir=self.project_dir,
            spec_dir=self.spec_dir,
            model=resolve_model_id(self.DEFAULT_MODEL),
            agent_type=self.AGENT_TYPE,
        )

    async def _collect_response(self, client: Any) -> str:
        """
        Collect text response from Claude client and record usage.

        Args:
            client: ClaudeSDKClient instance

        Returns:
            Collected response text
        """
        response_text = ""
        result_msg = None

        async for msg in client.receive_response():
            msg_type = type(msg).__name__

            if msg_type == "ResultMessage":
                result_msg = msg
            elif msg_type == "AssistantMessage":
                for content in msg.content:
                    if hasattr(content, "text"):
                        response_text += content.text

        # Best-effort usage recording. Mirrors the pattern used by
        # agents/session.py so the analyzer's cost shows up in
        # dashboard_snapshot.json + cost_data.json alongside everything else.
        if result_msg is not None:
            try:
                from core.usage_tracker import record_session_usage

                usage = getattr(result_msg, "usage", None) or {}
                cost_usd = getattr(result_msg, "total_cost_usd", None) or 0.0
                if isinstance(usage, dict):
                    record_session_usage(
                        spec_dir=self.spec_dir,
                        project_dir=self.project_dir,
                        phase="analysis",
                        agent_type=self.AGENT_TYPE,
                        model=getattr(
                            getattr(client, "options", None), "model", "unknown"
                        )
                        or "unknown",
                        provider="anthropic",
                        input_tokens=usage.get("input_tokens", 0),
                        output_tokens=usage.get("output_tokens", 0),
                        cost_usd=cost_usd,
                        cache_creation_input_tokens=usage.get(
                            "cache_creation_input_tokens", 0
                        ),
                        cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
                    )
            except Exception:
                # Never let usage tracking failures bubble up to the caller.
                pass

        return response_text
