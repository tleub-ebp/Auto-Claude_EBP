"""
Analytics service for integrating with the existing agent system.

This module provides integration points to collect analytics data
from the existing agent execution flow.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def _utcnow_naive() -> datetime:
    """Return a tz-naive UTC datetime (replacement for the deprecated
    `datetime.utcnow()`).

    The DB schema stores naive UTC datetimes; passing a tz-aware value
    would break the comparison with stored columns. We compute the same
    instant using the non-deprecated API and strip tzinfo at the end.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


from .collector import get_analytics_collector
from .database import get_db
from .database_schema import (
    Build,
    BuildError,
    BuildPhase,
    BuildStatus,
    QAResult,
    TokenUsage,
)


class AnalyticsService:
    """
    Service for integrating analytics collection with the agent system.
    """

    def __init__(self):
        self.collector = get_analytics_collector()
        self._setup_phase_monitoring()

    def _setup_phase_monitoring(self):
        """
        Setup monitoring of phase events from stdout.
        """
        # This monitors the phase events that are printed to stdout
        # by the core.phase_event.emit_phase function
        pass

    def start_build_from_spec(self, spec_path: str, **kwargs):
        """
        Start analytics tracking for a build from a spec file.
        """
        spec_path = Path(spec_path)
        spec_id = spec_path.stem
        spec_name = kwargs.get("spec_name") or spec_id
        project_path = kwargs.get("project_path") or str(spec_path.parent)

        return self.collector.build_session(
            spec_id=spec_id,
            spec_name=spec_name,
            project_path=project_path,
            llm_provider=kwargs.get("llm_provider"),
            llm_model=kwargs.get("llm_model"),
            agent_config=kwargs.get("agent_config", {}),
        )

    def monitor_agent_execution(self, agent_type: str, execution_data: dict[str, Any]):
        """
        Monitor agent execution and collect relevant metrics.
        """
        try:
            # Extract token usage if available
            if "token_usage" in execution_data:
                token_data = execution_data["token_usage"]
                self.collector.record_token_usage(
                    input_tokens=token_data.get("input_tokens", 0),
                    output_tokens=token_data.get("output_tokens", 0),
                    cost_usd=token_data.get("cost_usd", 0.0),
                    operation_type=f"{agent_type}_execution",
                    llm_provider=token_data.get("provider"),
                    llm_model=token_data.get("model"),
                )

            # Extract errors if any
            if "error" in execution_data:
                error_data = execution_data["error"]
                self.collector.record_error(
                    error_type=error_data.get("type", "agent_error"),
                    error_message=error_data.get("message", "Unknown error"),
                    error_category=error_data.get("category", "agent_error"),
                    file_path=error_data.get("file_path"),
                    line_number=error_data.get("line_number"),
                    function_name=error_data.get("function_name"),
                    stack_trace=error_data.get("stack_trace"),
                )

        except Exception as e:
            print(f"[Analytics] Error monitoring agent execution: {e}")

    def record_qa_results(self, qa_data: dict[str, Any]):
        """
        Record QA results from the QA system.
        """
        try:
            self.collector.record_qa_result(
                iteration=qa_data.get("iteration", 1),
                tests_run=qa_data.get("tests_run", 0),
                tests_passed=qa_data.get("tests_passed", 0),
                tests_failed=qa_data.get("tests_failed", 0),
                coverage_percentage=qa_data.get("coverage_percentage", 0.0),
                quality_score=qa_data.get("quality_score", 0.0),
                security_issues_found=qa_data.get("security_issues_found", 0),
                security_issues_fixed=qa_data.get("security_issues_fixed", 0),
                qa_type=qa_data.get("qa_type", "unit_test"),
                duration_seconds=qa_data.get("duration_seconds", 0.0),
                success=qa_data.get("success", False),
                feedback_summary=qa_data.get("feedback_summary"),
                detailed_feedback=qa_data.get("detailed_feedback"),
            )
        except Exception as e:
            print(f"[Analytics] Error recording QA results: {e}")

    def parse_phase_events_from_output(self, output: str):
        """
        Parse phase events from agent output and update analytics.
        """
        try:
            from core.phase_event import PHASE_MARKER_PREFIX

            for line in output.split("\n"):
                if line.startswith(PHASE_MARKER_PREFIX):
                    # Parse the phase event
                    json_str = line[len(PHASE_MARKER_PREFIX) :]
                    try:
                        phase_data = json.loads(json_str)
                        self._handle_phase_event(phase_data)
                    except json.JSONDecodeError:
                        continue

        except Exception as e:
            print(f"[Analytics] Error parsing phase events: {e}")

    def _handle_phase_event(self, phase_data: dict[str, Any]):
        """
        Handle a single phase event.
        """
        phase = phase_data.get("phase", "")

        if phase == "planning":
            self.collector.start_phase("planning", "planner")
        elif phase == "coding":
            self.collector.start_phase("coding", "coder")
        elif phase == "qa_review":
            self.collector.start_phase("qa_review", "qa_reviewer")
        elif phase == "qa_fixing":
            self.collector.start_phase("qa_fixing", "coder")
        elif phase == "complete":
            self.collector.update_build_status(BuildStatus.COMPLETE)
        elif phase == "failed":
            self.collector.update_build_status(BuildStatus.FAILED)

    def get_build_statistics(self, build_id: str) -> dict[str, Any] | None:
        """
        Get comprehensive statistics for a specific build.
        """
        db = next(get_db())
        try:
            build = db.query(Build).filter(Build.build_id == build_id).first()
            if not build:
                return None

            # Get all related data
            phases = db.query(BuildPhase).filter(BuildPhase.build_id == build_id).all()
            token_usage = (
                db.query(TokenUsage).filter(TokenUsage.build_id == build_id).all()
            )
            qa_results = db.query(QAResult).filter(QAResult.build_id == build_id).all()
            errors = db.query(BuildError).filter(BuildError.build_id == build_id).all()

            return {
                "build": {
                    "build_id": build.build_id,
                    "spec_id": build.spec_id,
                    "spec_name": build.spec_name,
                    "started_at": build.started_at.isoformat(),
                    "completed_at": build.completed_at.isoformat()
                    if build.completed_at
                    else None,
                    "status": build.status,
                    "total_duration_seconds": build.total_duration_seconds,
                    "total_tokens_used": build.total_tokens_used,
                    "total_cost_usd": build.total_cost_usd,
                    "qa_iterations": build.qa_iterations,
                    "qa_success_rate": build.qa_success_rate,
                    "llm_provider": build.llm_provider,
                    "llm_model": build.llm_model,
                },
                "phases": [
                    {
                        "phase_name": phase.phase_name,
                        "phase_type": phase.phase_type,
                        "started_at": phase.started_at.isoformat(),
                        "completed_at": phase.completed_at.isoformat()
                        if phase.completed_at
                        else None,
                        "duration_seconds": phase.duration_seconds,
                        "tokens_used": phase.tokens_used,
                        "cost_usd": phase.cost_usd,
                        "success": phase.success,
                        "subtask": phase.subtask,
                    }
                    for phase in phases
                ],
                "token_usage": [
                    {
                        "input_tokens": usage.input_tokens,
                        "output_tokens": usage.output_tokens,
                        "total_tokens": usage.total_tokens,
                        "cost_usd": usage.cost_usd,
                        "operation_type": usage.operation_type,
                        "llm_provider": usage.llm_provider,
                        "llm_model": usage.llm_model,
                        "timestamp": usage.timestamp.isoformat(),
                    }
                    for usage in token_usage
                ],
                "qa_results": [
                    {
                        "iteration": qa.iteration,
                        "tests_run": qa.tests_run,
                        "tests_passed": qa.tests_passed,
                        "tests_failed": qa.tests_failed,
                        "test_coverage_percentage": qa.test_coverage_percentage,
                        "code_quality_score": qa.code_quality_score,
                        "security_issues_found": qa.security_issues_found,
                        "security_issues_fixed": qa.security_issues_fixed,
                        "qa_type": qa.qa_type,
                        "duration_seconds": qa.duration_seconds,
                        "success": qa.success,
                        "feedback_summary": qa.feedback_summary,
                        "started_at": qa.started_at.isoformat(),
                        "completed_at": qa.completed_at.isoformat()
                        if qa.completed_at
                        else None,
                    }
                    for qa in qa_results
                ],
                "errors": [
                    {
                        "error_type": error.error_type,
                        "error_message": error.error_message,
                        "error_category": error.error_category,
                        "file_path": error.file_path,
                        "line_number": error.line_number,
                        "function_name": error.function_name,
                        "resolved": error.resolved,
                        "resolution_strategy": error.resolution_strategy,
                        "occurred_at": error.occurred_at.isoformat(),
                        "resolved_at": error.resolved_at.isoformat()
                        if error.resolved_at
                        else None,
                    }
                    for error in errors
                ],
            }

        finally:
            db.close()

    def cleanup_old_data(self, days_to_keep: int = 90):
        """
        Clean up old analytics data to prevent database bloat.
        """
        cutoff_date = _utcnow_naive() - timedelta(days=days_to_keep)

        db = next(get_db())
        try:
            # Delete old builds and related data
            old_builds = db.query(Build).filter(Build.started_at < cutoff_date).all()

            for build in old_builds:
                # Delete related records (cascades should handle this, but being explicit)
                db.query(TokenUsage).filter(
                    TokenUsage.build_id == build.build_id
                ).delete()
                db.query(QAResult).filter(QAResult.build_id == build.build_id).delete()
                db.query(BuildError).filter(
                    BuildError.build_id == build.build_id
                ).delete()
                db.query(BuildPhase).filter(
                    BuildPhase.build_id == build.build_id
                ).delete()
                db.query(Build).filter(Build.build_id == build.build_id).delete()

            db.commit()
            print(f"[Analytics] Cleaned up {len(old_builds)} old builds")

        except Exception as e:
            print(f"[Analytics] Error cleaning up old data: {e}")
            db.rollback()
        finally:
            db.close()


