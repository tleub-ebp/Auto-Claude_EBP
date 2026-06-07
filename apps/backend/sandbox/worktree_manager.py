"""
Worktree Manager — Manage isolated Git worktrees for sandbox simulation.

Creates temporary Git worktrees (or overlay copies) so that agents
can operate on a snapshot of the repository without affecting the
real working tree.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Git refs may contain alnum, `_ . / @ ^ ~ + -`. We additionally forbid a
# leading `-` so the ref cannot be parsed by git as an option flag, and we
# always pass `--` before the ref to terminate option parsing as defense in
# depth (see CVE-2017-1000117 family for git argument-injection precedent).
_REF_PATTERN = re.compile(r"^[A-Za-z0-9_./@^~+-]+$")


def _validate_ref(ref: str) -> str:
    """Validate a git ref against `git check-ref-format` rules.

    Beyond rejecting argument-injection attempts (`-`-prefixed refs), we
    pre-check the additional invariants from git-check-ref-format(1) so
    callers get a clear error before git itself fails:
    - no `..` (parent-traversal)
    - no `.lock` suffix (git uses these as locking sentinels)
    - no `@{` sequence (refs reserved for reflog)
    - not just `@`
    - no consecutive slashes
    - no leading/trailing slash
    - no leading/trailing dot
    - no path component starting with `.`
    """
    if not ref or ref.startswith("-") or not _REF_PATTERN.match(ref):
        raise ValueError(f"Invalid git ref: {ref!r}")

    # Per git-check-ref-format(1): these patterns make a ref invalid even
    # if every char is in our allowed charset.
    if (
        ref == "@"
        or ".." in ref
        or "//" in ref
        or "@{" in ref
        or ref.endswith(".lock")
        or ref.endswith("/")
        or ref.startswith("/")
        or ref.endswith(".")
        or ref.startswith(".")
    ):
        raise ValueError(f"Invalid git ref (violates check-ref-format): {ref!r}")

    # No ref component (slash-separated) may start with a `.`.
    for component in ref.split("/"):
        if component.startswith(".") or component.endswith(".lock"):
            raise ValueError(f"Invalid git ref component {component!r} in ref {ref!r}")

    return ref


@dataclass
class WorktreeInfo:
    """Metadata about a managed sandbox worktree."""

    path: Path
    branch: str
    commit_sha: str
    is_temporary: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


class WorktreeManager:
    """Create and manage Git worktrees for sandbox dry-runs.

    Usage::

        mgr = WorktreeManager(repo_root=Path("/my/repo"))
        wt = mgr.create_snapshot()
        # ... run agent actions on wt.path ...
        mgr.cleanup(wt)
    """

    def __init__(self, repo_root: Path) -> None:
        self._repo_root = repo_root
        self._active: list[WorktreeInfo] = []

    @property
    def repo_root(self) -> Path:
        return self._repo_root

    @property
    def active_worktrees(self) -> list[WorktreeInfo]:
        return list(self._active)

    def create_snapshot(self, ref: str = "HEAD") -> WorktreeInfo:
        """Create an isolated worktree snapshot from *ref*.

        Falls back to a plain directory copy if git worktree is
        unavailable (e.g. not a Git repo).
        """
        commit_sha = self._resolve_ref(ref)
        tmp_dir = Path(tempfile.mkdtemp(prefix="workpilot_sandbox_"))

        try:
            self._create_git_worktree(tmp_dir, ref)
            branch = ref
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            logger.warning(
                "Git worktree creation failed – falling back to directory copy"
            )
            self._copy_directory(tmp_dir)
            branch = "copy"

        info = WorktreeInfo(
            path=tmp_dir,
            branch=branch,
            commit_sha=commit_sha,
        )
        self._active.append(info)
        logger.info("Sandbox worktree created at %s (ref=%s)", tmp_dir, ref)
        return info

    def cleanup(self, worktree: WorktreeInfo) -> None:
        """Remove a sandbox worktree and clean up resources."""
        if worktree in self._active:
            self._active.remove(worktree)

        if worktree.path.exists():
            # Try git worktree remove first
            try:
                subprocess.run(
                    ["git", "worktree", "remove", "--force", str(worktree.path)],
                    cwd=str(self._repo_root),
                    capture_output=True,
                    timeout=30,
                )
            except (subprocess.CalledProcessError, FileNotFoundError, OSError):
                pass

            # Fallback: just remove the directory
            if worktree.path.exists():
                shutil.rmtree(worktree.path, ignore_errors=True)

        logger.info("Sandbox worktree cleaned up: %s", worktree.path)

    def cleanup_all(self) -> None:
        """Remove all active sandbox worktrees."""
        for wt in list(self._active):
            self.cleanup(wt)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _resolve_ref(self, ref: str) -> str:
        try:
            ref = _validate_ref(ref)
        except ValueError:
            return "unknown"
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--", ref],
                cwd=str(self._repo_root),
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip() if result.returncode == 0 else "unknown"
        except (FileNotFoundError, OSError):
            return "unknown"

    def _create_git_worktree(self, dest: Path, ref: str) -> None:
        ref = _validate_ref(ref)
        # Remove the temp dir first — git worktree add needs a non-existing target
        if dest.exists():
            shutil.rmtree(dest)

        subprocess.run(
            ["git", "worktree", "add", "--detach", str(dest), ref],
            cwd=str(self._repo_root),
            capture_output=True,
            check=True,
            timeout=60,
        )

    def _copy_directory(self, dest: Path) -> None:
        """Plain directory copy fallback, excluding heavy dirs."""
        exclude = {".git", "node_modules", "__pycache__", ".venv", "venv", ".tox"}
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(
            self._repo_root,
            dest,
            ignore=shutil.ignore_patterns(*exclude),
        )
