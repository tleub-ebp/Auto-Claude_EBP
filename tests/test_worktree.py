#!/usr/bin/env python3
"""
Tests for Git Worktree Management
=================================

Tests the worktree.py module functionality including:
- Worktree creation and removal
- Staging worktree management
- Branch operations
- Merge operations
- Change tracking
- Worktree cleanup and age detection
"""

import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from worktree import WorktreeManager


class TestWorktreeManagerInitialization:
    """Tests for WorktreeManager initialization."""

    def test_init_with_valid_git_repo(self, temp_git_repo: Path):
        """Manager initializes correctly with valid git repo."""
        manager = WorktreeManager(temp_git_repo)

        assert manager.project_dir == temp_git_repo
        assert (
            manager.worktrees_dir
            == temp_git_repo / ".workpilot" / "worktrees" / "tasks"
        )
        assert manager.base_branch is not None

    def test_init_prefers_main_over_current_branch(self, temp_git_repo: Path):
        """Manager prefers main/master over current branch when detecting base branch."""
        # Create and switch to a new branch
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo,
            capture_output=True,
        )

        # Even though we're on feature-branch, manager should prefer main
        manager = WorktreeManager(temp_git_repo)
        assert manager.base_branch == "main"

    def test_init_falls_back_to_current_branch(self, temp_git_repo: Path):
        """Manager falls back to current branch when main/master don't exist."""
        # Delete main branch to force fallback
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        subprocess.run(
            ["git", "branch", "-D", "main"], cwd=temp_git_repo, capture_output=True
        )

        manager = WorktreeManager(temp_git_repo)
        assert manager.base_branch == "feature-branch"

    def test_init_with_explicit_base_branch(self, temp_git_repo: Path):
        """Manager uses explicitly provided base branch."""
        manager = WorktreeManager(temp_git_repo, base_branch="main")
        assert manager.base_branch == "main"

    def test_setup_creates_worktrees_directory(self, temp_git_repo: Path):
        """Setup creates the worktrees directory."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        assert manager.worktrees_dir.exists()
        assert manager.worktrees_dir.is_dir()


class TestSpecNameValidation:
    """Tests for spec_name sanitization and validation."""

    def test_accented_name_is_transliterated_to_ascii(self):
        """Legacy accented spec folders are mapped to ASCII branch/path names."""
        result = WorktreeManager._validate_spec_name(
            "002-limitation-du-numéro-de-tva-intracommunautaire-du-"
        )
        assert result == "002-limitation-du-numero-de-tva-intracommunautaire-du-"

    def test_ascii_name_is_unchanged(self):
        """A clean ASCII spec name passes through untouched."""
        assert WorktreeManager._validate_spec_name("001-feature") == "001-feature"

    def test_branch_name_uses_ascii_for_accented_spec(self):
        """get_branch_name yields an ASCII git ref for an accented spec."""
        manager = WorktreeManager.__new__(WorktreeManager)
        assert (
            manager.get_branch_name("003-fenêtre-d-avertissement")
            == "workpilot/003-fenetre-d-avertissement"
        )

    def test_path_traversal_still_rejected(self):
        """Accent stripping must not weaken path-traversal protection."""
        with pytest.raises(ValueError):
            WorktreeManager._validate_spec_name("../../etc/passwd")

    def test_separator_still_rejected(self):
        """Slashes are not 'fixed' by transliteration and stay rejected."""
        with pytest.raises(ValueError):
            WorktreeManager._validate_spec_name("foo/bar")

    def test_empty_name_rejected(self):
        """Empty spec_name is rejected."""
        with pytest.raises(ValueError):
            WorktreeManager._validate_spec_name("")


class TestWorktreeCreation:
    """Tests for creating worktrees."""

    def test_create_worktree(self, temp_git_repo: Path):
        """Can create a new worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        assert info.path.exists()
        assert info.branch == "workpilot/test-spec"
        assert info.is_active is True
        assert (info.path / "README.md").exists()

    def test_create_worktree_with_spec_name(self, temp_git_repo: Path):
        """Worktree branch is derived from spec name."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("my-feature-spec")

        assert info.branch == "workpilot/my-feature-spec"

    def test_get_or_create_replaces_existing_worktree(self, temp_git_repo: Path):
        """get_or_create_worktree returns existing worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info1 = manager.create_worktree("test-spec")
        # Create a file in the worktree
        (info1.path / "test-file.txt").write_text("test")

        # get_or_create should return existing
        info2 = manager.get_or_create_worktree("test-spec")

        assert info2.path.exists()
        # The test file should still be there (same worktree)
        assert (info2.path / "test-file.txt").exists()

    def test_create_worktree_idempotent(self, temp_git_repo: Path):
        """create_worktree succeeds when called twice with same spec name."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # First creation should succeed
        info1 = manager.create_worktree("test-spec")
        assert info1.path.exists()
        assert info1.branch == "workpilot/test-spec"

        # Create a file in the worktree to verify it's preserved
        (info1.path / "test-file.txt").write_text("test content")

        # Second creation should also succeed (idempotent)
        info2 = manager.create_worktree("test-spec")

        # Should return valid worktree info
        assert info2.path.exists()
        assert info2.branch == "workpilot/test-spec"
        # The test file should still be there (same worktree returned)
        assert (info2.path / "test-file.txt").exists()
        assert (info2.path / "test-file.txt").read_text() == "test content"

    def test_create_worktree_branch_exists_no_worktree(self, temp_git_repo: Path):
        """create_worktree reuses existing branch when worktree is missing."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create initial worktree
        info1 = manager.create_worktree("test-spec")
        branch_name = info1.branch
        assert info1.path.exists()
        assert branch_name == "workpilot/test-spec"

        # Remove worktree but keep the branch (delete_branch=False is default)
        manager.remove_worktree("test-spec", delete_branch=False)

        # Verify worktree directory is gone
        assert not info1.path.exists()

        # Verify branch still exists
        result = subprocess.run(
            ["git", "branch", "--list", branch_name],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert branch_name in result.stdout, (
            "Branch should still exist after worktree removal"
        )

        # Create worktree again - should succeed by reusing existing branch
        info2 = manager.create_worktree("test-spec")

        # Should return valid worktree info with the same branch
        assert info2.path.exists()
        assert info2.branch == branch_name
        assert info2.is_active is True
        # README should exist (copied from base branch)
        assert (info2.path / "README.md").exists()

    def test_create_worktree_stale_directory(self, temp_git_repo: Path):
        """create_worktree cleans up stale directory and recreates worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree normally
        info = manager.create_worktree("test-spec")
        worktree_path = info.path
        branch_name = info.branch
        assert worktree_path.exists()

        # Add a file to the worktree so we can verify it gets cleaned up
        (worktree_path / "test-file.txt").write_text("test content")

        # Force-remove the worktree from git's tracking, but leave directory intact
        # This simulates a stale state where directory exists but git doesn't track it
        result = subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert result.returncode == 0, (
            f"Failed to force remove worktree: {result.stderr}"
        )

        # Recreate the directory manually to simulate stale state
        # (git worktree remove also deletes the directory, so we recreate it)
        worktree_path.mkdir(parents=True, exist_ok=True)
        (worktree_path / "stale-file.txt").write_text("stale content")

        # Verify directory exists but is not tracked by git
        assert worktree_path.exists()
        wt_list_result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert str(worktree_path) not in wt_list_result.stdout, (
            "Worktree should not be registered"
        )

        # Now create_worktree should clean up the stale directory and recreate successfully
        info2 = manager.create_worktree("test-spec")

        # Should return valid worktree info
        assert info2.path.exists()
        assert info2.branch == branch_name
        assert info2.is_active is True
        # README should exist (from base branch)
        assert (info2.path / "README.md").exists()
        # Stale file should be gone (directory was cleaned up)
        assert not (info2.path / "stale-file.txt").exists()

    def test_create_worktree_stale_directory_with_existing_branch(
        self, temp_git_repo: Path
    ):
        """create_worktree handles stale directory when branch already exists."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree normally
        info = manager.create_worktree("test-spec")
        worktree_path = info.path
        branch_name = info.branch
        assert worktree_path.exists()

        # Unregister the worktree but KEEP the branch
        # Use 'git worktree remove' which removes directory, then manually recreate stale dir
        # But first we need to ensure the branch survives
        result = subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert result.returncode == 0, f"Failed to remove worktree: {result.stderr}"

        # Verify branch still exists (git worktree remove doesn't delete branch)
        result = subprocess.run(
            ["git", "branch", "--list", branch_name],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert branch_name in result.stdout, (
            "Branch should still exist after worktree removal"
        )

        # Recreate stale directory manually (simulates orphaned directory)
        worktree_path.mkdir(parents=True, exist_ok=True)
        (worktree_path / "stale-file.txt").write_text("stale content")

        # Verify: directory exists, worktree NOT registered, branch EXISTS
        assert worktree_path.exists()
        wt_list_result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert str(worktree_path) not in wt_list_result.stdout, (
            "Worktree should not be registered"
        )

        # Now create_worktree should:
        # 1. Detect stale directory (not registered)
        # 2. Clean up stale directory
        # 3. Detect existing branch
        # 4. Reuse existing branch (no -b flag)
        info2 = manager.create_worktree("test-spec")

        # Should return valid worktree info with SAME branch (reused)
        assert info2.path.exists()
        assert info2.branch == branch_name
        assert info2.is_active is True
        # README should exist (from branch content)
        assert (info2.path / "README.md").exists()
        # Stale file should be gone (directory was cleaned up before worktree add)
        assert not (info2.path / "stale-file.txt").exists()


class TestWorktreeAddRetry:
    """Tests for the transient-failure retry around `git worktree add`.

    `git worktree add` is flaky on Windows CI: it intermittently exits non-zero
    with an empty stderr while antivirus/indexing briefly locks a just-created
    file during checkout. These tests pin the retry/cleanup behaviour.
    """

    def test_empty_stderr_is_retryable(self):
        """An empty stderr (the Windows CI signature) is treated as transient."""
        from core.worktree import _is_retryable_worktree_add_error

        assert _is_retryable_worktree_add_error("")
        assert _is_retryable_worktree_add_error("   \n")

    def test_lock_messages_are_retryable(self):
        """Known file-locking messages are treated as transient."""
        from core.worktree import _is_retryable_worktree_add_error

        assert _is_retryable_worktree_add_error(
            "fatal: Unable to create '.../index.lock': File exists"
        )
        assert _is_retryable_worktree_add_error(
            "error: The process cannot access the file because it is "
            "being used by another process"
        )

    def test_genuine_errors_are_not_retryable(self):
        """A real, non-transient git error is not retried."""
        from core.worktree import _is_retryable_worktree_add_error

        assert not _is_retryable_worktree_add_error(
            "fatal: invalid reference: does-not-exist"
        )

    def test_create_worktree_retries_transient_failure(
        self, temp_git_repo: Path, monkeypatch
    ):
        """A transient `worktree add` failure is retried and then succeeds."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        real_run_git = manager._run_git
        calls = {"add": 0}

        def flaky_run_git(args, *a, **kw):
            # Fail the first `worktree add` with an empty stderr (Windows CI
            # signature), then let the real command run on the retry.
            if len(args) >= 2 and args[0] == "worktree" and args[1] == "add":
                calls["add"] += 1
                if calls["add"] == 1:
                    return subprocess.CompletedProcess(
                        args=args, returncode=1, stdout="", stderr=""
                    )
            return real_run_git(args, *a, **kw)

        monkeypatch.setattr(manager, "_run_git", flaky_run_git)

        info = manager.create_worktree("test-spec")

        assert calls["add"] >= 2, "worktree add should have been retried"
        assert info.path.exists()
        assert info.branch == "workpilot/test-spec"
        assert (info.path / "README.md").exists()

    def test_spawn_failure_exit_code_is_retried_with_slow_backoff(
        self, temp_git_repo: Path, monkeypatch
    ):
        """STATUS_DLL_INIT_FAILED (0xC0000142) is retried even with stderr text.

        On loaded GitHub Windows runners git can die before producing output
        (exit 3221225794). The condition is runner-wide and persists longer
        than a file lock, so the retry must (a) trigger on the exit code alone
        and (b) use the slower backoff schedule.
        """
        import core.worktree as worktree_module

        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        real_run_git = manager._run_git
        calls = {"add": 0}
        sleeps: list[float] = []

        def flaky_run_git(args, *a, **kw):
            if len(args) >= 2 and args[0] == "worktree" and args[1] == "add":
                calls["add"] += 1
                if calls["add"] <= 2:
                    # Spawn failure: non-empty stderr that does NOT match the
                    # lock-message list — only the exit code marks it transient.
                    return subprocess.CompletedProcess(
                        args=args,
                        returncode=3221225794,
                        stdout="",
                        stderr="(spawn diagnostics)",
                    )
            return real_run_git(args, *a, **kw)

        monkeypatch.setattr(manager, "_run_git", flaky_run_git)
        monkeypatch.setattr(worktree_module.time, "sleep", lambda s: sleeps.append(s))

        info = manager.create_worktree("test-spec")

        assert calls["add"] >= 3, "spawn failure should have been retried"
        assert info.path.exists()
        # Slow schedule: 2.0 * 2**(attempt-1), not the 0.5-based lock schedule.
        assert sleeps[:2] == [2.0, 4.0]

    def test_create_worktree_reports_output_on_persistent_failure(
        self, temp_git_repo: Path, monkeypatch
    ):
        """A non-transient failure surfaces git's output instead of an empty msg."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        real_run_git = manager._run_git

        def failing_run_git(args, *a, **kw):
            if len(args) >= 2 and args[0] == "worktree" and args[1] == "add":
                return subprocess.CompletedProcess(
                    args=args,
                    returncode=128,
                    stdout="",
                    stderr="fatal: invalid reference: boom",
                )
            return real_run_git(args, *a, **kw)

        monkeypatch.setattr(manager, "_run_git", failing_run_git)

        with pytest.raises(Exception) as exc_info:
            manager.create_worktree("test-spec")

        message = str(exc_info.value)
        assert "git exit 128" in message
        assert "invalid reference: boom" in message


class TestWorktreeRemoval:
    """Tests for removing worktrees."""

    def test_remove_worktree(self, temp_git_repo: Path):
        """Can remove a worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        manager.remove_worktree("test-spec")

        assert not info.path.exists()

    def test_remove_with_delete_branch(self, temp_git_repo: Path):
        """Removing worktree can also delete the branch."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")
        branch_name = info.branch

        manager.remove_worktree("test-spec", delete_branch=True)

        # Verify branch is deleted
        result = subprocess.run(
            ["git", "branch", "--list", branch_name],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert branch_name not in result.stdout

    def test_remove_worktree_with_uncommitted_changes_raises_error(
        self, temp_git_repo: Path
    ):
        """Removing worktree with uncommitted changes raises RuntimeError."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Create an uncommitted change in the worktree
        (info.path / "new-file.txt").write_text("uncommitted content")

        # Should raise RuntimeError instead of silently deleting
        with pytest.raises(RuntimeError) as exc_info:
            manager.remove_worktree("test-spec")

        assert "uncommitted" in str(exc_info.value).lower()
        assert "new-file.txt" in str(exc_info.value)
        # Worktree should still exist
        assert info.path.exists()

    def test_remove_worktree_after_committing_changes(self, temp_git_repo: Path):
        """Can remove worktree after committing changes."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Create and commit a change in the worktree
        (info.path / "new-file.txt").write_text("committed content")
        subprocess.run(
            ["git", "add", "."],
            cwd=info.path,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "Test commit"],
            cwd=info.path,
            capture_output=True,
        )

        # Should remove successfully now
        manager.remove_worktree("test-spec")
        assert not info.path.exists()


class TestWorktreeCommitAndMerge:
    """Tests for commit and merge operations."""

    def test_merge_worktree(self, temp_git_repo: Path):
        """Can merge a worktree back to main."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        subprocess.run(["git", "add", "."], cwd=worker_info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )

        # Merge worktree back to main
        result = manager.merge_worktree("worker-spec", delete_after=False)

        assert result is True

        # Verify file is in main branch
        subprocess.run(
            ["git", "checkout", manager.base_branch],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert (temp_git_repo / "worker-file.txt").exists()

    def test_merge_worktree_already_on_target_branch(self, temp_git_repo: Path):
        """merge_worktree succeeds when already on target branch (ACS-174)."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Ensure we're on the base branch
        result = subprocess.run(
            ["git", "checkout", manager.base_branch],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert result.returncode == 0, f"Checkout failed: {result.stderr}"

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert result.returncode == 0, f"Git add failed: {result.stderr}"
        result = subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert result.returncode == 0, f"Commit failed: {result.stderr}"

        # Already on target branch, should skip checkout and still merge successfully
        result = manager.merge_worktree("worker-spec", delete_after=False)

        assert result is True

        # Verify file is in main branch
        assert (temp_git_repo / "worker-file.txt").exists()

    def test_merge_worktree_already_up_to_date(self, temp_git_repo: Path):
        """merge_worktree succeeds when branch is already up to date (ACS-226)."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # First merge succeeds
        result = manager.merge_worktree("worker-spec", delete_after=False)
        assert result is True

        # Second merge should also succeed (already up to date)
        result = manager.merge_worktree("worker-spec", delete_after=False)
        assert result is True

    def test_merge_worktree_already_up_to_date_with_no_commit(
        self, temp_git_repo: Path
    ):
        """merge_worktree with no_commit=True succeeds when already up to date (ACS-226)."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # First merge with no_commit succeeds
        result = manager.merge_worktree(
            "worker-spec", no_commit=True, delete_after=False
        )
        assert result is True

        # Commit the staged changes
        merge_commit_result = subprocess.run(
            ["git", "commit", "-m", "Merge commit"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert merge_commit_result.returncode == 0, (
            f"git commit failed: {merge_commit_result.stderr}"
        )

        # Second merge should also succeed (already up to date)
        result = manager.merge_worktree(
            "worker-spec", no_commit=True, delete_after=False
        )
        assert result is True

    def test_merge_worktree_already_up_to_date_with_delete_after(
        self, temp_git_repo: Path
    ):
        """merge_worktree with delete_after=True succeeds when already up to date (ACS-226)."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        branch_name = worker_info.branch
        (worker_info.path / "worker-file.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # First merge succeeds
        result = manager.merge_worktree("worker-spec", delete_after=False)
        assert result is True

        # Second merge with delete_after=True should also succeed and clean up
        result = manager.merge_worktree("worker-spec", delete_after=True)
        assert result is True

        # Verify worktree was deleted
        assert not worker_info.path.exists()

        # Verify branch was deleted
        branch_list_result = subprocess.run(
            ["git", "branch", "--list", branch_name],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert branch_name not in branch_list_result.stdout, (
            f"Branch {branch_name} should be deleted"
        )

    def test_merge_with_delete_after_but_uncommitted_changes(self, temp_git_repo: Path):
        """merge_worktree with delete_after=True preserves worktree if it has uncommitted changes."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # First merge succeeds
        result = manager.merge_worktree("worker-spec", delete_after=False)
        assert result is True

        # Now create an uncommitted change in the worktree
        (worker_info.path / "uncommitted.txt").write_text("uncommitted content")

        # Second merge with delete_after=True should succeed but NOT delete worktree
        # because it has uncommitted changes
        result = manager.merge_worktree("worker-spec", delete_after=True)
        assert result is True

        # Worktree should STILL exist (not deleted)
        assert worker_info.path.exists(), (
            "Worktree should be preserved because it has uncommitted changes"
        )

        # But the uncommitted file should still be there
        assert (worker_info.path / "uncommitted.txt").exists()

    def test_merge_worktree_conflict_detection(self, temp_git_repo: Path):
        """merge_worktree correctly detects and handles merge conflicts."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create initial file on base branch
        (temp_git_repo / "shared.txt").write_text("base content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=temp_git_repo, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Add shared file"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Create worktree with conflicting change
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "shared.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker change"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Make conflicting change on base branch
        (temp_git_repo / "shared.txt").write_text("base change")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=temp_git_repo, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Base change"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Merge should detect conflict and fail
        result = manager.merge_worktree("worker-spec", delete_after=False)
        assert result is False

        # Verify merge was aborted (no merge state exists)
        # Check that MERGE_HEAD does not exist
        merge_head_result = subprocess.run(
            ["git", "rev-parse", "--verify", "MERGE_HEAD"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert merge_head_result.returncode != 0, (
            "MERGE_HEAD should not exist after abort"
        )

        # Verify git status shows no unmerged/conflict status codes
        git_status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        # Should have no output (clean working directory)
        assert git_status.returncode == 0
        assert not git_status.stdout.strip(), (
            f"Expected clean status, got: {git_status.stdout}"
        )

    def test_merge_worktree_conflict_with_no_commit(self, temp_git_repo: Path):
        """merge_worktree with no_commit=True handles conflicts correctly."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create initial file on base branch
        (temp_git_repo / "shared.txt").write_text("base content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=temp_git_repo, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Add shared file"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Create worktree with conflicting change
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "shared.txt").write_text("worker content")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=worker_info.path, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Worker change"],
            cwd=worker_info.path,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Make conflicting change on base branch
        (temp_git_repo / "shared.txt").write_text("base change")
        add_result = subprocess.run(
            ["git", "add", "."], cwd=temp_git_repo, capture_output=True
        )
        assert add_result.returncode == 0, f"git add failed: {add_result.stderr}"
        commit_result = subprocess.run(
            ["git", "commit", "-m", "Base change"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert commit_result.returncode == 0, (
            f"git commit failed: {commit_result.stderr}"
        )

        # Merge with no_commit should detect conflict and fail
        result = manager.merge_worktree(
            "worker-spec", no_commit=True, delete_after=False
        )
        assert result is False

        # Verify merge was aborted (no merge state exists)
        # Check that MERGE_HEAD does not exist
        merge_head_result = subprocess.run(
            ["git", "rev-parse", "--verify", "MERGE_HEAD"],
            cwd=temp_git_repo,
            capture_output=True,
        )
        assert merge_head_result.returncode != 0, (
            "MERGE_HEAD should not exist after abort"
        )

        # Verify git status shows no staged/unstaged changes
        git_status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=temp_git_repo,
            capture_output=True,
            text=True,
        )
        assert git_status.returncode == 0
        assert not git_status.stdout.strip(), (
            f"Expected clean status, got: {git_status.stdout}"
        )


class TestChangeTracking:
    """Tests for tracking changes in worktrees."""

    def test_has_uncommitted_changes_false(self, temp_git_repo: Path):
        """has_uncommitted_changes returns False when clean."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        assert manager.has_uncommitted_changes() is False

    def test_has_uncommitted_changes_true(self, temp_git_repo: Path):
        """has_uncommitted_changes returns True when dirty."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Make uncommitted changes
        (temp_git_repo / "dirty.txt").write_text("uncommitted")

        assert manager.has_uncommitted_changes() is True

    def test_get_change_summary(self, temp_git_repo: Path):
        """get_change_summary returns correct counts."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Make various changes
        (info.path / "new-file.txt").write_text("new")
        (info.path / "README.md").write_text("modified")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Changes"], cwd=info.path, capture_output=True
        )

        summary = manager.get_change_summary("test-spec")

        assert summary["new_files"] == 1  # new-file.txt
        assert summary["modified_files"] == 1  # README.md

    def test_get_changed_files(self, temp_git_repo: Path):
        """get_changed_files returns list of changed files."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Make changes
        (info.path / "added.txt").write_text("new file")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Add file"], cwd=info.path, capture_output=True
        )

        files = manager.get_changed_files("test-spec")

        assert len(files) > 0
        file_names = [f[1] for f in files]
        assert "added.txt" in file_names


class TestWorktreeUtilities:
    """Tests for utility methods."""

    def test_list_worktrees(self, temp_git_repo: Path):
        """list_all_worktrees returns active worktrees."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("spec-1")
        manager.create_worktree("spec-2")

        worktrees = manager.list_all_worktrees()

        assert len(worktrees) == 2

    def test_get_info(self, temp_git_repo: Path):
        """get_worktree_info returns correct WorktreeInfo."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("test-spec")

        info = manager.get_worktree_info("test-spec")

        assert info is not None
        assert info.branch == "workpilot/test-spec"

    def test_get_worktree_path(self, temp_git_repo: Path):
        """get_worktree_path returns correct path."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        path = manager.get_worktree_path("test-spec")

        assert path == info.path

    def test_cleanup_all(self, temp_git_repo: Path):
        """cleanup_all removes all worktrees."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("spec-1")
        manager.create_worktree("spec-2")
        manager.create_worktree("spec-3")

        manager.cleanup_all()

        assert len(manager.list_all_worktrees()) == 0

    def test_cleanup_stale_worktrees(self, temp_git_repo: Path):
        """cleanup_stale_worktrees removes directories without git tracking."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a stale worktree directory (exists but not tracked by git)
        stale_dir = manager.worktrees_dir / "stale-worktree"
        stale_dir.mkdir(parents=True, exist_ok=True)

        # This should clean up the stale directory
        manager.cleanup_stale_worktrees()

        # Stale directory should be removed
        assert not stale_dir.exists()

    def test_get_test_commands_python(self, temp_git_repo: Path):
        """get_test_commands detects Python project commands."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Create requirements.txt
        (info.path / "requirements.txt").write_text("flask\n")

        commands = manager.get_test_commands("test-spec")

        assert any("pip" in cmd for cmd in commands)

    def test_get_test_commands_node(self, temp_git_repo: Path):
        """get_test_commands detects Node.js project commands."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec-node")

        # Create package.json
        (info.path / "package.json").write_text('{"name": "test"}')

        commands = manager.get_test_commands("test-spec-node")

        assert any("npm" in cmd for cmd in commands)


class TestWorktreeCleanup:
    """Tests for worktree cleanup and age detection functionality."""

    def test_get_worktree_stats_includes_age(self, temp_git_repo: Path):
        """Worktree stats include last commit date and age in days."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        # Make a commit in the worktree
        test_file = info.path / "test.txt"
        test_file.write_text("test")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "test commit"], cwd=info.path, capture_output=True
        )

        # Get stats
        stats = manager._get_worktree_stats("test-spec")

        assert stats["last_commit_date"] is not None
        assert isinstance(stats["last_commit_date"], datetime)
        assert stats["days_since_last_commit"] is not None
        assert stats["days_since_last_commit"] == 0  # Just committed

    def test_get_old_worktrees(self, temp_git_repo: Path):
        """get_old_worktrees identifies worktrees based on age threshold."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with a commit
        info = manager.create_worktree("test-spec")
        test_file = info.path / "test.txt"
        test_file.write_text("test")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "test commit"], cwd=info.path, capture_output=True
        )

        # Should not be considered old with default threshold (30 days)
        old_worktrees = manager.get_old_worktrees(days_threshold=30)
        assert len(old_worktrees) == 0

        # Should be considered old with 0 day threshold
        old_worktrees = manager.get_old_worktrees(days_threshold=0)
        assert len(old_worktrees) == 1
        assert "test-spec" in old_worktrees

    def test_get_old_worktrees_with_stats(self, temp_git_repo: Path):
        """get_old_worktrees returns full WorktreeInfo when include_stats=True."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with a commit
        info = manager.create_worktree("test-spec")
        test_file = info.path / "test.txt"
        test_file.write_text("test")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "test commit"], cwd=info.path, capture_output=True
        )

        # Get old worktrees with stats
        old_worktrees = manager.get_old_worktrees(days_threshold=0, include_stats=True)

        assert len(old_worktrees) == 1
        assert old_worktrees[0].spec_name == "test-spec"
        assert old_worktrees[0].days_since_last_commit is not None

    def test_cleanup_old_worktrees_dry_run(self, temp_git_repo: Path):
        """cleanup_old_worktrees dry run does not remove worktrees."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with a commit
        info = manager.create_worktree("test-spec")
        test_file = info.path / "test.txt"
        test_file.write_text("test")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "test commit"], cwd=info.path, capture_output=True
        )

        # Dry run should not remove anything
        removed, failed = manager.cleanup_old_worktrees(days_threshold=0, dry_run=True)

        assert len(removed) == 0
        assert len(failed) == 0
        assert info.path.exists()  # Worktree still exists

    def test_cleanup_old_worktrees_removes_old(self, temp_git_repo: Path):
        """cleanup_old_worktrees removes worktrees older than threshold."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with a commit
        info = manager.create_worktree("test-spec")
        test_file = info.path / "test.txt"
        test_file.write_text("test")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "test commit"], cwd=info.path, capture_output=True
        )

        # Actually remove with 0 day threshold
        removed, failed = manager.cleanup_old_worktrees(days_threshold=0, dry_run=False)

        assert len(removed) == 1
        assert "test-spec" in removed
        assert len(failed) == 0
        assert not info.path.exists()  # Worktree should be removed

    def test_get_worktree_count_warning(self, temp_git_repo: Path):
        """get_worktree_count_warning returns appropriate warnings based on count."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # No warning with few worktrees
        warning = manager.get_worktree_count_warning(warning_threshold=3)
        assert warning is None

        # The warning only depends on the worktree COUNT (list_all_worktrees),
        # so use a low threshold instead of creating 11 real worktrees: each
        # create_worktree spawns several git processes, and spawning dozens in
        # a tight loop intermittently fails on Windows CI (0xC0000142).
        for i in range(3):
            manager.create_worktree(f"test-spec-{i}")

        warning = manager.get_worktree_count_warning(warning_threshold=3)
        assert warning is not None
        assert "WARNING" in warning

    def test_get_worktree_count_critical_warning(self, temp_git_repo: Path):
        """get_worktree_count_warning returns critical warning for high counts."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Same as the warning test: only the count matters, so keep the number
        # of real worktrees (and git process spawns) low for Windows CI.
        for i in range(4):
            manager.create_worktree(f"test-spec-{i}")

        warning = manager.get_worktree_count_warning(
            warning_threshold=3, critical_threshold=4
        )
        assert warning is not None
        assert "CRITICAL" in warning


