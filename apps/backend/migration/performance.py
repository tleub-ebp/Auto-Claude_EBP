"""
Performance optimizations for migration engine
Implements caching, parallel processing, and incremental migrations
"""

import asyncio
import hashlib
import json
import logging
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .models import TransformationResult

logger = logging.getLogger(__name__)


class MigrationCache:
    """Cache for transformation results to avoid redundant LLM calls."""

    def __init__(self, cache_dir: str):
        self.cache_dir = Path(cache_dir)
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            self.cache_dir = None
        self.memory_cache: dict[str, TransformationResult] = {}
        self.ttl_hours = 24  # Cache valid for 24 hours

    def _get_cache_key(self, content: str, source: str, target: str) -> str:
        """Generate cache key from content and migration type."""
        data = f"{content}:{source}:{target}"
        return hashlib.sha256(data.encode()).hexdigest()

    def get(
        self, content: str, source: str, target: str
    ) -> TransformationResult | None:
        """Get cached transformation result."""
        key = self._get_cache_key(content, source, target)

        # Check memory cache first
        if key in self.memory_cache:
            return self.memory_cache[key]

        # Check disk cache
        if self.cache_dir is None:
            return None
        cache_file = self.cache_dir / f"{key}.json"
        if cache_file.exists():
            # Check if cache is still valid
            file_time = datetime.fromtimestamp(cache_file.stat().st_mtime)
            if datetime.now() - file_time < timedelta(hours=self.ttl_hours):
                try:
                    with open(cache_file, encoding="utf-8") as f:
                        payload = json.load(f)
                    result = TransformationResult.from_dict(payload)
                    self.memory_cache[key] = result
                    return result
                except Exception:
                    # Cache corruption (truncated/invalid) — log and self-heal
                    # by removing the bad entry so the next set() rebuilds it.
                    logger.exception(
                        "Failed to load cache entry %s; removing", cache_file.name
                    )
                    try:
                        cache_file.unlink(missing_ok=True)
                    except OSError:
                        pass

        return None

    def set(
        self, content: str, source: str, target: str, result: TransformationResult
    ) -> None:
        """Cache transformation result."""
        key = self._get_cache_key(content, source, target)

        # Update memory cache
        self.memory_cache[key] = result

        # Update disk cache
        if self.cache_dir is None:
            return
        cache_file = self.cache_dir / f"{key}.json"
        # Atomic write: tmp file + os.replace, so a crash mid-write never
        # leaves a half-written cache entry visible to readers.
        tmp_file = cache_file.with_suffix(cache_file.suffix + ".tmp")
        try:
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(result.to_dict(), f)
            os.replace(tmp_file, cache_file)
        except Exception:
            logger.exception("Failed to cache transformation result")
            try:
                tmp_file.unlink(missing_ok=True)
            except OSError:
                pass

    def clear(self, older_than_hours: int | None = None) -> int:
        """Clear cache entries.

        Args:
            older_than_hours: If None, clear everything (including memory).
                If an int, clear entries whose mtime is older than that many
                hours.
        """
        cleared = 0
        if self.cache_dir is None:
            return cleared

        if older_than_hours is None:
            for cache_file in self.cache_dir.glob("*.json"):
                try:
                    cache_file.unlink()
                    cleared += 1
                except OSError:
                    logger.exception("Failed to remove cache entry %s", cache_file)
            self.memory_cache.clear()
            return cleared

        cutoff_time = datetime.now() - timedelta(hours=older_than_hours)
        for cache_file in self.cache_dir.glob("*.json"):
            try:
                file_time = datetime.fromtimestamp(cache_file.stat().st_mtime)
                if file_time < cutoff_time:
                    cache_file.unlink()
                    cleared += 1
            except OSError:
                logger.exception("Failed to remove cache entry %s", cache_file)

        return cleared

    def get_stats(self) -> dict[str, Any]:
        """Get cache statistics."""
        if self.cache_dir is None:
            return {
                "memory_entries": len(self.memory_cache),
                "disk_entries": 0,
                "total_size_mb": 0,
                "cache_dir": None,
            }
        disk_files = list(self.cache_dir.glob("*.json"))
        total_size = sum(f.stat().st_size for f in disk_files)

        return {
            "memory_entries": len(self.memory_cache),
            "disk_entries": len(disk_files),
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "cache_dir": str(self.cache_dir),
        }


class ParallelTransformer:
    """Parallel processing for transformations."""

    def __init__(self, max_workers: int = 4):
        self.max_workers = max_workers

    def transform_files_parallel(
        self,
        files: list[str],
        transform_func: callable,
    ) -> list[TransformationResult]:
        """Transform multiple files in parallel."""
        results = []

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all tasks
            future_to_file = {
                executor.submit(transform_func, file_path): file_path
                for file_path in files
            }

            # Collect results as they complete
            for future in as_completed(future_to_file):
                file_path = future_to_file[future]
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    print(f"Error transforming {file_path}: {e}")

        return results

    async def transform_files_async(
        self,
        files: list[str],
        transform_func: callable,
    ) -> list[TransformationResult]:
        """Transform multiple files asynchronously."""
        tasks = [transform_func(file_path) for file_path in files]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter out exceptions
        valid_results = [r for r in results if isinstance(r, TransformationResult)]
        return valid_results


