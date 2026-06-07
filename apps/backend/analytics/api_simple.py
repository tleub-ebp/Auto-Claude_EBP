"""
Analytics API endpoints for the Build Analytics Dashboard.

Provides REST API endpoints for accessing build metrics, performance data,
and analytics insights.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query


def _utcnow_naive() -> datetime:
    """Tz-naive UTC datetime (replaces deprecated `datetime.utcnow()`).

    DB stores naive UTC; using a tz-aware value would break comparisons.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


from sqlalchemy import Integer, asc, case, cast, desc, func
from sqlalchemy.orm import Session

from .database import get_db
from .database_schema import (
    Build,
    BuildError,
    BuildPhase,
    BuildStatus,
    QAResult,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])


def serialize_build_summary(build):
    return {
        "build_id": build.build_id,
        "spec_id": build.spec_id,
        "spec_name": build.spec_name,
        "started_at": build.started_at.isoformat() if build.started_at else None,
        "completed_at": build.completed_at.isoformat() if build.completed_at else None,
        "status": build.status,
        "total_duration_seconds": build.total_duration_seconds,
        "total_tokens_used": build.total_tokens_used,
        "total_cost_usd": build.total_cost_usd,
        "qa_iterations": build.qa_iterations,
        "qa_success_rate": build.qa_success_rate,
        "llm_provider": build.llm_provider,
        "llm_model": build.llm_model,
    }


def serialize_phase_metrics(phase):
    return {
        "phase_name": phase.phase_name,
        "phase_type": phase.phase_type,
        "duration_seconds": phase.duration_seconds,
        "tokens_used": phase.tokens_used,
        "cost_usd": phase.cost_usd,
        "success": phase.success,
        "builds_count": 1,  # Simplified for now
    }


def serialize_token_metrics(date, total_tokens, total_cost, builds_count):
    return {
        "date": date,
        "total_tokens": total_tokens or 0,
        "total_cost_usd": total_cost or 0.0,
        "builds_count": builds_count,
        "avg_tokens_per_build": (total_tokens / builds_count)
        if builds_count > 0
        else 0,
    }


def serialize_qa_metrics(
    date, avg_success_rate, total_iterations, builds_tested, avg_coverage
):
    return {
        "date": date,
        "avg_success_rate": avg_success_rate or 0.0,
        "total_iterations": total_iterations or 0,
        "builds_tested": builds_tested,
        "avg_coverage": avg_coverage or 0.0,
    }


def serialize_error_metrics(error_type, error_category, count, resolved_count):
    return {
        "error_type": error_type,
        "error_category": error_category,
        "count": count,
        "resolved_count": resolved_count or 0,
        "resolution_rate": ((resolved_count or 0) / count * 100) if count > 0 else 0,
    }


def serialize_agent_performance(
    agent_type,
    llm_provider,
    llm_model,
    total_builds,
    success_rate,
    avg_duration,
    avg_tokens,
    avg_cost,
):
    return {
        "agent_type": agent_type,
        "llm_provider": llm_provider,
        "llm_model": llm_model,
        "total_builds": total_builds,
        "success_rate": success_rate or 0.0,
        "avg_duration_seconds": avg_duration or 0.0,
        "avg_tokens_per_build": avg_tokens or 0.0,
        "avg_cost_per_build": avg_cost or 0.0,
    }


