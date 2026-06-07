#!/usr/bin/env python3
"""
WorkPilot Merge/Rebase Wrapper

Integrates Smart Merge Manager with WorkPilot's automated merge/rebase operations.
This script wraps git merge/rebase calls and ensures .workpilot files are preserved.

Usage:
    workpilot-merge-wrapper.py merge <branch> [--no-ff] [--squash]
    workpilot-merge-wrapper.py rebase <branch> [--interactive]
    workpilot-merge-wrapper.py pull <remote> [<branch>]
"""

import os
import sys
import subprocess
import json
from pathlib import Path
from datetime import datetime
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="[WorkPilot Merge] %(levelname)s: %(message)s"
)
logger = logging.getLogger(__name__)

class WorkPilotMergeWrapper:
    def __init__(self, repo_path: str = "."):
        self.repo_path = Path(repo_path).resolve()
        self.manager_script = self.repo_path / "scripts" / "smart-merge-manager.py"
        self.workpilot_dir = self.repo_path / ".workpilot"

    def run_command(self, *args) -> tuple:
        """Run a command and return (exit_code, stdout, stderr)."""
        try:
            result = subprocess.run(
                args,
                cwd=str(self.repo_path),
                capture_output=True,
                text=True,
                timeout=300
            )
            return result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            return 1, "", "Command timed out"
        except Exception as e:
            return 1, "", str(e)

    def get_target_branch(self, args: list) -> str:
        """Extract target branch from git args."""
        if len(args) > 1:
            return args[1]
        return "unknown"

    def prepare_merge(self, target_branch: str) -> bool:
        """Run pre-merge backup using Smart Merge Manager."""
        if not self.manager_script.exists():
            logger.warning(f"Smart Merge Manager not found at {self.manager_script}")
            return True  # Continue anyway

        logger.info(f"Backing up .workpilot before merge...")
        code, stdout, stderr = self.run_command(
            "python3",
            str(self.manager_script),
            "prepare",
            target_branch
        )

        if code != 0:
            logger.warning(f"Pre-merge backup failed: {stderr}")
            return True  # Continue anyway - don't block git operation

        logger.info("✓ .workpilot backed up")
        return True

    def complete_merge(self, operation_type: str) -> bool:
        """Run post-merge restoration using Smart Merge Manager."""
        if not self.manager_script.exists():
            return True  # Continue anyway

        logger.info(f"Restoring and merging .workpilot files...")
        code, stdout, stderr = self.run_command(
            "python3",
            str(self.manager_script),
            "complete"
        )

        if code != 0:
            logger.warning(f"Post-{operation_type} restoration had issues: {stderr}")
            return True  # Continue anyway

        logger.info("✓ .workpilot files restored and merged")
        return True

    def merge(self, args: list) -> int:
        """Wrap git merge with .workpilot preservation."""
        target_branch = self.get_target_branch(args)

        # Pre-merge
        if not self.prepare_merge(target_branch):
            return 1

        # Run git merge
        logger.info(f"Merging {target_branch}...")
        code, stdout, stderr = self.run_command("git", "merge", *args[1:])

        if code != 0:
            logger.error(f"Merge failed: {stderr}")
            return code

        logger.info("✓ Merge completed")

        # Post-merge
        self.complete_merge("merge")

        logger.info(f"✓ Smart merge completed successfully")
        return 0

    def rebase(self, args: list) -> int:
        """Wrap git rebase with .workpilot preservation."""
        target_branch = self.get_target_branch(args)

        # Pre-rebase
        if not self.prepare_merge(target_branch):
            return 1

        # Run git rebase
        logger.info(f"Rebasing on {target_branch}...")
        code, stdout, stderr = self.run_command("git", "rebase", *args[1:])

        if code != 0:
            logger.error(f"Rebase failed: {stderr}")
            logger.info("Resolve conflicts manually, then run: git rebase --continue")
            return code

        logger.info("✓ Rebase completed")

        # Post-rebase
        self.complete_merge("rebase")

        logger.info(f"✓ Smart rebase completed successfully")
        return 0

    def pull(self, args: list) -> int:
        """Wrap git pull with .workpilot preservation."""
        # git pull = git fetch + git merge
        target = args[1] if len(args) > 1 else "origin"
        branch = args[2] if len(args) > 2 else None

        logger.info(f"Pulling from {target}...")

        # Pre-merge
        target_branch = f"{target}/{branch}" if branch else target
        if not self.prepare_merge(target_branch):
            return 1

        # Run git pull
        code, stdout, stderr = self.run_command("git", "pull", *args[1:])

        if code != 0:
            logger.error(f"Pull failed: {stderr}")
            return code

        logger.info("✓ Pull completed")

        # Post-merge
        self.complete_merge("merge")

        logger.info(f"✓ Smart pull completed successfully")
        return 0

    def main(self, argv: list) -> int:
        """Main entry point."""
        if len(argv) < 2:
            print("Usage: workpilot-merge-wrapper.py <merge|rebase|pull> <branch> [options]")
            return 1

        operation = argv[0]
        args = argv[1:]

        try:
            if operation == "merge":
                return self.merge(args)
            elif operation == "rebase":
                return self.rebase(args)
            elif operation == "pull":
                return self.pull(args)
            else:
                logger.error(f"Unknown operation: {operation}")
                return 1
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
            return 1


def main():
    wrapper = WorkPilotMergeWrapper()
    exit_code = wrapper.main(sys.argv[1:])
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
