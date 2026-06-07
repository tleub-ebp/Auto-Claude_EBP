"""
Analytics data collector for Build Analytics Dashboard.

This module captures agent events, phase transitions, token usage,
and build results to populate the analytics database.
"""

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any


def _utcnow_naive() -> datetime:
    """Tz-naive UTC datetime (replaces deprecated `_utcnow_naive()`).

    DB stores naive UTC; using a tz-aware value would break comparisons
    with stored columns.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


from core.phase_event import ExecutionPhase, emit_phase
from sqlalchemy.orm import Session

from .database import get_db
from .database_schema import (
    AgentType,
    Build,
    BuildError,
    BuildPhase,
    BuildStatus,
    QAResult,
    TokenUsage,
)


class AnalyticsCollector:
    """
    Collects and stores analytics data from agent execution.
    """

    def __init__(self):
        self.current_build: str | None = None
        self.current_phase: str | None = None
        self.phase_start_time: datetime | None = None
        self.build_start_time: datetime | None = None
        self.phase_tokens: int = 0
        self.build_tokens: int = 0
        self.phase_cost: float = 0.0
        self.build_cost: float = 0.0

    @contextmanager
    def build_session(
        self,
        spec_id: str,
        spec_name: str | None = None,
        project_path: str | None = None,
        llm_provider: str | None = None,
        llm_model: str | None = None,
        agent_config: dict[str, Any] | None = None,
    ):
        """
        Context manager for tracking a complete build session.
        """
        build_id = str(uuid.uuid4())
        self.current_build = build_id
        self.build_start_time = _utcnow_naive()
        self.build_tokens = 0
        self.build_cost = 0.0

        # Create build record
        db = next(get_db())
        try:
            build = Build(
                build_id=build_id,
                spec_id=spec_id,
                spec_name=spec_name,
                project_path=project_path,
                started_at=self.build_start_time,
                status=BuildStatus.PLANNING,
                llm_provider=llm_provider,
                llm_model=llm_model,
                agent_config=agent_config or {},
            )
            db.add(build)
            db.commit()

            yield build_id

        finally:
            # Finalize build record
            self._finalize_build(db, build_id)
            db.close()
            self.current_build = None
            self.build_start_time = None

    def start_phase(self, phase_name: str, phase_type: str, subtask: str | None = None):
        """
        Start tracking a new phase within the current build.
        """
        if not self.current_build:
            raise ValueError("No active build session")

        # End previous phase if any
        if self.current_phase:
            self.end_phase(success=True)

        self.current_phase = str(uuid.uuid4())
        self.phase_start_time = _utcnow_naive()
        self.phase_tokens = 0
        self.phase_cost = 0.0

        # Create phase record
        db = next(get_db())
        try:
            phase = BuildPhase(
                build_id=self.current_build,
                phase_name=phase_name,
                phase_type=phase_type,
                started_at=self.phase_start_time,
                subtask=subtask,
            )
            db.add(phase)
            db.commit()

            # Emit phase event for frontend
            emit_phase(ExecutionPhase(phase_name), f"Starting {phase_name}")

        finally:
            db.close()

    def end_phase(self, success: bool = True, error_message: str | None = None):
        """
        End the current phase and record metrics.
        """
        if not self.current_phase or not self.phase_start_time:
            return

        db = next(get_db())
        try:
            # Update phase record
            phase = (
                db.query(BuildPhase)
                .filter(
                    BuildPhase.build_id == self.current_build,
                    BuildPhase.started_at == self.phase_start_time,
                )
                .first()
            )

            if phase:
                phase.completed_at = _utcnow_naive()
                phase.duration_seconds = (
                    phase.completed_at - phase.started_at
                ).total_seconds()
                phase.tokens_used = self.phase_tokens
                phase.cost_usd = self.phase_cost
                phase.success = success

                if error_message:
                    # Create error record
                    error = BuildError(
                        build_id=self.current_build,
                        error_type="phase_error",
                        error_message=error_message,
                        error_category="system_error",
                        occurred_at=phase.completed_at,
                    )
                    db.add(error)

                db.commit()

            # Reset phase tracking
            self.current_phase = None
            self.phase_start_time = None
            self.phase_tokens = 0
            self.phase_cost = 0.0

        finally:
            db.close()

    def record_token_usage(
        self,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
        operation_type: str,
        llm_provider: str | None = None,
        llm_model: str | None = None,
    ):
        """
        Record token usage for the current phase/build.
        """
        if not self.current_build:
            return

        total_tokens = input_tokens + output_tokens

        # Update build totals
        self.build_tokens += total_tokens
        self.build_cost += cost_usd

        # Update phase totals if active
        if self.current_phase:
            self.phase_tokens += total_tokens
            self.phase_cost += cost_usd

        # Create token usage record
        db = next(get_db())
        try:
            token_usage = TokenUsage(
                build_id=self.current_build,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cost_usd=cost_usd,
                operation_type=operation_type,
                llm_provider=llm_provider,
                llm_model=llm_model,
                timestamp=_utcnow_naive(),
            )
            db.add(token_usage)
            db.commit()

        finally:
            db.close()

    def record_qa_result(
        self,
        iteration: int,
        tests_run: int,
        tests_passed: int,
        tests_failed: int,
        coverage_percentage: float,
        quality_score: float,
        security_issues_found: int,
        security_issues_fixed: int,
        qa_type: str,
        duration_seconds: float,
        success: bool,
        feedback_summary: str | None = None,
        detailed_feedback: str | None = None,
    ):
        """
        Record QA results for the current build.
        """
        if not self.current_build:
            return

        db = next(get_db())
        try:
            qa_result = QAResult(
                build_id=self.current_build,
                iteration=iteration,
                tests_run=tests_run,
                tests_passed=tests_passed,
                tests_failed=tests_failed,
                test_coverage_percentage=coverage_percentage,
                code_quality_score=quality_score,
                security_issues_found=security_issues_found,
                security_issues_fixed=security_issues_fixed,
                qa_type=qa_type,
                duration_seconds=duration_seconds,
                success=success,
                feedback_summary=feedback_summary,
                detailed_feedback=detailed_feedback,
                started_at=_utcnow_naive(),
                completed_at=_utcnow_naive(),
            )
            db.add(qa_result)
            db.commit()

        finally:
            db.close()

    def record_error(
        self,
        error_type: str,
        error_message: str,
        error_category: str = "system_error",
        file_path: str | None = None,
        line_number: int | None = None,
        function_name: str | None = None,
        stack_trace: str | None = None,
    ):
        """
        Record an error that occurred during build execution.
        """
        if not self.current_build:
            return

        db = next(get_db())
        try:
            error = BuildError(
                build_id=self.current_build,
                error_type=error_type,
                error_message=error_message,
                error_category=error_category,
                file_path=file_path,
                line_number=line_number,
                function_name=function_name,
                stack_trace=stack_trace,
                occurred_at=_utcnow_naive(),
            )
            db.add(error)
            db.commit()

        finally:
            db.close()

    def update_build_status(self, status: BuildStatus):
        """
        Update the status of the current build.
        """
        if not self.current_build:
            return

        db = next(get_db())
        try:
            build = db.query(Build).filter(Build.build_id == self.current_build).first()
            if build:
                build.status = status
                if status in [BuildStatus.COMPLETE, BuildStatus.FAILED]:
                    build.completed_at = _utcnow_naive()
                db.commit()

                # Emit phase event for frontend
                emit_phase(ExecutionPhase(status), f"Build {status.value}")

        finally:
            db.close()

    def _finalize_build(self, db: Session, build_id: str):
        """
        Finalize build record with aggregated metrics.
        """
        build = db.query(Build).filter(Build.build_id == build_id).first()
        if not build:
            return

        # Set completion status
        build.status = BuildStatus.COMPLETE
        build.completed_at = _utcnow_naive()

        # Calculate total duration
        if build.completed_at and build.started_at:
            build.total_duration_seconds = (
                build.completed_at - build.started_at
            ).total_seconds()

        # Aggregate token usage
        token_usage = db.query(TokenUsage).filter(TokenUsage.build_id == build_id).all()
        build.total_tokens_used = sum(t.total_tokens for t in token_usage)
        build.total_cost_usd = sum(t.cost_usd for t in token_usage)

        # Aggregate QA metrics
        qa_results = db.query(QAResult).filter(QAResult.build_id == build_id).all()
        build.qa_iterations = len(qa_results)
        if qa_results and len(qa_results) > 0:
            build.qa_success_rate = (
                sum(1 for qa in qa_results if qa.success) / len(qa_results) * 100
            )

        db.commit()


# Global collector instance
_collector = AnalyticsCollector()


def get_analytics_collector() -> AnalyticsCollector:
    """Get the global analytics collector instance."""
    return _collector


# Decorators for automatic analytics collection
def track_build(spec_id: str, **kwargs):
    """
    Decorator to automatically track a function as a build session.
    """

    def decorator(func):
        def wrapper(*args, **func_kwargs):
            with get_analytics_collector().build_session(spec_id, **kwargs):
                return func(*args, **func_kwargs)

        return wrapper

    return decorator


def track_phase(phase_name: str, phase_type: str, **kwargs):
    """
    Decorator to automatically track a function as a phase.
    """

    def decorator(func):
        def wrapper(*args, **func_kwargs):
            collector = get_analytics_collector()
            collector.start_phase(phase_name, phase_type, **kwargs)
            try:
                result = func(*args, **func_kwargs)
                collector.end_phase(success=True)
                return result
            except Exception as e:
                collector.end_phase(success=False, error_message=str(e))
                raise

        return wrapper

    return decorator


# Phase event listener for automatic collection
def on_phase_event(phase_data: dict[str, Any]):
    """
    Handle phase events from the core phase event system.
    """
    try:
        phase = phase_data.get("phase", "")

        collector = get_analytics_collector()

        if phase == ExecutionPhase.PLANNING:
            collector.start_phase("planning", AgentType.PLANNER)
        elif phase == ExecutionPhase.CODING:
            collector.start_phase("coding", AgentType.CODER)
        elif phase == ExecutionPhase.QA_REVIEW:
            collector.start_phase("qa_review", AgentType.QA_REVIEWER)
        elif phase == ExecutionPhase.QA_FIXING:
            collector.start_phase("qa_fixing", AgentType.CODER)
        elif phase == ExecutionPhase.COMPLETE:
            collector.update_build_status(BuildStatus.COMPLETE)
        elif phase == ExecutionPhase.FAILED:
            collector.update_build_status(BuildStatus.FAILED)

    except Exception as e:
        # Don't let analytics collection break the main flow
        print(f"[Analytics] Error processing phase event: {e}")


# Hook into the phase event system
def _hook_phase_events():
    """
    Hook into the core phase event system for automatic collection.
    """
    # This would be called during application startup
    # The actual implementation depends on how the phase event system works
    pass
