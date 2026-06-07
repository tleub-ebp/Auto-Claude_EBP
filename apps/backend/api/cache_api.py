#!/usr/bin/env python3
"""
Context Cache Management API

REST API endpoints for managing intelligent context caching.
Provides endpoints for cache monitoring, management, and configuration.
"""

import logging
import os
import re
import time
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def _safe_error_message(e: Exception) -> str:
    """Return a safe error message without exposing internal stack traces."""
    logger.error("Operation failed: %s: %s", type(e).__name__, e)
    # Map known exception types to safe user-facing messages
    _SAFE_MESSAGES: dict[type, str] = {
        TimeoutError: "Request timed out",
        ConnectionError: "Connection failed",
        PermissionError: "Permission denied",
        FileNotFoundError: "Resource not found",
        ValueError: "Invalid input",
        KeyError: "Missing required field",
        OSError: "System error",
    }
    for exc_type, msg in _SAFE_MESSAGES.items():
        if isinstance(e, exc_type):
            return msg
    return "An unexpected error occurred"


# Constants for error messages
PROJECT_PATH_NOT_FOUND = "Project path not found"
FAILED_TO_GET_CACHE_STATS = "Failed to get cache stats"
FAILED_TO_UPDATE_CACHE_CONFIG = "Failed to update cache config"
FAILED_TO_INVALIDATE_CACHE = "Failed to invalidate cache"
FAILED_TO_OPTIMIZE_CACHE = "Failed to optimize cache"
FAILED_TO_GET_CACHE_ENTRIES = "Failed to get cache entries"
FAILED_TO_GET_FRESHNESS_METRICS = "Failed to get freshness metrics"
FAILED_TO_GET_INVALIDATION_RULES = "Failed to get invalidation rules"
FAILED_TO_CREATE_INVALIDATION_RULE = "Failed to create invalidation rule"
FAILED_TO_DELETE_INVALIDATION_RULE = "Failed to delete invalidation rule"
FAILED_TO_GET_GIT_STATS = "Failed to get git invalidation stats"
FAILED_TO_START_GIT_MONITORING = "Failed to start git monitoring"
FAILED_TO_STOP_GIT_MONITORING = "Failed to stop git monitoring"
FAILED_TO_CHECK_GIT_INVALIDATION = "Failed to check git invalidation"
FAILED_TO_START_CACHE_EXPORT = "Failed to start cache export"
FAILED_TO_PERFORM_HEALTH_CHECK = "Failed to perform health check"

# Import cache services
from services.cache_freshness_system import (
    InvalidationEngine,
    InvalidationRule,
    InvalidationStrategy,
)
from services.git_cache_invalidation import GitBasedCacheInvalidator
from services.intelligent_context_cache import CacheConfig, get_context_cache

_SAFE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._\- ]+$")


def _validate_project_path(project_path: str) -> Path:
    """Validate and resolve a project path, preventing path traversal attacks.

    Strategy:
    1. Resolve the user-supplied path and check it is contained within a
       trusted allow-list root.
    2. Reject each path component that contains characters outside a
       conservative whitelist (alphanumerics, dot, underscore, hyphen,
       space). This acts as the sanitizer recognized by static analyzers:
       after this check, the returned path is considered safe from
       injection.
    3. Rebuild the Path from the trusted root and the validated
       components, so no string from the raw query reaches downstream
       sinks unchanged.
    """
    allowed_root = Path(
        os.path.realpath(os.getenv("CACHE_API_ALLOWED_PROJECT_ROOT", os.getcwd()))
    )

    requested_real = Path(os.path.realpath(os.path.normpath(project_path)))

    # Case-insensitive containment check (Windows-friendly).
    req_cmp = str(requested_real).casefold()
    root_cmp = str(allowed_root).casefold()
    if req_cmp == root_cmp:
        rel_parts: tuple[str, ...] = ()
    elif req_cmp.startswith(root_cmp + os.sep):
        rel_parts = Path(str(requested_real)[len(str(allowed_root)) + 1 :]).parts
    else:
        raise HTTPException(status_code=404, detail=PROJECT_PATH_NOT_FOUND)

    # Validate each component against a strict whitelist, then rebuild
    # the path from the trusted root + validated components.
    safe_path = allowed_root
    for part in rel_parts:
        if part in ("", ".") or not _SAFE_COMPONENT_RE.match(part):
            raise HTTPException(status_code=404, detail=PROJECT_PATH_NOT_FOUND)
        safe_path = safe_path / part

    try:
        is_dir = safe_path.is_dir()
    except OSError:
        raise HTTPException(status_code=404, detail=PROJECT_PATH_NOT_FOUND)

    if not is_dir:
        raise HTTPException(status_code=404, detail=PROJECT_PATH_NOT_FOUND)

    return safe_path