@router.get("/overview")
async def get_dashboard_overview(
    days: int = Query(default=30, ge=1, le=365), db: Session = Depends(get_db)
):
    """Get dashboard overview with key metrics."""
    cutoff_date = _utcnow_naive() - timedelta(days=days)

    # Total builds and success rate
    total_builds_query = db.query(Build).filter(Build.started_at >= cutoff_date)
    total_builds = total_builds_query.count()

    successful_builds = total_builds_query.filter(
        Build.status == BuildStatus.COMPLETE
    ).count()

    success_rate = (successful_builds / total_builds * 100) if total_builds > 0 else 0

    # Token and cost metrics
    token_cost_data = (
        db.query(
            func.sum(Build.total_tokens_used).label("total_tokens"),
            func.sum(Build.total_cost_usd).label("total_cost"),
            func.avg(Build.total_duration_seconds).label("avg_duration"),
        )
        .filter(Build.started_at >= cutoff_date)
        .first()
    )

    total_tokens_used = token_cost_data.total_tokens or 0
    total_cost_usd = token_cost_data.total_cost or 0.0
    avg_build_duration = token_cost_data.avg_duration or 0.0

    # Recent builds
    recent_builds = (
        db.query(Build)
        .filter(Build.started_at >= cutoff_date)
        .order_by(desc(Build.started_at))
        .limit(10)
        .all()
    )

    recent_builds_summary = [serialize_build_summary(build) for build in recent_builds]

    # Top error types
    error_data = (
        db.query(
            BuildError.error_type,
            BuildError.error_category,
            func.count(BuildError.id).label("count"),
            func.sum(cast(BuildError.resolved, Integer)).label("resolved_count"),
        )
        .join(Build)
        .filter(Build.started_at >= cutoff_date)
        .group_by(BuildError.error_type, BuildError.error_category)
        .order_by(desc("count"))
        .limit(10)
        .all()
    )

    top_error_types = [
        serialize_error_metrics(
            error.error_type, error.error_category, error.count, error.resolved_count
        )
        for error in error_data
    ]

    # Phase performance
    phase_data = (
        db.query(
            BuildPhase.phase_name,
            BuildPhase.phase_type,
            func.avg(BuildPhase.duration_seconds).label("avg_duration"),
            func.sum(BuildPhase.tokens_used).label("total_tokens"),
            func.sum(BuildPhase.cost_usd).label("total_cost"),
            func.sum(cast(BuildPhase.success, Integer)).label("success_count"),
            func.count(BuildPhase.id).label("total_count"),
        )
        .join(Build)
        .filter(Build.started_at >= cutoff_date)
        .group_by(BuildPhase.phase_name, BuildPhase.phase_type)
        .all()
    )

    phase_performance = []
    for phase in phase_data:
        phase_performance.append(
            {
                "phase_name": phase.phase_name,
                "phase_type": phase.phase_type,
                "duration_seconds": phase.avg_duration,
                "tokens_used": phase.total_tokens or 0,
                "cost_usd": phase.total_cost or 0.0,
                "success": (phase.success_count or 0) > 0,
                "builds_count": phase.total_count,
            }
        )

    return {
        "total_builds": total_builds,
        "successful_builds": successful_builds,
        "success_rate": success_rate,
        "total_tokens_used": total_tokens_used,
        "total_cost_usd": total_cost_usd,
        "avg_build_duration": avg_build_duration,
        "recent_builds": recent_builds_summary,
        "top_error_types": top_error_types,
        "phase_performance": phase_performance,
    }


@router.get("/builds")
async def get_builds(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    status: str | None = Query(default=None),
    spec_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """Get paginated list of builds with optional filtering."""
    query = db.query(Build)

    if status:
        query = query.filter(Build.status == status)

    if spec_id:
        query = query.filter(Build.spec_id == spec_id)

    builds = query.order_by(desc(Build.started_at)).offset(offset).limit(limit).all()

    return [serialize_build_summary(build) for build in builds]


@router.get("/builds/{build_id}")
async def get_build_details(build_id: str, db: Session = Depends(get_db)):
    """Get detailed information about a specific build."""
    build = db.query(Build).filter(Build.build_id == build_id).first()

    if not build:
        raise HTTPException(status_code=404, detail="Build not found")

    # Get phases for this build
    phases = db.query(BuildPhase).filter(BuildPhase.build_id == build_id).all()

    # Get QA results for this build
    qa_results = db.query(QAResult).filter(QAResult.build_id == build_id).all()

    # Get errors for this build
    errors = db.query(BuildError).filter(BuildError.build_id == build_id).all()

    return {
        "build": serialize_build_summary(build),
        "phases": [
            {
                "phase_name": phase.phase_name,
                "phase_type": phase.phase_type,
                "started_at": phase.started_at.isoformat()
                if phase.started_at
                else None,
                "completed_at": phase.completed_at.isoformat()
                if phase.completed_at
                else None,
                "duration_seconds": phase.duration_seconds,
                "tokens_used": phase.tokens_used,
                "cost_usd": phase.cost_usd,
                "success": phase.success,
                "subtask": phase.subtask,
                "progress_percentage": phase.progress_percentage,
                "phase_metadata": phase.phase_metadata,
            }
            for phase in phases
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
                "started_at": qa.started_at.isoformat() if qa.started_at else None,
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
                "occurred_at": error.occurred_at.isoformat()
                if error.occurred_at
                else None,
                "resolved_at": error.resolved_at.isoformat()
                if error.resolved_at
                else None,
            }
            for error in errors
        ],
    }


@router.get("/metrics/tokens")
async def get_token_metrics(
    days: int = Query(default=30, ge=1, le=365), db: Session = Depends(get_db)
):
    """Get token usage metrics over time."""
    cutoff_date = _utcnow_naive() - timedelta(days=days)

    # Group by date
    token_data = (
        db.query(
            func.date(Build.started_at).label("date"),
            func.sum(Build.total_tokens_used).label("total_tokens"),
            func.sum(Build.total_cost_usd).label("total_cost"),
            func.count(Build.build_id).label("builds_count"),
        )
        .filter(Build.started_at >= cutoff_date)
        .group_by(func.date(Build.started_at))
        .order_by(asc("date"))
        .all()
    )

    return [
        serialize_token_metrics(
            str(data.date), data.total_tokens, data.total_cost, data.builds_count
        )
        for data in token_data
    ]


