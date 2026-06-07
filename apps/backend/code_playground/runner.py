"""Subprocess-based code snippet runner."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024  # 256 KiB
TRUNCATION_MARKER = "\n…[truncated by playground: output cap reached]…\n"


class PlaygroundLanguage(str, Enum):
    """Languages the playground knows how to invoke."""

    PYTHON = "python"
    NODE = "node"


# Each entry: language → (file extension, executable lookup names).
# The first executable found on PATH wins. ``sys.executable`` is used as
# a guaranteed fallback for Python so the playground always has at least
# one runnable language.
_LANG_CONFIG: dict[PlaygroundLanguage, tuple[str, tuple[str, ...]]] = {
    PlaygroundLanguage.PYTHON: (".py", ("python3", "python")),
    PlaygroundLanguage.NODE: (".js", ("node",)),
}


class PlaygroundTimeout(Exception):
    """Raised when a snippet exceeds its wall-clock timeout."""


@dataclass
class PlaygroundResult:
    """Outcome of executing a single snippet."""

    language: PlaygroundLanguage
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float
    truncated: bool = False
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0

    def to_dict(self) -> dict[str, object]:
        return {
            "language": self.language.value,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_seconds": self.duration_seconds,
            "truncated": self.truncated,
            "succeeded": self.succeeded,
            "extra": dict(self.extra),
        }


def _resolve_executable(lang: PlaygroundLanguage) -> str | None:
    """Find an interpreter for ``lang`` on PATH, or ``None`` if missing."""
    # Python: prefer ``sys.executable`` over PATH lookup. On Windows, PATH
    # often resolves to the Microsoft Store stub (WindowsApps/python.exe),
    # which fails with WinError 3 when invoked via subprocess.
    if lang is PlaygroundLanguage.PYTHON and sys.executable:
        return sys.executable
    _, candidates = _LANG_CONFIG[lang]
    for name in candidates:
        path = shutil.which(name)
        if path:
            return path
    return None


def available_languages() -> list[PlaygroundLanguage]:
    """Return the set of languages whose interpreter is installed."""
    return [
        lang for lang in PlaygroundLanguage if _resolve_executable(lang) is not None
    ]


def _cap_output(buf: str) -> tuple[str, bool]:
    """Trim a captured stream to ``DEFAULT_OUTPUT_CAP_BYTES``."""
    encoded = buf.encode("utf-8", errors="replace")
    if len(encoded) <= DEFAULT_OUTPUT_CAP_BYTES:
        return buf, False
    head_keep = DEFAULT_OUTPUT_CAP_BYTES // 2
    tail_keep = DEFAULT_OUTPUT_CAP_BYTES - head_keep
    head = encoded[:head_keep].decode("utf-8", errors="replace")
    tail = encoded[-tail_keep:].decode("utf-8", errors="replace")
    return head + TRUNCATION_MARKER + tail, True


@dataclass
class PlaygroundRunner:
    """Runs snippets in a one-shot subprocess and returns structured output.

    A new instance per call is fine — there is no persistent state. Kept
    as a class so callers can override ``timeout_seconds`` / ``env`` /
    ``cwd`` once and reuse for several snippets.
    """

    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    env: dict[str, str] | None = None
    cwd: Path | None = None  # If None, a tmp dir is created per-run.

    def run(
        self,
        snippet: str,
        language: PlaygroundLanguage | str = PlaygroundLanguage.PYTHON,
        *,
        stdin: str = "",
    ) -> PlaygroundResult:
        if isinstance(language, str):
            language = PlaygroundLanguage(language)

        executable = _resolve_executable(language)
        if executable is None:
            raise RuntimeError(
                f"No interpreter for {language.value!r} on PATH — install one or "
                "filter via available_languages() before calling run()."
            )

        ext, _ = _LANG_CONFIG[language]
        owns_cwd = self.cwd is None
        cwd = Path(tempfile.mkdtemp(prefix="playground_")) if owns_cwd else self.cwd
        # ``cwd`` is non-None here either way, but Path() satisfies type checkers.
        cwd = Path(cwd)
        snippet_path = cwd / f"snippet{ext}"
        snippet_path.write_text(snippet, encoding="utf-8")

        # Build a deliberately *minimal* env to keep the snippet honest:
        # pass only PATH (so the interpreter can find sub-tools) and any
        # caller-provided overrides.
        run_env = {"PATH": os.environ.get("PATH", "")}
        if self.env:
            run_env.update(self.env)

        import time

        start = time.monotonic()
        try:
            proc = subprocess.run(
                [executable, str(snippet_path)],
                cwd=str(cwd),
                env=run_env,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            elapsed = time.monotonic() - start
            stdout, stdout_truncated = _cap_output(exc.stdout or "")
            stderr, stderr_truncated = _cap_output(
                (exc.stderr or "")
                + f"\n[playground] killed after {self.timeout_seconds:.1f}s\n"
            )
            if owns_cwd:
                shutil.rmtree(cwd, ignore_errors=True)
            raise PlaygroundTimeout(
                f"Snippet exceeded {self.timeout_seconds:.1f}s timeout"
            ) from None
        finally:
            if owns_cwd and cwd.exists():
                # Only remove if no exception path already cleaned it.
                shutil.rmtree(cwd, ignore_errors=True)

        elapsed = time.monotonic() - start
        stdout, stdout_truncated = _cap_output(proc.stdout)
        stderr, stderr_truncated = _cap_output(proc.stderr)

        return PlaygroundResult(
            language=language,
            exit_code=proc.returncode,
            stdout=stdout,
            stderr=stderr,
            duration_seconds=elapsed,
            truncated=stdout_truncated or stderr_truncated,
        )


def run_snippet(
    snippet: str,
    language: PlaygroundLanguage | str = PlaygroundLanguage.PYTHON,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    stdin: str = "",
) -> PlaygroundResult:
    """Convenience wrapper around ``PlaygroundRunner().run(...)``."""
    return PlaygroundRunner(timeout_seconds=timeout_seconds).run(
        snippet, language, stdin=stdin
    )
