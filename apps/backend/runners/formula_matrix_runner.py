"""
Formula Matrix Runner
=====================

Thin wrapper around :func:`cost_intelligence.compute_formula_matrix` that
emits a single JSON object on stdout. Designed to be spawned from the Electron
main process to power the kanban "Formula Lab".

Usage::

    python formula_matrix_runner.py \
        --ticket-id <id> \
        [--description "..."] \
        [--project-root <root>] \
        [--spec-dir <dir>] \
        [--providers anthropic,openai] \
        [--complexity 7.5]

Output protocol (one line of JSON)::

    {"matrix": { ... FormulaMatrix.to_dict() ... }}

On failure a single line is emitted with a non-zero exit code::

    {"error": "..."}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_path))

# cost_intelligence/__init__ pulls in budget_enforcer, which imports
# `apps.backend.models_registry` — that needs the repo root on sys.path
# (the Electron spawn only sets PYTHONPATH to apps/backend).
_repo_root = backend_path.parent.parent
if (_repo_root / "apps").is_dir():
    sys.path.insert(0, str(_repo_root))

from cost_intelligence import compute_formula_matrix  # noqa: E402
from cost_intelligence.formula_matrix import discover_local_models  # noqa: E402


def _split_csv(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    items = [token.strip() for token in raw.split(",") if token.strip()]
    return items or None


def main() -> None:
    parser = argparse.ArgumentParser(description="Formula Matrix Runner")
    parser.add_argument("--ticket-id", required=True)
    parser.add_argument("--description", default="")
    parser.add_argument("--project-root", default=None)
    parser.add_argument("--spec-dir", default=None)
    parser.add_argument("--providers", default=None)
    parser.add_argument("--complexity", type=float, default=None)
    args = parser.parse_args()

    try:
        # Best-effort: list the models actually pulled into the local Ollama
        # server so the Formula Lab can flag which ones are downloaded. Never
        # blocks for long and never raises (returns [] when Ollama is down).
        local_models = discover_local_models()
        matrix = compute_formula_matrix(
            ticket_id=args.ticket_id,
            description=args.description or "",
            spec_dir=Path(args.spec_dir) if args.spec_dir else None,
            project_root=Path(args.project_root) if args.project_root else None,
            providers=_split_csv(args.providers),
            complexity_score=args.complexity,
            local_models=local_models,
        )
        print(json.dumps({"matrix": matrix.to_dict()}, default=str), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
