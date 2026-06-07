"""
Conflict Predictor Runner

Executes conflict prediction analysis using the ConflictPredictorService.
Provides streaming output and structured results for proactive conflict detection.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from services.conflict_predictor_service import get_conflict_predictor_service


class ConflictPredictorRunner:
    """
    Runner for conflict prediction analysis with streaming support.
    """

    def __init__(self):
        self.conflict_service = get_conflict_predictor_service()

    def run_conflict_analysis(self, project_path: str) -> dict[str, Any]:
        """
        Run conflict prediction analysis for a given project.

        Args:
            project_path: Path to the project directory

        Returns:
            Dictionary containing the conflict analysis result
        """
        try:
            # Emit start event
            self._emit_event(
                "start", {"status": "Analyzing project for potential conflicts..."}
            )

            if not project_path or not os.path.exists(project_path):
                raise ValueError(f"Project path not found: {project_path}")

            # Run the conflict analysis
            self._emit_event(
                "progress", {"status": "Scanning worktrees and branches..."}
            )
            result = self.conflict_service.analyze_project_conflicts(project_path)

            # Prepare structured result
            structured_result = {
                "total_worktrees": result.total_worktrees,
                "active_worktrees": result.active_worktrees,
                "conflicts_detected": [
                    {
                        "risk_level": conflict.risk_level,
                        "conflict_type": conflict.conflict_type,
                        "file_path": conflict.file_path,
                        "worktree1": conflict.worktree1,
                        "worktree2": conflict.worktree2,
                        "branch1": conflict.branch1,
                        "branch2": conflict.branch2,
                        "description": conflict.description,
                        "resolution_strategy": conflict.resolution_strategy,
                    }
                    for conflict in result.conflicts_detected
                ],
                "modified_files": [
                    {
                        "file_path": mod.file_path,
                        "modification_type": mod.modification_type,
                        "lines_added": mod.lines_added,
                        "lines_removed": mod.lines_removed,
                        "worktree_name": mod.worktree_name,
                        "branch_name": mod.branch_name,
                    }
                    for mod in result.modified_files
                ],
                "recommendations": result.recommendations,
                "safe_merge_order": result.safe_merge_order,
                "high_risk_areas": result.high_risk_areas,
            }

            # Add summary statistics
            critical_conflicts = len(
                [c for c in result.conflicts_detected if c.risk_level == "critical"]
            )
            high_conflicts = len(
                [c for c in result.conflicts_detected if c.risk_level == "high"]
            )
            medium_conflicts = len(
                [c for c in result.conflicts_detected if c.risk_level == "medium"]
            )

            structured_result["summary"] = {
                "critical_conflicts": critical_conflicts,
                "high_conflicts": high_conflicts,
                "medium_conflicts": medium_conflicts,
                "total_conflicts": len(result.conflicts_detected),
                "risk_assessment": self._get_risk_assessment(
                    critical_conflicts, high_conflicts, medium_conflicts
                ),
            }

            # Stream detailed analysis
            self._stream_analysis_details(structured_result)

            # Emit completion event
            self._emit_event("complete", structured_result)

            return structured_result

        except Exception as e:
            error_msg = f"Conflict prediction failed: {str(e)}"
            self._emit_event("error", {"error": error_msg})
            raise

    def _get_risk_assessment(self, critical: int, high: int, medium: int) -> str:
        """Get overall risk assessment based on conflict counts"""
        if critical > 0:
            return "CRITICAL - Immediate coordination required"
        elif high > 2:
            return "HIGH - Significant conflicts detected"
        elif high > 0 or medium > 3:
            return "MEDIUM - Some conflicts need attention"
        elif medium > 0:
            return "LOW - Minor conflicts, monitor closely"
        else:
            return "SAFE - No conflicts detected"

    def _stream_analysis_details(self, result: dict[str, Any]):
        """Stream detailed analysis information"""

        # Stream worktree information
        self._emit_event(
            "progress",
            {"status": f"Found {result['total_worktrees']} active worktrees/branches"},
        )

        if result["active_worktrees"]:
            worktree_list = ", ".join(result["active_worktrees"][:5])
            if len(result["active_worktrees"]) > 5:
                worktree_list += f" and {len(result['active_worktrees']) - 5} more"
            self._emit_event(
                "progress", {"status": f"Active worktrees: {worktree_list}"}
            )

        # Stream file modifications
        if result["modified_files"]:
            self._emit_event(
                "progress",
                {
                    "status": f"Analyzing {len(result['modified_files'])} modified files..."
                },
            )

            # Group by modification type
            added_files = [
                f for f in result["modified_files"] if f["modification_type"] == "added"
            ]
            modified_files = [
                f
                for f in result["modified_files"]
                if f["modification_type"] == "modified"
            ]
            deleted_files = [
                f
                for f in result["modified_files"]
                if f["modification_type"] == "deleted"
            ]

            if added_files:
                self._emit_event(
                    "progress", {"status": f"{len(added_files)} files added"}
                )
            if modified_files:
                self._emit_event(
                    "progress", {"status": f"{len(modified_files)} files modified"}
                )
            if deleted_files:
                self._emit_event(
                    "progress", {"status": f"{len(deleted_files)} files deleted"}
                )

        # Stream conflicts by risk level
        conflicts = result["conflicts_detected"]
        if conflicts:
            self._emit_event(
                "progress",
                {"status": f"Detected {len(conflicts)} potential conflicts..."},
            )

            # Stream critical conflicts first
            critical_conflicts = [c for c in conflicts if c["risk_level"] == "critical"]
            if critical_conflicts:
                self._emit_event(
                    "progress",
                    {
                        "status": f"🚨 {len(critical_conflicts)} CRITICAL conflicts found!"
                    },
                )
                for conflict in critical_conflicts:
                    self._emit_event(
                        "progress",
                        {
                            "status": f"  • {conflict['worktree1']} vs {conflict['worktree2']}: {conflict['file_path']}"
                        },
                    )

            # Stream high conflicts
            high_conflicts = [c for c in conflicts if c["risk_level"] == "high"]
            if high_conflicts:
                self._emit_event(
                    "progress",
                    {"status": f"⚠️ {len(high_conflicts)} HIGH risk conflicts"},
                )
                for conflict in high_conflicts[:3]:  # Show first 3
                    self._emit_event(
                        "progress",
                        {
                            "status": f"  • {conflict['worktree1']} vs {conflict['worktree2']}: {conflict['file_path']}"
                        },
                    )

            # Stream medium conflicts
            medium_conflicts = [c for c in conflicts if c["risk_level"] == "medium"]
            if medium_conflicts:
                self._emit_event(
                    "progress",
                    {"status": f"⚡ {len(medium_conflicts)} MEDIUM risk conflicts"},
                )
        else:
            self._emit_event(
                "progress",
                {"status": "✅ No conflicts detected - safe for parallel development"},
            )

        # Stream recommendations
        if result["recommendations"]:
            self._emit_event(
                "progress",
                {
                    "status": f"Generating {len(result['recommendations'])} recommendations..."
                },
            )

            for i, rec in enumerate(result["recommendations"][:3], 1):
                self._emit_event("progress", {"status": f"{i}. {rec}"})

        # Stream safe merge order
        if result["safe_merge_order"] and len(result["safe_merge_order"]) > 1:
            self._emit_event("progress", {"status": "Safe merge order suggested:"})
            for i, worktree in enumerate(result["safe_merge_order"], 1):
                self._emit_event("progress", {"status": f"  {i}. {worktree}"})

        # Stream high risk areas
        if result["high_risk_areas"]:
            self._emit_event(
                "progress",
                {
                    "status": f"High risk areas to monitor: {', '.join(result['high_risk_areas'][:3])}"
                },
            )

    def _emit_event(self, event_type: str, data: dict[str, Any]):
        """Emit an event to stdout for the main process to capture"""
        event = {"type": event_type, "data": data, "timestamp": self._get_timestamp()}
        print(f"CONFLICT_PREDICTOR_EVENT:{json.dumps(event)}", flush=True)

    def _get_timestamp(self) -> str:
        """Get current ISO timestamp in UTC.

        Uses tz-aware `now(UTC)` then strips tzinfo to keep the existing
        wire format (no trailing `+00:00`) — `datetime.utcnow()` is
        deprecated since Python 3.12 but the consumers of this string
        expected the naive ISO form.
        """
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def main():
    """Main entry point for the conflict predictor runner"""
    parser = argparse.ArgumentParser(description="Conflict Predictor Runner")
    parser.add_argument(
        "--project-path", required=True, help="Path to the project directory"
    )

    args = parser.parse_args()

    try:
        runner = ConflictPredictorRunner()
        result = runner.run_conflict_analysis(args.project_path)
        # Result is already emitted via events, but we also return it for completeness
        print(f"CONFLICT_PREDICTOR_RESULT:{json.dumps(result)}", flush=True)

    except Exception as e:
        print(f"CONFLICT_PREDICTOR_ERROR:{str(e)}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
