"""Composing the subagent roster for a run.

Three layers, in order, each able to override the one before it:

1. **Phase defaults** — the generic roster for planner / coder / QA.
2. **Language overlays** — what the detected stack changes about those roles.
   A `test-runner` that knows `pytest -x` and `vitest run` beats one that has
   to rediscover the framework every time.
3. **Caller-supplied agents** — always win. That was the contract of the three
   `merge_with_user_agents` functions this module replaces, and it is preserved
   exactly.

The roster is capped. Three to five concurrent subagents is where the
parallelism still pays; past seven, reconciling the summaries costs more than
it saves. When the cap bites, generic phase defaults are dropped before
specialised or caller-supplied ones — the specific entry is the one carrying
information the parent does not already have.

Providers that cannot run subagents get ``None``, not a roster nobody reads.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .languages import LanguageOverlay, overlays_for
from .phases import PHASE_ALIASES, phase_defaults, sdk_available

logger = logging.getLogger(__name__)

__all__ = ["resolve", "merge_with_user_agents", "detect_languages", "MAX_ROSTER"]

MAX_ROSTER = 7

# Stack detection touches the filesystem; the answer does not change during a
# run, and create_client is called once per phase.
_STACK_CACHE: dict[str, list[str]] = {}


def detect_languages(project_dir: Path | str | None) -> list[str]:
    """Languages present in ``project_dir``, or [] when it cannot be determined.

    Reuses ``detect_project_stack`` rather than adding a fourth stack detector
    to this repo. Import failures degrade to "no overlay", never to an error:
    a missing specialisation is a worse roster, a raised exception is a broken
    build.
    """
    if not project_dir:
        return []
    key = str(Path(project_dir).resolve())
    if key in _STACK_CACHE:
        return _STACK_CACHE[key]

    languages: list[str] = []
    try:
        from runners.pipeline_generator_runner import detect_project_stack

        languages = list(detect_project_stack(Path(key)).get("languages") or [])
    except Exception as exc:
        logger.debug("stack detection unavailable for %s: %s", key, exc)

    _STACK_CACHE[key] = languages
    return languages


def _specialise_test_runner(base: Any, overlays: list[LanguageOverlay]) -> Any:
    """Fold concrete commands into the generic `test-runner` prompt."""
    if not overlays or base is None:
        return base

    lines = ["", "## This project's stack", ""]
    for overlay in overlays:
        lines.append(f"### {overlay.language}")
        if overlay.test_commands:
            lines.append("Commands, most useful first:")
            lines.extend(f"  {cmd}" for cmd in overlay.test_commands)
        if overlay.notes:
            lines.append(f"Watch out: {overlay.notes}")
        lines.append("")
    lines.append(
        "Detection was done from the files on disk. If what you find "
        "contradicts the above, trust the repository and say so in your report."
    )

    try:
        from claude_agent_sdk import AgentDefinition

        return AgentDefinition(
            description=base.description,
            prompt=base.prompt + "\n" + "\n".join(lines),
            tools=base.tools,
            model=getattr(base, "model", None) or "inherit",
        )
    except Exception as exc:  # never break the roster
        # Warning, not debug: the run continues with a generic test-runner,
        # which still works but has to rediscover the framework every time.
        # A silent downgrade is how you end up wondering why the roster stopped
        # helping.
        logger.warning(
            "could not specialise test-runner, falling back to the generic prompt: %s",
            exc,
        )
        return base


def _apply_cap(roster: dict[str, Any], protected: set[str]) -> dict[str, Any]:
    """Trim to MAX_ROSTER, dropping unprotected generic entries first."""
    if len(roster) <= MAX_ROSTER:
        return roster
    droppable = [name for name in roster if name not in protected]
    # Deterministic: alphabetical, so the same project always gets the same
    # roster rather than one that shifts with dict ordering.
    for name in sorted(droppable):
        if len(roster) <= MAX_ROSTER:
            break
        logger.debug("subagent roster over cap; dropping %s", name)
        del roster[name]
    return roster


def resolve(
    agent_type: str,
    project_dir: Path | str | None = None,
    user_agents: dict[str, Any] | None = None,
    provider: str | None = None,
) -> dict[str, Any] | None:
    """The subagent roster for one run, or ``None`` when there should be none."""
    if provider:
        try:
            from skills_registry.providers import get_provider_capabilities

            if not get_provider_capabilities(provider).supports_subagents:
                logger.debug("provider %r runs no subagents; roster omitted", provider)
                return None
        except Exception as exc:  # capability lookup must not break a run
            logger.debug("provider capability lookup failed: %s", exc)

    if not sdk_available():
        # Without the SDK there are no AgentDefinitions to build, but a caller
        # that passed its own dict still means it.
        return user_agents or None

    roster: dict[str, Any] = phase_defaults(agent_type)

    overlays = overlays_for(detect_languages(project_dir))
    if overlays:
        if "test-runner" in roster:
            roster["test-runner"] = _specialise_test_runner(
                roster["test-runner"], overlays
            )
        for overlay in overlays:
            roster.update(overlay.extra_agents)

    protected = {"test-runner"} | set(user_agents or {})
    roster = _apply_cap(roster, protected)

    if user_agents:
        roster.update(user_agents)  # caller wins, always

    return roster or None


def merge_with_user_agents(
    user_agents: dict[str, Any] | None,
    agent_type: str = "coder",
    project_dir: Path | str | None = None,
) -> dict[str, Any] | None:
    """Backwards-compatible entry point for the pre-registry call sites."""
    return resolve(agent_type, project_dir=project_dir, user_agents=user_agents)
