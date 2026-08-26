"""Running the deterministic gates a resolved profile says should run.

The workflow declares phases; until now nothing executed any of them, so the
one class of phase that could be executed cheaply was declared and ignored.

A deterministic gate is a check that costs no tokens — impeccable's 59 detector
rules are the case this exists for. Three consequences follow from that, and
they are why this file is separate from the rest of the engine:

* **It is never pruned by effort.** There is no level at which skipping a
  local check saves anything, so `resolve_profile` keeps it at every one.
* **The engine can actually run it.** No provider, no session, no budget. The
  rest of the pipeline still goes through `run_autonomous_agent`; this is the
  part `handle_build_command` can drive directly today.
* **Its verdict is external.** That is what makes it usable as corroboration
  by the learning loop, where the agent's own assessment of its work is not.

The command is declared by the pack (`pack.json` → `gate`), not written here.
A second deterministic pack should be a manifest, not a branch in this file.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["GateVerdict", "GateRun", "run_deterministic_gates", "DEFAULT_TIMEOUT"]

DEFAULT_TIMEOUT = 180


@dataclass(frozen=True)
class GateVerdict:
    """What one gate said."""

    phase_id: str
    pack: str
    clean: bool | None
    """None when the gate could not run — unknown, which is not the same as
    clean and must never be recorded as corroboration."""
    findings: int = 0
    detail: str = ""

    def describe(self) -> str:
        if self.clean is None:
            return f"  ?  {self.phase_id:<16} could not run ({self.detail})"
        if self.clean:
            return f"  ✓  {self.phase_id:<16} clean ({self.pack})"
        return f"  ✗  {self.phase_id:<16} {self.findings} finding(s) ({self.pack})"


@dataclass
class GateRun:
    verdicts: list[GateVerdict] = field(default_factory=list)

    @property
    def ran(self) -> bool:
        return any(v.clean is not None for v in self.verdicts)

    @property
    def all_clean(self) -> bool | None:
        """True only when every gate ran and every one was clean.

        None when there was nothing to run, or when any gate could not be
        evaluated. A gate that did not execute contributes no evidence in
        either direction: reporting False would claim a failure nobody
        observed, and reporting True would manufacture the corroboration the
        learning loop is not allowed to invent.
        """
        if not self.verdicts:
            return None
        if any(v.clean is None for v in self.verdicts):
            return None
        return all(v.clean for v in self.verdicts)

    def describe(self) -> str:
        if not self.verdicts:
            return ""
        return "\n".join(
            ["Deterministic gates:", *(v.describe() for v in self.verdicts)]
        )


def _count_findings(stdout: str) -> int:
    """Findings from a gate's JSON output, best-effort.

    The count is for the report only — `clean` comes from the exit status,
    which is the contract the pack declares. A tool that changes its JSON shape
    should degrade the message, never the verdict.
    """
    try:
        payload = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        return 0
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for key in ("findings", "violations", "issues", "errors"):
            value = payload.get(key)
            if isinstance(value, list):
                return len(value)
            if isinstance(value, int):
                return value
    return 0


def run_deterministic_gates(
    profile,
    project_dir: Path,
    packs: dict,
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> GateRun:
    """Run the gate of every deterministic phase this profile will run.

    ``packs`` maps pack name to a `Pack`. A phase whose pack declares no gate
    is skipped silently: most deterministic packs are guidance, and only some
    of them ship a checker.

    Never raises. A gate is a signal, and a build that produced working code
    must not fail because a linter could not start.
    """
    from .engine import DETERMINISTIC_PACKS

    run = GateRun()
    for resolved in profile.run:
        phase = resolved.phase
        if phase.pack not in DETERMINISTIC_PACKS:
            continue
        pack = packs.get(phase.pack)
        gate = getattr(pack, "gate", None) or {}
        command = gate.get("command")
        if not command:
            logger.debug("phase %s: pack declares no gate command", phase.id)
            continue

        run.verdicts.append(
            _execute(
                phase.id, phase.pack, [str(c) for c in command], project_dir, timeout
            )
        )
    return run


def _execute(
    phase_id: str, pack: str, command: list[str], project_dir: Path, timeout: int
) -> GateVerdict:
    try:
        completed = subprocess.run(
            command,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return GateVerdict(
            phase_id,
            pack,
            None,
            detail=f"{command[0]} is not installed — run `pnpm run skills:bootstrap`",
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return GateVerdict(phase_id, pack, None, detail=str(exc))

    clean = completed.returncode == 0
    return GateVerdict(
        phase_id=phase_id,
        pack=pack,
        clean=clean,
        findings=0 if clean else _count_findings(completed.stdout),
        detail=(completed.stderr or "").strip()[:200],
    )
