"""
Timeline Persistence Layer
===========================

Storage and persistence for file timelines.

This module handles:
- Saving/loading timelines to/from disk
- Managing the timeline index
- File path encoding for safe storage
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .timeline_models import FileTimeline

logger = logging.getLogger(__name__)

# Import debug utilities
try:
    from debug import debug
except ImportError:

    def debug(*args, **kwargs):
        pass


MODULE = "merge.timeline_persistence"


class TimelinePersistence:
    """
    Handles persistence of file timelines to disk.

    Timelines are stored as JSON files with an index for quick lookup.
    """

    def __init__(self, storage_path: Path):
        """
        Initialize the persistence layer.

        Args:
            storage_path: Directory for timeline storage (e.g., .workpilot/)
        """
        self.storage_path = Path(storage_path).resolve()
        self.timelines_dir = self.storage_path / "file-timelines"

        # Ensure storage directory exists
        self.timelines_dir.mkdir(parents=True, exist_ok=True)

    def load_all_timelines(self) -> dict[str, FileTimeline]:
        """
        Load all timelines from disk on startup.

        Returns:
            Dictionary mapping file_path to FileTimeline objects
        """
        from .timeline_models import FileTimeline

        timelines = {}
        index_path = self.timelines_dir / "index.json"

        if not index_path.exists():
            return timelines

        try:
            with open(index_path, encoding="utf-8") as f:
                index = json.load(f)

            for file_path in index.get("files", []):
                timeline_file = self._get_timeline_file_path(file_path)
                if timeline_file.exists():
                    with open(timeline_file, encoding="utf-8") as f:
                        data = json.load(f)
                    timelines[file_path] = FileTimeline.from_dict(data)

            debug(MODULE, f"Loaded {len(timelines)} timelines from storage")

        except Exception as e:
            logger.error(f"Failed to load timelines: {e}")

        return timelines

    def save_timeline(self, file_path: str, timeline: FileTimeline) -> None:
        """
        Save a single timeline to disk.

        Args:
            file_path: The file path (used as key)
            timeline: The FileTimeline object to save
        """
        try:
            # Save timeline file
            timeline_file = self._get_timeline_file_path(file_path)
            timeline_file.parent.mkdir(parents=True, exist_ok=True)

            with open(timeline_file, "w", encoding="utf-8") as f:
                json.dump(timeline.to_dict(), f, indent=2)

        except Exception as e:
            logger.error(f"Failed to persist timeline for {file_path}: {e}")

    def update_index(self, file_paths: list[str]) -> None:
        """
        Update the index file with all tracked files.

        Args:
            file_paths: List of all file paths being tracked
        """
        index_path = self.timelines_dir / "index.json"
        index = {
            "files": file_paths,
            "last_updated": datetime.now().isoformat(),
        }
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2)

    def _get_timeline_file_path(self, file_path: str) -> Path:
        """
        Get the storage path for a file's timeline.

        Encodes the file path to create a safe filename.

        Args:
            file_path: The original file path

        Returns:
            Path to the timeline JSON file
        """
        # Encode path: src/App.tsx -> src_App.tsx.json
        # Replace EVERY character Windows forbids in a filename (`<>:"/\|?*`,
        # control chars), not just slashes — git can hand us quoted/escaped paths
        # for names with spaces or non-ASCII (e.g. accented ".ebp" files), which
        # otherwise produce an invalid filename and an "[Errno 22] Invalid
        # argument" on save.
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", file_path)
        # Windows also rejects names ending in a space or dot.
        safe_name = safe_name.strip(" .") or "unnamed"
        # Cap length so deeply-nested paths don't blow past MAX_PATH; keep a hash
        # suffix so distinct long paths never collide.
        if len(safe_name) > 200:
            # Not a security hash — just a short collision-avoidance suffix for
            # the filename, so flag usedforsecurity=False (clears Bandit B324).
            digest = hashlib.sha1(
                file_path.encode("utf-8"), usedforsecurity=False
            ).hexdigest()[:12]
            safe_name = f"{safe_name[:150]}_{digest}"
        return self.timelines_dir / f"{safe_name}.json"
