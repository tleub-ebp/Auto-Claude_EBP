#!/usr/bin/env python3
"""
Smart Merge/Rebase Manager for WorkPilot worktrees.

Preserves local modifications during merge/rebase operations by:
1. Detecting critical files that should be merged intelligently
2. Backing up local state before merge/rebase
3. Merging changes while preserving local modifications
4. Restoring/merging files after the operation
"""

import os
import sys
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime
import difflib

__all__ = ["SmartMergeManager"]

class SmartMergeManager:
    def __init__(self, repo_path: str = "."):
        self.repo_path = Path(repo_path).resolve()
        self.workpilot_dir = self.repo_path / ".workpilot"
        self.backup_dir = self.repo_path / ".git" / "workpilot-backups"
        self.merge_state_file = self.repo_path / ".git" / "merge-state.json"

        # Critical files that should be merged, not overwritten
        self.critical_patterns = [
            ".workpilot/specs/**/*.json",
            ".workpilot/**/*.jsonl",
            ".workpilot/**/conversation.jsonl",
            ".workpilot/**/task_logs.json",
            ".workpilot/**/cost_data.json",
        ]

        self.backup_dir.mkdir(parents=True, exist_ok=True)

    def run_git_command(self, *args) -> Tuple[int, str, str]:
        """Execute git command and return exit code, stdout, stderr."""
        cmd = ["git", "-C", str(self.repo_path)] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode, result.stdout, result.stderr

    def get_git_status(self) -> Dict:
        """Get current git status."""
        code, stdout, stderr = self.run_git_command("status", "--porcelain")
        if code != 0:
            return {"error": stderr}

        modified = []
        untracked = []

        for line in stdout.strip().split("\n"):
            if not line:
                continue
            status, path = line[:2], line[3:]
            if status == " M" or status == "M ":
                modified.append(path)
            elif status == "??":
                untracked.append(path)

        return {"modified": modified, "untracked": untracked}

    def backup_workpilot(self, label: str = "") -> str:
        """Backup .workpilot directory with timestamp."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"backup_{timestamp}" + (f"_{label}" if label else "")
        backup_path = self.backup_dir / backup_name

        if self.workpilot_dir.exists():
            shutil.copytree(self.workpilot_dir, backup_path, dirs_exist_ok=True)

        return str(backup_path)

    def get_merge_base(self, branch1: str, branch2: str) -> Optional[str]:
        """Get common ancestor of two branches."""
        code, stdout, stderr = self.run_git_command("merge-base", branch1, branch2)
        if code == 0:
            return stdout.strip()
        return None

    def merge_json_files(self, base_file: Path, local_file: Path, remote_file: Path) -> Dict:
        """Intelligently merge JSON files."""
        try:
            base_data = json.loads(base_file.read_text()) if base_file.exists() else {}
            local_data = json.loads(local_file.read_text()) if local_file.exists() else {}
            remote_data = json.loads(remote_file.read_text()) if remote_file.exists() else {}
        except json.JSONDecodeError as e:
            return {"error": f"JSON decode error: {e}", "strategy": "keep_local"}

        # For arrays (like conversation.jsonl, task_logs), merge by appending
        if isinstance(local_data, list) and isinstance(remote_data, list):
            # Deduplicate based on ID or content hash
            merged = list(local_data)
            for item in remote_data:
                if item not in merged:
                    merged.append(item)
            return {"merged": merged, "strategy": "merge_arrays"}

        # For objects, deep merge with local taking precedence
        if isinstance(local_data, dict) and isinstance(remote_data, dict):
            merged = dict(remote_data)
            merged.update(local_data)
            return {"merged": merged, "strategy": "deep_merge"}

        # Default: keep local
        return {"merged": local_data, "strategy": "keep_local"}

    def merge_jsonl_files(self, base_file: Path, local_file: Path, remote_file: Path) -> Tuple[List, str]:
        """Merge JSONL files (line-delimited JSON) by deduplicating entries."""
        try:
            base_lines = set()
            if base_file.exists():
                for line in base_file.read_text().strip().split("\n"):
                    if line.strip():
                        base_lines.add(line.strip())

            local_lines = {}
            if local_file.exists():
                for line in local_file.read_text().strip().split("\n"):
                    if line.strip():
                        try:
                            data = json.loads(line)
                            # Use ID or hash as key
                            key = data.get("id", hash(line))
                            local_lines[key] = line
                        except json.JSONDecodeError:
                            local_lines[hash(line)] = line

            remote_lines = {}
            if remote_file.exists():
                for line in remote_file.read_text().strip().split("\n"):
                    if line.strip():
                        try:
                            data = json.loads(line)
                            key = data.get("id", hash(line))
                            remote_lines[key] = line
                        except json.JSONDecodeError:
                            remote_lines[hash(line)] = line

            # Merge: remote first, then overlay local (local takes precedence)
            merged_dict = dict(remote_lines)
            merged_dict.update(local_lines)

            merged_content = "\n".join(merged_dict.values())
            return merged_content.split("\n"), "merge_jsonl_dedup"

        except Exception as e:
            return [], f"error: {e}"

    def prepare_merge(self, target_branch: str) -> Dict:
        """Prepare for merge/rebase operation."""
        print(f"[Smart Merge] Preparing merge from {target_branch}...")

        # Check current status
        status = self.get_git_status()
        if status.get("error"):
            return {"error": "Failed to get git status", "details": status["error"]}

        modified = status.get("modified", [])
        untracked = status.get("untracked", [])

        # Backup .workpilot
        backup_path = self.backup_workpilot(f"pre-merge_{target_branch}")
        print(f"✓ Backed up .workpilot to {backup_path}")

        # Save merge state
        merge_state = {
            "timestamp": datetime.now().isoformat(),
            "operation": "merge",
            "target_branch": target_branch,
            "backup_path": backup_path,
            "modified_files": modified,
            "untracked_files": untracked,
            "workpilot_files": [],
        }

        # Identify .workpilot files
        if self.workpilot_dir.exists():
            for pattern in self.critical_patterns:
                # Simple glob pattern handling
                for file in self.workpilot_dir.rglob("*"):
                    if file.is_file():
                        merge_state["workpilot_files"].append(str(file.relative_to(self.repo_path)))

        self.merge_state_file.write_text(json.dumps(merge_state, indent=2))
        return merge_state

    def complete_merge(self, source_branch: Optional[str] = None) -> Dict:
        """Complete merge/rebase operation and restore/merge files."""
        if not self.merge_state_file.exists():
            print("[Smart Merge] No merge state found, skipping completion.")
            return {"info": "No merge state to restore"}

        merge_state = json.loads(self.merge_state_file.read_text())
        backup_path = Path(merge_state["backup_path"])

        print("[Smart Merge] Completing merge/rebase...")

        # Get current branch for comparison
        code, current_branch, _ = self.run_git_command("rev-parse", "--abbrev-ref", "HEAD")
        current_branch = current_branch.strip()

        merged_files = {}
        conflicts = []

        # Merge critical files from backup with current state
        if backup_path.exists():
            for backup_file in backup_path.rglob("*"):
                if not backup_file.is_file():
                    continue

                rel_path = backup_file.relative_to(backup_path)
                current_file = self.workpilot_dir / rel_path
                repo_file = self.repo_path / ".workpilot" / rel_path

                # For JSON files, do intelligent merge
                if backup_file.suffix == ".json":
                    # Get base version (would be in backup's parent if available)
                    base_file = None  # TODO: Could fetch base from git

                    merge_result = self.merge_json_files(
                        base_file or backup_file,
                        backup_file,
                        current_file if current_file.exists() else backup_file
                    )

                    if "merged" in merge_result:
                        merged_files[str(rel_path)] = merge_result["strategy"]
                        # Write merged content
                        current_file.parent.mkdir(parents=True, exist_ok=True)
                        current_file.write_text(json.dumps(merge_result["merged"], indent=2))

                # For JSONL files, deduplicate
                elif backup_file.suffix == ".jsonl" or "conversation" in backup_file.name:
                    merged_lines, strategy = self.merge_jsonl_files(
                        backup_file,
                        backup_file,
                        current_file if current_file.exists() else backup_file
                    )

                    if strategy.startswith("error"):
                        conflicts.append({"file": str(rel_path), "reason": strategy})
                    else:
                        merged_files[str(rel_path)] = strategy
                        current_file.parent.mkdir(parents=True, exist_ok=True)
                        current_file.write_text("\n".join(merged_lines))

                # For other files, keep current (newer)
                else:
                    if not current_file.exists() and backup_file.exists():
                        current_file.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(backup_file, current_file)
                        merged_files[str(rel_path)] = "restored"

        print(f"✓ Merged {len(merged_files)} files")
        if conflicts:
            print(f"⚠ {len(conflicts)} conflicts (kept local versions)")

        # Clear merge state
        self.merge_state_file.unlink(missing_ok=True)

        return {
            "success": True,
            "current_branch": current_branch,
            "merged_files": merged_files,
            "conflicts": conflicts,
        }

    def show_backup_list(self) -> List[Dict]:
        """List available backups."""
        backups = []
        if self.backup_dir.exists():
            for backup in sorted(self.backup_dir.iterdir(), reverse=True)[:10]:
                if backup.is_dir():
                    backups.append({
                        "name": backup.name,
                        "path": str(backup),
                        "size_mb": sum(f.stat().st_size for f in backup.rglob("*") if f.is_file()) / (1024 * 1024),
                    })
        return backups

    def restore_from_backup(self, backup_name: str) -> Dict:
        """Restore .workpilot from a specific backup."""
        backup_path = self.backup_dir / backup_name
        if not backup_path.exists():
            return {"error": f"Backup not found: {backup_name}"}

        # Remove current .workpilot
        if self.workpilot_dir.exists():
            shutil.rmtree(self.workpilot_dir)

        # Restore from backup
        shutil.copytree(backup_path, self.workpilot_dir)
        return {"success": True, "restored_from": backup_name}


def main():
    if len(sys.argv) < 2:
        print("Usage: smart-merge-manager.py <command> [args]")
        print("\nCommands:")
        print("  prepare <branch>      - Prepare for merge/rebase")
        print("  complete             - Complete merge/rebase operation")
        print("  list-backups         - Show available backups")
        print("  restore <backup>     - Restore from backup")
        sys.exit(1)

    manager = SmartMergeManager()
    command = sys.argv[1]

    if command == "prepare":
        if len(sys.argv) < 3:
            print("Usage: smart-merge-manager.py prepare <target_branch>")
            sys.exit(1)
        result = manager.prepare_merge(sys.argv[2])
    elif command == "complete":
        result = manager.complete_merge()
    elif command == "list-backups":
        result = {"backups": manager.show_backup_list()}
    elif command == "restore":
        if len(sys.argv) < 3:
            print("Usage: smart-merge-manager.py restore <backup_name>")
            sys.exit(1)
        result = manager.restore_from_backup(sys.argv[2])
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