# Pydantic models for API
class CacheConfigRequest(BaseModel):
    """Request model for cache configuration."""

    max_cache_size: int = Field(default=100, ge=1, le=1000)
    max_entry_age_hours: float = Field(default=24.0, ge=0.1, le=168.0)
    freshness_threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    similarity_threshold: float = Field(default=0.8, ge=0.0, le=1.0)
    enable_semantic_matching: bool = Field(default=True)
    enable_background_refresh: bool = Field(default=True)
    refresh_interval_minutes: float = Field(default=30.0, ge=1.0, le=1440.0)


class CacheStatsResponse(BaseModel):
    """Response model for cache statistics."""

    cache_size: int
    max_cache_size: int
    cache_hits: int
    cache_misses: int
    semantic_hits: int
    hit_rate: float
    total_time_saved: float
    total_tokens_saved: int
    avg_freshness: float
    freshness_threshold: float
    similarity_threshold: float
    semantic_matching_enabled: bool


class InvalidationRuleRequest(BaseModel):
    """Request model for creating invalidation rules."""

    name: str = Field(..., min_length=1, max_length=100)
    strategy: str = Field(..., description="Invalidation strategy name")
    conditions: dict[str, Any] = Field(default_factory=dict)
    action: str = Field(
        default="invalidate", pattern="^(invalidate|refresh|downgrade)$"
    )
    priority: int = Field(default=50, ge=0, le=100)


class InvalidationRuleResponse(BaseModel):
    """Response model for invalidation rules."""

    name: str
    strategy: str
    conditions: dict[str, Any]
    action: str
    priority: int
    created_at: float
    last_triggered: float
    trigger_count: int


class GitInvalidationStatsResponse(BaseModel):
    """Response model for git invalidation statistics."""

    monitoring_active: bool
    current_commit: str
    total_invalidations: int
    entries_invalidated: int
    monitoring_cycles: int
    last_invalidation: float
    recent_invalidations: int
    strategies_active: int


# Create API router
router = APIRouter(prefix="/api/cache", tags=["context-cache"])


# Global instances (will be initialized per project)
_cache_instances: dict[str, dict[str, Any]] = {}


def get_cache_components(project_path: Path) -> dict[str, Any]:
    """Get or create cache components for a project."""
    project_key = str(project_path.resolve())

    if project_key not in _cache_instances:
        # Initialize cache components
        context_cache = get_context_cache(project_path)
        invalidation_engine = InvalidationEngine(project_path)
        git_invalidator = GitBasedCacheInvalidator(project_path, context_cache)

        _cache_instances[project_key] = {
            "context_cache": context_cache,
            "invalidation_engine": invalidation_engine,
            "git_invalidator": git_invalidator,
        }

    return _cache_instances[project_key]


