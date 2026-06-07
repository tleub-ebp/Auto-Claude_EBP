"""Test Generation Agent API.

Extracted from provider_api.py to keep that module focused on the provider
domain. Mounted by provider_api via app.include_router(router).
"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Body

try:
    from provider_api import _safe_error_message
except ImportError:
    # Module loaded via the apps.backend.* package path (no top-level
    # provider_api on sys.path). Fall back to the package-qualified import.
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


@router.post("/api/test-generation/analyze-coverage")
def analyze_test_coverage(
    file_path: Annotated[str, Body(...)],
    existing_test_path: Annotated[str | None, Body()] = None,
):
    """Analyze test coverage gaps for a source file."""
    try:
        from agents.test_generator import TestGeneratorAgent

        agent = TestGeneratorAgent()
        gaps = agent.analyze_coverage(file_path, existing_test_path)
        return {
            "success": True,
            "gaps": [
                {
                    "function": {
                        "name": gap.function.name,
                        "module": gap.function.module,
                        "class_name": gap.function.class_name,
                        "args": gap.function.args,
                        "return_type": gap.function.return_type,
                        "docstring": gap.function.docstring,
                        "line_number": gap.function.line_number,
                        "is_async": gap.function.is_async,
                        "decorators": gap.function.decorators,
                        "complexity": gap.function.complexity,
                        "full_name": gap.function.full_name,
                        "is_private": gap.function.is_private,
                        "is_dunder": gap.function.is_dunder,
                    },
                    "priority": gap.priority,
                    "reason": gap.reason,
                    "suggested_test_count": gap.suggested_test_count,
                }
                for gap in gaps
            ],
        }
    except Exception as e:
        return {
            "success": False,
            "error": _safe_error_message(e),
        }


@router.post("/api/test-generation/generate-unit-tests")
def generate_unit_tests(
    file_path: Annotated[str, Body(...)],
    existing_test_path: Annotated[str | None, Body()] = None,
    max_tests_per_function: int = 3,
):
    """Generate unit tests for a source file."""
    try:
        from agents.test_generator import TestGeneratorAgent

        agent = TestGeneratorAgent()
        result = agent.generate_unit_tests(
            file_path, existing_test_path, max_tests_per_function
        )
        return {
            "success": True,
            "result": {
                "source_file": result.source_file,
                "functions_analyzed": result.functions_analyzed,
                "tests_generated": result.tests_generated,
                "coverage_gaps": [
                    {
                        "function": {
                            "name": gap.function.name,
                            "full_name": gap.function.full_name,
                        },
                        "priority": gap.priority,
                        "reason": gap.reason,
                        "suggested_test_count": gap.suggested_test_count,
                    }
                    for gap in result.coverage_gaps
                ],
                "generated_tests": [
                    {
                        "test_name": test.test_name,
                        "test_code": test.test_code,
                        "target_function": test.target_function,
                        "test_type": test.test_type,
                        "description": test.description,
                        "imports": test.imports,
                        "fixtures": test.fixtures,
                    }
                    for test in result.generated_tests
                ],
                "test_file_content": result.test_file_content,
                "test_file_path": result.test_file_path,
            },
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/test-generation/generate-e2e-tests")
def generate_e2e_tests(
    user_story: Annotated[str, Body(...)], target_module: Annotated[str, Body(...)]
):
    """Generate E2E tests from a user story."""
    try:
        from agents.test_generator import TestGeneratorAgent

        agent = TestGeneratorAgent()
        result = agent.generate_tests_from_user_story(user_story, target_module)
        return {
            "success": True,
            "result": {
                "source_file": result.source_file,
                "functions_analyzed": result.functions_analyzed,
                "tests_generated": result.tests_generated,
                "generated_tests": [
                    {
                        "test_name": test.test_name,
                        "test_code": test.test_code,
                        "target_function": test.target_function,
                        "test_type": test.test_type,
                        "description": test.description,
                        "imports": test.imports,
                        "fixtures": test.fixtures,
                    }
                    for test in result.generated_tests
                ],
                "test_file_content": result.test_file_content,
                "test_file_path": result.test_file_path,
            },
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/test-generation/generate-tdd-tests")
def generate_tdd_tests(spec: Annotated[dict, Body(...)]):
    """Generate tests before implementation (TDD mode)."""
    try:
        from agents.test_generator import TestGeneratorAgent

        agent = TestGeneratorAgent()
        result = agent.generate_tdd_tests(spec)
        return {
            "success": True,
            "result": {
                "source_file": result.source_file,
                "functions_analyzed": result.functions_analyzed,
                "tests_generated": result.tests_generated,
                "generated_tests": [
                    {
                        "test_name": test.test_name,
                        "test_code": test.test_code,
                        "target_function": test.target_function,
                        "test_type": test.test_type,
                        "description": test.description,
                        "imports": test.imports,
                        "fixtures": test.fixtures,
                    }
                    for test in result.generated_tests
                ],
                "test_file_content": result.test_file_content,
                "test_file_path": result.test_file_path,
            },
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/test-generation/run-post-build")
def run_post_build_test_generation(
    project_path: Annotated[str, Body(...)],
    modified_files: Annotated[list[str], Body(...)],
):
    """Run automatic test generation after a build (post-build hook)."""
    try:
        from agents.test_generator import TestGeneratorAgent

        agent = TestGeneratorAgent()
        results = []

        project_dir = os.path.realpath(project_path)
        for file_path in modified_files:
            # Validate file path stays within project directory
            real_file = os.path.realpath(file_path)
            if not real_file.startswith(project_dir):
                continue
            if file_path.endswith(".py") and os.path.exists(real_file):
                # Skip test files themselves
                if "test_" in file_path or "/tests/" in file_path:
                    continue

                # Find existing test file
                test_file_path = agent._compute_test_file_path(real_file)
                existing_test_path = (
                    test_file_path if os.path.exists(test_file_path) else None
                )

                # Generate tests
                result = agent.generate_unit_tests(file_path, existing_test_path)
                if result.tests_generated > 0:
                    results.append(
                        {
                            "source_file": result.source_file,
                            "tests_generated": result.tests_generated,
                            "test_file_path": result.test_file_path,
                            "test_file_content": result.test_file_content,
                        }
                    )

        return {
            "success": True,
            "results": results,
            "summary": {
                "files_processed": len(modified_files),
                "files_with_tests": len(results),
                "total_tests_generated": sum(r["tests_generated"] for r in results),
            },
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
