"""Reading capabilities/harnesses.yaml, and spotting which harnesses are in use.

The matrix is the single source of truth for where each tool looks. That makes
detection a consequence of it rather than a second body of knowledge: a harness
is present when the paths it is declared to read are on disk. `src/hybrid/
ide_detector.py` used to answer a similar question from 421 lines of regexes
over process names and environment variables, maintained apart from the matrix
and already drifted from it — this is the same answer derived from the file
that has to be right anyway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

__all__ = [
    "Harness",
    "load_harnesses",
    "detect_harnesses",
    "HARNESSES_RELPATH",
]

HARNESSES_RELPATH = Path("capabilities") / "harnesses.yaml"


@dataclass(frozen=True)
class Harness:
    name: str
    skills_path: str | None
    agents_path: str | None
    commands_path: str | None
    format: str
    instruction_file: str | None
    subagents: str
    hooks: str | None
    mcp: str | None
    default: bool
    note: str = ""
    tools: dict[str, str] = field(default_factory=dict)
    """Canonical tool name -> this harness's name for it. Partial by design."""

    def translate_tools(self, tools: list[str]) -> tuple[list[str], list[str]]:
        """Rename tools for this harness.

        Returns ``(translated, untranslated)``. An unmapped name passes through
        unchanged and is reported rather than dropped: a definition missing a
        tool is a subagent that silently cannot do its job, whereas one naming
        a tool the harness does not know is visibly wrong the first time it
        runs. Both are bad; only the second is findable.
        """
        if not self.tools:
            return list(tools), []
        renamed: list[str] = []
        unknown: list[str] = []
        for tool in tools:
            if tool in self.tools:
                renamed.append(self.tools[tool])
            else:
                renamed.append(tool)
                unknown.append(tool)
        return renamed, unknown


def load_harnesses(repo_root: Path) -> dict[str, Harness]:
    path = repo_root / HARNESSES_RELPATH
    if not path.is_file():
        raise FileNotFoundError(f"missing harness matrix: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, Harness] = {}
    for name, cfg in raw.items():
        cfg = cfg or {}
        out[name] = Harness(
            name=name,
            skills_path=cfg.get("skills_path"),
            agents_path=cfg.get("agents_path"),
            commands_path=cfg.get("commands_path"),
            format=cfg.get("format", "skill-dir"),
            instruction_file=cfg.get("instruction_file"),
            subagents=cfg.get("subagents", "none"),
            hooks=cfg.get("hooks"),
            mcp=cfg.get("mcp"),
            default=bool(cfg.get("default", False)),
            note=str(cfg.get("note", "") or ""),
            tools={str(k): str(v) for k, v in (cfg.get("tools") or {}).items()},
        )
    return out


def detect_harnesses(project_dir: Path, matrix: dict[str, Harness]) -> list[str]:
    """Which harnesses this project shows signs of, by name.

    Evidence is a harness-specific directory or config file that exists: its
    hooks config, its MCP config, its commands directory, or a skills path it
    does not share with anyone else. Shared paths prove nothing — `.agents/
    skills/` is read by six of these tools, so its presence is not evidence for
    any one of them, and treating it as such would report every harness on
    every repo.

    Returns names in matrix order. An empty list means no evidence, which is
    the honest answer and is why callers fall back to the declared defaults
    rather than to a guess.
    """
    shared = _shared_paths(matrix)
    found: list[str] = []
    for name, harness in matrix.items():
        candidates = [harness.hooks, harness.mcp, harness.commands_path]
        if harness.skills_path and harness.skills_path not in shared:
            candidates.append(harness.skills_path)
        if harness.agents_path and harness.agents_path not in shared:
            candidates.append(harness.agents_path)
        if any(rel and (project_dir / rel).exists() for rel in candidates):
            found.append(name)
    return found


def _shared_paths(matrix: dict[str, Harness]) -> set[str]:
    """Paths more than one harness reads, which therefore identify none."""
    seen: dict[str, int] = {}
    for harness in matrix.values():
        for rel in (harness.skills_path, harness.agents_path):
            if rel:
                seen[rel] = seen.get(rel, 0) + 1
    return {rel for rel, count in seen.items() if count > 1}
