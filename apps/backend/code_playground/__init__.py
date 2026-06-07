"""Code Playground — execute code snippets in an isolated subprocess.

A small, deterministic execution surface so the rest of the app (and the
agents) can quickly try out a snippet without touching the project tree
or a real REPL. Currently supports Python and Node.js.

Design constraints:
    * Subprocess isolation (no in-process eval).
    * Hard wall-clock timeout (kills the process tree on expiry).
    * Captured stdout / stderr / exit code, never raises on snippet errors.
    * Sandbox cwd is a tmp dir scoped to the run; cleaned on exit.
    * Resource limits (output size cap) to keep the host responsive.

Out of scope for this MVP (intentionally not implemented):
    * Network sandboxing / firewall rules
    * CPU / memory limits beyond what the OS provides
    * Persistent sessions or REPL state across runs
"""

from .runner import (
    PlaygroundLanguage,
    PlaygroundResult,
    PlaygroundRunner,
    PlaygroundTimeout,
    available_languages,
    run_snippet,
)

__all__ = [
    "PlaygroundLanguage",
    "PlaygroundResult",
    "PlaygroundRunner",
    "PlaygroundTimeout",
    "available_languages",
    "run_snippet",
]
