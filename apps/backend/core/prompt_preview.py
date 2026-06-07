"""Reconstruct what would be sent to the agent SDK, without spawning one.

Used by the Kanban "Voir prompt actif" debug button. We deliberately
mirror the assembly logic in :func:`core.client.create_client` (CLAUDE.md
inclusion, domain addendum injection) so what the user sees here matches
what the agent actually receives at runtime.

Read-only — no SDK auth required, no subprocess spawned.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class PromptPreview:
    """Snapshot of the SDK-level configuration for a (project, spec, agent_type)."""

    project_dir: str
    spec_dir: str
    agent_type: str
    model: str
    provider: str
    system_prompt: str
    system_prompt_length: int
    claude_md_included: bool
    domain_addendum_included: bool
    domain_addendum_chars: int
    allowed_tools: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_dir": self.project_dir,
            "spec_dir": self.spec_dir,
            "agent_type": self.agent_type,
            "model": self.model,
            "provider": self.provider,
            "system_prompt": self.system_prompt,
            "system_prompt_length": self.system_prompt_length,
            "claude_md_included": self.claude_md_included,
            "domain_addendum_included": self.domain_addendum_included,
            "domain_addendum_chars": self.domain_addendum_chars,
            "allowed_tools": list(self.allowed_tools),
            "notes": list(self.notes),
        }


def _base_prompt_for(project_dir: Path) -> str:
    """The same opening paragraph create_client builds for every Claude run."""
    return (
        f"You are an expert full-stack developer building production-quality "
        f"software. Your working directory is: {project_dir.resolve()}\n"
        f"Your filesystem access is RESTRICTED to this directory only. "
        f"Use relative paths (starting with ./) for all file operations. "
        f"Never use absolute paths or try to access files outside your working "
        f"directory.\n\n"
        f"You follow existing code patterns, write clean maintainable code, "
        f"and verify your work through thorough testing. You communicate "
        f"progress through Git commits and build-progress.txt updates."
    )


def build_prompt_preview(
    project_dir: Path,
    spec_dir: Path,
    *,
    agent_type: str = "coder",
) -> PromptPreview:
    """Build a snapshot mirroring what create_client would assemble.

    Never raises — populates ``notes`` when something is unavailable so
    the UI can surface "domain addendum couldn't be loaded" etc.
    """
    project_dir = Path(project_dir)
    spec_dir = Path(spec_dir)
    notes: list[str] = []

    # --- Base prompt -------------------------------------------------------
    base_prompt = _base_prompt_for(project_dir)

    # --- CLAUDE.md ---------------------------------------------------------
    claude_md_included = False
    try:
        from core.client import load_claude_md, should_use_claude_md

        if should_use_claude_md():
            content = load_claude_md(project_dir)
            if content:
                base_prompt = (
                    f"{base_prompt}\n\n# Project Instructions (from CLAUDE.md)"
                    f"\n\n{content}"
                )
                claude_md_included = True
            else:
                notes.append(
                    "CLAUDE.md flag enabled but file not found at project root"
                )
        else:
            notes.append("CLAUDE.md disabled by USE_CLAUDE_MD env var")
    except Exception as exc:  # noqa: BLE001
        notes.append(f"CLAUDE.md inclusion check failed: {exc}")

    # --- Domain addendum ---------------------------------------------------
    domain_addendum_included = False
    domain_addendum_chars = 0
    try:
        from core.client import _inject_domain_addendum

        before_len = len(base_prompt)
        base_prompt = _inject_domain_addendum(base_prompt, agent_type, spec_dir)
        domain_addendum_chars = max(0, len(base_prompt) - before_len)
        domain_addendum_included = domain_addendum_chars > 0
    except Exception as exc:  # noqa: BLE001
        notes.append(f"Domain addendum injection failed: {exc}")

    # --- Resolved model / provider ----------------------------------------
    model = ""
    provider = "anthropic"
    try:
        from phase_config import get_phase_model, get_phase_provider

        provider = get_phase_provider(spec_dir) or "anthropic"
        model = get_phase_model(spec_dir, _phase_for(agent_type), None) or ""
    except Exception as exc:  # noqa: BLE001
        notes.append(f"Phase model resolution failed: {exc}")

    # --- Allowed tools -----------------------------------------------------
    allowed_tools: list[str] = []
    try:
        from agents.tools_pkg.models import (
            AGENT_CONFIGS,  # type: ignore[import-not-found]
        )

        cfg = AGENT_CONFIGS.get(agent_type)
        if cfg is None:
            notes.append(f"agent_type {agent_type!r} not in AGENT_CONFIGS")
        else:
            # Use the static `allowed_tools` attribute when present — we don't
            # try to call get_allowed_tools() here because it pulls in MCP
            # config + Linear flags + project capabilities, which is a heavy
            # path with side-effect risk for a debug preview.
            allowed_tools = list(getattr(cfg, "allowed_tools", []) or [])
    except Exception as exc:  # noqa: BLE001
        notes.append(f"Could not enumerate allowed tools: {exc}")

    return PromptPreview(
        project_dir=str(project_dir),
        spec_dir=str(spec_dir),
        agent_type=agent_type,
        model=model,
        provider=provider,
        system_prompt=base_prompt,
        system_prompt_length=len(base_prompt),
        claude_md_included=claude_md_included,
        domain_addendum_included=domain_addendum_included,
        domain_addendum_chars=domain_addendum_chars,
        allowed_tools=allowed_tools,
        notes=notes,
    )


def _phase_for(agent_type: str) -> str:
    """Map agent_type → phase used by phase_config.get_phase_model."""
    return {
        "planner": "planning",
        "coder": "coding",
        "qa_reviewer": "qa",
        "qa_fixer": "qa",
        "documenter": "coding",
    }.get(agent_type, "coding")
