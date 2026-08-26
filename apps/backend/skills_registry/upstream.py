"""Provenance for packs that come from someone else's repository.

Two commands need the same three facts — `skills-cli add`, `skills-cli update`
and the weekly `skills-sync` job all have to know where a pack came from, what
its upstream looks like right now, and what it looked like when we last agreed
to it. This module owns those three, so there is one answer rather than one per
caller.

Content addressing, not version strings
---------------------------------------
The identity of a vendored pack is its **tree SHA**, not a tag or a branch
name. A tag can be moved, a branch always can; a tree SHA cannot. Comparing
SHAs is also what makes the weekly job quiet: identical SHA means nothing
happened, so there is no diff to classify and no pull request to open. A week
where upstream did not move should cost nothing and produce no noise, and a
version string cannot promise that.

`skills-lock.json` is the record. It is the same file the build writes, under
the pack entry the build already maintains, because a second provenance file
would be a second thing to keep in sync.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "LOCKFILE_NAME",
    "SourceSpec",
    "parse_source",
    "fetch_tree_sha",
    "recorded_shas",
    "record_shas",
    "forget_pack",
]

LOCKFILE_NAME = "skills-lock.json"

_GH_SLUG = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_URL_TAIL = re.compile(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$")


class SourceSpec:
    """An upstream reference and the pack name it defaults to.

    Accepts what a person would actually type: ``obra/superpowers``, a full
    GitHub URL, or an ``owner/repo@ref``. Anything else is kept verbatim as an
    opaque source — `npx skills` resolves more forms than we want to reimplement
    (the skills.sh registry among them), so guessing wrong is worse than passing
    the string through and letting it fail loudly downstream.
    """

    def __init__(self, raw: str, slug: str | None, ref: str) -> None:
        self.raw = raw
        self.slug = slug
        """``owner/repo`` when this resolves to a GitHub repository, else None."""
        self.ref = ref

    @property
    def is_github(self) -> bool:
        return self.slug is not None

    @property
    def default_pack_name(self) -> str:
        base = self.slug.split("/")[-1] if self.slug else self.raw
        base = re.sub(r"[^a-z0-9-]+", "-", base.lower()).strip("-")
        return base or "pack"

    def __str__(self) -> str:  # pragma: no cover - display only
        return self.raw


def parse_source(raw: str) -> SourceSpec:
    raw = raw.strip()

    # `@` means a ref in `owner/repo@ref`, but it is also part of an SSH URL
    # (`git@github.com:owner/repo`) and of a scoped npm name. Splitting on it
    # blindly turns `git@github.com:owner/repo` into the ref
    # `github.com:owner/repo`, so those two forms are recognised first.
    if raw.startswith("@") or raw.startswith("git@"):
        spec, ref = raw, "HEAD"
    else:
        spec, _, tail = raw.partition("@")
        spec, ref = spec.strip(), tail.strip() or "HEAD"

    if _GH_SLUG.match(spec):
        return SourceSpec(raw, spec, ref)

    if spec.startswith(("http://", "https://", "git@", "ssh://")) and (
        "github.com" in spec
    ):
        if match := _URL_TAIL.search(spec):
            return SourceSpec(raw, f"{match.group(1)}/{match.group(2)}", ref)

    return SourceSpec(raw, None, ref)


def fetch_tree_sha(source: str, ref: str = "HEAD") -> str | None:
    """The tree SHA a GitHub source is at right now, via the `gh` CLI.

    Returns None when it cannot be determined — no network, no `gh`, a private
    repo. A missing SHA has to stay missing: inventing one would record a
    provenance nobody can verify, which is worse than recording none.
    """
    if not _GH_SLUG.match(source):
        return None
    try:
        out = subprocess.run(
            ["gh", "api", f"repos/{source}/commits/{ref}", "--jq", ".commit.tree.sha"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as exc:
        logger.debug("could not read tree sha for %s: %s", source, exc)
        return None
    return out.stdout.strip() or None


def _load_lock(lockfile: Path) -> dict:
    if not lockfile.is_file():
        return {}
    try:
        data = json.loads(lockfile.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("%s: not valid JSON, provenance left untouched", lockfile)
        return {}
    return data if isinstance(data, dict) else {}


def _write_lock(lockfile: Path, data: dict) -> None:
    lockfile.write_text(
        json.dumps(data, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )


def recorded_shas(lockfile: Path) -> dict[str, str]:
    """Pack name → the upstream tree SHA we last agreed to."""
    return {
        name: entry.get("upstreamTreeSha", "")
        for name, entry in (_load_lock(lockfile).get("packs") or {}).items()
        if isinstance(entry, dict)
    }


def record_shas(lockfile: Path, observed: dict[str, str]) -> None:
    """Record observed SHAs, leaving every other lockfile field alone.

    Merges rather than rewrites: the build owns most of this file, and a
    provenance update that dropped the emitted list would make the next build
    orphan every output it had previously written.
    """
    if not observed:
        return
    data = _load_lock(lockfile)
    if not data:
        return
    packs = data.get("packs") or {}
    for name, sha in observed.items():
        if not sha:
            continue
        entry = packs.setdefault(name, {})
        if isinstance(entry, dict):
            entry["upstreamTreeSha"] = sha
    data["packs"] = packs
    _write_lock(lockfile, data)


def forget_pack(lockfile: Path, pack: str) -> None:
    """Drop one pack's entry after it has been removed from ``skills/``.

    Only the pack entry: the emitted files are the build's business, and the
    next build removes the ones that no longer resolve.
    """
    data = _load_lock(lockfile)
    packs = data.get("packs") or {}
    if packs.pop(pack, None) is None:
        return
    data["packs"] = packs
    _write_lock(lockfile, data)
