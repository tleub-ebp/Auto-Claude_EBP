"""System status endpoints.

Thin GET wrappers exposing the status / config of various subsystems
(router, local models, costs, sandbox, anomaly detector, scheduler,
auto-detector). Extracted from provider_api.py; mounted via
app.include_router(router).
"""

from __future__ import annotations

from fastapi import APIRouter

try:
    from provider_api import _safe_error_message
except ImportError:
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


# --- 6.1 Intelligent Router ---
@router.get("/api/router/config")
def get_router_config():
    try:
        from scheduling.intelligent_router import IntelligentRouter

        ir = IntelligentRouter()
        config = ir.get_config()
        return {"success": True, "config": config}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 6.2 Local Model Manager ---
@router.get("/api/local-models/status")
def get_local_models_status():
    try:
        from scheduling.local_model_manager import LocalModelManager

        mgr = LocalModelManager()
        status = mgr.get_status()
        return {"success": True, "status": status}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 6.3 Cost Estimator ---
@router.get("/api/costs/summary/{project_id}")
def get_cost_summary(project_id: str):
    try:
        from scheduling.cost_estimator import CostEstimator

        ce = CostEstimator()
        summary = ce.get_summary(project_id)
        return {"success": True, "summary": summary}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/costs/budget/{project_id}")
def get_cost_budget(project_id: str):
    try:
        from scheduling.cost_estimator import CostEstimator

        ce = CostEstimator()
        budget = ce.get_budget(project_id)
        return {"success": True, "budget": budget}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 7.2 Sandbox ---
@router.get("/api/sandbox/status")
def get_sandbox_status():
    try:
        from security.sandbox import SandboxManager

        mgr = SandboxManager()
        status = mgr.get_status()
        return {"success": True, "status": status}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 7.3 Anomaly Detector ---
@router.get("/api/anomaly/status")
def get_anomaly_status():
    try:
        from security.anomaly_detector import AnomalyDetector

        detector = AnomalyDetector()
        status = detector.get_status()
        return {"success": True, "status": status}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 8.1 Scheduler ---
@router.get("/api/scheduler/jobs")
def get_scheduler_jobs():
    try:
        from scheduling.scheduler import TaskScheduler

        sched = TaskScheduler()
        jobs = sched.list_jobs()
        return {
            "success": True,
            "jobs": [
                j.to_dict() if hasattr(j, "to_dict") else j.__dict__ for j in jobs
            ],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 8.2 Auto-Detection ---
@router.get("/api/auto-detect/status")
def get_auto_detect_status():
    try:
        from scheduling.auto_detector import AutoDetector

        detector = AutoDetector()
        status = detector.get_status()
        return {"success": True, "status": status}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
