#!/usr/bin/env python3
"""
Learning Loop Runner

Analyzes completed builds to extract success/failure patterns that
optimize future agent behavior. Can be triggered from the frontend UI
or run standalone from CLI.

Stdout protocol: LEARNING_LOOP_EVENT:{json}
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))


def emit_event(event_type: str, data: Any = None, message: str = "") -> None:
    """Emit a structured event to stdout for frontend consumption."""
    event = {"type": event_type}
    if data is not None:
        event["data"] = data
    if message:
        event["message"] = message
    print(
        f"LEARNING_LOOP_EVENT:{json.dumps(event, default=str, ensure_ascii=False)}",
        flush=True,
    )


def emit_status(message: str, progress: int = 0) -> None:
    """Emit a status update."""
    emit_event("status", message=message, data={"progress": progress})


def emit_stream_chunk(chunk: str) -> None:
    """Emit a streaming output chunk."""
    emit_event("stream_chunk", data=chunk)


async def record_outcome(
    project_dir: str,
    spec_id: str,
    verdict: str,
    details: str = "",
) -> Path | None:
    """
    Record a task outcome (human verdict or CI failure) for the learning loop.

    Writes task_outcome.json into the spec directory (read by the pattern
    extractor) and, when Graphiti memory is enabled, stores a task_outcome
    episode so future tasks can retrieve similar outcomes.

    Returns the spec directory, or None if it does not exist.
    """
    from datetime import datetime, timezone

    spec_dir = Path(project_dir) / ".workpilot" / "specs" / spec_id
    if not spec_dir.exists():
        emit_event("error", message=f"Spec directory not found: {spec_id}")
        return None

    outcome = {
        "verdict": verdict,
        "details": details[:2000],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # Keep a short history of outcomes (a task can fail CI several times
    # before being approved); the latest verdict is also exposed at top level.
    outcome_file = spec_dir / "task_outcome.json"
    history = []
    if outcome_file.exists():
        try:
            previous = json.loads(outcome_file.read_text(encoding="utf-8"))
            history = previous.get("history", [])
        except (json.JSONDecodeError, OSError):
            pass
    history.append(outcome)
    outcome_file.write_text(
        json.dumps(
            {**outcome, "history": history[-10:]},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    emit_status(f"Recorded outcome '{verdict}' for {spec_id}")

    # Best-effort: also store in Graphiti so get_similar_task_outcomes works
    try:
        from memory.graphiti_helpers import get_graphiti_memory

        memory = await get_graphiti_memory(spec_dir, Path(project_dir))
        if memory is not None:
            try:
                await memory.save_task_outcome(
                    task_id=spec_id,
                    success=verdict == "approved",
                    outcome=f"{verdict}: {details[:500]}" if details else verdict,
                )
            finally:
                await memory.close()
    except Exception as e:
        emit_status(f"Graphiti outcome save skipped: {e}")

    return spec_dir


async def run_analysis(
    project_dir: str,
    spec_id: str | None = None,
    model: str = "sonnet",
    thinking_level: str = "medium",
) -> None:
    """Run learning loop analysis."""
    from learning_loop.service import LearningLoopService

    service = LearningLoopService(
        project_dir=Path(project_dir),
        model=model,
        thinking_level=thinking_level,
    )

    def status_callback(message: str) -> None:
        emit_status(message)
        emit_stream_chunk(f"[Status] {message}\n")

    try:
        if spec_id:
            # Single-build analysis
            spec_dir = Path(project_dir) / ".workpilot" / "specs" / spec_id
            if not spec_dir.exists():
                emit_event("error", message=f"Spec directory not found: {spec_id}")
                return

            emit_status(f"Analyzing build {spec_id}...", progress=10)
            report = await service.run_post_build_analysis(
                spec_dir=spec_dir,
                status_callback=status_callback,
            )
        else:
            # Full project analysis
            emit_status("Running full project analysis...", progress=10)
            report = await service.run_full_analysis(
                limit=20,
                status_callback=status_callback,
            )

        # Emit results
        emit_status("Analysis complete", progress=100)
        summary = service.get_summary()
        patterns = service.get_patterns()

        emit_event(
            "complete",
            data={
                "report": report.to_dict(),
                "summary": summary,
                "patterns": patterns,
            },
        )

    except Exception as e:
        emit_event("error", message=str(e))
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Learning Loop Runner")
    parser.add_argument(
        "--project-dir", required=True, help="Path to the project directory"
    )
    parser.add_argument("--spec-id", help="Analyze a specific build (spec ID)")
    parser.add_argument("--model", default="sonnet", help="LLM model to use")
    parser.add_argument("--thinking-level", default="medium", help="Thinking level")
    parser.add_argument(
        "--record-outcome",
        choices=["approved", "rejected", "build_failed"],
        help=(
            "Record a task outcome (human verdict or CI failure) for the spec "
            "given by --spec-id, then run single-build analysis on it"
        ),
    )
    parser.add_argument(
        "--outcome-details",
        default="",
        help="Optional free-text details about the outcome (review notes, CI error)",
    )
    args = parser.parse_args()

    if args.record_outcome and not args.spec_id:
        parser.error("--record-outcome requires --spec-id")

    async def run() -> None:
        if args.record_outcome:
            spec_dir = await record_outcome(
                project_dir=args.project_dir,
                spec_id=args.spec_id,
                verdict=args.record_outcome,
                details=args.outcome_details,
            )
            if spec_dir is None:
                sys.exit(1)
        await run_analysis(
            project_dir=args.project_dir,
            spec_id=args.spec_id,
            model=args.model,
            thinking_level=args.thinking_level,
        )

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        emit_event("error", message="Analysis cancelled by user")
        sys.exit(1)
    except Exception as e:
        emit_event("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
