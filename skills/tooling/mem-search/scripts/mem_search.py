#!/usr/bin/env python3
"""mem-search CLI — the three layers, from a shell.

    mem_search.py index "flaky timeout in the integration suite"
    mem_search.py timeline task:042-add-widget pattern:p-17
    mem_search.py detail task:042-add-widget

The layering is the point, so the command shape enforces it: `index` takes a
query and returns ids, and the other two take ids. There is no way to ask for
every detail at once, because that is the call this exists to avoid.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _import_mem_search():
    """Find the backend package from wherever the skill was materialised.

    A skill is copied into several harness directories, so it cannot rely on
    its own path. It walks up looking for the backend, and says something
    useful when it is not there rather than raising an ImportError at a caller
    who has no idea what `mem_search` is.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "apps" / "backend"
        if (candidate / "mem_search").is_dir():
            sys.path.insert(0, str(candidate))
            import mem_search

            return mem_search
    raise SystemExit(
        "mem-search: could not find apps/backend/mem_search from "
        f"{here}. Run this from inside a WorkPilot checkout."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mem-search", description=__doc__)
    parser.add_argument(
        "--project-dir", default=".", help="project whose memory to read"
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="layer 1 — what exists, compactly")
    p_index.add_argument("query", nargs="+")
    p_index.add_argument("--limit", type=int, default=40)
    p_index.add_argument(
        "--budget", type=int, default=0, help="token ceiling (default: 100)"
    )

    p_time = sub.add_parser("timeline", help="layer 2 — a couple of lines per id")
    p_time.add_argument("ids", nargs="+")

    p_detail = sub.add_parser("detail", help="layer 3 — one full record")
    p_detail.add_argument("id")

    args = parser.parse_args(argv)
    mem_search = _import_mem_search()
    memory = mem_search.search_for(args.project_dir)

    if args.command == "index":
        result = memory.index(
            " ".join(args.query),
            limit=args.limit,
            budget_tokens=args.budget or mem_search.INDEX_TOKEN_BUDGET,
        )
        if args.json:
            print(
                json.dumps(
                    {
                        "query": result.query,
                        "tokens": result.tokens,
                        "truncated": result.truncated,
                        "refs": [
                            {
                                "id": r.id,
                                "kind": r.kind,
                                "when": r.when,
                                "label": r.label,
                            }
                            for r in result.refs
                        ],
                    },
                    indent="\t",
                    ensure_ascii=False,
                )
            )
        else:
            print(result.render() or "(nothing in memory matches)")
        return 0

    if args.command == "timeline":
        entries = memory.timeline(args.ids)
        if args.json:
            print(
                json.dumps(
                    [
                        {
                            "id": e.id,
                            "kind": e.kind,
                            "when": e.when,
                            "label": e.label,
                            "summary": e.summary,
                            "related": list(e.related),
                        }
                        for e in entries
                    ],
                    indent="\t",
                    ensure_ascii=False,
                )
            )
        else:
            for entry in entries:
                print(f"{entry.id}  {entry.when}  {entry.label}")
                print(f"  {entry.summary}")
            if not entries:
                print("(no such ids in memory)")
        return 0

    record = memory.detail(args.id)
    if record is None:
        print(f"mem-search: no record with id {args.id!r}", file=sys.stderr)
        return 1
    if args.json:
        print(
            json.dumps(
                {
                    "id": record.id,
                    "kind": record.kind,
                    "when": record.when,
                    "label": record.label,
                    "body": record.body,
                },
                indent="\t",
                ensure_ascii=False,
            )
        )
    else:
        print(f"{record.id}  {record.when}  {record.label}\n")
        print(record.body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