# Global service instance
_analytics_service = AnalyticsService()


def get_analytics_service() -> AnalyticsService:
    """Get the global analytics service instance."""
    return _analytics_service


# Integration hooks for the existing system
def hook_into_agent_system():
    """
    Hook analytics into the existing agent system.
    This should be called during application startup.
    """
    # Hook into phase event monitoring
    # Hook into agent execution monitoring
    # Hook into QA system
    pass


# Example usage and integration points
class AgentExecutionTracker:
    """
    Example class showing how to integrate analytics with agent execution.
    """

    def __init__(self):
        self.analytics = get_analytics_service()

    def track_agent_run(self, agent_type: str, spec_path: str, **kwargs):
        """
        Track a complete agent run with analytics.
        """
        with self.analytics.start_build_from_spec(spec_path, **kwargs) as _:
            try:
                # Start the appropriate phase
                if agent_type == "planner":
                    self.analytics.collector.start_phase("planning", "planner")
                elif agent_type == "coder":
                    self.analytics.collector.start_phase("coding", "coder")
                elif agent_type == "qa_reviewer":
                    self.analytics.collector.start_phase("qa_review", "qa_reviewer")

                # Execute the agent (this would be the actual agent execution)
                result = self._execute_agent(agent_type, spec_path)

                # End the phase successfully
                self.analytics.collector.end_phase(success=True)

                return result

            except Exception as e:
                # Record the error and end phase unsuccessfully
                self.analytics.collector.record_error(
                    error_type="agent_execution_error",
                    error_message=str(e),
                    error_category="agent_error",
                )
                self.analytics.collector.end_phase(success=False, error_message=str(e))
                raise

    def _execute_agent(self, agent_type: str, spec_path: str):
        """
        Placeholder for actual agent execution.
        """
        # This would contain the actual agent execution logic
        pass
