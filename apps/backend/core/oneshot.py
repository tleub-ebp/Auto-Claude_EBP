"""
Provider-agnostic one-shot LLM completion
==========================================

A single helper for the lightweight utilities (task title, terminal name, spec
interview, visual-proof navigation) so they honour the **user's selected
provider** (Claude / Copilot / OpenAI / Windsurf / …) instead of hardcoding the
Claude Agent SDK.

Routing mirrors ``core.client.create_agent_client``:
  - claude / anthropic        → ``create_simple_client`` (lightweight, text-only)
  - copilot / openai / windsurf → the matching AgentClient directly (no project
                                  context required — works for context-free
                                  utilities like title generation)
  - any other provider        → ``create_agent_client`` when a project/spec
                                context is available (its own routing + fallback),
                                otherwise the Claude lightweight client.

Always single-turn, text-only (no tools). Callers post-process the returned
text (strip, parse JSON, …) and degrade gracefully when it is empty.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Providers with a first-class AgentClient that can be instantiated without any
# project context — required for the context-free utilities.
_unused_first_class = {"claude", "anthropic", "copilot", "openai", "windsurf"}

# Cheap default model per provider for these tiny one-shot calls.
_DEFAULT_MODELS = {
    "claude": "claude-haiku-4-5",
    "anthropic": "claude-haiku-4-5",
    "copilot": "gpt-4o-mini",
    "openai": "gpt-4o-mini",
    "windsurf": "claude-3.5-haiku",
    "google": "gemini-2.0-flash",
}
_FALLBACK_MODEL = "claude-haiku-4-5"

# When the provider has no known cheap default (exotic provider), fall back to a
# model the task already uses (guaranteed valid for that provider).
_PHASE_MODEL_PRIORITY = ("qa_review", "qa_fixing", "spec", "planning", "coding")


def _model_from_task(spec_dir: Path | None) -> str | None:
    """Pick a model the task already uses, from task_metadata.json phaseModels."""
    if not spec_dir:
        return None
    try:
        meta_path = spec_dir / "task_metadata.json"
        if not meta_path.exists():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        phase_models = meta.get("phaseModels") or {}
        if not isinstance(phase_models, dict):
            return None
        for key in _PHASE_MODEL_PRIORITY:
            value = phase_models.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in phase_models.values():
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        return None
    return None


def _resolve_model(provider: str, explicit: str | None, spec_dir: Path | None) -> str:
    if explicit:
        return explicit
    default = _DEFAULT_MODELS.get(provider)
    if default:
        return default
    return _model_from_task(spec_dir) or _FALLBACK_MODEL


def _extract_text(msg) -> str:
    """Collect plain text from a provider-agnostic AgentMessage."""
    from core.agent_client import ContentBlockType

    text = ""
    for block in getattr(msg, "content", []) or []:
        if getattr(block, "type", None) == ContentBlockType.TEXT and getattr(
            block, "text", None
        ):
            text += block.text
    return text


def _claude_client(model: str, system_prompt: str | None, project_dir: str | None):
    from core.agent_client import ClaudeAgentClient
    from core.simple_client import create_simple_client

    sdk = create_simple_client(
        agent_type="commit_message",  # text-only, no tools
        model=model,
        system_prompt=system_prompt,
        cwd=Path(project_dir) if project_dir else None,
        max_turns=1,
    )
    return ClaudeAgentClient(sdk)


def _build_client(
    provider: str,
    model: str,
    system_prompt: str | None,
    project_dir: str | None,
    spec_dir: str | None,
    max_turns: int,
):
    cwd = str(Path(project_dir).resolve()) if project_dir else None

    if provider in ("claude", "anthropic"):
        return _claude_client(model, system_prompt, project_dir)

    if provider == "copilot":
        from core.agent_client import CopilotAgentClient

        return CopilotAgentClient(
            model=model,
            system_prompt=system_prompt,
            allowed_tools=[],
            cwd=cwd,
            agent_type="commit_message",
            max_turns=max_turns,
        )

    if provider == "openai":
        from core.agent_client import OpenAIAgentClient

        return OpenAIAgentClient(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=cwd,
            agent_type="commit_message",
        )

    if provider == "windsurf":
        from core.agent_client import WindsurfAgentClient

        return WindsurfAgentClient(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=cwd or ".",
            agent_type="commit_message",
        )

    if provider == "google":
        from core.agent_client import GoogleAgentClient

        return GoogleAgentClient(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=cwd,
            agent_type="commit_message",
        )

    # Exotic provider (google/ollama/mistral/…): use the full factory when a
    # project/spec context is available (it carries the provider routing +
    # fallback), otherwise degrade to the Claude lightweight client.
    if project_dir and spec_dir:
        from core.client import create_agent_client

        return create_agent_client(
            project_dir=Path(project_dir),
            spec_dir=Path(spec_dir),
            model=model,
            agent_type="commit_message",
            provider=provider,
            system_prompt=system_prompt,
        )

    logger.info(
        "[oneshot] Provider '%s' has no context-free client — using Claude.", provider
    )
    return _claude_client(_DEFAULT_MODELS["claude"], system_prompt, project_dir)


async def oneshot_completion(
    prompt: str,
    system_prompt: str | None = None,
    *,
    provider: str | None = None,
    model: str | None = None,
    project_dir: str | None = None,
    spec_dir: str | None = None,
    max_turns: int = 1,
) -> str:
    """Run a single text completion against the active provider; return the text.

    Returns an empty string on any failure inside the stream (the caller decides
    how to degrade). Raising exceptions is left to the caller's runner so they
    surface on stderr.
    """
    from core.client import _get_active_provider

    spec_path = Path(spec_dir) if spec_dir else None
    resolved_provider = (provider or "").strip().lower() or _get_active_provider(
        spec_path
    )
    resolved_model = _resolve_model(resolved_provider, model, spec_path)

    logger.info(
        "[oneshot] provider=%s model=%s (context=%s)",
        resolved_provider,
        resolved_model,
        "yes" if (project_dir and spec_dir) else "no",
    )

    client = _build_client(
        resolved_provider,
        resolved_model,
        system_prompt,
        project_dir,
        spec_dir,
        max_turns,
    )

    text = ""
    async with client:
        await client.query(prompt)
        async for msg in client.receive_response():
            text += _extract_text(msg)
    return text.strip()
