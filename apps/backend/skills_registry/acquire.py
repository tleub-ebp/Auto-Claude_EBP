"""Adding, updating and dropping packs — the editing side of the registry.

`skills-cli build` reads `skills/` and writes the harness outputs. This module
is the other direction: it changes what is *in* `skills/`, which is the only
other way the emitted set can move.

Why the fetch is a git clone, not `npx skills add`
--------------------------------------------------
The plan chose `vercel-labs/skills` as the acquisition backend. Running it
showed why that cannot work here, and it is not a missing flag:

* it writes into **every harness directory it knows** — `.claude/`, `.agents/`,
  `.windsurf/`, `.kilocode/` and dozens more — which is exactly what
  `skills-cli build` owns. Two writers of the same directories means whichever
  ran last wins, and `skills:check` reports drift nobody introduced;
* it writes **its own `skills-lock.json` at the repo root**. That is our file,
  and the provenance record the whole registry is built on.

Its update path was already out: project-level skills are not in its lock, so
`npx skills check`/`update` skip them silently, and targeting on two axes —
toolchain version *and* pack semver — is outside its model entirely.

So `scripts/vendor_pack.py` clones, which is what both tools do underneath,
and `skills-lock.json` remains the authority. `npx skills add <repo> --list` is
still the right tool for *discovery*: it enumerates what a repository offers
without installing anything.

Everything here is a plan-then-apply pair, so the CLI can print what a command
would do before it does it, and so it can be tested without a network.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .packs import Pack, PackVariant, load_pack
from .upstream import LOCKFILE_NAME, SourceSpec, forget_pack, parse_source

logger = logging.getLogger(__name__)

__all__ = [
    "AddPlan",
    "RemovePlan",
    "AcquireError",
    "plan_add",
    "apply_add",
    "plan_remove",
    "apply_remove",
    "bootstrap_satisfied",
    "fork_variant",
    "vendored_skill_count",
    "GITIGNORE_MARKER",
]

# Every generated ignore block carries this so `remove` can find its own work
# rather than pattern-matching its way through a hand-edited .gitignore.
GITIGNORE_MARKER = "# skills-cli: vendored on demand"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# `skills` would produce `skills/skills/`, and `_proposed` is where the
# learning loop parks candidates the resolver deliberately ignores.
_RESERVED_NAMES = frozenset({"skills", "agents", "_proposed"})


class AcquireError(Exception):
    """The request cannot be carried out. Always fatal — a half-added pack is
    worse than none, because the build would emit from it."""


@dataclass
class AddPlan:
    """Everything `add` is about to write, before it writes any of it."""

    pack: str
    source: SourceSpec
    pack_dir: Path
    manifest: dict
    pin: str
    gitignore_block: list[str] = field(default_factory=list)
    already_present: bool = False

    def describe(self) -> str:
        lines = [
            f"pack     {self.pack}"
            + (
                "  (already declared — manifest left as authored)"
                if self.already_present
                else ""
            ),
            f"source   {self.source.raw}"
            + (f" (ref {self.source.ref})" if self.source.ref != "HEAD" else ""),
            f"manifest {self.pack_dir.name}/pack.json",
            f"fetch    {' '.join(str(c) for c in self.manifest['bootstrap']['command'])}",
        ]
        if self.gitignore_block:
            lines.append(
                "gitignore adds an ignore block: only pack.json is committed, "
                "the content is fetched"
            )
        if self.pin:
            lines.append(
                f"pin      .workpilot/skills.toml → {self.pack} = {self.pin!r}"
            )
        return "\n".join("  " + line for line in lines)


@dataclass
class RemovePlan:
    pack: str
    pack_dir: Path
    source: str
    authored_files: int
    """Files that exist nowhere else. Non-zero means the deletion loses work."""
    vendored: bool

    @property
    def recoverable(self) -> bool:
        """Whether `skills-cli add` could put this back byte for byte."""
        return self.vendored and self.authored_files == 0


def _vendor_command(source: SourceSpec, pack: str) -> list[str]:
    """The command that vendors a pack, recorded in its manifest.

    Stored rather than hardcoded in the CLI so a fresh clone reproduces the
    exact fetch with `pnpm run skills:bootstrap`, and so a pack that needs a
    different installer (BMAD does) is not a special case in the code.
    """
    command = [
        "python3",
        "scripts/vendor_pack.py",
        source.slug or source.raw,
        "--into",
        f"skills/{pack}",
    ]
    if source.ref and source.ref != "HEAD":
        command += ["--ref", source.ref]
    return command


def plan_add(
    repo_root: Path,
    raw_source: str,
    *,
    name: str | None = None,
    description: str = "",
    pin: str = "latest",
    targets: dict[str, str] | None = None,
) -> AddPlan:
    source = parse_source(raw_source)
    pack = (name or source.default_pack_name).strip()
    if not _NAME_RE.match(pack) or pack in _RESERVED_NAMES:
        raise AcquireError(
            f"{pack!r} is not a usable pack name: lowercase letters, digits and "
            f"hyphens only, starting with a letter or digit, and not one of "
            f"{', '.join(sorted(_RESERVED_NAMES))}. Pass --name."
        )

    pack_dir = repo_root / "skills" / pack
    manifest_path = pack_dir / "pack.json"
    already = manifest_path.is_file()
    if already:
        existing = load_pack(pack_dir)
        if existing.source not in ("local", source.slug or source.raw):
            raise AcquireError(
                f"skills/{pack} already exists and points at {existing.source!r}, "
                f"not {source.slug or source.raw!r}. Pass --name to vendor this "
                f"one alongside it, or remove the other first."
            )

    manifest = {
        "name": pack,
        "version": "0.0.0",
        "description": description
        or f"Vendored from {source.slug or source.raw} by skills-cli add.",
        "targets": dict(targets or {}),
        "source": source.slug or source.raw,
        "maintainer": "upstream (vendored on demand)",
        "bootstrap": {
            "command": _vendor_command(source, pack),
            "note": (
                "Fetched on demand rather than committed: third-party content "
                "with its own release cadence, tracked by tree SHA in "
                f"{LOCKFILE_NAME}. Run `pnpm run skills:bootstrap` after cloning."
            ),
        },
    }

    # An existing manifest is authored, not generated. BMAD's names its own
    # installer and its own `produces`; regenerating it would replace a working
    # bootstrap with a generic one. Re-running `add` therefore repairs the
    # ignore block and the pin and leaves the manifest exactly as it is —
    # re-fetching is what `update` is for.
    if already:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Never for a pack that is already declared: `skills/bmad/` is committed on
    # purpose (76 wrappers live there), and an ignore block would untrack them.
    ignored = already or f"skills/{pack}/*" in _gitignore_text(repo_root)
    return AddPlan(
        pack=pack,
        source=source,
        pack_dir=pack_dir,
        manifest=manifest,
        pin=pin,
        gitignore_block=[] if ignored else _gitignore_block(pack),
        already_present=already,
    )


def apply_add(
    repo_root: Path, plan: AddPlan, *, project_dir: Path | None = None
) -> Path:
    """Write the manifest, the ignore block and the pin. Fetches nothing.

    The fetch is `bootstrap`'s job, and keeping them apart means `add` is safe
    to run offline and the fetch is retried by the same command a fresh clone
    uses. One code path for vendoring, not two.
    """
    plan.pack_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = plan.pack_dir / "pack.json"
    manifest_path.write_text(
        json.dumps(plan.manifest, indent="\t", ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if plan.gitignore_block:
        add_gitignore_block(repo_root, plan.pack)
    if plan.pin:
        pin_pack(project_dir or repo_root, plan.pack, plan.pin)
    return manifest_path


def plan_remove(repo_root: Path, pack_name: str) -> RemovePlan:
    pack_dir = repo_root / "skills" / pack_name
    if not (pack_dir / "pack.json").is_file():
        raise AcquireError(f"no pack named {pack_name!r} under {repo_root / 'skills'}")
    pack = load_pack(pack_dir)
    vendored = pack.source != "local"

    # For a vendored pack, everything except pack.json came from upstream and
    # comes back with one command. Anything else is authored here and does not.
    authored = 0
    if vendored:
        for path in pack_dir.rglob("*"):
            if path.is_file() and path.name != "pack.json" and not _is_fetched(path):
                authored += 1
    else:
        authored = sum(1 for p in pack_dir.rglob("*") if p.is_file())

    return RemovePlan(
        pack=pack_name,
        pack_dir=pack_dir,
        source=pack.source,
        authored_files=authored,
        vendored=vendored,
    )


def _is_fetched(path: Path) -> bool:
    """Whether a file under a vendored pack came from the fetch.

    Conservative on purpose: unrecognised files count as authored, so the worst
    case is `remove` asking for a confirmation it did not strictly need.
    """
    return path.name in ("SKILL.md", ".vendored") or "SKILL.md" in {
        p.name for p in path.parent.iterdir() if p.is_file()
    }


def apply_remove(
    repo_root: Path, plan: RemovePlan, *, project_dir: Path | None = None
) -> None:
    shutil.rmtree(plan.pack_dir)
    remove_gitignore_block(repo_root, plan.pack)
    unpin_pack(project_dir or repo_root, plan.pack)
    forget_pack(repo_root / LOCKFILE_NAME, plan.pack)


def vendored_skill_count(pack_dir: Path) -> int:
    """How many SKILL.md files a pack directory actually holds."""
    if not pack_dir.is_dir():
        return 0
    return sum(1 for _ in pack_dir.glob("*/SKILL.md")) + sum(
        1 for _ in (pack_dir / "agents").glob("*.md") if (pack_dir / "agents").is_dir()
    )


def bootstrap_satisfied(project_dir: Path, pack: Pack) -> bool:
    """Whether this pack's runtime is already on disk.

    Two shapes. A pack whose installer creates a known tree (BMAD writes
    `_bmad/`) declares `produces` and is checked against it. A pack that is
    simply fetched into its own directory declares nothing, and the honest
    check is whether any skill turned up — asserting a marker file the fetcher
    never writes would report failure on every successful fetch.
    """
    produces = pack.bootstrap.get("produces")
    if produces:
        return (project_dir / produces).exists()
    return vendored_skill_count(pack.path) > 0


# ── .gitignore ────────────────────────────────────────────────────────────────
#
# A vendored pack commits its pack.json and nothing else: the content is
# third-party, moves on its own schedule, and is pinned by tree SHA. The ignore
# block is what keeps that true, so `add` writes it and `remove` takes it away.


def _gitignore_block(pack: str) -> list[str]:
    return [
        f"{GITIGNORE_MARKER} ({pack})",
        f"skills/{pack}/*",
        f"!skills/{pack}/pack.json",
    ]


def _gitignore_text(repo_root: Path) -> str:
    path = repo_root / ".gitignore"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def add_gitignore_block(repo_root: Path, pack: str) -> bool:
    path = repo_root / ".gitignore"
    existing = _gitignore_text(repo_root)
    if f"skills/{pack}/*" in existing:
        return False
    block = "\n".join(_gitignore_block(pack))
    sep = "" if existing.endswith("\n") or not existing else "\n"
    path.write_text(f"{existing}{sep}{block}\n", encoding="utf-8")
    return True


def remove_gitignore_block(repo_root: Path, pack: str) -> bool:
    path = repo_root / ".gitignore"
    if not path.is_file():
        return False
    kept: list[str] = []
    dropped = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped in (
            f"{GITIGNORE_MARKER} ({pack})",
            f"skills/{pack}/*",
            f"!skills/{pack}/pack.json",
        ):
            dropped = True
            continue
        kept.append(line)
    if dropped:
        path.write_text("\n".join(kept).rstrip("\n") + "\n", encoding="utf-8")
    return dropped


# ── .workpilot/skills.toml ────────────────────────────────────────────────────
#
# Edited as text, not round-tripped through a TOML writer. The file is
# hand-maintained and heavily commented — the comments explain the pins, which
# is most of the value — and every TOML emitter available here would throw them
# away. Touching only the [packs] table keeps the rest byte-identical.


def _config_path(project_dir: Path) -> Path:
    return project_dir / ".workpilot" / "skills.toml"


def pin_pack(project_dir: Path, pack: str, spec: str) -> bool:
    path = _config_path(project_dir)
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'[packs]\n{pack} = "{spec}"\n', encoding="utf-8")
        return True

    lines = path.read_text(encoding="utf-8").splitlines()
    entry = f'{pack} = "{spec}"'
    key = re.compile(rf"^\s*{re.escape(pack)}\s*=")

    in_packs = False
    last_packs_line = -1
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            in_packs = stripped == "[packs]"
            if in_packs:
                last_packs_line = index
            continue
        if in_packs:
            if key.match(line):
                if line.strip() == entry:
                    return False
                lines[index] = entry
                path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                return True
            if stripped:
                last_packs_line = index

    if last_packs_line < 0:
        lines.extend(["", "[packs]", entry])
    else:
        lines.insert(last_packs_line + 1, entry)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def unpin_pack(project_dir: Path, pack: str) -> bool:
    path = _config_path(project_dir)
    if not path.is_file():
        return False
    key = re.compile(rf"^\s*{re.escape(pack)}\s*=")
    lines = path.read_text(encoding="utf-8").splitlines()

    in_packs = False
    kept: list[str] = []
    dropped = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_packs = stripped == "[packs]"
        elif in_packs and key.match(line):
            dropped = True
            continue
        kept.append(line)
    if dropped:
        path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    return dropped


# ── forking a pack on a breaking upstream release ─────────────────────────────


def fork_variant(
    repo_root: Path,
    pack_name: str,
    *,
    new_version: str,
    note: str = "",
) -> PackVariant:
    """Preserve the current cut as a variant before taking a breaking release.

    This is the non-regression promise, as a function. The pinned cut keeps its
    version, its targets and its directory; the root pack moves on. A project
    that resolved to the old one goes on resolving to it, because the resolver
    picks a variant by the toolchain the project is actually on rather than by
    whatever landed most recently.

    Only the manifest is written. The skills themselves are not copied: a
    vendored pack's content is re-fetched from a pinned upstream ref, and a
    locally authored one is moved by whoever is doing the fork, who is the only
    party that knows which files belong to which cut.
    """
    pack_dir = repo_root / "skills" / pack_name
    manifest_path = pack_dir / "pack.json"
    if not manifest_path.is_file():
        raise AcquireError(f"no pack named {pack_name!r} to fork")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    current_version = str(manifest.get("version", "0.0.0"))
    if current_version == new_version:
        raise AcquireError(
            f"{pack_name}: refusing to fork {current_version} into itself — "
            f"the new cut needs a version of its own"
        )

    directory = f"v{current_version.split('.')[0]}"
    existing = manifest.get("variants") or []
    if any(v.get("dir") == directory for v in existing):
        raise AcquireError(
            f"{pack_name}: a variant already occupies {directory!r}. Two "
            f"breaking releases inside one major need the second named by hand."
        )

    variant = {
        "version": current_version,
        "dir": directory,
        "targets": dict(manifest.get("targets") or {}),
    }
    if note:
        variant["note"] = note

    # Newest first: the resolver takes the first variant whose targets match,
    # so ordering is what makes "the newest applicable cut" true.
    manifest["variants"] = [variant, *existing]
    manifest["version"] = new_version
    manifest_path.write_text(
        json.dumps(manifest, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return PackVariant(
        version=variant["version"],
        dir=directory,
        targets=variant["targets"],
        note=note,
    )