class IncrementalMigration:
    """Support for incremental/partial migrations."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self.state_file = (
            self.project_dir / ".workpilot" / "migration" / "incremental_state.json"
        )
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            self.state_file = None
        self.state = self._load_state()

    def _load_state(self) -> dict[str, Any]:
        """Load incremental migration state."""
        if self.state_file is not None and self.state_file.exists():
            try:
                with open(self.state_file) as f:
                    return json.load(f)
            except Exception:
                logger.exception(
                    "Failed to load incremental migration state from %s; "
                    "falling back to empty state",
                    self.state_file,
                )

        return {
            "migrated_files": [],
            "pending_files": [],
            "failed_files": [],
            "last_updated": None,
        }

    def _save_state(self) -> None:
        """Save incremental migration state."""
        if self.state_file is None:
            return
        self.state["last_updated"] = datetime.now().isoformat()

        # Atomic write to avoid leaving a truncated state file on crash.
        tmp_file = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        try:
            with open(tmp_file, "w") as f:
                json.dump(self.state, f, indent=2)
            os.replace(tmp_file, self.state_file)
        except Exception:
            logger.exception("Failed to save incremental migration state")
            try:
                tmp_file.unlink(missing_ok=True)
            except OSError:
                pass

    def mark_migrated(self, file_path: str) -> None:
        """Mark a file as successfully migrated."""
        if file_path not in self.state["migrated_files"]:
            self.state["migrated_files"].append(file_path)

        if file_path in self.state["pending_files"]:
            self.state["pending_files"].remove(file_path)

        if file_path in self.state["failed_files"]:
            self.state["failed_files"].remove(file_path)

        self._save_state()

    def mark_pending(self, file_path: str) -> None:
        """Mark a file as pending migration."""
        if file_path not in self.state["pending_files"]:
            self.state["pending_files"].append(file_path)

        self._save_state()

    def mark_failed(self, file_path: str) -> None:
        """Mark a file as failed migration."""
        if file_path not in self.state["failed_files"]:
            self.state["failed_files"].append(file_path)

        if file_path in self.state["pending_files"]:
            self.state["pending_files"].remove(file_path)

        self._save_state()

    def get_pending_files(self) -> list[str]:
        """Get list of pending files."""
        return self.state["pending_files"].copy()

    def get_migrated_files(self) -> list[str]:
        """Get list of migrated files."""
        return self.state["migrated_files"].copy()

    def get_failed_files(self) -> list[str]:
        """Get list of failed files."""
        return self.state["failed_files"].copy()

    def is_migrated(self, file_path: str) -> bool:
        """Check if file is already migrated."""
        return file_path in self.state["migrated_files"]

    def get_progress(self) -> dict[str, Any]:
        """Get migration progress statistics."""
        total = (
            len(self.state["migrated_files"])
            + len(self.state["pending_files"])
            + len(self.state["failed_files"])
        )

        return {
            "migrated": len(self.state["migrated_files"]),
            "pending": len(self.state["pending_files"]),
            "failed": len(self.state["failed_files"]),
            "total": total,
            "progress_percent": round(
                len(self.state["migrated_files"]) / total * 100, 2
            )
            if total > 0
            else 0,
        }

    def reset(self) -> None:
        """Reset incremental state."""
        self.state = {
            "migrated_files": [],
            "pending_files": [],
            "failed_files": [],
            "last_updated": None,
        }
        self._save_state()


class TransformationBatcher:
    """Batch transformations for efficient processing."""

    def __init__(self, batch_size: int = 10):
        self.batch_size = batch_size

    def batch_files(self, files: list[str]) -> list[list[str]]:
        """Split files into batches."""
        batches = []
        for i in range(0, len(files), self.batch_size):
            batches.append(files[i : i + self.batch_size])
        return batches

    def process_batches(
        self,
        files: list[str],
        process_func: Callable,
        on_batch_complete: Callable | None = None,
    ) -> list[Any]:
        """Process files in batches."""
        batches = self.batch_files(files)
        all_results = []

        for i, batch in enumerate(batches):
            results = process_func(batch)
            all_results.extend(results)

            if on_batch_complete:
                on_batch_complete(i + 1, len(batches), len(all_results))

        return all_results


class ProgressTracker:
    """Track migration progress with detailed metrics."""

    def __init__(self):
        self.start_time: datetime | None = None
        self.end_time: datetime | None = None
        self.files_processed = 0
        self.files_total = 0
        self.current_file: str | None = None
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def start(self, total_files: int) -> None:
        """Start tracking."""
        self.start_time = datetime.now()
        self.files_total = total_files
        self.files_processed = 0

    def update(self, file_path: str) -> None:
        """Update progress."""
        self.current_file = file_path
        self.files_processed += 1

    def add_error(self, error: str) -> None:
        """Add error."""
        self.errors.append(error)

    def add_warning(self, warning: str) -> None:
        """Add warning."""
        self.warnings.append(warning)

    def finish(self) -> None:
        """Finish tracking."""
        self.end_time = datetime.now()

    def get_progress_percent(self) -> float:
        """Get progress percentage."""
        if self.files_total == 0:
            return 0.0
        return round(self.files_processed / self.files_total * 100, 2)

    def get_elapsed_time(self) -> float | None:
        """Get elapsed time in seconds."""
        if not self.start_time:
            return None

        end = self.end_time or datetime.now()
        return (end - self.start_time).total_seconds()

    def get_eta(self) -> float | None:
        """Estimate time remaining in seconds."""
        elapsed = self.get_elapsed_time()
        if not elapsed or self.files_processed == 0:
            return None

        avg_time_per_file = elapsed / self.files_processed
        remaining_files = self.files_total - self.files_processed
        return avg_time_per_file * remaining_files

    def get_summary(self) -> dict[str, Any]:
        """Get progress summary."""
        return {
            "files_processed": self.files_processed,
            "files_total": self.files_total,
            "progress_percent": self.get_progress_percent(),
            "elapsed_seconds": self.get_elapsed_time(),
            "eta_seconds": self.get_eta(),
            "current_file": self.current_file,
            "errors_count": len(self.errors),
            "warnings_count": len(self.warnings),
        }