@router.get("/metrics/qa")
async def get_qa_metrics(
    days: int = Query(default=30, ge=1, le=365), db: Session = Depends(get_db)
):
    """Get QA performance metrics over time."""
    cutoff_date = _utcnow_naive() - timedelta(days=days)

    # Group by date
    qa_data = (
        db.query(
            func.date(QAResult.started_at).label("date"),
            func.avg(
                QAResult.tests_passed / func.nullif(QAResult.tests_run, 0) * 100
            ).label("avg_success_rate"),
            func.sum(QAResult.iteration).label("total_iterations"),
            func.count(func.distinct(QAResult.build_id)).label("builds_tested"),
            func.avg(QAResult.test_coverage_percentage).label("avg_coverage"),
        )
        .filter(QAResult.started_at >= cutoff_date)
        .group_by(func.date(QAResult.started_at))
        .order_by(asc("date"))
        .all()
    )

    return [
        serialize_qa_metrics(
            str(data.date),
            data.avg_success_rate,
            data.total_iterations,
            data.builds_tested,
            data.avg_coverage,
        )
        for data in qa_data
    ]


@router.get("/metrics/agent-performance")
async def get_agent_performance(
    days: int = Query(default=30, ge=1, le=365), db: Session = Depends(get_db)
):
    """Get agent performance metrics."""
    cutoff_date = _utcnow_naive() - timedelta(days=days)

    # Get performance data from phases
    performance_data = (
        db.query(
            BuildPhase.phase_type.label("agent_type"),
            Build.llm_provider,
            Build.llm_model,
            func.count(BuildPhase.build_id).label("total_builds"),
            func.sum(cast(BuildPhase.success, Integer)).label("successful_builds"),
            func.avg(BuildPhase.duration_seconds).label("avg_duration"),
            func.avg(BuildPhase.tokens_used).label("avg_tokens"),
            func.avg(BuildPhase.cost_usd).label("avg_cost"),
        )
        .join(Build)
        .filter(BuildPhase.started_at >= cutoff_date)
        .group_by(BuildPhase.phase_type, Build.llm_provider, Build.llm_model)
        .all()
    )

    return [
        serialize_agent_performance(
            data.agent_type,
            data.llm_provider,
            data.llm_model,
            data.total_builds,
            ((data.successful_builds or 0) / data.total_builds * 100)
            if data.total_builds > 0
            else 0,
            data.avg_duration,
            data.avg_tokens,
            data.avg_cost,
        )
        for data in performance_data
    ]


@router.get("/metrics/errors")
async def get_error_metrics(
    days: int = Query(default=30, ge=1, le=365), db: Session = Depends(get_db)
):
    """Get error metrics and patterns."""
    cutoff_date = _utcnow_naive() - timedelta(days=days)

    error_data = (
        db.query(
            BuildError.error_type,
            BuildError.error_category,
            func.count(BuildError.id).label("count"),
            func.sum(cast(BuildError.resolved, Integer)).label("resolved_count"),
        )
        .join(Build)
        .filter(Build.started_at >= cutoff_date)
        .group_by(BuildError.error_type, BuildError.error_category)
        .order_by(desc("count"))
        .all()
    )

    return [
        serialize_error_metrics(
            error.error_type, error.error_category, error.count, error.resolved_count
        )
        for error in error_data
    ]


@router.get("/specs")
async def get_specs_summary(db: Session = Depends(get_db)):
    """Get summary of all specs and their performance."""
    specs_data = (
        db.query(
            Build.spec_id,
            Build.spec_name,
            func.count(Build.build_id).label("total_builds"),
            func.sum(case((Build.status == BuildStatus.COMPLETE, 1), else_=0)).label(
                "successful_builds"
            ),
            func.avg(Build.total_duration_seconds).label("avg_duration"),
            func.avg(Build.total_cost_usd).label("avg_cost"),
            func.avg(Build.qa_iterations).label("avg_qa_iterations"),
        )
        .group_by(Build.spec_id, Build.spec_name)
        .order_by(desc("total_builds"))
        .all()
    )

    return [
        {
            "spec_id": spec.spec_id,
            "spec_name": spec.spec_name,
            "total_builds": spec.total_builds,
            "successful_builds": spec.successful_builds or 0,
            "success_rate": ((spec.successful_builds or 0) / spec.total_builds * 100)
            if spec.total_builds > 0
            else 0,
            "avg_duration_seconds": spec.avg_duration or 0.0,
            "avg_cost_usd": spec.avg_cost or 0.0,
            "avg_qa_iterations": spec.avg_qa_iterations or 0.0,
        }
        for spec in specs_data
    ]
