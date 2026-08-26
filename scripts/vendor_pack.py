#!/usr/bin/env python3
"""Vendor an upstream skill pack into `skills/<pack>/`.

    vendor_pack.py <owner/repo|url> --into skills/superpowers [--ref v2.1.0]

Why this exists rather than `npx skills add`
--------------------------------------------
The plan chose `vercel-labs/skills` as the acquisition backend, on the
reasonable assumption that it could vendor into our layout. It cannot, and the
reason is not a missing flag:

* **It writes into every harness directory it knows** — `.claude/`, `.agents/`,
  `.windsurf/`, `.kilocode/` and dozens more. That is the job `skills-cli build`
  already owns. Two writers of the same directories means whichever ran last
  wins, and `skills:check` would report drift nobody introduced.
* **It writes its own `skills-lock.json` at the project root.** That is our
  file. Running it in this repo overwrites the provenance record the whole
  registry is built on.

Both tools clone a git repository underneath. Doing that directly puts the
files exactly where the source layout wants them, honours the `@ref` the
manifest already records, and leaves our two artifacts alone. `npx skills` is
still the better *discovery* tool — `skills add <repo> --list` enumerates what
a repository offers without installing anything, which is how the skill names
in `workflow.yaml` were verified.

What lands on disk
------------------
The upstream tree, minus its `.git`, plus the `pack.json` that was already
there. Nothing else is touched: the pack's manifest is authored by us and a
re-vendor must not clobber it.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Directories that belong to the upstream project rather than to its skills.
# Copying them in would put a second CI config and a second node_modules under
# `skills/`, which the build would then try to emit.
_SKIP = {
    ".git",
    ".github",
    "node_modules",
    ".venv",
    "__pycache__",
    ".idea",
    # The upstream's own generated harness mirrors. Copying them in would put a
    # second `.agents/` and `.claude/` under `skills/`, which is the output our
    # build writes — confusing at best, and a second source of truth at worst.
    ".agents",
    ".claude",
    ".claude-plugin",
    ".cursor",
    ".gemini",
    ".codex",
    ".pi",
}


def _clone(source: str, ref: str, dest: Path) -> None:
    url = (
        source
        if "://" in source or source.startswith("git@")
        else f"https://github.com/{source}.git"
    )
    cmd = ["git", "clone", "--depth", "1", "--quiet"]
    if ref and ref != "HEAD":
        cmd += ["--branch", ref]
    cmd += [url, str(dest)]
    subprocess.run(cmd, check=True)


def _copy_tree(src: Path, dest: Path) -> None:
    """Copy the upstream tree into ``dest``, preserving an authored `pack.json`."""
    dest.mkdir(parents=True, exist_ok=True)
    manifest = dest / "pack.json"
    keep = manifest.read_text(encoding="utf-8") if manifest.is_file() else None

    for entry in list(dest.iterdir()):
        if entry.name == "pack.json":
            continue
        shutil.rmtree(entry) if entry.is_dir() else entry.unlink()

    for entry in src.iterdir():
        if entry.name in _SKIP:
            continue
        target = dest / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, ignore=shutil.ignore_patterns(*_SKIP))
        else:
            shutil.copy2(entry, target)

    if keep is not None:
        manifest.write_text(keep, encoding="utf-8")


# A repository that *is* a single skill keeps its SKILL.md at the root.
_ROOT_SKILL = "SKILL.md"


def _is_mirror(rel: Path) -> bool:
    """Whether a path lives inside a harness mirror rather than the source.

    Upstreams commit their own generated output — impeccable ships the same
    skill under thirty directories (`.agent/`, `.trae-cn/`, `plugin/`, …).
    Copying all of them in would multiply every skill by thirty and let the
    build emit whichever the glob reached first.
    """
    return any(part.startswith(".") for part in rel.parts)


def _collect_skills(src: Path) -> dict[str, Path]:
    """Every distinct skill in the clone: name -> the directory holding it.

    Layout-agnostic on purpose. The four upstreams tracked here use four
    different shapes — `<skill>/`, `skills/<skill>/`, `skills/<group>/<skill>/`
    and `plugin/skills/<skill>/` — and enumerating them would mean editing this
    file every time a fifth appears. Finding the SKILL.md files and taking
    their parent directory works for all of them.

    On a duplicate name the shallowest path wins, which is the canonical copy:
    mirrors are always nested deeper than the source they were generated from.
    """
    found: dict[str, Path] = {}
    for skill_file in sorted(src.rglob(_ROOT_SKILL)):
        rel = skill_file.relative_to(src)
        if rel == Path(_ROOT_SKILL):
            continue  # the single-skill-at-root case, handled separately
        if _is_mirror(rel):
            continue
        name = skill_file.parent.name
        previous = found.get(name)
        if previous is None or len(skill_file.parent.relative_to(src).parts) < len(
            previous.relative_to(src).parts
        ):
            found[name] = skill_file.parent
    return found


def _normalise_layout(dest: Path, pack: str) -> int:
    """Rewrite the clone into `<pack>/<skill>/SKILL.md`, and report the count.

    Normalising here rather than teaching the resolver about four shapes keeps
    the source layout single: everything under `skills/` looks the same however
    it arrived.
    """
    manifest = dest / "pack.json"
    keep = manifest.read_text(encoding="utf-8") if manifest.is_file() else None

    root_skill = dest / _ROOT_SKILL
    if root_skill.is_file() and not _collect_skills(dest):
        # The repository is one skill. Name its directory after the pack, which
        # is what `npx skills` calls it too.
        staged = dest.parent / f".{pack}.staging"
        shutil.rmtree(staged, ignore_errors=True)
        staged.mkdir(parents=True)
        for entry in list(dest.iterdir()):
            if entry.name == "pack.json":
                continue
            entry.rename(staged / entry.name)
        (dest / pack).mkdir()
        for entry in list(staged.iterdir()):
            entry.rename(dest / pack / entry.name)
        shutil.rmtree(staged, ignore_errors=True)
        return 1

    skills = _collect_skills(dest)
    if not skills:
        return 0

    staged = dest.parent / f".{pack}.staging"
    shutil.rmtree(staged, ignore_errors=True)
    staged.mkdir(parents=True)
    for name, directory in skills.items():
        shutil.copytree(directory, staged / name)

    for entry in list(dest.iterdir()):
        if entry.name == "pack.json":
            continue
        shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
    for entry in list(staged.iterdir()):
        entry.rename(dest / entry.name)
    shutil.rmtree(staged, ignore_errors=True)

    if keep is not None:
        manifest.write_text(keep, encoding="utf-8")
    return len(skills)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="owner/repo, or a git URL")
    parser.add_argument(
        "--into", required=True, help="pack directory, e.g. skills/superpowers"
    )
    parser.add_argument("--ref", default="HEAD", help="tag, branch or commit to pin")
    args = parser.parse_args(argv)

    dest = (REPO_ROOT / args.into).resolve()
    if not str(dest).startswith(str(REPO_ROOT / "skills")):
        print(
            f"vendor_pack: --into must be under skills/, got {args.into}",
            file=sys.stderr,
        )
        return 2

    pack = dest.name
    with tempfile.TemporaryDirectory(prefix="workpilot-vendor-") as tmp:
        clone_dir = Path(tmp) / "src"
        try:
            _clone(args.source, args.ref, clone_dir)
        except subprocess.CalledProcessError as exc:
            print(f"vendor_pack: clone failed — {exc}", file=sys.stderr)
            return 1
        head = subprocess.run(
            ["git", "-C", str(clone_dir), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        _copy_tree(clone_dir, dest)
        _normalise_layout(dest, pack)

    count = len(list(dest.glob("*/SKILL.md")))
    if not count:
        print(
            f"vendor_pack: {args.source} produced no SKILL.md under {args.into}",
            file=sys.stderr,
        )
        return 1

    print(
        f"vendored {args.source}@{head[:12] or args.ref} → {args.into} ({count} skill(s))"
    )
    # Leave a receipt so a human reading the tree knows it is generated.
    (dest / ".vendored.json").write_text(
        json.dumps(
            {"source": args.source, "ref": args.ref, "commit": head, "skills": count},
            indent="\t",
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