@router.get(
    "/stats",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_GET_CACHE_STATS},
    },
)
async def get_cache_stats(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> CacheStatsResponse:
    """Get comprehensive cache statistics."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]

        stats = context_cache.get_cache_stats()

        return CacheStatsResponse(**stats)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting cache stats: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/config",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_UPDATE_CACHE_CONFIG},
    },
)
async def update_cache_config(
    config: CacheConfigRequest,
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, str]:
    """Update cache configuration."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]

        # Update configuration
        new_config = CacheConfig(
            max_cache_size=config.max_cache_size,
            max_entry_age_hours=config.max_entry_age_hours,
            freshness_threshold=config.freshness_threshold,
            similarity_threshold=config.similarity_threshold,
            enable_semantic_matching=config.enable_semantic_matching,
            enable_background_refresh=config.enable_background_refresh,
            refresh_interval_minutes=config.refresh_interval_minutes,
        )

        context_cache.config = new_config

        # Optimize cache with new settings
        context_cache.optimize_cache()

        return {"message": "Cache configuration updated successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating cache config: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/invalidate",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_INVALIDATE_CACHE},
    },
)
async def invalidate_cache(
    project_path: Annotated[str, Query(..., description="Project path")],
    pattern: Annotated[str, Query(None, description="Pattern to match cache keys")]
    | None = None,
) -> dict[str, Any]:
    """Invalidate cache entries."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]

        # Get stats before invalidation
        before_stats = context_cache.get_cache_stats()

        # Perform invalidation
        context_cache.invalidate_cache(pattern)

        # Get stats after invalidation
        after_stats = context_cache.get_cache_stats()

        return {
            "message": "Cache invalidated successfully",
            "pattern": pattern,
            "entries_before": before_stats["cache_size"],
            "entries_after": after_stats["cache_size"],
            "entries_invalidated": before_stats["cache_size"]
            - after_stats["cache_size"],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error invalidating cache: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/optimize",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_OPTIMIZE_CACHE},
    },
)
async def optimize_cache(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, Any]:
    """Optimize cache by removing stale entries."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]

        # Get stats before optimization
        before_stats = context_cache.get_cache_stats()

        # Optimize cache
        context_cache.optimize_cache()

        # Get stats after optimization
        after_stats = context_cache.get_cache_stats()

        return {
            "message": "Cache optimized successfully",
            "entries_before": before_stats["cache_size"],
            "entries_after": after_stats["cache_size"],
            "entries_removed": before_stats["cache_size"] - after_stats["cache_size"],
            "avg_freshness_before": before_stats["avg_freshness"],
            "avg_freshness_after": after_stats["avg_freshness"],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error optimizing cache: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/entries",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_GET_CACHE_ENTRIES},
    },
)
async def get_cache_entries(
    limit: Annotated[int, Query(default=50, ge=1, le=200)],
    project_path: Annotated[str, Query(..., description="Project path")],
) -> list[dict[str, Any]]:
    """Get cache entries with metadata."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]

        entries = []

        with context_cache._cache_lock:
            # Sort by last accessed (most recent first)
            sorted_entries = sorted(
                context_cache._cache.values(),
                key=lambda e: e.last_accessed,
                reverse=True,
            )

            for entry in sorted_entries[:limit]:
                entry_data = {
                    "cache_key": entry.cache_key,
                    "created_at": entry.created_at,
                    "last_accessed": entry.last_accessed,
                    "access_count": entry.access_count,
                    "freshness_score": entry.freshness_score,
                    "git_commit_hash": entry.git_commit_hash,
                    "files_count": len(entry.files_changed),
                    "build_time_saved": entry.build_time_saved,
                    "tokens_saved": entry.tokens_saved,
                    "semantic_signature": entry.semantic_signature,
                }
                entries.append(entry_data)

        return entries

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting cache entries: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/freshness",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_GET_FRESHNESS_METRICS},
    },
)
async def get_freshness_metrics(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, Any]:
    """Get detailed freshness metrics for all cache entries."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]
        freshness_calculator = components["invalidation_engine"].freshness_calculator

        freshness_metrics = []

        with context_cache._cache_lock:
            for entry in context_cache._cache.values():
                metrics = freshness_calculator.calculate_freshness(entry)
                metrics_data = {
                    "cache_key": entry.cache_key,
                    "calculated_at": metrics.calculated_at,
                    "overall_freshness": metrics.overall_freshness,
                    "confidence_score": metrics.confidence_score,
                    "factors": {
                        "age_score": metrics.age_score,
                        "git_score": metrics.git_score,
                        "file_score": metrics.file_score,
                        "dependency_score": metrics.dependency_score,
                        "access_score": metrics.access_score,
                        "semantic_score": metrics.semantic_score,
                        "build_score": metrics.build_score,
                    },
                    "change_tracking": {
                        "files_changed_count": len(metrics.files_changed),
                        "dependencies_changed_count": len(metrics.dependencies_changed),
                        "commits_since_cache": metrics.commits_since_cache,
                    },
                }
                freshness_metrics.append(metrics_data)

        # Sort by freshness score (lowest first)
        freshness_metrics.sort(key=lambda m: m["overall_freshness"])

        return {
            "total_entries": len(freshness_metrics),
            "freshness_metrics": freshness_metrics,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting freshness metrics: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/invalidation/rules",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_GET_INVALIDATION_RULES},
    },
)
async def get_invalidation_rules(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> list[InvalidationRuleResponse]:
    """Get all invalidation rules."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        invalidation_engine = components["invalidation_engine"]

        rules = invalidation_engine.get_rules()

        return [
            InvalidationRuleResponse(
                name=rule.name,
                strategy=rule.strategy.value,
                conditions=rule.conditions,
                action=rule.action,
                priority=rule.priority,
                created_at=rule.created_at,
                last_triggered=rule.last_triggered,
                trigger_count=rule.trigger_count,
            )
            for rule in rules
        ]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting invalidation rules: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/invalidation/rules",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        400: {"description": "Invalid rule data"},
        500: {"description": FAILED_TO_CREATE_INVALIDATION_RULE},
    },
)
async def create_invalidation_rule(
    rule_request: InvalidationRuleRequest,
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, str]:
    """Create a new invalidation rule."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        invalidation_engine = components["invalidation_engine"]

        # Convert strategy string to enum
        try:
            strategy = InvalidationStrategy(rule_request.strategy)
        except ValueError:
            raise HTTPException(
                status_code=400, detail=f"Invalid strategy: {rule_request.strategy}"
            )

        # Create rule
        rule = InvalidationRule(
            name=rule_request.name,
            strategy=strategy,
            conditions=rule_request.conditions,
            action=rule_request.action,
            priority=rule_request.priority,
        )

        invalidation_engine.add_rule(rule)

        return {
            "message": f"Invalidation rule '{rule_request.name}' created successfully"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating invalidation rule: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.delete(
    "/invalidation/rules/{rule_name}",
    responses={
        404: {"description": "Project path not found or rule not found"},
        500: {"description": FAILED_TO_DELETE_INVALIDATION_RULE},
    },
)
async def delete_invalidation_rule(
    rule_name: str, project_path: Annotated[str, Query(..., description="Project path")]
) -> dict[str, str]:
    """Delete an invalidation rule."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        invalidation_engine = components["invalidation_engine"]

        if not invalidation_engine.remove_rule(rule_name):
            raise HTTPException(status_code=404, detail=f"Rule '{rule_name}' not found")

        return {"message": f"Invalidation rule '{rule_name}' deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting invalidation rule: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/git/stats",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_GET_GIT_STATS},
    },
)
async def get_git_invalidation_stats(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> GitInvalidationStatsResponse:
    """Get git-based invalidation statistics."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        git_invalidator = components["git_invalidator"]

        stats = git_invalidator.get_statistics()

        return GitInvalidationStatsResponse(**stats)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting git invalidation stats: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/git/monitoring/start",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_START_GIT_MONITORING},
    },
)
async def start_git_monitoring(
    project_path: Annotated[str, Query(..., description="Project path")],
    interval_seconds: Annotated[float, Query(default=30.0, ge=5.0, le=300.0)],
) -> dict[str, str]:
    """Start git-based cache monitoring."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        git_invalidator = components["git_invalidator"]

        git_invalidator.start_monitoring(interval_seconds)

        return {"message": f"Git monitoring started with {interval_seconds}s interval"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting git monitoring: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/git/monitoring/stop",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_STOP_GIT_MONITORING},
    },
)
async def stop_git_monitoring(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, str]:
    """Stop git-based cache monitoring."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        git_invalidator = components["git_invalidator"]

        git_invalidator.stop_monitoring()

        return {"message": "Git monitoring stopped"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error stopping git monitoring: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/git/check",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_CHECK_GIT_INVALIDATION},
    },
)
async def check_git_invalidation(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, Any]:
    """Check for git changes that would trigger invalidation."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        git_invalidator = components["git_invalidator"]

        check_result = git_invalidator.manual_invalidation_check()

        return check_result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking git invalidation: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.post(
    "/export",
    responses={
        400: {"description": "Export path must be inside the project directory"},
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_START_CACHE_EXPORT},
    },
)
async def export_cache_data(
    background_tasks: BackgroundTasks,
    project_path: Annotated[str, Query(..., description="Project path")],
    export_path: Annotated[str, Query(None, description="Export file path")]
    | None = None,
) -> dict[str, str]:
    """Export cache data for analysis."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]
        git_invalidator = components["git_invalidator"]

        # Determine export path (must resolve inside the project directory)
        if not export_path:
            export_file = path / "cache_export.json"
        else:
            project_dir = os.path.realpath(str(path))
            resolved_export = os.path.realpath(
                os.path.join(project_dir, export_path)
                if not os.path.isabs(export_path)
                else os.path.normpath(export_path)
            )
            if (
                not resolved_export.startswith(project_dir + os.sep)
                and resolved_export != project_dir
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Export path must be inside the project directory",
                )
            export_file = Path(resolved_export)

        # Export cache data in background
        def export_data():
            try:
                context_cache.export_cache_data(str(export_file))

                # Also export git invalidation log
                git_log_path = export_file.with_suffix(".git_log.json")
                git_invalidator.export_invalidation_log(str(git_log_path))

                logger.info(f"Cache data exported to {export_file}")
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error exporting cache data: {e}")

        background_tasks.add_task(export_data)

        return {"message": f"Cache data export started to {export_path}"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting cache export: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


@router.get(
    "/health",
    responses={
        404: {"description": PROJECT_PATH_NOT_FOUND},
        500: {"description": FAILED_TO_PERFORM_HEALTH_CHECK},
    },
)
async def cache_health_check(
    project_path: Annotated[str, Query(..., description="Project path")],
) -> dict[str, Any]:
    """Health check for cache system."""
    try:
        path = _validate_project_path(project_path)

        components = get_cache_components(path)
        context_cache = components["context_cache"]
        git_invalidator = components["git_invalidator"]

        # Get basic stats
        stats = context_cache.get_cache_stats()
        git_stats = git_invalidator.get_statistics()

        # Determine health status
        health_status = "healthy"
        issues = []

        # Check cache size
        if stats["cache_size"] == 0:
            health_status = "warning"
            issues.append("Cache is empty")

        # Check hit rate
        if (
            stats["hit_rate"] < 0.3
            and (stats["cache_hits"] + stats["cache_misses"]) > 10
        ):
            health_status = "warning"
            issues.append("Low cache hit rate")

        # Check average freshness
        if stats["avg_freshness"] < 0.5:
            health_status = "warning"
            issues.append("Low average freshness")

        # Check git monitoring
        if not git_stats["monitoring_active"]:
            health_status = "warning"
            issues.append("Git monitoring is not active")

        return {
            "status": health_status,
            "issues": issues,
            "cache_stats": {
                "cache_size": stats["cache_size"],
                "hit_rate": stats["hit_rate"],
                "avg_freshness": stats["avg_freshness"],
            },
            "git_monitoring": git_stats["monitoring_active"],
            "timestamp": time.time(),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error performing health check: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_message(e))


# Utility function to include router in FastAPI app
def setup_cache_api(app):
    """Setup cache API routes in FastAPI app."""
    app.include_router(router)
