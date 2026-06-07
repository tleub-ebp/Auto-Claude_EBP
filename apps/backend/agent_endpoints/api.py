"""Agent-feature HTTP endpoints.

Thin FastAPI wrappers around the refactoring, documentation, feedback-learning,
task-templates and AI code-review agents. Extracted from provider_api.py;
mounted via app.include_router(router).

Frontend traffic (preserve URL / method / body / response shape verbatim):
  - DocumentationView.tsx  -> /api/documentation/{coverage,generate-docstrings,generate-readme}
  - RefactoringView.tsx    -> /api/refactoring/{detect-smells,propose}
  - CodeReview.tsx         -> /api/code-review/analyze
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body

try:
    from provider_api import _safe_error_message
except ImportError:
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


# --- 2.1 Refactoring Agent ---
@router.post("/api/refactoring/detect-smells")
def detect_smells(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from agents.refactorer import RefactoringAgent

        agent = RefactoringAgent(thresholds=body.get("thresholds", {}))
        source = body.get("source", "")
        smells = agent.detect_smells_from_source(source)
        return {
            "success": True,
            "smells": [
                s.to_dict() if hasattr(s, "to_dict") else s.__dict__ for s in smells
            ],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/refactoring/propose")
def propose_refactoring(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from agents.refactorer import RefactoringAgent

        agent = RefactoringAgent(thresholds=body.get("thresholds", {}))
        source = body.get("source", "")
        proposals = agent.propose_refactoring(source=source)
        return {
            "success": True,
            "proposals": [
                p.to_dict() if hasattr(p, "to_dict") else p.__dict__ for p in proposals
            ],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 2.2 Documentation Agent ---
@router.post("/api/documentation/coverage")
def check_doc_coverage(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from agents.documenter import DocFormat, DocumentationAgent

        fmt = body.get("format", "google")
        agent = DocumentationAgent(default_format=DocFormat(fmt))
        file_path = body.get("file_path", "")
        coverage = agent.check_documentation_coverage(file_path=file_path)
        return {"success": True, "coverage": coverage}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/documentation/generate-docstrings")
def generate_docstrings(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from agents.documenter import DocFormat, DocumentationAgent

        fmt = body.get("format", "google")
        agent = DocumentationAgent(default_format=DocFormat(fmt))
        file_path = body.get("file_path", "")
        result = agent.generate_docstrings(file_path=file_path)
        return {
            "success": True,
            "result": result.to_dict()
            if hasattr(result, "to_dict")
            else result.__dict__,
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/documentation/generate-readme")
def generate_readme(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from agents.documenter import DocFormat, DocumentationAgent

        fmt = body.get("format", "google")
        agent = DocumentationAgent(default_format=DocFormat(fmt))
        dir_path = body.get("dir_path", "")
        result = agent.generate_module_readme(dir_path)
        return {
            "success": True,
            "result": result.to_dict()
            if hasattr(result, "to_dict")
            else result.__dict__,
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 2.4 Feedback Learning ---
@router.get("/api/feedback/stats/{project_id}")
def get_feedback_stats(project_id: str):
    try:
        from agents.feedback_learning import FeedbackLearning

        fl = FeedbackLearning()
        stats = fl.get_stats(project_id)
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 3.2 Task Templates ---
@router.get("/api/templates")
def list_task_templates():
    try:
        from scheduling.task_templates import TemplateManager

        tm = TemplateManager()
        templates = tm.list_templates()
        return {
            "success": True,
            "templates": [
                t.to_dict() if hasattr(t, "to_dict") else t.__dict__ for t in templates
            ],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- 3.3 AI Code Review ---
@router.post("/api/code-review/analyze")
def analyze_code_review(body: Annotated[dict[str, Any], Body(...)]):
    try:
        from review.ai_code_review import AICodeReview

        reviewer = AICodeReview()
        diff = body.get("diff", "")
        result = reviewer.review_diff(diff)
        return {
            "success": True,
            "review": result.to_dict()
            if hasattr(result, "to_dict")
            else result.__dict__,
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
