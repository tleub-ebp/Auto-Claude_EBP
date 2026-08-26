#!/usr/bin/env python3
"""skills-cli — the one thing that writes materialised skills.

    pnpm run skills:build          # write every enabled harness output
    pnpm run skills:check          # fail if the outputs are stale (CI gate)
    pnpm run skills:list           # what this project resolves to, and why not
    pnpm run skills:update         # check vendored packs against upstream
    python scripts/skills_cli.py add obra/superpowers
    python scripts/skills_cli.py why <skill>

One authored skill in `skills/` becomes N files: `.agents/skills/` (the source
the backend serves to the Kanban palette, and the path Copilot/Codex/Cursor/
Amp/Gemini read natively), plus whichever harness mirrors are enabled.

Why Python and not Node, given the rest of `scripts/` is split: the build has
to *emit* YAML frontmatter, read TOML config and compare semver ranges. Node
has none of the three available here, so it would mean three new dependencies
on a root package.json that has five — or a hand-written YAML emitter, which is
precisely the class of code this registry exists to delete. PyYAML is declared
and `tomllib` is in the stdlib, so the Python side costs nothing. CI already
invokes `python3 scripts/update-readme.py` the same way.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.acquire import (  # noqa: E402
    AcquireError,
    apply_add,
    apply_remove,
    bootstrap_satisfied,
    plan_add,
    plan_remove,
)
from skills_registry.build import (  # noqa: E402
    apply_build,
    plan_build,
)
from skills_registry.harnesses import (  # noqa: E402
    detect_harnesses,
    load_harnesses,
)
from skills_registry.packs import PackError, load_packs  # noqa: E402
from skills_registry.project import load_project_config  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402
from skills_registry.upstream import (  # noqa: E402
    LOCKFILE_NAME,
    fetch_tree_sha,
    record_shas,
    recorded_shas,
)

from workflows import WorkflowError  # noqa: E402

SKILLS_ROOT = REPO_ROOT / "skills"


def _resolve_harnesses(
    explicit: str | None, config_harnesses: list[str], project_dir: Path
) -> list[str]:
    """Which harness outputs to write, in order of who asked.

    `--harness=auto` writes the mirrors this checkout shows evidence of, on top
    of the defaults. The defaults are always included: `.agents/skills/` is what
    the WorkPilot backend serves to the Kanban palette whatever the developer's
    editor happens to be, so detection can add mirrors and never remove them.
    """
    matrix = load_harnesses(REPO_ROOT)
    defaults = [name for name, h in matrix.items() if h.default]

    if explicit and explicit != "auto":
        return [h.strip() for h in explicit.split(",") if h.strip()]
    if explicit == "auto":
        detected = detect_harnesses(project_dir, matrix)
        return list(dict.fromkeys(defaults + detected))
    if config_harnesses:
        return config_harnesses
    return defaults


def _load(project_dir: Path):
    packs = load_packs(SKILLS_ROOT)
    config = load_project_config(project_dir)
    return packs, config


def cmd_build(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    harness_names = _resolve_harnesses(args.harness, config.harnesses, project_dir)
    resolution = resolve(packs, config)
    plan = plan_build(REPO_ROOT, resolution, harness_names)
    # Outputs land in the consuming project; packs are read from this repo.
    result = apply_build(
        project_dir,
        resolution,
        plan,
        harness_names,
        source_root=REPO_ROOT,
        check_only=args.check,
    )

    if args.check:
        if result.changed:
            print("skills:check — outputs are stale.", file=sys.stderr)
            for rel in result.written:
                print(f"  would write   {rel}", file=sys.stderr)
            for rel in result.removed:
                print(f"  would remove  {rel}", file=sys.stderr)
            print(
                "\nRun `pnpm run skills:build` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(
            f"skills:check — OK, {len(result.unchanged)} file(s) up to date "
            f"across harness(es): {', '.join(sorted(harness_names))}."
        )
        return 0

    print(
        f"skills:build — {len(resolution.selected)} skill(s)/agent(s) "
        f"→ {project_dir} "
        f"[harness: {', '.join(sorted(harness_names))}]"
    )
    for rel in result.written:
        print(f"  wrote    {rel}")
    for rel in result.removed:
        print(f"  removed  {rel}")
    if not result.changed:
        print("  (already up to date)")
    for warning in plan.warnings:
        print(f"  ⚠ {warning}")
    if resolution.rejected:
        print(
            f"\n  {len(resolution.rejected)} not emitted — `skills:list` explains why"
        )
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    resolution = resolve(packs, config)

    print(f"project: {project_dir}")
    if config.targets:
        parts = [
            f"{k}={v} ({config.target_source(k)})"
            for k, v in sorted(config.targets.items())
        ]
        print(f"targets: {', '.join(parts)}")
    else:
        print("targets: none detected and none declared in .workpilot/skills.toml")
    if config.packs:
        print(
            f"pins:    {', '.join(f'{k}={v}' for k, v in sorted(config.packs.items()))}"
        )

    print(f"\nselected ({len(resolution.selected)}):")
    for src in resolution.selected:
        print(f"  [{src.kind:5}] {src.name:34} {src.pack}")

    if resolution.rejected:
        print(f"\nnot emitted ({len(resolution.rejected)}):")
        for rej in sorted(resolution.rejected, key=lambda r: (r.gate, r.name)):
            print(f"  [{rej.gate:9}] {rej.name:34} {rej.reason}")
    return 0


def cmd_workflow(args: argparse.Namespace) -> int:
    """Show how a workflow resolves here, and which phases cannot run yet."""
    from workflows import load_workflow, resolve_profile, validate_impls

    project_dir = Path(args.project_dir).resolve()
    path = REPO_ROOT / "workflows" / args.workflow / "workflow.yaml"
    workflow = load_workflow(path)

    profile = resolve_profile(workflow, args.effort, provider=args.provider)
    print(profile.describe())

    packs, _ = _load(project_dir)
    available = {p.name: {s.name for s in p.skills()} for p in packs}
    missing = validate_impls(workflow, available)
    if missing:
        print(f"\n{len(missing)} phase(s) cannot run yet:")
        for m in missing:
            print(f"  {m.phase_id:<14} {m.impl:<45} {m.reason}")
    return 0


def cmd_bootstrap(args: argparse.Namespace) -> int:
    """Materialise the runtimes that gated skills are waiting on.

    Some packs are wrappers around a runtime that is too large to commit and is
    generated by its own installer — BMAD is the case this exists for. Until
    that runtime is on disk, `requires` keeps those skills out of the build, so
    the command palette shows nothing broken. This puts it there.
    """
    import subprocess

    project_dir = Path(args.project_dir).resolve()
    packs, _ = _load(project_dir)
    wanted = [p for p in packs if p.bootstrap.get("command")]
    if args.pack:
        wanted = [p for p in wanted if p.name == args.pack]
        if not wanted:
            print(
                f"skills-cli: no pack named {args.pack!r} declares a bootstrap",
                file=sys.stderr,
            )
            return 1
    elif not getattr(args, "all", False):
        # A pack marked optional is one the repo declares but does not want by
        # default — a heavier alternative to something already here. Naming it
        # explicitly is the opt-in; a bare `bootstrap` must not install it.
        skipped = [p.name for p in wanted if p.bootstrap.get("optional")]
        wanted = [p for p in wanted if not p.bootstrap.get("optional")]
        if skipped:
            print(
                f"skipping optional pack(s): {', '.join(sorted(skipped))} "
                f"(--pack <name> or --all to install)"
            )
    if not wanted:
        print("skills-cli: no pack needs bootstrapping.")
        return 0

    failed = False
    fetched: list[str] = []
    for pack in wanted:
        command = [str(c) for c in pack.bootstrap["command"]]
        produces = pack.bootstrap.get("produces") or "its skills"
        if bootstrap_satisfied(project_dir, pack) and not args.force:
            print(
                f"{pack.name}: {produces} already present — skipping (--force to redo)"
            )
            continue

        print(f"{pack.name}: running {' '.join(command)}")
        print(f"  in {project_dir}")
        if args.dry_run:
            print("  (dry run — nothing executed)")
            continue
        try:
            subprocess.run(command, cwd=project_dir, check=True)
        except (subprocess.CalledProcessError, FileNotFoundError, OSError) as exc:
            print(f"{pack.name}: bootstrap failed — {exc}", file=sys.stderr)
            failed = True
            continue
        if not bootstrap_satisfied(project_dir, pack):
            print(
                f"{pack.name}: installer finished but {produces} is still missing",
                file=sys.stderr,
            )
            failed = True
            continue
        fetched.append(pack.name)

    # Record what upstream looked like at the moment we vendored it. Without
    # this the first sync run reports every pack as moved, and a report that is
    # always positive is a report nobody reads.
    _record_provenance(fetched)

    if not failed and not args.dry_run:
        print("\nRun `pnpm run skills:build` to emit the skills this unlocked.")
    return 1 if failed else 0


def _record_provenance(pack_names: list[str]) -> None:
    """Stamp the current upstream tree SHA for packs we just fetched."""
    if not pack_names:
        return
    by_name = {p.name: p for p in load_packs(SKILLS_ROOT)}
    observed: dict[str, str] = {}
    for name in pack_names:
        pack = by_name.get(name)
        if not pack or pack.source == "local":
            continue
        if sha := fetch_tree_sha(pack.source):
            observed[name] = sha
    if observed:
        record_shas(REPO_ROOT / LOCKFILE_NAME, observed)
        print(f"  provenance recorded for {', '.join(sorted(observed))}")


def cmd_add(args: argparse.Namespace) -> int:
    """Vendor a pack from upstream and record where it came from.

    Two steps that stay separate on purpose: this writes the manifest, the
    ignore block and the pin, and `bootstrap` does the fetch. So `add` works
    offline, and the fetch a fresh clone performs is the same code path as the
    one here — there is no second way to vendor a pack that could drift.
    """
    project_dir = Path(args.project_dir).resolve()
    plan = plan_add(
        REPO_ROOT,
        args.source,
        name=args.name,
        description=args.description or "",
        pin=("" if args.no_pin else args.pin),
    )

    print("skills-cli add:")
    print(plan.describe())
    if args.dry_run:
        print("\n  (dry run — nothing written)")
        return 0

    apply_add(REPO_ROOT, plan, project_dir=project_dir)
    print(f"\nwrote skills/{plan.pack}/pack.json")

    if args.no_fetch:
        # Record where upstream is now even though nothing was fetched.
        # Without a baseline the next sync reports the pack as "moved" when it
        # has not, and a report that is always positive stops being read.
        _record_provenance([plan.pack])
        print(f"Run `pnpm run skills:bootstrap --pack {plan.pack}` to fetch it.")
        return 0

    fetch_args = argparse.Namespace(
        project_dir=str(project_dir),
        pack=plan.pack,
        force=False,
        dry_run=False,
        all=False,
    )
    return cmd_bootstrap(fetch_args)


def cmd_update(args: argparse.Namespace) -> int:
    """Check vendored packs against upstream, and re-fetch the ones that moved.

    Comparison is by tree SHA, so a week in which upstream did not move costs
    one API call per pack and prints "unchanged". `--check` stops after the
    report, which is what CI wants; without it the moved packs are re-fetched
    and their provenance re-stamped.

    A breaking upstream change is not resolved here. `.github/workflows/
    skills-sync.yml` classifies the diff and opens a pull request that adds a
    *variant*, leaving the pinned one resolving exactly as before. Overwriting
    a pack in place is how a project that pinned `dotnet = "^2"` silently ends
    up on v3.
    """
    project_dir = Path(args.project_dir).resolve()
    packs = [p for p in load_packs(SKILLS_ROOT) if p.source != "local"]
    if args.pack:
        packs = [p for p in packs if p.name in args.pack]
        unknown = set(args.pack) - {p.name for p in packs}
        if unknown:
            print(
                f"skills-cli: no vendored pack named {', '.join(sorted(unknown))}",
                file=sys.stderr,
            )
            return 1
    if not packs:
        print("skills-cli: no vendored packs to update.")
        return 0

    known = recorded_shas(REPO_ROOT / LOCKFILE_NAME)
    moved: list[str] = []
    unreachable = 0

    for pack in packs:
        current = fetch_tree_sha(pack.source)
        if current is None:
            print(f"  ?  {pack.name:<16} could not reach {pack.source}")
            unreachable += 1
            continue
        if current == known.get(pack.name, ""):
            print(f"  =  {pack.name:<16} unchanged ({current[:12]})")
            continue
        was = known.get(pack.name, "")[:12] or "not recorded"
        print(f"  ↑  {pack.name:<16} {was} → {current[:12]}  ({pack.source})")
        moved.append(pack.name)

    if not moved:
        print(
            "\nEverything is at the upstream we recorded."
            + (f" ({unreachable} unreachable)" if unreachable else "")
        )
        return 1 if (args.check and unreachable) else 0

    if args.check:
        print(f"\n{len(moved)} pack(s) moved upstream. Run `pnpm run skills:update`.")
        return 1

    print()
    fetch_args = argparse.Namespace(
        project_dir=str(project_dir), pack="", force=True, dry_run=False, all=False
    )
    failed = 0
    for name in moved:
        fetch_args.pack = name
        failed |= cmd_bootstrap(fetch_args)
    return failed


def cmd_remove(args: argparse.Namespace) -> int:
    """Drop a pack, its ignore block, its pin and its lockfile entry.

    Deletes a directory, so it says what it is about to lose first. A vendored
    pack is one `add` away from coming back; a locally authored one is not, and
    that difference decides whether `--yes` is required.
    """
    project_dir = Path(args.project_dir).resolve()
    plan = plan_remove(REPO_ROOT, args.pack)

    print(f"skills-cli remove: {plan.pack}  (source: {plan.source})")
    print(f"  deletes  {plan.pack_dir.relative_to(REPO_ROOT)}/")
    if plan.authored_files:
        print(
            f"  ⚠ {plan.authored_files} file(s) here are authored, not fetched — "
            f"deleting them loses work that no `add` brings back"
        )
    elif plan.vendored:
        print("  vendored content only — `skills-cli add` restores it")
    print(
        "  also removes its .gitignore block, its skills.toml pin "
        f"and its {LOCKFILE_NAME} entry"
    )

    if args.dry_run:
        print("\n  (dry run — nothing deleted)")
        return 0
    if not plan.recoverable and not args.yes:
        print(
            "\nRefusing to delete unrecoverable content without --yes.",
            file=sys.stderr,
        )
        return 1

    apply_remove(REPO_ROOT, plan, project_dir=project_dir)
    print(f"\nremoved skills/{plan.pack}")
    print("Run `pnpm run skills:build` to drop what it emitted.")
    return 0


def cmd_why(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    resolution = resolve(packs, config)

    name = args.skill
    if src := resolution.by_name().get(name):
        print(f"{name}: emitted (pack {src.pack}, targets {src.targets or 'any'})")
        return 0

    rejections = resolution.rejections_for(name)
    if not rejections:
        print(f"{name}: no such skill in any pack under {SKILLS_ROOT}", file=sys.stderr)
        return 1
    for rej in rejections:
        print(f"{name}: rejected at gate '{rej.gate}' — {rej.reason}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="skills-cli", description=__doc__)
    parser.add_argument(
        "--project-dir",
        default=str(REPO_ROOT),
        help="project whose targets and pins drive resolution (default: this repo)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser(
        "build", help="materialise skills into the harness outputs"
    )
    p_build.add_argument(
        "--check", action="store_true", help="report drift, write nothing"
    )
    p_build.add_argument(
        "--harness",
        help=(
            "comma-separated harness names, or 'auto' to add the ones this "
            "checkout shows evidence of (default: those marked default)"
        ),
    )
    p_build.set_defaults(func=cmd_build)

    p_list = sub.add_parser(
        "list", help="show what resolves, and why the rest does not"
    )
    p_list.set_defaults(func=cmd_list)

    p_boot = sub.add_parser(
        "bootstrap", help="install the runtimes that gated skills are waiting on"
    )
    p_boot.add_argument("--pack", help="bootstrap only this pack")
    p_boot.add_argument(
        "--all", action="store_true", help="include packs marked optional"
    )
    p_boot.add_argument("--force", action="store_true", help="re-run even if present")
    p_boot.add_argument("--dry-run", action="store_true", help="print, do not execute")
    p_boot.set_defaults(func=cmd_bootstrap)

    p_wf = sub.add_parser("workflow", help="show how a workflow resolves here")
    p_wf.add_argument("workflow", nargs="?", default="feature-build")
    p_wf.add_argument(
        "--effort", default="medium", help="none|low|medium|high|ultrathink"
    )
    p_wf.add_argument("--provider", help="resolve dispatch against this provider")
    p_wf.set_defaults(func=cmd_workflow)

    p_why = sub.add_parser("why", help="explain one skill's fate")
    p_why.add_argument("skill")
    p_why.set_defaults(func=cmd_why)

    p_add = sub.add_parser("add", help="vendor a pack from upstream")
    p_add.add_argument("source", help="owner/repo, owner/repo@ref, or a git URL")
    p_add.add_argument("--name", help="pack name (default: the repo name)")
    p_add.add_argument("--description", help="what this pack is for")
    p_add.add_argument(
        "--pin",
        default="latest",
        help="version range for skills.toml (default: latest)",
    )
    p_add.add_argument(
        "--no-pin", action="store_true", help="do not record a pin in skills.toml"
    )
    p_add.add_argument(
        "--no-fetch", action="store_true", help="write the manifest, fetch later"
    )
    p_add.add_argument("--dry-run", action="store_true", help="print, write nothing")
    p_add.set_defaults(func=cmd_add)

    p_up = sub.add_parser("update", help="compare vendored packs with upstream")
    p_up.add_argument("pack", nargs="*", help="limit to these packs")
    p_up.add_argument(
        "--check", action="store_true", help="report drift and exit 1, fetch nothing"
    )
    p_up.set_defaults(func=cmd_update)

    p_rm = sub.add_parser("remove", help="drop a pack and everything pointing at it")
    p_rm.add_argument("pack")
    p_rm.add_argument(
        "--yes", action="store_true", help="confirm deleting authored content"
    )
    p_rm.add_argument("--dry-run", action="store_true", help="print, delete nothing")
    p_rm.set_defaults(func=cmd_remove)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (
        AcquireError,
        PackError,
        ValueError,
        FileNotFoundError,
        WorkflowError,
    ) as exc:
        print(f"skills-cli: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
