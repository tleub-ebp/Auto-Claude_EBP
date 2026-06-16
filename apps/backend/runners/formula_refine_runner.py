"""
Formula Refine Runner
=====================

Thin wrapper around :func:`cost_intelligence.formula_refine.refine_formulas_sync`.
Runs ONE cheap LLM call to sharpen the success probability of the top formulas
for a ticket (the "hybrid" AI pass of the Formula Lab).

Input protocol (JSON on stdin)::

    {"description": "...", "candidates": [{"key": "...", "provider": "...",
      "model": "...", "effort": "...", "tier": "...", "base_probability": 0.8}]}

Output protocol (one line of JSON on stdout)::

    {"refined": [{"key": "...", "success_probability": 0.86, "reason": "..."}]}

On failure::

    {"error": "..."}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

backend_path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_path))

# Importing cost_intelligence triggers budget_enforcer's `apps.backend...`
# import, which needs the repo root on sys.path (the Electron spawn only sets
# PYTHONPATH to apps/backend).
_repo_root = backend_path.parent.parent
if (_repo_root / "apps").is_dir():
    sys.path.insert(0, str(_repo_root))

from cost_intelligence.formula_refine import refine_formulas_sync  # noqa: E402


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        description = str(payload.get("description", ""))
        candidates = payload.get("candidates") or []
        if not isinstance(candidates, list):
            raise ValueError("candidates must be a list")

        refined = refine_formulas_sync(description, candidates)
        print(
            json.dumps({"refined": [r.to_dict() for r in refined]}, default=str),
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
