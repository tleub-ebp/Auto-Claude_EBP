#!/usr/bin/env python3
"""Compare vendored skill packs against their upstream, and report what moved.

Called by .github/workflows/skills-sync.yml. Prints a summary, sets GitHub
Actions outputs, and writes nothing unless something actually changed.

Change detection is content-addressed: it compares the upstream tree SHA
recorded in skills-lock.json with the one GitHub reports now. Identical SHA
means no work — no diffing, no PR, no churn for a week where nothing happened.
That is the same provenance mechanism `gh skill update` uses.

Breaking changes are not applied in place. The classifier says whether the diff
is breaking; a breaking one forks the pack into a *new variant* so the pinned
one keeps resolving for projects that target it.

Classification needs the pack's content, which for a vendored pack is only on
disk after `skills:bootstrap`. When it is absent the run says so and reports the
move unclassified: guessing "non-breaking" because we could not look would take
a breaking release in place, which is the one outcome this file exists to avoid.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.acquire import AcquireError, fork_variant  # noqa: E402
from skills_registry.classify import (  # noqa: E402
    classify_pack_diff,
    facts_from_sources,
)
from skills_registry.packs import load_packs  # noqa: E402
from skills_registry.upstream import (  # noqa: E402
    LOCKFILE_NAME,
    fetch_tree_sha,
    record_shas,
    recorded_shas,
)

LOCKFILE = REPO_ROOT / LOCKFILE_NAME


def _set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        if "\n" in value:
            fh.write(f"{name}<<__EOF__\n{value}\n__EOF__\n")
        else:
            fh.write(f"{name}={value}\n")


def _pack_facts(pack_name: str):
    """The comparable facts of a pack as it currently sits on disk.

    Empty when the pack has not been bootstrapped — a vendored pack commits
    only its `pack.json`, so a runner that skipped the fetch has nothing to
    compare and must say so rather than conclude anything.
    """
    for pack in load_packs(REPO_ROOT / "skills"):
        if pack.name == pack_name:
            return facts_from_sources(pack.skills())
    return []


def _refetch(pack_name: str) -> bool:
    """Re-run the pack's own bootstrap to bring in the new release."""
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "skills_cli.py"),
            "bootstrap",
            "--pack",
            pack_name,
            "--force",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  fetch failed for {pack_name}: {result.stderr.strip()}")
    return result.returncode == 0


def _apply_release(pack_name: str, before: list) -> list[str]:
    """Take the new release, as a variant when it breaks and in place when not.

    Returns the lines to put in the report. The fork happens here rather than
    being left to a reviewer because the decision is mechanical and the failure
    mode of forgetting it is silent: a project pinned to the old toolchain
    starts receiving guidance written for a newer one, and nothing says so.
    """
    if not _refetch(pack_name):
        return ["  could not re-fetch — release not applied"]

    after = _pack_facts(pack_name)
    if not before and not after:
        return ["  not bootstrapped on this runner — moved, but unclassified"]

    diff = classify_pack_diff(pack_name, before, after)
    lines = ["  " + line for line in diff.summary().splitlines()]

    current = next(
        (p.version for p in load_packs(REPO_ROOT / "skills") if p.name == pack_name),
        "0.0.0",
    )
    new_version = diff.bump(current)

    if diff.needs_variant:
        try:
            variant = fork_variant(
                REPO_ROOT,
                pack_name,
                new_version=new_version,
                note=(
                    "Kept because the release above removed or narrowed skills "
                    "a project on these targets depends on."
                ),
            )
        except AcquireError as exc:
            lines.append(f"  could not fork: {exc}")
            return lines
        lines.append(
            f"  **forked** — {current} preserved as variant `{variant.dir}`, "
            f"root now {new_version}. Projects on its targets are unaffected."
        )
    else:
        _set_pack_version(pack_name, new_version)
        lines.append(f"  bumped in place {current} → {new_version}")
    return lines


def _set_pack_version(pack_name: str, version: str) -> None:
    manifest = REPO_ROOT / "skills" / pack_name / "pack.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["version"] = version
    manifest.write_text(
        json.dumps(data, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", help="also append the summary to this file")
    parser.add_argument("--pack", default=os.environ.get("ONLY_PACK") or "")
    parser.add_argument(
        "--no-record",
        action="store_true",
        help="report only; do not write the observed SHAs back to the lockfile",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "re-fetch what moved, classify it, and fork a variant when the "
            "release breaks. Without this the run only compares tree SHAs."
        ),
    )
    args = parser.parse_args(argv)

    recorded = recorded_shas(LOCKFILE)
    lines: list[str] = []
    observed: dict[str, str] = {}
    changed = False

    for pack in load_packs(REPO_ROOT / "skills"):
        if pack.source == "local":
            continue
        if args.pack and pack.name != args.pack:
            continue

        current = fetch_tree_sha(pack.source)
        known = recorded.get(pack.name, "")

        if current is None:
            lines.append(f"- `{pack.name}` — could not reach {pack.source}, skipped")
            continue
        observed[pack.name] = current

        if current == known:
            lines.append(f"- `{pack.name}` — unchanged (`{current[:12]}`)")
            continue

        changed = True
        lines.append(
            f"- `{pack.name}` — **moved** `{known[:12] or 'none'}` → `{current[:12]}` "
            f"({pack.source})"
        )
        if args.apply:
            # Snapshot before the fetch: this is the release we are on, and
            # after the fetch it is gone. There is nowhere else to get it.
            lines.extend(_apply_release(pack.name, _pack_facts(pack.name)))

    summary = "\n".join(lines) or "- no upstream packs declared"
    print(summary)

    # Record the baseline so the next run is quiet when nothing moved. Without
    # this every run reports "moved" and the signal stops meaning anything.
    if observed and not args.no_record:
        record_shas(LOCKFILE, observed)

    if args.report:
        with open(args.report, "a", encoding="utf-8") as fh:
            fh.write("## Skills sync\n\n" + summary + "\n")

    _set_output("changed", "true" if changed else "false")
    _set_output("summary", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
