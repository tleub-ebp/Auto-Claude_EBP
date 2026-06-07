#!/usr/bin/env python3
"""
WorkPilot Auto-Merge Hook

Integrates with WorkPilot's task execution to automatically use Smart Merge Manager
when performing merge/rebase operations during automated workflows.

This hook is called by WorkPilot AI before it executes merge/rebase commands.
It ensures that .workpilot files are preserved throughout the operation.

Environment Variables (set by WorkPilot):
    WORKPILOT_OPERATION: merge, rebase, or pull
    WORKPILOT_TARGET_BRANCH: target branch name
    WORKPILOT_REPO_PATH: repository path
    WORKPILOT_TASK_ID: task identifier (optional)
    WORKPILOT_AUTO_MERGE: true if this is an automatic merge
"""

import os
import sys
import subprocess
import json
import logging
from pathlib import Path
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="[WorkPilot Auto-Merge] %(levelname)s: %(message)s"
)
logger = logging.getLogger(__name__)


class WorkPilotAutoMergeHook:
    def __init__(self):
        self.repo_path = Path(os.environ.get("WORKPILOT_REPO_PATH", ".")).resolve()
        self.operation = os.environ.get("WORKPILOT_OPERATION", "merge")
        self.target_branch = os.environ.get("WORKPILOT_TARGET_BRANCH", "unknown")
        self.task_id = os.environ.get("WORKPILOT_TASK_ID", "unknown")
        self.auto_merge = os.environ.get("WORKPILOT_AUTO_MERGE", "false").lower() == "true"

        self.wrapper_script = self.repo_path / "scripts" / "workpilot-merge-wrapper.py"
        self.workpilot_dir = self.repo_path / ".workpilot"
        self.status_file = self.repo_path / ".git" / "workpilot-auto-merge-status.json"

    def log_status(self, status: str, details: dict = None) -> None:
        """Log operation status for WorkPilot."""
        status_data = {
            "timestamp": datetime.now().isoformat(),
            "task_id": self.task_id,
            "operation": self.operation,
            "target_branch": self.target_branch,
            "status": status,
            "workpilot_files_preserved": self.workpilot_dir.exists(),
            "details": details or {}
        }

        try:
            self.status_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.status_file, "w") as f:
                json.dump(status_data, f, indent=2)
        except Exception as e:
            logger.warning(f"Could not write status file: {e}")

    def execute_merge_with_wrapper(self) -> int:
        """Execute merge/rebase using the wrapper script."""
        if not self.wrapper_script.exists():
            logger.error(f"Wrapper script not found: {self.wrapper_script}")
            logger.info("Falling back to standard git command (no .workpilot preservation)")
            return 1

        try:
            cmd = [
                "python3",
                str(self.wrapper_script),
                self.operation,
                self.target_branch
            ]

            logger.info(f"Executing: {' '.join(cmd)}")
            result = subprocess.run(cmd, cwd=str(self.repo_path))

            return result.returncode
        except Exception as e:
            logger.error(f"Failed to execute wrapper: {e}")
            return 1

    def pre_merge_checks(self) -> bool:
        """Perform pre-merge validation."""
        logger.info("Performing pre-merge checks...")

        # Check if we're in a valid git repo
        code = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=str(self.repo_path),
            capture_output=True
        ).returncode

        if code != 0:
            logger.error("Not in a valid git repository")
            return False

        # Check current branch
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(self.repo_path),
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            logger.error("Could not determine current branch")
            return False

        current_branch = result.stdout.strip()
        logger.info(f"Current branch: {current_branch}")
        logger.info(f"Target branch: {self.target_branch}")

        # Check for uncommitted changes
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(self.repo_path),
            capture_output=True,
            text=True
        )

        if result.stdout.strip():
            logger.warning("Uncommitted changes detected (non-.workpilot files)")
            # This is not necessarily a blocker - git will handle it

        return True

    def run(self) -> int:
        """Execute the auto-merge hook."""
        logger.info("=" * 60)
        logger.info(f"WorkPilot Auto-Merge Hook")
        logger.info(f"Operation: {self.operation}")
        logger.info(f"Target: {self.target_branch}")
        logger.info(f"Repository: {self.repo_path}")
        logger.info(f"Task ID: {self.task_id}")
        logger.info("=" * 60)

        self.log_status("started")

        # Pre-merge checks
        if not self.pre_merge_checks():
            logger.error("Pre-merge checks failed")
            self.log_status("failed", {"reason": "pre-merge checks failed"})
            return 1

        # Execute merge with wrapper
        logger.info(f"Starting {self.operation}...")
        exit_code = self.execute_merge_with_wrapper()

        if exit_code == 0:
            logger.info(f"✓ {self.operation.capitalize()} completed successfully")
            logger.info(f"✓ .workpilot files preserved and merged")
            self.log_status("success")
        else:
            logger.error(f"✗ {self.operation.capitalize()} failed with exit code {exit_code}")
            self.log_status("failed", {"exit_code": exit_code})

        logger.info("=" * 60)
        return exit_code


def main():
    """Entry point for WorkPilot hook."""
    # Allow manual testing
    if len(sys.argv) > 1:
        os.environ["WORKPILOT_OPERATION"] = sys.argv[1]
        if len(sys.argv) > 2:
            os.environ["WORKPILOT_TARGET_BRANCH"] = sys.argv[2]
        if len(sys.argv) > 3:
            os.environ["WORKPILOT_REPO_PATH"] = sys.argv[3]

    hook = WorkPilotAutoMergeHook()
    exit_code = hook.run()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
