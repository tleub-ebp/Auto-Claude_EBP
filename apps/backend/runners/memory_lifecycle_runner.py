#!/usr/bin/env python3
"""
Memory Lifecycle Runner (Feature 43)

Manages Graphiti memory lifecycle: pruning, retention policy enforcement,
freshness scoring, and export. Called by the Electron frontend via IPC.

Usage:
    python memory_lifecycle_runner.py --action prune --project /path/to/project [options]
    python memory_lifecycle_runner.py --action status --project /path/to/project
    python memory_lifecycle_runner.py --action export --output /path/to/export.json
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


def load_env(project_dir: str) -> dict:
    """Load .env file from project directory."""
    env = {}
    env_path = Path(project_dir) / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            key = line[:eq].strip()
            val = line[eq + 1 :].strip().strip("\"'")
            env[key] = val
    return env


def get_memory_dir(project_dir: str) -> Path:
    return Path(project_dir) / ".workpilot" / "memory"


def action_status(project_dir: str) -> dict:
    """Return memory stats without using Graphiti (file-based fallback)."""
    memory_dir = get_memory_dir(project_dir)
    env = load_env(project_dir)

    episode_count = 0
    disk_bytes = 0
    oldest_ts = None
    newest_ts = None

    if memory_dir.exists():
        for f in memory_dir.glob("*.json"):
            episode_count += 1
            disk_bytes += f.stat().st_size
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                ts = data.get("created_at") or data.get("timestamp")
                if ts:
                    if oldest_ts is None or ts < oldest_ts:
                        oldest_ts = ts
                    if newest_ts is None or ts > newest_ts:
                        newest_ts = ts
            except Exception:
                pass

    return {
        "episode_count": episode_count,
        "disk_usage_bytes": disk_bytes,
        "oldest_episode": oldest_ts,
        "newest_episode": newest_ts,
        "graphiti_enabled": env.get("GRAPHITI_ENABLED", "false").lower() == "true",
        "retention_days": int(env.get("MEMORY_RETENTION_DAYS", "90")),
        "max_episodes": int(env.get("MEMORY_MAX_EPISODES", "10000")),
        "prune_strategy": env.get("MEMORY_PRUNE_STRATEGY", "lru"),
        "auto_prune": env.get("MEMORY_AUTO_PRUNE", "false").lower() == "true",
    }


def action_prune(
    project_dir: str,
    strategy: str = "lru",
    max_age_days: int | None = None,
    max_count: int | None = None,
    dry_run: bool = False,
) -> dict:
    """Prune memory episodes according to strategy."""
    memory_dir = get_memory_dir(project_dir)
    env = load_env(project_dir)

    if not memory_dir.exists():
        return {"pruned": 0, "remaining": 0, "dry_run": dry_run}

    # Try Graphiti-aware pruning first
    graphiti_enabled = env.get("GRAPHITI_ENABLED", "false").lower() == "true"
    if graphiti_enabled:
        try:
            return _prune_graphiti(
                project_dir, strategy, max_age_days, max_count, dry_run, env
            )
        except Exception as e:
            print(
                f"[MemoryLifecycle] Graphiti prune failed, falling back to file-based: {e}",
                file=sys.stderr,
            )

    # File-based pruning fallback
    files = sorted(memory_dir.glob("*.json"), key=lambda f: f.stat().st_mtime)
    to_delete = []

    if strategy == "oldest" or strategy == "lru":
        if max_age_days is not None:
            cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
                days=max_age_days
            )
            for f in files:
                mtime = datetime.utcfromtimestamp(f.stat().st_mtime)
                if mtime < cutoff:
                    to_delete.append(f)
        if max_count is not None and (len(files) - len(to_delete)) > max_count:
            remaining = [f for f in files if f not in to_delete]
            excess = len(remaining) - max_count
            to_delete.extend(remaining[:excess])

    elif strategy == "duplicates":
        seen_hashes: dict = {}
        for f in files:
            try:
                content = f.read_text(encoding="utf-8")
                h = hash(content)
                if h in seen_hashes:
                    to_delete.append(f)
                else:
                    seen_hashes[h] = f
            except Exception:
                pass

    pruned = 0
    if not dry_run:
        for f in to_delete:
            try:
                f.unlink()
                pruned += 1
            except Exception:
                pass
    else:
        pruned = len(to_delete)

    remaining = len(list(memory_dir.glob("*.json"))) - (pruned if not dry_run else 0)
    return {
        "pruned": pruned,
        "remaining": remaining,
        "dry_run": dry_run,
        "strategy": strategy,
    }


def _prune_graphiti(
    project_dir: str,
    strategy: str,
    max_age_days: int | None,
    max_count: int | None,
    dry_run: bool,
    env: dict,
) -> dict:
    """Attempt to prune via Graphiti API."""
    sys.path.insert(0, str(Path(project_dir)))
    sys.path.insert(0, str(Path(__file__).parent.parent))

    # Import only if available
    try:
        from integrations.graphiti.client import (
            get_graphiti_client,  # type: ignore  # noqa: F401
        )
    except ImportError:
        raise RuntimeError("Graphiti client not available")

    # This would call the actual Graphiti prune endpoint
    # For now, fall back to file-based since the exact Graphiti prune API varies
    raise NotImplementedError(
        "Graphiti prune via API not yet implemented; use file-based fallback"
    )


def action_export(project_dir: str, output_path: str) -> dict:
    """Export all memory episodes to a JSON file."""
    memory_dir = get_memory_dir(project_dir)
    memories = []

    if memory_dir.exists():
        for f in sorted(memory_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                memories.append({"id": f.stem, **data})
            except Exception:
                memories.append({"id": f.stem, "error": "parse_error"})

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(memories, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"count": len(memories), "path": str(out)}


def main():
    parser = argparse.ArgumentParser(description="Memory Lifecycle Runner")
    parser.add_argument(
        "--action", choices=["status", "prune", "export"], required=True
    )
    parser.add_argument("--project", required=True, help="Project directory")
    parser.add_argument(
        "--strategy", default="lru", choices=["lru", "oldest", "duplicates"]
    )
    parser.add_argument("--max-age-days", type=int, default=None)
    parser.add_argument("--max-count", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", default=None, help="Export output path")
    parser.add_argument(
        "--output-json", action="store_true", help="Print result as JSON"
    )
    args = parser.parse_args()

    try:
        if args.action == "status":
            result = action_status(args.project)
        elif args.action == "prune":
            result = action_prune(
                args.project,
                strategy=args.strategy,
                max_age_days=args.max_age_days,
                max_count=args.max_count,
                dry_run=args.dry_run,
            )
        elif args.action == "export":
            output = args.output or str(
                Path(args.project)
                / ".workpilot"
                / f"memory_export_{int(time.time())}.json"
            )
            result = action_export(args.project, output)
        else:
            result = {"error": f"Unknown action: {args.action}"}

        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