class TestEmptyPRGuard:
    """Garde-fou : pas de PR vide depuis push_and_create_pr."""

    def test_count_commits_ahead_returns_zero_for_fresh_branch(
        self, temp_git_repo: Path
    ):
        """Une branche fraîche (créée depuis main, sans nouveau commit) doit
        rapporter 0 commit en avance."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("empty-spec")

        ahead = manager._count_commits_ahead("empty-spec", manager.base_branch)

        assert ahead == 0

    def test_count_commits_ahead_after_commit(self, temp_git_repo: Path):
        """Après un commit dans le worktree, le compteur doit refléter
        l'avance par rapport à la base."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("work-spec")

        (info.path / "feature.txt").write_text("nouveau contenu\n")
        assert manager.commit_in_worktree("work-spec", "feat: ajout feature")

        ahead = manager._count_commits_ahead("work-spec", manager.base_branch)

        assert ahead == 1

    def test_count_commits_ahead_unknown_target_returns_none(self, temp_git_repo: Path):
        """Une cible inconnue (ni locale ni distante) renvoie None pour
        permettre au caller de décider quoi faire."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("spec")

        assert manager._count_commits_ahead("spec", "branche-inexistante") is None

    def test_push_and_create_pr_refuses_empty_branch(
        self, temp_git_repo: Path, monkeypatch
    ):
        """push_and_create_pr doit refuser une branche sans commit en
        avance pour éviter de créer une PR vide silencieusement."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("idle-spec")

        # Si push_branch était appelé, on aurait un network error : on ne le
        # mocke volontairement pas pour vérifier que le garde-fou court-circuite.
        push_called = {"value": False}

        def fake_push(*_args, **_kwargs):
            push_called["value"] = True
            return {"success": True, "branch": "x", "remote": "origin"}

        monkeypatch.setattr(manager, "push_branch", fake_push)

        result = manager.push_and_create_pr(
            "idle-spec",
            target_branch=manager.base_branch,
            title="ne devrait pas être créée",
        )

        assert result["success"] is False
        assert result["pushed"] is False
        assert "Aucun commit" in (result.get("error") or "")
        assert push_called["value"] is False


