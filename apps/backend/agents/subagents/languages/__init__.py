"""Per-language knowledge that specialises the generic subagent roster.

The temptation is to add one subagent per language. That does not survive a
polyglot repo: this one is Python + TypeScript, so three phase defaults plus
three agents per language is nine, well past the five-to-seven roster where
merging the summaries starts costing more than the parallelism buys.

So overlays **specialise existing roles** instead. A `test-runner` that knows
`pytest -x` and `vitest run` is one agent that works; two `test-runner`s
competing for the same job is a worse version of the generic one.

A language module contributes:

``test_commands``
    Concrete commands, most specific first. These are folded into the
    `test-runner` prompt so it stops guessing at the framework.
``lint_commands``
    Same, for the formatting/lint gate.
``extra_agents``
    Roles that genuinely have no generic equivalent. Kept deliberately small.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

__all__ = ["LanguageOverlay", "OVERLAYS", "overlays_for"]


@dataclass(frozen=True)
class LanguageOverlay:
    language: str
    test_commands: list[str] = field(default_factory=list)
    lint_commands: list[str] = field(default_factory=list)
    extra_agents: dict[str, Any] = field(default_factory=dict)
    notes: str = ""


def _load() -> dict[str, LanguageOverlay]:
    from . import dotnet, go, java, python, rust, typescript

    modules = (python, typescript, dotnet, go, rust, java)
    return {m.OVERLAY.language: m.OVERLAY for m in modules}


OVERLAYS: dict[str, LanguageOverlay] = {}


def overlays_for(languages: list[str]) -> list[LanguageOverlay]:
    """Overlays for the detected languages, in a stable order.

    ``detect_project_stack`` reports compound names such as
    ``javascript/typescript`` and ``java/kotlin``; both halves map to the same
    overlay, so match on substrings rather than equality.
    """
    global OVERLAYS
    if not OVERLAYS:
        OVERLAYS = _load()

    # Tokenise rather than substring-match: "javascript" contains "java", and
    # "go" is a substring of half the words in English. Splitting on the
    # separators detect_project_stack actually uses keeps the match exact.
    tokens = {
        tok
        for entry in languages
        for tok in re.split(r"[\s/,;+()]+", entry.lower())
        if tok
    }
    aliases = {
        "python": {"python", "py"},
        "typescript": {"typescript", "javascript", "ts", "js", "node"},
        "dotnet": {"c#", "csharp", "dotnet", ".net", "fsharp"},
        "go": {"go", "golang"},
        "rust": {"rust"},
        "java": {"java", "kotlin"},
    }
    return [OVERLAYS[name] for name, keys in aliases.items() if tokens & keys]
