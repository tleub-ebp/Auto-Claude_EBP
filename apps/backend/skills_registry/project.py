"""What a consuming project is on, and which packs it wants.

Two sources, in order:

1. ``.workpilot/skills.toml`` — explicit, and always wins::

       [targets]
       dotnet = "8.0"

       [packs]
       dotnet = "^1"
       bmad = "6.2.1"

2. Detection from the files on disk, for anything the file leaves unsaid.

Detection is deliberately narrow. It reads version markers it can be sure
about (a ``TargetFramework``, an ``engines.node``, a ``go.mod`` directive) and
stays quiet otherwise. A wrong guess here silently ships a skill written for
the wrong toolchain, which is the exact failure this module exists to prevent —
so when the marker is ambiguous, the answer is "unknown", not a best effort.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

__all__ = ["ProjectConfig", "load_project_config", "detect_targets"]

CONFIG_RELPATH = Path(".workpilot") / "skills.toml"

# net48 -> 4.8, net472 -> 4.7.2, net10.0 -> 10.0, netcoreapp3.1 -> 3.1
_TFM_RE = re.compile(r"^net(?:coreapp|standard)?(\d+(?:\.\d+)*)$")


@dataclass
class ProjectConfig:
    """Resolved wishes of one consuming project."""

    project_dir: Path
    targets: dict[str, str] = field(default_factory=dict)
    packs: dict[str, str] = field(default_factory=dict)
    harnesses: list[str] = field(default_factory=list)
    detected: dict[str, str] = field(default_factory=dict)
    """What detection found, kept separate so `why` can show which of the two
    sources a target came from."""

    def target_source(self, tool: str) -> str:
        if tool in self.detected and self.targets.get(tool) == self.detected[tool]:
            return "detected"
        return "skills.toml"


def _normalise_tfm(moniker: str) -> str | None:
    """``net48`` -> ``4.8``. Returns None for a moniker we cannot read."""
    m = _TFM_RE.match(moniker.strip())
    if not m:
        return None
    digits = m.group(1)
    if "." in digits:
        return digits
    # net48 / net472 are packed decimals: 4.8 and 4.7.2.
    return ".".join(digits) if len(digits) <= 3 else None


def _detect_dotnet(project_dir: Path) -> str | None:
    # global.json pins the SDK and is the most authoritative marker.
    gj = project_dir / "global.json"
    if gj.is_file():
        try:
            sdk = json.loads(gj.read_text(encoding="utf-8")).get("sdk", {})
            if version := sdk.get("version"):
                return ".".join(str(version).split(".")[:2])
        except (json.JSONDecodeError, OSError, AttributeError):
            pass

    # Otherwise the highest TargetFramework across the project files: a
    # multi-targeting solution should get the guidance for its newest runtime.
    best: tuple[int, ...] | None = None
    best_text: str | None = None
    for proj in list(project_dir.rglob("*.csproj"))[:200]:
        try:
            text = proj.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for tag in re.findall(
            r"<TargetFrameworks?>([^<]+)</TargetFrameworks?>", text, re.IGNORECASE
        ):
            for moniker in tag.split(";"):
                norm = _normalise_tfm(moniker)
                if not norm:
                    continue
                key = tuple(int(p) for p in norm.split("."))
                if best is None or key > best:
                    best, best_text = key, norm
    return best_text


def _detect_node(project_dir: Path) -> str | None:
    nvmrc = project_dir / ".nvmrc"
    if nvmrc.is_file():
        try:
            raw = nvmrc.read_text(encoding="utf-8").strip().lstrip("v")
            if raw and raw[0].isdigit():
                return raw
        except OSError:
            pass
    pkg = project_dir / "package.json"
    if pkg.is_file():
        try:
            engines = json.loads(pkg.read_text(encoding="utf-8")).get("engines", {})
            node = engines.get("node")
            if node:
                # ">=20.0.0" -> "20.0.0": the floor is what the project runs on.
                m = re.search(r"(\d+(?:\.\d+)*)", str(node))
                if m:
                    return m.group(1)
        except (json.JSONDecodeError, OSError, AttributeError):
            pass
    return None


def _detect_python(project_dir: Path) -> str | None:
    pv = project_dir / ".python-version"
    if pv.is_file():
        try:
            raw = pv.read_text(encoding="utf-8").strip()
            if raw and raw[0].isdigit():
                return raw
        except OSError:
            pass
    pp = project_dir / "pyproject.toml"
    if pp.is_file():
        try:
            data = tomllib.loads(pp.read_text(encoding="utf-8"))
            rp = data.get("project", {}).get("requires-python")
            if rp:
                m = re.search(r"(\d+\.\d+)", str(rp))
                if m:
                    return m.group(1)
        except (tomllib.TOMLDecodeError, OSError, AttributeError):
            pass
    return None


def _detect_go(project_dir: Path) -> str | None:
    gm = project_dir / "go.mod"
    if gm.is_file():
        try:
            m = re.search(
                r"^go\s+(\d+\.\d+(?:\.\d+)?)", gm.read_text(encoding="utf-8"), re.M
            )
            if m:
                return m.group(1)
        except OSError:
            pass
    return None


def _detect_rust(project_dir: Path) -> str | None:
    ct = project_dir / "Cargo.toml"
    if ct.is_file():
        try:
            data = tomllib.loads(ct.read_text(encoding="utf-8"))
            rv = data.get("package", {}).get("rust-version")
            if rv:
                return str(rv)
        except (tomllib.TOMLDecodeError, OSError, AttributeError):
            pass
    return None


_DETECTORS = {
    "dotnet": _detect_dotnet,
    "node": _detect_node,
    "python": _detect_python,
    "go": _detect_go,
    "rust": _detect_rust,
}


def detect_targets(project_dir: Path) -> dict[str, str]:
    """Best-effort toolchain versions read from the project's own files."""
    found: dict[str, str] = {}
    for tool, detector in _DETECTORS.items():
        try:
            if version := detector(project_dir):
                found[tool] = version
        except Exception as exc:  # a detector must never break a build
            logger.debug("target detection for %s failed: %s", tool, exc)
    return found


def load_project_config(project_dir: Path) -> ProjectConfig:
    """Read ``.workpilot/skills.toml``, filling gaps from detection."""
    project_dir = project_dir.resolve()
    detected = detect_targets(project_dir)

    declared_targets: dict[str, str] = {}
    packs: dict[str, str] = {}
    harnesses: list[str] = []

    config_path = project_dir / CONFIG_RELPATH
    if config_path.is_file():
        try:
            data = tomllib.loads(config_path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise ValueError(f"{config_path}: invalid TOML — {exc}") from exc
        declared_targets = {
            str(k): str(v) for k, v in (data.get("targets") or {}).items()
        }
        packs = {str(k): str(v) for k, v in (data.get("packs") or {}).items()}
        harnesses = [str(h) for h in (data.get("harnesses") or [])]

    # Detection fills gaps; an explicit declaration always wins.
    targets = {**detected, **declared_targets}

    return ProjectConfig(
        project_dir=project_dir,
        targets=targets,
        packs=packs,
        harnesses=harnesses,
        detected=detected,
    )