class TestApplyDiscardList:
    """Vérifie que la discard list est appliquée à la branche avant le push,
    afin d'éviter toute décorrélation entre l'aperçu filtré et la PR."""

    def _diff_files_against_base(
        self, manager: WorktreeManager, spec: str
    ) -> list[str]:
        worktree_path = manager.get_worktree_path(spec)
        result = manager._run_git(
            ["diff", "--name-only", f"{manager.base_branch}...HEAD"],
            cwd=worktree_path,
        )
        return [line for line in result.stdout.strip().split("\n") if line]

    def test_no_discard_list_is_noop(self, temp_git_repo: Path):
        """Sans fichier .workpilot-discard-list, aucun fichier n'est reverté."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("no-discard-spec")

        (info.path / "feature.txt").write_text("contenu\n")
        assert manager.commit_in_worktree("no-discard-spec", "feat: feature")

        reverted = manager._apply_discard_list("no-discard-spec", manager.base_branch)

        assert reverted == []
        assert "feature.txt" in self._diff_files_against_base(
            manager, "no-discard-spec"
        )

    def test_discards_added_and_modified_files(self, temp_git_repo: Path):
        """Les fichiers ajoutés sont supprimés, les fichiers modifiés sont
        restaurés à la version de la base ; ceux hors discard list restent."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("discard-spec")

        # Fichier ajouté par la tâche (absent de la base)
        (info.path / "added.txt").write_text("ajout tâche\n")
        # Fichier existant modifié par la tâche
        (info.path / "README.md").write_text("# Modifié par la tâche\n")
        # Fichier conservé (hors discard list)
        (info.path / "keep.txt").write_text("à garder\n")
        assert manager.commit_in_worktree("discard-spec", "feat: trois fichiers")

        # L'utilisateur abandonne added.txt et README.md
        (info.path / ".workpilot-discard-list").write_text(
            "added.txt\nREADME.md\n", encoding="utf-8"
        )

        reverted = manager._apply_discard_list("discard-spec", manager.base_branch)

        assert set(reverted) == {"added.txt", "README.md"}

        diff_files = self._diff_files_against_base(manager, "discard-spec")
        # Les fichiers abandonnés ne doivent plus apparaître dans le diff
        assert "added.txt" not in diff_files
        assert "README.md" not in diff_files
        # Le fichier conservé reste dans le diff
        assert "keep.txt" in diff_files

        # added.txt est physiquement supprimé du worktree
        assert not (info.path / "added.txt").exists()
        # README.md est restauré au contenu de la base
        assert (info.path / "README.md").read_text() == "# Test repo\n"

    def test_discard_list_excludes_files_from_pr_branch(self, temp_git_repo: Path):
        """Le commit de revert généré exclut bien les fichiers de la branche
        poussée (aucune décorrélation avec le diff filtré)."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("corr-spec")

        (info.path / "secret.txt").write_text("ne pas pousser\n")
        (info.path / "wanted.txt").write_text("à pousser\n")
        assert manager.commit_in_worktree("corr-spec", "feat: deux fichiers")

        (info.path / ".workpilot-discard-list").write_text(
            "secret.txt\n", encoding="utf-8"
        )

        manager._apply_discard_list("corr-spec", manager.base_branch)

        diff_files = self._diff_files_against_base(manager, "corr-spec")
        assert "secret.txt" not in diff_files
        assert "wanted.txt" in diff_files
