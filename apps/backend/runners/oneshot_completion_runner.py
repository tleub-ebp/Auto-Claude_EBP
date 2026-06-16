#!/usr/bin/env python3
"""
One-Shot Completion Runner — provider-agnostic single text completion.

A thin CLI around ``core.oneshot.oneshot_completion`` used by the frontend's
lightweight utilities (task title, terminal name, spec interview, visual-proof
navigation). It honours whatever LLM provider the user selected — the prompt is
built on the frontend, this just runs it through the active provider.

Input: a JSON file passed via ``--input <path>`` with keys:
    prompt        (str, required)  the complete user prompt
    system_prompt (str, optional)  system prompt
    project_dir   (str, optional)  working directory (enables exotic-provider routing)
    spec_dir      (str, optional)  spec directory (provider/model resolution)
    provider      (str, optional)  override; else resolved from env/task metadata
    model         (str, optional)  override; else a cheap per-provider default
    max_turns     (int, optional)  default 1

Output: ``__ONESHOT_RESULT__:<raw model text>`` on stdout (exit 0). Any failure
exits non-zero with a short reason on stderr so the caller can degrade.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Add the backend package root to the path (mirrors the other runners).
sys.path.insert(0, str(Path(__file__).parent.parent))

RESULT_MARKER = "__ONESHOT_RESULT__:"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provider-agnostic one-shot completion"
    )
    parser.add_argument("--input", required=True, help="Path to the JSON input file")
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"Could not read input: {exc}", file=sys.stderr)
        return 1

    prompt = payload.get("prompt")
    if not prompt:
        print("Missing required 'prompt' field", file=sys.stderr)
        return 1

    try:
        from core.oneshot import oneshot_completion

        result = asyncio.run(
            oneshot_completion(
                prompt,
                system_prompt=payload.get("system_prompt"),
                provider=payload.get("provider"),
                model=payload.get("model"),
                project_dir=payload.get("project_dir"),
                spec_dir=payload.get("spec_dir"),
                max_turns=int(payload.get("max_turns", 1)),
            )
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Generation failed: {exc}", file=sys.stderr)
        return 1

    if not result:
        print("Empty response", file=sys.stderr)
        return 1

    print(RESULT_MARKER + result, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
