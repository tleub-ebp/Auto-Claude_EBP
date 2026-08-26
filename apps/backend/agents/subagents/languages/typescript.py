"""TypeScript / JavaScript overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="typescript",
    test_commands=[
        "vitest run                      # non-watch; plain `vitest` hangs",
        "vitest run <file>               # one file, when iterating",
        "jest --ci                       # if the project uses jest",
        "playwright test                 # e2e only, slow",
    ],
    lint_commands=[
        "biome ci .",
        "tsc --noEmit                    # slow on large projects",
    ],
    notes=(
        "Never run a watch-mode test command: it never exits and the run "
        "stalls. Check the package manager from the lockfile (pnpm-lock.yaml, "
        "yarn.lock, package-lock.json) rather than defaulting to npm."
    ),
)
